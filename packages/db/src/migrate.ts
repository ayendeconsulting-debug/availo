import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import pg from "pg";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/** Applies every pending migration in filename order, each in its own transaction. */
export async function migrate(client: pg.ClientBase): Promise<string[]> {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migration (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Set(
    (await client.query<{ name: string }>("SELECT name FROM schema_migration")).rows.map((r) => r.name),
  );
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migration (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      ran.push(file);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
    }
  }
  return ran;
}

// Run directly (pnpm db:…). pathToFileURL keeps this true on Windows paths too.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const ran = await migrate(client);
    console.log(ran.length ? `Applied: ${ran.join(", ")}` : "Up to date");
  } finally {
    await client.end();
  }
}
