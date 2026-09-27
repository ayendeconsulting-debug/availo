/** US-037 to US-042, NFR-OFF-01 to NFR-OFF-05 — the gate device's offline core, against a fake server. */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { pinHash, publicKeyFor, qrText, signPass, toBase64Url, type GatePassEntry } from "@availo/pass";
import { DeviceRevokedError, GateClient, GateStore, NetworkError, type CacheDocument, type GateApi, type GateEvent, type SyncResult } from "../src/index.js";

const LOT = "11111111-1111-4111-8111-111111111111";
const PASS = "33333333-3333-4333-8333-333333333333";
const PASS2 = "55555555-5555-4555-8555-555555555555";
const priv = new Uint8Array(32).fill(7);
const secret = new Uint8Array(32).fill(3);
const salt = new Uint8Array(16).fill(5);
const signed = signPass({ passId: PASS, lotId: LOT, keyId: 1, privateKey: priv }).signedPart;

function entry(over: Partial<GatePassEntry> = {}): GatePassEntry {
  return {
    passId: PASS, lotId: LOT, reference: "AV-ONE", driverName: "Adaeze Okafor", plate: "LND123AB",
    start: "2030-01-01T08:00:00.000Z", end: "2030-01-01T11:00:00.000Z", earlyEntryMinutes: 15, accessible: false,
    status: "active", totpSecret: toBase64Url(secret), pinHash: pinHash(salt, LOT, "482913"), onSite: false, ...over,
  };
}

function doc(passes: GatePassEntry[] = [entry()]): CacheDocument {
  return {
    lotId: LOT, pinSalt: toBase64Url(salt), generatedAt: "2029-12-31T12:00:00.000Z", validUntil: "2030-01-01T12:00:00.000Z",
    publicKeys: [{ keyId: 1, publicKey: toBase64Url(publicKeyFor(priv)) }], passes,
  };
}

/** A server that records what it received and can drop off the network, or lose its reply. */
class FakeServer implements GateApi {
  offline = false;
  loseReply = false;
  revoked = false;
  received = new Map<string, GateEvent>();
  cacheDoc = doc();
  async fetchCache() {
    if (this.offline) throw new NetworkError("offline");
    if (this.revoked) throw new DeviceRevokedError("revoked");
    return structuredClone(this.cacheDoc);
  }
  async sendEvents(events: GateEvent[]) {
    if (this.offline) throw new NetworkError("offline");
    const results: SyncResult[] = events.map((e) => {
      const dup = this.received.has(e.id);
      this.received.set(e.id, e);
      return { id: e.id, outcome: dup ? "duplicate" : "accepted", flags: [] };
    });
    if (this.loseReply) throw new NetworkError("connection dropped after the server committed");
    return { results };
  }
}

let t = new Date("2030-01-01T07:50:00Z");
let seq = 0;
const now = () => t;
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
let server: FakeServer;
let store: GateStore;
let gate: GateClient;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory(); // a fresh device for every test
  t = new Date("2030-01-01T07:50:00Z");
  server = new FakeServer();
  store = await GateStore.open();
  gate = new GateClient(store, server, now, id);
  expect(await gate.refreshCache()).toBe(true);
});

describe("Offline verification and recording (US-038, US-040, US-042)", () => {
  it("verifies, admits and records exit with no network, queuing both records in order", async () => {
    server.offline = true;
    gate.setConnectivity(false); // the browser reports going offline
    const v = await gate.scan(qrText(signed, secret, t));
    expect(v).toMatchObject({ status: "VALID", onSite: false, actions: ["record_entry"], pass: { plate: "LND123AB" } });

    const entryEvent = await gate.recordEntry(v, true);
    expect(entryEvent).toMatchObject({ kind: "entry", method: "qr", passId: PASS, deviceResult: "VALID", plateConfirmed: true });
    expect(await gate.pending()).toBe(1);

    t = new Date("2030-01-01T10:30:00Z");
    const again = await gate.scan(qrText(signed, secret, t));
    expect(again).toMatchObject({ onSite: true, actions: ["record_exit"] });
    await gate.recordExit(again);

    const r = await gate.flush();
    expect(r).toMatchObject({ sent: 0, remaining: 2 });
    const queued = await store.peek<GateEvent>(10);
    expect(queued.map((q) => q.event.kind)).toEqual(["entry", "exit"]);
    expect(queued.every((q) => q.event.recordedOffline)).toBe(true);
  });

  it("will not admit without the plate confirmed, twice, or on anything but VALID", async () => {
    const v = await gate.scan(qrText(signed, secret, t));
    await expect(gate.recordEntry(v, false)).rejects.toThrow(/Confirm the plate/);
    await gate.recordEntry(v, true);
    const second = await gate.scan(qrText(signed, secret, t));
    await expect(gate.recordEntry({ ...second, onSite: true }, true)).rejects.toThrow(/already recorded/);
    t = new Date("2030-01-01T07:40:00Z");
    const early = await gate.enterPin("482913");
    expect(early.status).toBe("NOT_YET_DUE");
    await expect(gate.recordEntry(early, true)).rejects.toThrow(/Only a VALID pass/);
  });

  it("never leaves the attendant at a dead end (US-041)", async () => {
    const stale = await gate.scan(qrText(signed, secret, new Date(t.getTime() - 10 * 60_000)));
    expect(stale.status).toBe("STALE_CODE");
    expect(stale.actions).toEqual(["ask_for_live_pass", "try_pin", "search_plate", "contact_operations", "manual_exception"]);
    const unknown = await gate.scan("not a pass");
    expect(unknown).toMatchObject({ status: "NOT_FOUND", actions: ["try_pin", "search_plate", "contact_operations", "manual_exception"] });
    const manual = await gate.recordManualException({ kind: "entry", plate: "xyz 987 ab", reason: "Phone dead, booking confirmed by ops by phone", deviceResult: "NOT_FOUND" });
    expect(manual).toMatchObject({ method: "manual", plate: "XYZ987AB" });
    await expect(gate.recordManualException({ kind: "entry", plate: "X", reason: " ", deviceResult: "NOT_FOUND" })).rejects.toThrow(/reason/);
  });

  it("finds bookings by partial plate, tolerating case and separators (US-039)", async () => {
    server.cacheDoc = doc([entry(), entry({ passId: PASS2, reference: "AV-TWO", plate: "LND999ZZ", pinHash: pinHash(salt, LOT, "111111") })]);
    await gate.refreshCache();
    const all = await gate.searchPlate("lnd");
    expect(all.map((v) => ("pass" in v ? v.pass.reference : "")).sort()).toEqual(["AV-ONE", "AV-TWO"]);
    const one = await gate.searchPlate("123-ab");
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ status: "VALID", method: "plate" });
  });
});

describe("Sync (NFR-OFF-03)", () => {
  it("sends queued records once, in order, when the network returns", async () => {
    server.offline = true;
    await gate.recordEntry(await gate.scan(qrText(signed, secret, t)), true);
    server.offline = false;
    expect(await gate.flush()).toMatchObject({ sent: 1, remaining: 0 });
    expect(server.received.size).toBe(1);
    expect(await gate.flush()).toMatchObject({ sent: 0, remaining: 0 });
  });

  it("repeats safely when the connection drops after the server committed", async () => {
    await gate.recordEntry(await gate.scan(qrText(signed, secret, t)), true);
    server.loseReply = true;
    expect(await gate.flush()).toMatchObject({ remaining: 1 });
    server.loseReply = false;
    const r = await gate.flush();
    expect(r).toMatchObject({ sent: 0, remaining: 0 }); // acknowledged as a duplicate
    expect(server.received.size).toBe(1);
  });

  it("survives a restart: the queue, the cache and on-site state are still there", async () => {
    server.offline = true;
    await gate.recordEntry(await gate.scan(qrText(signed, secret, t)), true);
    store.close();
    const reopened = new GateClient(await GateStore.open(), server, now, id);
    expect(await reopened.load()).toBe(true);
    expect(await reopened.pending()).toBe(1);
    expect((await reopened.scan(qrText(signed, secret, t))).onSite).toBe(true);
  });

  it("keeps its own unsynced entries on site when a fresh cache arrives", async () => {
    server.offline = true;
    await gate.recordEntry(await gate.scan(qrText(signed, secret, t)), true);
    server.offline = false; // the cache still says not on site: the server has not seen the entry yet
    await gate.refreshCache();
    expect((await gate.scan(qrText(signed, secret, t))).onSite).toBe(true);
  });
});

describe("Protecting the cache (NFR-OFF-05, US-055)", () => {
  it("stores nothing readable: the pass set and the queue are encrypted on the device", async () => {
    await gate.recordEntry(await gate.scan(qrText(signed, secret, t)), true);
    const dump = await new Promise<string>((resolve) => {
      const req = indexedDB.open("availo-gate");
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(["cache", "queue"]);
        const out: unknown[] = [];
        tx.objectStore("cache").getAll().onsuccess = (e) => out.push((e.target as IDBRequest).result);
        tx.objectStore("queue").getAll().onsuccess = (e) => out.push((e.target as IDBRequest).result);
        tx.oncomplete = () => { db.close(); resolve(JSON.stringify(out, (_k, v) => (v instanceof ArrayBuffer ? Array.from(new Uint8Array(v)) : v))); };
      };
    });
    expect(dump).not.toMatch(/LND123AB|Adaeze|AV-ONE/);
  });

  it("purges the pass set at the end of its window and refuses to verify from it", async () => {
    t = new Date("2030-01-01T12:00:00Z");
    expect(await gate.load()).toBe(false);
    await expect(gate.scan(qrText(signed, secret, t))).rejects.toThrow(/No valid gate cache/);
  });

  it("purges the pass set when the device is revoked, but keeps unsynced records", async () => {
    server.offline = true;
    await gate.recordEntry(await gate.scan(qrText(signed, secret, t)), true);
    server.offline = false;
    server.revoked = true;
    await expect(gate.refreshCache()).rejects.toThrow(DeviceRevokedError);
    expect(await store.getCache()).toBeNull();
    expect(await gate.pending()).toBe(1);
  });
});
