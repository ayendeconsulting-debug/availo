import { openDB, type DBSchema, type IDBPDatabase } from "idb";

/**
 * On-device storage for the gate (NFR-OFF-05). Everything sensitive is
 * encrypted with an AES-GCM key generated on the device as non-extractable:
 * script can use it but never read it out, and it never leaves the phone.
 *
 * On a bring-your-own phone (OD-14) this protects against casual file access and
 * backups, not against a fully compromised handset. The cache holds only what
 * an attendant may see and expires after 24 hours.
 */
interface Sealed { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer }

interface GateDB extends DBSchema {
  key: { key: "k"; value: CryptoKey };
  meta: { key: string; value: unknown };
  cache: { key: "current"; value: { sealed: Sealed; validUntil: string; lotId: string } };
  queue: { key: number; value: { seq?: number; id: string; sealed: Sealed } };
  onsite: { key: string; value: { passId: string; since: string } };
}

export class GateStore {
  private constructor(private readonly db: IDBPDatabase<GateDB>) {}

  static async open(name = "availo-gate"): Promise<GateStore> {
    const db = await openDB<GateDB>(name, 1, {
      upgrade(d) {
        d.createObjectStore("key");
        d.createObjectStore("meta");
        d.createObjectStore("cache");
        d.createObjectStore("queue", { keyPath: "seq", autoIncrement: true });
        d.createObjectStore("onsite", { keyPath: "passId" });
      },
    });
    return new GateStore(db);
  }

  close(): void {
    this.db.close();
  }

  private async key(): Promise<CryptoKey> {
    const existing = await this.db.get("key", "k");
    if (existing) return existing;
    const k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await this.db.put("key", k, "k");
    return k;
  }

  async seal(value: unknown): Promise<Sealed> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await this.key(), new TextEncoder().encode(JSON.stringify(value)));
    return { iv, data };
  }

  async open<T>(s: Sealed): Promise<T> {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: s.iv }, await this.key(), s.data);
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  }

  // ——— meta (device token, lot) ———
  async getMeta<T>(k: string): Promise<T | undefined> {
    return (await this.db.get("meta", k)) as T | undefined;
  }
  async setMeta(k: string, v: unknown): Promise<void> {
    await this.db.put("meta", v, k);
  }
  async deleteMeta(k: string): Promise<void> {
    await this.db.delete("meta", k);
  }

  // ——— cache ———
  async putCache(value: unknown, validUntil: string, lotId: string): Promise<void> {
    await this.db.put("cache", { sealed: await this.seal(value), validUntil, lotId }, "current");
  }
  async getCache<T>(): Promise<{ value: T; validUntil: string } | null> {
    const row = await this.db.get("cache", "current");
    return row ? { value: await this.open<T>(row.sealed), validUntil: row.validUntil } : null;
  }
  async purgeCache(): Promise<void> {
    const tx = this.db.transaction(["cache", "onsite"], "readwrite");
    await Promise.all([tx.objectStore("cache").clear(), tx.objectStore("onsite").clear(), tx.done]);
  }

  // ——— outbound queue: ordered, durable, encrypted ———
  async enqueue(id: string, event: unknown): Promise<void> {
    await this.db.add("queue", { id, sealed: await this.seal(event) });
  }
  async peek<T>(limit: number): Promise<Array<{ seq: number; id: string; event: T }>> {
    // Read raw rows first: awaiting decryption inside a cursor would let the transaction close.
    const rows = await this.db.getAll("queue", undefined, limit);
    return Promise.all(rows.map(async (r) => ({ seq: r.seq!, id: r.id, event: await this.open<T>(r.sealed) })));
  }
  async remove(seqs: number[]): Promise<void> {
    const tx = this.db.transaction("queue", "readwrite");
    await Promise.all([...seqs.map((s) => tx.store.delete(s)), tx.done]);
  }
  async pending(): Promise<number> {
    return this.db.count("queue");
  }

  // ——— local on-site state ———
  async onSite(): Promise<Map<string, string>> {
    return new Map((await this.db.getAll("onsite")).map((r) => [r.passId, r.since]));
  }
  async setOnSite(passId: string, since: string | null): Promise<void> {
    if (since) await this.db.put("onsite", { passId, since });
    else await this.db.delete("onsite", passId);
  }
  async replaceOnSite(entries: Map<string, string>): Promise<void> {
    const tx = this.db.transaction("onsite", "readwrite");
    await tx.store.clear();
    for (const [passId, since] of entries) await tx.store.put({ passId, since });
    await tx.done;
  }
}
