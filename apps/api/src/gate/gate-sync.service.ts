import { Inject, Injectable } from "@nestjs/common";
import type pg from "pg";
import { CLOCK, type Clock } from "../common/clock.js";
import { PG_POOL } from "../common/db.js";
import type { GateContext } from "./attendant.guard.js";

export interface GateEventInput {
  id: string;
  kind: "entry" | "exit";
  method: "qr" | "pin" | "plate" | "manual";
  passId?: string | undefined;
  plate?: string | undefined;
  reason?: string | undefined;
  deviceResult: string;
  plateConfirmed: boolean;
  occurredAt: Date;
  recordedOffline: boolean;
}

export type SyncOutcome = { id: string; outcome: "accepted" | "duplicate"; flags: string[] };

/** A device clock this far ahead of the server is flagged, not rejected. */
const CLOCK_SKEW_MS = 10 * 60_000;

/**
 * NFR-OFF-03 and NFR-OFF-04. Each record is applied once, keyed by the id the
 * device generated. The server is authoritative: a record that conflicts with
 * what the server knows — a cancellation or suspension issued while the device
 * was offline, an exit with no entry — is kept and flagged for review. Nothing
 * is silently accepted as if it were normal, and nothing is discarded.
 */
@Injectable()
export class GateSyncService {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async sync(ctx: GateContext, events: GateEventInput[]): Promise<SyncOutcome[]> {
    const out: SyncOutcome[] = [];
    // In the order recorded: an exit must be applied after its entry.
    for (const e of events) out.push(await this.apply(ctx, e));
    return out;
  }

  private async apply(ctx: GateContext, e: GateEventInput): Promise<SyncOutcome> {
    const received = this.clock.now();
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const inserted = await c.query(
        `INSERT INTO gate_event (id, lot_id, kind, method, pass_id, plate, device_result, plate_confirmed, reason,
                                 attendant_id, device_id, occurred_at, received_at, recorded_offline)
         VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [e.id, ctx.lotId, e.kind, e.method, e.plate ?? null, e.deviceResult, e.plateConfirmed, e.reason ?? null,
         ctx.attendantId, ctx.deviceId, e.occurredAt, received, e.recordedOffline]);
      if (!inserted.rowCount) {
        const { rows: [prev] } = await c.query<{ conflict: string | null }>("SELECT conflict FROM gate_event WHERE id = $1", [e.id]);
        await c.query("COMMIT");
        return { id: e.id, outcome: "duplicate", flags: prev?.conflict ? prev.conflict.split(",") : [] };
      }

      const flags: string[] = [];
      if (ctx.device.revoked) flags.push("DEVICE_REVOKED");
      if (e.occurredAt.getTime() > received.getTime() + CLOCK_SKEW_MS) flags.push("CLOCK_SKEW");
      if (e.method === "manual") flags.push("MANUAL_EXCEPTION"); // US-041: reported separately

      let reservationId: string | null = null;
      let passId: string | null = null;
      if (e.passId) {
        const { rows: [p] } = await c.query<{ pass_id: string; reservation_id: string; lot_id: string; revoked_at: Date | null; status: string; verification_state: string }>(
          `SELECT ap.id AS pass_id, r.id AS reservation_id, r.lot_id, ap.revoked_at, r.status::text, u.verification_state::text
             FROM access_pass ap JOIN reservation r ON r.id = ap.reservation_id JOIN app_user u ON u.id = r.user_id
            WHERE ap.id = $1 FOR UPDATE OF r`, [e.passId]);
        if (!p || p.lot_id !== ctx.lotId) {
          flags.push("UNKNOWN_PASS");
        } else {
          passId = p.pass_id;
          reservationId = p.reservation_id;
          if (p.status === "cancelled" || p.revoked_at) flags.push("CANCELLED_WHILE_OFFLINE");
          if (p.verification_state === "suspended") flags.push("SUSPENDED_WHILE_OFFLINE");
        }
      } else if (e.method !== "manual") {
        flags.push("UNKNOWN_PASS");
      }

      if (e.kind === "entry" && e.method !== "manual") {
        if (!e.plateConfirmed) flags.push("PLATE_NOT_CONFIRMED"); // US-040
        if (e.deviceResult !== "VALID") flags.push(`ADMITTED_ON_${e.deviceResult}`);
      }

      if (reservationId) {
        const { rows: [s] } = await c.query<{ id: string; state: string; entered_at: Date }>(
          "SELECT id, state::text, entered_at FROM parking_session WHERE reservation_id = $1 FOR UPDATE", [reservationId]);
        if (e.kind === "entry") {
          // The vehicle is physically in: record the session even when flagged, so occupancy reflects the lot.
          if (!s) {
            await c.query(
              "INSERT INTO parking_session (reservation_id, state, entered_at, entry_event_id) VALUES ($1, 'active', $2, $3)",
              [reservationId, e.occurredAt, e.id]);
          } else {
            flags.push(s.state === "active" ? "DUPLICATE_ENTRY" : "REENTRY_AFTER_EXIT");
          }
        } else if (!s) {
          flags.push("EXIT_WITHOUT_ENTRY");
        } else if (s.state === "ended") {
          flags.push("DUPLICATE_EXIT");
        } else {
          if (e.occurredAt < s.entered_at) flags.push("EXIT_BEFORE_ENTRY");
          await c.query("UPDATE parking_session SET state = 'ended', exited_at = $2, exit_event_id = $3 WHERE id = $1",
            [s.id, e.occurredAt, e.id]);
        }
      }

      await c.query(
        "UPDATE gate_event SET pass_id = $2, reservation_id = $3, conflict = $4, review_state = $5 WHERE id = $1",
        [e.id, passId, reservationId, flags.length ? flags.join(",") : null, flags.length ? "flagged" : "none"]);
      await c.query("COMMIT");
      return { id: e.id, outcome: "accepted", flags };
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }
}
