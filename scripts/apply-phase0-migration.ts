import "dotenv/config";
import { readFile } from "node:fs/promises";
import pg from "pg";

if (!process.env.JUDGE_DATABASE_URL) throw new Error("JUDGE_DATABASE_URL is required");

const client = new pg.Client({ connectionString: process.env.JUDGE_DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query(await readFile(new URL("../migrations/0006_rebuild_artifacts.sql", import.meta.url), "utf8"));
  await client.query("COMMIT");
  console.log("Phase 0 migration 0006 applied");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
