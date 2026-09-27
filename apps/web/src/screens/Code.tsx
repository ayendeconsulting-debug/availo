import { useEffect, useState } from "react";
import { BackBar, Button, Field, Shell } from "@availo/ui";
import { api, ApiError, OfflineError, session } from "../api.js";
import { flow } from "../flow.js";
import { navigate } from "../router.js";

/** Confirm the number with the 6-digit code (US-001). */
export function Code() {
  const f = flow.get();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(60);
  useEffect(() => {
    if (!f.e164) navigate("/", true);
    const t = setInterval(() => setWait((w) => Math.max(0, w - 1)), 1000);
    return () => clearInterval(t);
  }, [f.e164]);

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) { setError("Enter the 6 digits from the text message."); return; }
    setBusy(true);
    setError(undefined);
    try {
      const r = await api<{ status: string; registrationToken?: string; accessToken?: string; refreshToken?: string }>("POST", "/auth/otp/verify", { mobile: f.e164, code }, { auth: false });
      if (r.status === "signed_in") {
        session.save({ accessToken: r.accessToken!, refreshToken: r.refreshToken! });
        flow.clear();
        navigate("/home", true);
      } else {
        flow.set({ registrationToken: r.registrationToken! });
        navigate("/details", true);
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === "OTP_INCORRECT") setError(`That code is not right. ${String(err.detail.attemptsRemaining)} attempts left.`);
      else setError(err instanceof OfflineError ? "No connection. Try again when you have signal." : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setError(undefined);
    try {
      await api("POST", "/auth/otp/request", { mobile: f.e164 }, { auth: false });
      setWait(60);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Shell>
      <BackBar title="Enter your code" onBack={() => navigate("/")} />
      <form className="av-main" onSubmit={verify} noValidate>
        <p className="av-note" style={{ fontSize: 15, color: "var(--ink)" }}>We sent a 6-digit code to <strong>{f.e164 ? displayPhone(f.e164) : ""}</strong>. It expires in 5 minutes.</p>
        <Field label="Code" big inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="••••••"
          value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} error={error}
          style={{ letterSpacing: "0.4em", textAlign: "center", fontSize: 30 }} />
        <button type="button" className="av-link" onClick={resend} disabled={wait > 0}>
          {wait > 0 ? `Send a new code in ${wait} s` : "Send a new code"}
        </button>
        <div className="av-spacer" />
        <Button type="submit" disabled={busy}>{busy ? "Checking…" : "Continue"}</Button>
      </form>
    </Shell>
  );
}

function displayPhone(e164: string): string {
  const n = e164.replace("+234", "");
  return `+234 ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
}
