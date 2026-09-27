import { useState } from "react";
import { BackBar, Button, Icon, Shell } from "@availo/ui";
import { useGate } from "../gate.js";
import { navigate } from "../router.js";

/** US-039: PIN fallback, large keys for one-handed outdoor use (NFR-ACC-06). */
export function Pin() {
  const g = useGate();
  const [pin, setPin] = useState("");
  const press = (d: string) => setPin((p) => (p + d).slice(0, 6));
  async function check() {
    const t0 = performance.now();
    const v = await g.device.client.enterPin(pin);
    g.setResult({ v, ms: performance.now() - t0, offline: !g.online });
    navigate("/result", true);
  }
  return (
    <Shell>
      <BackBar title="Enter PIN" onBack={() => navigate("/")} />
      <main className="av-main">
        <div className="av-pin" style={{ justifyContent: "center" }} aria-live="polite" aria-label={`PIN entered: ${pin.length} of 6 digits`}>
          {Array.from({ length: 6 }, (_, i) => <span key={i} style={{ color: "var(--ink)" }} aria-hidden="true">{pin[i] ?? ""}</span>)}
        </div>
        <div className="av-keypad">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => <button key={d} type="button" onClick={() => press(d)}>{d}</button>)}
          <button type="button" aria-label="Delete last digit" onClick={() => setPin((p) => p.slice(0, -1))}><Icon name="back" size={28} /></button>
          <button type="button" onClick={() => press("0")}>0</button>
          <button type="button" aria-label="Clear" onClick={() => setPin("")}><Icon name="x" size={28} /></button>
        </div>
        <div className="av-spacer" />
        <Button large disabled={pin.length !== 6} onClick={() => void check()}>Check PIN</Button>
      </main>
    </Shell>
  );
}
