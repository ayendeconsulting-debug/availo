import { type CanActivate, type ExecutionContext, HttpStatus, Inject, Injectable, SetMetadata, createParamDecorator } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiError } from "../common/errors.js";
import { GateAuthService, type AttendantClaims, type DeviceRecord } from "./gate-auth.service.js";

export const DEVICE_HEADER = "x-gate-device";
export interface GateContext extends AttendantClaims { device: DeviceRecord }

/** Routes a revoked device may still call, so records it made before revocation are not lost (NFR-OFF-04). */
export const AllowRevokedDevice = () => SetMetadata("allowRevokedDevice", true);

/**
 * Every gate call carries both an attendant token and the device token, and the
 * two must agree: the attendant signed in on this device, for this lot (US-055).
 */
@Injectable()
export class AttendantGuard implements CanActivate {
  constructor(
    @Inject(GateAuthService) private readonly auth: GateAuthService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; gate?: GateContext }>();
    const header = req.headers.authorization ?? "";
    const claims = await this.auth.verifyAttendantToken(header.startsWith("Bearer ") ? header.slice(7) : "");
    const device = await this.auth.deviceFromToken(req.headers[DEVICE_HEADER]);
    if (!device || device.id !== claims.deviceId || device.lotId !== claims.lotId) {
      throw new ApiError(HttpStatus.UNAUTHORIZED, "DEVICE_MISMATCH", "This session belongs to a different device.");
    }
    if (device.revoked && !this.reflector.get<boolean>("allowRevokedDevice", ctx.getHandler())) {
      throw new ApiError(HttpStatus.FORBIDDEN, "DEVICE_REVOKED", "This device is no longer authorised. Its gate data has been removed.", { purge: true });
    }
    req.gate = { ...claims, device };
    return true;
  }
}

export const Gate = createParamDecorator((_: unknown, ctx: ExecutionContext): GateContext =>
  ctx.switchToHttp().getRequest<{ gate: GateContext }>().gate);
