import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToUuid, fromBase64Url, toBase64Url, uuidToBytes } from "./encoding.js";
import { codeAt } from "./totp.js";

/**
 * The QR payload (US-034, OD-13):
 *
 *   AV1:<base64url( version | keyId | passId | lotId | signature )>:<6-digit rotating code>
 *
 * It carries an opaque pass id and the lot — no name, plate or other personal
 * data. The signed part never changes; the code changes every 30 seconds and is
 * computed on the driver's phone from a per-pass secret.
 */
const PREFIX = "AV1:";
const VERSION = 1;
const BODY_LEN = 1 + 1 + 16 + 16;
const SIG_LEN = 64;

export interface SignedPass {
  /** The part of the QR that never changes. The driver app appends ":" + current code. */
  readonly signedPart: string;
}

export function signPass(input: { passId: string; lotId: string; keyId: number; privateKey: Uint8Array }): SignedPass {
  const body = new Uint8Array(BODY_LEN);
  body[0] = VERSION;
  body[1] = input.keyId;
  body.set(uuidToBytes(input.passId), 2);
  body.set(uuidToBytes(input.lotId), 18);
  const sig = ed25519.sign(body, input.privateKey);
  const all = new Uint8Array(BODY_LEN + SIG_LEN);
  all.set(body);
  all.set(sig, BODY_LEN);
  return { signedPart: PREFIX + toBase64Url(all) };
}

/** What the driver's phone renders as the QR right now. Works offline (NFR-OFF-06). */
export function qrText(signedPart: string, totpSecret: Uint8Array, at: Date): string {
  return `${signedPart}:${codeAt(totpSecret, at)}`;
}

export type ParsedQr =
  | { ok: true; passId: string; lotId: string; keyId: number; code: string }
  | { ok: false };

/** Parses and checks the signature. Anything malformed or unsigned is simply not a pass. */
export function parseQr(text: string, publicKeys: ReadonlyMap<number, Uint8Array>): ParsedQr {
  const m = /^AV1:([A-Za-z0-9_-]+):(\d{6})$/.exec(text.trim());
  if (!m) return { ok: false };
  const bytes = fromBase64Url(m[1]!);
  if (!bytes || bytes.length !== BODY_LEN + SIG_LEN || bytes[0] !== VERSION) return { ok: false };
  const body = bytes.slice(0, BODY_LEN);
  const sig = bytes.slice(BODY_LEN);
  const key = publicKeys.get(body[1]!);
  if (!key) return { ok: false };
  let valid = false;
  try {
    valid = ed25519.verify(sig, body, key);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false };
  return { ok: true, keyId: body[1]!, passId: bytesToUuid(body.slice(2, 18)), lotId: bytesToUuid(body.slice(18, 34)), code: m[2]! };
}

export function publicKeyFor(privateKey: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(privateKey);
}
