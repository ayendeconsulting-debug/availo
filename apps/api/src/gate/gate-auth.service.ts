import { createHash, randomBytes, randomInt } from "node:crypto";
import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { SignJWT, jwtVerify } from "jose";
import type pg from "pg";
import { normaliseNigerianMobile } from "@availo/shared";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { CLOCK, type Clock } from "../common/clock.js";
import { PG_POOL } from "../common/db.js";
import { ApiError } from "../common/errors.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** An attendant's working session. Long enough for a shift; gate verification itself never needs it (NFR-AVL-02). */
export const ATTENDANT_TOKEN_TTL_SECONDS = 12 * 3600;
export const ENROLMENT_CODE_TTL_SECONDS = 24 * 3600;

export interface AttendantClaims { attendantId: string; deviceId: string; lotId: string }
export interface DeviceRecord { id: string; lotId: string; revoked: boolean }

@Injectable()
export class GateAuthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ——— Administration (console arrives in sprint 6; a CLI calls these until then) ———

  async createAttendant(input: { mobile: string; name: string; lotId: string; createdBy: string }): Promise<string> {
    const m = normaliseNigerianMobile(input.mobile);
    if (!m.ok) throw new Error("Not a Nigerian mobile number");
    const { rows: [r] } = await this.pool.query<{ id: string }>(
      `INSERT INTO staff_account (mobile_e164, display_name, role, lot_id, created_by) VALUES ($1, $2, 'attendant', $3, $4) RETURNING id`,
      [m.e164, input.name, input.lotId, input.createdBy]);
    return r!.id;
  }

  /** Creates a device slot and its one-time enrolment code, shown once to the administrator. */
  async createDevice(input: { lotId: string; label: string; createdBy: string }): Promise<{ deviceId: string; enrolmentCode: string }> {
    const code = Array.from({ length: 10 }, () => CROCKFORD[randomInt(0, 32)]).join("");
    const { rows: [r] } = await this.pool.query<{ id: string }>(
      `INSERT INTO gate_device (lot_id, label, enrolment_code_hash, enrolment_expires_at, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.lotId, input.label, sha256(code), new Date(this.clock.now().getTime() + ENROLMENT_CODE_TTL_SECONDS * 1000), input.createdBy]);
    return { deviceId: r!.id, enrolmentCode: code.replace(/(.{5})/, "$1-") };
  }

  /** US-055: revocation stops sync and makes the device purge its cache on next contact. */
  async revokeDevice(deviceId: string, reason: string): Promise<void> {
    await this.pool.query("UPDATE gate_device SET revoked_at = $2, revoked_reason = $3 WHERE id = $1 AND revoked_at IS NULL",
      [deviceId, this.clock.now(), reason]);
  }

  // ——— Device side ———

  /** Exchanges a one-time enrolment code for a long-lived device token. The code cannot be used twice. */
  async enrol(code: string): Promise<{ deviceId: string; deviceToken: string; lotId: string }> {
    const normalised = code.toUpperCase().replace(/[^0-9A-Z]/g, "");
    const token = randomBytes(32).toString("base64url");
    const { rows: [d] } = await this.pool.query<{ id: string; lot_id: string }>(
      `UPDATE gate_device SET token_hash = $2, enrolled_at = $3, enrolment_code_hash = NULL
        WHERE enrolment_code_hash = $1 AND enrolment_expires_at > $3 AND revoked_at IS NULL AND token_hash IS NULL
        RETURNING id, lot_id`,
      [sha256(normalised), sha256(token), this.clock.now()]);
    if (!d) throw new ApiError(HttpStatus.UNAUTHORIZED, "ENROLMENT_INVALID", "That enrolment code is not valid. Ask the operations team for a new one.");
    return { deviceId: d.id, deviceToken: token, lotId: d.lot_id };
  }

  async deviceFromToken(token: string | undefined): Promise<DeviceRecord | null> {
    if (!token) return null;
    const { rows: [d] } = await this.pool.query<{ id: string; lot_id: string; revoked_at: Date | null }>(
      "SELECT id, lot_id, revoked_at FROM gate_device WHERE token_hash = $1", [sha256(token)]);
    return d ? { id: d.id, lotId: d.lot_id, revoked: d.revoked_at !== null } : null;
  }

  /** After OTP: an active attendant for this device's lot, on an enrolled, unrevoked device. */
  async signIn(mobileE164: string, device: DeviceRecord): Promise<{ accessToken: string; expiresIn: number; attendant: { id: string; name: string }; lotId: string }> {
    if (device.revoked) throw new ApiError(HttpStatus.FORBIDDEN, "DEVICE_REVOKED", "This device is no longer authorised. Its gate data has been removed.");
    const { rows: [a] } = await this.pool.query<{ id: string; display_name: string; lot_id: string }>(
      "SELECT id, display_name, lot_id FROM staff_account WHERE mobile_e164 = $1 AND role = 'attendant' AND active", [mobileE164]);
    if (!a || a.lot_id !== device.lotId) {
      throw new ApiError(HttpStatus.FORBIDDEN, "NOT_AN_ATTENDANT_HERE", "This number is not an attendant for this device's lot.");
    }
    const now = Math.floor(this.clock.now().getTime() / 1000);
    const accessToken = await new SignJWT({ typ: "attendant", did: device.id, lot: device.lotId })
      .setProtectedHeader({ alg: "HS256" }).setSubject(a.id).setIssuedAt(now).setExpirationTime(now + ATTENDANT_TOKEN_TTL_SECONDS)
      .sign(this.config.jwtSecret);
    return { accessToken, expiresIn: ATTENDANT_TOKEN_TTL_SECONDS, attendant: { id: a.id, name: a.display_name }, lotId: device.lotId };
  }

  async verifyAttendantToken(token: string): Promise<AttendantClaims> {
    try {
      const { payload } = await jwtVerify(token, this.config.jwtSecret, { algorithms: ["HS256"], currentDate: this.clock.now() });
      if (payload.typ !== "attendant" || typeof payload.sub !== "string") throw new Error("wrong type");
      return { attendantId: payload.sub, deviceId: String(payload.did), lotId: String(payload.lot) };
    } catch {
      throw new ApiError(HttpStatus.UNAUTHORIZED, "UNAUTHENTICATED", "Sign in again to sync. Gate checks keep working offline.");
    }
  }
}
