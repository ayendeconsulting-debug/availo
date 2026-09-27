import { Chip, Icon, BrandBar, Shell, displayPlate, naira, watDay, watTime } from "@availo/ui";
import { api, type Booking } from "../api.js";
import { useCached } from "../hooks.js";
import { local } from "../local.js";
import { go } from "../router.js";
import { DriverNav } from "./Nav.js";

export function Bookings() {
  const b = useCached<Booking[]>(() => api<Booking[]>("GET", "/reservations"), local.bookings, local.saveBookings);
  const upcoming = (b.data ?? []).filter((x) => x.upcoming);
  const past = (b.data ?? []).filter((x) => !x.upcoming);
  const item = (x: Booking) => (
    <a key={x.id} className="av-item" href={`/pass/${x.id}`} onClick={go(`/pass/${x.id}`)}>
      <span className="main">
        <strong>{watDay(x.window.start)} · {watTime(x.window.start)}–{watTime(x.window.end)}</strong>
        <small>{x.reference} · {displayPlate(x.plate)} · {naira(x.amountKobo)}</small>
      </span>
      {x.status !== "confirmed" ? <Chip tone="bad">{x.status}</Chip> : x.session === "active" ? <Chip tone="ok">Parked</Chip> : null}
      <Icon name="forward" size={18} />
    </a>
  );
  return (
    <Shell>
      <BrandBar right={b.offline ? <Chip tone="status" icon="offline">Offline</Chip> : undefined} />
      <main className="av-main tight">
        <h2 className="av-h2 xl">Bookings</h2>
        <div className="av-kicker">Upcoming</div>
        {upcoming.length ? upcoming.map(item) : <p className="av-note">No upcoming bookings.</p>}
        {past.length ? <><div className="av-kicker">Past</div>{past.map(item)}</> : null}
      </main>
      <DriverNav current="bookings" />
    </Shell>
  );
}
