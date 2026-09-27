import { useState } from "react";
import { Button, Icon, Row, Shell, ResultBanner, displayPlate, watTime, type ResultTone } from "@availo/ui";
import type { NextAction } from "@availo/gate-client";
import { useGate } from "../gate.js";
import { navigate } from "../router.js";
import { GateBar } from "./common.js";

type Look = { tone: ResultTone; label: string; icon: "check" | "clock" | "x" | "alert" | "exit" };
const LOOK: Record<string, Look> = {
  VALID: { tone: "ok", label: "VALID", icon: "check" },
  NOT_YET_DUE: { tone: "warn", label: "NOT YET DUE", icon: "clock" },
  EXPIRED: { tone: "bad", label: "EXPIRED", icon: "clock" },
  CANCELLED: { tone: "bad", label: "CANCELLED", icon: "x" },
  WRONG_LOT: { tone: "bad", label: "WRONG LOT", icon: "x" },
  NOT_FOUND: { tone: "bad", label: "NOT FOUND", icon: "x" },
  STALE_CODE: { tone: "warn", label: "OLD CODE", icon: "alert" },
};

/**
 * T2 / T3 · the answer after a scan, PIN or plate search (US-038, US-040, US-041).
 * One unambiguous result, what the attendant may see, and always a next step.
 */
export function Result() {
  const g = useGate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const r = g.result;
  if (!r) { queueMicrotask(() => navigate("/", true)); return null; }
  const { v } = r;
  const pass = "pass" in v ? v.pass : null;
  const look = v.onSite && pass ? { tone: "neutral" as const, label: "ON SITE", icon: "exit" as const } : LOOK[v.status]!;

  const sub = (() => {
    if (v.onSite && pass) return `Entered earlier · booked until ${watTime(pass.end)}`;
    if (v.status === "VALID") return `Verified ${r.offline ? "offline" : "on this phone"} in ${r.ms < 100 ? "under 0.1" : (r.ms / 1000).toFixed(1)} s`;
    if (!pass) return v.status === "WRONG_LOT" ? "This pass is for a different lot" : "No booking on this phone matches";
    if (v.status === "NOT_YET_DUE") return `Starts ${watTime(pass.start)} · entry opens a little before`;
    if (v.status === "EXPIRED") return `Time ended ${watTime(pass.end)}`;
    if (v.status === "STALE_CODE") return "This code is too old — it may be a screenshot";
    return "This booking was cancelled";
  })();

  async function record(kind: "entry" | "exit") {
    setBusy(true);
    setError(undefined);
    try {
      if (kind === "entry") await g.device.client.recordEntry(v, true);
      else await g.device.client.recordExit(v);
      g.setResult(null);
      g.bump();
      void g.sync();
      navigate("/", true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const action = (a: NextAction) => {
    switch (a) {
      case "record_entry": return null;
      case "record_exit": return null;
      case "ask_for_live_pass": return <Button key={a} large icon="scan" onClick={() => navigate("/scan", true)}>Scan the live pass</Button>;
      case "try_pin": return <Button key={a} variant="outline" small icon="keypad" onClick={() => navigate("/pin", true)}>Try PIN</Button>;
      case "search_plate": return <Button key={a} variant="outline" small icon="search" onClick={() => navigate("/plate", true)}>Search plate</Button>;
      case "contact_operations": return OPS_PHONE
        ? <a key={a} className="av-btn outline small" href={`tel:${OPS_PHONE}`}><Icon name="phone" />Call operations</a>
        : null;
      case "manual_exception": return <button key={a} type="button" className="av-link" onClick={() => navigate("/exception", true)}>Record an exception</button>;
    }
  };
  const small = v.actions.filter((a) => a === "try_pin" || a === "search_plate" || a === "contact_operations").map(action).filter(Boolean);

  return (
    <Shell>
      <GateBar />
      <ResultBanner tone={look.tone} status={look.label} sub={sub} icon={look.icon} />
      <main className="av-main" style={{ gap: 14 }}>
        {pass ? (
          <>
            {v.actions.includes("record_entry") ? <div style={{ fontSize: 14, fontWeight: 600, textAlign: "center", color: "var(--muted)" }}>Check the plate matches the car</div> : null}
            <div className="av-plate">{displayPlate(pass.plate)}</div>
            <div className="av-card">
              <Row label="Driver" value={pass.driverName} />
              <Row label="Booked" value={`${watTime(pass.start)}–${watTime(pass.end)}`} />
              <Row label="Lot" value={g.device.client.current?.lotName ?? ""} />
            </div>
            {pass.accessible ? <div className="av-access-banner"><Icon name="access" size={28} />Accessible bay</div> : null}
          </>
        ) : null}
        {error ? <div className="av-banner bad" role="alert">{error}</div> : null}
        <div className="av-spacer" />
        {v.actions.includes("record_entry") ? (
          <>
            <Button large icon="entry" disabled={busy} onClick={() => void record("entry")}>Record entry</Button>
            <Button variant="outline" onClick={() => navigate("/exception?mismatch=1", true)}>Plate doesn&apos;t match</Button>
          </>
        ) : null}
        {v.actions.includes("record_exit") ? <Button large icon="exit" disabled={busy} onClick={() => void record("exit")}>Record exit</Button> : null}
        {v.actions.includes("ask_for_live_pass") ? action("ask_for_live_pass") : null}
        {small.length ? <div className="av-btn-grid">{small}</div> : null}
        {v.actions.includes("manual_exception") ? action("manual_exception") : null}
        <button type="button" className="av-link" onClick={() => { g.setResult(null); navigate("/", true); }}>Back to gate</button>
      </main>
    </Shell>
  );
}

const OPS_PHONE = import.meta.env.VITE_OPS_PHONE as string | undefined;
