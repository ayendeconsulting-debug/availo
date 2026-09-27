import { Body, Controller, Get, HttpStatus, Inject, Post, UseGuards } from "@nestjs/common";
import type pg from "pg";
import { z } from "zod";
import { normalisePlate } from "@availo/shared";
import { PG_POOL } from "../common/db.js";
import { ApiError } from "../common/errors.js";
import { validate } from "../common/validate.js";
import { AuthGuard, CurrentUser } from "../auth/auth.guard.js";
import type { AccessClaims } from "../auth/tokens.service.js";
import { TokensService } from "../auth/tokens.service.js";

const RegisterBody = z.object({
  registrationToken: z.string().min(1),
  name: z.string().trim().min(2, "Enter your name as it should appear on your pass.").max(80),
  userType: z.string().min(1),
  campusIdentifier: z.string().trim().max(40).optional(),
  email: z.email("Enter a valid email address.").optional(),
  vehicle: z.object({ plate: z.string().min(1, "Enter your vehicle's registration number.") }),
});

interface Rule { user_type: string; requires_campus_identifier: boolean; identifier_label: string | null; identifier_pattern: string | null; wallet_enabled: boolean }

@Controller()
export class RegistrationController {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(TokensService) private readonly tokens: TokensService,
  ) {}

  /** US-002: the user types on offer come from configuration. */
  @Get("user-types")
  async userTypes() {
    const { rows } = await this.pool.query<Rule & { label: string }>(
      "SELECT user_type, label, requires_campus_identifier, identifier_label FROM user_type_rule WHERE active ORDER BY user_type");
    return rows.map((r) => ({ userType: r.user_type, label: r.label, requiresCampusIdentifier: r.requires_campus_identifier, identifierLabel: r.identifier_label }));
  }

  /**
   * US-001, US-002, US-003, US-005, US-006, US-131. Self-serve for every user type.
   * Automated checks run here; no administrator stands between registering and
   * booking. Accessible-eligibility claims (US-046) and risk rules (US-136) arrive
   * in later sprints and are the only things that will raise a review.
   */
  @Post("registrations")
  async register(@Body() body: unknown) {
    const input = validate(RegisterBody, body);
    const mobile = await this.tokens.verifyRegistrationToken(input.registrationToken);

    const { rows: [rule] } = await this.pool.query<Rule>("SELECT * FROM user_type_rule WHERE user_type::text = $1 AND active", [input.userType]);
    if (!rule) throw new ApiError(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "Some fields need correcting.", { fields: [{ path: "userType", message: "Choose Staff, Student or Guest." }] });

    let campusIdentifier: string | null = null;
    if (rule.requires_campus_identifier) {
      const id = input.campusIdentifier ?? "";
      if (!id || (rule.identifier_pattern && !new RegExp(rule.identifier_pattern).test(id))) {
        throw new ApiError(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "Some fields need correcting.", {
          fields: [{ path: "campusIdentifier", message: `Enter your ${rule.identifier_label?.toLowerCase() ?? "campus identifier"} as it appears on your ID card.` }],
        });
      }
      campusIdentifier = id.toUpperCase();
    }

    const plate = normalisePlate(input.vehicle.plate);
    if (!plate) {
      throw new ApiError(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "Some fields need correcting.", { fields: [{ path: "vehicle.plate", message: "Enter the registration number shown on the plate." }] });
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const conflict = async (sql: string, params: unknown[]) => ((await client.query(sql, params)).rowCount ?? 0) > 0;
      if (await conflict("SELECT 1 FROM app_user WHERE mobile_e164 = $1", [mobile])) {
        throw new ApiError(HttpStatus.CONFLICT, "MOBILE_IN_USE", "This number already has an account. Sign in instead.");
      }
      if (campusIdentifier && await conflict("SELECT 1 FROM app_user WHERE campus_identifier = $1 AND verification_state <> 'suspended'", [campusIdentifier])) {
        throw new ApiError(HttpStatus.CONFLICT, "IDENTIFIER_IN_USE", `This ${rule.identifier_label?.toLowerCase()} is already registered to another account. If it is yours, recover that account instead.`, { recovery: "/auth/otp/request" });
      }
      if (await conflict("SELECT 1 FROM vehicle WHERE plate_normalised = $1 AND active", [plate.normalised])) {
        throw new ApiError(HttpStatus.CONFLICT, "PLATE_IN_USE", "This plate is registered to another account. Contact the operations team if it is yours.");
      }
      const { rows: [user] } = await client.query<{ id: string }>(
        `INSERT INTO app_user (mobile_e164, display_name, user_type, campus_identifier, email, verification_state, verified_at, verified_by)
         VALUES ($1, $2, $3, $4, $5, 'verified', now(), 'rule:registration-automatic') RETURNING id`,
        [mobile, input.name, rule.user_type, campusIdentifier, input.email ?? null]);
      const { rows: [vehicle] } = await client.query<{ id: string }>(
        "INSERT INTO vehicle (user_id, plate_display, plate_normalised, plate_warning) VALUES ($1, $2, $3, $4) RETURNING id",
        [user!.id, input.vehicle.plate.trim().toUpperCase(), plate.normalised, plate.warning ?? null]);
      await client.query("COMMIT");
      const tokens = await this.tokens.issue({ id: user!.id, userType: rule.user_type });
      return {
        user: { id: user!.id, userType: rule.user_type, verificationState: "verified" },
        vehicle: { id: vehicle!.id, plate: plate.normalised, ...(plate.warning ? { warning: plate.warning } : {}) },
        ...tokens,
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      // A simultaneous registration won the race for the same number, identifier or plate.
      if ((err as { code?: string }).code === "23505") {
        throw new ApiError(HttpStatus.CONFLICT, "ALREADY_REGISTERED", "These details were registered a moment ago. Sign in, or contact the operations team.");
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /** US-005: the driver sees their own verification state; US-019: the wallet balance is always visible. */
  @Get("me")
  @UseGuards(AuthGuard)
  async me(@CurrentUser() auth: AccessClaims) {
    const { rows: [u] } = await this.pool.query<{ id: string; display_name: string; user_type: string; verification_state: string; wallet_enabled: boolean }>(
      `SELECT u.id, u.display_name, u.user_type, u.verification_state, r.wallet_enabled
         FROM app_user u JOIN user_type_rule r ON r.user_type = u.user_type WHERE u.id = $1`, [auth.userId]);
    if (!u) throw new ApiError(HttpStatus.UNAUTHORIZED, "UNAUTHENTICATED", "Sign in again to continue.");
    const { rows: vehicles } = await this.pool.query<{ id: string; plate_normalised: string }>(
      "SELECT id, plate_normalised FROM vehicle WHERE user_id = $1 AND active ORDER BY created_at", [u.id]);
    let walletBalanceKobo: string | null = null;
    if (u.wallet_enabled) {
      const { rows: [b] } = await this.pool.query<{ b: string }>("SELECT COALESCE(sum(amount_kobo),0)::text AS b FROM wallet_entry WHERE user_id = $1", [u.id]);
      walletBalanceKobo = b!.b;
    }
    return {
      id: u.id, name: u.display_name, userType: u.user_type, verificationState: u.verification_state,
      vehicles: vehicles.map((v) => ({ id: v.id, plate: v.plate_normalised })),
      walletBalanceKobo,
    };
  }
}
