import { useEffect, useRef, useState } from "react";
import { BackBar, Icon, Row, Shell, displayPlate, naira, watDay, watTime } from "@availo/ui";
import { api, ApiError, OfflineError, type Checkout as C } from "../api.js";
import { useLot, useMe } from "../hooks.js";
import { navigate } from "../router.js";

const POOL: Record<string, string> = { open: "Open bay", campus: "Campus bay", accessible: "Accessible bay" };
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

/**
 * Pay for your booking (US-134, US-135; prototype GuestCheckout).
 *
 * The space is held while the driver pays; the timer counts the hold down. Paying
 * happens on the provider's secure page — card, bank transfer or USSD — so no card
 * detail ever enters this app. Coming back, the app asks the API to verify with the
 * provider; the outcome is never taken from the redirect itself.
 */
export function Checkout({ holdId, returning }: { holdId: string; returning?: boolean }) {
  const lot = useLot();
  const me = useMe();
  const [c, setC] = useState<C | null>(null);
  const [left, setLeft] = useState(0);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(!!returning);
  const deadline = useRef(0);

  function take(v: C) {
    setC(v);
    deadline.current = Date.now() + v.secondsLeft * 1000;
    setLeft(v.secondsLeft);
    if (v.state === "confirmed" && v.reservationId) navigate(`/pass/${v.reservationId}`, true);
  }

  // Load, or — back from the payment page — verify, then keep asking for a short while: a bank
  // transfer can take a moment to land, and the provider's webhook may arrive first anyway.
  useEffect(() => {
    let live = true;
    let tries = 0;
    const load = async () => {
      try {
        const v = await api<C>(returning ? "POST" : "GET", `/checkouts/${holdId}${returning ? "/verify" : ""}`);
        if (!live) return;
        take(v);
        if (returning && v.state === "held" && ++tries < 15) setTimeout(load, 2000);
        else setChecking(false);
      } catch (e) {
        if (!live) return;
        setChecking(false);
        setError(e instanceof OfflineError ? "No connection. Your payment, if made, is safe — open this page again when you have signal." : (e as Error).message);
      }
    };
    void load();
    return () => { live = false; };
  }, [holdId, returning]);

  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, Math.round((deadline.current - Date.now()) / 1000))), 1000);
    return () => clearInterval(t);
  }, []);

  async function cancel() {
    setBusy(true);
    try {
      await api<C>("DELETE", `/checkouts/${holdId}`);
      navigate("/home", true);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const held = c?.state === "held" && left > 0;
  const plate = me.data?.vehicles[0]?.plate;
  const parking = c ? BigInt(c.parkingKobo) : 0n;

  return (
    <Shell>
      <BackBar title="Pay for your booking" onBack={() => navigate("/reserve")} />
      {held ? (
        <>
          <section className={`av-hold${left < 120 ? " low" : ""}`} aria-live="polite">
            <span style={{ display: "flex", color: "var(--line)" }}><Icon name="clock" size={30} color="#F4C21B" /></span>
            <div className="msg">We&apos;re holding your space. Pay before the timer runs out.</div>
            <div className="timer" role="timer" aria-label={`${Math.floor(left / 60)} minutes ${left % 60} seconds left`}>{mmss(left)}</div>
          </section>
          <div className="av-dash" aria-hidden="true" />
        </>
      ) : null}
      <main className="av-main tight">
        {checking ? <div className="av-banner warn" role="status">Confirming your payment with the bank…</div> : null}
        {c && !checking ? <Outcome c={c} expired={c.state === "held" && left === 0} /> : null}
        {c ? (
          <div className="av-card">
            <Row label="Where" value={`${lot.data?.name ?? "Pilot lot"} · ${POOL[c.pool] ?? c.pool}`} />
            <Row label="When" value={`${watDay(c.window.start)} · ${watTime(c.window.start)}–${watTime(c.window.end)}`} />
            {plate ? <Row label="Vehicle" value={displayPlate(plate)} /> : null}
            <div className="av-rule" />
            <Row label={`${c.hours} h × ${naira(c.rateKobo)}`} value={naira(parking)} />
            {BigInt(c.serviceFeeKobo) > 0n ? <Row label="Service fee" value={naira(c.serviceFeeKobo)} /> : null}
            <div className="av-total"><strong>Total</strong><span className="amount">{naira(c.amountKobo)}</span></div>
          </div>
        ) : null}
        {held ? (
          <>
            <div className="av-card">
              <div className="av-terms">
                <div><Icon name="exit" size={18} /><span>No refund if you leave before your time ends.</span></div>
                <div><Icon name="clock" size={18} /><span>Grace period and overstay charge: [to be set by the pilot operator].</span></div>
                <div><Icon name="calendar" size={18} /><span>Cancelling before you arrive: [policy to be set].</span></div>
              </div>
            </div>
            <div className="av-field">
              <span className="av-label">Pay with</span>
              <div className="av-methods">
                <span><Icon name="card" size={18} />Card</span>
                <span><Icon name="bank" size={18} />Bank transfer</span>
                <span><Icon name="keypad" size={18} />USSD</span>
              </div>
              <span className="av-hint">You choose on the next screen.</span>
            </div>
          </>
        ) : null}
        {error ? <div className="av-banner bad" role="alert">{error}</div> : null}
        <div className="av-spacer" />
        {held && c?.payment?.authorizationUrl ? (
          <>
            <a className="av-btn" href={c.payment.authorizationUrl}><Icon name="lock" size={20} />Pay {naira(c.amountKobo)}</a>
            <p className="av-secure"><Icon name="lock" size={14} />Paid through Paystack. Availo never sees or stores card details.</p>
            <button type="button" className="av-link-btn" onClick={cancel} disabled={busy}>Cancel and release the space</button>
          </>
        ) : c && c.state !== "confirmed" && !checking ? (
          <a className="av-btn" href="/reserve" onClick={(e) => { e.preventDefault(); navigate("/reserve", true); }}>Choose a time again</a>
        ) : null}
      </main>
    </Shell>
  );
}

/** Plain words for every way a checkout can end (NFR-ACC-07). */
function Outcome({ c, expired }: { c: C; expired: boolean }) {
  if (c.state === "held" && !expired) return null;
  const [tone, text] =
    c.state === "failed" ? ["bad", "The payment didn't go through, so the space has been released. Nothing was charged."]
    : c.state === "cancelled" ? ["warn", "You cancelled this checkout and the space was released. If a payment still completes, it will be refunded in full."]
    : c.state === "refund_due" ? ["warn", `We received your payment but couldn't keep the booking: ${c.payment?.note ?? ""} A full refund is on its way to the card or account you paid from.`]
    : ["warn", "Your hold ran out before payment completed, so the space was released. If you did pay, we'll book it if a space is still free, or refund you in full."];
  return <div className={`av-banner ${tone}`} role="status">{text}</div>;
}

/** Starts a checkout from the Reserve screen. Resumes one already open rather than starting a second. */
export async function startCheckout(body: { lotId: string; vehicleId: string; start: string; hours: number }, key: string): Promise<string> {
  try {
    const c = await api<C>("POST", "/checkouts", body, { idempotencyKey: key });
    return c.holdId;
  } catch (e) {
    if (e instanceof ApiError && e.code === "CHECKOUT_IN_PROGRESS" && typeof e.detail.holdId === "string") return e.detail.holdId;
    throw e;
  }
}
