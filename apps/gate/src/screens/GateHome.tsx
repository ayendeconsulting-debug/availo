import { useEffect, useState } from "react";
import { Icon, Shell, displayPlate, watTime } from "@availo/ui";
import { useGate } from "../gate.js";
import { navigate } from "../router.js";
import { GateBar } from "./common.js";

/**
 * T1 · Gate home (US-037): expected today, on site, overstaying, and three
 * actions. Nothing else — no revenue, no balances. Every figure comes from this
 * phone's own copy, so it reads the same with or without signal.
 */
export function GateHome() {
  const g = useGate();
  const [onSite, setOnSite] = useState<Map<string, string>>(new Map());
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    void g.device.client.onSite().then(setOnSite);
    void g.device.client.touched().then(setTouched);
  }, [g.version, g.device]);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t); }, []);

  const cache = g.device.client.current;
  const passes = cache?.passes ?? [];
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(now);
  const dayOf = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date(iso));
  // Still to arrive: booked for today, not ended, and not yet in (or in and out) by the server's or this phone's records.
  const expected = passes.filter((p) => p.status === "active" && dayOf(p.start) === today && new Date(p.end) > now
    && !onSite.has(p.passId) && !p.exited && !touched.has(p.passId)).length;
  const overstaying = passes.filter((p) => onSite.has(p.passId) && new Date(p.end) <= now);

  return (
    <Shell>
      <GateBar />
      <main className="av-main">
        {!cache ? <div className="av-banner bad" role="alert">No passes on this phone. Connect to download today&apos;s passes.</div> : null}
        {g.needsSignIn ? (
          <div className="av-banner warn" role="status">Sign in again to send records. Checking passes still works. <button type="button" className="av-link" style={{ display: "inline" }} onClick={() => navigate("/signin")}>Sign in</button></div>
        ) : null}
        <div className="av-stats">
          <div className="av-stat"><b>{expected}</b><span>Expected today</span></div>
          <div className="av-stat"><b>{onSite.size}</b><span>On site</span></div>
          <div className="av-stat"><b className={overstaying.length ? "warn" : ""}>{overstaying.length}</b><span>Overstaying</span></div>
        </div>
        <button type="button" className="av-scan" onClick={() => navigate("/scan")} disabled={!cache}>
          <Icon name="scan" size={56} color="#1E2124" strokeWidth={2.2} />Scan pass
        </button>
        <div className="av-btn-grid">
          <button type="button" className="av-btn outline" style={{ minHeight: 64, fontSize: 20 }} onClick={() => navigate("/pin")} disabled={!cache}><Icon name="keypad" />Enter PIN</button>
          <button type="button" className="av-btn outline" style={{ minHeight: 64, fontSize: 20 }} onClick={() => navigate("/plate")} disabled={!cache}><Icon name="search" />Search plate</button>
        </div>
        {overstaying.length || g.pending || g.flagged.length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="av-kicker">Needs attention</div>
            {overstaying.map((p) => (
              <div key={p.passId} className="av-item">
                <span className="plate">{displayPlate(p.plate)}</span>
                <span className="av-chip warn">Time ended {watTime(p.end)}</span>
              </div>
            ))}
            {g.pending ? (
              <div className="av-item"><Icon name="sync" /><span className="main"><strong>{g.pending} {g.pending === 1 ? "record" : "records"} waiting to send</strong><small>They send automatically when there is signal.</small></span></div>
            ) : null}
            {g.flagged.length ? (
              <div className="av-item"><Icon name="alert" /><span className="main"><strong>{g.flagged.length} sent for review</strong><small>Operations will check {g.flagged.length === 1 ? "it" : "them"}. Nothing more to do here.</small></span></div>
            ) : null}
          </div>
        ) : null}
        <div className="av-spacer" />
        <button type="button" className="av-link" onClick={() => navigate("/exception")}>Record an exception</button>
      </main>
    </Shell>
  );
}
