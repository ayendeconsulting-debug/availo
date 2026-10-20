import { HttpStatus } from "@nestjs/common";
import type { RejectReason } from "@availo/engine";
import { ApiError } from "./errors.js";

/** Each engine refusal maps to one status and one plain-language message (NFR-ACC-07). */
export const REJECTIONS: Record<RejectReason, [HttpStatus, string]> = {
  USER_NOT_FOUND: [HttpStatus.UNAUTHORIZED, "Sign in again to continue."],
  USER_NOT_BOOKABLE: [HttpStatus.FORBIDDEN, "This account cannot make bookings right now. Contact the operations team."],
  VEHICLE_NOT_REGISTERED: [HttpStatus.UNPROCESSABLE_ENTITY, "Choose one of the vehicles registered to your account."],
  WALLET_PATH_NOT_AVAILABLE: [HttpStatus.UNPROCESSABLE_ENTITY, "Your bookings are paid at checkout, not from a wallet."],
  CHECKOUT_PATH_NOT_AVAILABLE: [HttpStatus.UNPROCESSABLE_ENTITY, "Your bookings are paid from your wallet. Top up if your balance is short."],
  CHECKOUT_IN_PROGRESS: [HttpStatus.CONFLICT, "You already have a checkout in progress. Finish paying for it or cancel it first."],
  VEHICLE_ALREADY_BOOKED: [HttpStatus.CONFLICT, "That vehicle is already booked for part of this time. Choose another time or vehicle."],
  NOT_ELIGIBLE: [HttpStatus.FORBIDDEN, "Accessible bays are reserved for accounts verified as eligible."],
  INVALID_WINDOW: [HttpStatus.UNPROCESSABLE_ENTITY, "Choose a start time in the future and a duration within the lot's limits."],
  NO_TARIFF: [HttpStatus.CONFLICT, "This lot is not taking bookings right now."],
  NO_CAPACITY: [HttpStatus.CONFLICT, "There is no space available for that time. Try another time."],
  INSUFFICIENT_BALANCE: [HttpStatus.PAYMENT_REQUIRED, "Your balance does not cover this booking. Top up to continue."],
};

export function rejection(reason: RejectReason, detail: Record<string, unknown> = {}): ApiError {
  const [status, message] = REJECTIONS[reason];
  return new ApiError(status, reason, message, detail);
}
