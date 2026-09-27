/**
 * The SMS provider sits behind this interface from day one (handover §7 item 6).
 * Termii or Africa's Talking implement it later; delivery status is part of the
 * contract because US-059 depends on it.
 */
export interface SmsMessage { to: string; body: string; purpose: "otp" | "pass" | "warning" | "notice" }
export interface SmsResult { providerRef: string; status: "queued" | "sent" | "delivered" | "failed" }
export interface SmsSender { send(msg: SmsMessage): Promise<SmsResult> }

export const SMS_SENDER = Symbol("SMS_SENDER");

/** Development and test only. Keeps an outbox in memory; refused in production by loadConfig. */
export class DevSmsSender implements SmsSender {
  readonly outbox: Array<SmsMessage & { at: Date }> = [];
  constructor(private readonly log = false) {}
  async send(msg: SmsMessage): Promise<SmsResult> {
    this.outbox.push({ ...msg, at: new Date() });
    if (this.log) console.log(`[dev-sms] to ${msg.to}: ${msg.body}`);
    return { providerRef: `dev-${this.outbox.length}`, status: "delivered" };
  }
  lastTo(to: string): SmsMessage | undefined {
    return [...this.outbox].reverse().find((m) => m.to === to);
  }
}
