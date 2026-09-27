/**
 * US-003: plates are normalised for case, spacing and separators on storage, and
 * all gate matching uses the normalised value. Format is validated with a
 * warning, not a block, so valid but unusual plates are not excluded.
 */
export interface PlateResult {
  normalised: string;
  /** Present when the plate does not match the current Nigerian format (e.g. ABC-123DE). */
  warning?: "UNUSUAL_PLATE_FORMAT";
}

const CURRENT_FORMAT = /^[A-Z]{3}\d{3}[A-Z]{2}$/;

export function normalisePlate(input: string): PlateResult | null {
  const normalised = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalised.length < 2 || normalised.length > 12) return null;
  return CURRENT_FORMAT.test(normalised) ? { normalised } : { normalised, warning: "UNUSUAL_PLATE_FORMAT" };
}
