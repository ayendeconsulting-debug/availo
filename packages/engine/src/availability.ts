import { candidatePools, peakOccupancy } from "./capacity.js";
import type { ReservationStore } from "./store.js";
import type { PoolKind, TimeWindow } from "./types.js";

const HOUR_MS = 3_600_000;

export interface AvailabilityRequest {
  readonly userId: string;
  readonly lotId: string;
  readonly start: Date;
  readonly hours: number;
  readonly accessible?: boolean;
  readonly now: Date;
}

export type AvailabilityResult =
  | {
      readonly ok: true;
      readonly window: TimeWindow;
      /** Only the pools this driver may book from (US-022): ring-fence + open for campus, open for guests. */
      readonly pools: ReadonlyArray<{ kind: PoolKind; capacity: number; available: number }>;
      readonly available: number;
      readonly rateKobo: bigint;
      readonly amountKobo: bigint;
      /** Wallet balance before and after, for wallet holders (US-022). Null on the checkout path. */
      readonly balanceBeforeKobo: bigint | null;
      readonly balanceAfterKobo: bigint | null;
    }
  | { readonly ok: false; readonly reason: "USER_NOT_FOUND" | "NOT_ELIGIBLE" | "NO_TARIFF" | "INVALID_WINDOW" };

/**
 * What this driver could book for this window, and what it would cost. A read:
 * no locks, so the figure is advisory — reserve() re-checks under lock (US-023).
 */
export async function checkAvailability(store: ReservationStore, req: AvailabilityRequest): Promise<AvailabilityResult> {
  return store.transaction(async (tx) => {
    const user = await tx.getUser(req.userId);
    if (!user) return { ok: false, reason: "USER_NOT_FOUND" } as const;
    const tariff = await tx.tariffInForce(req.lotId, user.userType, req.now);
    if (!tariff) return { ok: false, reason: "NO_TARIFF" } as const;
    if (!Number.isInteger(req.hours) || req.hours < tariff.minHours || req.hours > tariff.maxHours || req.start < req.now) {
      return { ok: false, reason: "INVALID_WINDOW" } as const;
    }
    const window: TimeWindow = { start: req.start, end: new Date(req.start.getTime() + req.hours * HOUR_MS) };
    const candidates = candidatePools(user, await tx.listPools(req.lotId), { accessible: req.accessible ?? false });
    if (!candidates.ok) return { ok: false, reason: candidates.reason } as const;

    const claims = await tx.claimsOverlapping(candidates.pools.map((p) => p.id), window, req.now);
    const pools = candidates.pools.map((p) => ({
      kind: p.kind,
      capacity: p.capacity,
      available: Math.max(0, p.capacity - peakOccupancy(claims.filter((c) => c.poolId === p.id), window)),
    }));
    const amount = tariff.hourlyRateKobo * BigInt(req.hours);
    const wallet = user.userType === "guest" ? null : await tx.walletBalanceKobo(user.id);
    return {
      ok: true,
      window,
      pools,
      available: pools.reduce((n, p) => n + p.available, 0),
      rateKobo: tariff.hourlyRateKobo,
      amountKobo: amount,
      balanceBeforeKobo: wallet,
      balanceAfterKobo: wallet === null ? null : wallet - amount,
    } as const;
  });
}
