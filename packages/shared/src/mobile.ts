/**
 * NFR-LOC-01, US-001: Nigerian mobile numbers are accepted in international
 * (+234…, 234…) and local (0…) form and stored as one E.164 value.
 */
export type MobileResult = { ok: true; e164: string } | { ok: false; reason: "INVALID_MOBILE" };

// Nigerian mobile subscriber numbers: 10 digits after the country code, beginning 70, 80, 81, 90 or 91.
const NATIONAL = /^[789][01]\d{8}$/;

export function normaliseNigerianMobile(input: string): MobileResult {
  const digits = input.replace(/[\s\-().]/g, "");
  let national: string | null = null;
  if (/^\+234\d+$/.test(digits)) national = digits.slice(4);
  else if (/^234\d+$/.test(digits)) national = digits.slice(3);
  else if (/^0\d+$/.test(digits)) national = digits.slice(1);
  if (national === null || !NATIONAL.test(national)) return { ok: false, reason: "INVALID_MOBILE" };
  return { ok: true, e164: `+234${national}` };
}
