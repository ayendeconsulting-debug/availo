import { BrandBar, Chip, Shell, naira, watDay, watTime } from "@availo/ui";
import { api, type Wallet as W } from "../api.js";
import { useCached } from "../hooks.js";
import { DriverNav } from "./Nav.js";

const LABELS: Record<string, string> = {
  top_up: "Top-up", allocation: "Credit from Availo", reservation_debit: "Booking", extension_debit: "Extension",
  penalty: "Overstay charge", refund: "Refund", reversal: "Correction",
};

/** US-019: balance and history, each line with its running balance. Read only; top-up arrives in sprint 2. */
export function Wallet() {
  const w = useCached<W>(() => api<W>("GET", "/wallet"), () => null, () => undefined);
  return (
    <Shell>
      <BrandBar right={w.offline ? <Chip tone="status" icon="offline">Offline</Chip> : undefined} />
      <main className="av-main tight">
        <div className="av-wallet">
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div className="av-kicker kicker">Wallet</div>
            <div className="amount">{w.data ? naira(w.data.balanceKobo) : "—"}</div>
          </div>
        </div>
        <p className="av-note">Topping up with card, transfer or USSD arrives in the next release.</p>
        <div className="av-kicker">History</div>
        {w.offline && !w.data ? <p className="av-note">History needs a connection.</p> : null}
        {w.data?.entries.map((e) => (
          <div key={e.id} className="av-item">
            <span className="main">
              <strong>{LABELS[e.type] ?? e.type}</strong>
              <small>{watDay(e.at)} {watTime(e.at)} · {e.reference}</small>
            </span>
            <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
              <strong style={{ color: BigInt(e.amountKobo) < 0n ? "var(--ink)" : "var(--ok)" }}>{BigInt(e.amountKobo) > 0n ? "+" : ""}{naira(e.amountKobo)}</strong>
              <small className="muted" style={{ fontSize: 13 }}>{naira(e.balanceAfterKobo)}</small>
            </span>
          </div>
        ))}
      </main>
      <DriverNav current="wallet" />
    </Shell>
  );
}
