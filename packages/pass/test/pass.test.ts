/** US-033, US-034, US-036, US-038, US-039, OD-13 — the pass and its offline verification. */
import { describe, expect, it } from "vitest";
import {
  codeAt, codeIsCurrent, pinHash, publicKeyFor, qrText, signPass, toBase64Url, verifyPin, verifyQr,
  type GateCache, type GatePassEntry,
} from "../src/index.js";

const priv = new Uint8Array(32).fill(7);
const otherPriv = new Uint8Array(32).fill(9);
const LOT = "11111111-1111-4111-8111-111111111111";
const OTHER_LOT = "22222222-2222-4222-8222-222222222222";
const PASS = "33333333-3333-4333-8333-333333333333";
const secret = new Uint8Array(32).fill(3);
const salt = new Uint8Array(16).fill(5);
const at = (iso: string) => new Date(iso);

function entry(over: Partial<GatePassEntry> = {}): GatePassEntry {
  return {
    passId: PASS, lotId: LOT, reference: "AV-TEST0001", driverName: "Adaeze Okafor", plate: "LND123AB",
    start: "2030-01-01T08:00:00.000Z", end: "2030-01-01T11:00:00.000Z", earlyEntryMinutes: 15, accessible: false,
    status: "active", totpSecret: toBase64Url(secret), pinHash: pinHash(salt, LOT, "482913"), ...over,
  };
}

function cache(...entries: GatePassEntry[]): GateCache {
  return {
    lotId: LOT, pinSalt: toBase64Url(salt), publicKeys: new Map([[1, publicKeyFor(priv)]]),
    passes: new Map(entries.map((e) => [e.passId, e])),
  };
}

const signed = signPass({ passId: PASS, lotId: LOT, keyId: 1, privateKey: priv }).signedPart;

describe("QR payload (US-034)", () => {
  it("carries no personal data: only a version, key id, pass id, lot id and signature", () => {
    const text = qrText(signed, secret, at("2030-01-01T09:00:00Z"));
    expect(text).toMatch(/^AV1:[A-Za-z0-9_-]+:\d{6}$/);
    expect(text).not.toMatch(/LND|Adaeze|AV-TEST/);
  });

  it("verifies VALID offline from the cache alone, with name, plate, window and accessible indicator", () => {
    const now = at("2030-01-01T09:00:00Z");
    const r = verifyQr(qrText(signed, secret, now), cache(entry()), now);
    expect(r).toEqual({
      status: "VALID", method: "qr",
      pass: { passId: PASS, reference: "AV-TEST0001", driverName: "Adaeze Okafor", plate: "LND123AB", start: "2030-01-01T08:00:00.000Z", end: "2030-01-01T11:00:00.000Z", accessible: false },
    });
  });

  it("never exposes the secret, PIN hash or anything beyond the attendant's view (NFR-PRI-01)", () => {
    const now = at("2030-01-01T09:00:00Z");
    const r = verifyQr(qrText(signed, secret, now), cache(entry()), now);
    expect(JSON.stringify(r)).not.toMatch(/totpSecret|pinHash/);
  });

  it("rejects a forged or altered payload as NOT_FOUND", () => {
    const now = at("2030-01-01T09:00:00Z");
    const forged = signPass({ passId: PASS, lotId: LOT, keyId: 1, privateKey: otherPriv }).signedPart;
    expect(verifyQr(qrText(forged, secret, now), cache(entry()), now).status).toBe("NOT_FOUND");
    const text = qrText(signed, secret, now);
    const flipped = text.slice(0, 10) + (text[10] === "A" ? "B" : "A") + text.slice(11);
    expect(verifyQr(flipped, cache(entry()), now).status).toBe("NOT_FOUND");
    expect(verifyQr("hello", cache(entry()), now).status).toBe("NOT_FOUND");
  });

  it("returns WRONG_LOT for a genuine pass for another lot", () => {
    const now = at("2030-01-01T09:00:00Z");
    const elsewhere = signPass({ passId: PASS, lotId: OTHER_LOT, keyId: 1, privateKey: priv }).signedPart;
    expect(verifyQr(qrText(elsewhere, secret, now), cache(entry()), now).status).toBe("WRONG_LOT");
  });

  it("returns NOT_FOUND for a genuine pass the device has not cached", () => {
    const now = at("2030-01-01T09:00:00Z");
    expect(verifyQr(qrText(signed, secret, now), cache(), now).status).toBe("NOT_FOUND");
  });
});

describe("Rotating code (OD-13: 30 s steps, accepted within ±5 minutes)", () => {
  it("changes every 30 seconds", () => {
    expect(codeAt(secret, at("2030-01-01T09:00:00Z"))).not.toBe(codeAt(secret, at("2030-01-01T09:00:30Z")));
  });

  it("tolerates a gate device clock up to five minutes out either way", () => {
    const phone = at("2030-01-01T09:00:00Z");
    const code = codeAt(secret, phone);
    expect(codeIsCurrent(secret, code, at("2030-01-01T09:04:59Z"))).toBe(true);
    expect(codeIsCurrent(secret, code, at("2030-01-01T08:55:01Z"))).toBe(true);
  });

  it("rejects a forwarded screenshot once it is more than about five minutes old: STALE_CODE", () => {
    const screenshotAt = at("2030-01-01T09:00:00Z");
    const screenshot = qrText(signed, secret, screenshotAt);
    const later = at("2030-01-01T09:06:00Z");
    const r = verifyQr(screenshot, cache(entry()), later);
    expect(r.status).toBe("STALE_CODE");
    // The live pass on the owner's phone still verifies.
    expect(verifyQr(qrText(signed, secret, later), cache(entry()), later).status).toBe("VALID");
  });
});

describe("Time and status (US-038, early entry 15 minutes)", () => {
  const scanAt = (iso: string, e = entry()) => verifyQr(qrText(signed, secret, at(iso)), cache(e), at(iso)).status;

  it("admits from 15 minutes before start", () => {
    expect(scanAt("2030-01-01T07:44:59Z")).toBe("NOT_YET_DUE");
    expect(scanAt("2030-01-01T07:45:00Z")).toBe("VALID");
  });

  it("honours a lot's configured early-entry allowance, including none", () => {
    expect(scanAt("2030-01-01T07:59:00Z", entry({ earlyEntryMinutes: 0 }))).toBe("NOT_YET_DUE");
    expect(scanAt("2030-01-01T07:31:00Z", entry({ earlyEntryMinutes: 30 }))).toBe("VALID");
  });

  it("is EXPIRED from the reserved end", () => {
    expect(scanAt("2030-01-01T10:59:59Z")).toBe("VALID");
    expect(scanAt("2030-01-01T11:00:00Z")).toBe("EXPIRED");
  });

  it("is CANCELLED when the cache says so, whatever the time", () => {
    expect(scanAt("2030-01-01T09:00:00Z", entry({ status: "cancelled" }))).toBe("CANCELLED");
  });
});

describe("PIN fallback (US-036, US-039)", () => {
  it("resolves the pass by PIN with the same states as a scan", () => {
    const r = verifyPin("482913", cache(entry()), at("2030-01-01T09:00:00Z"));
    expect(r).toMatchObject({ status: "VALID", method: "pin", pass: { plate: "LND123AB" } });
    expect(verifyPin("482913", cache(entry()), at("2030-01-01T12:00:00Z")).status).toBe("EXPIRED");
  });

  it("returns NOT_FOUND for a wrong or malformed PIN", () => {
    expect(verifyPin("000000", cache(entry()), at("2030-01-01T09:00:00Z")).status).toBe("NOT_FOUND");
    expect(verifyPin("48291", cache(entry()), at("2030-01-01T09:00:00Z")).status).toBe("NOT_FOUND");
  });

  it("prefers the usable pass if an expired pass in the cache shares the PIN", () => {
    const old = entry({ passId: "44444444-4444-4444-8444-444444444444", reference: "AV-OLD", start: "2029-12-31T08:00:00.000Z", end: "2029-12-31T09:00:00.000Z" });
    const r = verifyPin("482913", cache(old, entry()), at("2030-01-01T09:00:00Z"));
    expect(r).toMatchObject({ status: "VALID", pass: { reference: "AV-TEST0001" } });
  });
});
