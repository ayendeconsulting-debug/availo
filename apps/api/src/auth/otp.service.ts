import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type pg from "pg";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { CLOCK, type Clock } from "../common/clock.js";
import { PG_POOL } from "../common/db.js";
import { ApiError } from "../common/errors.js";
import { SMS_SENDER, type SmsSender } from "../sms/sms.js";

/** US-001 limits. */
export const OTP_TTL_SECONDS = 5 * 60;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_SECONDS = 60;

@Injectable()
export class OtpService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private hash(challengeId: string, code: string): string {
    return createHmac("sha256", this.config.otpPepper).update(`${challengeId}:${code}`).digest("hex");
  }

  /** Issues a code. The response never reveals whether the number already has an account. */
  async request(mobileE164: string): Promise<{ expiresInSeconds: number; resendAfterSeconds: number }> {
    const now = this.clock.now();
    const { rows: [last] } = await this.pool.query<{ created_at: Date }>(
      "SELECT created_at FROM otp_challenge WHERE mobile_e164 = $1 ORDER BY created_at DESC LIMIT 1",
      [mobileE164],
    );
    if (last) {
      const wait = OTP_RESEND_SECONDS - Math.floor((now.getTime() - last.created_at.getTime()) / 1000);
      if (wait > 0) {
        throw new ApiError(HttpStatus.TOO_MANY_REQUESTS, "OTP_RESEND_TOO_SOON", `You can request another code in ${wait} seconds.`, { retryAfterSeconds: wait });
      }
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // A new code supersedes any earlier one for this number.
      await client.query("UPDATE otp_challenge SET consumed_at = $2 WHERE mobile_e164 = $1 AND consumed_at IS NULL", [mobileE164, now]);
      const { rows: [c] } = await client.query<{ id: string }>(
        "INSERT INTO otp_challenge (mobile_e164, code_hash, expires_at, created_at) VALUES ($1, '', $2, $3) RETURNING id",
        [mobileE164, new Date(now.getTime() + OTP_TTL_SECONDS * 1000), now],
      );
      await client.query("UPDATE otp_challenge SET code_hash = $2 WHERE id = $1", [c!.id, this.hash(c!.id, code)]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    await this.sms.send({ to: mobileE164, purpose: "otp", body: `Your Availo code is ${code}. It expires in 5 minutes. Never share it.` });
    return { expiresInSeconds: OTP_TTL_SECONDS, resendAfterSeconds: OTP_RESEND_SECONDS };
  }

  /** Checks a code. Throws on any failure; returns normally only for a correct, live, unconsumed code. */
  async verify(mobileE164: string, code: string): Promise<void> {
    const now = this.clock.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: [c] } = await client.query<{ id: string; code_hash: string; expires_at: Date; attempts: number }>(
        `SELECT id, code_hash, expires_at, attempts FROM otp_challenge
          WHERE mobile_e164 = $1 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [mobileE164],
      );
      if (!c || c.expires_at <= now) {
        await client.query("COMMIT");
        throw new ApiError(HttpStatus.UNAUTHORIZED, "OTP_EXPIRED", "That code has expired. Request a new one.");
      }
      if (c.attempts >= OTP_MAX_ATTEMPTS) {
        await client.query("COMMIT");
        throw new ApiError(HttpStatus.TOO_MANY_REQUESTS, "OTP_LOCKED", "Too many incorrect attempts. Request a new code.");
      }
      const expected = Buffer.from(c.code_hash, "hex");
      const actual = Buffer.from(this.hash(c.id, code), "hex");
      if (!/^\d{6}$/.test(code) || !timingSafeEqual(expected, actual)) {
        await client.query("UPDATE otp_challenge SET attempts = attempts + 1 WHERE id = $1", [c.id]);
        await client.query("COMMIT");
        const remaining = OTP_MAX_ATTEMPTS - c.attempts - 1;
        throw remaining > 0
          ? new ApiError(HttpStatus.UNAUTHORIZED, "OTP_INCORRECT", "That code is not correct.", { attemptsRemaining: remaining })
          : new ApiError(HttpStatus.TOO_MANY_REQUESTS, "OTP_LOCKED", "Too many incorrect attempts. Request a new code.");
      }
      await client.query("UPDATE otp_challenge SET consumed_at = $2 WHERE id = $1", [c.id, now]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
