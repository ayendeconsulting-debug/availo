import type { Booking, Lot, Me, PassView } from "./api.js";

/**
 * What the phone keeps so the app is useful with no signal. The pass is what
 * matters (NFR-OFF-06): it renders and its QR keeps rotating from local data.
 * localStorage can be unavailable (private mode); every access is guarded.
 */
function read<T>(k: string): T | null {
  try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : null; } catch { return null; }
}
function write(k: string, v: unknown): void {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ }
}

export const local = {
  me: () => read<Me>("av.me"),
  saveMe: (m: Me) => write("av.me", m),
  lot: () => read<Lot>("av.lot"),
  saveLot: (l: Lot) => write("av.lot", l),
  bookings: () => read<Booking[]>("av.bookings") ?? [],
  saveBookings: (b: Booking[]) => write("av.bookings", b),
  pass: (reservationId: string) => read<PassView>(`av.pass.${reservationId}`),
  savePass: (reservationId: string, p: PassView) => write(`av.pass.${reservationId}`, p),
  clear: () => {
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith("av.")) localStorage.removeItem(k);
    } catch { /* storage unavailable */ }
  },
};
