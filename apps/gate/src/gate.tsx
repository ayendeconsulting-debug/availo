import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { DeviceRevokedError, NetworkError, type SyncResult, type Verification } from "@availo/gate-client";
import { Device, SignInRequired } from "./device.js";

export interface GateState {
  device: Device;
  online: boolean;
  lastSync: Date | null;
  pending: number;
  flagged: SyncResult[];
  needsSignIn: boolean;
  revoked: boolean;
  /** The verification on screen, with how long it took. */
  result: { v: Verification; ms: number; offline: boolean } | null;
  setResult: (r: GateState["result"]) => void;
  sync: () => Promise<void>;
  bump: () => void;
  version: number;
}

const Ctx = createContext<GateState | null>(null);
export const useGate = () => useContext(Ctx)!;

const SYNC_EVERY_MS = 30_000;
const CACHE_EVERY_MS = 10 * 60_000;

export function GateProvider({ device, children }: { device: Device; children: ReactNode }) {
  const [online, setOnline] = useState(navigator.onLine);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [pending, setPending] = useState(0);
  const [flagged, setFlagged] = useState<SyncResult[]>([]);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const [result, setResult] = useState<GateState["result"]>(null);
  const [version, setVersion] = useState(0);
  const lastCache = useRef(0);
  const running = useRef(false);

  const bump = useCallback(() => {
    setVersion((v) => v + 1);
    void device.client.pending().then(setPending);
  }, [device]);

  const sync = useCallback(async () => {
    if (running.current || !device.signedIn) return;
    running.current = true;
    try {
      if (Date.now() - lastCache.current > CACHE_EVERY_MS || !device.client.current) {
        if (await device.client.refreshCache()) lastCache.current = Date.now();
      }
      const r = await device.client.flush();
      if (r.flagged.length) setFlagged((f) => [...r.flagged, ...f].slice(0, 20));
      setOnline(device.client.isOnline);
      if (device.client.isOnline) {
        const at = new Date();
        setLastSync(at);
        setNeedsSignIn(false);
        void device.store.setMeta("lastSync", at.toISOString());
      }
    } catch (e) {
      if (e instanceof DeviceRevokedError) { await device.forget(); setRevoked(true); }
      else if (e instanceof SignInRequired) setNeedsSignIn(true);
      else if (e instanceof NetworkError) setOnline(false);
    } finally {
      running.current = false;
      bump();
    }
  }, [device, bump]);

  useEffect(() => {
    void device.store.getMeta<string>("lastSync").then((v) => { if (v) setLastSync((cur) => cur ?? new Date(v)); });
  }, [device]);

  useEffect(() => {
    const on = () => { device.client.setConnectivity(true); setOnline(true); void sync(); };
    const off = () => { device.client.setConnectivity(false); setOnline(false); };
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    device.client.setConnectivity(navigator.onLine);
    void sync();
    const t = setInterval(() => void sync(), SYNC_EVERY_MS);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); clearInterval(t); };
  }, [device, sync]);

  return (
    <Ctx.Provider value={{ device, online, lastSync, pending, flagged, needsSignIn, revoked, result, setResult, sync, bump, version }}>
      {children}
    </Ctx.Provider>
  );
}
