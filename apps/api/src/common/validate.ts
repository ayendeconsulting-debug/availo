import { HttpStatus } from "@nestjs/common";
import type { z } from "zod";
import { ApiError } from "./errors.js";

/** NFR-ACC-07: errors say what is wrong and what is required, per field. */
export function validate<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  throw new ApiError(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "Some fields need correcting.", {
    fields: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  });
}
