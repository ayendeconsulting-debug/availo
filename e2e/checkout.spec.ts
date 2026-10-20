/**
 * Sprint 2 in a real browser: both payment paths end to end. Real builds of the
 * driver app, the real API, real Postgres, and the Paystack simulator serving its
 * hosted checkout page and posting signed webhooks to the API.
 *
 * 1. A guest reserves, sees the hold count down, pays on the provider's page,
 *    comes back, and lands on a pass — confirmed by server-side verification,
 *    once (US-134, US-135, §4.13 steps 3–5).
 * 2. A member of staff is short for a booking, tops up the shortfall from the
 *    booking screen, comes back with the booking still chosen, and books it from
 *    the wallet — allocated credit first (US-016, US-021, OD-12).
 */
import { test, expect, chromium, type Page } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { startPaystackSimulator, type PaystackSimulator } from "../packages/paystack-sim/src/index.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const PG = process.env.E2E_PG_URL ?? "postgres://postgres@localhost:5432";
const DB_URL = `${PG}/availo_e2e_pay`;
const EXEC = process.env.PW_CHROMIUM_PATH;
const SHOTS = process.env.E2E_SCREENSHOTS;
const SECRET = "sk_test_e2e_checkout";
// 08:50 in Lagos.
const T0 = new Date("2030-01-01T07:50:00Z");
const GUEST = { mobile: "8030000010", e164: "+2348030000010" };
const STAFF = { mobile: "8030000003", e164: "+2348030000003" }; // seeded with ₦1,000 of allocated credit

let firstBoot = 0;
const fakeNow = () => new Date(T0.getTime() + (Date.now() - firstBoot));
let api: { proc: ChildProcess; log: string[] } | null = null;
let preview: ChildProcess | null = null;
let sim: PaystackSimulator;

function run(cmd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8" });
}
async function waitFor(check: () => boolean | Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
async function lastCode(e164: string): Promise<string> {
  let code: string | undefined;
  await waitFor(() => {
    code = [...(api?.log.join("") ?? "").matchAll(new RegExp(`\\[dev-sms\\] to \\${e164}: Your Availo code is (\\d{6})`, "g"))].at(-1)?.[1];
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
async function signIn(page: Page, who: { mobile: string; e164: string }) {
  await page.goto("http://localhost:4173/");
  await page.getByLabel("Mobile number").fill(who.mobile);
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel("Code").fill(await lastCode(who.e164));
  await page.getByRole("button", { name: "Continue" }).click();
}

test.beforeAll(async () => {
  const admin = new pg.Client({ connectionString: `${PG}/postgres` });
  await admin.connect();
  await admin.query("DROP DATABASE IF EXISTS availo_e2e_pay WITH (FORCE)");
  await admin.query("CREATE DATABASE availo_e2e_pay");
  await admin.end();
  run("pnpm", ["-s", "db:migrate"], { DATABASE_URL: DB_URL });
  run("pnpm", ["-s", "db:seed"], { DATABASE_URL: DB_URL });
  run("pnpm", ["-s", "--filter", "@availo/web", "build"]);

  sim = await startPaystackSimulator({ secretKey: SECRET, webhookUrl: "http://127.0.0.1:3000/webhooks/paystack" });
  firstBoot = Date.now();
  const log: string[] = [];
  const proc = spawn("pnpm", ["exec", "tsx", "apps/api/src/main.ts"], {
    cwd: ROOT,
    env: {
      ...process.env, NODE_ENV: "development", DATABASE_URL: DB_URL, PORT: "3000", AVAILO_CLOCK_START: fakeNow().toISOString(),
      PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_BASE_URL: sim.url, APP_BASE_URL: "http://localhost:4173",
    },
  });
  proc.stdout!.on("data", (d) => log.push(String(d)));
  proc.stderr!.on("data", (d) => log.push(String(d)));
  api = { proc, log };
  await waitFor(() => log.join("").includes("listening"), "the API to start");
  preview = spawn("pnpm", ["exec", "vite", "preview", "--port", "4173", "--strictPort"], { cwd: path.join(ROOT, "apps", "web") });
  let out = "";
  preview.stdout!.on("data", (d) => (out += String(d)));
  await waitFor(() => out.includes("4173"), "the driver app");
});

test.afterAll(async () => {
  for (const p of [api?.proc, preview]) {
    if (!p) continue;
    p.kill("SIGTERM");
    await waitFor(() => p.exitCode !== null || p.signalCode !== null, "a process to stop");
  }
  await sim?.close();
});

test("a guest reserves, pays at checkout behind a hold, and gets a pass", async () => {
  const browser = await chromium.launch(EXEC ? { executablePath: EXEC } : {});
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.clock.install({ time: fakeNow() });
  const d = await ctx.newPage();
  await signIn(d, GUEST);
  await expect(d.getByText("Good morning, Chidi")).toBeVisible();
  await expect(d.getByRole("link", { name: "Payments" })).toBeVisible(); // no wallet tab for a checkout driver
  await d.getByRole("link", { name: "Reserve parking" }).click();
  await expect(d.getByRole("button", { name: "Continue to pay · ₦1,500" })).toBeEnabled();
  await shot(d, "pay-1-guest-reserve");
  await d.getByRole("button", { name: "Continue to pay · ₦1,500" }).click();

  // The hold: a countdown, the total, and the way to pay.
  await expect(d.getByText("We're holding your space")).toBeVisible();
  await expect(d.getByRole("timer")).toHaveText(/^(10:00|09:5\d)$/);
  await expect(d.getByText("₦1,500").first()).toBeVisible();
  await shot(d, "pay-2-hold");
  const holds = await query<{ n: string }>("SELECT count(*)::text AS n FROM inventory_hold WHERE released_at IS NULL");
  expect(holds[0]!.n).toBe("1");

  // The provider's hosted page — the simulator's stand-in — then back to the app.
  await d.getByRole("link", { name: "Pay ₦1,500" }).click();
  await expect(d.getByText("TEST PAYMENT SIMULATOR")).toBeVisible();
  await shot(d, "pay-3-provider-page");
  await d.getByRole("button", { name: "Pay ₦1,500.00" }).click();
  await expect(d.getByRole("heading", { name: "Your pass" })).toBeVisible({ timeout: 20_000 });
  await expect(d.locator(".av-qr-frame svg")).toBeVisible();
  await shot(d, "pay-4-pass");

  // Exactly once, however many ways the outcome arrived (webhook and the return).
  const [r] = await query<{ n: string; l: string; w: string }>(`SELECT
    (SELECT count(*) FROM reservation)::text AS n,
    (SELECT count(*) FROM payment_ledger_entry WHERE entry_type = 'checkout_payment')::text AS l,
    (SELECT count(*) FROM payment_transaction WHERE status = 'succeeded' AND verified_at IS NOT NULL)::text AS w`);
  expect(r).toEqual({ n: "1", l: "1", w: "1" });

  // History, with a receipt.
  await d.getByRole("link", { name: "Close pass" }).click();
  await d.getByRole("link", { name: "Payments" }).click();
  await expect(d.getByText("Parking · ")).toBeVisible();
  await expect(d.getByRole("button", { name: "Receipt (PDF)" })).toBeVisible();
  await shot(d, "pay-5-history");
  const dl = d.waitForEvent("download");
  await d.getByRole("button", { name: "Receipt (PDF)" }).click();
  expect((await dl).suggestedFilename()).toMatch(/^availo-receipt-AV-.*\.pdf$/);
  await browser.close();
});

test("staff short of balance top up from the booking screen and come straight back to book", async () => {
  const browser = await chromium.launch(EXEC ? { executablePath: EXEC } : {});
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.clock.install({ time: fakeNow() });
  const d = await ctx.newPage();
  await signIn(d, STAFF);
  await d.getByRole("link", { name: "Reserve parking" }).click();
  await d.getByLabel("Arrive from").selectOption("13");
  await expect(d.getByText("Your balance is ₦500 short")).toBeVisible();
  await shot(d, "topup-1-short");
  await d.getByRole("link", { name: "Top up ₦500" }).last().click();

  await expect(d.getByRole("heading", { name: "Top up wallet" })).toBeVisible();
  await expect(d.getByLabel("Another amount")).toHaveValue("500");
  await shot(d, "topup-2-amount");
  await d.getByRole("button", { name: "Pay ₦500" }).click();
  await expect(d.getByText("TEST PAYMENT SIMULATOR")).toBeVisible();
  await d.getByLabel("Pay with").selectOption("bank_transfer");
  await d.getByRole("button", { name: "Pay ₦500.00" }).click();
  await expect(d.getByText("₦500 added. Your balance is ₦1,500.")).toBeVisible({ timeout: 20_000 });
  await shot(d, "topup-3-credited");
  await d.getByRole("button", { name: "Back to your booking" }).click();

  // The same booking is still chosen.
  await expect(d.getByLabel("Arrive from")).toHaveValue("13");
  await expect(d.getByText("₦1,500 → ₦0")).toBeVisible();
  await d.getByRole("button", { name: "Reserve · ₦1,500" }).click();
  await expect(d.getByRole("heading", { name: "Your pass" })).toBeVisible();

  // OD-12: the ₦1,000 grant went first, then ₦500 of the driver's own money.
  const [w] = await query<{ amount: string; allocated: string }>(
    "SELECT amount_kobo::text AS amount, allocated_kobo::text AS allocated FROM wallet_entry WHERE entry_type = 'reservation_debit'");
  expect(w).toEqual({ amount: "-150000", allocated: "-100000" });
  await browser.close();
});
