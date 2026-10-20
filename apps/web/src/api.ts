/** The driver app's connection to the Availo API. */
const BASE = (import.meta.env.VITE_API_URL ?? "http://localhost:3000").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly detail: Record<string, unknown> = {}) {
    super(message);
  }
}
/** No connection. Screens fall back to what is stored on the phone. */
export class OfflineError extends Error {}

const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string | null) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export const session = {
  get access() { return store.get("av.access"); },
  get refresh() { return store.get("av.refresh"); },
  save(t: { accessToken: string; refreshToken: string }) { store.set("av.access", t.accessToken); store.set("av.refresh", t.refreshToken); },
  clear() { store.set("av.access", null); store.set("av.refresh", null); },
  get signedIn() { return !!store.get("av.refresh"); },
};

async function raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  try {
    return await fetch(BASE + path, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new OfflineError("No connection");
  }
}

async function parse<T>(r: Response): Promise<T> {
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  if (!r.ok) {
    const e = json.error ?? {};
    const { code, message, ...detail } = e;
    throw new ApiError(r.status, code ?? "ERROR", message ?? "Something went wrong. Try again.", detail);
  }
  return json as T;
}

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  const rt = session.refresh;
  if (!rt) return false;
  refreshing ??= (async () => {
    try {
      const r = await raw("POST", "/auth/refresh", { refreshToken: rt });
      if (!r.ok) { if (r.status === 401) session.clear(); return false; }
      session.save(await r.json());
      return true;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function api<T>(method: string, path: string, body?: unknown, opts: { auth?: boolean; idempotencyKey?: string } = {}): Promise<T> {
  const auth = opts.auth ?? true;
  const headers = (): Record<string, string> => ({
    ...(auth && session.access ? { Authorization: `Bearer ${session.access}` } : {}),
    ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
  });
  let r = await raw(method, path, body, headers());
  if (r.status === 401 && auth && (await refresh())) r = await raw(method, path, body, headers());
  return parse<T>(r);
}

/** A PDF the driver downloads (US-019). Fetched with the session, then saved through a blob link. */
export async function download(path: string, filename: string): Promise<void> {
  const get = () => raw("GET", path, undefined, session.access ? { Authorization: `Bearer ${session.access}` } : {});
  let r = await get();
  if (r.status === 401 && (await refresh())) r = await get();
  if (!r.ok) await parse(r);
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ——— Shapes returned by the API ———
export interface Me {
  id: string; name: string; userType: "staff" | "student" | "guest"; verificationState: string; vehicles: Array<{ id: string; plate: string }>;
  walletBalanceKobo: string | null;
  /** US-016, US-134: how this driver pays. */
  paymentPath?: "wallet" | "checkout";
}
export interface Lot { id: string; name: string; property: string; building: string | null; gateDirections: string | null; entrancePhotoUrl: string | null; earlyEntryMinutes: number; pools: Array<{ kind: string; capacity: number }> }
export interface Availability {
  window: { start: string; end: string }; available: number;
  pools: Array<{ kind: "campus" | "open" | "accessible"; capacity: number; available: number }>;
  rateKobo: string; serviceFeeKobo: string; amountKobo: string; paymentPath: "wallet" | "checkout";
  minHours: number; maxHours: number; balanceBeforeKobo: string | null; balanceAfterKobo: string | null;
  terms: { earlyCheckoutRefund: boolean; cancellation: string; grace: string; penalty: string };
}
export interface Booking { id: string; reference: string; lot: { id: string; name: string }; pool: string; status: string; plate: string; window: { start: string; end: string }; hours: number; amountKobo: string; passId: string | null; session: string | null; upcoming: boolean }
export interface PassView {
  passId: string; reference: string; lot: { id: string; name: string }; window: { start: string; end: string }; earlyEntryMinutes: number;
  plate: string; driverName: string; accessible: boolean; pool?: string; pin: string; qr: { signedPart: string; totpSecret: string; stepSeconds: number }; status: string;
}
export interface Wallet { balanceKobo: string; entries: Array<{ id: string; type: string; amountKobo: string; reference: string; at: string; balanceAfterKobo: string }> }

/** US-134, US-135: a checkout and the hold behind it. */
export interface Checkout {
  holdId: string; reference: string; lotId: string; pool: string;
  state: "held" | "confirmed" | "expired" | "failed" | "cancelled" | "refund_due";
  window: { start: string; end: string }; hours: number;
  rateKobo: string; parkingKobo: string; serviceFeeKobo: string; amountKobo: string;
  expiresAt: string; secondsLeft: number;
  payment: { id: string; reference: string; status: string; fulfilment: string; note: string | null; authorizationUrl: string | null } | null;
  reservationId: string | null;
}
/** US-016. */
export interface TopUp { paymentId: string; reference: string; amountKobo: string; state: "pending" | "credited" | "failed" | "abandoned" | "refund_due"; authorizationUrl: string | null; balanceKobo: string }
export interface WalletRules { minTopUpKobo: string; maxTopUpKobo: string; maxBalanceKobo: string; consumptionOrder: string }
/** US-019. */
export interface PaymentItem {
  kind: "checkout" | "top_up" | "refund" | "allocation"; id: string; paymentId: string | null; reference: string; amountKobo: string; at: string;
  status: string; note: string | null; channel: string | null;
  booking: { id: string; reference: string; lot: string; window: { start: string; end: string } } | null;
  receipt: boolean;
}
