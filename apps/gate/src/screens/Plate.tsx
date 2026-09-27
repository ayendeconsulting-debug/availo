import { useEffect, useState } from "react";
import { BackBar, Field, Icon, Shell, displayPlate, watTime } from "@availo/ui";
import type { Verification } from "@availo/gate-client";
import { useGate } from "../gate.js";
import { navigate } from "../router.js";

const STATUS: Record<string, string> = { VALID: "Valid now", NOT_YET_DUE: "Not yet due", EXPIRED: "Expired", CANCELLED: "Cancelled" };

/** US-039: plate search, tolerant of spacing and separators, partial entry gives candidates. */
export function Plate() {
  const g = useGate();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Verification[]>([]);
  useEffect(() => { void g.device.client.searchPlate(q).then(setResults); }, [q, g.device]);
  return (
    <Shell>
      <BackBar title="Search plate" onBack={() => navigate("/")} />
      <main className="av-main">
        <Field label="Plate" big autoCapitalize="characters" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} hint="Type part of the plate. Spaces and dashes don't matter." />
        {q.length >= 2 && results.length === 0 ? <p className="av-note" role="status">No booking on this phone matches.</p> : null}
        {results.map((v) => "pass" in v ? (
          <button key={v.pass.passId} type="button" className="av-item" style={{ cursor: "pointer", textAlign: "left", font: "inherit" }}
            onClick={() => { g.setResult({ v, ms: 0, offline: !g.online }); navigate("/result", true); }}>
            <span className="plate">{displayPlate(v.pass.plate)}</span>
            <span className="main" style={{ alignItems: "flex-end", flexGrow: 0 }}>
              <strong>{v.onSite ? "On site" : STATUS[v.status] ?? v.status}</strong>
              <small>{watTime(v.pass.start)}–{watTime(v.pass.end)}</small>
            </span>
            <Icon name="forward" size={18} />
          </button>
        ) : null)}
      </main>
    </Shell>
  );
}
