import type pg from "pg";
import type { Claim, PoolSnapshot, ReservationStore, ReservationTx, UserSnapshot } from "@availo/engine";

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
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(pgTx(client));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

interface PoolRow { id: string; lot_id: string; kind: PoolSnapshot["kind"]; capacity: number }
const toPool = (r: PoolRow): PoolSnapshot => ({ id: r.id, lotId: r.lot_id, kind: r.kind, capacity: r.capacity });

/** A plain object of functions over one client — one transaction. */
function pgTx(c: pg.PoolClient): ReservationTx {
  return {
    async getUser(userId) {
      const { rows } = await c.query<{ id: string; user_type: UserSnapshot["userType"]; verification_state: UserSnapshot["verificationState"]; accessible_eligible: boolean }>(
        "SELECT id, user_type, verification_state, accessible_eligible FROM app_user WHERE id = $1",
        [userId],
      );
      const r = rows[0];
      return r ? { id: r.id, userType: r.user_type, verificationState: r.verification_state, accessibleEligible: r.accessible_eligible } : null;
    },

    async vehicleBelongsTo(vehicleId, userId) {
      const { rowCount } = await c.query("SELECT 1 FROM vehicle WHERE id = $1 AND user_id = $2 AND active", [vehicleId, userId]);
      return rowCount === 1;
    },

    async tariffInForce(lotId, userType, at) {
      // A type-specific tariff wins over the all-types tariff; latest effective version wins.
      const { rows } = await c.query<{ id: string; hourly_rate_kobo: string; min_hours: number; max_hours: number }>(
        `SELECT id, hourly_rate_kobo::text, min_hours, max_hours FROM tariff
         WHERE lot_id = $1 AND effective_from <= $3 AND (user_type = $2 OR user_type IS NULL)
         ORDER BY (user_type IS NULL), effective_from DESC LIMIT 1`,
        [lotId, userType, at],
      );
      const r = rows[0];
      return r ? { id: r.id, hourlyRateKobo: BigInt(r.hourly_rate_kobo), minHours: r.min_hours, maxHours: r.max_hours } : null;
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

    async claimsOverlapping(poolIds, window, now) {
      const { rows } = await c.query<{ pool_id: string; s: Date; e: Date }>(
        `SELECT pool_id, lower(time_window) AS s, upper(time_window) AS e FROM reservation
          WHERE pool_id = ANY($1::uuid[]) AND status = 'confirmed' AND time_window && tstzrange($2, $3, '[)')
         UNION ALL
         SELECT pool_id, lower(time_window), upper(time_window) FROM inventory_hold
          WHERE pool_id = ANY($1::uuid[]) AND released_at IS NULL AND expires_at > $4
            AND time_window && tstzrange($2, $3, '[)')`,
        [poolIds, window.start, window.end, now],
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

    async appendWalletDebit({ userId, amountKobo, reference }) {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO wallet_entry (user_id, entry_type, amount_kobo, reference, actor)
         VALUES ($1::uuid, 'reservation_debit', $2, $3, $1::text) RETURNING id`,
        [userId, (-amountKobo).toString(), reference],
      );
      return rows[0]!.id;
    },

    async insertReservation(r) {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO reservation (reference, user_id, vehicle_id, lot_id, pool_id, time_window, hours,
                                  tariff_id, rate_applied_kobo, amount_kobo, wallet_entry_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, tstzrange($6, $7, '[)'), $8, $9, $10, $11, $12, $13) RETURNING id`,
        [r.reference, r.userId, r.vehicleId, r.lotId, r.poolId, r.window.start, r.window.end, r.hours,
         r.tariffId, r.rateAppliedKobo.toString(), r.amountKobo.toString(), r.walletEntryId, r.idempotencyKey ?? null],
      );
      return rows[0]!.id;
    },
  };
}
