import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { normaliseNigerianMobile, normalisePlate } from "@availo/shared";
import { ApiError } from "../common/errors.js";
import { validate } from "../common/validate.js";
import { OtpService } from "../auth/otp.service.js";
import { PassService } from "../passes/pass.service.js";
import { AllowRevokedDevice, AttendantGuard, DEVICE_HEADER, Gate, type GateContext } from "./attendant.guard.js";
import { GateAuthService } from "./gate-auth.service.js";
import { GateSyncService } from "./gate-sync.service.js";

const GateEvent = z.object({
  id: z.uuid(),
  kind: z.enum(["entry", "exit"]),
  method: z.enum(["qr", "pin", "plate", "manual"]),
  passId: z.uuid().optional(),
  plate: z.string().max(20).optional(),
  reason: z.string().trim().min(3).max(500).optional(),
  deviceResult: z.string().min(1).max(40),
  plateConfirmed: z.boolean(),
  occurredAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
  recordedOffline: z.boolean(),
}).refine((e) => e.method !== "manual" || !!e.reason, { message: "A manual exception needs a reason.", path: ["reason"] });

@Controller("gate")
export class GateController {
  constructor(
    @Inject(GateAuthService) private readonly auth: GateAuthService,
    @Inject(OtpService) private readonly otp: OtpService,
    @Inject(PassService) private readonly passes: PassService,
    @Inject(GateSyncService) private readonly sync: GateSyncService,
  ) {}

  /** One-time: turns an administrator-issued code into this phone's device token. */
  @Post("devices/enrol")
  async enrol(@Body() body: unknown) {
    const { enrolmentCode } = validate(z.object({ enrolmentCode: z.string().min(10).max(20) }), body);
    return this.auth.enrol(enrolmentCode);
  }

  /** Attendant sign-in: OTP (requested via /auth/otp/request) on an enrolled device. */
  @Post("auth/verify")
  @HttpCode(HttpStatus.OK)
  async signIn(@Body() body: unknown, @Headers(DEVICE_HEADER) deviceToken?: string) {
    const input = validate(z.object({ mobile: z.string(), code: z.string() }), body);
    const m = normaliseNigerianMobile(input.mobile);
    if (!m.ok) throw new ApiError(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "Some fields need correcting.", { fields: [{ path: "mobile", message: "Enter a Nigerian mobile number." }] });
    const device = await this.auth.deviceFromToken(deviceToken);
    if (!device) throw new ApiError(HttpStatus.UNAUTHORIZED, "DEVICE_NOT_ENROLLED", "Enrol this phone as a gate device first.");
    await this.otp.verify(m.e164, input.code);
    return this.auth.signIn(m.e164, device);
  }

  /** NFR-OFF-01: every authorised pass for the next 24 hours, plus vehicles still on site. */
  @Get("cache")
  @UseGuards(AttendantGuard)
  async cache(@Gate() gate: GateContext) {
    return this.passes.gateCache(gate.lotId);
  }

  /** NFR-OFF-03: send queued records, oldest first. Safe to repeat. */
  @Post("events")
  @HttpCode(HttpStatus.OK)
  @UseGuards(AttendantGuard)
  @AllowRevokedDevice()
  async events(@Gate() gate: GateContext, @Body() body: unknown) {
    const { events } = validate(z.object({ events: z.array(GateEvent).min(1).max(500) }), body);
    const normalised = events.map((e) => ({ ...e, plate: e.plate ? (normalisePlate(e.plate)?.normalised ?? e.plate) : undefined }));
    const results = await this.sync.sync(gate, normalised);
    return { results, ...(gate.device.revoked ? { purge: true } : {}) };
  }
}
