import { candidatePools, choosePool } from "./capacity.js";
import type { ReservationTx, ReservationStore } from "./store.js";
import type {
  ConsumptionOrder, PoolSnapshot, RejectReason, ReserveRequest, ReserveResult, TariffSnapshot, TimeWindow, UserSnapshot, WalletBalances,
} from "./types.js";

const HOUR_MS = 3_600_000;
const BOOKABLE_STATES = new Set(["verified", "flagged"]); // US-136: a flagged account keeps booking

/** What every booking path checks before it touches capacity. */
export interface Prepared {
  readonly user: UserSnapshot;
  readonly tariff: TariffSnapshot;
  readonly window: TimeWindow;
  readonly candidates: readonly PoolSnapshot[];
  readonly rateKobo: bigint;
  readonly serviceFeeKobo: bigint;
  readonly amountKobo: bigint;
}

/**
 * Validation shared by the wallet path and the checkout path: the account can
 * book, the vehicle is theirs, the duration is within the tariff, and the pools
 * they may draw on (US-022, US-023, US-024). Takes no locks.
 */
export async function prepare(
  tx: ReservationTx,
  req: { userId: string; vehicleId: string; lotId: string; start: Date; hours: number; accessible?: boolean; now: Date },
  path: "wallet" | "checkout",
): Promise<{ ok: true; value: Prepared } | { ok: false; reason: RejectReason }> {
  const fail = (reason: RejectReason) => ({ ok: false, reason }) as const;
  const user = await tx.getUser(req.userId);
  if (!user) return fail("USER_NOT_FOUND");
  if (!BOOKABLE_STATES.has(user.verificationState)) return fail("USER_NOT_BOOKABLE");
  if (path === "wallet" && !user.walletEnabled) return fail("WALLET_PATH_NOT_AVAILABLE");
  if (path === "checkout" && user.walletEnabled) return fail("CHECKOUT_PATH_NOT_AVAILABLE");
  if (!(await tx.vehicleBelongsTo(req.vehicleId, user.id))) return fail("VEHICLE_NOT_REGISTERED");

  const tariff = await tx.tariffInForce(req.lotId, user.userType, req.now);
  if (!tariff) return fail("NO_TARIFF");
  if (!Number.isInteger(req.hours) || req.hours < tariff.minHours || req.hours > tariff.maxHours) return fail("INVALID_WINDOW");
  if (req.start.getTime() < req.now.getTime()) return fail("INVALID_WINDOW");
  const window: TimeWindow = { start: req.start, end: new Date(req.start.getTime() + req.hours * HOUR_MS) };

  const candidates = candidatePools(user, await tx.listPools(req.lotId), { accessible: req.accessible ?? false });
  if (!candidates.ok) return fail(candidates.reason);
  if (candidates.pools.length === 0) return fail("NO_CAPACITY");

  // US-013: the rate in force now is stored on the booking and never recomputed.
  const rateKobo = tariff.hourlyRateKobo;
  const serviceFeeKobo = tariff.serviceFeeKobo;
  return {
    ok: true,
    value: { user, tariff, window, candidates: candidates.pools, rateKobo, serviceFeeKobo, amountKobo: rateKobo * BigInt(req.hours) + serviceFeeKobo },
  };
}

/** Locks the candidate pools (by id) and picks the first, in draw order, with room across the window. */
export async function lockAndChoose(
  tx: ReservationTx,
  candidates: readonly PoolSnapshot[],
  window: TimeWindow,
  now: Date,
): Promise<PoolSnapshot | null> {
  const lockedById = new Map((await tx.lockPools(candidates.map((p) => p.id))).map((p) => [p.id, p]));
  const locked = candidates.map((p) => lockedById.get(p.id) ?? { ...p, capacity: 0 });
  const claims = await tx.claimsOverlapping(locked.map((p) => p.id), window, now);
  return choosePool(locked, claims, window);
}

/**
 * OD-12: how much of a debit draws on allocated credit. Allocated first by
 * default, so grants are used before the driver's own money (US-018). Never more
 * than either bucket holds; the caller has already checked the total covers it.
 */
export function allocatedPart(balances: WalletBalances, amountKobo: bigint, order: ConsumptionOrder = "allocated_first"): bigint {
  const allocated = balances.allocatedKobo > 0n ? balances.allocatedKobo : 0n;
  const paidRaw = balances.totalKobo - balances.allocatedKobo;
  const paid = paidRaw > 0n ? paidRaw : 0n;
  if (order === "allocated_first") return allocated < amountKobo ? allocated : amountKobo;
  const fromPaid = paid < amountKobo ? paid : amountKobo;
  const rest = amountKobo - fromPaid;
  return allocated < rest ? allocated : rest;
}

/**
 * Reserve a space paid from the driver's wallet (US-022, US-023).
 *
 * Everything happens in one transaction. The candidate pools are locked, then the
 * wallet; capacity is checked under those locks; the debit and the reservation
 * are written together. Any failure after that point rolls both back.
 *
 * Drivers whose payment path is checkout use placeHold() and convertHold() instead (US-134, US-135).
 */
export async function reserve(store: ReservationStore, req: ReserveRequest): Promise<ReserveResult> {
  return store.transaction(async (tx) => {
    const p = await prepare(tx, req, "wallet");
    if (!p.ok) return reject(p.reason);
    const { user, tariff, window, candidates, rateKobo, serviceFeeKobo, amountKobo } = p.value;

    // Lock order is always pools (by id), then wallet. Every booking follows it, so none can deadlock.
    const pool = await lockAndChoose(tx, candidates, window, req.now);
    await tx.lockWallet(user.id);
    if (!pool) return reject("NO_CAPACITY");

    const balances = await tx.walletBalances(user.id);
    if (balances.totalKobo < amountKobo) return reject("INSUFFICIENT_BALANCE");
    const allocatedKobo = allocatedPart(balances, amountKobo, req.consumptionOrder);

    const walletEntryId = await tx.appendWalletDebit({ userId: user.id, amountKobo, allocatedKobo, reference: req.reference });
    const reservationId = await tx.insertReservation({
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
      walletEntryId,
      ...(req.idempotencyKey !== undefined ? { idempotencyKey: req.idempotencyKey } : {}),
    });

    return {
      ok: true,
      reservationId,
      poolId: pool.id,
      poolKind: pool.kind,
      window,
      rateAppliedKobo: rateKobo,
      serviceFeeKobo,
      amountKobo,
      walletEntryId,
      allocatedKobo,
    } as const;
  });
}

function reject(reason: RejectReason): ReserveResult {
  return { ok: false, reason };
}
