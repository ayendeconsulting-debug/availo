/**
 * Sprint 1 "done when": the offline path works with the network genuinely
 * disabled, not mocked (handover §7). Real builds of both PWAs, real API, real
 * Postgres, real Chromium.
 *
 * A driver books in the driver app and opens their pass. The gate phone sets up
 * and downloads the day's passes. Then the gate browser is taken offline, the
 * API process is stopped and the gate app's own web server is stopped too, and
 * the gate app is reloaded — so it can only run from its service worker and
 * local storage. Its camera is fed a picture of the driver's actual pass
 * screen. It admits and releases the car. The API is restarted, the browser
 * reconnects, and the records arrive exactly once.
 */
import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";

const ROOT = path.resolve(import.meta.dirname, "..");
const PG = process.env.E2E_PG_URL ?? "postgres://postgres@localhost:5432";
const DB_URL = `${PG}/availo_e2e`;
const EXEC = process.env.PW_CHROMIUM_PATH; // e.g. /opt/pw-browsers/chromium; unset uses Playwright's own
const SHOTS = process.env.E2E_SCREENSHOTS; // optional folder for screen captures
// 08:50 in Lagos: the driver books 09:00–12:00, and the gate admits from 08:45.
const T0 = new Date("2030-01-01T07:50:00Z");
const DRIVER = { mobile: "8030000001", e164: "+2348030000001", plate: "LND 123 AB" };
const ATTENDANT = { mobile: "8110000009", e164: "+2348110000009" };

let firstBoot = 0;
const fakeNow = () => new Date(T0.getTime() + (Date.now() - firstBoot));
let api: { proc: ChildProcess; log: string[] } | null = null;
const previews: Record<string, ChildProcess> = {};

function run(cmd: string, args: string[], env: Record<string, string> = {}, cwd = ROOT): string {
  return execFileSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
}

async function waitFor(check: () => boolean | Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function startApi(): Promise<void> {
  const log: string[] = [];
  const proc = spawn("pnpm", ["exec", "tsx", "apps/api/src/main.ts"], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: "development", DATABASE_URL: DB_URL, PORT: "3000", AVAILO_CLOCK_START: fakeNow().toISOString() },
  });
  proc.stdout!.on("data", (d) => log.push(String(d)));
  proc.stderr!.on("data", (d) => log.push(String(d)));
  api = { proc, log };
  await waitFor(() => log.join("").includes("listening"), "the API to start");
}

async function stopApi(): Promise<void> {
  if (!api) return;
  const p = api.proc;
  p.kill("SIGTERM");
  await waitFor(() => p.exitCode !== null || p.signalCode !== null, "the API to stop");
  api = null;
}

function startPreview(app: "web" | "gate", port: number): Promise<void> {
  const proc = spawn("pnpm", ["exec", "vite", "preview", "--port", String(port), "--strictPort"], { cwd: path.join(ROOT, "apps", app) });
  previews[app] = proc;
  let out = "";
  proc.stdout!.on("data", (d) => (out += String(d)));
  return waitFor(() => out.includes(String(port)), `${app} preview`);
}

async function stopPreview(app: "web" | "gate"): Promise<void> {
  const p = previews[app];
  if (!p) return;
  p.kill("SIGTERM");
  await waitFor(() => p.exitCode !== null || p.signalCode !== null, `${app} preview to stop`);
  delete previews[app];
}

async function lastCode(e164: string): Promise<string> {
  let code: string | undefined;
  await waitFor(() => {
    const all = [...(api?.log.join("") ?? "").matchAll(new RegExp(`\\[dev-sms\\] to \\${e164}: Your Availo code is (\\d{6})`, "g"))];
    code = all.at(-1)?.[1];
    return !!code;
  }, `a code for ${e164}`, 10_000);
  return code!;
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function query<T extends pg.QueryResultRow>(sql: string): Promise<T[]> {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try { return (await c.query<T>(sql)).rows; } finally { await c.end(); }
}

test.beforeAll(async () => {
  const admin = new pg.Client({ connectionString: `${PG}/postgres` });
  await admin.connect();
  await admin.query("DROP DATABASE IF EXISTS availo_e2e WITH (FORCE)");
  await admin.query("CREATE DATABASE availo_e2e");
  await admin.end();
  run("pnpm", ["-s", "db:migrate"], { DATABASE_URL: DB_URL });
  run("pnpm", ["-s", "db:seed"], { DATABASE_URL: DB_URL });
  run("pnpm", ["-s", "--filter", "@availo/web", "build"]);
  run("pnpm", ["-s", "--filter", "@availo/gate", "build"]);
  firstBoot = Date.now();
  await startApi();
  await startPreview("web", 4173);
  await startPreview("gate", 4174);
});

test.afterAll(async () => {
  await stopApi();
  await stopPreview("web");
  await stopPreview("gate");
});

test("a car is admitted and released at a gate with no network, and the records sync once", async () => {
  // ——— Driver: sign in, reserve 09:00–12:00, open the pass ———
  const driverBrowser = await chromium.launch(EXEC ? { executablePath: EXEC } : {});
  const driverCtx = await driverBrowser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await driverCtx.clock.install({ time: fakeNow() });
  const d = await driverCtx.newPage();
  await d.goto("http://localhost:4173/");
  await shot(d, "driver-1-sign-up");
  await d.getByLabel("Mobile number").fill(DRIVER.mobile);
  await d.getByRole("button", { name: "Send code" }).click();
  await d.getByLabel("Code").fill(await lastCode(DRIVER.e164));
  await d.getByRole("button", { name: "Continue" }).click();
  await expect(d.getByText("Good morning, Adaeze")).toBeVisible();
  await expect(d.getByText("₦5,000")).toBeVisible();
  await expect(d.getByText("12 of 12 free")).toBeVisible();
  await shot(d, "driver-2-home");
  await d.getByRole("link", { name: "Reserve parking" }).click();
  await expect(d.getByRole("button", { name: "Reserve · ₦1,500" })).toBeEnabled();
  await expect(d.getByText("₦5,000 → ₦3,500")).toBeVisible();
  await shot(d, "driver-3-reserve");
  await d.getByRole("button", { name: "Reserve · ₦1,500" }).click();
  await expect(d.getByRole("heading", { name: "Your pass" })).toBeVisible();
  await expect(d.locator(".av-qr-frame svg")).toBeVisible();
  await expect(d.getByText("09:00–12:00")).toBeVisible();
  await shot(d, "driver-4-pass");

  // The gate's camera will see the driver's actual pass screen.
  const work = mkdtempSync(path.join(tmpdir(), "availo-e2e-"));
  const png = path.join(work, "pass.png");
  const y4m = path.join(work, "pass.y4m");
  await d.locator(".av-qr-frame > div").screenshot({ path: png });
  run("ffmpeg", ["-loglevel", "error", "-y", "-loop", "1", "-i", png, "-vf",
    "scale=w=440:h=440:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2:color=white,format=yuv420p", "-t", "2", "-r", "10", y4m]);

  // The driver's pass also renders with no signal (NFR-OFF-06).
  await driverCtx.setOffline(true);
  await d.reload();
  await expect(d.getByRole("heading", { name: "Your pass" })).toBeVisible();
  await expect(d.locator(".av-qr-frame svg")).toBeVisible();
  await driverBrowser.close();

  // ——— Gate phone: enrol, sign in, download passes (online) ———
  const lotId = (await query<{ id: string }>("SELECT id FROM lot"))[0]!.id;
  const env = { DATABASE_URL: DB_URL, NODE_ENV: "development", AVAILO_CLOCK_START: fakeNow().toISOString() };
  run("pnpm", ["-s", "gate:admin", "attendant", "add", lotId, ATTENDANT.e164, "Bola Gate"], env);
  const enrolment = /Enrolment code[^:]*: ([0-9A-Z-]+)/.exec(run("pnpm", ["-s", "gate:admin", "device", "add", lotId, "Gate phone 1"], env))![1]!;

  const gateDir = mkdtempSync(path.join(tmpdir(), "availo-gate-"));
  const gateCtx: BrowserContext = await chromium.launchPersistentContext(gateDir, {
    ...(EXEC ? { executablePath: EXEC } : {}),
    viewport: { width: 390, height: 844 },
    permissions: ["camera"],
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${y4m}`],
  });
  await gateCtx.clock.install({ time: fakeNow() });
  const g = gateCtx.pages()[0] ?? (await gateCtx.newPage());
  await g.goto("http://localhost:4174/");
  await g.getByLabel("Enrolment code").fill(enrolment);
  await g.getByRole("button", { name: "Enrol phone" }).click();
  await g.getByLabel("Your mobile number").fill(ATTENDANT.mobile);
  await g.getByRole("button", { name: "Send code" }).click();
  await g.getByLabel("Code").fill(await lastCode(ATTENDANT.e164));
  await g.getByRole("button", { name: "Sign in" }).click();
  await expect(g.getByText(/^Online/)).toBeVisible();
  await expect(g.locator(".av-stat").filter({ hasText: "Expected today" }).locator("b")).toHaveText("1");
  // Make sure the service worker controls the page before the network goes.
  await waitFor(async () => {
    if (await g.evaluate(() => !!navigator.serviceWorker?.controller)) return true;
    await g.reload();
    return false;
  }, "service worker control", 20_000);
  await shot(g, "gate-1-home-online");

  // ——— Cut everything: browser offline, API stopped, gate web server stopped ———
  await gateCtx.setOffline(true);
  await stopApi();
  await stopPreview("gate");
  await g.reload();
  await expect(g.getByText(/^Offline/)).toBeVisible();
  expect(await g.evaluate(() => fetch("http://localhost:3000/pass-keys").then(() => "reached", () => "unreachable"))).toBe("unreachable");

  const started = Date.now();
  await g.getByRole("button", { name: "Scan pass" }).click();
  await expect(g.getByText("VALID", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(g.getByText(/Verified offline in/)).toBeVisible();
  await expect(g.locator(".av-plate")).toHaveText(DRIVER.plate);
  await shot(g, "gate-2-valid-offline");
  expect(Date.now() - started).toBeLessThan(15_000);
  await g.getByRole("button", { name: "Record entry" }).click();
  await expect(g.getByText("1 record waiting to send")).toBeVisible();
  await expect(g.locator(".av-stat").filter({ hasText: "On site" }).locator("b")).toHaveText("1");

  await g.getByRole("button", { name: "Scan pass" }).click();
  await expect(g.getByText("ON SITE", { exact: true })).toBeVisible({ timeout: 15_000 });
  await g.getByRole("button", { name: "Record exit" }).click();
  await expect(g.getByText("2 records waiting to send")).toBeVisible();
  await shot(g, "gate-3-home-offline-queued");
  expect(await query("SELECT 1 FROM gate_event")).toHaveLength(0);

  // ——— Back online: restart the API, reconnect, sync once ———
  await startApi();
  await startPreview("gate", 4174);
  await gateCtx.setOffline(false);
  await expect(g.getByText(/^Online/)).toBeVisible({ timeout: 45_000 });
  await expect(g.getByText(/records? waiting to send/)).toHaveCount(0, { timeout: 45_000 });

  const events = await query<{ kind: string; method: string; recorded_offline: boolean; conflict: string | null }>(
    "SELECT kind::text, method::text, recorded_offline, conflict FROM gate_event ORDER BY occurred_at");
  expect(events).toEqual([
    { kind: "entry", method: "qr", recorded_offline: true, conflict: null },
    { kind: "exit", method: "qr", recorded_offline: true, conflict: null },
  ]);
  expect(await query<{ state: string }>("SELECT state::text FROM parking_session")).toEqual([{ state: "ended" }]);

  // A second sync, after a reload, changes nothing.
  await g.reload();
  await expect(g.getByText(/^Online/)).toBeVisible({ timeout: 45_000 });
  expect(await query("SELECT 1 FROM gate_event")).toHaveLength(2);
  await shot(g, "gate-4-home-synced");
  await gateCtx.close();
  writeFileSync(path.join(work, "done"), "ok");
});
