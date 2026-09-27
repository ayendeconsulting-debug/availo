import { randomUUID } from "node:crypto";
import { Body, Controller, Get, Headers, HttpStatus, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import type pg from "pg";
import { z } from "zod";
import { checkAvailability, reserve, type RejectReason, type ReservationStore } from "@availo/engine";
import { CLOCK, type Clock } from "../common/clock.js";
import { PG_POOL, RESERVATION_STORE } from "../common/db.js";
import { ApiError } from "../common/errors.js";
import { validate } from "../common/validate.js";
import { AuthGuard, CurrentUser } from "../auth/auth.guard.js";
import type { AccessClaims } from "../auth/tokens.service.js";
import { PassService } from "../passes/pass.service.js";

const Start = z.iso.datetime({ offset: true, message: "Give the start as an ISO 8601 date-time, e.g. 2026-10-01T09:00:00+01:00." }).transform((s) => new Date(s));
const Hours = z.coerce.number().int("Hours must be a whole number.").min(1);
const Uuid = z.uuid();

/** Each engine refusal maps to one status and one plain-language message (NFR-ACC-07). */
const REJECTIONS: Record<RejectReason, [HttpStatus, string]> = {
  USER_NOT_FOUND: [HttpStatus.UNAUTHORIZED, "Sign in again to continue."],
  USER_NOT_BOOKABLE: [HttpStatus.FORBIDDEN, "This account cannot make bookings right now. Contact the operations team."],
  VEHICLE_NOT_REGISTERED: [HttpStatus.UNPROCESSABLE_ENTITY, "Choose one of the vehicles registered to your account."],
  WALLET_PATH_NOT_AVAILABLE: [HttpStatus.UNPROCESSABLE_ENTITY, "Guest bookings are paid at checkout, which is not available yet."],
  NOT_ELIGIBLE: [HttpStatus.FORBIDDEN, "Accessible bays are reserved for accounts verified as eligible."],
  INVALID_WINDOW: [HttpStatus.UNPROCESSABLE_ENTITY, "Choose a start time in the future and a duration within the lot's limits."],
  NO_TARIFF: [HttpStatus.CONFLICT, "This lot is not taking bookings right now."],
  NO_CAPACITY: [HttpStatus.CONFLICT, "There is no space available for that time. Try another time."],
  INSUFFICIENT_BALANCE: [HttpStatus.PAYMENT_REQUIRED, "Your balance does not cover this booking. Top up to continue."],
};

const kobo = (v: bigint | null) => (v === null ? null : v.toString());

@Controller()
@UseGuards(AuthGuard)
export class ReservationsController {
  constructor(
    @Inject(RESERVATION_STORE) private readonly store: ReservationStore,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PassService) private readonly passes: PassService,
  ) {}

  /** US-022: the capacity this driver can actually book, and what it would cost against their balance. */
  @Get("lots/:lotId/availability")
  async availability(@CurrentUser() auth: AccessClaims, @Param("lotId", ParseUUIDPipe) lotId: string, @Query() query: unknown) {
    const q = validate(z.object({ start: Start, hours: Hours, accessible: z.enum(["true", "false"]).optional() }), query);
    const r = await checkAvailability(this.store, {
      userId: auth.userId, lotId, start: q.start, hours: q.hours, accessible: q.accessible === "true", now: this.clock.now(),
    });
    if (!r.ok) {
      const [status, message] = REJECTIONS[r.reason];
      throw new ApiError(status, r.reason, message);
    }
    return {
      window: { start: r.window.start.toISOString(), end: r.window.end.toISOString() },
      available: r.available,
      pools: r.pools,
      rateKobo: kobo(r.rateKobo),
      amountKobo: kobo(r.amountKobo),
      minHours: r.minHours,
      maxHours: r.maxHours,
      balanceBeforeKobo: kobo(r.balanceBeforeKobo),
      balanceAfterKobo: kobo(r.balanceAfterKobo),
      // US-022: charged for the block reserved, not time used; stated before confirmation.
      terms: { earlyCheckoutRefund: false, cancellation: "OD-11 pending", grace: "OD-09 pending", penalty: "OD-09 pending" },
    };
  }

  /**
   * US-022, US-023. Send an Idempotency-Key so a retry after a dropped
   * connection returns the original booking instead of making a second one.
   */
  @Post("reservations")
  async create(@CurrentUser() auth: AccessClaims, @Body() body: unknown, @Headers("idempotency-key") idempotencyKey?: string) {
    const b = validate(z.object({ lotId: Uuid, vehicleId: Uuid, start: Start, hours: Hours, accessible: z.boolean().optional() }), body);
    const key = idempotencyKey ? validate(z.string().min(8).max(128), idempotencyKey) : undefined;

    if (key) {
      const existing = await this.findByKey(auth.userId, key);
      if (existing) return existing;
    }

    let result;
    try {
      result = await reserve(this.store, {
        reference: `AV-${randomUUID().slice(0, 8).toUpperCase()}`,
        userId: auth.userId,
        vehicleId: b.vehicleId,
        lotId: b.lotId,
        start: b.start,
        hours: b.hours,
        ...(b.accessible !== undefined ? { accessible: b.accessible } : {}),
        ...(key ? { idempotencyKey: key } : {}),
        now: this.clock.now(),
      });
    } catch (err) {
      // A concurrent retry with the same key committed first; everything here rolled back.
      if (key && (err as { code?: string }).code === "23505") {
        const existing = await this.findByKey(auth.userId, key);
        if (existing) return existing;
      }
      throw err;
    }

    if (!result.ok) {
      const [status, message] = REJECTIONS[result.reason];
      const detail: Record<string, unknown> = {};
      if (result.reason === "INSUFFICIENT_BALANCE") {
        // US-021: state the shortfall so the driver can top up in the same flow.
        const quote = await checkAvailability(this.store, { userId: auth.userId, lotId: b.lotId, start: b.start, hours: b.hours, now: this.clock.now() });
        if (quote.ok && quote.balanceAfterKobo !== null) detail.shortfallKobo = (-quote.balanceAfterKobo).toString();
      }
      throw new ApiError(status, result.reason, message, detail);
    }
    // US-033: a pass on confirmation. If this step fails the booking stands and GET …/pass issues it.
    try {
      const issued = await this.passes.issue(result.reservationId);
      if (issued.created) await this.passes.sendCopy(result.reservationId);
    } catch {
      /* issued lazily on first read */
    }
    return this.findById(auth.userId, result.reservationId);
  }

  @Get("reservations/:id")
  async get(@CurrentUser() auth: AccessClaims, @Param("id", ParseUUIDPipe) id: string) {
    const r = await this.findById(auth.userId, id);
    if (!r) throw new ApiError(HttpStatus.NOT_FOUND, "NOT_FOUND", "No booking with that reference on your account.");
    return r;
  }

  private findById(userId: string, id: string) {
    return this.load("r.id = $2", [userId, id]);
  }

  private findByKey(userId: string, key: string) {
    return this.load("r.idempotency_key = $2", [userId, key]);
  }

  private async load(where: string, params: unknown[]) {
    const { rows: [r] } = await this.pool.query<{
      id: string; reference: string; lot_id: string; kind: string; s: Date; e: Date; hours: number;
      rate_applied_kobo: string; amount_kobo: string; wallet_entry_id: string; status: string; plate: string; pass_id: string | null;
    }>(
      `SELECT r.id, r.reference, r.lot_id, p.kind::text, lower(r.time_window) AS s, upper(r.time_window) AS e, r.hours,
              r.rate_applied_kobo::text, r.amount_kobo::text, r.wallet_entry_id, r.status::text, v.plate_normalised AS plate, ap.id AS pass_id
         FROM reservation r JOIN capacity_pool p ON p.id = r.pool_id JOIN vehicle v ON v.id = r.vehicle_id
         LEFT JOIN access_pass ap ON ap.reservation_id = r.id
        WHERE r.user_id = $1 AND ${where}`,
      params,
    );
    if (!r) return null;
    return {
      id: r.id, reference: r.reference, lotId: r.lot_id, pool: r.kind, status: r.status, plate: r.plate,
      window: { start: r.s.toISOString(), end: r.e.toISOString() }, hours: r.hours,
      rateAppliedKobo: r.rate_applied_kobo, amountKobo: r.amount_kobo, walletEntryId: r.wallet_entry_id,
      passId: r.pass_id,
    };
  }
}
