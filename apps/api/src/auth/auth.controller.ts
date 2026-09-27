import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from "@nestjs/common";
import type pg from "pg";
import { z } from "zod";
import { normaliseNigerianMobile } from "@availo/shared";
import { PG_POOL } from "../common/db.js";
import { ApiError } from "../common/errors.js";
import { validate } from "../common/validate.js";
import { OtpService } from "./otp.service.js";
import { TokensService } from "./tokens.service.js";

const Mobile = z.string().transform((s, ctx) => {
  const r = normaliseNigerianMobile(s);
  if (!r.ok) {
    ctx.addIssue({ code: "custom", message: "Enter a Nigerian mobile number, e.g. 0803 123 4567 or +234 803 123 4567." });
    return z.NEVER;
  }
  return r.e164;
});

@Controller("auth")
export class AuthController {
  constructor(
    @Inject(OtpService) private readonly otp: OtpService,
    @Inject(TokensService) private readonly tokens: TokensService,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
  ) {}

  /** US-001. Unauthenticated by necessity; throttled per number (NFR-SEC-08). */
  @Post("otp/request")
  @HttpCode(HttpStatus.ACCEPTED)
  async requestOtp(@Body() body: unknown) {
    const { mobile } = validate(z.object({ mobile: Mobile }), body);
    return this.otp.request(mobile);
  }

  /** Signs an existing driver in, or returns a registration token for a new number. */
  @Post("otp/verify")
  @HttpCode(HttpStatus.OK)
  async verifyOtp(@Body() body: unknown) {
    const { mobile, code } = validate(z.object({ mobile: Mobile, code: z.string() }), body);
    await this.otp.verify(mobile, code);
    const { rows: [user] } = await this.pool.query<{ id: string; user_type: string; verification_state: string }>(
      "SELECT id, user_type, verification_state FROM app_user WHERE mobile_e164 = $1", [mobile]);
    if (!user) {
      return { status: "registration_required", registrationToken: await this.tokens.issueRegistrationToken(mobile) };
    }
    if (user.verification_state === "suspended") {
      throw new ApiError(HttpStatus.FORBIDDEN, "ACCOUNT_SUSPENDED", "This account is suspended. Contact the operations team.");
    }
    return { status: "signed_in", ...(await this.tokens.issue({ id: user.id, userType: user.user_type })) };
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() body: unknown) {
    const { refreshToken } = validate(z.object({ refreshToken: z.string().min(1) }), body);
    return this.tokens.rotate(refreshToken);
  }
}
