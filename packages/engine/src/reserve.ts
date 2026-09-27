import { candidatePools, choosePool } from "./capacity.js";
import type { ReservationStore } from "./store.js";
import type { ReserveRequest, ReserveResult, TimeWindow } from "./types.js";

const HOUR_MS = 3_600_000;
const BOOKABLE_STATES = new Set(["verified", "flagged"]); // US-136: a flagged account keeps booking

/**
 * Reserve a space paid from the driver's wallet (US-022, US-023).
 *
 * Everything happens in one transaction. The candidate pools are locked, then the
 * wallet; capacity is checked under those locks; the debit and the reservation
 * are written together. Any failure after that point rolls both back.
 *
 * Guests pay at checkout behind an inventory hold (US-134, US-135), which is a
 * separate path added in sprint 4.
 */
export async function reserve(store: ReservationStore, req: ReserveRequest): Promise<ReserveResult> {
  return store.transaction(async (tx) => {
    const user = await tx.getUser(req.userId);
    if (!user) return reject("USER_NOT_FOUND");
    if (!BOOKABLE_STATES.has(user.verificationState)) return reject("USER_NOT_BOOKABLE");
    if (user.userType === "guest") return reject("WALLET_PATH_NOT_AVAILABLE");
    if (!(await tx.vehicleBelongsTo(req.vehicleId, user.id))) return reject("VEHICLE_NOT_REGISTERED");

    const tariff = await tx.tariffInForce(req.lotId, user.userType, req.now);
    if (!tariff) return reject("NO_TARIFF");
    if (!Number.isInteger(req.hours) || req.hours < tariff.minHours || req.hours > tariff.maxHours) {
      return reject("INVALID_WINDOW");
    }
    if (req.start.getTime() < req.now.getTime()) return reject("INVALID_WINDOW");
    const window: TimeWindow = { start: req.start, end: new Date(req.start.getTime() + req.hours * HOUR_MS) };

    const candidates = candidatePools(user, await tx.listPools(req.lotId), { accessible: req.accessible ?? false });
    if (!candidates.ok) return reject(candidates.reason);
    if (candidates.pools.length === 0) return reject("NO_CAPACITY");

    // Lock order is always pools (by id), then wallet. Every booking follows it, so none can deadlock.
    const lockedById = new Map((await tx.lockPools(candidates.pools.map((p) => p.id))).map((p) => [p.id, p]));
    const locked = candidates.pools.map((p) => lockedById.get(p.id) ?? { ...p, capacity: 0 });
    await tx.lockWallet(user.id);

    const claims = await tx.claimsOverlapping(locked.map((p) => p.id), window, req.now);
    const pool = choosePool(locked, claims, window);
    if (!pool) return reject("NO_CAPACITY");

    // US-013: the rate in force now is stored on the reservation and never recomputed.
    const rate = tariff.hourlyRateKobo;
    const amount = rate * BigInt(req.hours);
    if ((await tx.walletBalanceKobo(user.id)) < amount) return reject("INSUFFICIENT_BALANCE");

    const walletEntryId = await tx.appendWalletDebit({ userId: user.id, amountKobo: amount, reference: req.reference });
    const reservationId = await tx.insertReservation({
      reference: req.reference,
      userId: user.id,
      vehicleId: req.vehicleId,
      lotId: req.lotId,
      poolId: pool.id,
      window,
      hours: req.hours,
      tariffId: tariff.id,
      rateAppliedKobo: rate,
      amountKobo: amount,
      walletEntryId,
      ...(req.idempotencyKey !== undefined ? { idempotencyKey: req.idempotencyKey } : {}),
    });

    return {
      ok: true,
      reservationId,
      poolId: pool.id,
      poolKind: pool.kind,
      window,
      rateAppliedKobo: rate,
      amountKobo: amount,
      walletEntryId,
    } as const;
  });
}

function reject(reason: Extract<ReserveResult, { ok: false }>["reason"]): ReserveResult {
  return { ok: false, reason };
}
