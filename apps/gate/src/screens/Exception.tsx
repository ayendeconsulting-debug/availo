import { useState } from "react";
import { BackBar, Button, Field, Shell } from "@availo/ui";
import { useGate } from "../gate.js";
import { navigate } from "../router.js";

/** US-041: a manual exception, with a mandatory reason, always sent for review. */
export function Exception() {
  const g = useGate();
  const mismatch = new URLSearchParams(location.search).has("mismatch");
  const last = g.result;
  const [kind, setKind] = useState<"entry" | "exit">("entry");
  const [plate, setPlate] = useState("");
  const [reason, setReason] = useState(mismatch ? "Arriving plate does not match the booking" : "");
  const [error, setError] = useState<string>();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      await g.device.client.recordManualException({
        kind, plate, reason, deviceResult: last?.v.status ?? "NONE",
        ...(last && "pass" in last.v ? { passId: last.v.pass.passId } : {}),
      });
      g.setResult(null);
      g.bump();
      void g.sync();
      navigate("/", true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Shell>
      <BackBar title="Record an exception" onBack={() => navigate("/")} />
      <form className="av-main" onSubmit={save} noValidate>
        <p className="av-note">Use this only when the normal checks can&apos;t be followed. Operations reviews every exception.</p>
        <fieldset className="av-fieldset">
          <legend>What is happening?</legend>
          <div className="av-choice-grid" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
            <button type="button" className="av-choice" aria-pressed={kind === "entry"} onClick={() => setKind("entry")}><span className="big">Letting in</span></button>
            <button type="button" className="av-choice" aria-pressed={kind === "exit"} onClick={() => setKind("exit")}><span className="big">Letting out</span></button>
          </div>
        </fieldset>
        <Field label="Plate of the car at the gate" big autoCapitalize="characters" value={plate} onChange={(e) => setPlate(e.target.value)} />
        <Field label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} error={error} hint="Required. Say what you saw and who you spoke to." />
        <div className="av-spacer" />
        <Button type="submit" large disabled={!plate.trim() || reason.trim().length < 3}>Record exception</Button>
      </form>
    </Shell>
  );
}
