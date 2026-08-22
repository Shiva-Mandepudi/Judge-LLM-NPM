import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../shared/schema.js";

const connectionString = process.env.JUDGE_DATABASE_URL;
if (!connectionString) {
  throw new Error("JUDGE_DATABASE_URL is required (Judge service must use its own database, never Cosmic Guidance's product DB).");
}

export const pool = new Pool({ connectionString, max: 10 });
export const db = drizzle(pool, { schema });
export type Db = typeof db;
