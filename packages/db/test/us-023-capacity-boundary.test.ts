/**
 * US-023 — Never exceed capacity. RELEASE GATE (HLR §2.3, NFR-ARC-09).
 *
 * Overlapping confirmed reservations and active holds must never exceed a
 * pool's capacity, under any concurrency, including simultaneous confirmation
 * of the final space. Capacity and payment commit atomically (US-022): every
 * rejected attempt leaves the wallet untouched.
 *
 * These tests run against a real Postgres. Nothing here is mocked except, in
 * one test, a fault injected into the store to prove rollback.
 */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reserve, type ReservationStore, type ReserveResult } from "@availo/engine";
import { createPgReservationStore } from "../src/index.js";
import {
  DATABASE_URL, HOUR, NOW, TEST_RATE_KOBO,
  capacityBreaches, countRows, ledgerBalance, resetDatabase, seedDrivers, seedPilotLot, windowStart,
  type SeededDriver, type SeededLot,
} from "./harness.js";

// One connection per concurrent booking, so the database really sees them at once.
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 40 });
let store: ReservationStore;
let lot: SeededLot;
let ref = 0;

function book(d: SeededDriver, start: Date, hours: number, opts: { accessible?: boolean; via?: ReservationStore } = {}): Promise<ReserveResult> {
  return reserve(opts.via ?? store, {
    reference: `R-${++ref}`,
    userId: d.userId,
    vehicleId: d.vehicleId,
    lotId: lot.lotId,
    start,
    hours,
    now: NOW,
    ...(opts.accessible !== undefined ? { accessible: opts.accessible } : {}),
  });
}

/** Wallet-side assertions shared by every scenario. */
async function assertLedgerAgrees(drivers: SeededDriver[], results: ReserveResult[]): Promise<void> {
  for (const [i, d] of drivers.entries()) {
    const r = results[i]!;
    const balance = await ledgerBalance(pool, d.userId);
    const debits = await countRows(pool, "SELECT 1 FROM wallet_entry WHERE user_id = $1 AND entry_type = 'reservation_debit'", [d.userId]);
    if (r.ok) {
      expect(balance).toBe(d.openingBalanceKobo - r.amountKobo);
      expect(debits).toBe(1);
      const linked = await countRows(
        pool,
        `SELECT 1 FROM reservation r JOIN wallet_entry w ON w.id = r.wallet_entry_id
         WHERE r.id = $1 AND w.user_id = r.user_id AND w.amount_kobo = -r.amount_kobo AND w.entry_type = 'reservation_debit'`,
        [r.reservationId],
      );
      expect(linked, "reservation must reference the ledger entry that paid for it").toBe(1);
    } else {
      expect(balance, "a rejected attempt must leave the wallet untouched").toBe(d.openingBalanceKobo);
      expect(debits).toBe(0);
    }
  }
}

beforeAll(async () => {
  store = createPgReservationStore(pool);
});

beforeEach(async () => {
  await resetDatabase(pool);
  lot = await seedPilotLot(pool); // 12 campus / 6 open / 2 accessible
});

afterAll(async () => {
  await pool.end();
});

describe("US-023 capacity boundary under concurrency", () => {
  it("20 simultaneous staff confirmations against 18 general bays: exactly 18 succeed, 12 campus then 6 open, accessible untouched", async () => {
    const drivers = await seedDrivers(pool, 20);
    const start = windowStart(0, 9);

    const results = await Promise.all(drivers.map((d) => book(d, start, 3)));

    const won = results.filter((r) => r.ok);
    const lost = results.filter((r) => !r.ok);
    expect(won).toHaveLength(18);
    expect(lost).toHaveLength(2);
    for (const r of lost) expect(r).toEqual({ ok: false, reason: "NO_CAPACITY" });

    // US-133: staff draw on the ring-fence and then the open share.
    expect(won.filter((r) => r.ok && r.poolKind === "campus")).toHaveLength(12);
    expect(won.filter((r) => r.ok && r.poolKind === "open")).toHaveLength(6);
    // US-024 / US-047: accessible capacity is never released into a general pool.
    expect(await countRows(pool, "SELECT 1 FROM reservation WHERE pool_id = $1", [lot.pools.accessible])).toBe(0);

    // US-013: the rate in force is stored on the reservation; cost is hours × rate.
    for (const r of won) if (r.ok) {
      expect(r.rateAppliedKobo).toBe(TEST_RATE_KOBO);
      expect(r.amountKobo).toBe(TEST_RATE_KOBO * 3n);
    }

    expect(await capacityBreaches(pool)).toEqual([]);
    await assertLedgerAgrees(drivers, results);
  });

  it("the final space: 17 booked, 8 drivers confirm at the same instant, exactly one gets it", async () => {
    const start = windowStart(1, 9);
    const earlier = await seedDrivers(pool, 17);
    for (const d of earlier) expect((await book(d, start, 2)).ok).toBe(true);

    const racers = await seedDrivers(pool, 8);
    const results = await Promise.all(racers.map((d) => book(d, start, 2)));

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await capacityBreaches(pool)).toEqual([]);
    await assertLedgerAgrees(racers, results);
  });

  it("repeats the boundary race ten times without a single breach", async () => {
    for (let round = 0; round < 10; round++) {
      const drivers = await seedDrivers(pool, 20);
      const results = await Promise.all(drivers.map((d) => book(d, windowStart(10 + round, 8), 1 + (round % 4))));
      expect(results.filter((r) => r.ok), `round ${round}`).toHaveLength(18);
      await assertLedgerAgrees(drivers, results);
    }
    expect(await capacityBreaches(pool)).toEqual([]);
  });

  it("the same driver confirming three times at once with funds for one is debited once", async () => {
    const [d] = await seedDrivers(pool, 1, { balanceKobo: TEST_RATE_KOBO * 2n });
    const results = await Promise.all([0, 1, 2].map((k) => book(d!, windowStart(2, 9 + k * 3), 2)));

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((x) => !x.ok)) expect(r).toEqual({ ok: false, reason: "INSUFFICIENT_BALANCE" });
    expect(await ledgerBalance(pool, d!.userId)).toBe(0n);
  });
});

describe("US-023 capacity is peak occupancy over the window, not a count of overlaps", () => {
  it("admits a booking that spans two partly-full hours when peak use stays within capacity, and only one", async () => {
    // 17 of 18 general bays taken 09–10, and a different 17 taken 11–12. 10–11 is empty.
    const a = await seedDrivers(pool, 17);
    const b = await seedDrivers(pool, 17);
    for (const d of a) expect((await book(d, windowStart(3, 9), 1)).ok).toBe(true);
    for (const d of b) expect((await book(d, windowStart(3, 11), 1)).ok).toBe(true);

    // 09–12 overlaps 34 reservations, but peak occupancy with one more is 18. One fits; the second does not.
    const racers = await seedDrivers(pool, 5);
    const results = await Promise.all(racers.map((d) => book(d, windowStart(3, 9), 3)));

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await capacityBreaches(pool)).toEqual([]);
    await assertLedgerAgrees(racers, results);
  });

  it("treats windows as half-open: a booking ending at 10:00 does not block one starting at 10:00", async () => {
    const full = await seedDrivers(pool, 18);
    for (const d of full) expect((await book(d, windowStart(4, 9), 1)).ok).toBe(true);

    const [next] = await seedDrivers(pool, 1);
    expect((await book(next!, windowStart(4, 10), 1)).ok).toBe(true);
    const [blocked] = await seedDrivers(pool, 1);
    expect(await book(blocked!, windowStart(4, 9), 2)).toEqual({ ok: false, reason: "NO_CAPACITY" });
  });

  it("counts an unexpired hold exactly as a confirmed reservation, and ignores an expired one (US-135)", async () => {
    const holders = await seedDrivers(pool, 18, { balanceKobo: 0n });
    const start = windowStart(5, 9);
    for (const [i, h] of holders.entries()) {
      await pool.query(
        `INSERT INTO inventory_hold (user_id, pool_id, time_window, expires_at)
         VALUES ($1, $2, tstzrange($3, $4, '[)'), $5)`,
        [h.userId, i < 12 ? lot.pools.campus : lot.pools.open, start, new Date(start.getTime() + HOUR), new Date(NOW.getTime() + 10 * 60_000)],
      );
    }
    const [d] = await seedDrivers(pool, 1);
    expect(await book(d!, start, 1)).toEqual({ ok: false, reason: "NO_CAPACITY" });

    await pool.query("UPDATE inventory_hold SET expires_at = $1", [new Date(NOW.getTime() - 1)]);
    expect((await book(d!, start, 1)).ok).toBe(true);
  });
});

describe("US-022 capacity and payment commit together or not at all", () => {
  it("rejects a booking the wallet cannot cover in full, and commits nothing", async () => {
    const [d] = await seedDrivers(pool, 1, { balanceKobo: TEST_RATE_KOBO * 3n - 1n });
    expect(await book(d!, windowStart(6, 9), 3)).toEqual({ ok: false, reason: "INSUFFICIENT_BALANCE" });
    expect(await countRows(pool, "SELECT 1 FROM reservation")).toBe(0);
    expect(await ledgerBalance(pool, d!.userId)).toBe(d!.openingBalanceKobo);
  });

  it("rolls back the wallet debit when the reservation write fails after it", async () => {
    const faulty: ReservationStore = {
      transaction: (work) =>
        store.transaction((tx) =>
          work({
            ...bindAll(tx),
            insertReservation: async () => {
              throw new Error("injected fault after debit");
            },
          }),
        ),
    };
    const [d] = await seedDrivers(pool, 1);
    await expect(book(d!, windowStart(7, 9), 2, { via: faulty })).rejects.toThrow("injected fault");

    expect(await countRows(pool, "SELECT 1 FROM reservation")).toBe(0);
    expect(await countRows(pool, "SELECT 1 FROM wallet_entry WHERE entry_type = 'reservation_debit'")).toBe(0);
    expect(await ledgerBalance(pool, d!.userId)).toBe(d!.openingBalanceKobo);
  });
});

describe("US-023 test integrity", () => {
  it("detects a breach when the pool lock is removed — proving the boundary tests can fail", async () => {
    // Remove the lock and widen the read-then-write gap. If the tests above could
    // not catch this, they would be worthless as a release gate.
    const unlocked: ReservationStore = {
      transaction: (work) =>
        store.transaction((tx) => {
          const t = bindAll(tx);
          return work({
            ...t,
            lockPools: (ids) => t.listPools(lot.lotId).then((ps) => ps.filter((p) => ids.includes(p.id))),
            lockWallet: async () => {},
            claimsOverlapping: async (...args) => {
              const claims = await t.claimsOverlapping(...args);
              await new Promise((r) => setTimeout(r, 50));
              return claims;
            },
          });
        }),
    };
    const drivers = await seedDrivers(pool, 20);
    await Promise.all(drivers.map((d) => book(d, windowStart(8, 9), 1, { via: unlocked })));
    expect((await capacityBreaches(pool)).length).toBeGreaterThan(0);
  });
});

/** Copies a transaction object's methods, bound, so tests can override one of them. */
function bindAll<T extends object>(obj: T): T {
  const out = {} as Record<string, unknown>;
  for (const key of Object.keys(obj) as Array<keyof T & string>) {
    const v = obj[key];
    out[key] = typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(obj) : v;
  }
  return out as T;
}
