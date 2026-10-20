import type { Claim, HoldReleaseReason, HoldSnapshot, PoolSnapshot, TariffSnapshot, TimeWindow, UserSnapshot, WalletBalances } from "./types.js";

/**
 * The persistence port the engine drives. An adapter (packages/db) implements it
 * against Postgres. The engine owns the rules; the adapter owns the locks.
 *
 * Every method on ReservationTx runs inside one database transaction. If `work`
 * throws, the adapter rolls back everything — capacity and payment commit
 * together or not at all (US-022).
 *
 * Lock order, everywhere: payment row (held by the caller, if any), then pools by
 * id, then a hold, then the wallet. Nothing takes them in another order, so no two
 * transactions can deadlock.
 */
export interface ReservationStore {
  transaction<T>(work: (tx: ReservationTx) => Promise<T>): Promise<T>;
}

export interface ReservationTx {
  getUser(userId: string): Promise<UserSnapshot | null>;
  vehicleBelongsTo(vehicleId: string, userId: string): Promise<boolean>;
  tariffInForce(lotId: string, userType: UserSnapshot["userType"], at: Date): Promise<TariffSnapshot | null>;
  listPools(lotId: string): Promise<PoolSnapshot[]>;

  /**
   * Exclusively locks the given pools until the transaction ends, always in a
   * fixed (id) order so concurrent bookings cannot deadlock. Returns the pools as
   * read under the lock. This is what serialises bookings against a pool (US-023).
   */
  lockPools(poolIds: readonly string[]): Promise<PoolSnapshot[]>;
  /** Exclusively locks the user's wallet so concurrent debits cannot overspend it. */
  lockWallet(userId: string): Promise<void>;

  /**
   * Confirmed reservations and unexpired, unreleased holds in these pools that
   * overlap the window. `excludeHoldId` leaves one hold out, so a hold can ask
   * whether it fits alongside every other claim.
   */
  claimsOverlapping(poolIds: readonly string[], window: TimeWindow, now: Date, excludeHoldId?: string): Promise<Claim[]>;
  /** Derived from ledger entries — never a stored figure (US-020). */
  walletBalanceKobo(userId: string): Promise<bigint>;
  /** Total and allocated parts of the balance, both derived from the ledger (US-018). */
  walletBalances(userId: string): Promise<WalletBalances>;

  appendWalletDebit(entry: {
    userId: string;
    amountKobo: bigint;
    /** The part of the debit drawn on allocated credit (OD-12). */
    allocatedKobo: bigint;
    reference: string;
  }): Promise<string>;
  insertReservation(r: {
    reference: string;
    userId: string;
    vehicleId: string;
    lotId: string;
    poolId: string;
    window: TimeWindow;
    hours: number;
    tariffId: string;
    rateAppliedKobo: bigint;
    serviceFeeKobo: bigint;
    amountKobo: bigint;
    /** Exactly one of these pays for it. */
    walletEntryId?: string;
    paymentTransactionId?: string;
    holdId?: string;
    idempotencyKey?: string;
  }): Promise<string>;

  /** A hold the driver placed that has not converted, been released or expired. One at a time (US-135). */
  liveHoldFor(userId: string, now: Date): Promise<HoldSnapshot | null>;
  insertHold(h: Omit<HoldSnapshot, "id" | "releasedAt" | "releaseReason"> & { idempotencyKey?: string }): Promise<string>;
  getHold(holdId: string): Promise<HoldSnapshot | null>;
  /** Locks the hold row. Called only after the hold's pool is locked. */
  lockHold(holdId: string): Promise<HoldSnapshot | null>;
  releaseHold(holdId: string, reason: HoldReleaseReason, at: Date): Promise<void>;
  /** Whether the vehicle is on a confirmed reservation overlapping the window (US-026). */
  vehicleBookedDuring(vehicleId: string, window: TimeWindow): Promise<boolean>;
  /** The reservation a hold converted to, if it has. */
  reservationForHold(holdId: string): Promise<string | null>;
}
