/**
 * Sprint 2 — payments over HTTP against real Postgres, with the production
 * Paystack adapter talking to the Paystack simulator over HTTP and receiving
 * its signed webhooks.
 *
 * Checkout behind a hold (US-134, US-135, §4.13 steps 3–5 and the abandoned-payment variant),
 * deterministic outcomes and idempotent webhooks (US-017), wallet top-up (US-016),
 * allocated credit first (US-018, OD-12), limits (US-015), the ledger (US-020),
 * history and receipts (US-019), rate limits (NFR-SEC-08).
 */
import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, seed, SEED, type SeedResult } from "@availo/db";
import { startPaystackSimulator, type PaystackSimulator } from "@availo/paystack-sim";
import { AppModule } from "../src/app.module.js";
import { loadConfig } from "../src/config.js";
import { DevSmsSender } from "../src/sms/sms.js";
import { PaystackProvider, paystackSignature } from "../src/payments/paystack.js";
import type { InitializeRequest, PaymentProvider } from "../src/payments/provider.js";
import { PaymentsService } from "../src/payments/payments.service.js";
import { PassService } from "../src/passes/pass.service.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/availo_test";
const SECRET = "sk_test_payments_suite";
const T0 = new Date("2029-12-31T12:00:00Z");
const TOMORROW_10 = "2030-01-01T10:00:00+01:00";
const RATE = 50_000n; // test rate, ₦500/hour

const clock = { t: T0, now() { return this.t; }, advance(s: number) { this.t = new Date(this.t.getTime() + s * 1000); } };
const sms = new DevSmsSender();
const pool = new pg.Pool({ connectionString: DATABASE_URL });
let app: INestApplication;
let sim: PaystackSimulator;
let seeded: SeedResult;
let payments: PaymentsService;

/** The production adapter, with switches to make the provider misbehave on demand. */
class Flaky implements PaymentProvider {
  readonly name = "paystack";
  failInitialize = false;
  failVerify = false;
  constructor(private readonly inner: PaystackProvider) {}
  initialize(r: InitializeRequest) { if (this.failInitialize) return Promise.reject(new Error("connect ECONNREFUSED")); return this.inner.initialize(r); }
  verify(ref: string) { if (this.failVerify) return Promise.reject(new Error("timeout")); return this.inner.verify(ref); }
  refund(r: Parameters<PaymentProvider["refund"]>[0]) { return this.inner.refund(r); }
  authenticateWebhook(b: Buffer, h: Record<string, string | string[] | undefined>) { return this.inner.authenticateWebhook(b, h); }
  parseWebhook(b: Buffer) { return this.inner.parseWebhook(b); }
}
let provider: Flaky;

const http = () => request(app.getHttpServer());
const lastCode = (mobile: string) => /\b(\d{6})\b/.exec(sms.lastTo(mobile)?.body ?? "")?.[1] ?? "";
async function signIn(mobile: string): Promise<string> {
  await http().post("/auth/otp/request").send({ mobile }).expect(202);
  const r = await http().post("/auth/otp/verify").send({ mobile, code: lastCode(mobile) }).expect(200);
  clock.advance(61); // OTP resend throttle
  return r.body.accessToken as string;
}
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const guest = () => signIn(SEED.guests[0].mobile);
const staff = (i = 0) => signIn(SEED.drivers[i]!.mobile);
const n = async (sql: string, params: unknown[] = []) => Number((await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM (${sql}) q`, params)).rows[0]!.n);

async function openAvailable(token: string, start = TOMORROW_10, hours = 3): Promise<number> {
  const r = await http().get(`/lots/${seeded.lotId}/availability`).query({ start, hours }).set(as(token)).expect(200);
  return r.body.pools.find((p: { kind: string }) => p.kind === "open").available as number;
}
function checkout(token: string, body: Record<string, unknown> = {}, key?: string) {
  const req = http().post("/checkouts").set(as(token));
  if (key) req.set("Idempotency-Key", key);
  return req.send({ lotId: seeded.lotId, vehicleId: seeded.guests[0]!.vehicleId, start: TOMORROW_10, hours: 3, ...body });
}

beforeAll(async () => {
  sim = await startPaystackSimulator({ secretKey: SECRET, webhookUrl: null, autoProcessRefunds: false });
  provider = new Flaky(new PaystackProvider(SECRET, sim.url));
  const config = loadConfig({ NODE_ENV: "test", DATABASE_URL, PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_BASE_URL: sim.url });
  const mod = await Test.createTestingModule({ imports: [AppModule.forRoot(config, { clock, sms, payments: provider })] }).compile();
  app = mod.createNestApplication({ logger: false, rawBody: true });
  await app.listen(0, "127.0.0.1");
  sim.setWebhookUrl(`${await app.getUrl()}/webhooks/paystack`.replace("[::1]", "127.0.0.1"));
  payments = app.get(PaymentsService);
});

beforeEach(async () => {
  clock.t = T0;
  sms.outbox.length = 0;
  provider.failInitialize = false;
  provider.failVerify = false;
  const c = await pool.connect();
  try {
    await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(c);
    seeded = await seed(c);
  } finally {
    c.release();
  }
});

afterAll(async () => {
  await app.close();
  await sim.close();
  await pool.end();
});

describe("US-134, US-135 checkout behind a hold (§4.13 steps 3–5)", () => {
  it("quotes the checkout path with the total before anything is charged", async () => {
    const g = await guest();
    await pool.query("UPDATE tariff SET service_fee_kobo = 10000"); // pre-pilot data only; tariffs are versioned in operation
    const a = await http().get(`/lots/${seeded.lotId}/availability`).query({ start: TOMORROW_10, hours: 3 }).set(as(g)).expect(200);
    expect(a.body).toMatchObject({ paymentPath: "checkout", rateKobo: "50000", serviceFeeKobo: "10000", amountKobo: "160000", balanceBeforeKobo: null });
    const me = await http().get("/me").set(as(g)).expect(200);
    expect(me.body).toMatchObject({ paymentPath: "checkout", walletBalanceKobo: null });
  });

  it("holds the space, takes payment on the provider's page, and confirms only after verifying — exactly once", async () => {
    const g = await guest();
    expect(await openAvailable(g)).toBe(6);
    const c = await checkout(g).expect(201);
    expect(c.body).toMatchObject({ state: "held", secondsLeft: 600, amountKobo: (RATE * 3n).toString(), parkingKobo: (RATE * 3n).toString(), serviceFeeKobo: "0" });
    expect(c.body.payment.authorizationUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/checkout\//);
    // §4.13 step 4: the hold counts against the pool. 6 → 5.
    expect(await openAvailable(g)).toBe(5);

    // The driver pays; Paystack posts charge.success; the API verifies with Paystack and converts the hold.
    await sim.pay(c.body.payment.reference);
    const after = await http().get(`/checkouts/${c.body.holdId}`).set(as(g)).expect(200);
    expect(after.body.state).toBe("confirmed");
    expect(await openAvailable(g)).toBe(5); // converted without releasing and re-taking the space

    // Paystack retries the webhook; the driver's browser comes back and asks too.
    await sim.resendWebhooks(c.body.payment.reference);
    await sim.resendWebhooks(c.body.payment.reference);
    await http().post(`/checkouts/${c.body.holdId}/verify`).set(as(g)).expect(200);
    expect(await n("SELECT 1 FROM reservation")).toBe(1);
    expect(await n("SELECT 1 FROM payment_ledger_entry WHERE entry_type = 'checkout_payment'")).toBe(1);
    expect((await pool.query("SELECT times_received FROM webhook_event")).rows).toEqual([{ times_received: 3 }]);

    const r = await http().get(`/reservations/${after.body.reservationId}`).set(as(g)).expect(200);
    expect(r.body).toMatchObject({ status: "confirmed", pool: "open", paidBy: "checkout", amountKobo: (RATE * 3n).toString(), reference: c.body.reference });
    // §4.13 step 5: the pass, and its SMS copy with no QR.
    const pass = await http().get(`/reservations/${r.body.id}/pass`).set(as(g)).expect(200);
    expect(pass.body.pin).toMatch(/^\d{6}$/);
    expect(sms.lastTo(SEED.guests[0].mobile)?.body).toContain(`Gate PIN ${pass.body.pin}`);
    // The ledger entry is immutable.
    await expect(pool.query("UPDATE payment_ledger_entry SET amount_kobo = 1")).rejects.toThrow(/append-only/);
  });

  it("never confirms on the browser's return or an unauthenticated webhook — only on the provider's verify", async () => {
    const g = await guest();
    const c = await checkout(g).expect(201);
    const ref = c.body.payment.reference as string;
    // Back from checkout without paying: Paystack says "abandoned", which is not final while the hold is live.
    expect((await http().post(`/checkouts/${c.body.holdId}/verify`).set(as(g)).expect(200)).body.state).toBe("held");

    const forged = JSON.stringify({ event: "charge.success", data: { id: 1, reference: ref, status: "success", amount: Number(RATE * 3n), currency: "NGN" } });
    await http().post("/webhooks/paystack").set("Content-Type", "application/json").set("x-paystack-signature", "0".repeat(128)).send(forged).expect(401);
    await http().post("/webhooks/paystack").set("Content-Type", "application/json").send(forged).expect(401);
    // Even a correctly signed webhook is only a prompt to ask Paystack, which says it is unpaid.
    await http().post("/webhooks/paystack").set("Content-Type", "application/json").set("x-paystack-signature", paystackSignature(SECRET, forged)).send(forged).expect(200);
    expect(await n("SELECT 1 FROM reservation")).toBe(0);
    expect((await http().get(`/checkouts/${c.body.holdId}`).set(as(g))).body.state).toBe("held");
  });

  it("a payment failure returns the space at once", async () => {
    const g = await guest();
    const c = await checkout(g).expect(201);
    expect(await openAvailable(g)).toBe(5);
    sim.fail(c.body.payment.reference);
    const v = await http().post(`/checkouts/${c.body.holdId}/verify`).set(as(g)).expect(200);
    expect(v.body).toMatchObject({ state: "failed", payment: { status: "failed" } });
    expect(await openAvailable(g)).toBe(6);
  });

  it("abandoned-payment variant: the space returns on hold expiry, before any job runs; the job then records it", async () => {
    const g = await guest();
    const c = await checkout(g).expect(201);
    expect(await openAvailable(g)).toBe(5);
    clock.advance(600);
    expect(await openAvailable(g)).toBe(6);
    expect((await http().get(`/checkouts/${c.body.holdId}`).set(as(g))).body.state).toBe("expired");
    expect(await payments.sweepExpired()).toEqual({ holds: 1, payments: 1 });
    expect((await pool.query("SELECT release_reason FROM inventory_hold")).rows).toEqual([{ release_reason: "expired" }]);
    expect((await pool.query("SELECT status::text FROM payment_transaction")).rows).toEqual([{ status: "abandoned" }]);
    expect(await n("SELECT 1 FROM reservation")).toBe(0);
  });

  it("a payment that lands after the hold lapsed is honoured if the space is still free", async () => {
    const g = await guest();
    const c = await checkout(g).expect(201);
    clock.advance(700); // past the 10-minute hold, inside the 15-minute access token
    await payments.sweepExpired();
    await sim.pay(c.body.payment.reference);
    expect((await http().get(`/checkouts/${c.body.holdId}`).set(as(g))).body.state).toBe("confirmed");
    expect((await pool.query("SELECT fulfilment::text, status::text FROM payment_transaction")).rows).toEqual([{ fulfilment: "fulfilled", status: "succeeded" }]);
  });

  it("…and refunded to the original method, posted once, if the space has gone", async () => {
    const g = await guest();
    const c = await checkout(g).expect(201);
    clock.advance(601);
    // The open share fills while the first driver is still on the payment page.
    await pool.query("UPDATE capacity_pool SET capacity = 0 WHERE kind = 'open'");
    await sim.pay(c.body.payment.reference);
    const v = (await http().get(`/checkouts/${c.body.holdId}`).set(as(g))).body;
    expect(v).toMatchObject({ state: "refund_due", payment: { fulfilment: "refund_due" } });
    expect(await n("SELECT 1 FROM reservation")).toBe(0);
    expect(await n("SELECT 1 FROM payment_ledger_entry WHERE entry_type = 'unfulfilled_payment'")).toBe(1);
    expect(await n("SELECT 1 FROM payment_ledger_entry WHERE entry_type = 'checkout_payment'")).toBe(0);

    await payments.submitRefunds();
    expect(sim.refunds).toHaveLength(1);
    await sim.processRefunds();      // refund.processed webhook
    await sim.resendWebhooks(c.body.payment.reference);
    expect((await pool.query("SELECT status::text FROM refund")).rows).toEqual([{ status: "processed" }]);
    expect(await n("SELECT 1 FROM payment_ledger_entry WHERE entry_type = 'refund'")).toBe(1);
    const net = await pool.query<{ s: string }>("SELECT sum(amount_kobo)::text AS s FROM payment_ledger_entry");
    expect(net.rows[0]!.s).toBe("0");
    const h = await http().get("/payments").set(as(g)).expect(200);
    expect(h.body.map((i: { kind: string; status: string }) => `${i.kind}:${i.status}`)).toEqual(["refund:processed", "checkout:refund_due"]);
  });

  it("refunds a payment whose amount differs from what was asked", async () => {
    const g = await guest();
    const c = await checkout(g).expect(201);
    await sim.pay(c.body.payment.reference, { amountKobo: 100n });
    expect((await http().get(`/checkouts/${c.body.holdId}`).set(as(g))).body.state).toBe("refund_due");
    expect(await n("SELECT 1 FROM reservation")).toBe(0);
    expect((await pool.query("SELECT amount_kobo::text FROM refund")).rows).toEqual([{ amount_kobo: "100" }]);
  });

  it("cancelling returns the space at once; a payment that still lands is refunded, not booked", async () => {
    const g = await guest();
    const c = await checkout(g).expect(201);
    expect((await http().delete(`/checkouts/${c.body.holdId}`).set(as(g)).expect(200)).body.state).toBe("cancelled");
    expect(await openAvailable(g)).toBe(6);
    await sim.pay(c.body.payment.reference);
    expect(await n("SELECT 1 FROM reservation")).toBe(0);
    expect((await pool.query("SELECT fulfilment_note FROM payment_transaction")).rows[0].fulfilment_note).toMatch(/cancelled/);
  });

  it("a retried request returns the same checkout; a second checkout while one is open is refused with its id", async () => {
    const g = await guest();
    const a = await checkout(g, {}, "checkout-key-0001").expect(201);
    const b = await checkout(g, {}, "checkout-key-0001").expect(201);
    expect(b.body.holdId).toBe(a.body.holdId);
    expect(b.body.payment.reference).toBe(a.body.payment.reference);
    const other = await checkout(g, { start: "2030-01-02T10:00:00+01:00" }).expect(409);
    expect(other.body.error).toMatchObject({ code: "CHECKOUT_IN_PROGRESS", holdId: a.body.holdId });
    expect(await n("SELECT 1 FROM payment_transaction")).toBe(1);
  });

  it("a provider outage holds nothing and charges nothing", async () => {
    const g = await guest();
    provider.failInitialize = true;
    const r = await checkout(g).expect(502);
    expect(r.body.error.code).toBe("PAYMENT_PROVIDER_UNAVAILABLE");
    expect(await openAvailable(g)).toBe(6);
    provider.failInitialize = false;
    await checkout(g).expect(201);
  });

  it("a verify timeout changes nothing and the next attempt settles it", async () => {
    const g = await guest();
    const c = await checkout(g).expect(201);
    provider.failVerify = true;
    await sim.pay(c.body.payment.reference);
    expect((await http().get(`/checkouts/${c.body.holdId}`).set(as(g))).body.state).toBe("held");
    provider.failVerify = false;
    expect((await http().post(`/checkouts/${c.body.holdId}/verify`).set(as(g))).body.state).toBe("confirmed");
  });

  it("keeps wallet drivers on the wallet and guests off it", async () => {
    const s = await staff();
    expect((await checkout(s, { vehicleId: seeded.users[0]!.vehicleId }).expect(422)).body.error.code).toBe("CHECKOUT_PATH_NOT_AVAILABLE");
    const g = await guest();
    expect((await http().post("/top-ups").set(as(g)).send({ amountKobo: "500000" }).expect(422)).body.error.code).toBe("WALLET_PATH_NOT_AVAILABLE");
  });

  it("rate-limits payment initiation (NFR-SEC-08)", async () => {
    const s = await staff();
    for (let i = 0; i < 5; i++) await http().post("/top-ups").set(as(s)).send({ amountKobo: "100000" }).expect(201);
    expect((await http().post("/top-ups").set(as(s)).send({ amountKobo: "100000" }).expect(429)).body.error.code).toBe("TOO_MANY_PAYMENTS");
  });

  it("puts the confirmed checkout booking in the gate cache like any other", async () => {
    const g = await guest();
    const c = await checkout(g).expect(201);
    await sim.pay(c.body.payment.reference);
    clock.advance(12 * 3600);
    const cache = await app.get(PassService).gateCache(seeded.lotId);
    expect(cache.passes.map((p) => p.reference)).toContain(c.body.reference);
  });
});

describe("US-016 wallet top-up", () => {
  it("credits the wallet only after verifying, exactly once however the outcome arrives", async () => {
    const s = await staff(1); // seeded with ₦3,000 of allocated credit
    const rules = await http().get("/wallet/rules").set(as(s)).expect(200);
    expect(rules.body).toMatchObject({ minTopUpKobo: "50000", consumptionOrder: "allocated_first" });
    const t = await http().post("/top-ups").set(as(s)).set("Idempotency-Key", "topup-key-0001").send({ amountKobo: "500000" }).expect(201);
    expect(t.body).toMatchObject({ state: "pending", amountKobo: "500000", balanceKobo: "300000" });
    const again = await http().post("/top-ups").set(as(s)).set("Idempotency-Key", "topup-key-0001").send({ amountKobo: "500000" }).expect(201);
    expect(again.body.paymentId).toBe(t.body.paymentId);

    await sim.pay(t.body.reference, { webhook: false });
    // The webhook and five browser verifies arrive at once.
    await Promise.all([sim.resendWebhooks(t.body.reference), ...Array.from({ length: 5 }, () => http().post(`/top-ups/${t.body.paymentId}/verify`).set(as(s)))]);
    await sim.pay(t.body.reference); // already paid: no-op at the provider
    const v = await http().get(`/top-ups/${t.body.paymentId}`).set(as(s)).expect(200);
    expect(v.body).toMatchObject({ state: "credited", balanceKobo: "800000" });
    expect(await n("SELECT 1 FROM wallet_entry WHERE entry_type = 'top_up'")).toBe(1);
    expect(await n("SELECT 1 FROM payment_ledger_entry WHERE entry_type = 'top_up_payment'")).toBe(1);
    expect((await pool.query("SELECT allocated_kobo::text FROM wallet_entry WHERE entry_type = 'top_up'")).rows).toEqual([{ allocated_kobo: "0" }]);
    // The database itself refuses a second credit for the same payment.
    await expect(pool.query(
      `INSERT INTO wallet_entry (user_id, entry_type, amount_kobo, reference, actor, payment_transaction_id)
       SELECT user_id, 'top_up', amount_kobo, reference, 'test', id FROM payment_transaction`)).rejects.toThrow(/wallet_entry_top_up_once/);
  });

  it("enforces the configured limits before any payment opens (US-015)", async () => {
    const s = await staff(1);
    expect((await http().post("/top-ups").set(as(s)).send({ amountKobo: "49999" }).expect(422)).body.error).toMatchObject({ code: "TOP_UP_OUT_OF_RANGE", minKobo: "50000" });
    expect((await http().post("/top-ups").set(as(s)).send({ amountKobo: "5000001" }).expect(422)).body.error.code).toBe("TOP_UP_OUT_OF_RANGE");
    await pool.query("INSERT INTO wallet_rule (min_top_up_kobo, max_top_up_kobo, max_balance_kobo, effective_from, created_by) VALUES (50000, 400000, 500000, $1, 'test')", [new Date(T0.getTime() - 1000)]);
    const r = await http().post("/top-ups").set(as(s)).send({ amountKobo: "300000" }).expect(422);
    expect(r.body.error).toMatchObject({ code: "BALANCE_LIMIT", headroomKobo: "200000" });
    expect(await n("SELECT 1 FROM payment_transaction")).toBe(0);
  });

  it("consumes allocated credit before paid credit (OD-12), and the split shows on every debit", async () => {
    const s = await staff(2); // ₦1,000 allocated
    const t = await http().post("/top-ups").set(as(s)).send({ amountKobo: "200000" }).expect(201);
    await sim.pay(t.body.reference);
    const book = (start: string, hours: number) =>
      http().post("/reservations").set(as(s)).send({ lotId: seeded.lotId, vehicleId: seeded.users[2]!.vehicleId, start, hours });
    await book("2030-01-01T09:00:00+01:00", 1).expect(201); // ₦500: all allocated
    await book("2030-01-02T09:00:00+01:00", 2).expect(201); // ₦1,000: ₦500 allocated, ₦500 paid
    await book("2030-01-03T09:00:00+01:00", 3).expect(201); // ₦1,500: all paid
    const { rows } = await pool.query("SELECT amount_kobo::text AS amount, allocated_kobo::text AS allocated FROM wallet_entry WHERE entry_type = 'reservation_debit' ORDER BY created_at, id");
    expect(rows).toEqual([
      { amount: "-50000", allocated: "-50000" },
      { amount: "-100000", allocated: "-50000" },
      { amount: "-150000", allocated: "0" },
    ]);
    const w = await http().get("/wallet").set(as(s)).expect(200);
    expect(w.body.balanceKobo).toBe("0");
  });
});

describe("US-019 history, receipts and statements", () => {
  it("lists every payment and serves a PDF receipt to its owner only", async () => {
    const g = await guest();
    const c = await checkout(g).expect(201);
    await sim.pay(c.body.payment.reference, { channel: "ussd" });
    const h = await http().get("/payments").set(as(g)).expect(200);
    expect(h.body).toHaveLength(1);
    expect(h.body[0]).toMatchObject({ kind: "checkout", status: "fulfilled", channel: "ussd", receipt: true, booking: { reference: c.body.reference } });
    const pdf = await http().get(`/payments/${h.body[0].paymentId}/receipt.pdf`).set(as(g)).buffer(true).parse(binary).expect(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    const s = await staff();
    await http().get(`/payments/${h.body[0].paymentId}/receipt.pdf`).set(as(s)).expect(404);
  });

  it("produces a statement for any period", async () => {
    const s = await staff();
    const t = await http().post("/top-ups").set(as(s)).send({ amountKobo: "100000" }).expect(201);
    await sim.pay(t.body.reference);
    const pdf = await http().get("/statement.pdf").query({ from: "2029-12-01", to: "2029-12-31" }).set(as(s)).buffer(true).parse(binary).expect(200);
    expect((pdf.body as Buffer).length).toBeGreaterThan(1000);
    await http().get("/statement.pdf").query({ from: "2030-01-02", to: "2030-01-01" }).set(as(s)).expect(400);
  });
});

/** supertest parser that keeps a PDF as bytes. */
function binary(res: request.Response, cb: (err: Error | null, body: unknown) => void) {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  stream.on("end", () => cb(null, Buffer.concat(chunks)));
}
