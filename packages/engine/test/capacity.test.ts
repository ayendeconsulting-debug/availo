/** Pure-engine unit tests for the capacity rules behind US-023, US-024, US-133. No database. */
import { describe, expect, it } from "vitest";
import { candidatePools, peakOccupancy, type Claim, type PoolSnapshot, type UserSnapshot } from "../src/index.js";

const h = (hour: number) => new Date(Date.UTC(2030, 0, 1, hour));
const w = (from: number, to: number) => ({ start: h(from), end: h(to) });
const claim = (from: number, to: number, poolId = "p"): Claim => ({ poolId, window: w(from, to) });

describe("peakOccupancy (US-023)", () => {
  it("is zero with no claims", () => {
    expect(peakOccupancy([], w(9, 12))).toBe(0);
  });

  it("is the maximum simultaneous claims within the window, not the number of overlapping claims", () => {
    // 09–10 ×2 and 11–12 ×2 overlap 09–12 four times, but never more than two at once.
    const claims = [claim(9, 10), claim(9, 10), claim(11, 12), claim(11, 12)];
    expect(peakOccupancy(claims, w(9, 12))).toBe(2);
  });

  it("treats windows as half-open: touching intervals do not overlap", () => {
    expect(peakOccupancy([claim(8, 9), claim(12, 13)], w(9, 12))).toBe(0);
    expect(peakOccupancy([claim(9, 10), claim(10, 11)], w(9, 12))).toBe(1);
  });

  it("counts only the part of a claim inside the window", () => {
    // Three claims overlap each other only at 07–08, outside the window 08–10.
    const claims = [claim(6, 8), claim(7, 9), claim(7, 10)];
    expect(peakOccupancy(claims, w(8, 10))).toBe(2);
  });

  it("finds a peak that starts mid-window", () => {
    const claims = [claim(9, 12), claim(10, 11), claim(10, 12), claim(11, 12)];
    expect(peakOccupancy(claims, w(9, 12))).toBe(3);
  });
});

describe("candidatePools (US-133, US-024, US-047)", () => {
  const pools: PoolSnapshot[] = [
    { id: "acc", lotId: "L", kind: "accessible", capacity: 2 },
    { id: "open", lotId: "L", kind: "open", capacity: 6 },
    { id: "camp", lotId: "L", kind: "campus", capacity: 12 },
  ];
  const user = (userType: UserSnapshot["userType"], accessibleEligible = false): UserSnapshot => ({
    id: "u", userType, verificationState: "verified", accessibleEligible,
  });
  const kinds = (r: ReturnType<typeof candidatePools>) => (r.ok ? r.pools.map((p) => p.kind) : r.reason);

  it("gives staff and students the ring-fence first, then the open share", () => {
    expect(kinds(candidatePools(user("staff"), pools, { accessible: false }))).toEqual(["campus", "open"]);
    expect(kinds(candidatePools(user("student"), pools, { accessible: false }))).toEqual(["campus", "open"]);
  });

  it("gives guests the open share only, never the ring-fence", () => {
    expect(kinds(candidatePools(user("guest"), pools, { accessible: false }))).toEqual(["open"]);
  });

  it("never offers the accessible sub-pool for a general request, even to an eligible driver", () => {
    expect(kinds(candidatePools(user("staff", true), pools, { accessible: false }))).toEqual(["campus", "open"]);
  });

  it("offers only the accessible sub-pool to an eligible driver of any type who asks for it, with no general fallback", () => {
    for (const t of ["staff", "student", "guest"] as const) {
      expect(kinds(candidatePools(user(t, true), pools, { accessible: true }))).toEqual(["accessible"]);
    }
  });

  it("refuses accessible capacity to an ineligible account whatever it sends", () => {
    expect(kinds(candidatePools(user("staff", false), pools, { accessible: true }))).toBe("NOT_ELIGIBLE");
  });
});
