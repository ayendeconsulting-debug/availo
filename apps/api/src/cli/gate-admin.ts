/**
 * Gate administration until the operations console exists (sprint 6).
 *
 *   pnpm gate:admin attendant add <lotId> <mobile> "<name>"
 *   pnpm gate:admin device add <lotId> "<label>"        → prints a one-time enrolment code
 *   pnpm gate:admin device revoke <deviceId> "<reason>"
 */
import pg from "pg";
import { loadConfig } from "../config.js";
import { systemClock } from "../common/clock.js";
import { GateAuthService } from "../gate/gate-auth.service.js";

const [area, action, ...args] = process.argv.slice(2);
const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const boot = Date.now();
const clock = config.clockStart ? { now: () => new Date(config.clockStart!.getTime() + (Date.now() - boot)) } : systemClock;
const gate = new GateAuthService(config, pool, clock);
const actor = `cli:${process.env.USER ?? process.env.USERNAME ?? "unknown"}`;

try {
  if (area === "attendant" && action === "add" && args.length === 3) {
    const id = await gate.createAttendant({ lotId: args[0]!, mobile: args[1]!, name: args[2]!, createdBy: actor });
    console.log(`Attendant ${id} created.`);
  } else if (area === "device" && action === "add" && args.length === 2) {
    const d = await gate.createDevice({ lotId: args[0]!, label: args[1]!, createdBy: actor });
    console.log(`Device ${d.deviceId}\nEnrolment code (one use, 24 hours): ${d.enrolmentCode}`);
  } else if (area === "device" && action === "revoke" && args.length === 2) {
    await gate.revokeDevice(args[0]!, args[1]!);
    console.log("Revoked. The device purges its cache on next contact.");
  } else {
    console.error('Usage:\n  gate:admin attendant add <lotId> <mobile> "<name>"\n  gate:admin device add <lotId> "<label>"\n  gate:admin device revoke <deviceId> "<reason>"');
    process.exitCode = 2;
  }
} finally {
  await pool.end();
}
