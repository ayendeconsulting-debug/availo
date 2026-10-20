import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import PDFDocument from "pdfkit";
import type pg from "pg";
import { PG_POOL } from "../common/db.js";
import { ApiError } from "../common/errors.js";

/** Lagos is UTC+1 all year. Statements are cut on West Africa Time days (NFR-LOC-03). */
const WAT_OFFSET_MS = 3_600_000;
const watDateTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const watTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit", hour12: false });
const watDay = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "short", year: "numeric" });
/** Standard PDF fonts have no naira sign; formal documents use the ISO code. */
const ngn = (k: string | bigint) => {
  const v = BigInt(k);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  return `${neg ? "-" : ""}NGN ${(abs / 100n).toLocaleString("en-NG")}.${String(abs % 100n).padStart(2, "0")}`;
};

interface HistoryRow {
  kind: "checkout" | "top_up" | "refund" | "allocation";
  id: string; payment_id: string | null; reference: string; amount_kobo: string; at: Date; status: string; note: string | null;
  booking_reference: string | null; reservation_id: string | null; lot_name: string | null; s: Date | null; e: Date | null; channel: string | null;
}

/** US-019: where a driver's money went, on screen and as PDF receipts and statements. */
@Injectable()
export class ReceiptsService {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  private async rows(userId: string, from: Date | null, to: Date | null): Promise<HistoryRow[]> {
    const { rows } = await this.pool.query<HistoryRow>(
      `SELECT * FROM (
         SELECT pt.purpose::text AS kind, pt.id, pt.id AS payment_id, pt.reference, pt.amount_kobo::text, COALESCE(pt.paid_at, pt.created_at) AS at,
                CASE WHEN pt.status = 'succeeded' THEN pt.fulfilment::text ELSE pt.status::text END AS status, pt.fulfilment_note AS note,
                r.reference AS booking_reference, r.id AS reservation_id, l.name AS lot_name, lower(r.time_window) AS s, upper(r.time_window) AS e, pt.channel
           FROM payment_transaction pt
           LEFT JOIN reservation r ON r.payment_transaction_id = pt.id
           LEFT JOIN lot l ON l.id = r.lot_id
          WHERE pt.user_id = $1 AND pt.status IN ('succeeded', 'failed')
         UNION ALL
         SELECT 'refund', rf.id, pt.id, pt.reference, (-rf.amount_kobo)::text, COALESCE(rf.processed_at, rf.queued_at), rf.status::text, rf.reason,
                NULL, NULL, NULL, NULL, NULL, pt.channel
           FROM refund rf JOIN payment_transaction pt ON pt.id = rf.payment_transaction_id
          WHERE pt.user_id = $1
         UNION ALL
         SELECT 'allocation', we.id, NULL, we.reference, we.amount_kobo::text, we.created_at, 'credited', NULL, NULL, NULL, NULL, NULL, NULL, NULL
           FROM wallet_entry we WHERE we.user_id = $1 AND we.entry_type = 'allocation'
       ) h
       WHERE ($2::timestamptz IS NULL OR at >= $2) AND ($3::timestamptz IS NULL OR at < $3)
       ORDER BY at DESC, id DESC
       LIMIT 500`,
      [userId, from, to]);
    return rows;
  }

  async history(userId: string) {
    return (await this.rows(userId, null, null)).map((r) => ({
      kind: r.kind, id: r.id, paymentId: r.payment_id, reference: r.reference, amountKobo: r.amount_kobo, at: r.at.toISOString(),
      status: r.status, note: r.note, channel: r.channel,
      booking: r.reservation_id ? { id: r.reservation_id, reference: r.booking_reference, lot: r.lot_name, window: { start: r.s!.toISOString(), end: r.e!.toISOString() } } : null,
      receipt: (r.kind === "checkout" || r.kind === "top_up") && r.payment_id !== null && ["fulfilled", "refund_due"].includes(r.status),
    }));
  }

  async receiptPdf(userId: string, paymentId: string): Promise<{ buffer: Buffer; filename: string }> {
    const { rows: [p] } = await this.pool.query<{
      reference: string; purpose: string; amount_kobo: string; paid_amount_kobo: string | null; paid_at: Date | null; channel: string | null; fulfilment: string; fulfilment_note: string | null;
      display_name: string; mobile_e164: string; booking_reference: string | null; lot_name: string | null; property: string | null; s: Date | null; e: Date | null;
      hours: number | null; rate_applied_kobo: string | null; service_fee_kobo: string | null; plate: string | null; refund_status: string | null; balance_after: string | null;
    }>(
      `SELECT pt.reference, pt.purpose::text, pt.amount_kobo::text, pt.paid_amount_kobo::text, pt.paid_at, pt.channel, pt.fulfilment::text, pt.fulfilment_note,
              u.display_name, u.mobile_e164, r.reference AS booking_reference, l.name AS lot_name, pr.name AS property,
              lower(r.time_window) AS s, upper(r.time_window) AS e, r.hours, r.rate_applied_kobo::text, r.service_fee_kobo::text,
              v.plate_display AS plate, rf.status::text AS refund_status,
              (SELECT sum(w2.amount_kobo)::text FROM wallet_entry w2 WHERE w2.user_id = pt.user_id AND (w2.created_at, w2.id) <= (we.created_at, we.id)) AS balance_after
         FROM payment_transaction pt JOIN app_user u ON u.id = pt.user_id
         LEFT JOIN reservation r ON r.payment_transaction_id = pt.id LEFT JOIN lot l ON l.id = r.lot_id LEFT JOIN property pr ON pr.id = l.property_id
         LEFT JOIN vehicle v ON v.id = r.vehicle_id LEFT JOIN refund rf ON rf.payment_transaction_id = pt.id
         LEFT JOIN wallet_entry we ON we.payment_transaction_id = pt.id AND we.entry_type = 'top_up'
        WHERE pt.id = $1 AND pt.user_id = $2 AND pt.status = 'succeeded'`,
      [paymentId, userId]);
    if (!p) throw new ApiError(HttpStatus.NOT_FOUND, "NOT_FOUND", "No paid payment with that reference on your account.");

    const buffer = await render((doc) => {
      header(doc, p.purpose === "top_up" ? "Wallet top-up receipt" : "Parking receipt");
      fields(doc, [
        ["Receipt", p.reference],
        ["Paid", p.paid_at ? `${watDateTime.format(p.paid_at)} WAT` : "—"],
        ["Paid by", `${p.display_name} · ${p.mobile_e164}`],
        ["Method", p.channel ? p.channel.replace(/_/g, " ") : "—"],
      ]);
      doc.moveDown();
      if (p.fulfilment === "refund_due") {
        // Not honoured: say what was received and that it is going back, whatever was asked for.
        lines(doc, [["Payment received", ngn(p.paid_amount_kobo ?? p.amount_kobo)]], ["Total paid", ngn(p.paid_amount_kobo ?? p.amount_kobo)]);
      } else if (p.purpose === "checkout" && p.booking_reference) {
        fields(doc, [
          ["Booking", p.booking_reference],
          ["Site", [p.lot_name, p.property].filter(Boolean).join(", ")],
          ["Time", `${watDateTime.format(p.s!)}–${watTime.format(p.e!)} WAT`],
          ["Vehicle", p.plate ?? "—"],
        ]);
        doc.moveDown();
        lines(doc, [
          [`Parking, ${p.hours} h × ${ngn(p.rate_applied_kobo!)}`, ngn(BigInt(p.rate_applied_kobo!) * BigInt(p.hours!))],
          ...(BigInt(p.service_fee_kobo ?? "0") > 0n ? [["Service fee", ngn(p.service_fee_kobo!)] as [string, string]] : []),
        ], ["Total paid", ngn(p.amount_kobo)]);
        doc.moveDown().fontSize(9).fillColor("#555").text("Charged for the time reserved, not the time used. No refund is made for leaving early.");
      } else if (p.purpose === "top_up") {
        lines(doc, [["Added to wallet", ngn(p.amount_kobo)]], ["Total paid", ngn(p.amount_kobo)]);
        if (p.balance_after) doc.moveDown().fontSize(10).fillColor("#1e2124").text(`Wallet balance after this top-up: ${ngn(p.balance_after)}`);
        doc.moveDown().fontSize(9).fillColor("#555").text("A wallet balance is money held for future parking. It is not spent until you book.");
      }
      if (p.fulfilment === "refund_due") {
        doc.moveDown().fontSize(10).fillColor("#9a1b1b").text(`Refund ${p.refund_status === "processed" ? "issued" : "in progress"} to the original payment method: ${p.fulfilment_note ?? ""}`);
      }
      footer(doc);
    });
    return { buffer, filename: `availo-receipt-${p.reference}.pdf` };
  }

  async statementPdf(userId: string, fromDay: string | null, toDay: string | null): Promise<{ buffer: Buffer; filename: string }> {
    // A WAT calendar day d runs from (d 00:00 WAT) = (d − 1 h UTC).
    const from = fromDay ? new Date(Date.parse(`${fromDay}T00:00:00Z`) - WAT_OFFSET_MS) : null;
    const to = toDay ? new Date(Date.parse(`${toDay}T00:00:00Z`) - WAT_OFFSET_MS + 86_400_000) : null;
    if (from && to && from >= to) throw new ApiError(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "The start date must be on or before the end date.");
    const items = (await this.rows(userId, from, to)).reverse();
    const { rows: [u] } = await this.pool.query<{ display_name: string; mobile_e164: string; wallet_enabled: boolean }>(
      "SELECT u.display_name, u.mobile_e164, r.wallet_enabled FROM app_user u JOIN user_type_rule r ON r.user_type = u.user_type WHERE u.id = $1", [userId]);
    const wallet = u!.wallet_enabled ? await this.walletLines(userId, from, to) : null;

    const label = (k: HistoryRow) =>
      k.kind === "checkout" ? `Parking ${k.booking_reference ?? ""}${k.lot_name ? ` · ${k.lot_name}` : ""}`.trim()
      : k.kind === "top_up" ? "Wallet top-up" : k.kind === "refund" ? "Refund to original method" : "Credit from Availo";

    const buffer = await render((doc) => {
      header(doc, "Statement");
      fields(doc, [
        ["Name", `${u!.display_name} · ${u!.mobile_e164}`],
        ["Period", `${fromDay ? watDay.format(new Date(`${fromDay}T12:00:00Z`)) : "First payment"} to ${toDay ? watDay.format(new Date(`${toDay}T12:00:00Z`)) : "today"}`],
      ]);
      doc.moveDown().font("Helvetica-Bold").fontSize(11).fillColor("#1e2124").text("Payments and refunds");
      doc.font("Helvetica").moveDown(0.3);
      const shown = items.filter((i) => i.kind !== "allocation" && !(i.kind !== "refund" && i.status === "failed"));
      if (!shown.length) doc.fontSize(10).text("None in this period.");
      for (const i of shown) row(doc, `${watDateTime.format(i.at)}  ${label(i)}  ${i.reference}`, ngn(i.amount_kobo));
      const paid = shown.filter((i) => i.kind !== "refund").reduce((n, i) => n + BigInt(i.amount_kobo), 0n);
      const refunded = shown.filter((i) => i.kind === "refund" && i.status === "processed").reduce((n, i) => n + BigInt(i.amount_kobo), 0n);
      doc.moveDown(0.3);
      row(doc, "Paid in this period", ngn(paid), true);
      row(doc, "Refunded in this period", ngn(refunded), true);

      if (wallet) {
        doc.moveDown().font("Helvetica-Bold").fontSize(11).text("Wallet");
        doc.font("Helvetica").moveDown(0.3);
        row(doc, "Opening balance", ngn(wallet.opening), true);
        for (const w of wallet.entries) row(doc, `${watDateTime.format(w.at)}  ${WALLET_LABEL[w.type] ?? w.type}  ${w.reference}`, ngn(w.amount));
        row(doc, "Closing balance", ngn(wallet.closing), true);
        row(doc, "  of which credit from Availo", ngn(wallet.closingAllocated));
      }
      footer(doc);
    });
    return { buffer, filename: `availo-statement-${fromDay ?? "start"}-to-${toDay ?? "today"}.pdf` };
  }

  private async walletLines(userId: string, from: Date | null, to: Date | null) {
    const { rows: [o] } = await this.pool.query<{ b: string }>(
      "SELECT COALESCE(sum(amount_kobo), 0)::text AS b FROM wallet_entry WHERE user_id = $1 AND ($2::timestamptz IS NOT NULL AND created_at < $2)", [userId, from]);
    const { rows } = await this.pool.query<{ type: string; amount: string; reference: string; at: Date }>(
      `SELECT entry_type::text AS type, amount_kobo::text AS amount, reference, created_at AS at FROM wallet_entry
        WHERE user_id = $1 AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at < $3) ORDER BY created_at, id`,
      [userId, from, to]);
    const { rows: [c] } = await this.pool.query<{ b: string; a: string }>(
      "SELECT COALESCE(sum(amount_kobo), 0)::text AS b, COALESCE(sum(allocated_kobo), 0)::text AS a FROM wallet_entry WHERE user_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2)", [userId, to]);
    return { opening: o!.b, entries: rows, closing: c!.b, closingAllocated: c!.a };
  }
}

const WALLET_LABEL: Record<string, string> = {
  top_up: "Top-up", allocation: "Credit from Availo", reservation_debit: "Booking", extension_debit: "Extension",
  penalty: "Overstay charge", refund: "Refund", reversal: "Correction",
};

// ——— Layout ———

function render(draw: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 56, info: { Title: "Availo", Author: "Availo" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    draw(doc);
    doc.end();
  });
}

function header(doc: PDFKit.PDFDocument, title: string) {
  doc.rect(0, 0, doc.page.width, 8).fill("#ffd23f");
  doc.fillColor("#1e2124").font("Helvetica-Bold").fontSize(22).text("AVAILO", 56, 40, { characterSpacing: 1.5 });
  doc.font("Helvetica").fontSize(14).text(title);
  doc.moveDown(0.8);
}

function fields(doc: PDFKit.PDFDocument, pairs: Array<[string, string]>) {
  for (const [k, v] of pairs) {
    const y = doc.y;
    doc.font("Helvetica").fontSize(10).fillColor("#555").text(k, 56, y, { width: 110 });
    doc.font("Helvetica").fontSize(10).fillColor("#1e2124").text(v, 170, y, { width: doc.page.width - 226 });
    doc.x = 56;
    doc.moveDown(0.2);
  }
}

function row(doc: PDFKit.PDFDocument, left: string, right: string, bold = false) {
  const y = doc.y;
  const width = doc.page.width - 112;
  doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9.5).fillColor("#1e2124").text(left, 56, y, { width: width - 120 });
  const after = doc.y;
  doc.text(right, 56 + width - 120, y, { width: 120, align: "right" });
  doc.y = Math.max(after, doc.y);
  doc.x = 56;
  doc.font("Helvetica");
  doc.moveDown(0.15);
}

function lines(doc: PDFKit.PDFDocument, items: Array<[string, string]>, total: [string, string]) {
  for (const [l, r] of items) row(doc, l, r);
  doc.moveTo(56, doc.y + 2).lineTo(doc.page.width - 56, doc.y + 2).strokeColor("#1e2124").lineWidth(0.8).stroke();
  doc.moveDown(0.4);
  row(doc, total[0], total[1], true);
}

function footer(doc: PDFKit.PDFDocument) {
  doc.moveDown(2).font("Helvetica").fontSize(8.5).fillColor("#777")
    .text("Amounts in Nigerian naira. Times in West Africa Time. Paid through a licensed payment provider; Availo never stores card details.", 56, doc.y, { width: doc.page.width - 112 });
}
