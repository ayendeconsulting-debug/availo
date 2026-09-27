import { useEffect, useState } from "react";
import { api, OfflineError, type Lot, type Me } from "./api.js";
import { local } from "./local.js";

/** Load from the API, falling back to what the phone last saw when there is no signal. */
export function useCached<T>(load: () => Promise<T>, cached: () => T | null, save: (v: T) => void, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(cached);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    load().then((v) => { if (live) { save(v); setData(v); setOffline(false); } })
      .catch((e) => { if (!live) return; if (e instanceof OfflineError) setOffline(true); else setError((e as Error).message); });
    return () => { live = false; };
  }, deps);
  return { data, offline, error };
}

export function useMe() {
  return useCached<Me>(() => api<Me>("GET", "/me"), local.me, local.saveMe);
}

export function useLot() {
  return useCached<Lot>(async () => (await api<Lot[]>("GET", "/lots"))[0]!, local.lot, local.saveLot);
}
