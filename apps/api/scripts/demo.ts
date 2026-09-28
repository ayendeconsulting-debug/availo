/**
 * Sprint 1 headless demo (handover §7 item 12). Runs the walking skeleton end
 * to end against a real API process and Postgres, ten times, and fails loudly
 * if any invariant breaks:
 *
 *   a staff member registers, holds a seeded wallet, reserves one hour, gets a
 *   pass, is scanned in by a gate device with no network, the entry syncs,
 *   they are scanned out offline, the exit syncs — and the reservation, the
 *   ledger, the balance, occupancy and the capacity cap all agree.
 *
 *   pnpm demo                       # ten runs
 *   DEMO_RUNS=50 pnpm demo          # more
 *
 * Uses its own database (availo_demo), dropped and rebuilt on every start.
 */
import "fake-indexeddb/auto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { IDBFactory } from "fake-indexeddb";
import { DeviceRevokedError, GateClient, GateStore, NetworkError, type CacheDocument, type GateApi, type GateEvent, type SyncResult } from "@availo/gate-client";
import { fromBase64Url, qrText } from "@availo/pass";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PG = process.env.DEMO_PG_URL ?? process.env.E2E_PG_URL ?? "postgres://postgres@localhost:5432";
const DB_URL = `${PG}/availo_demo`;
const PORT = Number(process.env.DEMO_PORT ?? 3100);
const API = `http://localhost:${PORT}`;
const RUNS = Number(process.env.DEMO_RUNS ?? 10);
const RATE = 50_000n; // seed placeholder, OD-04
const WALLET = 200_000n; // ₦2,000 seeded per driver
// 08:50 in Lagos. Every run books 09:00–10:00; the gate admits from 08:45.
const T0 = new Date("2030-01-01T07:50:00Z");

const boot = Date.now();
const now = () => new Date(T0.getTime() + (Date.now() - boot));

// ——— plumbing ———

class Failure extends Error {}
function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Failure(what);
}
function eq<T>(actual: T, expected: T, what: string): void {
  const a = JSON.stringify(actual, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  const e = JSON.stringify(expected, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  if (a !== e) throw new Failure(`${what}: expected ${e}, got ${a}`);
}

async function until(fn: () => boolean, what: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Failure(`timed out waiting for ${what}`);
}

let api: { proc: ChildProcess; log: string } | null = null;
async function startApi() {
  const proc = spawn("pnpm", ["exec", "tsx", "apps/api/src/main.ts"], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: "development", DATABASE_URL: DB_URL, PORT: String(PORT), AVAILO_CLOCK_START: now().toISOString() },
  });
  api = { proc, log: "" };
  proc.stdout!.on("data", (d) => { api!.log += String(d); });
  proc.stderr!.on("data", (d) => { api!.log += String(d); });
  await until(() => api!.log.includes("listening"), "the API to start");
}
async function stopApi() {
  if (!api) return;
  const p = api.proc;
  p.kill("SIGTERM");
  await until(() => p.exitCode !== null || p.signalCode !== null, "the API to stop");
  api = null;
}

async function code(e164: string): Promise<string> {
  let c: string | undefined;
  await until(() => {
    const all = [...(api?.log ?? "").matchAll(new RegExp(`\\[dev-sms\\] to \\${e164}: Your Availo code is (\\d{6})`, "g"))];
    c = all.at(-1)?.[1];
    return !!c;
  }, `an SMS code for ${e164}`);
  return c!;
}

async function http<T>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const r = await fetch(API + p, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : {}) as T };
}
async function ok<T>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const r = await http<T>(method, p, body, headers);
  check(r.status < 300, `${method} ${p} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

const db = new pg.Pool({ connectionString: DB_URL });
const one = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]!;
const rows = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

/** The gate phone's transport, with a switch that cuts the network entirely. */
class GateLink implements GateApi {
  offline = false;
  constructor(private token: string, private readonly device: string) {}
  private h() { return { Authorization: `Bearer ${this.token}`, "X-Gate-Device": this.device }; }
  async fetchCache(): Promise<CacheDocument> {
    if (this.offline) throw new NetworkError("offline");
    const r = await http<CacheDocument & { error?: { code: string } }>("GET", "/gate/cache", undefined, this.h());
    if (r.status === 403 && r.body.error?.code === "DEVICE_REVOKED") throw new DeviceRevokedError("revoked");
    check(r.status === 200, `gate cache → ${r.status}`);
    return r.body;
  }
  async sendEvents(events: GateEvent[]) {
    if (this.offline) throw new NetworkError("offline");
    return ok<{ results: SyncResult[] }>("POST", "/gate/events", { events }, this.h());
  }
  resend(events: GateEvent[]) {
    return ok<{ results: SyncResult[] }>("POST", "/gate/events", { events }, this.h());
  }
}

// ——— setup ———

function run(cmd: string, args: string[], env: Record<string, string> = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8" });
}

async function setup() {
  const admin = new pg.Client({ connectionString: `${PG}/postgres` });
  await admin.connect();
  await admin.query("DROP DATABASE IF EXISTS availo_demo WITH (FORCE)");
  await admin.query("CREATE DATABASE availo_demo");
  await admin.end();
  run("pnpm", ["-s", "db:migrate"], { DATABASE_URL: DB_URL });
  run("pnpm", ["-s", "db:seed"], { DATABASE_URL: DB_URL });
  await startApi();

  const lotId = (await one<{ id: string }>("SELECT id FROM lot")).id;
  const env = { DATABASE_URL: DB_URL, NODE_ENV: "development", AVAILO_CLOCK_START: now().toISOString() };
  run("pnpm", ["-s", "gate:admin", "attendant", "add", lotId, "+2348119990001", "Demo Attendant"], env);
  const enrolment = /Enrolment code[^:]*: ([0-9A-Z-]+)/.exec(run("pnpm", ["-s", "gate:admin", "device", "add", lotId, "Demo gate phone"], env))![1]!;

  const device = await ok<{ deviceToken: string }>("POST", "/gate/devices/enrol", { enrolmentCode: enrolment });
  await ok("POST", "/auth/otp/request", { mobile: "+2348119990001" });
  const signIn = await ok<{ accessToken: string }>("POST", "/gate/auth/verify", { mobile: "+2348119990001", code: await code("+2348119990001") }, { "X-Gate-Device": device.deviceToken });

  globalThis.indexedDB = new IDBFactory();
  const link = new GateLink(signIn.accessToken, device.deviceToken);
  const gate = new GateClient(await GateStore.open("availo-demo-gate"), link, now);
  check(await gate.refreshCache(), "the gate phone downloads its first cache");
  return { lotId, link, gate };
}

// ——— one run of the walking skeleton ———

async function oneRun(i: number, lotId: string, link: GateLink, gate: GateClient) {
  const mobile = `+234809${String(10_000_000 + i).slice(1)}`;
  const plate = `DMO${String(100 + i).padStart(3, "0")}AA`;

  // 1. Register as staff through OTP and self-serve registration.
  await ok("POST", "/auth/otp/request", { mobile });
  const v = await ok<{ status: string; registrationToken: string }>("POST", "/auth/otp/verify", { mobile, code: await code(mobile) });
  eq(v.status, "registration_required", "a new number is asked to register");
  const reg = await ok<{ accessToken: string; user: { id: string; verificationState: string }; vehicle: { id: string } }>("POST", "/registrations", {
    registrationToken: v.registrationToken, name: `Demo Staff ${i}`, userType: "staff", campusIdentifier: `DEMO-${i}`, vehicle: { plate },
  });
  eq(reg.user.verificationState, "verified", "staff are verified automatically (US-006)");
  const auth = { Authorization: `Bearer ${reg.accessToken}` };

  // 2. Seeded wallet: an allocation, as the seed records it (top-up arrives in sprint 2).
  await db.query("INSERT INTO wallet_entry (user_id, entry_type, amount_kobo, reference, actor) VALUES ($1, 'allocation', $2, $3, 'demo-seed')",
    [reg.user.id, WALLET.toString(), `DEMO-SEED-${i}`]);

  // 3. Reserve one hour, 09:00–10:00 WAT.
  const start = "2030-01-01T09:00:00+01:00";
  const quote = await ok<{ amountKobo: string; balanceBeforeKobo: string; balanceAfterKobo: string }>("GET", `/lots/${lotId}/availability?start=${encodeURIComponent(start)}&hours=1`, undefined, auth);
  eq([quote.amountKobo, quote.balanceBeforeKobo, quote.balanceAfterKobo], [RATE.toString(), WALLET.toString(), (WALLET - RATE).toString()], "the quote before booking");
  const key = randomUUID();
  const booking = await ok<{ id: string; reference: string; amountKobo: string; rateAppliedKobo: string; walletEntryId: string; passId: string }>(
    "POST", "/reservations", { lotId, vehicleId: reg.vehicle.id, start, hours: 1 }, { ...auth, "Idempotency-Key": key });
  const retry = await ok<{ id: string }>("POST", "/reservations", { lotId, vehicleId: reg.vehicle.id, start, hours: 1 }, { ...auth, "Idempotency-Key": key });
  eq(retry.id, booking.id, "a retried booking returns the original (idempotency key)");

  // 4. The pass.
  const pass = await ok<{ passId: string; pin: string; qr: { signedPart: string; totpSecret: string } }>("GET", `/reservations/${booking.id}/pass`, undefined, auth);
  eq(pass.passId, booking.passId, "the pass issued on confirmation is the one returned");
  check(/^\d{6}$/.test(pass.pin), "a six-digit PIN");

  // 5. The gate picks up the new pass while online, then loses the network.
  check(await gate.refreshCache(), "the gate refreshes its cache");
  link.offline = true;
  gate.setConnectivity(false);
  const phone = () => qrText(pass.qr.signedPart, fromBase64Url(pass.qr.totpSecret)!, now());

  const t0 = performance.now();
  const inScan = await gate.scan(phone());
  const ms = performance.now() - t0;
  eq(inScan.status, "VALID", "the pass verifies offline (US-038)");
  check(ms < 3000, `verification within 3 s (NFR-PER-02): ${ms.toFixed(1)} ms`);
  eq((await gate.enterPin(pass.pin)).status, "VALID", "the PIN verifies offline (US-039)");
  const entry = await gate.recordEntry(inScan, true);
  eq((await gate.flush()).remaining, 1, "the entry waits in the queue while offline");

  // 6. Signal returns: the entry syncs, and the server sees one car on site.
  link.offline = false;
  gate.setConnectivity(true);
  const s1 = await gate.flush();
  eq([s1.sent, s1.remaining, s1.flagged.length], [1, 0, 0], "the entry syncs once, unflagged");
  const onSite = await one<{ n: number }>("SELECT count(*)::int AS n FROM parking_session WHERE reservation_id = $1 AND state = 'active'", [booking.id]);
  eq(onSite.n, 1, "occupancy: the session is active after entry (US-027)");

  // 7. Offline again for the exit.
  link.offline = true;
  gate.setConnectivity(false);
  const outScan = await gate.scan(phone());
  check(outScan.onSite && outScan.actions.includes("record_exit"), "the gate knows the car is on site and offers exit");
  const exit = await gate.recordExit(outScan);
  link.offline = false;
  gate.setConnectivity(true);
  const s2 = await gate.flush();
  eq([s2.sent, s2.remaining, s2.flagged.length], [1, 0, 0], "the exit syncs once, unflagged");

  // 8. A repeated sync of the same records changes nothing (NFR-OFF-03).
  const again = await link.resend([entry, exit]);
  eq(again.results.map((r) => r.outcome), ["duplicate", "duplicate"], "resending the same records is recognised");
  eq((await one<{ n: number }>("SELECT count(*)::int AS n FROM gate_event WHERE reservation_id = $1", [booking.id])).n, 2, "exactly two gate records");

  // 9. Invariants: reservation, ledger, balance and occupancy agree.
  const r = await one<{ amount: string; rate: string; pool: string; wallet_entry_id: string }>(
    "SELECT r.amount_kobo::text AS amount, r.rate_applied_kobo::text AS rate, p.kind::text AS pool, r.wallet_entry_id FROM reservation r JOIN capacity_pool p ON p.id = r.pool_id WHERE r.id = $1", [booking.id]);
  eq([r.amount, r.rate], [RATE.toString(), RATE.toString()], "one hour at the stored rate (US-013)");
  check(r.pool !== "accessible", "a general booking never draws on the accessible pool");
  const debit = await one<{ amount: string; user_id: string; entry_type: string }>("SELECT amount_kobo::text AS amount, user_id, entry_type::text FROM wallet_entry WHERE id = $1", [r.wallet_entry_id]);
  eq([debit.entry_type, debit.amount, debit.user_id], ["reservation_debit", (-RATE).toString(), reg.user.id], "the reservation points at the debit that paid for it (US-023)");
  const ledger = await one<{ b: string; debits: number }>(
    "SELECT COALESCE(sum(amount_kobo),0)::text AS b, count(*) FILTER (WHERE entry_type = 'reservation_debit')::int AS debits FROM wallet_entry WHERE user_id = $1", [reg.user.id]);
  eq([ledger.b, ledger.debits], [(WALLET - RATE).toString(), 1], "ledger: allocation minus one debit");
  const wallet = await ok<{ balanceKobo: string; entries: Array<{ balanceAfterKobo: string }> }>("GET", "/wallet", undefined, auth);
  eq(wallet.balanceKobo, ledger.b, "the balance the driver sees is the ledger sum (US-020)");
  eq(wallet.entries.map((e) => e.balanceAfterKobo), [(WALLET - RATE).toString(), WALLET.toString()], "running balances");
  const session = await one<{ state: string; entered: Date; exited: Date }>("SELECT state::text, entered_at AS entered, exited_at AS exited FROM parking_session WHERE reservation_id = $1", [booking.id]);
  eq(session.state, "ended", "occupancy: the session ends on exit");
  check(session.exited >= session.entered, "exit after entry");
  const active = await one<{ n: number }>("SELECT count(*)::int AS n FROM parking_session WHERE state = 'active'");
  eq(active.n, 0, "occupancy: no car left on site");
  await capacityHolds();
  return { reference: booking.reference, pool: r.pool, ms };
}

/** US-023, checked independently of the engine: no pool's peak occupancy exceeds its capacity. */
async function capacityHolds() {
  const breaches = await rows<{ kind: string }>(`
    WITH claims AS (SELECT pool_id, time_window FROM reservation WHERE status = 'confirmed'),
    instants AS (SELECT DISTINCT pool_id, lower(time_window) AS t FROM claims)
    SELECT cp.kind::text AS kind FROM instants i JOIN capacity_pool cp ON cp.id = i.pool_id
    GROUP BY cp.id, cp.kind, cp.capacity
    HAVING max((SELECT count(*) FROM claims c WHERE c.pool_id = i.pool_id AND c.time_window @> i.t)) > cp.capacity`);
  eq(breaches, [], "no pool exceeds its capacity (US-023)");
}

// ——— main ———

async function main() {
  console.log(`Availo sprint 1 demo — ${RUNS} runs of the walking skeleton\n`);
  const { lotId, link, gate } = await setup();
  let passed = 0;
  for (let i = 1; i <= RUNS; i++) {
    const started = Date.now();
    try {
      const r = await oneRun(i, lotId, link, gate);
      passed++;
      console.log(`  ✓ run ${String(i).padStart(2)}  ${r.reference}  ${r.pool.padEnd(6)} bay  verified offline in ${r.ms.toFixed(1)} ms  (${Date.now() - started} ms)`);
    } catch (e) {
      console.log(`  ✗ run ${String(i).padStart(2)}  ${(e as Error).message}`);
      break;
    }
  }

  if (passed === RUNS) {
    // Across all runs: every booking paid once, every car in and out once, nothing flagged.
    const totals = await one<{ reservations: number; debits: number; paid: string; charged: string; events: number; flagged: number; ended: number }>(`
      SELECT (SELECT count(*) FROM reservation)::int AS reservations,
             (SELECT count(*) FROM wallet_entry WHERE entry_type = 'reservation_debit')::int AS debits,
             (SELECT (-sum(amount_kobo))::text FROM wallet_entry WHERE entry_type = 'reservation_debit') AS paid,
             (SELECT sum(amount_kobo)::text FROM reservation) AS charged,
             (SELECT count(*) FROM gate_event)::int AS events,
             (SELECT count(*) FROM gate_event WHERE review_state = 'flagged')::int AS flagged,
             (SELECT count(*) FROM parking_session WHERE state = 'ended')::int AS ended`);
    try {
      eq([totals.reservations, totals.debits, totals.events, totals.flagged, totals.ended], [RUNS, RUNS, RUNS * 2, 0, RUNS], "totals across all runs");
      eq(totals.paid, totals.charged, "debits equal reservation charges");
      await capacityHolds();
      console.log(`\n  ${RUNS} reservations, ${RUNS} debits, ${RUNS * 2} gate records, 0 flagged, ${RUNS} sessions ended.`);
      console.log(`  Debits ${totals.paid} kobo = charges ${totals.charged} kobo. No capacity breach.`);
    } catch (e) {
      console.log(`  ✗ totals  ${(e as Error).message}`);
      passed = -1;
    }
  }

  await stopApi();
  await db.end();
  if (passed !== RUNS) {
    console.log(`\nFAILED — ${Math.max(passed, 0)} of ${RUNS} runs passed.`);
    process.exit(1);
  }
  console.log(`\nPASSED — ${RUNS} of ${RUNS} consecutive runs.`);
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  await stopApi().catch(() => undefined);
  process.exit(1);
});
