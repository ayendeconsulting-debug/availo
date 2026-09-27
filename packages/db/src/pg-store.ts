import type pg from "pg";
import type { ReservationStore } from "@availo/engine";

export function createPgReservationStore(_pool: pg.Pool): ReservationStore {
  throw new Error("not implemented");
}
