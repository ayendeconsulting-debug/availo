import { useState } from "react";
import { BrandBar, Chip, Icon, Shell, naira, watDay, watTime } from "@availo/ui";
import { api, download, type PaymentItem } from "../api.js";
import { useCached, useMe } from "../hooks.js";
import { DriverNav } from "./Nav.js";

const KIND: Record<string, string> = { checkout: "Parking", top_up: "Wallet top-up", refund: "Refund", allocation: "Credit from Availo" };
const STATUS: Record<string, { label: string; tone?: "ok" | "warn" | "bad" }> = {
  fulfilled: { label: "Paid", tone: "ok" },
  refund_due: { label: "Refunding", tone: "warn" },
  failed: { label: "Failed", tone: "bad" },
  queued: { label: "Refund queued", tone: "warn" },
  submitted: { label: "Refund sent", tone: "warn" },
  processed: { label: "Refunded", tone: "ok" },
  credited: { label: "Credited", tone: "ok" },
};

/** US-019: every payment, top-up and refund, with date, reference and amount; a PDF receipt for each, and a statement for any period. */
export function Payments() {
  const me = useMe();
  const items = useCached<PaymentItem[]>(() => api<PaymentItem[]>("GET", "/payments"), () => null, () => undefined);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string>();

  async function get(path: string, name: string) {
    setError(undefined);
    try { await download(path, name); } catch (e) { setError((e as Error).message); }
  }

  return (
    <Shell>
      <BrandBar right={items.offline ? <Chip tone="status" icon="offline">Offline</Chip> : undefined} />
      <main className="av-main tight">
        <h2 className="av-h2 xl">Payments</h2>
        {items.offline && !items.data ? <p className="av-note">Payment history needs a connection.</p> : null}
        {items.data && !items.data.length ? <p className="av-note">No payments yet.</p> : null}
        {items.data?.map((i) => {
          const st = STATUS[i.status];
          return (
            <div key={`${i.kind}-${i.id}`} className="av-item">
              <span className="main">
                <strong>{KIND[i.kind] ?? i.kind}{i.booking ? ` · ${watDay(i.booking.window.start)} ${watTime(i.booking.window.start)}` : ""}</strong>
                <small>{watDay(i.at)} {watTime(i.at)} · {i.booking?.reference ?? i.reference}{i.channel ? ` · ${i.channel.replace(/_/g, " ")}` : ""}</small>
                {i.receipt && i.paymentId ? (
                  <button type="button" className="av-link-btn" style={{ alignSelf: "flex-start", padding: "6px 0", minHeight: 44 }}
                    onClick={() => get(`/payments/${i.paymentId}/receipt.pdf`, `availo-receipt-${i.reference}.pdf`)}>
                    Receipt (PDF)
                  </button>
                ) : null}
              </span>
              <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                <strong>{naira(i.amountKobo)}</strong>
                {st ? <Chip {...(st.tone ? { tone: st.tone } : {})}>{st.label}</Chip> : null}
              </span>
            </div>
          );
        })}
        <div className="av-card">
          <div className="av-kicker">Statement</div>
          <div className="av-dates">
            <div className="av-field"><label htmlFor="from" className="av-label">From</label><div className="av-input"><input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div></div>
            <div className="av-field"><label htmlFor="to" className="av-label">To</label><div className="av-input"><input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div></div>
          </div>
          <span className="av-hint">Leave both empty for everything so far.</span>
          <button type="button" className="av-btn outline" onClick={() => {
            const q = new URLSearchParams();
            if (from) q.set("from", from);
            if (to) q.set("to", to);
            void get(`/statement.pdf${q.size ? `?${q}` : ""}`, `availo-statement-${from || "start"}-to-${to || "today"}.pdf`);
          }}><Icon name="receipt" size={20} />Download statement</button>
        </div>
        {error ? <div className="av-banner bad" role="alert">{error}</div> : null}
      </main>
      <DriverNav current={me.data?.paymentPath === "checkout" ? "wallet" : "account"} />
    </Shell>
  );
}
