/**
 * Runs the Paystack simulator for local development.
 *
 *   pnpm paystack:sim
 *
 * PAYSTACK_SECRET_KEY must match the API's; PAYSTACK_SIM_WEBHOOK_URL is where it
 * delivers webhooks (default: the local API).
 */
import { startPaystackSimulator } from "./index.js";

const sim = await startPaystackSimulator({
  secretKey: process.env.PAYSTACK_SECRET_KEY ?? "sk_test_availo_simulator",
  webhookUrl: process.env.PAYSTACK_SIM_WEBHOOK_URL ?? "http://localhost:3000/webhooks/paystack",
  port: Number(process.env.PAYSTACK_SIM_PORT ?? 4010),
  log: true,
});
console.log(`Paystack simulator on ${sim.url} — test payments only, no money moves.`);
