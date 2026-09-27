import { useEffect, useState } from "react";
import { BrandBar, Chip, Icon, Pool, Shell, displayPlate, naira, watDay, watTime } from "@availo/ui";
import { api, OfflineError, type Availability, type Booking } from "../api.js";
import { useCached, useLot, useMe } from "../hooks.js";
import { local } from "../local.js";
import { go } from "../router.js";
import { DriverNav } from "./Nav.js";

const POOL_NAMES: Record<string, string> = { campus: "Campus bays", open: "Open bays", accessible: "Accessible bays" };

/** D3 · Home: balance always visible (US-019), capacity the driver can book now (US-022), next booking. */
export function Home() {
  const me = useMe();
  const lot = useLot();
  const bookings = useCached<Booking[]>(() => api<Booking[]>("GET", "/reservations"), local.bookings, local.saveBookings);
  const [now, setNow] = useState<Availability | null>(null);
  const [nowOffline, setNowOffline] = useState(false);

  useEffect(() => {
    if (!lot.data) return;
    const start = new Date(Math.ceil((Date.now() + 60_000) / 60_000) * 60_000).toISOString();
    api<Availability>("GET", `/lots/${lot.data.id}/availability?start=${encodeURIComponent(start)}&hours=1`)
      .then((a) => { setNow(a); setNowOffline(false); })
      .catch((e) => { if (e instanceof OfflineError) setNowOffline(true); });
  }, [lot.data?.id]);

  const first = me.data?.name.split(" ")[0];
  const next = bookings.data?.find((b) => b.upcoming && b.status === "confirmed");
  const accessible = lot.data?.pools.find((p) => p.kind === "accessible");
  const offline = me.offline || lot.offline || nowOffline;

  return (
    <Shell>
      <BrandBar right={offline ? <Chip tone="status" icon="offline">Offline</Chip> : undefined} />
      <main className="av-main tight">
        <div className="av-greeting">{greeting()}{first ? `, ${first}` : ""}</div>
        {me.data?.walletBalanceKobo !== null && me.data?.walletBalanceKobo !== undefined ? (
          <div className="av-wallet">
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <div className="av-kicker kicker">Wallet</div>
              <div className="amount">{naira(me.data.walletBalanceKobo)}</div>
            </div>
            <a className="av-btn" href="/wallet" onClick={go("/wallet")}>Details</a>
          </div>
        ) : null}
        <section className="av-card roomy" aria-labelledby="lot-name">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <h2 id="lot-name" className="av-h2">{lot.data?.name ?? "UNILAG Pilot Lot"}</h2>
              {lot.data?.building ? <div className="av-hint" style={{ fontSize: 14, marginTop: 2 }}>{lot.data.building}</div> : null}
            </div>
            <Chip>Now</Chip>
          </div>
          {now ? now.pools.map((p) => (
            <Pool key={p.kind} name={POOL_NAMES[p.kind] ?? p.kind} total={p.capacity} free={p.available} accessible={p.kind === "accessible"} />
          )) : <p className="av-note">{nowOffline ? "Live availability needs a connection." : "Checking availability…"}</p>}
          {accessible && !now?.pools.some((p) => p.kind === "accessible") ? (
            <div className="av-hint">{accessible.capacity} accessible bays are held for drivers verified for accessible parking.</div>
          ) : null}
        </section>
        <a className="av-btn" href="/reserve" onClick={go("/reserve")}><Icon name="car" color="#1E2124" />Reserve parking</a>
        {next ? (
          <a className="av-item" href={`/pass/${next.id}`} onClick={go(`/pass/${next.id}`)}>
            <span style={{ display: "flex", color: "var(--muted)" }}><Icon name="calendar" /></span>
            <span className="main">
              <strong>{watDay(next.window.start)} · {watTime(next.window.start)}–{watTime(next.window.end)}</strong>
              <small>{next.pool === "campus" ? "Campus bay" : next.pool === "open" ? "Open bay" : "Accessible bay"} · {displayPlate(next.plate)}</small>
            </span>
            <span style={{ fontSize: 14, fontWeight: 600 }}>View pass</span>
            <Icon name="forward" size={18} />
          </a>
        ) : null}
      </main>
      <DriverNav current="home" />
    </Shell>
  );
}

function greeting(): string {
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", hour12: false }).format(new Date()));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}
