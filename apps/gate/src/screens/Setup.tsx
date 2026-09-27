import { useState } from "react";
import { BrandBar, Button, Field, Shell } from "@availo/ui";
import { normaliseNigerianMobile } from "@availo/shared";
import { NetworkError } from "@availo/gate-client";
import type { Device } from "../device.js";

/** First run: enrol this phone with the one-time code from operations, then sign in by OTP (US-055). */
export function Setup({ device, onReady }: { device: Device; onReady: () => void }) {
  const [step, setStep] = useState<"enrol" | "mobile" | "code">(device.enrolled ? "mobile" : "enrol");
  const [enrolCode, setEnrolCode] = useState("");
  const [mobile, setMobile] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try { await fn(); } catch (e) { setError(e instanceof NetworkError ? "No connection. Setting up a gate phone needs signal once." : (e as Error).message); } finally { setBusy(false); }
  }
  const e164 = () => {
    const n = normaliseNigerianMobile(mobile.startsWith("0") || mobile.startsWith("+") ? mobile : `+234${mobile}`);
    if (!n.ok) throw new Error("Enter a Nigerian mobile number.");
    return n.e164;
  };

  return (
    <Shell>
      <BrandBar gate />
      <div className="av-dashes" aria-hidden="true" />
      {step === "enrol" ? (
        <form className="av-main" onSubmit={(e) => { e.preventDefault(); void run(async () => { await device.enrol(enrolCode); setStep("mobile"); }); }}>
          <h2 className="av-h2 xl">Set up this gate phone</h2>
          <p className="av-note">Enter the enrolment code from the operations team. It works once.</p>
          <Field label="Enrolment code" big autoCapitalize="characters" autoComplete="off" value={enrolCode} onChange={(e) => setEnrolCode(e.target.value)} error={error} placeholder="XXXXX-XXXXX" />
          <div className="av-spacer" />
          <Button type="submit" large disabled={busy}>{busy ? "Enrolling…" : "Enrol phone"}</Button>
        </form>
      ) : step === "mobile" ? (
        <form className="av-main" onSubmit={(e) => { e.preventDefault(); void run(async () => { await device.requestCode(e164()); setStep("code"); }); }}>
          <h2 className="av-h2 xl">Attendant sign-in</h2>
          <Field label="Your mobile number" prefix="+234" inputMode="tel" value={mobile} onChange={(e) => setMobile(e.target.value)} error={error} placeholder="803 000 0000" />
          <div className="av-spacer" />
          <Button type="submit" large disabled={busy}>{busy ? "Sending…" : "Send code"}</Button>
        </form>
      ) : (
        <form className="av-main" onSubmit={(e) => { e.preventDefault(); void run(async () => { await device.signIn(e164(), code); onReady(); }); }}>
          <h2 className="av-h2 xl">Enter your code</h2>
          <Field label="Code" big inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} error={error} style={{ letterSpacing: "0.4em", textAlign: "center" }} />
          <div className="av-spacer" />
          <Button type="submit" large disabled={busy}>{busy ? "Checking…" : "Sign in"}</Button>
          <button type="button" className="av-link" onClick={() => setStep("mobile")}>Use a different number</button>
        </form>
      )}
    </Shell>
  );
}
