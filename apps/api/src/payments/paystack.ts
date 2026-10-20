import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  InitializeRequest, InitializeResult, PaymentProvider, RefundResult, VerifiedStatus, VerifyResult, WebhookNotice,
} from "./provider.js";

/**
 * Paystack (https://paystack.com/docs/api). Card, bank transfer and USSD on
 * Paystack's hosted checkout, so no card data reaches the platform (NFR-SEC-06).
 *
 * - Amounts are integer kobo both sides.
 * - Webhooks carry `x-paystack-signature`: HMAC-SHA512 of the raw body, keyed
 *   with the secret key. Checked in constant time before the body is parsed.
 * - Every outcome is confirmed by GET /transaction/verify/:reference.
 *
 * `baseUrl` points at the real API, or at the local simulator that speaks the
 * same protocol, so the same code is what the tests exercise.
 */
export class PaystackProvider implements PaymentProvider {
  readonly name = "paystack";

  constructor(
    private readonly secretKey: string,
    private readonly baseUrl = "https://api.paystack.co",
    private readonly timeoutMs = 15_000,
  ) {
    if (!secretKey) throw new Error("A Paystack secret key is required");
  }

  async initialize(req: InitializeRequest): Promise<InitializeResult> {
    const body = await this.call("POST", "/transaction/initialize", {
      email: req.email,
      amount: req.amountKobo.toString(),
      currency: "NGN",
      reference: req.reference,
      callback_url: req.callbackUrl,
      channels: ["card", "bank_transfer", "ussd", "bank"],
      metadata: req.metadata,
    });
    const d = body.data as { authorization_url?: string; access_code?: string } | undefined;
    if (!d?.authorization_url || !d.access_code) throw new Error("Paystack initialize returned no authorization URL");
    return { authorizationUrl: d.authorization_url, accessCode: d.access_code };
  }

  async verify(reference: string): Promise<VerifyResult> {
    const res = await this.raw("GET", `/transaction/verify/${encodeURIComponent(reference)}`);
    const body = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: Record<string, unknown> };
    if (res.status === 404 || (res.status === 400 && /not found/i.test(body.message ?? ""))) {
      return { status: "not_found", reference, amountKobo: null, currency: null, providerTxnId: null, channel: null, feesKobo: null, paidAt: null, gatewayResponse: body.message ?? null };
    }
    if (!res.ok || !body.status || !body.data) throw new Error(`Paystack verify failed: HTTP ${res.status} ${body.message ?? ""}`.trim());
    const d = body.data;
    return {
      status: mapStatus(String(d.status ?? "")),
      reference: String(d.reference ?? reference),
      amountKobo: d.amount != null ? BigInt(String(d.amount)) : null,
      currency: d.currency != null ? String(d.currency) : null,
      providerTxnId: d.id != null ? String(d.id) : null,
      channel: d.channel != null ? String(d.channel) : null,
      feesKobo: d.fees != null ? BigInt(String(d.fees)) : null,
      paidAt: d.paid_at ? new Date(String(d.paid_at)) : null,
      gatewayResponse: d.gateway_response != null ? String(d.gateway_response) : null,
    };
  }

  async refund(req: { providerTxnId: string; amountKobo: bigint; reason: string }): Promise<RefundResult> {
    const body = await this.call("POST", "/refund", {
      transaction: req.providerTxnId,
      amount: req.amountKobo.toString(),
      merchant_note: req.reason.slice(0, 200),
    });
    const d = (body.data ?? {}) as { id?: unknown; status?: unknown };
    const s = String(d.status ?? "pending");
    return { providerRefundRef: String(d.id ?? ""), status: s === "processed" ? "processed" : s === "failed" ? "failed" : "pending" };
  }

  authenticateWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    const sig = headers["x-paystack-signature"];
    if (typeof sig !== "string" || !/^[0-9a-f]{128}$/i.test(sig)) return false;
    const expected = createHmac("sha512", this.secretKey).update(rawBody).digest();
    return timingSafeEqual(expected, Buffer.from(sig, "hex"));
  }

  parseWebhook(rawBody: Buffer): WebhookNotice {
    const body = JSON.parse(rawBody.toString("utf8")) as { event?: string; data?: Record<string, unknown> };
    const event = String(body.event ?? "unknown");
    const d = body.data ?? {};
    if (event.startsWith("charge.")) {
      const reference = d.reference != null ? String(d.reference) : null;
      return {
        event, kind: "charge", reference,
        dedupeKey: `${event}:${String(d.id ?? reference ?? sha(rawBody))}`,
        summary: { id: d.id ?? null, reference, status: d.status ?? null, amount: d.amount ?? null, currency: d.currency ?? null, channel: d.channel ?? null, paid_at: d.paid_at ?? null },
      };
    }
    if (event.startsWith("refund.")) {
      const txn = (d.transaction ?? {}) as Record<string, unknown>;
      const reference = d.transaction_reference != null ? String(d.transaction_reference) : txn.reference != null ? String(txn.reference) : null;
      const refundId = String(d.id ?? d.refund_reference ?? sha(rawBody));
      return {
        event, kind: "refund", reference,
        dedupeKey: `${event}:${refundId}`,
        summary: { refund: refundId, reference, status: d.status ?? null, amount: d.amount ?? null, currency: d.currency ?? null },
      };
    }
    return { event, kind: "other", reference: null, dedupeKey: `${event}:${sha(rawBody)}`, summary: {} };
  }

  private async call(method: string, path: string, json?: unknown): Promise<{ status?: boolean; message?: string; data?: unknown }> {
    const res = await this.raw(method, path, json);
    const body = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: unknown };
    if (!res.ok || body.status === false) throw new Error(`Paystack ${method} ${path} failed: HTTP ${res.status} ${body.message ?? ""}`.trim());
    return body;
  }

  private raw(method: string, path: string, json?: unknown): Promise<Response> {
    return fetch(this.baseUrl.replace(/\/$/, "") + path, {
      method,
      headers: { Authorization: `Bearer ${this.secretKey}`, ...(json !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}

/** Paystack's transaction statuses, reduced to the outcomes the platform acts on. */
function mapStatus(s: string): VerifiedStatus {
  switch (s) {
    case "success": return "success";
    case "failed": return "failed";
    case "abandoned": return "abandoned";
    case "reversed": return "failed";
    default: return "pending"; // ongoing, pending, processing, queued
  }
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 32);

/** Signs a body the way Paystack does. Used by the simulator and by tests. */
export function paystackSignature(secretKey: string, rawBody: string | Buffer): string {
  return createHmac("sha512", secretKey).update(rawBody).digest("hex");
}
