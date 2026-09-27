import type { Claim, PoolKind, PoolSnapshot, TimeWindow, UserSnapshot } from "./types.js";

/**
 * The largest number of claims held simultaneously at any instant inside
 * `window` (US-023). Windows are half-open, so a claim ending at 10:00 and one
 * starting at 10:00 never coincide.
 *
 * This is deliberately not "the number of claims overlapping the window": two
 * one-hour bookings at 09:00 and 11:00 overlap 09:00–12:00 but never occupy
 * two spaces at once.
 */
export function peakOccupancy(claims: readonly Claim[], window: TimeWindow): number {
  const from = window.start.getTime();
  const to = window.end.getTime();
  const events: Array<[time: number, delta: 1 | -1]> = [];
  for (const c of claims) {
    const s = Math.max(c.window.start.getTime(), from);
    const e = Math.min(c.window.end.getTime(), to);
    if (s < e) events.push([s, 1], [e, -1]);
  }
  // At equal instants, releases come before arrivals (half-open intervals).
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let peak = 0;
  for (const [, delta] of events) {
    current += delta;
    if (current > peak) peak = current;
  }
  return peak;
}

export type PoolCandidates =
  | { readonly ok: true; readonly pools: readonly PoolSnapshot[] }
  | { readonly ok: false; readonly reason: "NOT_ELIGIBLE" };

/** Which general pools each user type may draw on, in the order they are drawn (US-133). */
const GENERAL_ORDER: Record<UserSnapshot["userType"], readonly PoolKind[]> = {
  staff: ["campus", "open"],
  student: ["campus", "open"],
  guest: ["open"],
};

/**
 * The pools this user may book from, in draw order. Entitlement is decided here,
 * server-side, whatever the client sent (NFR-SEC-09).
 *
 * - Staff and students: ring-fence first, then the open share (US-133).
 * - Guests: the open share only (US-133).
 * - Accessible: only when asked for, only for eligible accounts of any type, and
 *   with no general fallback (US-024, US-047). A general request never draws on
 *   the accessible sub-pool, which is never released into a general pool.
 */
export function candidatePools(
  user: UserSnapshot,
  pools: readonly PoolSnapshot[],
  opts: { readonly accessible: boolean },
): PoolCandidates {
  const byKind = (kind: PoolKind) =>
    pools.filter((p) => p.kind === kind).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  if (opts.accessible) {
    if (!user.accessibleEligible) return { ok: false, reason: "NOT_ELIGIBLE" };
    return { ok: true, pools: byKind("accessible") };
  }
  return { ok: true, pools: GENERAL_ORDER[user.userType].flatMap(byKind) };
}

/** The first pool, in draw order, with room for one more claim across the whole window. */
export function choosePool(
  candidates: readonly PoolSnapshot[],
  claims: readonly Claim[],
  window: TimeWindow,
): PoolSnapshot | null {
  for (const pool of candidates) {
    const inPool = claims.filter((c) => c.poolId === pool.id);
    if (peakOccupancy(inPool, window) + 1 <= pool.capacity) return pool;
  }
  return null;
}
