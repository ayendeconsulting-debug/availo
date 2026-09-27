import { Controller, Get, Inject, UseGuards } from "@nestjs/common";
import type pg from "pg";
import { AuthGuard, CurrentUser } from "../auth/auth.guard.js";
import type { AccessClaims } from "../auth/tokens.service.js";
import { CLOCK, type Clock } from "../common/clock.js";
import { PG_POOL } from "../common/db.js";

/** Read endpoints behind the driver app's home, bookings and wallet screens. */
@Controller()
@UseGuards(AuthGuard)
export class DriverController {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** US-009: the lots a driver can book. One in MVP1; nothing here assumes that. */
  @Get("lots")
  async lots() {
    const { rows } = await this.pool.query<{ id: string; name: string; building: string | null; gate_directions: string | null; entrance_photo_url: string | null; early_entry_minutes: number; property: string; pools: Array<{ kind: string; capacity: number }> }>(
      `SELECT l.id, l.name, l.building, l.gate_directions, l.entrance_photo_url, l.early_entry_minutes, p.name AS property,
              (SELECT json_agg(json_build_object('kind', cp.kind, 'capacity', cp.capacity) ORDER BY cp.kind) FROM capacity_pool cp WHERE cp.lot_id = l.id) AS pools
         FROM lot l JOIN property p ON p.id = l.property_id ORDER BY l.name`);
    return rows.map((l) => ({
      id: l.id, name: l.name, property: l.property, building: l.building, gateDirections: l.gate_directions,
      entrancePhotoUrl: l.entrance_photo_url, earlyEntryMinutes: l.early_entry_minutes, pools: l.pools ?? [],
    }));
  }

  /** The driver's bookings: upcoming first, then the most recent past ones. */
  @Get("reservations")
  async mine(@CurrentUser() auth: AccessClaims) {
    const { rows } = await this.pool.query<{ id: string; reference: string; lot_id: string; lot_name: string; kind: string; s: Date; e: Date; hours: number; amount_kobo: string; status: string; plate: string; pass_id: string | null; session_state: string | null }>(
      `SELECT r.id, r.reference, r.lot_id, l.name AS lot_name, p.kind::text, lower(r.time_window) AS s, upper(r.time_window) AS e,
              r.hours, r.amount_kobo::text, r.status::text, v.plate_normalised AS plate, ap.id AS pass_id, ps.state::text AS session_state
         FROM reservation r JOIN lot l ON l.id = r.lot_id JOIN capacity_pool p ON p.id = r.pool_id JOIN vehicle v ON v.id = r.vehicle_id
         LEFT JOIN access_pass ap ON ap.reservation_id = r.id LEFT JOIN parking_session ps ON ps.reservation_id = r.id
        WHERE r.user_id = $1
        ORDER BY (upper(r.time_window) < $2), CASE WHEN upper(r.time_window) >= $2 THEN lower(r.time_window) END ASC, lower(r.time_window) DESC
        LIMIT 50`,
      [auth.userId, this.clock.now()]);
    return rows.map((r) => ({
      id: r.id, reference: r.reference, lot: { id: r.lot_id, name: r.lot_name }, pool: r.kind, status: r.status, plate: r.plate,
      window: { start: r.s.toISOString(), end: r.e.toISOString() }, hours: r.hours, amountKobo: r.amount_kobo,
      passId: r.pass_id, session: r.session_state, upcoming: r.e > this.clock.now(),
    }));
  }

  /**
   * US-019: balance and history, each entry with its running balance. The balance
   * is the sum of the ledger — never a stored figure (US-020, NFR-SEC-14).
   */
  @Get("wallet")
  async wallet(@CurrentUser() auth: AccessClaims) {
    const { rows } = await this.pool.query<{ id: string; entry_type: string; amount_kobo: string; reference: string; created_at: Date; running: string }>(
      `SELECT id, entry_type::text, amount_kobo::text, reference, created_at,
              (sum(amount_kobo) OVER (ORDER BY created_at, id))::text AS running
         FROM wallet_entry WHERE user_id = $1 ORDER BY created_at DESC, id DESC`,
      [auth.userId]);
    return {
      balanceKobo: rows[0]?.running ?? "0",
      entries: rows.map((r) => ({ id: r.id, type: r.entry_type, amountKobo: r.amount_kobo, reference: r.reference, at: r.created_at.toISOString(), balanceAfterKobo: r.running })),
    };
  }
}
