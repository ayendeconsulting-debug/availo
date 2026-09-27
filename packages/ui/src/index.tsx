/**
 * Availo UI kit — the prototype's building blocks as React components.
 * Every interactive element is a real <button>, <a> or <input> (NFR-ACC-03).
 */
import type { ReactNode, ButtonHTMLAttributes, AnchorHTMLAttributes, InputHTMLAttributes } from "react";
import { useId } from "react";

type IconName =
  | "back" | "forward" | "close" | "check" | "bell" | "car" | "calendar" | "home" | "list" | "wallet" | "account" | "pin-map"
  | "offline" | "online" | "access" | "clock" | "exit" | "entry" | "search" | "phone" | "scan" | "keypad" | "minus" | "plus"
  | "x" | "alert" | "sync";

const PATHS: Record<IconName, ReactNode> = {
  back: <path d="M15 18l-6-6 6-6" />,
  forward: <path d="M9 6l6 6-6 6" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  bell: <><path d="M6 16v-5a6 6 0 0112 0v5l2 2H4z" /><path d="M10 21h4" /></>,
  car: <><path d="M5 15l1.6-4.8A2 2 0 018.5 9h7a2 2 0 011.9 1.2L19 15" /><rect x="3" y="15" width="18" height="4" rx="1.5" /><path d="M6.5 19v1.5M17.5 19v1.5" /></>,
  calendar: <><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  home: <><path d="M4 11l8-7 8 7v9H4z" /><path d="M10 20v-5h4v5" /></>,
  list: <><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" /></>,
  wallet: <><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18" /><path d="M16 14.5h2" /></>,
  account: <><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></>,
  "pin-map": <><path d="M12 21s-7-6.2-7-11a7 7 0 0114 0c0 4.8-7 11-7 11z" /><circle cx="12" cy="10" r="2.5" /></>,
  offline: <><path d="M3 3l18 18" /><path d="M8.5 16.5a5 5 0 017 0" /><path d="M5 12.5a10 10 0 014.5-2.3" /><path d="M14.8 10.3A10 10 0 0119 12.5" /><path d="M12 20h.01" /></>,
  online: <><path d="M8.5 16.5a5 5 0 017 0" /><path d="M5 12.5a10 10 0 0114 0" /><path d="M2 8.8a15 15 0 0120 0" /><path d="M12 20h.01" /></>,
  access: <><circle cx="12" cy="4.5" r="1.8" /><path d="M12 7.5v6h5.5l2 5.5" /><path d="M9 10.5a6 6 0 108.3 8" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  exit: <><path d="M15 17l5-5-5-5M20 12H9" /><path d="M12 20H6a2 2 0 01-2-2V6a2 2 0 012-2h6" /></>,
  entry: <><path d="M10 17l5-5-5-5M15 12H3" /><path d="M13 4h5a2 2 0 012 2v12a2 2 0 01-2 2h-5" /></>,
  search: <><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></>,
  phone: <path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z" />,
  scan: <><path d="M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3" /><path d="M4 12h16" /></>,
  keypad: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h.01M12 8h.01M15 8h.01M9 12h.01M12 12h.01M15 12h.01M9 16h.01M12 16h.01M15 16h.01" /></>,
  minus: <path d="M5 12h14" />,
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="M7 7l10 10M17 7L7 17" />,
  alert: <><path d="M12 3l9.5 17H2.5z" /><path d="M12 10v4M12 17h.01" /></>,
  sync: <><path d="M20 11a8 8 0 00-14.3-4.9L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0014.3 4.9L20 16" /><path d="M20 20v-4h-4" /></>,
};

export function Icon({ name, size = 22, color = "currentColor", strokeWidth = 2 }: { name: IconName; size?: number; color?: string; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  return <div className="av-shell">{children}</div>;
}

export function BrandBar({ gate, subtitle, right }: { gate?: boolean; subtitle?: string; right?: ReactNode }) {
  return (
    <header className={`av-bar${subtitle ? " tall" : ""}`}>
      <div className="av-brand">
        <div className="av-brand-row">
          <div className="av-mark" aria-hidden="true">A</div>
          <span className="av-wordmark">{gate ? "AVAILO GATE" : "AVAILO"}</span>
        </div>
        {subtitle ? <span className="av-brand-sub">{subtitle}</span> : null}
      </div>
      {right}
    </header>
  );
}

export function BackBar({ title, onBack, backLabel = "Back" }: { title: string; onBack: () => void; backLabel?: string }) {
  return (
    <header className="av-bar back">
      <button type="button" className="av-icon-btn" aria-label={backLabel} onClick={onBack}><Icon name="back" size={24} /></button>
      <h1 className="av-bar-title">{title}</h1>
    </header>
  );
}

type Variant = "primary" | "outline" | "dark";
function cls(variant: Variant, large?: boolean, small?: boolean) {
  return `av-btn${variant === "primary" ? "" : " " + variant}${large ? " large" : ""}${small ? " small" : ""}`;
}

export function Button({ variant = "primary", large, small, icon, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; large?: boolean; small?: boolean; icon?: IconName }) {
  return (
    <button type="button" className={cls(variant, large, small)} {...rest}>
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

export function LinkButton({ variant = "primary", large, small, icon, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant; large?: boolean; small?: boolean; icon?: IconName }) {
  return (
    <a className={cls(variant, large, small)} {...rest}>
      {icon ? <Icon name={icon} /> : null}
      {children}
    </a>
  );
}

export function Field({ label, hint, error, prefix, big, ...input }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode; error?: string | undefined; prefix?: string; big?: boolean }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="av-field">
      <label htmlFor={id} className="av-label">{label}</label>
      <div className={`av-input${big ? " big" : ""}${error ? " invalid" : ""}`}>
        {prefix ? <span className="prefix">{prefix}</span> : null}
        <input id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...input} />
      </div>
      {hint ? <div id={hintId} className="av-hint">{hint}</div> : null}
      {error ? <div id={errId} className="av-error" role="alert">{error}</div> : null}
    </div>
  );
}

export function Row({ label, value }: { label: ReactNode; value: ReactNode }) {
  return <div className="av-row"><span>{label}</span><span>{value}</span></div>;
}

/** One cell per bay; `free` of them lit. Decorative: the count beside it carries the meaning (NFR-ACC-04). */
export function Bays({ total, free, accessible, small }: { total: number; free: number; accessible?: boolean; small?: boolean }) {
  const taken = Math.max(0, total - free);
  return (
    <div className={`av-bays${accessible ? " access" : ""}${small ? " small" : ""}`} aria-hidden="true">
      {Array.from({ length: total }, (_, i) => <span key={i} className={i >= taken ? "free" : ""} />)}
    </div>
  );
}

export function Pool({ name, total, free, accessible, note }: { name: string; total: number; free: number; accessible?: boolean; note?: string }) {
  return (
    <div className="av-pool">
      <div className="av-pool-head">
        <span className="name">{name}</span>
        <span className="count">{free} <small>of {total} free</small></span>
      </div>
      <Bays total={total} free={free} {...(accessible ? { accessible } : {})} />
      {note ? <div className="av-hint">{note}</div> : null}
    </div>
  );
}

export function Chip({ tone, icon, children }: { tone?: "ok" | "warn" | "bad" | "status"; icon?: IconName; children: ReactNode }) {
  return <span className={`av-chip${tone ? " " + tone : ""}`}>{icon ? <Icon name={icon} size={16} /> : null}{children}</span>;
}

export function BottomNav({ items, current }: { items: Array<{ key: string; label: string; icon: IconName; href: string; onClick?: (e: React.MouseEvent) => void }>; current: string }) {
  return (
    <nav className="av-nav" aria-label="Main">
      {items.map((i) => (
        <a key={i.key} href={i.href} aria-current={i.key === current ? "page" : undefined} onClick={i.onClick}>
          <span className="tick" />
          <Icon name={i.icon} />
          {i.label}
        </a>
      ))}
    </nav>
  );
}

export type ResultTone = "ok" | "warn" | "bad" | "neutral";
export function ResultBanner({ tone, status, sub, icon }: { tone: ResultTone; status: string; sub?: string; icon: IconName }) {
  const colors: Record<ResultTone, string> = { ok: "#1F7A4D", warn: "#C2410C", bad: "#B42318", neutral: "#3A3F45" };
  return (
    <section className={`av-result ${tone}`} aria-live="assertive">
      <span className="badge"><Icon name={icon} size={34} color={colors[tone]} strokeWidth={2.6} /></span>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <span className={`status${status.length > 9 ? " long" : ""}`}>{status}</span>
        {sub ? <span className="sub">{sub}</span> : null}
      </div>
    </section>
  );
}

/** Naira from kobo, e.g. 150000 → ₦1,500. */
export function naira(kobo: string | number | bigint): string {
  const k = BigInt(kobo);
  const neg = k < 0n;
  const abs = neg ? -k : k;
  const whole = abs / 100n;
  const frac = abs % 100n;
  const s = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "−" : ""}₦${s}${frac ? "." + frac.toString().padStart(2, "0") : ""}`;
}

/** Plates as printed: ABC123DE → ABC 123 DE. Unusual formats are shown as stored. */
export function displayPlate(p: string): string {
  const m = /^([A-Z]{3})(\d{3})([A-Z]{2})$/.exec(p);
  return m ? `${m[1]} ${m[2]} ${m[3]}` : p;
}

const WAT = "Africa/Lagos";
export function watTime(iso: string | Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: WAT, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}
export function watDay(iso: string | Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: WAT, weekday: "short", day: "numeric", month: "short" }).format(new Date(iso)).replace(",", "");
}
