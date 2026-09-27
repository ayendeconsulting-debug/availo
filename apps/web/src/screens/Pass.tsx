import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { BrandBar, Chip, Icon, Shell, displayPlate, watDay, watTime } from "@availo/ui";
import { fromBase64Url, qrText, STEP_SECONDS } from "@availo/pass";
import { api, OfflineError, type PassView } from "../api.js";
import { useLot } from "../hooks.js";
import { local } from "../local.js";
import { go, navigate } from "../router.js";

/**
 * D6 · Pass (US-033, US-035). Renders from the phone's own copy when there is
 * no signal (NFR-OFF-06). The QR is recomputed on the phone every 30 seconds
 * from the pass's secret, so a screenshot goes stale (OD-13).
 */
export function Pass({ reservationId }: { reservationId: string }) {
  const [pass, setPass] = useState<PassView | null>(() => local.pass(reservationId));
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string>();
  const [svg, setSvg] = useState("");
  const lot = useLot();

  useEffect(() => {
    api<PassView>("GET", `/reservations/${reservationId}/pass`)
      .then((p) => { local.savePass(reservationId, p); setPass(p); setOffline(false); })
      .catch((e) => { if (e instanceof OfflineError) setOffline(true); else setError((e as Error).message); });
  }, [reservationId]);

  useEffect(() => {
    if (!pass) return;
    const secret = fromBase64Url(pass.qr.totpSecret);
    if (!secret) return;
    let lastStep = -1;
    const render = () => {
      const step = Math.floor(Date.now() / 1000 / STEP_SECONDS);
      if (step === lastStep) return;
      lastStep = step;
      QRCode.toString(qrText(pass.qr.signedPart, secret, new Date()), { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#1E2124", light: "#FFFFFF" } })
        .then(setSvg).catch(() => setSvg(""));
    };
    render();
    const t = setInterval(render, 1000);
    return () => clearInterval(t);
  }, [pass]);

  if (!pass) {
    return (
      <Shell>
        <BrandBar right={<a className="av-icon-btn" href="/home" aria-label="Close pass" onClick={go("/home")}><Icon name="close" size={24} /></a>} />
        <main className="av-main">
          <p className="av-note" role="status">{error ?? (offline ? "This pass hasn't been opened on this phone yet. Open it once with a connection and it will then work offline." : "Loading your pass…")}</p>
        </main>
      </Shell>
    );
  }

  const BAY: Record<string, string> = { campus: "Campus", open: "Open", accessible: "Accessible" };
  const bay = BAY[pass.pool ?? (pass.accessible ? "accessible" : "")];
  return (
    <Shell>
      <BrandBar right={<a className="av-icon-btn" href="/home" aria-label="Close pass" onClick={go("/home")}><Icon name="close" size={24} /></a>} />
      <main className="av-main tight" style={{ paddingBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 className="av-h2 xl">Your pass</h2>
          {pass.status === "confirmed" ? <Chip tone="ok" icon="check">Confirmed</Chip> : <Chip tone="bad">{pass.status}</Chip>}
        </div>
        <section className="av-pass" aria-label="Parking pass">
          <div className="av-qr-frame">
            <div role="img" aria-label={`QR code for booking ${pass.reference}`} dangerouslySetInnerHTML={{ __html: svg }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <div className="av-kicker" style={{ color: "var(--muted-on-dark)" }}>PIN</div>
            <div className="av-pin" aria-label={`PIN ${pass.pin.split("").join(" ")}`}>
              {pass.pin.split("").map((d, i) => <span key={i} aria-hidden="true">{d}</span>)}
            </div>
          </div>
          <div className="av-pass-grid">
            <div><span>Vehicle</span><span>{displayPlate(pass.plate)}</span></div>
            <div><span>Bay</span><span>{bay ?? "Any free bay"}</span></div>
            <div><span>Date</span><span>{watDay(pass.window.start)}</span></div>
            <div><span>Time</span><span>{watTime(pass.window.start)}–{watTime(pass.window.end)}</span></div>
          </div>
          <div className="refresh">{pass.reference} · the code changes every 30 seconds</div>
        </section>
        <div className="av-inline-note"><span style={{ display: "flex" }}><Icon name="offline" size={20} /></span>Show this at the gate. It works without signal.</div>
        {pass.earlyEntryMinutes > 0 ? <p className="av-note">You can enter from {pass.earlyEntryMinutes} minutes before your start. Your time still ends at {watTime(pass.window.end)}.</p> : null}
        {lot.data?.gateDirections || lot.data?.entrancePhotoUrl ? (
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            {lot.data.entrancePhotoUrl ? <img src={lot.data.entrancePhotoUrl} alt="The gate entrance" className="av-photo" style={{ objectFit: "cover" }} /> : null}
            {lot.data.gateDirections ? <div style={{ fontSize: 14, lineHeight: 1.4 }}><strong>Entrance:</strong> {lot.data.gateDirections}</div> : null}
          </div>
        ) : null}
        <div className="av-spacer" />
        <button type="button" className="av-btn outline small" onClick={() => navigate("/bookings")}>All bookings</button>
      </main>
    </Shell>
  );
}
