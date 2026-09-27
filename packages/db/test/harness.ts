import pg from "pg";
import { migrate } from "../src/migrate.js";

export const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/availo_test";

/** Rate used by tests only. The pilot rate is OD-04 and is not set here. */
export const TEST_RATE_KOBO = 50_000n; // ₦500/hour
export const HOUR = 3_600_000;

export interface SeededLot {
  lotId: string;
  pools: { campus: string; open: string; accessible: string };
  tariffId: string;
}

export interface SeededDriver {
  userId: string;
  vehicleId: string;
  openingBalanceKobo: bigint;
}

/** Drops and rebuilds the schema from migrations. */
export async function resetDatabase(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(client);
  } finally {
    client.release();
  }
}

/** HLR §4.13 step 1: 20 bays — 12 campus ring-fence, 6 open, 2 accessible. */
export async function seedPilotLot(pool: pg.Pool, split = { campus: 12, open: 6, accessible: 2 }): Promise<SeededLot> {
  const total = split.campus + split.open + split.accessible;
  const { rows: [property] } = await pool.query<{ id: string }>(
    "INSERT INTO property (name) VALUES ('University of Lagos') RETURNING id",
  );
  const { rows: [lot] } = await pool.query<{ id: string }>(
    "INSERT INTO lot (property_id, name, total_bays) VALUES ($1, 'Pilot lot', $2) RETURNING id",
    [property!.id, total],
  );
  const pools = {} as SeededLot["pools"];
  for (const kind of ["campus", "open", "accessible"] as const) {
    const { rows: [p] } = await pool.query<{ id: string }>(
      "INSERT INTO capacity_pool (lot_id, kind, capacity) VALUES ($1, $2, $3) RETURNING id",
      [lot!.id, kind, split[kind]],
    );
    pools[kind] = p!.id;
  }
  const { rows: [tariff] } = await pool.query<{ id: string }>(
    `INSERT INTO tariff (lot_id, hourly_rate_kobo, min_hours, max_hours, effective_from, created_by)
     VALUES ($1, $2, 1, 12, '2000-01-01', 'test-seed') RETURNING id`,
    [lot!.id, TEST_RATE_KOBO.toString()],
  );
  return { lotId: lot!.id, pools, tariffId: tariff!.id };
}

let driverSeq = 0;

/** Creates verified drivers, each with one vehicle and a seeded wallet top-up. */
export async function seedDrivers(
  pool: pg.Pool,
  count: number,
  opts: { userType?: "staff" | "student" | "guest"; balanceKobo?: bigint; accessibleEligible?: boolean } = {},
): Promise<SeededDriver[]> {
  const userType = opts.userType ?? "staff";
  const balance = opts.balanceKobo ?? 1_000_000n; // ₦10,000
  const drivers: SeededDriver[] = [];
  for (let i = 0; i < count; i++) {
    const n = ++driverSeq;
    const { rows: [u] } = await pool.query<{ id: string }>(
      `INSERT INTO app_user (mobile_e164, display_name, user_type, campus_identifier, verification_state, accessible_eligible)
       VALUES ($1, $2, $3, $4, 'verified', $5) RETURNING id`,
      [`+2348${String(n).padStart(9, "0")}`, `Driver ${n}`, userType, userType === "guest" ? null : `ID${n}`, opts.accessibleEligible ?? false],
    );
    const plate = `LAG${String(n).padStart(4, "0")}AA`;
    const { rows: [v] } = await pool.query<{ id: string }>(
      "INSERT INTO vehicle (user_id, plate_display, plate_normalised) VALUES ($1, $2, $2) RETURNING id",
      [u!.id, plate],
    );
    if (balance > 0n) {
      await pool.query(
        "INSERT INTO wallet_entry (user_id, entry_type, amount_kobo, reference, actor) VALUES ($1, 'top_up', $2, $3, 'test-seed')",
        [u!.id, balance.toString(), `SEED-${n}`],
      );
    }
    drivers.push({ userId: u!.id, vehicleId: v!.id, openingBalanceKobo: balance });
  }
  return drivers;
}

/**
 * Independent check of the US-023 invariant, written in SQL and sharing no code
 * with the engine: for every pool, the peak number of simultaneous claims at any
 * instant never exceeds the pool's capacity. Peak concurrency over half-open
 * intervals is always reached at some interval's start, so those are the only
 * instants that need checking.
 */
export async function capacityBreaches(pool: pg.Pool): Promise<Array<{ kind: string; capacity: number; peak: number }>> {
  const { rows } = await pool.query<{ kind: string; capacity: number; peak: string }>(`
    WITH claims AS (
      SELECT pool_id, time_window FROM reservation WHERE status = 'confirmed'
      UNION ALL
      SELECT pool_id, time_window FROM inventory_hold WHERE released_at IS NULL AND expires_at > now()
    ),
    instants AS (SELECT DISTINCT pool_id, lower(time_window) AS t FROM claims)
    SELECT cp.kind::text AS kind, cp.capacity,
           max((SELECT count(*) FROM claims c WHERE c.pool_id = i.pool_id AND c.time_window @> i.t)) AS peak
    FROM instants i JOIN capacity_pool cp ON cp.id = i.pool_id
    GROUP BY cp.id, cp.kind, cp.capacity`);
  return rows
    .map((r) => ({ kind: r.kind, capacity: r.capacity, peak: Number(r.peak) }))
    .filter((r) => r.peak > r.capacity);
}

/** Balance derived from the ledger, computed independently of the engine. */
export async function ledgerBalance(pool: pg.Pool, userId: string): Promise<bigint> {
  const { rows: [r] } = await pool.query<{ b: string }>(
    "SELECT COALESCE(sum(amount_kobo), 0)::text AS b FROM wallet_entry WHERE user_id = $1",
    [userId],
  );
  return BigInt(r!.b);
}

export async function countRows(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<number> {
  const { rows: [r] } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM (${sql}) q`, params);
  return Number(r!.n);
}

/** A window of `hours` starting at `hourOfDay` UTC on a day `dayOffset` days after a fixed future date. */
export function windowStart(dayOffset: number, hourOfDay: number): Date {
  return new Date(Date.UTC(2030, 0, 1 + dayOffset, hourOfDay));
}

export const NOW = new Date(Date.UTC(2029, 11, 31, 12));
