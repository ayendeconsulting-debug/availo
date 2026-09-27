import { Controller, Get, HttpStatus, Inject, Param, ParseUUIDPipe, UseGuards } from "@nestjs/common";
import { AuthGuard, CurrentUser } from "../auth/auth.guard.js";
import type { AccessClaims } from "../auth/tokens.service.js";
import { ApiError } from "../common/errors.js";
import { PassService } from "./pass.service.js";

@Controller()
export class PassesController {
  constructor(@Inject(PassService) private readonly passes: PassService) {}

  /** Public verification keys. Gate devices pin these; a key rotation adds a new key id. */
  @Get("pass-keys")
  keys() {
    return { keys: this.passes.publicKeys() };
  }

  /** US-033, US-035: the pass, with what the app needs to render it offline. */
  @Get("reservations/:id/pass")
  @UseGuards(AuthGuard)
  async pass(@CurrentUser() auth: AccessClaims, @Param("id", ParseUUIDPipe) id: string) {
    let view = await this.passes.driverView(auth.userId, id);
    if (!view && (await this.passes.ownsConfirmedReservation(auth.userId, id))) {
      // Issue lazily if issue at confirmation did not complete; issue() is idempotent.
      await this.passes.issue(id);
      view = await this.passes.driverView(auth.userId, id);
    }
    if (!view) throw new ApiError(HttpStatus.NOT_FOUND, "NOT_FOUND", "No pass for that booking on your account.");
    return view;
  }
}
