import type pg from "pg";
import type { Claim, HoldSnapshot, PoolSnapshot, ReservationStore, ReservationTx, UserSnapshot } from "@availo/engine";

/**
 * Postgres implementation of the engine's store port.
 *
 * Isolation is READ COMMITTED; correctness comes from explicit row locks.
 * Bays are unnumbered, so capacity is a count per pool and an exclusion
 * constraint cannot express "at most N overlapping". Instead every booking takes
 * `SELECT … FOR UPDATE` on its candidate pool rows, which serialises bookings
 * against a pool while leaving other pools and lots free (US-023).
 */
export function createPgReservationStore(pool: pg.Pool): ReservationStore {
  return {
    transaction: (work) => withPgTransaction(pool, (_client, tx) => work(tx)),
  };
}

/**
 * One transaction that gives the caller both the engine's port and the raw
 * client, so work outside the engine — locking a payment row, writing the
 * payment ledger — commits or rolls back together with the engine's writes.
 */
export async function withPgTransaction<T>(pool: pg.Pool, work: (client: pg.PoolClient, tx: ReservationTx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client, pgTx(client));
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

interface HoldRow {
  id: string; reference: string; user_id: string; vehicle_id: string; lot_id: string; pool_id: string; s: Date; e: Date;
  hours: number; tariff_id: string; rate_applied_kobo: string; service_fee_kobo: string; amount_kobo: string;
  expires_at: Date; released_at: Date | null; release_reason: HoldSnapshot["releaseReason"];
}
const HOLD_COLS = `id, reference, user_id, vehicle_id, lot_id, pool_id, lower(time_window) AS s, upper(time_window) AS e, hours, tariff_id,
  rate_applied_kobo::text, service_fee_kobo::text, amount_kobo::text, expires_at, released_at, release_reason`;
const toHold = (r: HoldRow): HoldSnapshot => ({
  id: r.id, reference: r.reference, userId: r.user_id, vehicleId: r.vehicle_id, lotId: r.lot_id, poolId: r.pool_id,
  window: { start: r.s, end: r.e }, hours: r.hours, tariffId: r.tariff_id, rateAppliedKobo: BigInt(r.rate_applied_kobo),
  serviceFeeKobo: BigInt(r.service_fee_kobo), amountKobo: BigInt(r.amount_kobo), expiresAt: r.expires_at,
  releasedAt: r.released_at, releaseReason: r.release_reason,
});

interface PoolRow { id: string; lot_id: string; kind: PoolSnapshot["kind"]; capacity: number }
const toPool = (r: PoolRow): PoolSnapshot => ({ id: r.id, lotId: r.lot_id, kind: r.kind, capacity: r.capacity });

/** A plain object of functions over one client — one transaction. */
function pgTx(c: pg.PoolClient): ReservationTx {
  return {
    async getUser(userId) {
      const { rows } = await c.query<{ id: string; user_type: UserSnapshot["userType"]; verification_state: UserSnapshot["verificationState"]; accessible_eligible: boolean; wallet_enabled: boolean | null }>(
        `SELECT u.id, u.user_type, u.verification_state, u.accessible_eligible, r.wallet_enabled
           FROM app_user u LEFT JOIN user_type_rule r ON r.user_type = u.user_type WHERE u.id = $1`,
        [userId],
      );
      const r = rows[0];
      return r ? {
        id: r.id, userType: r.user_type, verificationState: r.verification_state, accessibleEligible: r.accessible_eligible,
        walletEnabled: r.wallet_enabled ?? false,
      } : null;
    },

    async vehicleBelongsTo(vehicleId, userId) {
      const { rowCount } = await c.query("SELECT 1 FROM vehicle WHERE id = $1 AND user_id = $2 AND active", [vehicleId, userId]);
      return rowCount === 1;
    },

    async tariffInForce(lotId, userType, at) {
      // A type-specific tariff wins over the all-types tariff; latest effective version wins.
      const { rows } = await c.query<{ id: string; hourly_rate_kobo: string; service_fee_kobo: string; min_hours: number; max_hours: number }>(
        `SELECT id, hourly_rate_kobo::text, service_fee_kobo::text, min_hours, max_hours FROM tariff
         WHERE lot_id = $1 AND effective_from <= $3 AND (user_type = $2 OR user_type IS NULL)
         ORDER BY (user_type IS NULL), effective_from DESC LIMIT 1`,
        [lotId, userType, at],
      );
      const r = rows[0];
      return r ? { id: r.id, hourlyRateKobo: BigInt(r.hourly_rate_kobo), serviceFeeKobo: BigInt(r.service_fee_kobo), minHours: r.min_hours, maxHours: r.max_hours } : null;
    },

    async listPools(lotId) {
      const { rows } = await c.query<PoolRow>("SELECT id, lot_id, kind, capacity FROM capacity_pool WHERE lot_id = $1", [lotId]);
      return rows.map(toPool);
    },

    async lockPools(poolIds) {
      // LockRows runs above the Sort, so rows are locked in id order: no deadlocks between bookings.
      const { rows } = await c.query<PoolRow>(
        "SELECT id, lot_id, kind, capacity FROM capacity_pool WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
        [poolIds],
      );
      return rows.map(toPool);
    },

    async lockWallet(userId) {
      // NO KEY UPDATE still lets this transaction's ledger insert take its FK KEY SHARE lock.
      await c.query("SELECT 1 FROM app_user WHERE id = $1 FOR NO KEY UPDATE", [userId]);
    },

    async claimsOverlapping(poolIds, window, now, excludeHoldId) {
      const { rows } = await c.query<{ pool_id: string; s: Date; e: Date }>(
        `SELECT pool_id, lower(time_window) AS s, upper(time_window) AS e FROM reservation
          WHERE pool_id = ANY($1::uuid[]) AND status = 'confirmed' AND time_window && tstzrange($2, $3, '[)')
         UNION ALL
         SELECT pool_id, lower(time_window), upper(time_window) FROM inventory_hold
          WHERE pool_id = ANY($1::uuid[]) AND released_at IS NULL AND expires_at > $4
            AND time_window && tstzrange($2, $3, '[)') AND id IS DISTINCT FROM $5::uuid`,
        [poolIds, window.start, window.end, now, excludeHoldId ?? null],
      );
      return rows.map((r): Claim => ({ poolId: r.pool_id, window: { start: r.s, end: r.e } }));
    },

    async walletBalanceKobo(userId) {
      const { rows } = await c.query<{ b: string }>(
        "SELECT COALESCE(sum(amount_kobo), 0)::text AS b FROM wallet_entry WHERE user_id = $1",
        [userId],
      );
      return BigInt(rows[0]!.b);
    },

    async walletBalances(userId) {
      const { rows } = await c.query<{ t: string; a: string }>(
        "SELECT COALESCE(sum(amount_kobo), 0)::text AS t, COALESCE(sum(allocated_kobo), 0)::text AS a FROM wallet_entry WHERE user_id = $1",
        [userId],
      );
      return { totalKobo: BigInt(rows[0]!.t), allocatedKobo: BigInt(rows[0]!.a) };
    },

    async appendWalletDebit({ userId, amountKobo, allocatedKobo, reference }) {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO wallet_entry (user_id, entry_type, amount_kobo, allocated_kobo, reference, actor)
         VALUES ($1::uuid, 'reservation_debit', $2, $3, $4, $1::text) RETURNING id`,
        [userId, (-amountKobo).toString(), (-allocatedKobo).toString(), reference],
      );
      return rows[0]!.id;
    },

    async insertReservation(r) {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO reservation (reference, user_id, vehicle_id, lot_id, pool_id, time_window, hours, tariff_id, rate_applied_kobo,
                                  service_fee_kobo, amount_kobo, wallet_entry_id, payment_transaction_id, hold_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, tstzrange($6, $7, '[)'), $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
        [r.reference, r.userId, r.vehicleId, r.lotId, r.poolId, r.window.start, r.window.end, r.hours,
         r.tariffId, r.rateAppliedKobo.toString(), r.serviceFeeKobo.toString(), r.amountKobo.toString(),
         r.walletEntryId ?? null, r.paymentTransactionId ?? null, r.holdId ?? null, r.idempotencyKey ?? null],
      );
      return rows[0]!.id;
    },

    async liveHoldFor(userId, now) {
      const { rows } = await c.query<HoldRow>(
        `SELECT ${HOLD_COLS} FROM inventory_hold WHERE user_id = $1 AND released_at IS NULL AND expires_at > $2
          ORDER BY created_at DESC LIMIT 1`,
        [userId, now],
      );
      return rows[0] ? toHold(rows[0]) : null;
    },

    async insertHold(h) {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO inventory_hold (reference, user_id, vehicle_id, lot_id, pool_id, time_window, hours, tariff_id,
                                     rate_applied_kobo, service_fee_kobo, amount_kobo, expires_at, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, tstzrange($6, $7, '[)'), $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
        [h.reference, h.userId, h.vehicleId, h.lotId, h.poolId, h.window.start, h.window.end, h.hours, h.tariffId,
         h.rateAppliedKobo.toString(), h.serviceFeeKobo.toString(), h.amountKobo.toString(), h.expiresAt, h.idempotencyKey ?? null],
      );
      return rows[0]!.id;
    },

    async getHold(holdId) {
      const { rows } = await c.query<HoldRow>(`SELECT ${HOLD_COLS} FROM inventory_hold WHERE id = $1`, [holdId]);
      return rows[0] ? toHold(rows[0]) : null;
    },

    async lockHold(holdId) {
      const { rows } = await c.query<HoldRow>(`SELECT ${HOLD_COLS} FROM inventory_hold WHERE id = $1 FOR UPDATE`, [holdId]);
      return rows[0] ? toHold(rows[0]) : null;
    },

    async releaseHold(holdId, reason, at) {
      await c.query(
        "UPDATE inventory_hold SET released_at = $3, release_reason = $2 WHERE id = $1 AND released_at IS NULL",
        [holdId, reason, at],
      );
    },

    async vehicleBookedDuring(vehicleId, window) {
      const { rowCount } = await c.query(
        "SELECT 1 FROM reservation WHERE vehicle_id = $1 AND status = 'confirmed' AND time_window && tstzrange($2, $3, '[)') LIMIT 1",
        [vehicleId, window.start, window.end],
      );
      return (rowCount ?? 0) > 0;
    },

    async reservationForHold(holdId) {
      const { rows } = await c.query<{ id: string }>("SELECT id FROM reservation WHERE hold_id = $1", [holdId]);
      return rows[0]?.id ?? null;
    },
  };
}
