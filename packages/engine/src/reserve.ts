import type { ReservationStore } from "./store.js";
import type { ReserveRequest, ReserveResult } from "./types.js";

export async function reserve(_store: ReservationStore, _req: ReserveRequest): Promise<ReserveResult> {
  throw new Error("not implemented");
}
