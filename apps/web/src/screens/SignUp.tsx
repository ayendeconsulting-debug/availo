import { useState } from "react";
import { BrandBar, Button, Field, Shell } from "@availo/ui";
import { normaliseNigerianMobile } from "@availo/shared";
import { api, ApiError, OfflineError } from "../api.js";
import { flow } from "../flow.js";
import { navigate } from "../router.js";

type UserType = "staff" | "student" | "guest";
const TYPES: Array<{ key: UserType; label: string; sub: string }> = [
  { key: "staff", label: "Staff", sub: "Wallet" },
  { key: "student", label: "Student", sub: "Wallet" },
  { key: "guest", label: "Guest", sub: "Pay per booking" },
];
const HINTS: Record<UserType, string> = {
  staff: "Next, add your staff number and vehicle. You can then reserve campus and open bays.",
  student: "Next, add your matriculation number and vehicle. You can then reserve campus and open bays.",
  guest: "No campus ID needed. Add your vehicle and pay when you book. Guests use the open bays.",
};

/** D1 · Sign up. The same first step signs a returning driver in (US-001, US-002). */
export function SignUp() {
  const saved = flow.get();
  const [mobile, setMobile] = useState(saved.mobile ?? "");
  const [type, setType] = useState<UserType>(saved.userType ?? "staff");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const n = normaliseNigerianMobile(mobile.startsWith("0") || mobile.startsWith("+") ? mobile : `+234${mobile}`);
    if (!n.ok) { setError("Enter a Nigerian mobile number, for example 803 123 4567."); return; }
    setBusy(true);
    setError(undefined);
    try {
      await api("POST", "/auth/otp/request", { mobile: n.e164 }, { auth: false });
      flow.set({ mobile, e164: n.e164, userType: type });
      navigate("/code");
    } catch (err) {
      if (err instanceof ApiError && err.code === "OTP_RESEND_TOO_SOON") {
        flow.set({ mobile, e164: n.e164, userType: type });
        navigate("/code");
      } else setError(err instanceof OfflineError ? "No connection. Connect to the internet to sign up." : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <BrandBar />
      <section className="av-hero">
        <h1>Your space,<br /><em>booked</em> before<br />you arrive.</h1>
        <p>UNILAG Pilot Lot</p>
      </section>
      <div className="av-dashes" aria-hidden="true" />
      <form className="av-main" style={{ gap: 18, paddingTop: 22 }} onSubmit={send} noValidate>
        <Field label="Mobile number" prefix="+234" inputMode="tel" autoComplete="tel-national" placeholder="803 000 0000"
          value={mobile} onChange={(e) => setMobile(e.target.value)} error={error} />
        <fieldset className="av-fieldset">
          <legend>I&apos;m parking as</legend>
          <div className="av-choice-grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
            {TYPES.map((t) => (
              <button key={t.key} type="button" className="av-choice" style={{ minHeight: 64 }} aria-pressed={t.key === type} onClick={() => setType(t.key)}>
                <span className="big">{t.label}</span>
                <span className="sub">{t.sub}</span>
              </button>
            ))}
          </div>
          <p className="av-note" style={{ marginTop: 4 }}>{HINTS[type]}</p>
        </fieldset>
        <div className="av-spacer" />
        <Button type="submit" disabled={busy}>{busy ? "Sending…" : "Send code"}</Button>
        <p className="av-note" style={{ textAlign: "center", fontSize: 13 }}>We&apos;ll text a 6-digit code to confirm your number. Already registered? The same code signs you in.</p>
      </form>
    </Shell>
  );
}
