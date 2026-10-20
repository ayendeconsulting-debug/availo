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
  /**
   * The payment path this driver uses (US-016, US-134): a prepaid wallet, or pay at checkout.
   * Configuration (user_type_rule today, the site's location profile from sprint 3), never a code branch.
   */
  readonly walletEnabled: boolean;
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
  /** US-013: any service fee, added once per booking. */
  readonly serviceFeeKobo: bigint;
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
  /** OD-12: which credit a wallet debit draws on first. Allocated first unless configured otherwise. */
  readonly consumptionOrder?: ConsumptionOrder;
}

/** OD-12, decided: allocated credit is consumed before paid credit (US-018). */
export type ConsumptionOrder = "allocated_first" | "paid_first";

/** A wallet balance split by where the money came from (US-018, US-062). Both derived from the ledger. */
export interface WalletBalances {
  readonly totalKobo: bigint;
  readonly allocatedKobo: bigint;
}

export type RejectReason =
  | "USER_NOT_FOUND"
  | "USER_NOT_BOOKABLE" // suspended or not yet verified (US-005, US-007)
  | "VEHICLE_NOT_REGISTERED" // US-003
  | "WALLET_PATH_NOT_AVAILABLE" // this driver pays at checkout, not from a wallet (US-134)
  | "CHECKOUT_PATH_NOT_AVAILABLE" // this driver pays from a wallet (US-016)
  | "CHECKOUT_IN_PROGRESS" // one live hold per driver (US-135)
  | "VEHICLE_ALREADY_BOOKED" // a vehicle may not be on two overlapping bookings (US-026)
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
      readonly serviceFeeKobo: bigint;
      readonly amountKobo: bigint;
      readonly walletEntryId: string;
      /** OD-12: how much of the debit drew on allocated credit; the rest drew on paid credit. */
      readonly allocatedKobo: bigint;
    }
  | { readonly ok: false; readonly reason: RejectReason };

/** US-135: hold capacity while a checkout payment completes. */
export interface HoldRequest {
  readonly reference: string;
  readonly userId: string;
  readonly vehicleId: string;
  readonly lotId: string;
  readonly start: Date;
  readonly hours: number;
  readonly accessible?: boolean;
  readonly idempotencyKey?: string;
  readonly now: Date;
  /** The lot's hold duration (US-135, default ten minutes). */
  readonly holdMinutes: number;
}

export type HoldResult =
  | {
      readonly ok: true;
      readonly holdId: string;
      readonly poolId: string;
      readonly poolKind: PoolKind;
      readonly window: TimeWindow;
      readonly rateAppliedKobo: bigint;
      readonly serviceFeeKobo: bigint;
      readonly amountKobo: bigint;
      readonly expiresAt: Date;
    }
  | { readonly ok: false; readonly reason: RejectReason; readonly holdId?: string };

/** The fixed quote and claim a hold carries until it converts or is released. */
export interface HoldSnapshot {
  readonly id: string;
  readonly reference: string;
  readonly userId: string;
  readonly vehicleId: string;
  readonly lotId: string;
  readonly poolId: string;
  readonly window: TimeWindow;
  readonly hours: number;
  readonly tariffId: string;
  readonly rateAppliedKobo: bigint;
  readonly serviceFeeKobo: bigint;
  readonly amountKobo: bigint;
  readonly expiresAt: Date;
  readonly releasedAt: Date | null;
  readonly releaseReason: HoldReleaseReason | null;
}

export type HoldReleaseReason = "converted" | "expired" | "payment_failed" | "cancelled";

export interface ConvertHoldRequest {
  readonly holdId: string;
  /** The verified payment that pays for the reservation (US-134). */
  readonly paymentTransactionId: string;
  readonly now: Date;
}

export type ConvertHoldResult =
  | {
      readonly ok: true;
      readonly reservationId: string;
      /** True when the hold had already lapsed and capacity was taken again for a late payment. */
      readonly late: boolean;
      /** True when this hold had already converted: the existing reservation is returned, nothing is written. */
      readonly alreadyConverted: boolean;
    }
  | {
      readonly ok: false;
      /**
       * HOLD_NOT_FOUND; HOLD_CANCELLED (the driver cancelled it); NO_CAPACITY (it lapsed and the space has
       * since gone); VEHICLE_ALREADY_BOOKED (it lapsed and the driver has since booked the same car for an
       * overlapping time — a late duplicate). Each means the payment cannot be honoured and is refunded (US-017).
       */
      readonly reason: "HOLD_NOT_FOUND" | "HOLD_CANCELLED" | "NO_CAPACITY" | "VEHICLE_ALREADY_BOOKED";
    };
