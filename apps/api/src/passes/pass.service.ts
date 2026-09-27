import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt } from "node:crypto";
import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import type pg from "pg";
import { pinHash, publicKeyFor, signPass, toBase64Url, type GatePassEntry } from "@availo/pass";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { CLOCK, type Clock } from "../common/clock.js";
import { PG_POOL } from "../common/db.js";
import { ApiError } from "../common/errors.js";
import { SMS_SENDER, type SmsSender } from "../sms/sms.js";

/** The attendant device caches 24 hours of passes (NFR-OFF-01); PINs are unique across that horizon. */
export const CACHE_HORIZON_HOURS = 24;

interface PassRow {
  pass_id: string; reservation_id: string; reference: string; lot_id: string; lot_name: string; early_entry_minutes: number;
  s: Date; e: Date; plate: string; driver_name: string; pool_kind: string; status: string; user_id: string;
  signed_part: string; pin_ciphertext: string; pin_lookup: string; revoked_at: Date | null; on_site: boolean; exited: boolean; pool_kind_label?: string;
}

const PASS_SELECT = `
  SELECT ap.id AS pass_id, r.id AS reservation_id, r.reference, r.lot_id, l.name AS lot_name, l.early_entry_minutes,
         lower(r.time_window) AS s, upper(r.time_window) AS e, v.plate_normalised AS plate, u.display_name AS driver_name,
         cp.kind::text AS pool_kind, r.status::text AS status, r.user_id,
         ap.signed_part, ap.pin_ciphertext, ap.pin_lookup, ap.revoked_at,
         EXISTS (SELECT 1 FROM parking_session ps WHERE ps.reservation_id = r.id AND ps.state = 'active') AS on_site,
         EXISTS (SELECT 1 FROM parking_session ps WHERE ps.reservation_id = r.id AND ps.state = 'ended') AS exited
    FROM access_pass ap
    JOIN reservation r ON r.id = ap.reservation_id
    JOIN lot l ON l.id = r.lot_id
    JOIN vehicle v ON v.id = r.vehicle_id
    JOIN app_user u ON u.id = r.user_id
    JOIN capacity_pool cp ON cp.id = r.pool_id`;

@Injectable()
export class PassService {
  private readonly log = new Logger(PassService.name);
  private readonly pinPepper: Buffer;
  private readonly pinKey: Buffer;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
  ) {
    this.pinPepper = this.derive("pin-lookup");
    this.pinKey = this.derive("pin-encryption");
  }

  private derive(label: string, extra = ""): Buffer {
    return createHmac("sha256", this.config.passMasterKey).update(`${label}:${extra}`).digest();
  }

  /** The per-pass secret behind the rotating code. Derived, never stored. */
  totpSecret(passId: string): Uint8Array {
    return this.derive("totp", passId);
  }

  publicKeys(): Array<{ keyId: number; publicKey: string }> {
    return [{ keyId: this.config.passKeyId, publicKey: toBase64Url(publicKeyFor(this.config.passSigningKey)) }];
  }

  private pinLookup(lotId: string, pin: string): string {
    return createHmac("sha256", this.pinPepper).update(`${lotId}:${pin}`).digest("base64url");
  }

  private encryptPin(pin: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.pinKey, iv);
    const ct = Buffer.concat([c.update(pin, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
  }

  private decryptPin(blob: string): string {
    const b = Buffer.from(blob, "base64url");
    const d = createDecipheriv("aes-256-gcm", this.pinKey, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  }

  /**
   * US-033: issue the pass for a confirmed reservation. Idempotent — a second
   * call returns the pass already issued. The PIN is unique among every pass at
   * the lot that an attendant device could hold at the same time.
   */
  async issue(reservationId: string): Promise<{ passId: string; pin: string; created: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: [r] } = await client.query<{ lot_id: string; status: string }>(
        "SELECT lot_id, status::text FROM reservation WHERE id = $1", [reservationId]);
      if (!r || r.status !== "confirmed") throw new ApiError(HttpStatus.CONFLICT, "NOT_CONFIRMED", "A pass is issued only for a confirmed booking.");
      // Serialise PIN allocation per lot so two passes cannot draw the same PIN at once.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('pass-pin:' || $1))", [r.lot_id]);
      const { rows: [existing] } = await client.query<{ id: string; pin_ciphertext: string }>(
        "SELECT id, pin_ciphertext FROM access_pass WHERE reservation_id = $1", [reservationId]);
      if (existing) {
        await client.query("COMMIT");
        return { passId: existing.id, pin: this.decryptPin(existing.pin_ciphertext), created: false };
      }

      const horizon = new Date(this.clock.now().getTime() - CACHE_HORIZON_HOURS * 3_600_000);
      let pin = "";
      for (let attempt = 0; attempt < 50 && !pin; attempt++) {
        const candidate = String(randomInt(0, 1_000_000)).padStart(6, "0");
        const { rowCount } = await client.query(
          `SELECT 1 FROM access_pass ap JOIN reservation res ON res.id = ap.reservation_id
            WHERE ap.lot_id = $1 AND ap.pin_lookup = $2 AND ap.revoked_at IS NULL AND upper(res.time_window) > $3`,
          [r.lot_id, this.pinLookup(r.lot_id, candidate), horizon]);
        if (!rowCount) pin = candidate;
      }
      if (!pin) throw new Error("Could not allocate a unique PIN");

      const passId = (await client.query<{ id: string }>("SELECT gen_random_uuid() AS id")).rows[0]!.id;
      const { signedPart } = signPass({ passId, lotId: r.lot_id, keyId: this.config.passKeyId, privateKey: this.config.passSigningKey });
      await client.query(
        `INSERT INTO access_pass (id, reservation_id, lot_id, key_id, signed_part, pin_lookup, pin_ciphertext, issued_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [passId, reservationId, r.lot_id, this.config.passKeyId, signedPart, this.pinLookup(r.lot_id, pin), this.encryptPin(pin), this.clock.now()]);
      await client.query("COMMIT");
      return { passId, pin, created: true };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * US-033 by SMS, per the decision on pass copies: reference, window, plate,
   * PIN and a link to the live pass — never a QR, which would be static.
   * A failed send never fails the booking (NFR-AVL-04).
   */
  async sendCopy(reservationId: string): Promise<void> {
    try {
      const p = await this.load("r.id = $1", [reservationId]);
      if (!p) return;
      const { rows: [u] } = await this.pool.query<{ mobile_e164: string }>("SELECT mobile_e164 FROM app_user WHERE id = $1", [p.user_id]);
      const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
      const end = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit", hour12: false }).format(p.e);
      await this.sms.send({
        to: u!.mobile_e164,
        purpose: "pass",
        body: `Availo ${p.reference}: ${p.lot_name}, ${fmt.format(p.s)}–${end} WAT, ${p.plate}. Gate PIN ${this.decryptPin(p.pin_ciphertext)}. Pass: ${this.config.appBaseUrl}/passes/${p.reference}`,
      });
    } catch (err) {
      this.log.warn(`Pass SMS for reservation ${reservationId} failed: ${(err as Error).message}`);
    }
  }

  async ownsConfirmedReservation(userId: string, reservationId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "SELECT 1 FROM reservation WHERE id = $1 AND user_id = $2 AND status = 'confirmed'", [reservationId, userId]);
    return (rowCount ?? 0) > 0;
  }

  /** What the driver's app needs to show the pass and compute the rotating QR offline (NFR-OFF-06). */
  async driverView(userId: string, reservationId: string) {
    const p = await this.load("r.id = $1 AND r.user_id = $2", [reservationId, userId]);
    if (!p) return null;
    return {
      passId: p.pass_id,
      reference: p.reference,
      lot: { id: p.lot_id, name: p.lot_name },
      window: { start: p.s.toISOString(), end: p.e.toISOString() },
      earlyEntryMinutes: p.early_entry_minutes,
      plate: p.plate,
      driverName: p.driver_name,
      accessible: p.pool_kind === "accessible",
      pool: p.pool_kind,
      pin: this.decryptPin(p.pin_ciphertext),
      qr: { signedPart: p.signed_part, totpSecret: toBase64Url(this.totpSecret(p.pass_id)), stepSeconds: 30 },
      status: p.revoked_at ? "revoked" : p.status,
    };
  }

  /**
   * The authorised set an attendant device caches for a lot (NFR-OFF-01): every
   * pass whose window overlaps the next 24 hours. PIN hashes are salted fresh for
   * each cache so one device's cache cannot be matched against another's.
   */
  async gateCache(lotId: string): Promise<{ lotId: string; lotName: string; pinSalt: string; generatedAt: string; validUntil: string; publicKeys: Array<{ keyId: number; publicKey: string }>; passes: GatePassEntry[] }> {
    const now = this.clock.now();
    const until = new Date(now.getTime() + CACHE_HORIZON_HOURS * 3_600_000);
    const rows = await this.loadAll(
      `r.lot_id = $1 AND r.status IN ('confirmed', 'cancelled')
        AND ((upper(r.time_window) > $2 AND lower(r.time_window) < $3)
             OR EXISTS (SELECT 1 FROM parking_session ps WHERE ps.reservation_id = r.id AND ps.state = 'active'))`,
      [lotId, now, until]);
    const salt = randomBytes(16);
    const { rows: [lot] } = await this.pool.query<{ name: string }>("SELECT name FROM lot WHERE id = $1", [lotId]);
    return {
      lotId,
      lotName: lot?.name ?? "",
      pinSalt: toBase64Url(salt),
      generatedAt: now.toISOString(),
      // NFR-OFF-05: the device purges the cache at the end of its window.
      validUntil: until.toISOString(),
      publicKeys: this.publicKeys(),
      passes: rows.map((p) => ({
        passId: p.pass_id, lotId: p.lot_id, reference: p.reference, driverName: p.driver_name, plate: p.plate,
        start: p.s.toISOString(), end: p.e.toISOString(), earlyEntryMinutes: p.early_entry_minutes,
        accessible: p.pool_kind === "accessible",
        status: p.status === "confirmed" && !p.revoked_at ? "active" : "cancelled",
        totpSecret: toBase64Url(this.totpSecret(p.pass_id)),
        pinHash: pinHash(salt, p.lot_id, this.decryptPin(p.pin_ciphertext)),
        onSite: p.on_site,
        exited: p.exited,
      })),
    };
  }

  private async load(where: string, params: unknown[]): Promise<PassRow | undefined> {
    return (await this.loadAll(where, params))[0];
  }

  private async loadAll(where: string, params: unknown[]): Promise<PassRow[]> {
    return (await this.pool.query<PassRow>(`${PASS_SELECT} WHERE ${where}`, params)).rows;
  }
}
