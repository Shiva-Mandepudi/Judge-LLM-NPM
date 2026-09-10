import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

// Generic migration runner for environments without psql. Applies ONE migration
// file inside a transaction so a failure leaves the schema untouched. Prints
// only the file name and progress — never the connection string.
// Usage: npm run db:apply -- migrations/0011_pricing_snapshots.sql

const fileArg = process.argv[2];
if (!fileArg) {
  console.error("Usage: npm run db:apply -- migrations/<file>.sql");
  process.exit(1);
}
if (!process.env.JUDGE_DATABASE_URL) throw new Error("JUDGE_DATABASE_URL is required");

const filePath = path.resolve(process.cwd(), fileArg);
const fileName = path.basename(filePath);
if (!fileName.endsWith(".sql")) {
  console.error(`Refusing to apply non-SQL file: ${fileName}`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.JUDGE_DATABASE_URL });
await client.connect();
try {
  console.log(`Applying migration ${fileName} ...`);
  await client.query("BEGIN");
  await client.query(await readFile(filePath, "utf8"));
  await client.query("COMMIT");
  console.log(`Migration ${fileName} applied`);
} catch (error) {
  await client.query("ROLLBACK");
  console.error(`Migration ${fileName} failed and was rolled back`);
  throw error;
} finally {
  await client.end();
}
