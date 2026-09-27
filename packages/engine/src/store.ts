import type { Claim, PoolSnapshot, TariffSnapshot, TimeWindow, UserSnapshot } from "./types.js";

/**
 * The persistence port the engine drives. An adapter (packages/db) implements it
 * against Postgres. The engine owns the rules; the adapter owns the locks.
 *
 * Every method on ReservationTx runs inside one database transaction. If `work`
 * throws, the adapter rolls back everything — capacity and payment commit
 * together or not at all (US-022).
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

  /** Confirmed reservations and unexpired holds in these pools that overlap the window. */
  claimsOverlapping(poolIds: readonly string[], window: TimeWindow, now: Date): Promise<Claim[]>;
  /** Derived from ledger entries — never a stored figure (US-020). */
  walletBalanceKobo(userId: string): Promise<bigint>;

  appendWalletDebit(entry: {
    userId: string;
    amountKobo: bigint;
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
    amountKobo: bigint;
    walletEntryId: string;
    idempotencyKey?: string;
  }): Promise<string>;
}
