/**
 * The gate end to end against the real API and Postgres: device enrolment,
 * attendant sign-in, cache download, then verification and recording with the
 * network cut, and sync afterwards (US-040, US-042, US-055, NFR-OFF-01..05).
 *
 * "Offline" here means the gate client's transport refuses every call, so the
 * client can only use what it stored. The browser test with the network truly
 * disabled comes with the attendant PWA.
 */
import "reflect-metadata";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, seed, SEED, type SeedResult } from "@availo/db";
import { fromBase64Url, qrText } from "@availo/pass";
import { DeviceRevokedError, GateClient, GateStore, NetworkError, type CacheDocument, type GateApi, type GateEvent } from "@availo/gate-client";
import { AppModule } from "../src/app.module.js";
import { loadConfig } from "../src/config.js";
import { DevSmsSender } from "../src/sms/sms.js";
import { GateAuthService } from "../src/gate/gate-auth.service.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/availo_test";
// Server and gate device share one clock here; CLOCK_SKEW is tested by moving the device alone.
const T0 = new Date("2030-01-01T07:00:00Z");
const ATTENDANT_MOBILE = "+2348110000001";

const clock = { t: T0, now() { return this.t; }, advance(s: number) { this.t = new Date(this.t.getTime() + s * 1000); } };
const sms = new DevSmsSender();
const pool = new pg.Pool({ connectionString: DATABASE_URL });
let app: INestApplication;
let seeded: SeedResult;
const http = () => request(app.getHttpServer());
const lastCode = (m: string) => /\b(\d{6})\b/.exec(sms.lastTo(m)?.body ?? "")?.[1] ?? "";

/** The gate client's transport over real HTTP, with a switch that cuts the network. */
class HttpGateApi implements GateApi {
  offline = false;
  constructor(private token: string, private readonly deviceToken: string) {}
  private headers() { return { Authorization: `Bearer ${this.token}`, "X-Gate-Device": this.deviceToken }; }
  async fetchCache(): Promise<CacheDocument> {
    if (this.offline) throw new NetworkError("offline");
    const r = await http().get("/gate/cache").set(this.headers());
    if (r.status === 403 && r.body.error?.code === "DEVICE_REVOKED") throw new DeviceRevokedError("revoked");
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    return r.body as CacheDocument;
  }
  async sendEvents(events: GateEvent[]) {
    if (this.offline) throw new NetworkError("offline");
    const r = await http().post("/gate/events").set(this.headers()).send({ events });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    return r.body;
  }
}

async function driverBooks(i = 0, start = "2030-01-01T09:00:00+01:00", hours = 3) {
  const m = SEED.drivers[i]!.mobile;
  await http().post("/auth/otp/request").send({ mobile: m }).expect(202);
  const token = (await http().post("/auth/otp/verify").send({ mobile: m, code: lastCode(m) }).expect(200)).body.accessToken;
  const b = await http().post("/reservations").set("Authorization", `Bearer ${token}`)
    .send({ lotId: seeded.lotId, vehicleId: seeded.users[i]!.vehicleId, start, hours }).expect(201);
  const pass = (await http().get(`/reservations/${b.body.id}/pass`).set("Authorization", `Bearer ${token}`).expect(200)).body;
  return { reservationId: b.body.id as string, pass, token: token as string };
}

async function enrolDevice() {
  const gateAuth = app.get(GateAuthService);
  await gateAuth.createAttendant({ lotId: seeded.lotId, mobile: ATTENDANT_MOBILE, name: "Gate Attendant", createdBy: "test" });
  const { deviceId, enrolmentCode } = await gateAuth.createDevice({ lotId: seeded.lotId, label: "Gate phone 1", createdBy: "test" });
  const enrolled = (await http().post("/gate/devices/enrol").send({ enrolmentCode }).expect(201)).body;
  await http().post("/auth/otp/request").send({ mobile: ATTENDANT_MOBILE }).expect(202);
  const signIn = await http().post("/gate/auth/verify").set("X-Gate-Device", enrolled.deviceToken)
    .send({ mobile: ATTENDANT_MOBILE, code: lastCode(ATTENDANT_MOBILE) }).expect(200);
  return { deviceId, enrolmentCode, deviceToken: enrolled.deviceToken as string, accessToken: signIn.body.accessToken as string };
}

let deviceTime = T0;
let deviceSkewMs = 0;
const setTime = (iso: string) => { deviceTime = new Date(iso); clock.t = deviceTime; };

async function gateDevice(accessToken: string, deviceToken: string) {
  globalThis.indexedDB = new IDBFactory();
  const api = new HttpGateApi(accessToken, deviceToken);
  const client = new GateClient(await GateStore.open(), api, () => new Date(deviceTime.getTime() + deviceSkewMs));
  return { api, client };
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({
    imports: [AppModule.forRoot(loadConfig({ NODE_ENV: "test", DATABASE_URL }), { clock, sms })],
  }).compile();
  app = mod.createNestApplication({ logger: false });
  await app.init();
});

beforeEach(async () => {
  clock.t = T0;
  deviceTime = T0;
  deviceSkewMs = 0;
  sms.outbox.length = 0;
  const c = await pool.connect();
  try {
    await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(c);
    seeded = await seed(c);
  } finally {
    c.release();
  }
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("Device enrolment and attendant sign-in (US-055)", () => {
  it("uses an enrolment code once only", async () => {
    const d = await enrolDevice();
    const again = await http().post("/gate/devices/enrol").send({ enrolmentCode: d.enrolmentCode }).expect(401);
    expect(again.body.error.code).toBe("ENROLMENT_INVALID");
  });

  it("signs in only an attendant for this device's lot, and only on an enrolled device", async () => {
    const d = await enrolDevice();
    // A driver's number is not an attendant.
    const driver = SEED.drivers[0]!.mobile;
    clock.advance(61);
    await http().post("/auth/otp/request").send({ mobile: driver }).expect(202);
    const r = await http().post("/gate/auth/verify").set("X-Gate-Device", d.deviceToken).send({ mobile: driver, code: lastCode(driver) }).expect(403);
    expect(r.body.error.code).toBe("NOT_AN_ATTENDANT_HERE");
    // No device token, no sign-in.
    await http().post("/gate/auth/verify").send({ mobile: ATTENDANT_MOBILE, code: "000000" }).expect(401);
  });

  it("keeps attendant and driver credentials apart, and binds the session to its device", async () => {
    const d = await enrolDevice();
    const { token: driverToken } = await driverBooks();
    await http().get("/gate/cache").set({ Authorization: `Bearer ${driverToken}`, "X-Gate-Device": d.deviceToken }).expect(401);
    await http().get("/me").set("Authorization", `Bearer ${d.accessToken}`).expect(401);
    await http().get("/gate/cache").set({ Authorization: `Bearer ${d.accessToken}`, "X-Gate-Device": "not-this-device" }).expect(401);
  });
});

describe("The offline gate, end to end (NFR-OFF-01 to NFR-OFF-04)", () => {
  it("downloads passes, then with the network cut verifies, admits and releases; syncs once when back", async () => {
    const { pass, reservationId } = await driverBooks();
    const d = await enrolDevice();
    const { api, client } = await gateDevice(d.accessToken, d.deviceToken);
    expect(await client.refreshCache()).toBe(true);
    setTime("2030-01-01T07:50:00Z"); // 08:50 WAT, ten minutes before the booking

    api.offline = true; // —— signal lost at the gate ——
    client.setConnectivity(false);
    const secret = fromBase64Url(pass.qr.totpSecret)!;
    const phoneQr = () => qrText(pass.qr.signedPart, secret, deviceTime);

    const started = performance.now();
    const v = await client.scan(phoneQr());
    expect(performance.now() - started).toBeLessThan(3000); // NFR-PER-02
    expect(v).toMatchObject({ status: "VALID", pass: { plate: "LND123AB", driverName: SEED.drivers[0]!.name } });
    await client.recordEntry(v, true);

    setTime("2030-01-01T10:40:00Z");
    await client.recordExit(await client.scan(phoneQr()));
    expect(await client.flush()).toMatchObject({ sent: 0, remaining: 2 });
    expect((await pool.query("SELECT count(*)::int AS n FROM gate_event")).rows[0].n).toBe(0);

    api.offline = false; // —— signal back ——
    const synced = await client.flush();
    expect(synced).toEqual({ sent: 2, flagged: [], remaining: 0 });

    const { rows: events } = await pool.query("SELECT kind::text, method::text, recorded_offline, conflict, reservation_id FROM gate_event ORDER BY occurred_at");
    expect(events).toEqual([
      { kind: "entry", method: "qr", recorded_offline: true, conflict: null, reservation_id: reservationId },
      { kind: "exit", method: "qr", recorded_offline: true, conflict: null, reservation_id: reservationId },
    ]);
    const { rows: [session] } = await pool.query("SELECT state::text, entered_at, exited_at FROM parking_session WHERE reservation_id = $1", [reservationId]);
    expect(session).toEqual({ state: "ended", entered_at: new Date("2030-01-01T07:50:00Z"), exited_at: new Date("2030-01-01T10:40:00Z") });
  });

  it("never duplicates a record, however often the same batch is sent", async () => {
    await driverBooks();
    const d = await enrolDevice();
    const { client } = await gateDevice(d.accessToken, d.deviceToken);
    await client.refreshCache();
    const { pass } = { pass: (await pool.query("SELECT id FROM access_pass")).rows[0] };
    const e = await client.recordManualException({ kind: "entry", plate: "LND123AB", reason: "Scanner fault", deviceResult: "NOT_FOUND", passId: pass.id });
    const headers = { Authorization: `Bearer ${d.accessToken}`, "X-Gate-Device": d.deviceToken };
    const first = await http().post("/gate/events").set(headers).send({ events: [e] }).expect(200);
    const second = await http().post("/gate/events").set(headers).send({ events: [e] }).expect(200);
    expect(first.body.results[0]).toMatchObject({ outcome: "accepted", flags: ["MANUAL_EXCEPTION"] });
    expect(second.body.results[0]).toMatchObject({ outcome: "duplicate", flags: ["MANUAL_EXCEPTION"] });
    expect((await pool.query("SELECT count(*)::int AS n FROM gate_event")).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM parking_session")).rows[0].n).toBe(1);
  });

  it("flags, and keeps, an entry made offline after the booking was cancelled — the server wins", async () => {
    const { pass, reservationId } = await driverBooks();
    const d = await enrolDevice();
    const { api, client } = await gateDevice(d.accessToken, d.deviceToken);
    await client.refreshCache();
    setTime("2030-01-01T07:50:00Z");
    api.offline = true;
    // Cancelled on the server while the gate is offline (the cancel path itself arrives with OD-11).
    await pool.query("UPDATE reservation SET status = 'cancelled' WHERE id = $1", [reservationId]);
    const v = await client.scan(qrText(pass.qr.signedPart, fromBase64Url(pass.qr.totpSecret)!, deviceTime));
    expect(v.status).toBe("VALID"); // the device could not know
    await client.recordEntry(v, true);

    api.offline = false;
    const r = await client.flush();
    expect(r.flagged).toHaveLength(1);
    expect(r.flagged[0]!.flags).toEqual(["CANCELLED_WHILE_OFFLINE"]);
    const { rows: [e] } = await pool.query("SELECT conflict, review_state FROM gate_event");
    expect(e).toEqual({ conflict: "CANCELLED_WHILE_OFFLINE", review_state: "flagged" });
    // The car is physically in, so the session is recorded for occupancy and review.
    expect((await pool.query("SELECT state::text FROM parking_session")).rows[0].state).toBe("active");

    // A fresh cache now shows it cancelled.
    await client.refreshCache();
    expect((await client.scan(qrText(pass.qr.signedPart, fromBase64Url(pass.qr.totpSecret)!, deviceTime))).status).toBe("CANCELLED");
  });

  it("flags an exit with no entry, and a second entry for a vehicle already on site", async () => {
    const { pass } = await driverBooks();
    const d = await enrolDevice();
    const headers = { Authorization: `Bearer ${d.accessToken}`, "X-Gate-Device": d.deviceToken };
    const base = { method: "qr", passId: pass.passId, plate: "LND123AB", deviceResult: "VALID", plateConfirmed: true, recordedOffline: false };
    const ev = (n: number, kind: string, at: string) => ({ ...base, id: `00000000-0000-4000-8000-00000000000${n}`, kind, occurredAt: at });
    setTime("2030-01-01T08:10:00Z");
    const r = await http().post("/gate/events").set(headers).send({ events: [
      ev(1, "exit", "2030-01-01T07:55:00Z"),
      ev(2, "entry", "2030-01-01T08:00:00Z"),
      ev(3, "entry", "2030-01-01T08:05:00Z"),
    ] }).expect(200);
    expect(r.body.results.map((x: { flags: string[] }) => x.flags)).toEqual([["EXIT_WITHOUT_ENTRY"], [], ["DUPLICATE_ENTRY"]]);
  });

  it("carries vehicles still on site in the next cache, so exit works on a device that did not record the entry", async () => {
    const { pass } = await driverBooks();
    const d = await enrolDevice();
    const first = await gateDevice(d.accessToken, d.deviceToken);
    await first.client.refreshCache();
    setTime("2030-01-01T07:50:00Z");
    const secret = fromBase64Url(pass.qr.totpSecret)!;
    await first.client.recordEntry(await first.client.scan(qrText(pass.qr.signedPart, secret, deviceTime)), true);
    await first.client.flush();

    const second = await gateDevice(d.accessToken, d.deviceToken); // fresh storage, as after reinstall
    await second.client.refreshCache();
    const v = await second.client.scan(qrText(pass.qr.signedPart, secret, deviceTime));
    expect(v).toMatchObject({ onSite: true, actions: ["record_exit"] });
  });
});

describe("Device clocks (NFR-OFF-04)", () => {
  it("flags, but keeps, a record from a device whose clock runs well ahead of the server", async () => {
    const { pass } = await driverBooks();
    const d = await enrolDevice();
    const { client } = await gateDevice(d.accessToken, d.deviceToken);
    await client.refreshCache();
    setTime("2030-01-01T07:50:00Z");
    deviceSkewMs = 11 * 60_000;
    const v = await client.scan(qrText(pass.qr.signedPart, fromBase64Url(pass.qr.totpSecret)!, new Date(deviceTime.getTime() + deviceSkewMs)));
    await client.recordEntry(v, true);
    const r = await client.flush();
    expect(r.flagged[0]!.flags).toEqual(["CLOCK_SKEW"]);
  });
});

describe("Revocation (US-055)", () => {
  it("stops cache download and purges the device, but still takes and flags the records it holds", async () => {
    const { pass } = await driverBooks();
    const d = await enrolDevice();
    const { api, client } = await gateDevice(d.accessToken, d.deviceToken);
    await client.refreshCache();
    setTime("2030-01-01T07:50:00Z");
    api.offline = true;
    await client.recordEntry(await client.scan(qrText(pass.qr.signedPart, fromBase64Url(pass.qr.totpSecret)!, deviceTime)), true);

    await app.get(GateAuthService).revokeDevice(d.deviceId, "Phone lost");
    api.offline = false;
    await expect(client.refreshCache()).rejects.toThrow(DeviceRevokedError);
    await expect(client.scan("anything")).rejects.toThrow(/No valid gate cache/);

    const r = await client.flush();
    expect(r).toMatchObject({ remaining: 0 });
    expect(r.flagged[0]!.flags).toContain("DEVICE_REVOKED");
    expect((await pool.query("SELECT review_state FROM gate_event")).rows[0].review_state).toBe("flagged");
  });
});
