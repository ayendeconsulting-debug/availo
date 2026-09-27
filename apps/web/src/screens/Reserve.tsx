import { useEffect, useMemo, useState } from "react";
import { BackBar, Bays, Icon, Row, Shell, naira } from "@availo/ui";
import { api, ApiError, OfflineError, type Availability, type Booking } from "../api.js";
import { useLot, useMe } from "../hooks.js";
import { navigate } from "../router.js";

const POOL_LABEL: Record<string, string> = { campus: "campus", open: "open", accessible: "accessible" };
const FIRST_HOUR = 6;
const LAST_START = 21;

/** Lagos is UTC+1 all year (no daylight saving), so a WAT wall-clock time maps to one fixed offset. */
function watDate(daysAhead: number): { y: number; m: number; d: number; label: string } {
  const lagos = new Date(Date.now() + 3_600_000 + daysAhead * 86_400_000);
  const y = lagos.getUTCFullYear(), m = lagos.getUTCMonth() + 1, d = lagos.getUTCDate();
  const label = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric" }).format(lagos);
  return { y, m, d, label };
}
const iso = (day: { y: number; m: number; d: number }, hour: number) =>
  `${day.y}-${String(day.m).padStart(2, "0")}-${String(day.d).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00+01:00`;

/**
 * D5 · Reserve hours (US-022). Shows only the capacity this driver may book,
 * the cost at the rate in force, the wallet before and after, and the terms,
 * before anything is confirmed. Capacity and payment commit together.
 * Opening hours per lot (US-011) are not modelled yet; start times run 06:00–21:00.
 */
export function Reserve() {
  const me = useMe();
  const lot = useLot();
  const days = useMemo(() => [0, 1, 2, 3].map(watDate), []);
  const nowWatHour = new Date(Date.now() + 3_600_000).getUTCHours();
  const [dayIdx, setDayIdx] = useState(nowWatHour >= LAST_START ? 1 : 0);
  const firstStart = dayIdx === 0 ? Math.max(FIRST_HOUR, nowWatHour + 1) : FIRST_HOUR;
  const [startHour, setStartHour] = useState(Math.max(9, firstStart));
  const [hours, setHours] = useState(3);
  const [quote, setQuote] = useState<Availability | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => crypto.randomUUID());
  const hour = Math.max(startHour, firstStart);
  const start = iso(days[dayIdx]!, hour);

  useEffect(() => {
    if (!lot.data) return;
    let live = true;
    setError(undefined);
    api<Availability>("GET", `/lots/${lot.data.id}/availability?start=${encodeURIComponent(start)}&hours=${hours}`)
      .then((q) => { if (live) setQuote(q); })
      .catch((e) => { if (live) setError(e instanceof OfflineError ? "Booking needs a connection." : (e as Error).message); });
    return () => { live = false; };
  }, [lot.data?.id, start, hours]);

  const vehicle = me.data?.vehicles[0];
  const pool = quote?.pools.find((p) => p.available > 0) ?? quote?.pools[0];
  const endHour = hour + hours;
  const short = quote?.balanceAfterKobo != null && BigInt(quote.balanceAfterKobo) < 0n;

  async function reserve() {
    if (!lot.data || !vehicle) return;
    setBusy(true);
    setError(undefined);
    try {
      const b = await api<Booking>("POST", "/reservations", { lotId: lot.data.id, vehicleId: vehicle.id, start, hours }, { idempotencyKey: key });
      navigate(`/pass/${b.id}`, true);
    } catch (e) {
      if (e instanceof ApiError && e.code === "INSUFFICIENT_BALANCE") setError(`Your balance is ${naira(String(e.detail.shortfallKobo ?? 0))} short. Wallet top-up arrives in the next release.`);
      else setError(e instanceof OfflineError ? "No connection. Nothing was booked or charged." : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <BackBar title="Reserve a space" onBack={() => navigate("/home")} />
      <main className="av-main">
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 600 }}>
          <span style={{ display: "flex", color: "var(--muted)" }}><Icon name="pin-map" size={18} /></span>
          {lot.data?.name ?? "UNILAG Pilot Lot"}{pool ? ` · ${POOL_LABEL[pool.kind]} bay` : ""}
        </div>
        <fieldset className="av-fieldset">
          <legend>Day</legend>
          <div className="av-choice-grid" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
            {days.map((d, i) => (
              <button key={d.label} type="button" className="av-choice" aria-pressed={i === dayIdx} onClick={() => setDayIdx(i)} disabled={i === 0 && nowWatHour >= LAST_START}>
                <span className="day">{d.label}</span>
              </button>
            ))}
          </div>
        </fieldset>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
          <div className="av-field">
            <label htmlFor="start" className="av-label">Arrive from</label>
            <div className="av-input big">
              <select id="start" value={hour} onChange={(e) => setStartHour(Number(e.target.value))}>
                {Array.from({ length: LAST_START - firstStart + 1 }, (_, i) => firstStart + i).map((h) => (
                  <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>
                ))}
              </select>
            </div>
          </div>
          <div className="av-field">
            <span className="av-label" id="hlabel">Hours</span>
            <div className="av-stepper" role="group" aria-labelledby="hlabel">
              <button type="button" aria-label="One hour less" onClick={() => setHours(Math.max(quote?.minHours ?? 1, hours - 1))}><Icon name="minus" size={20} /></button>
              <output aria-live="polite">{hours}</output>
              <button type="button" aria-label="One hour more" onClick={() => setHours(Math.min(quote?.maxHours ?? 12, hours + 1))}><Icon name="plus" size={20} /></button>
            </div>
          </div>
        </div>
        <div className="av-card">
          <div className="av-row"><span style={{ color: "var(--ink)", fontWeight: 700 }}>{days[dayIdx]!.label} · {String(hour).padStart(2, "0")}:00–{String(endHour % 24).padStart(2, "0")}:00{endHour >= 24 ? " (next day)" : ""}</span><span /></div>
          {quote && pool ? (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <Bays total={pool.capacity} free={pool.available} small accessible={pool.kind === "accessible"} />
              <span style={{ fontSize: 14, color: "var(--muted)" }}>
                {pool.available} {POOL_LABEL[pool.kind]} {pool.available === 1 ? "bay" : "bays"} free for these hours
              </span>
            </div>
          ) : null}
          <div className="av-rule" />
          <Row label={`${hours} h × ${quote ? naira(quote.rateKobo) : "…"}`} value={quote ? naira(quote.amountKobo) : "…"} />
          {quote?.balanceBeforeKobo != null ? (
            <Row label="Wallet after booking" value={`${naira(quote.balanceBeforeKobo)} → ${naira(quote.balanceAfterKobo!)}`} />
          ) : null}
        </div>
        <div className="av-card">
          <div className="av-terms">
            <div><Icon name="exit" size={18} /><span>No refund if you leave before your time ends.</span></div>
            <div><Icon name="clock" size={18} /><span>Grace period and overstay charge: [to be set by the pilot operator].</span></div>
            <div><Icon name="calendar" size={18} /><span>Cancelling before you arrive: [policy to be set].</span></div>
          </div>
        </div>
        {error ? <div className="av-banner bad" role="alert">{error}</div> : null}
        {short && !error ? <div className="av-banner warn" role="status">Your balance doesn&apos;t cover these hours. Choose fewer hours; top-up arrives in the next release.</div> : null}
        <div className="av-spacer" />
        <button type="button" className="av-btn" onClick={reserve} disabled={busy || !quote || quote.available === 0 || short || !vehicle}>
          {busy ? "Reserving…" : quote?.available === 0 ? "Full for these hours" : `Reserve · ${quote ? naira(quote.amountKobo) : ""}`}
        </button>
      </main>
    </Shell>
  );
}
