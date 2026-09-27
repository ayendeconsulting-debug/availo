import { useEffect, useRef, useState } from "react";
import * as jsqrModule from "jsqr";

// jsQR ships as CommonJS; take its function whichever way the bundler exposes it.
type Decode = (data: Uint8ClampedArray, width: number, height: number, opts?: { inversionAttempts?: "dontInvert" | "attemptBoth" }) => { data: string } | null;
const jsQR: Decode = ((jsqrModule as unknown as { default?: Decode }).default ?? (jsqrModule as unknown as Decode));
import { BackBar, Button, Shell } from "@availo/ui";
import { useGate } from "../gate.js";
import { navigate } from "../router.js";

/**
 * Scans the driver's phone with the camera (US-038). Decoding and verification
 * both run on this phone; no network is involved.
 */
export function Scan() {
  const g = useGate();
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stop = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    async function tick() {
      if (stop) return;
      const v = video.current;
      if (v && ctx && v.readyState >= 2 && v.videoWidth) {
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
        ctx.drawImage(v, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const found = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
        if (found?.data) {
          const t0 = performance.now();
          const result = await g.device.client.scan(found.data);
          g.setResult({ v: result, ms: performance.now() - t0, offline: !g.online });
          stop = true;
          navigate("/result", true);
          return;
        }
      }
      setTimeout(() => void tick(), 120);
    }

    navigator.mediaDevices?.getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then((s) => {
        stream = s;
        if (video.current) { video.current.srcObject = s; void video.current.play(); }
        void tick();
      })
      .catch(() => setError("The camera isn't available. Allow camera access, or use the PIN or plate instead."));
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [g]);

  return (
    <Shell>
      <BackBar title="Scan pass" onBack={() => navigate("/")} />
      <main className="av-main">
        {error ? <div className="av-banner bad" role="alert">{error}</div> : (
          <div className="av-camera">
            <video ref={video} muted playsInline aria-label="Camera view" />
            <div className="reticle" aria-hidden="true" />
          </div>
        )}
        <p className="av-note" style={{ textAlign: "center" }}>Hold the driver&apos;s phone inside the frame.</p>
        <div className="av-spacer" />
        <div className="av-btn-grid">
          <Button variant="outline" icon="keypad" onClick={() => navigate("/pin", true)}>PIN</Button>
          <Button variant="outline" icon="search" onClick={() => navigate("/plate", true)}>Plate</Button>
        </div>
      </main>
    </Shell>
  );
}
