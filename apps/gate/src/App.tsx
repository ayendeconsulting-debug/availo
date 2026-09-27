import { useEffect, useState } from "react";
import { Shell, BrandBar } from "@availo/ui";
import { Device } from "./device.js";
import { GateProvider, useGate } from "./gate.js";
import { usePath } from "./router.js";
import { Exception } from "./screens/Exception.js";
import { GateHome } from "./screens/GateHome.js";
import { Pin } from "./screens/Pin.js";
import { Plate } from "./screens/Plate.js";
import { Result } from "./screens/Result.js";
import { Scan } from "./screens/Scan.js";
import { Setup } from "./screens/Setup.js";

export function App() {
  const [device, setDevice] = useState<Device | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    Device.open().then((d) => { setDevice(d); setReady(d.signedIn); }).catch((e) => setError((e as Error).message));
  }, []);
  if (error) return <Shell><BrandBar gate /><main className="av-main"><div className="av-banner bad" role="alert">This phone can&apos;t open its gate storage: {error}</div></main></Shell>;
  if (!device) return null;
  if (!ready) return <Setup device={device} onReady={() => setReady(true)} />;
  return <GateProvider device={device}><Routes onSignedOut={() => setReady(false)} /></GateProvider>;
}

function Routes({ onSignedOut }: { onSignedOut: () => void }) {
  const g = useGate();
  const path = usePath();
  useEffect(() => { if (g.revoked || path === "/signin") onSignedOut(); }, [g.revoked, path, onSignedOut]);
  switch (path) {
    case "/scan": return <Scan />;
    case "/result": return <Result />;
    case "/pin": return <Pin />;
    case "/plate": return <Plate />;
    case "/exception": return <Exception />;
    default: return <GateHome />;
  }
}
