import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for Paystack's API, for development, tests, the demo and the
 * browser test. It speaks the same protocol the PaystackProvider adapter uses —
 * the same paths, bodies, statuses and HMAC-SHA512 webhook signature — so the
 * adapter under test is the production adapter.
 *
 * It is not Paystack. Field-level details it reproduces are taken from Paystack's
 * published API; the live test-mode run with a real test key is what confirms them.
 *
 * Behaviour it models on purpose:
 * - verify reports "abandoned" for a transaction nobody has paid yet, as Paystack does;
 * - a payment can complete after the platform's hold has lapsed (late payment);
 * - webhooks can be repeated, delayed or withheld, to prove idempotency (US-017);
 * - the paid amount can be made to differ from the amount asked for.
 */
export interface SimTransaction {
  id: number;
  reference: string;
  accessCode: string;
  amountKobo: bigint;
  paidAmountKobo: bigint | null;
  email: string;
  callbackUrl: string;
  metadata: Record<string, unknown>;
  status: "abandoned" | "success" | "failed";
  channel: string | null;
  paidAt: Date | null;
}

export interface SimRefund { id: number; transactionId: number; reference: string; amountKobo: bigint; status: "pending" | "processed" | "failed" }

export interface SimOptions {
  secretKey: string;
  /** Where charge.success and refund.* webhooks are delivered. Null to deliver none. */
  webhookUrl: string | null;
  port?: number;
  /** Deliver each webhook this many times (Paystack retries; so does this). Default 1. */
  webhookRepeats?: number;
  /** Process refunds as soon as they are requested. Default true. */
  autoProcessRefunds?: boolean;
  log?: boolean;
}

export interface PaystackSimulator {
  readonly url: string;
  readonly transactions: Map<string, SimTransaction>;
  readonly refunds: SimRefund[];
  readonly webhooksSent: Array<{ event: string; reference: string | null; status: number | null }>;
  /** Mark a transaction paid, as if the driver completed the hosted checkout, and send charge.success. */
  pay(reference: string, opts?: { channel?: string; amountKobo?: bigint; webhook?: boolean }): Promise<void>;
  fail(reference: string): void;
  /** Resend every webhook for a reference, signed again, exactly as before. */
  resendWebhooks(reference: string): Promise<void>;
  processRefunds(): Promise<void>;
  /** Fail every pending refund, as Paystack does when the money cannot go back, and send refund.failed. */
  failRefunds(): Promise<void>;
  setWebhookUrl(url: string | null): void;
  close(): Promise<void>;
}

const FEE_RATE = 0.015;
const FEE_FLAT_KOBO = 10_000n; // ₦100, waived under ₦2,500, capped at ₦2,000 — Paystack's local card pricing

function fees(amount: bigint): bigint {
  let f = BigInt(Math.round(Number(amount) * FEE_RATE)) + (amount >= 250_000n ? FEE_FLAT_KOBO : 0n);
  if (f > 200_000n) f = 200_000n;
  return f;
}

export async function startPaystackSimulator(opts: SimOptions): Promise<PaystackSimulator> {
  const transactions = new Map<string, SimTransaction>();
  const byAccessCode = new Map<string, SimTransaction>();
  const refunds: SimRefund[] = [];
  const webhooksSent: PaystackSimulator["webhooksSent"] = [];
  const sentBodies = new Map<string, string[]>();
  let webhookUrl = opts.webhookUrl;
  let nextId = 4_100_000_000;
  let nextRefund = 9_000_000;
  const log = (m: string) => { if (opts.log) console.log(`[paystack-sim] ${m}`); };

  const sign = (body: string) => createHmac("sha512", opts.secretKey).update(body).digest("hex");

  async function deliver(event: string, reference: string | null, data: Record<string, unknown>) {
    const body = JSON.stringify({ event, data });
    const list = sentBodies.get(reference ?? "") ?? [];
    list.push(body);
    sentBodies.set(reference ?? "", list);
    for (let i = 0; i < (opts.webhookRepeats ?? 1); i++) await post(event, reference, body);
  }

  async function post(event: string, reference: string | null, body: string) {
    if (!webhookUrl) { webhooksSent.push({ event, reference, status: null }); return; }
    try {
      const r = await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json", "x-paystack-signature": sign(body) }, body });
      webhooksSent.push({ event, reference, status: r.status });
      log(`webhook ${event} ${reference} → ${r.status}`);
    } catch (err) {
      webhooksSent.push({ event, reference, status: null });
      log(`webhook ${event} ${reference} failed: ${(err as Error).message}`);
    }
  }

  const txnData = (t: SimTransaction) => ({
    id: t.id, domain: "test", status: t.status, reference: t.reference,
    amount: Number(t.paidAmountKobo ?? t.amountKobo), currency: "NGN",
    gateway_response: t.status === "success" ? "Successful" : t.status === "failed" ? "Declined" : "The transaction was not completed",
    paid_at: t.paidAt?.toISOString() ?? null, created_at: new Date().toISOString(),
    channel: t.channel, fees: t.status === "success" ? Number(fees(t.paidAmountKobo ?? t.amountKobo)) : null,
    metadata: t.metadata,
    customer: { email: t.email },
  });

  async function pay(reference: string, o: { channel?: string; amountKobo?: bigint; webhook?: boolean } = {}) {
    const t = transactions.get(reference);
    if (!t) throw new Error(`No simulated transaction ${reference}`);
    if (t.status === "success") return;
    t.status = "success";
    t.channel = o.channel ?? "card";
    t.paidAmountKobo = o.amountKobo ?? t.amountKobo;
    t.paidAt = new Date();
    if (o.webhook !== false) await deliver("charge.success", reference, txnData(t));
  }

  async function processRefunds() {
    for (const r of refunds.filter((x) => x.status === "pending")) {
      r.status = "processed";
      await deliver("refund.processed", r.reference, {
        id: r.id, status: "processed", transaction_reference: r.reference, amount: Number(r.amountKobo), currency: "NGN",
      });
    }
  }

  async function failRefunds() {
    for (const r of refunds.filter((x) => x.status === "pending")) {
      r.status = "failed";
      await deliver("refund.failed", r.reference, { status: "failed", transaction_reference: r.reference, refund_reference: null, amount: Number(r.amountKobo), currency: "NGN" });
    }
  }

  const server: Server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      json(res, 500, { status: false, message: (err as Error).message });
    }
  });

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://sim");
    const parts = url.pathname.split("/").filter(Boolean);

    // ——— The hosted checkout page the driver's browser is sent to ———
    if (parts[0] === "checkout" && parts[1]) {
      const t = byAccessCode.get(parts[1]);
      if (!t) return text(res, 404, "Unknown checkout");
      if (req.method === "GET") return html(res, checkoutPage(t));
      if (req.method === "POST") {
        const form = new URLSearchParams(await readBody(req));
        const action = form.get("action");
        if (action === "pay") await pay(t.reference, { channel: form.get("channel") ?? "card" });
        if (action === "fail") t.status = "failed";
        const back = new URL(t.callbackUrl);
        back.searchParams.set("trxref", t.reference);
        back.searchParams.set("reference", t.reference);
        res.writeHead(303, { Location: back.toString() });
        return res.end();
      }
    }

    // ——— The API ———
    if (req.headers.authorization !== `Bearer ${opts.secretKey}`) return json(res, 401, { status: false, message: "Invalid key" });

    if (req.method === "POST" && url.pathname === "/transaction/initialize") {
      const b = JSON.parse(await readBody(req)) as { email?: string; amount?: string | number; reference?: string; callback_url?: string; metadata?: Record<string, unknown> };
      if (!b.email || !b.amount || !b.reference) return json(res, 400, { status: false, message: "email, amount and reference are required" });
      if (transactions.has(b.reference)) return json(res, 400, { status: false, message: "Duplicate Transaction Reference" });
      const t: SimTransaction = {
        id: nextId++, reference: b.reference, accessCode: randomBytes(8).toString("hex"), amountKobo: BigInt(String(b.amount)), paidAmountKobo: null,
        email: b.email, callbackUrl: b.callback_url ?? "http://localhost/", metadata: b.metadata ?? {}, status: "abandoned", channel: null, paidAt: null,
      };
      transactions.set(t.reference, t);
      byAccessCode.set(t.accessCode, t);
      log(`initialize ${t.reference} ₦${Number(t.amountKobo) / 100}`);
      return json(res, 200, { status: true, message: "Authorization URL created", data: { authorization_url: `${self.url}/checkout/${t.accessCode}`, access_code: t.accessCode, reference: t.reference } });
    }

    if (req.method === "GET" && parts[0] === "transaction" && parts[1] === "verify" && parts[2]) {
      const t = transactions.get(decodeURIComponent(parts[2]));
      if (!t) return json(res, 400, { status: false, message: "Transaction reference not found" });
      return json(res, 200, { status: true, message: "Verification successful", data: txnData(t) });
    }

    if (req.method === "POST" && url.pathname === "/refund") {
      const b = JSON.parse(await readBody(req)) as { transaction?: string | number; amount?: string | number };
      const t = [...transactions.values()].find((x) => String(x.id) === String(b.transaction) || x.reference === String(b.transaction));
      if (!t || t.status !== "success") return json(res, 400, { status: false, message: "Transaction not found or not successful" });
      const amount = b.amount != null ? BigInt(String(b.amount)) : (t.paidAmountKobo ?? t.amountKobo);
      const already = refunds.filter((r) => r.transactionId === t.id && r.status !== "failed").reduce((n, r) => n + r.amountKobo, 0n);
      if (already + amount > (t.paidAmountKobo ?? t.amountKobo)) return json(res, 400, { status: false, message: "Refund amount exceeds transaction amount" });
      const r: SimRefund = { id: nextRefund++, transactionId: t.id, reference: t.reference, amountKobo: amount, status: "pending" };
      refunds.push(r);
      log(`refund ${t.reference} ₦${Number(amount) / 100}`);
      json(res, 200, { status: true, message: "Refund has been queued for processing", data: { id: r.id, status: "pending", amount: Number(amount), currency: "NGN", transaction: { id: t.id, reference: t.reference } } });
      if (opts.autoProcessRefunds ?? true) setTimeout(() => { void processRefunds(); }, 10);
      return;
    }

    return json(res, 404, { status: false, message: "Not found" });
  }

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const self: PaystackSimulator = {
    url: `http://127.0.0.1:${port}`,
    transactions,
    refunds,
    webhooksSent,
    pay,
    fail(reference) {
      const t = transactions.get(reference);
      if (t && t.status !== "success") t.status = "failed";
    },
    async resendWebhooks(reference) {
      for (const body of sentBodies.get(reference) ?? []) await post(JSON.parse(body).event, reference, body);
    },
    processRefunds,
    failRefunds,
    setWebhookUrl(u) { webhookUrl = u; },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
  return self;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
function text(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(body);
}
function html(res: ServerResponse, body: string) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A deliberately plain page, labelled as a simulator so it is never mistaken for Paystack's checkout. */
function checkoutPage(t: SimTransaction): string {
  const naira = `₦${(Number(t.amountKobo) / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment simulator</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f3f3f1;color:#1e2124}main{max-width:420px;margin:0 auto;padding:24px 16px}
.banner{background:#1e2124;color:#ffd23f;padding:10px 14px;font-weight:700;letter-spacing:.02em}
.card{background:#fff;border:1px solid #d9d9d4;padding:16px;margin:16px 0}.amt{font-size:32px;font-weight:800}
button{display:block;width:100%;min-height:48px;margin:10px 0;font:inherit;font-weight:700;border:2px solid #1e2124;background:#fff;cursor:pointer}
button.primary{background:#1e2124;color:#fff}label{display:block;margin:8px 0 4px}select{width:100%;min-height:44px;font:inherit}</style></head>
<body><div class="banner" role="note">TEST PAYMENT SIMULATOR — no money moves</div><main>
<div class="card"><div>Availo booking</div><div class="amt">${esc(naira)}</div><div>Reference ${esc(t.reference)}</div><div>${esc(t.email)}</div></div>
<form method="post"><label for="channel">Pay with</label><select id="channel" name="channel"><option value="card">Card</option><option value="bank_transfer">Bank transfer</option><option value="ussd">USSD</option></select>
<button class="primary" name="action" value="pay" id="sim-pay">Pay ${esc(naira)}</button>
<button name="action" value="fail" id="sim-fail">Simulate a declined payment</button>
<button name="action" value="cancel" id="sim-cancel">Cancel and go back</button></form></main></body></html>`;
}
