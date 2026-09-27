import type { Claim, PoolSnapshot, TimeWindow, UserSnapshot } from "./types.js";

export function peakOccupancy(_claims: readonly Claim[], _window: TimeWindow): number {
  throw new Error("not implemented");
}

export type PoolCandidates =
  | { readonly ok: true; readonly pools: readonly PoolSnapshot[] }
  | { readonly ok: false; readonly reason: "NOT_ELIGIBLE" };

export function candidatePools(
  _user: UserSnapshot,
  _pools: readonly PoolSnapshot[],
  _opts: { readonly accessible: boolean },
): PoolCandidates {
  throw new Error("not implemented");
}
