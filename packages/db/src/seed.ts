import pg from "pg";

/**
 * Sprint 1 seed (handover §7 item 5, HLR §4.13 step 1): one property, one lot of
 * 20 bays split 12 campus / 6 open / 2 accessible, one tariff, and three staff
 * drivers with vehicles and seeded wallet balances.
 *
 * The hourly rate is a placeholder. The pilot rate is OD-04 and is not decided.
 */
export const SEED = {
  property: "University of Lagos",
  lot: "UNILAG Pilot Lot",
  pools: { campus: 12, open: 6, accessible: 2 },
  placeholderRateKobo: 50_000n, // ₦500/hour — PLACEHOLDER pending OD-04
  drivers: [
    { name: "Adaeze Okafor", mobile: "+2348030000001", staffNo: "UNILAG-S-0001", plate: "LND123AB", balanceKobo: 500_000n },
    { name: "Tunde Bakare", mobile: "+2348030000002", staffNo: "UNILAG-S-0002", plate: "KJA456CD", balanceKobo: 300_000n },
    { name: "Ngozi Eze", mobile: "+2348030000003", staffNo: "UNILAG-S-0003", plate: "EKY789EF", balanceKobo: 100_000n },
  ],
} as const;

export interface SeedResult {
  lotId: string;
  users: Array<{ id: string; mobile: string; vehicleId: string }>;
}

export async function seed(client: pg.ClientBase): Promise<SeedResult> {
  const existing = await client.query("SELECT 1 FROM lot LIMIT 1");
  if (existing.rowCount) throw new Error("Refusing to seed: the database already has a lot.");

  await client.query("BEGIN");
  try {
    const { rows: [property] } = await client.query<{ id: string }>(
      "INSERT INTO property (name) VALUES ($1) RETURNING id", [SEED.property]);
    const total = SEED.pools.campus + SEED.pools.open + SEED.pools.accessible;
    const { rows: [lot] } = await client.query<{ id: string }>(
      "INSERT INTO lot (property_id, name, total_bays) VALUES ($1, $2, $3) RETURNING id", [property!.id, SEED.lot, total]);
    for (const [kind, capacity] of Object.entries(SEED.pools)) {
      await client.query("INSERT INTO capacity_pool (lot_id, kind, capacity) VALUES ($1, $2, $3)", [lot!.id, kind, capacity]);
    }
    await client.query(
      `INSERT INTO tariff (lot_id, hourly_rate_kobo, min_hours, max_hours, effective_from, created_by)
       VALUES ($1, $2, 1, 12, '2000-01-01', 'seed: placeholder rate pending OD-04')`,
      [lot!.id, SEED.placeholderRateKobo.toString()]);

    const users: SeedResult["users"] = [];
    for (const d of SEED.drivers) {
      const { rows: [u] } = await client.query<{ id: string }>(
        `INSERT INTO app_user (mobile_e164, display_name, user_type, campus_identifier, verification_state, verified_at, verified_by)
         VALUES ($1, $2, 'staff', $3, 'verified', now(), 'seed') RETURNING id`,
        [d.mobile, d.name, d.staffNo]);
      const { rows: [v] } = await client.query<{ id: string }>(
        "INSERT INTO vehicle (user_id, plate_display, plate_normalised) VALUES ($1, $2, $2) RETURNING id", [u!.id, d.plate]);
      await client.query(
        `INSERT INTO wallet_entry (user_id, entry_type, amount_kobo, reference, actor)
         VALUES ($1, 'allocation', $2, $3, 'seed')`,
        [u!.id, d.balanceKobo.toString(), `SEED-${d.staffNo}`]);
      users.push({ id: u!.id, mobile: d.mobile, vehicleId: v!.id });
    }
    await client.query("COMMIT");
    return { lotId: lot!.id, users };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const r = await seed(client);
    console.log(`Seeded lot ${r.lotId} with ${r.users.length} staff drivers.`);
  } finally {
    await client.end();
  }
}
