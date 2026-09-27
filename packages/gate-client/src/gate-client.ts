import { fromBase64Url, resolveEntry, verifyPin, verifyQr, type GateCache, type GatePassEntry, type GateResult } from "@availo/pass";
import { normalisePlate } from "@availo/shared";
import type { GateStore } from "./store.js";

/** The cache as the server sends it (GET /gate/cache). */
export interface CacheDocument {
  lotId: string;
  pinSalt: string;
  generatedAt: string;
  validUntil: string;
  publicKeys: Array<{ keyId: number; publicKey: string }>;
  passes: GatePassEntry[];
}

export interface GateEvent {
  id: string;
  kind: "entry" | "exit";
  method: "qr" | "pin" | "plate" | "manual";
  passId?: string;
  plate?: string;
  reason?: string;
  deviceResult: string;
  plateConfirmed: boolean;
  occurredAt: string;
  recordedOffline: boolean;
}

export interface SyncResult { id: string; outcome: "accepted" | "duplicate"; flags: string[] }

/** Transport to the API. Implementations throw NetworkError when there is no connection. */
export interface GateApi {
  fetchCache(): Promise<CacheDocument>;
  sendEvents(events: GateEvent[]): Promise<{ results: SyncResult[]; purge?: boolean }>;
}

export class NetworkError extends Error {}
export class DeviceRevokedError extends Error {}

/** US-041: every result that is not a clean admission offers a next step. Never a dead end. */
export type NextAction = "record_entry" | "record_exit" | "try_pin" | "search_plate" | "ask_for_live_pass" | "contact_operations" | "manual_exception";

export type Verification = GateResult & { onSite: boolean; actions: NextAction[] };

const FALLBACKS: NextAction[] = ["try_pin", "search_plate", "contact_operations", "manual_exception"];

/**
 * The attendant's device logic, independent of any screen (US-037 to US-042).
 * Verification reads only local state; recording writes to a durable queue;
 * sync is a separate step that may happen much later.
 */
export class GateClient {
  private cache: GateCache | null = null;
  private raw: CacheDocument | null = null;
  private online = true;

  constructor(
    private readonly store: GateStore,
    private readonly api: GateApi,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  get isOnline(): boolean {
    return this.online;
  }

  /** The app wires the browser's online/offline events here; every API call also updates it. */
  setConnectivity(online: boolean): void {
    this.online = online;
  }

  /** Download the day's passes. Returns false when offline; the existing cache stays in use. */
  async refreshCache(): Promise<boolean> {
    let doc: CacheDocument;
    try {
      doc = await this.api.fetchCache();
      this.online = true;
    } catch (err) {
      if (err instanceof DeviceRevokedError) {
        await this.purge();
        throw err;
      }
      if (err instanceof NetworkError) {
        this.online = false;
        return false;
      }
      throw err;
    }
    await this.store.putCache(doc, doc.validUntil, doc.lotId);
    // Server state, then this device's own records that the server has not seen yet.
    const onSite = new Map<string, string>();
    for (const p of doc.passes) if (p.onSite) onSite.set(p.passId, doc.generatedAt);
    for (const q of await this.store.peek<GateEvent>(10_000)) {
      if (!q.event.passId) continue;
      if (q.event.kind === "entry") onSite.set(q.event.passId, q.event.occurredAt);
      else onSite.delete(q.event.passId);
    }
    await this.store.replaceOnSite(onSite);
    this.use(doc);
    return true;
  }

  /** Load the stored cache after a restart. Purged, not used, once its window has ended (NFR-OFF-05). */
  async load(): Promise<boolean> {
    const stored = await this.store.getCache<CacheDocument>();
    if (!stored) return false;
    if (this.now() >= new Date(stored.validUntil)) {
      await this.store.purgeCache();
      this.cache = this.raw = null;
      return false;
    }
    this.use(stored.value);
    return true;
  }

  private use(doc: CacheDocument): void {
    this.raw = doc;
    this.cache = {
      lotId: doc.lotId,
      pinSalt: doc.pinSalt,
      publicKeys: new Map(doc.publicKeys.map((k) => [k.keyId, fromBase64Url(k.publicKey)!])),
      passes: new Map(doc.passes.map((p) => [p.passId, p])),
    };
  }

  private requireCache(): GateCache {
    if (!this.cache || !this.raw || this.now() >= new Date(this.raw.validUntil)) {
      throw new Error("No valid gate cache on this device. Connect to download today's passes.");
    }
    return this.cache;
  }

  private async decorate(r: GateResult): Promise<Verification> {
    const onSite = "pass" in r ? (await this.store.onSite()).has(r.pass.passId) : false;
    let actions: NextAction[];
    if (onSite) actions = ["record_exit"];
    else if (r.status === "VALID") actions = ["record_entry"];
    else if (r.status === "STALE_CODE") actions = ["ask_for_live_pass", ...FALLBACKS];
    else actions = FALLBACKS;
    return { ...r, onSite, actions };
  }

  /** US-038: scan resolves from local data only. */
  async scan(qr: string): Promise<Verification> {
    return this.decorate(verifyQr(qr, this.requireCache(), this.now()));
  }

  /** US-039 PIN fallback. */
  async enterPin(pin: string): Promise<Verification> {
    return this.decorate(verifyPin(pin, this.requireCache(), this.now()));
  }

  /** US-039 plate search: tolerant of case, spacing and separators; partial entry gives candidates. */
  async searchPlate(input: string): Promise<Verification[]> {
    const cache = this.requireCache();
    const q = normalisePlate(input)?.normalised ?? input.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (q.length < 2) return [];
    const out: Verification[] = [];
    for (const e of cache.passes.values()) {
      if (!e.plate.includes(q)) continue;
      // Same states as a scan; the attendant then confirms the plate as usual.
      out.push(await this.decorate(resolveEntry(e as GatePassEntry, this.now(), "plate")));
    }
    return out;
  }

  /**
   * US-040: entry is recorded only after the attendant confirms the arriving plate
   * matches, and only on a VALID result. Anything else goes through a manual exception.
   */
  async recordEntry(v: Verification, plateConfirmed: boolean): Promise<GateEvent> {
    if (!("pass" in v) || v.status !== "VALID") throw new Error("Only a VALID pass can be admitted. Use a manual exception.");
    if (!plateConfirmed) throw new Error("Confirm the plate matches before recording entry.");
    if (v.onSite) throw new Error("This vehicle is already recorded on site.");
    const e = this.event({ kind: "entry", method: v.method, passId: v.pass.passId, plate: v.pass.plate, deviceResult: v.status, plateConfirmed });
    await this.store.enqueue(e.id, e);
    await this.store.setOnSite(v.pass.passId, e.occurredAt);
    return e;
  }

  /** Exit stops grace and penalty accruing (US-040). Recorded whatever the pass status now is. */
  async recordExit(v: Verification): Promise<GateEvent> {
    if (!("pass" in v)) throw new Error("No booking to record an exit against.");
    const e = this.event({ kind: "exit", method: v.method, passId: v.pass.passId, plate: v.pass.plate, deviceResult: v.status, plateConfirmed: true });
    await this.store.enqueue(e.id, e);
    await this.store.setOnSite(v.pass.passId, null);
    return e;
  }

  /** US-041: a manual exception with a mandatory reason, always flagged for review. */
  async recordManualException(input: { kind: "entry" | "exit"; plate: string; reason: string; deviceResult: string; passId?: string }): Promise<GateEvent> {
    if (input.reason.trim().length < 3) throw new Error("A manual exception needs a reason.");
    const plate = normalisePlate(input.plate)?.normalised ?? input.plate;
    const e = this.event({ kind: input.kind, method: "manual", plate, reason: input.reason.trim(), deviceResult: input.deviceResult, plateConfirmed: true, ...(input.passId ? { passId: input.passId } : {}) });
    await this.store.enqueue(e.id, e);
    return e;
  }

  private event(fields: Omit<GateEvent, "id" | "occurredAt" | "recordedOffline">): GateEvent {
    return { id: this.newId(), occurredAt: this.now().toISOString(), recordedOffline: !this.online, ...fields };
  }

  pending(): Promise<number> {
    return this.store.pending();
  }

  /**
   * NFR-OFF-03: send queued records oldest first, in batches. A record leaves the
   * queue only when the server has acknowledged it — accepted or already seen —
   * so an interrupted sync simply repeats, and the server never counts twice.
   */
  async flush(batchSize = 100): Promise<{ sent: number; flagged: SyncResult[]; remaining: number }> {
    let sent = 0;
    const flagged: SyncResult[] = [];
    for (;;) {
      const batch = await this.store.peek<GateEvent>(batchSize);
      if (batch.length === 0) break;
      let reply;
      try {
        reply = await this.api.sendEvents(batch.map((b) => b.event));
        this.online = true;
      } catch (err) {
        if (err instanceof NetworkError) {
          this.online = false;
          break;
        }
        throw err;
      }
      const acked = new Set(reply.results.map((r) => r.id));
      await this.store.remove(batch.filter((b) => acked.has(b.id)).map((b) => b.seq));
      sent += reply.results.filter((r) => r.outcome === "accepted").length;
      flagged.push(...reply.results.filter((r) => r.flags.length > 0));
      if (reply.purge) await this.purge();
      if (acked.size < batch.length) break; // the server did not take everything; try again later
    }
    return { sent, flagged, remaining: await this.store.pending() };
  }

  /** Logout, end of cache window or revocation: the pass set goes. Unsynced records stay, encrypted, until sent. */
  async purge(): Promise<void> {
    await this.store.purgeCache();
    this.cache = this.raw = null;
  }
}
