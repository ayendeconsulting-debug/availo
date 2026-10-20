import { Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Inject, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { AuthGuard, CurrentUser } from "../auth/auth.guard.js";
import type { AccessClaims } from "../auth/tokens.service.js";
import { ApiError } from "../common/errors.js";
import { validate } from "../common/validate.js";
import { PAYMENT_PROVIDER, type PaymentProvider } from "./provider.js";
import { PaymentsService } from "./payments.service.js";
import { ReceiptsService } from "./receipts.service.js";

const Start = z.iso.datetime({ offset: true, message: "Give the start as an ISO 8601 date-time, e.g. 2026-10-01T09:00:00+01:00." }).transform((s) => new Date(s));
const Hours = z.coerce.number().int("Hours must be a whole number.").min(1);
const Kobo = z.string().regex(/^\d{1,12}$/, "Give the amount in kobo as a whole number.").transform((s) => BigInt(s));
const Key = z.string().min(8).max(128);
const Day = z.iso.date().optional();

/** US-134, US-135 checkout; US-016 top-up; US-019 history and receipts. */
@Controller()
@UseGuards(AuthGuard)
export class PaymentsController {
  constructor(
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(ReceiptsService) private readonly receipts: ReceiptsService,
  ) {}

  /** Hold the space and open a payment. Send an Idempotency-Key so a retry returns the same checkout. */
  @Post("checkouts")
  start(@CurrentUser() auth: AccessClaims, @Body() body: unknown, @Headers("idempotency-key") key?: string) {
    const b = validate(z.object({ lotId: z.uuid(), vehicleId: z.uuid(), start: Start, hours: Hours, accessible: z.boolean().optional() }), body);
    return this.payments.startCheckout(auth.userId, b, key ? validate(Key, key) : undefined);
  }

  @Get("checkouts/:id")
  get(@CurrentUser() auth: AccessClaims, @Param("id", ParseUUIDPipe) id: string) {
    return this.payments.checkoutView(auth.userId, id);
  }

  /** The driver is back from the payment page. The outcome comes from the provider, not from this request. */
  @Post("checkouts/:id/verify")
  @HttpCode(HttpStatus.OK)
  verify(@CurrentUser() auth: AccessClaims, @Param("id", ParseUUIDPipe) id: string) {
    return this.payments.verifyCheckout(auth.userId, id);
  }

  @Delete("checkouts/:id")
  cancel(@CurrentUser() auth: AccessClaims, @Param("id", ParseUUIDPipe) id: string) {
    return this.payments.cancelCheckout(auth.userId, id);
  }

  /** US-015: the limits, shown before the driver chooses an amount. */
  @Get("wallet/rules")
  async rules() {
    const r = await this.payments.walletRule();
    return { minTopUpKobo: r.minTopUpKobo.toString(), maxTopUpKobo: r.maxTopUpKobo.toString(), maxBalanceKobo: r.maxBalanceKobo.toString(), consumptionOrder: r.consumptionOrder };
  }

  @Post("top-ups")
  topUp(@CurrentUser() auth: AccessClaims, @Body() body: unknown, @Headers("idempotency-key") key?: string) {
    const b = validate(z.object({ amountKobo: Kobo }), body);
    return this.payments.startTopUp(auth.userId, b.amountKobo, key ? validate(Key, key) : undefined);
  }

  @Get("top-ups/:id")
  topUpView(@CurrentUser() auth: AccessClaims, @Param("id", ParseUUIDPipe) id: string) {
    return this.payments.topUpView(auth.userId, id);
  }

  @Post("top-ups/:id/verify")
  @HttpCode(HttpStatus.OK)
  verifyTopUp(@CurrentUser() auth: AccessClaims, @Param("id", ParseUUIDPipe) id: string) {
    return this.payments.verifyTopUp(auth.userId, id);
  }

  /** US-019: every payment, top-up and refund, with date, reference and amount. */
  @Get("payments")
  history(@CurrentUser() auth: AccessClaims) {
    return this.receipts.history(auth.userId);
  }

  @Get("payments/:id/receipt.pdf")
  async receipt(@CurrentUser() auth: AccessClaims, @Param("id", ParseUUIDPipe) id: string, @Res() res: Response) {
    const pdf = await this.receipts.receiptPdf(auth.userId, id);
    send(res, pdf.buffer, pdf.filename);
  }

  /** US-019: a statement for any period, as PDF. Dates are West Africa Time days, inclusive. */
  @Get("statement.pdf")
  async statement(@CurrentUser() auth: AccessClaims, @Query() query: unknown, @Res() res: Response) {
    const q = validate(z.object({ from: Day, to: Day }), query);
    const pdf = await this.receipts.statementPdf(auth.userId, q.from ?? null, q.to ?? null);
    send(res, pdf.buffer, pdf.filename);
  }
}

/** Provider webhooks. Unauthenticated by bearer token by design; authenticated by the provider's signature instead. */
@Controller("webhooks")
export class WebhooksController {
  constructor(
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  @Post("paystack")
  @HttpCode(HttpStatus.OK)
  async paystack(@Req() req: Request & { rawBody?: Buffer }) {
    const raw = req.rawBody;
    // NFR-SEC-09: nothing is read from a body whose signature does not verify.
    if (!raw || this.provider.name !== "paystack" || !this.provider.authenticateWebhook(raw, req.headers)) {
      throw new ApiError(HttpStatus.UNAUTHORIZED, "BAD_SIGNATURE", "Webhook signature did not verify.");
    }
    let notice;
    try {
      notice = this.provider.parseWebhook(raw);
    } catch {
      throw new ApiError(HttpStatus.BAD_REQUEST, "BAD_BODY", "Webhook body is not valid JSON.");
    }
    const r = await this.payments.handleWebhook(notice);
    return { received: true, duplicate: r.duplicate };
  }
}

function send(res: Response, buffer: Buffer, filename: string) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.end(buffer);
}
