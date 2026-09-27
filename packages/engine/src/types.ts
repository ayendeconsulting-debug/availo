/** Core vocabulary of the Parking Exchange Engine (NFR-ARC-03). No I/O here. */

export type UserType = "staff" | "student" | "guest"; // US-002
export type PoolKind = "campus" | "open" | "accessible"; // US-010, US-133
export type VerificationState = "pending" | "verified" | "flagged" | "suspended"; // US-006, US-136

/** A half-open interval [start, end). Adjacent windows do not overlap. */
export interface TimeWindow {
  readonly start: Date;
  readonly end: Date;
}

export interface UserSnapshot {
  readonly id: string;
  readonly userType: UserType;
  readonly verificationState: VerificationState;
  /** US-046: the decision only — never the evidence behind it (NFR-PRI-02). */
  readonly accessibleEligible: boolean;
}

export interface PoolSnapshot {
  readonly id: string;
  readonly lotId: string;
  readonly kind: PoolKind;
  readonly capacity: number;
}

/** A confirmed reservation or an unexpired hold occupying one space in a pool (US-023, US-135). */
export interface Claim {
  readonly poolId: string;
  readonly window: TimeWindow;
}

export interface TariffSnapshot {
  readonly id: string;
  readonly hourlyRateKobo: bigint;
  readonly minHours: number;
  readonly maxHours: number;
}

export interface ReserveRequest {
  readonly reference: string;
  readonly userId: string;
  readonly vehicleId: string;
  readonly lotId: string;
  readonly start: Date;
  readonly hours: number;
  /** The driver asks for accessible capacity (US-024). Eligibility is checked server-side regardless. */
  readonly accessible?: boolean;
  /** A client retry carrying the same key returns the original booking rather than making a second. */
  readonly idempotencyKey?: string;
  /** The engine's notion of "now" — injected so the engine stays pure and testable. */
  readonly now: Date;
}

export type RejectReason =
  | "USER_NOT_FOUND"
  | "USER_NOT_BOOKABLE" // suspended or not yet verified (US-005, US-007)
  | "VEHICLE_NOT_REGISTERED" // US-003
  | "WALLET_PATH_NOT_AVAILABLE" // guests pay at checkout, not from a wallet (US-134)
  | "NOT_ELIGIBLE" // accessible capacity requested by an ineligible account (US-024, US-047)
  | "INVALID_WINDOW" // in the past, or duration outside tariff limits (US-013)
  | "NO_TARIFF"
  | "NO_CAPACITY" // US-023
  | "INSUFFICIENT_BALANCE"; // US-021

export type ReserveResult =
  | {
      readonly ok: true;
      readonly reservationId: string;
      readonly poolId: string;
      readonly poolKind: PoolKind;
      readonly window: TimeWindow;
      readonly rateAppliedKobo: bigint;
      readonly amountKobo: bigint;
      readonly walletEntryId: string;
    }
  | { readonly ok: false; readonly reason: RejectReason };
