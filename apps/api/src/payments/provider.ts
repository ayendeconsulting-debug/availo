/**
 * The payment provider sits behind this interface (HLR §3.6): the provider is
 * replaceable and the ledger must not care which one took the money.
 *
 * The platform never sees card data (NFR-SEC-06). A payment is initialised here,
 * the driver pays on the provider's own hosted page, and the outcome is only ever
 * believed after a server-side verify (US-134) — never from the browser's return.
 */
export interface InitializeRequest {
  /** Ours. The provider echoes it on every verify and webhook; it is the idempotency key end to end. */
  readonly reference: string;
  readonly amountKobo: bigint;
  readonly email: string;
  /** Where the provider sends the driver's browser back to. Not trusted for the outcome. */
  readonly callbackUrl: string;
  readonly metadata: Record<string, string>;
}

export interface InitializeResult {
  readonly authorizationUrl: string;
  readonly accessCode: string;
}

export type VerifiedStatus = "success" | "failed" | "abandoned" | "pending" | "not_found";

export interface VerifyResult {
  readonly status: VerifiedStatus;
  readonly reference: string;
  readonly amountKobo: bigint | null;
  readonly currency: string | null;
  readonly providerTxnId: string | null;
  readonly channel: string | null;
  readonly feesKobo: bigint | null;
  readonly paidAt: Date | null;
  readonly gatewayResponse: string | null;
}

export interface RefundResult {
  readonly providerRefundRef: string;
  readonly status: "pending" | "processed" | "failed";
}

/** A webhook reduced to what the platform acts on. Nothing about the customer or the card survives this. */
export interface WebhookNotice {
  readonly event: string;
  readonly kind: "charge" | "refund" | "other";
  /** The payment reference (ours) the event concerns. */
  readonly reference: string | null;
  /** Identifies this event, so a repeat is recognised (US-017). */
  readonly dedupeKey: string;
  readonly summary: Record<string, unknown>;
}

export interface PaymentProvider {
  readonly name: string;
  initialize(req: InitializeRequest): Promise<InitializeResult>;
  verify(reference: string): Promise<VerifyResult>;
  refund(req: { providerTxnId: string; amountKobo: bigint; reason: string }): Promise<RefundResult>;
  /** Authenticates a webhook from its raw body and headers. Never parse an unauthenticated body. */
  authenticateWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
  parseWebhook(rawBody: Buffer): WebhookNotice;
}

export const PAYMENT_PROVIDER = Symbol("PAYMENT_PROVIDER");
