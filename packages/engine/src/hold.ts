import { peakOccupancy } from "./capacity.js";
import { lockAndChoose, prepare } from "./reserve.js";
import type { ReservationStore, ReservationTx } from "./store.js";
import type { ConvertHoldRequest, ConvertHoldResult, HoldRequest, HoldResult } from "./types.js";

const MINUTE_MS = 60_000;

/**
 * US-135: hold capacity while a checkout payment completes.
 *
 * A hold is a claim on a pool exactly like a confirmed reservation (US-023): it
 * is placed under the same pool locks and counted by the same capacity check
 * until it converts, is released, or expires. Expiry needs no job to return the
 * space — an expired hold simply stops being counted (US-135: "automatically and
 * immediately").
 *
 * The quote is fixed on the hold: rate, service fee and amount are what the
 * reservation will carry when the payment is verified (US-013).
 *
 * One live hold per driver. A second checkout while one is live is refused with
 * the live hold's id, so the app can resume it or cancel it. A vehicle already
 * booked for an overlapping time cannot be held again (US-026).
 */
export async function placeHold(store: ReservationStore, req: HoldRequest): Promise<HoldResult> {
  return store.transaction(async (tx) => {
    const p = await prepare(tx, req, "checkout");
    if (!p.ok) return { ok: false, reason: p.reason } as const;
    const { user, tariff, window, candidates, rateKobo, serviceFeeKobo, amountKobo } = p.value;

    const pool = await lockAndChoose(tx, candidates, window, req.now);
    // The driver's own row is locked after the pools (the same order as a wallet booking), so two
    // checkouts by one driver serialise even at different sites, and the checks below cannot both pass.
    await tx.lockWallet(user.id);
    const live = await tx.liveHoldFor(user.id, req.now);
    if (live) return { ok: false, reason: "CHECKOUT_IN_PROGRESS", holdId: live.id } as const;
    // Refused before payment rather than refunded after it.
    if (await tx.vehicleBookedDuring(req.vehicleId, window)) return { ok: false, reason: "VEHICLE_ALREADY_BOOKED" } as const;
    if (!pool) return { ok: false, reason: "NO_CAPACITY" } as const;

    const expiresAt = new Date(req.now.getTime() + req.holdMinutes * MINUTE_MS);
    const holdId = await tx.insertHold({
      reference: req.reference,
      userId: user.id,
      vehicleId: req.vehicleId,
      lotId: req.lotId,
      poolId: pool.id,
      window,
      hours: req.hours,
      tariffId: tariff.id,
      rateAppliedKobo: rateKobo,
      serviceFeeKobo,
      amountKobo,
      expiresAt,
      ...(req.idempotencyKey !== undefined ? { idempotencyKey: req.idempotencyKey } : {}),
    });
    return { ok: true, holdId, poolId: pool.id, poolKind: pool.kind, window, rateAppliedKobo: rateKobo, serviceFeeKobo, amountKobo, expiresAt } as const;
  });
}

/**
 * US-134, US-135: a verified payment turns its hold into a reservation, inside
 * the caller's transaction (which already holds the payment row's lock).
 *
 * The hold's pool is locked, then the hold. The reservation is inserted and the
 * hold released in the same transaction, so the space is never free in between:
 * it converts without releasing and re-taking capacity.
 *
 * Capacity is re-checked every time, counting every other claim but this hold.
 * For a live hold that check always passes. For a hold that lapsed while the
 * driver was still paying, it passes only if the space is still free — the same
 * question any new booking would have to answer — and otherwise the payment
 * cannot be honoured and is refunded (US-017). That also covers the instant of
 * expiry, where another booking may already have treated this hold as gone.
 */
export async function convertHoldWithin(tx: ReservationTx, req: ConvertHoldRequest): Promise<ConvertHoldResult> {
  const unlocked = await tx.getHold(req.holdId);
  if (!unlocked) return { ok: false, reason: "HOLD_NOT_FOUND" };

  const [pool] = await tx.lockPools([unlocked.poolId]); // a hold's pool never changes
  const hold = await tx.lockHold(req.holdId);
  if (!hold) return { ok: false, reason: "HOLD_NOT_FOUND" };

  const existing = await tx.reservationForHold(hold.id);
  if (existing) return { ok: true, reservationId: existing, late: false, alreadyConverted: true };
  if (hold.releaseReason === "cancelled") return { ok: false, reason: "HOLD_CANCELLED" };

  const late = hold.releasedAt !== null || hold.expiresAt.getTime() <= req.now.getTime();
  // Every conversion, not only late ones: an earlier hold of the same driver may have converted late
  // since this one was placed. One car, one booking for any instant (US-026); the later payment is refunded.
  if (await tx.vehicleBookedDuring(hold.vehicleId, hold.window)) return { ok: false, reason: "VEHICLE_ALREADY_BOOKED" };
  const others = await tx.claimsOverlapping([hold.poolId], hold.window, req.now, hold.id);
  if (!pool || peakOccupancy(others, hold.window) + 1 > pool.capacity) return { ok: false, reason: "NO_CAPACITY" };

  const reservationId = await tx.insertReservation({
    reference: hold.reference,
    userId: hold.userId,
    vehicleId: hold.vehicleId,
    lotId: hold.lotId,
    poolId: hold.poolId,
    window: hold.window,
    hours: hold.hours,
    tariffId: hold.tariffId,
    rateAppliedKobo: hold.rateAppliedKobo,
    serviceFeeKobo: hold.serviceFeeKobo,
    amountKobo: hold.amountKobo,
    paymentTransactionId: req.paymentTransactionId,
    holdId: hold.id,
  });
  // A hold released for any other reason keeps that reason on record; one still open is now converted.
  if (hold.releasedAt === null) await tx.releaseHold(hold.id, "converted", req.now);
  return { ok: true, reservationId, late, alreadyConverted: false };
}

/** convertHoldWithin in a transaction of its own, for callers with nothing else to commit alongside it. */
export async function convertHold(store: ReservationStore, req: ConvertHoldRequest): Promise<ConvertHoldResult> {
  return store.transaction((tx) => convertHoldWithin(tx, req));
}
