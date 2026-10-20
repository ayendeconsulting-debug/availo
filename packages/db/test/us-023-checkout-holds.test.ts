/**
 * US-023 on the checkout path — RELEASE GATE (HLR §2.3, NFR-ARC-09).
 *
 * US-135: a hold counts against pool capacity exactly as a confirmed
 * reservation does, so the hard cap holds while checkout payments are in
 * flight; a hold converts to a reservation without releasing and re-taking the
 * space; a hold that lapsed can convert only if the space is still free.
 *
 * Real Postgres, real concurrency. Payments are represented by verified
 * payment rows; the provider itself is exercised in the API tests.
 */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  convertHold, placeHold, reserve,
  type ConvertHoldResult, type HoldResult, type ReservationStore, type ReserveResult,
} from "@availo/engine";
import { createPgReservationStore } from "../src/index.js";
import {
  DATABASE_URL, HOUR, NOW, TEST_RATE_KOBO,
  capacityBreaches, countRows, insertPaymentFor, ledgerBalance, resetDatabase, seedDrivers, seedPilotLot, windowStart,
  type SeededDriver, type SeededLot,
} from "./harness.js";

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 40 });
let store: ReservationStore;
let lot: SeededLot;
let ref = 0;

const guests = (n: number) => seedDrivers(pool, n, { userType: "guest", balanceKobo: 0n });

function hold(d: SeededDriver, start: Date, hours = 1, now = NOW, lotId = lot.lotId): Promise<HoldResult> {
  return placeHold(store, { reference: `H-${++ref}`, userId: d.userId, vehicleId: d.vehicleId, lotId, start, hours, now, holdMinutes: 10 });
}
function book(d: SeededDriver, start: Date, hours = 1): Promise<ReserveResult> {
  return reserve(store, { reference: `R-${++ref}`, userId: d.userId, vehicleId: d.vehicleId, lotId: lot.lotId, start, hours, now: NOW });
}
async function convert(holdId: string, now = NOW, paymentId?: string): Promise<ConvertHoldResult> {
  return convertHold(store, { holdId, paymentTransactionId: paymentId ?? (await insertPaymentFor(pool, holdId)), now });
}
const okCount = (rs: Array<{ ok: boolean }>) => rs.filter((r) => r.ok).length;
const liveHolds = (at = NOW) => countRows(pool, "SELECT 1 FROM inventory_hold WHERE released_at IS NULL AND expires_at > $1", [at]);

beforeAll(() => { store = createPgReservationStore(pool); });
beforeEach(async () => {
  await resetDatabase(pool);
  lot = await seedPilotLot(pool); // 12 campus / 6 open / 2 accessible
});
afterAll(async () => { await pool.end(); });

describe("US-023 / US-135 holds at the capacity boundary", () => {
  it("20 guests check out at the same instant against the 6-space open share: exactly 6 holds, none on the ring-fence", async () => {
    const gs = await guests(20);
    const start = windowStart(0, 9);
    const results = await Promise.all(gs.map((g) => hold(g, start)));
    expect(okCount(results)).toBe(6);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "NO_CAPACITY")).toBe(true);
    expect(await countRows(pool, "SELECT 1 FROM inventory_hold WHERE pool_id = $1", [lot.pools.open])).toBe(6);
    expect(await countRows(pool, "SELECT 1 FROM inventory_hold WHERE pool_id <> $1", [lot.pools.open])).toBe(0);
    expect(await capacityBreaches(pool)).toEqual([]);
  });

  it("wallet bookings and checkout holds racing for the same open share: exactly 6 win between them, losers pay nothing", async () => {
    const start = windowStart(1, 9);
    const fill = await seedDrivers(pool, 12);
    for (const d of fill) expect((await book(d, start)).ok).toBe(true); // the ring-fence is full
    const staff = await seedDrivers(pool, 10);
    const gs = await guests(10);
    const results = await Promise.all([...staff.map((d) => book(d, start)), ...gs.map((g) => hold(g, start))]);
    expect(okCount(results)).toBe(6);
    for (const [i, d] of staff.entries()) {
      expect(await ledgerBalance(pool, d.userId)).toBe(results[i]!.ok ? d.openingBalanceKobo - TEST_RATE_KOBO : d.openingBalanceKobo);
    }
    expect(await capacityBreaches(pool)).toEqual([]);
  });

  it("repeats the mixed race ten times without a single breach", async () => {
    for (let round = 0; round < 10; round++) {
      const start = windowStart(10 + round, 9);
      const fill = await seedDrivers(pool, 12);
      await Promise.all(fill.map((d) => book(d, start)));
      const staff = await seedDrivers(pool, 4);
      const gs = await guests(6);
      const results = await Promise.all([...staff.map((d) => book(d, start)), ...gs.map((g) => hold(g, start))]);
      expect(okCount(results)).toBe(6);
      expect(await capacityBreaches(pool)).toEqual([]);
    }
  });
});

describe("US-135 a hold converts without releasing and re-taking capacity", () => {
  it("6 live holds convert while 10 more guests and 6 staff try for the open share: all 6 convert, nobody else gets in", async () => {
    const start = windowStart(2, 9);
    const fill = await seedDrivers(pool, 12);
    for (const d of fill) await book(d, start);
    const holders = await guests(6);
    const holds = await Promise.all(holders.map((g) => hold(g, start)));
    const ids = holds.map((h) => (h.ok ? h.holdId : ""));
    const payments = await Promise.all(ids.map((id) => insertPaymentFor(pool, id)));
    const others = await guests(10);
    const staff = await seedDrivers(pool, 6);

    const [conversions, attempts] = await Promise.all([
      Promise.all(ids.map((id, i) => convert(id, NOW, payments[i]))),
      Promise.all([...others.map((g) => hold(g, start)), ...staff.map((d) => book(d, start))]),
    ]);
    expect(conversions.every((c) => c.ok && !c.alreadyConverted && !c.late)).toBe(true);
    expect(okCount(attempts)).toBe(0);
    expect(await countRows(pool, "SELECT 1 FROM reservation WHERE pool_id = $1 AND hold_id IS NOT NULL", [lot.pools.open])).toBe(6);
    expect(await liveHolds()).toBe(0);
    expect(await capacityBreaches(pool)).toEqual([]);
  });

  it("stores the quote from the hold: a rate change after the hold does not change the booking (US-013)", async () => {
    const [g] = await guests(1);
    const h = await hold(g!, windowStart(3, 9), 2);
    expect(h.ok).toBe(true);
    await pool.query(
      "INSERT INTO tariff (lot_id, hourly_rate_kobo, min_hours, max_hours, effective_from, created_by) VALUES ($1, $2, 1, 12, $3, 'test')",
      [lot.lotId, (TEST_RATE_KOBO * 3n).toString(), new Date(NOW.getTime() - 1000)]);
    const c = await convert(h.ok ? h.holdId : "");
    expect(c.ok).toBe(true);
    const { rows: [r] } = await pool.query("SELECT rate_applied_kobo::text AS rate, amount_kobo::text AS amount FROM reservation");
    expect(r).toEqual({ rate: TEST_RATE_KOBO.toString(), amount: (TEST_RATE_KOBO * 2n).toString() });
  });

  it("converts once however many times the same payment is verified at once", async () => {
    const [g] = await guests(1);
    const h = await hold(g!, windowStart(4, 9));
    const holdId = h.ok ? h.holdId : "";
    const payment = await insertPaymentFor(pool, holdId);
    const results = await Promise.all(Array.from({ length: 6 }, () => convert(holdId, NOW, payment)));
    expect(results.filter((r) => r.ok && !r.alreadyConverted)).toHaveLength(1);
    expect(results.filter((r) => r.ok && r.alreadyConverted)).toHaveLength(5);
    expect(await countRows(pool, "SELECT 1 FROM reservation")).toBe(1);
  });

  it("a second payment for an already converted hold is reported, not booked again", async () => {
    const [g] = await guests(1);
    const h = await hold(g!, windowStart(4, 12));
    const holdId = h.ok ? h.holdId : "";
    const [a, b] = await Promise.all([convert(holdId), convert(holdId)]);
    expect([a, b].filter((r) => r.ok && !r.alreadyConverted)).toHaveLength(1);
    expect([a, b].filter((r) => r.ok && r.alreadyConverted)).toHaveLength(1);
    expect(await countRows(pool, "SELECT 1 FROM reservation")).toBe(1);
  });
});

describe("US-135 lapsed holds", () => {
  it("returns the space the instant a hold expires, with no job having run", async () => {
    const gs = await guests(7);
    const start = windowStart(5, 9);
    for (const g of gs.slice(0, 6)) expect((await hold(g, start)).ok).toBe(true);
    expect(await hold(gs[6]!, start)).toMatchObject({ ok: false, reason: "NO_CAPACITY" });
    const after = new Date(NOW.getTime() + 10 * 60_000); // exactly at expiry
    expect((await hold(gs[6]!, start, 1, after)).ok).toBe(true);
  });

  it("at the instant of expiry, late conversions and new holds race: exactly 6 between them", async () => {
    const start = windowStart(6, 9);
    const first = await guests(6);
    const holds = await Promise.all(first.map((g) => hold(g, start)));
    const ids = holds.map((h) => (h.ok ? h.holdId : ""));
    const payments = await Promise.all(ids.map((id) => insertPaymentFor(pool, id)));
    const at = new Date(NOW.getTime() + 10 * 60_000);
    const second = await guests(6);
    const [late, fresh] = await Promise.all([
      Promise.all(ids.map((id, i) => convert(id, at, payments[i]))),
      Promise.all(second.map((g) => hold(g, start, 1, at))),
    ]);
    expect(okCount(late) + okCount(fresh)).toBe(6);
    expect(late.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "NO_CAPACITY")).toBe(true);
    expect(late.filter((r) => r.ok).every((r) => r.ok && r.late)).toBe(true);
    expect(await capacityBreaches(pool, at)).toEqual([]);
  });

  it("a late payment cannot take back a space that went to someone else after its hold lapsed", async () => {
    const start = windowStart(6, 12);
    const first = await guests(6);
    const ids = (await Promise.all(first.map((g) => hold(g, start)))).map((h) => (h.ok ? h.holdId : ""));
    const at = new Date(NOW.getTime() + 10 * 60_000);
    for (const g of await guests(6)) expect((await hold(g, start, 1, at)).ok).toBe(true);
    const late = await Promise.all(ids.map((id) => convert(id, at)));
    expect(late.every((r) => !r.ok && r.reason === "NO_CAPACITY")).toBe(true);
    expect(await countRows(pool, "SELECT 1 FROM reservation")).toBe(0);
    expect(await capacityBreaches(pool, at)).toEqual([]);
  });

  it("a late payment converts when the space is still free", async () => {
    const [g] = await guests(1);
    const h = await hold(g!, windowStart(7, 9));
    const c = await convert(h.ok ? h.holdId : "", new Date(NOW.getTime() + 30 * 60_000));
    expect(c).toMatchObject({ ok: true, late: true, alreadyConverted: false });
  });

  it("never converts a hold the driver cancelled", async () => {
    const [g] = await guests(1);
    const h = await hold(g!, windowStart(7, 12));
    const holdId = h.ok ? h.holdId : "";
    await pool.query("UPDATE inventory_hold SET released_at = $2, release_reason = 'cancelled' WHERE id = $1", [holdId, NOW]);
    expect(await convert(holdId)).toEqual({ ok: false, reason: "HOLD_CANCELLED" });
    expect(await countRows(pool, "SELECT 1 FROM reservation")).toBe(0);
  });

  it("refuses a late conversion when the driver has since booked the same car for that time (US-026)", async () => {
    const [g] = await guests(1);
    const start = windowStart(8, 9);
    const h1 = await hold(g!, start);
    const later = new Date(NOW.getTime() + 11 * 60_000);
    const h2 = await hold(g!, start, 1, later);
    expect((await convert(h2.ok ? h2.holdId : "", later)).ok).toBe(true);
    expect(await convert(h1.ok ? h1.holdId : "", later)).toEqual({ ok: false, reason: "VEHICLE_ALREADY_BOOKED" });
    expect(await countRows(pool, "SELECT 1 FROM reservation")).toBe(1);
  });
});

describe("US-135 one live hold per driver", () => {
  it("five checkouts by one driver at the same instant: exactly one hold", async () => {
    const [g] = await guests(1);
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => hold(g!, windowStart(9, 8 + i))));
    expect(okCount(results)).toBe(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "CHECKOUT_IN_PROGRESS" && typeof r.holdId === "string")).toBe(true);
  });

  it("one driver checking out at several sites at the same instant still gets exactly one hold", async () => {
    const others = await Promise.all([seedPilotLot(pool), seedPilotLot(pool), seedPilotLot(pool)]);
    const [g] = await guests(1);
    for (let round = 0; round < 5; round++) {
      const start = windowStart(20 + round, 9);
      const results = await Promise.all([lot, ...others].flatMap((l) => [hold(g!, start, 1, NOW, l.lotId), hold(g!, start, 1, NOW, l.lotId)]));
      expect(okCount(results)).toBe(1);
      await pool.query("UPDATE inventory_hold SET released_at = $1, release_reason = 'cancelled' WHERE released_at IS NULL", [NOW]);
    }
  });

  it("an on-time conversion is refused when a lapsed earlier hold for the same car converted first (US-026)", async () => {
    const [g] = await guests(1);
    const start = windowStart(9, 14);
    const a = await hold(g!, start);
    const later = new Date(NOW.getTime() + 11 * 60_000);
    const b = await hold(g!, start, 1, later); // A has lapsed, so B is allowed
    expect((await convert(a.ok ? a.holdId : "", later)).ok).toBe(true); // A's bank transfer lands late
    expect(await convert(b.ok ? b.holdId : "", later)).toEqual({ ok: false, reason: "VEHICLE_ALREADY_BOOKED" });
    expect(await countRows(pool, "SELECT 1 FROM reservation")).toBe(1);
  });

  it("refuses the checkout path to a wallet driver and the wallet path to a guest", async () => {
    const [d] = await seedDrivers(pool, 1);
    const [g] = await guests(1);
    expect(await hold(d!, windowStart(9, 9))).toMatchObject({ ok: false, reason: "CHECKOUT_PATH_NOT_AVAILABLE" });
    expect(await book(g!, windowStart(9, 9))).toEqual({ ok: false, reason: "WALLET_PATH_NOT_AVAILABLE" });
  });

  it("refuses a hold for a vehicle already booked for an overlapping time (US-026)", async () => {
    const [g] = await guests(1);
    const h = await hold(g!, windowStart(9, 9), 2);
    await convert(h.ok ? h.holdId : "");
    expect(await hold(g!, new Date(windowStart(9, 9).getTime() + HOUR), 2)).toMatchObject({ ok: false, reason: "VEHICLE_ALREADY_BOOKED" });
  });
});
