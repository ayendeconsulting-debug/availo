import { DeviceRevokedError, GateClient, GateStore, NetworkError, type CacheDocument, type GateApi, type GateEvent, type SyncResult } from "@availo/gate-client";

const BASE = (import.meta.env.VITE_API_URL ?? "http://localhost:3000").replace(/\/$/, "");

export interface DeviceCredentials { deviceId: string; deviceToken: string; lotId: string }
export interface AttendantSession { accessToken: string; attendantName: string; expiresAt: string }

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly detail: Record<string, unknown> = {}) { super(message); }
}
/** The attendant must sign in again to sync. Verification keeps working meanwhile. */
export class SignInRequired extends Error {}

async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let r: Response;
  try {
    r = await fetch(BASE + path, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new NetworkError("offline");
  }
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  if (!r.ok) {
    const { code, message, ...detail } = json.error ?? {};
    if (r.status === 403 && code === "DEVICE_REVOKED") throw new DeviceRevokedError(message);
    if (r.status === 401 && (code === "UNAUTHENTICATED" || code === "DEVICE_MISMATCH")) throw new SignInRequired(message);
    throw new ApiError(r.status, code ?? "ERROR", message ?? "Something went wrong.", detail);
  }
  return json as T;
}

/**
 * Everything the gate phone holds lives in its encrypted store (NFR-OFF-05):
 * the device token, the attendant session, the pass set and the queue.
 */
export class Device {
  private creds: DeviceCredentials | null = null;
  private session: AttendantSession | null = null;
  readonly client: GateClient;

  private constructor(readonly store: GateStore) {
    const api: GateApi = {
      fetchCache: () => call<CacheDocument>("GET", "/gate/cache", undefined, this.headers()),
      sendEvents: (events: GateEvent[]) => call<{ results: SyncResult[]; purge?: boolean }>("POST", "/gate/events", { events }, this.headers()),
    };
    this.client = new GateClient(store, api);
  }

  static async open(): Promise<Device> {
    const d = new Device(await GateStore.open());
    const c = await d.store.getMeta<Parameters<GateStore["open"]>[0]>("device");
    if (c) d.creds = await d.store.open<DeviceCredentials>(c);
    const s = await d.store.getMeta<Parameters<GateStore["open"]>[0]>("session");
    if (s) d.session = await d.store.open<AttendantSession>(s);
    await d.client.load();
    return d;
  }

  private headers(): Record<string, string> {
    if (!this.creds || !this.session) throw new SignInRequired("Sign in to sync.");
    return { Authorization: `Bearer ${this.session.accessToken}`, "X-Gate-Device": this.creds.deviceToken };
  }

  get enrolled(): boolean { return !!this.creds; }
  get signedIn(): boolean { return !!this.session; }
  get attendantName(): string { return this.session?.attendantName ?? ""; }
  get sessionExpired(): boolean { return !!this.session && new Date(this.session.expiresAt) <= new Date(); }

  async enrol(code: string): Promise<void> {
    const r = await call<DeviceCredentials>("POST", "/gate/devices/enrol", { enrolmentCode: code });
    this.creds = r;
    await this.store.setMeta("device", await this.store.seal(r));
  }

  async requestCode(mobile: string): Promise<void> {
    await call("POST", "/auth/otp/request", { mobile });
  }

  async signIn(mobile: string, code: string): Promise<void> {
    if (!this.creds) throw new Error("Enrol this phone first.");
    const r = await call<{ accessToken: string; expiresIn: number; attendant: { name: string } }>(
      "POST", "/gate/auth/verify", { mobile, code }, { "X-Gate-Device": this.creds.deviceToken });
    this.session = { accessToken: r.accessToken, attendantName: r.attendant.name, expiresAt: new Date(Date.now() + r.expiresIn * 1000).toISOString() };
    await this.store.setMeta("session", await this.store.seal(this.session));
  }

  /** Logout purges the pass set (NFR-OFF-05). Unsent records stay, encrypted, for the next sign-in. */
  async signOut(): Promise<void> {
    this.session = null;
    await this.store.deleteMeta("session");
    await this.client.purge();
  }

  /** After revocation this phone is no longer a gate device. */
  async forget(): Promise<void> {
    await this.signOut();
    this.creds = null;
    await this.store.deleteMeta("device");
  }
}
