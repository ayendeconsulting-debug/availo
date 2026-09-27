import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * OD-13: the rotating component. RFC 6238-style, HMAC-SHA-256, 6 digits,
 * 30-second steps, accepted within ±10 steps (±5 minutes) so an offline gate
 * device with a drifting clock still verifies (docs/decisions.md).
 */
export const STEP_SECONDS = 30;
export const TOLERANCE_STEPS = 10;
export const DIGITS = 6;

export function stepAt(at: Date): number {
  return Math.floor(at.getTime() / 1000 / STEP_SECONDS);
}

export function codeForStep(secret: Uint8Array, step: number): string {
  const counter = new Uint8Array(8);
  let n = step;
  for (let i = 7; i >= 0; i--) {
    counter[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  const mac = hmac(sha256, secret, counter);
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function codeAt(secret: Uint8Array, at: Date): string {
  return codeForStep(secret, stepAt(at));
}

export function codeIsCurrent(secret: Uint8Array, code: string, at: Date): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const now = stepAt(at);
  let match = false;
  // Check every step in the window so timing does not reveal which one matched.
  for (let s = now - TOLERANCE_STEPS; s <= now + TOLERANCE_STEPS; s++) {
    if (codeForStep(secret, s) === code) match = true;
  }
  return match;
}
