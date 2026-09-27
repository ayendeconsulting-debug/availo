import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { equalBytes, fromBase64Url, toBase64Url, utf8 } from "./encoding.js";
import { parseQr } from "./payload.js";
import { codeIsCurrent } from "./totp.js";

/**
 * One authorised pass as the attendant's device holds it (NFR-OFF-01). Only
 * what the attendant may see (NFR-PRI-01): name, plate, window, accessible
 * indicator. No balance, contact details or access requirement.
 */
export interface GatePassEntry {
  readonly passId: string;
  readonly lotId: string;
  readonly reference: string;
  readonly driverName: string;
  readonly plate: string;
  readonly start: string; // ISO 8601 UTC
  readonly end: string;
  readonly earlyEntryMinutes: number;
  readonly accessible: boolean;
  readonly status: "active" | "cancelled";
  /** base64url per-pass secret for the rotating code. */
  readonly totpSecret: string;
  /** base64url HMAC-SHA-256(cacheSalt, lotId:pin). Salted per cache issue. */
  readonly pinHash: string;
  /** The server's view when the cache was built: an entry is recorded and no exit yet. */
  readonly onSite?: boolean;
  /** The vehicle has already been in and out on this booking. */
  readonly exited?: boolean;
}

export interface GateCache {
  readonly lotId: string;
  /** base64url salt the server used for every pinHash in this cache. */
  readonly pinSalt: string;
  readonly publicKeys: ReadonlyMap<number, Uint8Array>;
  readonly passes: ReadonlyMap<string, GatePassEntry>;
}

/**
 * US-038 result states, plus STALE_CODE: the signature is genuine but the
 * rotating code is outside the window — a screenshot or a phone clock far off.
 * IN_GRACE and IN_PENALTY arrive with the session lifecycle (sprint 3).
 */
export type GateStatus = "VALID" | "NOT_YET_DUE" | "EXPIRED" | "CANCELLED" | "WRONG_LOT" | "NOT_FOUND" | "STALE_CODE";

export type GateMethod = "qr" | "pin" | "plate";

export type GateResult =
  | { status: "VALID"; method: GateMethod; pass: GateView }
  | { status: Exclude<GateStatus, "VALID" | "NOT_FOUND" | "WRONG_LOT">; method: GateMethod; pass: GateView }
  | { status: "NOT_FOUND" | "WRONG_LOT"; method: GateMethod };

/** What the attendant is shown. Nothing else leaves the cache. */
export interface GateView {
  passId: string;
  reference: string;
  driverName: string;
  plate: string;
  start: string;
  end: string;
  accessible: boolean;
}

const view = (e: GatePassEntry): GateView => ({
  passId: e.passId, reference: e.reference, driverName: e.driverName, plate: e.plate, start: e.start, end: e.end, accessible: e.accessible,
});

export function pinHash(pinSalt: Uint8Array, lotId: string, pin: string): string {
  return toBase64Url(hmac(sha256, pinSalt, utf8(`${lotId}:${pin}`)));
}

function timeStatus(e: GatePassEntry, now: Date): "VALID" | "NOT_YET_DUE" | "EXPIRED" {
  const t = now.getTime();
  if (t < Date.parse(e.start) - e.earlyEntryMinutes * 60_000) return "NOT_YET_DUE";
  if (t >= Date.parse(e.end)) return "EXPIRED";
  return "VALID";
}

/** Status of a cached pass found by PIN or plate: cancellation and time only. The rotating code applies to scans. */
export function resolveEntry(e: GatePassEntry, now: Date, method: GateMethod): GateResult {
  if (e.status === "cancelled") return { status: "CANCELLED", method, pass: view(e) };
  return { status: timeStatus(e, now), method, pass: view(e) };
}

/** Verify a scanned QR entirely from the device cache — no network (US-034, US-042, NFR-PER-02). */
export function verifyQr(text: string, cache: GateCache, now: Date): GateResult {
  const parsed = parseQr(text, cache.publicKeys);
  if (!parsed.ok) return { status: "NOT_FOUND", method: "qr" };
  if (parsed.lotId !== cache.lotId) return { status: "WRONG_LOT", method: "qr" };
  const e = cache.passes.get(parsed.passId);
  if (!e) return { status: "NOT_FOUND", method: "qr" };
  if (e.status === "cancelled") return { status: "CANCELLED", method: "qr", pass: view(e) };
  const t = timeStatus(e, now);
  if (t !== "VALID") return { status: t, method: "qr", pass: view(e) };
  const secret = fromBase64Url(e.totpSecret);
  if (!secret || !codeIsCurrent(secret, parsed.code, now)) return { status: "STALE_CODE", method: "qr", pass: view(e) };
  return { status: "VALID", method: "qr", pass: view(e) };
}

/** PIN fallback (US-036, US-039): same states and same records as a scan. The attendant then confirms the plate. */
export function verifyPin(pin: string, cache: GateCache, now: Date): GateResult {
  if (!/^\d{6}$/.test(pin)) return { status: "NOT_FOUND", method: "pin" };
  const salt = fromBase64Url(cache.pinSalt);
  if (!salt) return { status: "NOT_FOUND", method: "pin" };
  const wanted = fromBase64Url(pinHash(salt, cache.lotId, pin))!;
  const matches: GatePassEntry[] = [];
  for (const e of cache.passes.values()) {
    const h = fromBase64Url(e.pinHash);
    if (h && equalBytes(h, wanted)) matches.push(e);
  }
  if (matches.length === 0) return { status: "NOT_FOUND", method: "pin" };
  // PINs are unique among live passes at a lot; if an old pass in the cache shares one, the usable pass wins.
  const rank = { VALID: 0, NOT_YET_DUE: 1, EXPIRED: 2, CANCELLED: 3 } as const;
  const scored = matches.map((e) => ({ e, s: e.status === "cancelled" ? ("CANCELLED" as const) : timeStatus(e, now) }));
  scored.sort((a, b) => rank[a.s] - rank[b.s]);
  const best = scored[0]!;
  return { status: best.s, method: "pin", pass: view(best.e) };
}
