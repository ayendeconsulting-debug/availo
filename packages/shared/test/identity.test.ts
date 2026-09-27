import { describe, expect, it } from "vitest";
import { normaliseNigerianMobile, normalisePlate } from "../src/index.js";

describe("normaliseNigerianMobile (US-001, NFR-LOC-01)", () => {
  it.each([
    ["08031234567", "+2348031234567"],
    ["+2348031234567", "+2348031234567"],
    ["2348031234567", "+2348031234567"],
    ["0803 123 4567", "+2348031234567"],
    ["+234 803-123-4567", "+2348031234567"],
    ["09151234567", "+2349151234567"],
    ["07011234567", "+2347011234567"],
  ])("normalises %s to %s", (input, e164) => {
    expect(normaliseNigerianMobile(input)).toEqual({ ok: true, e164 });
  });

  it.each(["0803123456", "080312345678", "01234567890", "+14165551234", "08031234abc", ""])("rejects %s", (input) => {
    expect(normaliseNigerianMobile(input).ok).toBe(false);
  });
});

describe("normalisePlate (US-003)", () => {
  it("normalises case, spacing and separators to one value", () => {
    for (const p of ["abc-123de", "ABC 123 DE", "Abc.123.De", "ABC123DE"]) {
      expect(normalisePlate(p)).toEqual({ normalised: "ABC123DE" });
    }
  });

  it("warns on an unusual format but does not block it", () => {
    expect(normalisePlate("LAG 1234")).toEqual({ normalised: "LAG1234", warning: "UNUSUAL_PLATE_FORMAT" });
  });

  it("rejects empty or absurd input", () => {
    expect(normalisePlate("--")).toBeNull();
    expect(normalisePlate("A".repeat(20))).toBeNull();
  });
});
