/**
 * Sprint 1 API spine over HTTP against real Postgres: OTP sign-in (US-001),
 * self-serve registration (US-002, US-003, US-005, US-006, US-131), availability
 * and reservation (US-021, US-022, US-023, US-133), and §4.13 step 5.
 */
import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, seed, SEED, type SeedResult } from "@availo/db";
import { AppModule } from "../src/app.module.js";
import { loadConfig } from "../src/config.js";
import { DevSmsSender } from "../src/sms/sms.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/availo_test";
const T0 = new Date("2029-12-31T12:00:00Z");
const TOMORROW_9 = "2030-01-01T09:00:00+01:00"; // West Africa Time, stored UTC (NFR-LOC-03)

const clock = { t: T0, now() { return this.t; }, advance(s: number) { this.t = new Date(this.t.getTime() + s * 1000); } };
const sms = new DevSmsSender();
const pool = new pg.Pool({ connectionString: DATABASE_URL });
let app: INestApplication;
let seeded: SeedResult;

const http = () => request(app.getHttpServer());
const lastCode = (mobile: string) => /\b(\d{6})\b/.exec(sms.lastTo(mobile)?.body ?? "")?.[1] ?? "";

async function otp(mobile: string, e164 = mobile) {
  await http().post("/auth/otp/request").send({ mobile }).expect(202);
  return http().post("/auth/otp/verify").send({ mobile, code: lastCode(e164) });
}

async function signInSeeded(i = 0): Promise<string> {
  const d = SEED.drivers[i]!;
  const r = await otp(d.mobile);
  expect(r.body.status).toBe("signed_in");
  return r.body.accessToken as string;
}

async function registerNew(mobile: string, e164: string, body: Record<string, unknown>) {
  const v = await otp(mobile, e164);
  expect(v.body.status).toBe("registration_required");
  return http().post("/registrations").send({ registrationToken: v.body.registrationToken, ...body });
}

async function registered(mobile: string, e164: string, body: Record<string, unknown>) {
  const r = await registerNew(mobile, e164, body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r;
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

describe("US-001 OTP sign-in", () => {
  it("accepts local and international forms of the same number as one account", async () => {
    const e164 = SEED.drivers[0].mobile; // +2348030000001
    const local = await otp("0803 000 0001", e164);
    expect(local.body.status).toBe("signed_in");
    clock.advance(61);
    const intl = await otp("+234 803 000 0001", e164);
    expect(intl.body.status).toBe("signed_in");
  });

  it("stores only a hash of the code", async () => {
    await http().post("/auth/otp/request").send({ mobile: SEED.drivers[0].mobile }).expect(202);
    const code = lastCode(SEED.drivers[0].mobile);
    const { rows } = await pool.query("SELECT code_hash FROM otp_challenge");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(code);
  });

  it("throttles resend to one per sixty seconds", async () => {
    const m = SEED.drivers[0].mobile;
    await http().post("/auth/otp/request").send({ mobile: m }).expect(202);
    clock.advance(30);
    const r = await http().post("/auth/otp/request").send({ mobile: m }).expect(429);
    expect(r.body.error).toMatchObject({ code: "OTP_RESEND_TOO_SOON", retryAfterSeconds: 30 });
    clock.advance(31);
    await http().post("/auth/otp/request").send({ mobile: m }).expect(202);
  });

  it("allows five attempts, then locks the code even if the sixth is right", async () => {
    const m = SEED.drivers[0].mobile;
    await http().post("/auth/otp/request").send({ mobile: m }).expect(202);
    const code = lastCode(m);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let left = 4; left >= 1; left--) {
      const r = await http().post("/auth/otp/verify").send({ mobile: m, code: wrong }).expect(401);
      expect(r.body.error).toMatchObject({ code: "OTP_INCORRECT", attemptsRemaining: left });
    }
    await http().post("/auth/otp/verify").send({ mobile: m, code: wrong }).expect(429);
    const r = await http().post("/auth/otp/verify").send({ mobile: m, code }).expect(429);
    expect(r.body.error.code).toBe("OTP_LOCKED");
  });

  it("expires a code after five minutes", async () => {
    const m = SEED.drivers[0].mobile;
    await http().post("/auth/otp/request").send({ mobile: m }).expect(202);
    clock.advance(301);
    const r = await http().post("/auth/otp/verify").send({ mobile: m, code: lastCode(m) }).expect(401);
    expect(r.body.error.code).toBe("OTP_EXPIRED");
  });

  it("accepts a code only once", async () => {
    const m = SEED.drivers[0].mobile;
    await http().post("/auth/otp/request").send({ mobile: m }).expect(202);
    await http().post("/auth/otp/verify").send({ mobile: m, code: lastCode(m) }).expect(200);
    await http().post("/auth/otp/verify").send({ mobile: m, code: lastCode(m) }).expect(401);
  });

  it("rejects a number that is not a Nigerian mobile, saying what is expected", async () => {
    const r = await http().post("/auth/otp/request").send({ mobile: "+1 416 555 1234" }).expect(400);
    expect(r.body.error.fields[0]).toMatchObject({ path: "mobile" });
    expect(r.body.error.fields[0].message).toMatch(/Nigerian mobile/);
  });

  it("rotates refresh tokens and revokes the family when a rotated token is reused", async () => {
    const r = await otp(SEED.drivers[0].mobile);
    const first = r.body.refreshToken as string;
    const second = (await http().post("/auth/refresh").send({ refreshToken: first }).expect(200)).body.refreshToken as string;
    const reuse = await http().post("/auth/refresh").send({ refreshToken: first }).expect(401);
    expect(reuse.body.error.code).toBe("SESSION_REVOKED");
    await http().post("/auth/refresh").send({ refreshToken: second }).expect(401);
  });
});

describe("Self-serve registration (US-002, US-003, US-005, US-006, US-131)", () => {
  it("registers a student who can see capacity immediately, with no administrator in the path", async () => {
    const r = await registered("08090000001", "+2348090000001", {
      name: "Chidi Nwosu", userType: "student", campusIdentifier: "190401001", vehicle: { plate: "abc-123 de" },
    });
    expect(r.body.user).toMatchObject({ userType: "student", verificationState: "verified" });
    expect(r.body.vehicle).toEqual({ id: expect.any(String), plate: "ABC123DE" });

    const me = await http().get("/me").set("Authorization", `Bearer ${r.body.accessToken}`).expect(200);
    expect(me.body).toMatchObject({ verificationState: "verified", walletBalanceKobo: "0" });

    const a = await http().get(`/lots/${seeded.lotId}/availability`).query({ start: TOMORROW_9, hours: 2 })
      .set("Authorization", `Bearer ${r.body.accessToken}`).expect(200);
    expect(a.body.available).toBe(18);
  });

  it("registers a guest with no campus identifier and no wallet", async () => {
    const r = await registered("07010000001", "+2347010000001", { name: "Visitor One", userType: "guest", vehicle: { plate: "LAG 1234" } });
    expect(r.body.vehicle.warning).toBe("UNUSUAL_PLATE_FORMAT");
    const me = await http().get("/me").set("Authorization", `Bearer ${r.body.accessToken}`).expect(200);
    expect(me.body.walletBalanceKobo).toBeNull();
  });

  it("requires a campus identifier from staff and students", async () => {
    const r = await registerNew("08090000002", "+2348090000002", { name: "No Id", userType: "staff", vehicle: { plate: "ABC123DE" } });
    expect(r.status).toBe(400);
    expect(r.body.error.fields[0].path).toBe("campusIdentifier");
  });

  it("rejects an identifier or a plate already held by an active account", async () => {
    const id = await registerNew("08090000003", "+2348090000003", {
      name: "Dup Id", userType: "staff", campusIdentifier: SEED.drivers[0].staffNo, vehicle: { plate: "ZZZ999ZZ" } });
    expect(id.status).toBe(409);
    expect(id.body.error.code).toBe("IDENTIFIER_IN_USE");

    clock.advance(61);
    const plate = await registerNew("08090000004", "+2348090000004", {
      name: "Dup Plate", userType: "guest", vehicle: { plate: SEED.drivers[0].plate.toLowerCase() } });
    expect(plate.status).toBe(409);
    expect(plate.body.error.code).toBe("PLATE_IN_USE");
  });
});

describe("Availability and reservation over HTTP (US-022, US-023, US-133, §4.13 step 5)", () => {
  it("shows staff 12 campus + 6 open, charges the block from the wallet, and the ring-fence falls from 12 to 11", async () => {
    const token = await signInSeeded(0);
    const auth = { Authorization: `Bearer ${token}` };
    const before = await http().get(`/lots/${seeded.lotId}/availability`).query({ start: TOMORROW_9, hours: 3 }).set(auth).expect(200);
    expect(before.body).toMatchObject({
      available: 18,
      pools: [{ kind: "campus", capacity: 12, available: 12 }, { kind: "open", capacity: 6, available: 6 }],
      amountKobo: "150000", balanceBeforeKobo: "500000", balanceAfterKobo: "350000",
      terms: { earlyCheckoutRefund: false },
    });

    const r = await http().post("/reservations").set(auth)
      .send({ lotId: seeded.lotId, vehicleId: seeded.users[0]!.vehicleId, start: TOMORROW_9, hours: 3 }).expect(201);
    expect(r.body).toMatchObject({ pool: "campus", hours: 3, amountKobo: "150000", rateAppliedKobo: "50000", status: "confirmed", plate: "LND123AB" });
    expect(r.body.window).toEqual({ start: "2030-01-01T08:00:00.000Z", end: "2030-01-01T11:00:00.000Z" });

    const after = await http().get(`/lots/${seeded.lotId}/availability`).query({ start: TOMORROW_9, hours: 3 }).set(auth).expect(200);
    expect(after.body.pools[0]).toEqual({ kind: "campus", capacity: 12, available: 11 });
    const me = await http().get("/me").set(auth).expect(200);
    expect(me.body.walletBalanceKobo).toBe("350000");
  });

  it("returns the original booking for a retried Idempotency-Key and debits once", async () => {
    const token = await signInSeeded(0);
    const send = () => http().post("/reservations").set({ Authorization: `Bearer ${token}`, "Idempotency-Key": "retry-key-0001" })
      .send({ lotId: seeded.lotId, vehicleId: seeded.users[0]!.vehicleId, start: TOMORROW_9, hours: 1 });
    const [a, b] = await Promise.all([send(), send()]);
    expect(a.body.id).toBeDefined();
    expect(b.body.id).toBe(a.body.id);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM wallet_entry WHERE entry_type = 'reservation_debit'");
    expect(rows[0].n).toBe(1);
  });

  it("states the shortfall when the wallet cannot cover the block (US-021)", async () => {
    const token = await signInSeeded(2); // ₦1,000 seeded
    const r = await http().post("/reservations").set("Authorization", `Bearer ${token}`)
      .send({ lotId: seeded.lotId, vehicleId: seeded.users[2]!.vehicleId, start: TOMORROW_9, hours: 3 }).expect(402);
    expect(r.body.error).toMatchObject({ code: "INSUFFICIENT_BALANCE", shortfallKobo: "50000" });
  });

  it("shows a guest the open share only, and never lets any request reach the ring-fence or accessible pool", async () => {
    const g = (await registered("07010000002", "+2347010000002", { name: "Visitor Two", userType: "guest", vehicle: { plate: "GST001AA" } })).body;
    const auth = { Authorization: `Bearer ${g.accessToken}` };
    const a = await http().get(`/lots/${seeded.lotId}/availability`).query({ start: TOMORROW_9, hours: 2 }).set(auth).expect(200);
    expect(a.body.pools).toEqual([{ kind: "open", capacity: 6, available: 6 }]);
    expect(a.body.balanceBeforeKobo).toBeNull();

    const acc = await http().get(`/lots/${seeded.lotId}/availability`).query({ start: TOMORROW_9, hours: 2, accessible: "true" }).set(auth).expect(403);
    expect(acc.body.error.code).toBe("NOT_ELIGIBLE");

    const r = await http().post("/reservations").set(auth)
      .send({ lotId: seeded.lotId, vehicleId: g.vehicle.id, start: TOMORROW_9, hours: 2 }).expect(422);
    expect(r.body.error.code).toBe("WALLET_PATH_NOT_AVAILABLE");
  });

  it("refuses accessible capacity to an ineligible staff account whatever the client sends (US-024, NFR-SEC-09)", async () => {
    const token = await signInSeeded(0);
    const r = await http().post("/reservations").set("Authorization", `Bearer ${token}`)
      .send({ lotId: seeded.lotId, vehicleId: seeded.users[0]!.vehicleId, start: TOMORROW_9, hours: 1, accessible: true }).expect(403);
    expect(r.body.error.code).toBe("NOT_ELIGIBLE");
  });

  it("refuses unauthenticated calls, other drivers' vehicles, and other drivers' bookings", async () => {
    await http().post("/reservations").send({}).expect(401);
    const t0 = await signInSeeded(0);
    const t1 = await signInSeeded(1);
    const wrongVehicle = await http().post("/reservations").set("Authorization", `Bearer ${t0}`)
      .send({ lotId: seeded.lotId, vehicleId: seeded.users[1]!.vehicleId, start: TOMORROW_9, hours: 1 }).expect(422);
    expect(wrongVehicle.body.error.code).toBe("VEHICLE_NOT_REGISTERED");

    const mine = await http().post("/reservations").set("Authorization", `Bearer ${t0}`)
      .send({ lotId: seeded.lotId, vehicleId: seeded.users[0]!.vehicleId, start: TOMORROW_9, hours: 1 }).expect(201);
    await http().get(`/reservations/${mine.body.id}`).set("Authorization", `Bearer ${t1}`).expect(404);
    await http().get(`/reservations/${mine.body.id}`).set("Authorization", `Bearer ${t0}`).expect(200);
  });

  it("refuses a start in the past", async () => {
    const token = await signInSeeded(0);
    const r = await http().post("/reservations").set("Authorization", `Bearer ${token}`)
      .send({ lotId: seeded.lotId, vehicleId: seeded.users[0]!.vehicleId, start: "2029-12-31T08:00:00Z", hours: 1 }).expect(422);
    expect(r.body.error.code).toBe("INVALID_WINDOW");
  });
});
