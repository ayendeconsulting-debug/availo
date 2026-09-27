import { HttpException, HttpStatus } from "@nestjs/common";

/** Every error body has the same shape: { error: { code, message, ...detail } }. Never a bare error (US-038 spirit). */
export class ApiError extends HttpException {
  constructor(status: HttpStatus, code: string, message: string, detail: Record<string, unknown> = {}) {
    super({ error: { code, message, ...detail } }, status);
  }
}
