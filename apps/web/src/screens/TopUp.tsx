import { useEffect, useState } from "react";
import { BackBar, Icon, Row, Shell, naira } from "@availo/ui";
import { api, OfflineError, type TopUp as T, type Wallet, type WalletRules } from "../api.js";
import { navigate } from "../router.js";

const PRESETS = [200_000n, 500_000n, 1_000_000n]; // ₦2,000 · ₦5,000 · ₦10,000
const RETURN_KEY = "av.topup.return";

/**
 * Top up wallet (US-016, US-015; prototype TopUp). The amount and the new balance
 * are shown before paying; the limits come from configuration. Payment happens
 * on the provider's secure page. The balance moves only after the API has
 * verified the payment with the provider.
 */
export function TopUp() {
  const params = new URLSearchParams(location.search);
  const suggested = params.get("amount");
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [rules, setRules] = useState<WalletRules | null>(null);
  const [amount, setAmount] = useState<bigint>(() => (suggested && /^\d+$/.test(suggested) ? roundUp(BigInt(suggested)) : 500_000n));
  const [custom, setCustom] = useState(() => (suggested && !PRESETS.includes(roundUp(BigInt(suggested))) ? String(Number(roundUp(BigInt(suggested))) / 100) : ""));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => crypto.randomUUID());

  useEffect(() => {
    // Where to go once the money lands: back to the booking that was short, if that's where we came from.
    try { sessionStorage.setItem(RETURN_KEY, params.get("return") ?? "/wallet"); } catch { /* ignore */ }
    Promise.all([api<Wallet>("GET", "/wallet"), api<WalletRules>("GET", "/wallet/rules")])
      .then(([w, r]) => { setWallet(w); setRules(r); })
      .catch((e) => setError(e instanceof OfflineError ? "Topping up needs a connection." : (e as Error).message));
  }, []);

  const min = rules ? BigInt(rules.minTopUpKobo) : 0n;
  const max = rules ? BigInt(rules.maxTopUpKobo) : 0n;
  const outOfRange = rules !== null && (amount < min || amount > max);

  async function pay() {
    setBusy(true);
    setError(undefined);
    try {
      const t = await api<T>("POST", "/top-ups", { amountKobo: amount.toString() }, { idempotencyKey: key });
      if (t.authorizationUrl) location.assign(t.authorizationUrl);
      else navigate(`/wallet/return?payment=${t.paymentId}`, true);
    } catch (e) {
      setError(e instanceof OfflineError ? "No connection. Nothing was charged." : (e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Shell>
      <BackBar title="Top up wallet" onBack={() => navigate("/wallet")} />
      <main className="av-main">
        <div className="av-total"><span style={{ color: "var(--muted)" }}>Current balance</span><span className="amount" style={{ fontSize: 26 }}>{wallet ? naira(wallet.balanceKobo) : "—"}</span></div>
        <fieldset className="av-fieldset">
          <legend>Amount</legend>
          <div className="av-amounts">
            {PRESETS.map((v) => (
              <button key={v.toString()} type="button" aria-pressed={!custom && amount === v} onClick={() => { setCustom(""); setAmount(v); }}>{naira(v)}</button>
            ))}
          </div>
        </fieldset>
        <div className="av-field">
          <label htmlFor="other" className="av-label">Another amount</label>
          <div className="av-input big">
            <span className="prefix">₦</span>
            <input id="other" inputMode="numeric" autoComplete="off" value={custom} placeholder="e.g. 3000"
              onChange={(e) => { const v = e.target.value.replace(/[^\d]/g, "").slice(0, 7); setCustom(v); if (v) setAmount(BigInt(v) * 100n); }} />
          </div>
          {rules ? <span className={`av-hint${outOfRange ? " bad" : ""}`}>Between {naira(rules.minTopUpKobo)} and {naira(rules.maxTopUpKobo)}.</span> : null}
        </div>
        <div className="av-card">
          <Row label="New balance" value={wallet ? naira(BigInt(wallet.balanceKobo) + amount) : "—"} />
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
        {error ? <div className="av-banner bad" role="alert">{error}</div> : null}
        <div className="av-spacer" />
        <button type="button" className="av-btn" onClick={pay} disabled={busy || !rules || outOfRange || amount <= 0n}>
          {busy ? "Opening payment…" : `Pay ${naira(amount)}`}
        </button>
        <p className="av-secure"><Icon name="lock" size={14} />Paid through Paystack. Availo never sees or stores card details.</p>
      </main>
    </Shell>
  );
}

/** Back from the payment page: verify with the API, which verifies with the provider. */
export function TopUpReturn({ paymentId }: { paymentId: string }) {
  const [t, setT] = useState<T | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    let tries = 0;
    const check = async () => {
      try {
        const v = await api<T>("POST", `/top-ups/${paymentId}/verify`);
        if (!live) return;
        setT(v);
        if (v.state === "pending" && ++tries < 15) setTimeout(check, 2000);
      } catch (e) {
        if (live) setError(e instanceof OfflineError ? "No connection. If you paid, your top-up is safe and will show when you're back online." : (e as Error).message);
      }
    };
    void check();
    return () => { live = false; };
  }, [paymentId]);

  let back = "/wallet";
  try { back = sessionStorage.getItem(RETURN_KEY) ?? "/wallet"; } catch { /* ignore */ }
  const pending = !t || t.state === "pending";
  return (
    <Shell>
      <BackBar title="Top up wallet" onBack={() => navigate("/wallet", true)} />
      <main className="av-main">
        {error ? <div className="av-banner bad" role="alert">{error}</div>
          : pending ? <div className="av-banner warn" role="status">Confirming your payment with the bank… This can take a minute for a bank transfer.</div>
          : t.state === "credited" ? <div className="av-banner ok" role="status">{naira(t.amountKobo)} added. Your balance is {naira(t.balanceKobo)}.</div>
          : t.state === "refund_due" ? <div className="av-banner warn" role="status">We received a payment we couldn&apos;t add to your wallet. A full refund is on its way.</div>
          : <div className="av-banner bad" role="status">The payment didn&apos;t go through. Nothing was charged.</div>}
        <div className="av-spacer" />
        <button type="button" className="av-btn" disabled={pending && !error} onClick={() => navigate(t?.state === "credited" ? back : "/wallet", true)}>
          {t?.state === "credited" && back === "/reserve" ? "Back to your booking" : "Done"}
        </button>
      </main>
    </Shell>
  );
}

/** A shortfall is rounded up to whole naira, and to at least the smallest top-up preset worth offering. */
function roundUp(kobo: bigint): bigint {
  const n = ((kobo + 99n) / 100n) * 100n;
  return n < 50_000n ? 50_000n : n;
}
