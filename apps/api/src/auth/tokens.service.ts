import { createHash, randomBytes, randomUUID } from "node:crypto";
import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { SignJWT, jwtVerify } from "jose";
import type pg from "pg";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { CLOCK, type Clock } from "../common/clock.js";
import { PG_POOL } from "../common/db.js";
import { ApiError } from "../common/errors.js";

export interface AccessClaims { userId: string; userType: string }
export interface TokenPair { accessToken: string; refreshToken: string; expiresIn: number }

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

@Injectable()
export class TokensService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async issue(user: { id: string; userType: string }, familyId: string = randomUUID()): Promise<TokenPair> {
    const now = this.clock.now();
    const accessToken = await new SignJWT({ typ: "access", ut: user.userType })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.id)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(now.getTime() / 1000) + this.config.accessTokenTtlSeconds)
      .sign(this.config.jwtSecret);
    const refreshToken = randomBytes(32).toString("base64url");
    await this.pool.query(
      "INSERT INTO refresh_token (user_id, family_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)",
      [user.id, familyId, sha256(refreshToken), new Date(now.getTime() + this.config.refreshTokenTtlSeconds * 1000)],
    );
    return { accessToken, refreshToken, expiresIn: this.config.accessTokenTtlSeconds };
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.config.jwtSecret, {
        algorithms: ["HS256"],
        currentDate: this.clock.now(),
      });
      if (payload.typ !== "access" || typeof payload.sub !== "string") throw new Error("wrong token type");
      return { userId: payload.sub, userType: String(payload.ut) };
    } catch {
      throw new ApiError(HttpStatus.UNAUTHORIZED, "UNAUTHENTICATED", "Sign in again to continue.");
    }
  }

  /**
   * Rotates a refresh token. Using a token that was already rotated means it has
   * leaked: the whole family is revoked and the driver must sign in again.
   */
  async rotate(refreshToken: string): Promise<TokenPair> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: [row] } = await client.query<{ id: string; user_id: string; family_id: string; expires_at: Date; rotated_at: Date | null; revoked_at: Date | null; user_type: string; verification_state: string }>(
        `SELECT t.id, t.user_id, t.family_id, t.expires_at, t.rotated_at, t.revoked_at, u.user_type, u.verification_state
           FROM refresh_token t JOIN app_user u ON u.id = t.user_id
          WHERE t.token_hash = $1 FOR UPDATE OF t`,
        [sha256(refreshToken)],
      );
      const now = this.clock.now();
      if (!row || row.revoked_at || row.expires_at <= now || row.verification_state === "suspended") {
        await client.query("ROLLBACK");
        throw new ApiError(HttpStatus.UNAUTHORIZED, "UNAUTHENTICATED", "Sign in again to continue.");
      }
      if (row.rotated_at) {
        await client.query("UPDATE refresh_token SET revoked_at = $2 WHERE family_id = $1 AND revoked_at IS NULL", [row.family_id, now]);
        await client.query("COMMIT");
        throw new ApiError(HttpStatus.UNAUTHORIZED, "SESSION_REVOKED", "This session was ended for your security. Sign in again.");
      }
      await client.query("UPDATE refresh_token SET rotated_at = $2 WHERE id = $1", [row.id, now]);
      await client.query("COMMIT");
      return this.issue({ id: row.user_id, userType: row.user_type }, row.family_id);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** A short-lived proof that this mobile number passed OTP, used to finish registration. */
  async issueRegistrationToken(mobileE164: string): Promise<string> {
    const now = Math.floor(this.clock.now().getTime() / 1000);
    return new SignJWT({ typ: "registration" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(mobileE164)
      .setIssuedAt(now)
      .setExpirationTime(now + this.config.registrationTokenTtlSeconds)
      .sign(this.config.jwtSecret);
  }

  async verifyRegistrationToken(token: string): Promise<string> {
    try {
      const { payload } = await jwtVerify(token, this.config.jwtSecret, { algorithms: ["HS256"], currentDate: this.clock.now() });
      if (payload.typ !== "registration" || typeof payload.sub !== "string") throw new Error("wrong token type");
      return payload.sub;
    } catch {
      throw new ApiError(HttpStatus.UNAUTHORIZED, "REGISTRATION_EXPIRED", "Verify your mobile number again to finish registering.");
    }
  }
}
