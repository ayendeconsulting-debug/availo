import { randomBytes } from "node:crypto";
import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import type pg from "pg";
import { convertHoldWithin, placeHold, type ReservationStore } from "@availo/engine";
import { withPgTransaction } from "@availo/db";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { CLOCK, type Clock } from "../common/clock.js";
import { PG_POOL, RESERVATION_STORE } from "../common/db.js";
import { ApiError } from "../common/errors.js";
import { rejection } from "../common/rejections.js";
import { PassService } from "../passes/pass.service.js";
import { PAYMENT_PROVIDER, type PaymentProvider, type VerifyResult, type WebhookNotice } from "./provider.js";

/** NFR-SEC-08: checkout and top-up initiation are rate-limited per driver. */
const INITIATION_LIMIT = 5;
const INITIATION_WINDOW_MINUTES = 10;
/** A top-up nobody completed is closed as abandoned after this long. */
const TOP_UP_ABANDON_MINUTES = 60;
/** A refund is tried this many times before it is left as failed for operations to act on. */
const MAX_REFUND_ATTEMPTS = 5;
/** A refund claimed for submission but never sent (the process stopped) is reclaimed after this long. */
const REFUND_STUCK_MINUTES = 15;
/** Unpaid payments are asked about again for this long, in case a payment completed and its webhook was lost. */
const RECHECK_HOURS = 24;
const RECHECK_EVERY_MINUTES = 15;

export interface PaymentRow {
  id: string; reference: string; user_id: string; purpose: "checkout" | "top_up"; amount_kobo: string; currency: string;
  hold_id: string | null; status: "initiated" | "succeeded" | "failed" | "abandoned";
  fulfilment: "pending" | "fulfilled" | "refund_due" | "not_applicable"; fulfilment_note: string | null;
  provider_txn_id: string | null; authorization_url: string | null; created_at: Date;
}

export type SettleOutcome =
  | { state: "confirmed"; reservationId: string; late: boolean }
  | { state: "credited"; walletEntryId: string }
  | { state: "refund_due"; note: string }
  | { state: "failed" }
  | { state: "pending" };

const newReference = (prefix: "AV" | "TU") => `${prefix}-${randomBytes(5).toString("hex").toUpperCase()}`;

/**
 * Both payment paths on one provider (HLR §3.6, EP-04).
 *
 * - Checkout (US-134, US-135): a hold on capacity, a payment on the provider's
 *   hosted page, and — only after a server-side verify — the hold converts to a
 *   reservation with its payment-ledger entry, in one transaction.
 * - Top-up (US-016): a payment, and — only after a server-side verify — a paid
 *   credit on the wallet with its payment-ledger entry, in one transaction.
 *
 * Every outcome goes through settle(), whichever way it arrives: the driver's
 * return from checkout, a webhook, a repeat of either, or the expiry job. settle()
 * locks the payment row, so concurrent arrivals queue behind each other, and the
 * second finds the work done. Unique constraints in the database make a double
 * credit, a double posting or a second reservation impossible even if that lock
 * were bypassed (US-017).
 */
@Injectable()
export class PaymentsService {
  private readonly log = new Logger(PaymentsService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(RESERVATION_STORE) private readonly store: ReservationStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Inject(PassService) private readonly passes: PassService,
  ) {}

  // ——— Checkout (US-134, US-135) ———

  async startCheckout(userId: string, b: { lotId: string; vehicleId: string; start: Date; hours: number; accessible?: boolean | undefined }, idempotencyKey?: string) {
    if (idempotencyKey) {
      const existing = await this.holdByKey(userId, idempotencyKey);
      if (existing) return this.checkoutView(userId, existing);
    }
    await this.enforceInitiationLimit(userId);
    const { rows: [lot] } = await this.pool.query<{ hold_minutes: number }>("SELECT hold_minutes FROM lot WHERE id = $1", [b.lotId]);
    if (!lot) throw new ApiError(HttpStatus.NOT_FOUND, "NOT_FOUND", "That parking site does not exist.");

    let held;
    try {
      held = await placeHold(this.store, {
        reference: newReference("AV"), userId, vehicleId: b.vehicleId, lotId: b.lotId, start: b.start, hours: b.hours,
        ...(b.accessible !== undefined ? { accessible: b.accessible } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        now: this.clock.now(), holdMinutes: lot.hold_minutes,
      });
    } catch (err) {
      if (idempotencyKey && (err as { code?: string }).code === "23505") {
        const existing = await this.holdByKey(userId, idempotencyKey);
        if (existing) return this.checkoutView(userId, existing);
      }
      throw err;
    }
    if (!held.ok) throw rejection(held.reason, held.holdId ? { holdId: held.holdId } : {});

    const payment = await this.createPayment(userId, "checkout", held.amountKobo, held.holdId);
    try {
      await this.initialize(payment, `${this.config.appBaseUrl}/checkout/return?hold=${held.holdId}`, { purpose: "checkout", hold: held.holdId });
    } catch (err) {
      // Nothing can be paid, so nothing is held: the space goes straight back.
      await this.releaseHold(held.holdId, "payment_failed");
      await this.markPayment(payment.id, "failed", "provider_unavailable", { error: (err as Error).message });
      throw new ApiError(HttpStatus.BAD_GATEWAY, "PAYMENT_PROVIDER_UNAVAILABLE", "Payment is unavailable right now. Nothing was charged and no space is held. Try again shortly.");
    }
    return this.checkoutView(userId, held.holdId);
  }

  /** What the app shows while a checkout is open: the countdown, the total, the link to pay, and the outcome. */
  async checkoutView(userId: string, holdId: string) {
    const { rows: [h] } = await this.pool.query<{
      id: string; reference: string; lot_id: string; s: Date; e: Date; hours: number; rate_applied_kobo: string; service_fee_kobo: string;
      amount_kobo: string; expires_at: Date; released_at: Date | null; release_reason: string | null; kind: string; reservation_id: string | null;
    }>(
      `SELECT h.id, h.reference, h.lot_id, lower(h.time_window) AS s, upper(h.time_window) AS e, h.hours, h.rate_applied_kobo::text,
              h.service_fee_kobo::text, h.amount_kobo::text, h.expires_at, h.released_at, h.release_reason, cp.kind::text, r.id AS reservation_id
         FROM inventory_hold h JOIN capacity_pool cp ON cp.id = h.pool_id LEFT JOIN reservation r ON r.hold_id = h.id
        WHERE h.id = $1 AND h.user_id = $2`,
      [holdId, userId]);
    if (!h) throw new ApiError(HttpStatus.NOT_FOUND, "NOT_FOUND", "No checkout with that reference on your account.");
    const { rows: [p] } = await this.pool.query<PaymentRow>(
      "SELECT * FROM payment_transaction WHERE hold_id = $1 ORDER BY created_at DESC LIMIT 1", [holdId]);
    const now = this.clock.now();
    const state = h.reservation_id ? "confirmed"
      : p?.fulfilment === "refund_due" ? "refund_due"
      : h.released_at ? (h.release_reason === "cancelled" ? "cancelled" : h.release_reason === "payment_failed" ? "failed" : "expired")
      : h.expires_at <= now ? "expired" : "held";
    return {
      holdId: h.id, reference: h.reference, lotId: h.lot_id, pool: h.kind, state,
      window: { start: h.s.toISOString(), end: h.e.toISOString() }, hours: h.hours,
      // US-134: the parking charge, any service fee and the total, shown before authorisation.
      rateKobo: h.rate_applied_kobo, parkingKobo: (BigInt(h.amount_kobo) - BigInt(h.service_fee_kobo)).toString(),
      serviceFeeKobo: h.service_fee_kobo, amountKobo: h.amount_kobo,
      expiresAt: h.expires_at.toISOString(), secondsLeft: Math.max(0, Math.floor((h.expires_at.getTime() - now.getTime()) / 1000)),
      payment: p ? { id: p.id, reference: p.reference, status: p.status, fulfilment: p.fulfilment, note: p.fulfilment_note, authorizationUrl: state === "held" ? p.authorization_url : null } : null,
      reservationId: h.reservation_id,
    };
  }

  /** The driver returned from checkout or pressed "I've paid": ask the provider, never the browser (US-134). */
  async verifyCheckout(userId: string, holdId: string) {
    const view = await this.checkoutView(userId, holdId);
    if (view.payment && view.state !== "confirmed") await this.settle(view.payment.reference, "driver_return");
    return this.checkoutView(userId, holdId);
  }

  /** US-135: the driver gives up. The space returns at once. A payment that still lands is refunded. */
  async cancelCheckout(userId: string, holdId: string) {
    const view = await this.checkoutView(userId, holdId);
    if (view.state === "confirmed") throw new ApiError(HttpStatus.CONFLICT, "ALREADY_CONFIRMED", "This booking is already paid and confirmed.");
    await this.releaseHold(holdId, "cancelled");
    if (view.payment?.status === "initiated") {
      await this.event(view.payment.id, "cancelled_by_driver", {});
      // A payment completed in the instant before cancelling is caught here rather than left for the webhook.
      const r = await this.settle(view.payment.reference, "cancel");
      if (r.state === "pending") {
        await this.pool.query("UPDATE payment_transaction SET status = 'abandoned', fulfilment = 'not_applicable', updated_at = now() WHERE id = $1 AND status = 'initiated'", [view.payment.id]);
      }
    }
    return this.checkoutView(userId, holdId);
  }

  // ——— Wallet top-up (US-016) ———

  async startTopUp(userId: string, amountKobo: bigint, idempotencyKey?: string) {
    if (idempotencyKey) {
      const { rows: [existing] } = await this.pool.query<{ id: string }>(
        "SELECT id FROM payment_transaction WHERE user_id = $1 AND purpose = 'top_up' AND idempotency_key = $2", [userId, idempotencyKey]);
      if (existing) return this.topUpView(userId, existing.id);
    }
    const { rows: [u] } = await this.pool.query<{ wallet_enabled: boolean }>(
      "SELECT r.wallet_enabled FROM app_user u JOIN user_type_rule r ON r.user_type = u.user_type WHERE u.id = $1", [userId]);
    if (!u?.wallet_enabled) throw rejection("WALLET_PATH_NOT_AVAILABLE");
    const rule = await this.walletRule();
    // US-015, US-016: limits are configuration; the driver sees them before paying.
    if (amountKobo < rule.minTopUpKobo || amountKobo > rule.maxTopUpKobo) {
      throw new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, "TOP_UP_OUT_OF_RANGE", `Top up between ${naira(rule.minTopUpKobo)} and ${naira(rule.maxTopUpKobo)}.`, {
        minKobo: rule.minTopUpKobo.toString(), maxKobo: rule.maxTopUpKobo.toString(),
      });
    }
    // Top-ups still open count too, so two started together cannot together pass the limit. A payment that
    // lands anyway is credited — money received is never refused — so the limit governs what is offered.
    const balance = (await this.balance(userId)) + (await this.pendingTopUps(userId));
    if (balance + amountKobo > rule.maxBalanceKobo) {
      throw new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, "BALANCE_LIMIT", `A wallet can hold at most ${naira(rule.maxBalanceKobo)}. You can add up to ${naira(rule.maxBalanceKobo - balance > 0n ? rule.maxBalanceKobo - balance : 0n)}.`, {
        maxBalanceKobo: rule.maxBalanceKobo.toString(), headroomKobo: (rule.maxBalanceKobo - balance).toString(),
      });
    }
    await this.enforceInitiationLimit(userId);
    let payment;
    try {
      payment = await this.createPayment(userId, "top_up", amountKobo, null, idempotencyKey);
    } catch (err) {
      if (idempotencyKey && (err as { code?: string }).code === "23505") {
        const { rows: [existing] } = await this.pool.query<{ id: string }>(
          "SELECT id FROM payment_transaction WHERE user_id = $1 AND purpose = 'top_up' AND idempotency_key = $2", [userId, idempotencyKey]);
        if (existing) return this.topUpView(userId, existing.id);
      }
      throw err;
    }
    try {
      await this.initialize(payment, `${this.config.appBaseUrl}/wallet/return?payment=${payment.id}`, { purpose: "top_up" });
    } catch (err) {
      await this.markPayment(payment.id, "failed", "provider_unavailable", { error: (err as Error).message });
      throw new ApiError(HttpStatus.BAD_GATEWAY, "PAYMENT_PROVIDER_UNAVAILABLE", "Top-up is unavailable right now. Nothing was charged. Try again shortly.");
    }
    return this.topUpView(userId, payment.id);
  }

  async topUpView(userId: string, paymentId: string) {
    const { rows: [p] } = await this.pool.query<PaymentRow & { wallet_entry_id: string | null }>(
      `SELECT pt.*, we.id AS wallet_entry_id FROM payment_transaction pt
         LEFT JOIN wallet_entry we ON we.payment_transaction_id = pt.id AND we.entry_type = 'top_up'
        WHERE pt.id = $1 AND pt.user_id = $2 AND pt.purpose = 'top_up'`, [paymentId, userId]);
    if (!p) throw new ApiError(HttpStatus.NOT_FOUND, "NOT_FOUND", "No top-up with that reference on your account.");
    const balance = await this.balance(userId);
    const state = p.wallet_entry_id ? "credited" : p.fulfilment === "refund_due" ? "refund_due" : p.status === "initiated" ? "pending" : p.status;
    return {
      paymentId: p.id, reference: p.reference, amountKobo: p.amount_kobo, state,
      authorizationUrl: state === "pending" ? p.authorization_url : null,
      balanceKobo: balance.toString(),
    };
  }

  async verifyTopUp(userId: string, paymentId: string) {
    const view = await this.topUpView(userId, paymentId);
    if (view.state === "pending") await this.settle(view.reference, "driver_return");
    return this.topUpView(userId, paymentId);
  }

  async walletRule() {
    const { rows: [r] } = await this.pool.query<{ min_top_up_kobo: string; max_top_up_kobo: string; max_balance_kobo: string; consumption_order: "allocated_first" | "paid_first" }>(
      `SELECT min_top_up_kobo::text, max_top_up_kobo::text, max_balance_kobo::text, consumption_order FROM wallet_rule
        WHERE effective_from <= $1 ORDER BY effective_from DESC, created_at DESC LIMIT 1`, [this.clock.now()]);
    if (!r) throw new Error("No wallet rule in force");
    return { minTopUpKobo: BigInt(r.min_top_up_kobo), maxTopUpKobo: BigInt(r.max_top_up_kobo), maxBalanceKobo: BigInt(r.max_balance_kobo), consumptionOrder: r.consumption_order };
  }

  // ——— Settlement of an outcome, from any source ———

  /**
   * Ask the provider what happened to a payment, then act on it exactly once.
   * The provider call happens outside the transaction; the payment row is then
   * locked and its state re-read, so a concurrent settle that already acted makes
   * this one a no-op.
   */
  async settle(reference: string, source: string): Promise<SettleOutcome> {
    let verified: VerifyResult;
    try {
      verified = await this.provider.verify(reference);
    } catch (err) {
      this.log.warn(`Verify of ${reference} failed: ${(err as Error).message}`);
      return { state: "pending" };
    }

    const outcome = await withPgTransaction(this.pool, async (c, tx) => {
      const { rows: [p] } = await c.query<PaymentRow>("SELECT * FROM payment_transaction WHERE reference = $1 FOR UPDATE", [reference]);
      if (!p) return null;
      await c.query("UPDATE payment_transaction SET last_checked_at = $2 WHERE id = $1", [p.id, this.clock.now()]);
      await this.event(p.id, "verified", { source, status: verified.status, amount: verified.amountKobo?.toString() ?? null, gateway: verified.gatewayResponse }, c);

      if (p.status === "succeeded") return this.outcomeOf(p, c); // already acted on: nothing more to do

      if (verified.status === "failed") {
        await c.query("UPDATE payment_transaction SET status = 'failed', fulfilment = 'not_applicable', updated_at = now() WHERE id = $1", [p.id]);
        // US-135: payment failure returns the capacity at once.
        if (p.hold_id) await tx.releaseHold(p.hold_id, "payment_failed", this.clock.now());
        return { state: "failed" } as const;
      }
      if (verified.status !== "success") return { state: "pending" } as const;

      const now = this.clock.now();
      await c.query(
        `UPDATE payment_transaction SET status = 'succeeded', verified_at = $2, provider_txn_id = $3, paid_amount_kobo = $4,
                channel = $5, provider_fee_kobo = $6, paid_at = $7, updated_at = now() WHERE id = $1`,
        [p.id, now, verified.providerTxnId, verified.amountKobo?.toString() ?? null, verified.channel, verified.feesKobo?.toString() ?? null, verified.paidAt]);

      // Paid a different amount, or in another currency, than was asked: never honour it, give it back.
      if (verified.amountKobo !== BigInt(p.amount_kobo) || (verified.currency ?? "NGN") !== p.currency) {
        return this.unfulfilled(c, p, verified, `Paid ${verified.amountKobo ?? "?"} ${verified.currency ?? ""}, expected ${p.amount_kobo} ${p.currency}`);
      }

      if (p.purpose === "top_up") {
        await tx.lockWallet(p.user_id);
        const { rows: [w] } = await c.query<{ id: string }>(
          `INSERT INTO wallet_entry (user_id, entry_type, amount_kobo, allocated_kobo, reference, actor, payment_transaction_id)
           VALUES ($1, 'top_up', $2, 0, $3, 'provider:' || $4, $5) RETURNING id`,
          [p.user_id, p.amount_kobo, p.reference, this.provider.name, p.id]);
        await this.post(c, "top_up_payment", p, null);
        await c.query("UPDATE payment_transaction SET fulfilment = 'fulfilled', updated_at = now() WHERE id = $1", [p.id]);
        await this.event(p.id, "fulfilled", { walletEntryId: w!.id }, c);
        return { state: "credited", walletEntryId: w!.id } as const;
      }

      // Checkout: the hold becomes the reservation, in this transaction.
      const converted = await convertHoldWithin(tx, { holdId: p.hold_id!, paymentTransactionId: p.id, now });
      if (!converted.ok) {
        const why = converted.reason === "HOLD_CANCELLED" ? "The checkout was cancelled before the payment completed."
          : converted.reason === "NO_CAPACITY" ? "The hold had lapsed and the space was taken before the payment completed."
          : converted.reason === "VEHICLE_ALREADY_BOOKED" ? "Duplicate payment: the vehicle was already booked for this time."
          : "The checkout no longer exists.";
        return this.unfulfilled(c, p, verified, why);
      }
      if (converted.alreadyConverted) {
        // The hold was paid for by another payment: this one is a duplicate charge (US-017).
        return this.unfulfilled(c, p, verified, "Duplicate payment: this booking was already paid.");
      }
      await this.post(c, "checkout_payment", p, converted.reservationId);
      await c.query("UPDATE payment_transaction SET fulfilment = 'fulfilled', updated_at = now() WHERE id = $1", [p.id]);
      await this.event(p.id, "fulfilled", { reservationId: converted.reservationId, late: converted.late }, c);
      return { state: "confirmed", reservationId: converted.reservationId, late: converted.late } as const;
    });

    if (!outcome) {
      this.log.warn(`Settle for unknown reference ${reference} (${source})`);
      return { state: "pending" };
    }
    // US-033: the pass, once the booking is confirmed. Outside the transaction; a failure here never undoes a payment.
    if (outcome.state === "confirmed") {
      try {
        const issued = await this.passes.issue(outcome.reservationId);
        if (issued.created) await this.passes.sendCopy(outcome.reservationId);
      } catch (err) {
        this.log.warn(`Pass for ${outcome.reservationId} deferred: ${(err as Error).message}`);
      }
    }
    // Send the refund now rather than at the next job run. Where jobs are off (tests), callers run it themselves.
    if (outcome.state === "refund_due" && this.config.payments.runJobs) void this.submitRefunds().catch(() => undefined);
    return outcome;
  }

  /** Money arrived that the platform cannot honour: post it as owed back and queue the refund (US-017). */
  private async unfulfilled(c: pg.PoolClient, p: PaymentRow, v: VerifyResult, note: string): Promise<SettleOutcome> {
    const paid = v.amountKobo ?? BigInt(p.amount_kobo);
    await c.query("UPDATE payment_transaction SET fulfilment = 'refund_due', fulfilment_note = $2, updated_at = now() WHERE id = $1", [p.id, note]);
    // A hold this payment was for is finished with: the space goes back now rather than at expiry.
    if (p.hold_id) {
      await c.query(
        `UPDATE inventory_hold SET released_at = $2, release_reason = CASE WHEN expires_at <= $2 THEN 'expired' ELSE 'payment_failed' END
          WHERE id = $1 AND released_at IS NULL AND NOT EXISTS (SELECT 1 FROM reservation WHERE hold_id = $1)`,
        [p.hold_id, this.clock.now()]);
    }
    await c.query(
      `INSERT INTO payment_ledger_entry (entry_type, amount_kobo, user_id, payment_transaction_id, reference, actor)
       VALUES ('unfulfilled_payment', $1, $2, $3, $4, 'system')`, [paid.toString(), p.user_id, p.id, p.reference]);
    await c.query(
      `INSERT INTO refund (payment_transaction_id, amount_kobo, reason, actor) VALUES ($1, $2, $3, 'system')
       ON CONFLICT (payment_transaction_id) DO NOTHING`, [p.id, paid.toString(), note]);
    await this.event(p.id, "refund_queued", { note, amount: paid.toString() }, c);
    return { state: "refund_due", note };
  }

  private async outcomeOf(p: PaymentRow, c: pg.PoolClient): Promise<SettleOutcome> {
    if (p.fulfilment === "refund_due") return { state: "refund_due", note: p.fulfilment_note ?? "" };
    if (p.purpose === "top_up") {
      const { rows: [w] } = await c.query<{ id: string }>("SELECT id FROM wallet_entry WHERE payment_transaction_id = $1 AND entry_type = 'top_up'", [p.id]);
      return { state: "credited", walletEntryId: w!.id };
    }
    const { rows: [r] } = await c.query<{ id: string }>("SELECT id FROM reservation WHERE payment_transaction_id = $1", [p.id]);
    return { state: "confirmed", reservationId: r!.id, late: false };
  }

  private async post(c: pg.PoolClient, type: "checkout_payment" | "top_up_payment", p: PaymentRow, reservationId: string | null) {
    await c.query(
      `INSERT INTO payment_ledger_entry (entry_type, amount_kobo, user_id, payment_transaction_id, reservation_id, reference, actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [type, p.amount_kobo, p.user_id, p.id, reservationId, p.reference, `provider:${this.provider.name}`]);
  }

  // ——— Webhooks (US-017) ———

  /**
   * An authenticated webhook. Recorded once per distinct event; a repeat is
   * counted and, if the first was already processed, ignored. Either way the
   * outcome is decided by settle(), which verifies with the provider.
   */
  async handleWebhook(notice: WebhookNotice): Promise<{ duplicate: boolean; outcome: string }> {
    const now = this.clock.now();
    const { rows: [w] } = await this.pool.query<{ id: string; processed_at: Date | null; times_received: number }>(
      `INSERT INTO webhook_event (provider, dedupe_key, event, reference, summary, first_received, last_received)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (provider, dedupe_key) DO UPDATE SET times_received = webhook_event.times_received + 1, last_received = EXCLUDED.last_received
       RETURNING id, processed_at, times_received`,
      [this.provider.name, notice.dedupeKey, notice.event, notice.reference, JSON.stringify(notice.summary), now]);
    if (w!.processed_at) return { duplicate: true, outcome: "already_processed" };

    let outcome = "ignored";
    if (notice.kind === "charge" && notice.reference) outcome = (await this.settle(notice.reference, `webhook:${notice.event}`)).state;
    if (notice.kind === "refund" && notice.reference) outcome = await this.refundNotice(notice.reference, notice.event);
    if (outcome !== "pending") {
      await this.pool.query("UPDATE webhook_event SET processed_at = $2, outcome = $3 WHERE id = $1 AND processed_at IS NULL", [w!.id, now, outcome]);
    }
    return { duplicate: w!.times_received > 1, outcome };
  }

  // ——— Refunds to the original method ———

  /** Submits queued refunds to the provider. Run by the job, and straight after a refund is queued. */
  async submitRefunds(): Promise<number> {
    const now = this.clock.now();
    // Claimed but never sent — the process stopped between claiming and calling the provider. If the call
    // did reach the provider, a second full refund is refused there (it would exceed the amount paid).
    await this.pool.query(
      "UPDATE refund SET status = 'queued', last_error = 'reclaimed: submission did not complete' WHERE status = 'submitted' AND provider_refund_ref IS NULL AND submitted_at < $1",
      [new Date(now.getTime() - REFUND_STUCK_MINUTES * 60_000)]);
    // Out of attempts: left as failed, loudly, for operations (NFR-SEC-12). Never silently skipped.
    const { rows: exhausted } = await this.pool.query<{ id: string; payment_transaction_id: string }>(
      "UPDATE refund SET status = 'failed' WHERE status = 'queued' AND attempts >= $1 RETURNING id, payment_transaction_id", [MAX_REFUND_ATTEMPTS]);
    for (const r of exhausted) {
      this.log.error(`Refund ${r.id} for payment ${r.payment_transaction_id} failed ${MAX_REFUND_ATTEMPTS} times and needs manual action`);
      await this.event(r.payment_transaction_id, "refund_gave_up", { attempts: MAX_REFUND_ATTEMPTS });
    }
    const { rows } = await this.pool.query<{ id: string; amount_kobo: string; reason: string; provider_txn_id: string; payment_id: string }>(
      `SELECT r.id, r.amount_kobo::text, r.reason, p.provider_txn_id, p.id AS payment_id FROM refund r
         JOIN payment_transaction p ON p.id = r.payment_transaction_id
        WHERE r.status = 'queued' ORDER BY r.queued_at LIMIT 20`);
    let n = 0;
    for (const r of rows) {
      // Claim it first, so two job runs cannot submit the same refund twice.
      const { rowCount } = await this.pool.query(
        "UPDATE refund SET status = 'submitted', attempts = attempts + 1, submitted_at = $2 WHERE id = $1 AND status = 'queued'", [r.id, this.clock.now()]);
      if (!rowCount) continue;
      try {
        const res = await this.provider.refund({ providerTxnId: r.provider_txn_id, amountKobo: BigInt(r.amount_kobo), reason: r.reason });
        await this.pool.query("UPDATE refund SET provider_refund_ref = $2 WHERE id = $1", [r.id, res.providerRefundRef]);
        await this.event(r.payment_id, "refund_submitted", { providerRefundRef: res.providerRefundRef, status: res.status });
        if (res.status === "processed") await this.refundProcessed(r.payment_id);
        n++;
      } catch (err) {
        await this.pool.query("UPDATE refund SET status = 'queued', last_error = $2 WHERE id = $1", [r.id, (err as Error).message]);
      }
    }
    return n;
  }

  private async refundNotice(reference: string, event: string): Promise<string> {
    const { rows: [p] } = await this.pool.query<{ id: string }>("SELECT id FROM payment_transaction WHERE reference = $1", [reference]);
    if (!p) return "ignored";
    if (event === "refund.processed") return (await this.refundProcessed(p.id)) ? "refunded" : "already_refunded";
    if (event === "refund.failed") {
      // The money went back to the merchant balance. It is still owed: queue the refund again, so the job
      // retries it until it succeeds or runs out of attempts and is raised to operations.
      await this.pool.query(
        "UPDATE refund SET status = 'queued', provider_refund_ref = NULL, last_error = 'provider reported refund.failed' WHERE payment_transaction_id = $1 AND status <> 'processed'",
        [p.id]);
      await this.event(p.id, "refund_failed", {});
      this.log.warn(`Refund for payment ${p.id} failed at the provider; queued again`);
      return "refund_failed";
    }
    return "noted";
  }

  /** The money has gone back: the refund posts to the ledger once (US-020). */
  private async refundProcessed(paymentId: string): Promise<boolean> {
    return withPgTransaction(this.pool, async (c) => {
      const { rows: [r] } = await c.query<{ id: string; amount_kobo: string; status: string }>(
        "SELECT id, amount_kobo::text, status::text FROM refund WHERE payment_transaction_id = $1 FOR UPDATE", [paymentId]);
      if (!r || r.status === "processed") return false;
      const { rows: [p] } = await c.query<PaymentRow>("SELECT * FROM payment_transaction WHERE id = $1", [paymentId]);
      await c.query("UPDATE refund SET status = 'processed', processed_at = $2 WHERE id = $1", [r.id, this.clock.now()]);
      await c.query(
        `INSERT INTO payment_ledger_entry (entry_type, amount_kobo, user_id, payment_transaction_id, reference, actor)
         VALUES ('refund', $1, $2, $3, $4, $5)`, [(-BigInt(r.amount_kobo)).toString(), p!.user_id, p!.id, p!.reference, `provider:${this.provider.name}`]);
      await this.event(paymentId, "refund_processed", { amount: r.amount_kobo }, c);
      return true;
    });
  }

  // ——— Jobs ———

  /**
   * Closes holds that lapsed (US-135). Capacity already returned the moment they
   * expired — an expired hold is never counted — so this only records it, and
   * asks the provider once more in case a payment completed at the last moment.
   */
  async sweepExpired(): Promise<{ holds: number; payments: number }> {
    const now = this.clock.now();
    const { rows: holds } = await this.pool.query<{ id: string }>(
      "SELECT id FROM inventory_hold WHERE released_at IS NULL AND expires_at <= $1 ORDER BY expires_at LIMIT 200", [now]);
    let payments = 0;
    for (const h of holds) {
      // One stubborn payment must not stop every other hold from being closed.
      try {
        const { rows: open } = await this.pool.query<{ reference: string }>(
          "SELECT reference FROM payment_transaction WHERE hold_id = $1 AND status = 'initiated'", [h.id]);
        for (const p of open) {
          const r = await this.settle(p.reference, "expiry");
          if (r.state === "confirmed" || r.state === "refund_due") continue;
          await this.pool.query("UPDATE payment_transaction SET status = 'abandoned', fulfilment = 'not_applicable', updated_at = now() WHERE reference = $1 AND status = 'initiated'", [p.reference]);
          payments++;
        }
      } catch (err) {
        this.log.error(`Closing hold ${h.id} failed: ${(err as Error).message}`);
      }
      await this.pool.query(
        "UPDATE inventory_hold SET released_at = expires_at, release_reason = 'expired' WHERE id = $1 AND released_at IS NULL AND NOT EXISTS (SELECT 1 FROM reservation WHERE hold_id = $1)", [h.id]);
    }
    const { rows: topUps } = await this.pool.query<{ reference: string }>(
      `SELECT reference FROM payment_transaction WHERE purpose = 'top_up' AND status = 'initiated' AND created_at <= $1 LIMIT 200`,
      [new Date(now.getTime() - TOP_UP_ABANDON_MINUTES * 60_000)]);
    for (const p of topUps) {
      const r = await this.settle(p.reference, "expiry");
      if (r.state !== "pending") continue;
      await this.pool.query("UPDATE payment_transaction SET status = 'abandoned', fulfilment = 'not_applicable', updated_at = now() WHERE reference = $1 AND status = 'initiated'", [p.reference]);
      payments++;
    }
    return { holds: holds.length, payments };
  }

  /**
   * Asks the provider again about recent payments recorded as abandoned or failed. A driver can still
   * complete a payment on the provider's page after the platform gave up on it; if that webhook is
   * lost, this is what finds the money, and settle() then books it or refunds it (US-017).
   */
  async recheckRecent(): Promise<number> {
    const now = this.clock.now();
    const { rows } = await this.pool.query<{ reference: string }>(
      `SELECT reference FROM payment_transaction
        WHERE status IN ('abandoned', 'failed') AND created_at > $1 AND (last_checked_at IS NULL OR last_checked_at < $2)
        ORDER BY created_at DESC LIMIT 50`,
      [new Date(now.getTime() - RECHECK_HOURS * 3_600_000), new Date(now.getTime() - RECHECK_EVERY_MINUTES * 60_000)]);
    let found = 0;
    for (const p of rows) {
      try {
        const r = await this.settle(p.reference, "recheck");
        if (r.state === "confirmed" || r.state === "credited" || r.state === "refund_due") found++;
      } catch (err) {
        this.log.error(`Recheck of ${p.reference} failed: ${(err as Error).message}`);
      }
    }
    return found;
  }

  // ——— Helpers ———

  private async holdByKey(userId: string, key: string): Promise<string | null> {
    const { rows: [h] } = await this.pool.query<{ id: string }>("SELECT id FROM inventory_hold WHERE user_id = $1 AND idempotency_key = $2", [userId, key]);
    return h?.id ?? null;
  }

  private async enforceInitiationLimit(userId: string) {
    const since = new Date(this.clock.now().getTime() - INITIATION_WINDOW_MINUTES * 60_000);
    const { rows: [r] } = await this.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM payment_transaction WHERE user_id = $1 AND created_at > $2", [userId, since]);
    if ((r?.n ?? 0) >= INITIATION_LIMIT) {
      throw new ApiError(HttpStatus.TOO_MANY_REQUESTS, "TOO_MANY_PAYMENTS", "Too many payment attempts. Wait a few minutes and try again.");
    }
  }

  private async createPayment(userId: string, purpose: "checkout" | "top_up", amountKobo: bigint, holdId: string | null, idempotencyKey?: string): Promise<PaymentRow> {
    const reference = purpose === "checkout" ? newReference("AV") + "-P" : newReference("TU");
    const { rows: [p] } = await this.pool.query<PaymentRow>(
      `INSERT INTO payment_transaction (reference, user_id, purpose, provider, amount_kobo, hold_id, idempotency_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [reference, userId, purpose, this.provider.name, amountKobo.toString(), holdId, idempotencyKey ?? null, this.clock.now()]);
    await this.event(p!.id, "initiated", { purpose, amount: amountKobo.toString() });
    return p!;
  }

  private async initialize(p: PaymentRow, callbackUrl: string, metadata: Record<string, string>) {
    const { rows: [u] } = await this.pool.query<{ email: string | null; mobile_e164: string }>("SELECT email, mobile_e164 FROM app_user WHERE id = $1", [p.user_id]);
    const email = u?.email ?? `${u!.mobile_e164.replace(/\D/g, "")}@${this.config.payments.fallbackEmailDomain}`;
    const init = await this.provider.initialize({ reference: p.reference, amountKobo: BigInt(p.amount_kobo), email, callbackUrl, metadata: { ...metadata, payment: p.id } });
    await this.pool.query("UPDATE payment_transaction SET authorization_url = $2, updated_at = now() WHERE id = $1", [p.id, init.authorizationUrl]);
  }

  private async releaseHold(holdId: string, reason: "payment_failed" | "cancelled") {
    await this.pool.query(
      `UPDATE inventory_hold SET released_at = $3, release_reason = $2
        WHERE id = $1 AND released_at IS NULL AND NOT EXISTS (SELECT 1 FROM reservation WHERE hold_id = $1)`,
      [holdId, reason, this.clock.now()]);
  }

  private async markPayment(id: string, status: "failed", note: string, detail: Record<string, unknown>) {
    await this.pool.query("UPDATE payment_transaction SET status = $2, fulfilment = 'not_applicable', fulfilment_note = $3, updated_at = now() WHERE id = $1", [id, status, note]);
    await this.event(id, status, detail);
  }

  private async event(paymentId: string, kind: string, detail: Record<string, unknown>, c: pg.Pool | pg.PoolClient = this.pool) {
    await c.query("INSERT INTO payment_event (payment_id, kind, detail) VALUES ($1, $2, $3)", [paymentId, kind, JSON.stringify(detail)]);
  }

  private async pendingTopUps(userId: string): Promise<bigint> {
    const since = new Date(this.clock.now().getTime() - TOP_UP_ABANDON_MINUTES * 60_000);
    const { rows: [r] } = await this.pool.query<{ s: string }>(
      "SELECT COALESCE(sum(amount_kobo), 0)::text AS s FROM payment_transaction WHERE user_id = $1 AND purpose = 'top_up' AND status = 'initiated' AND created_at > $2",
      [userId, since]);
    return BigInt(r!.s);
  }

  private async balance(userId: string): Promise<bigint> {
    const { rows: [r] } = await this.pool.query<{ b: string }>("SELECT COALESCE(sum(amount_kobo), 0)::text AS b FROM wallet_entry WHERE user_id = $1", [userId]);
    return BigInt(r!.b);
  }
}

const naira = (k: bigint) => `₦${(Number(k) / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 })}`;
