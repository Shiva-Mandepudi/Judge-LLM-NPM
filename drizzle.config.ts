import { defineConfig } from "drizzle-kit";

if (!process.env.JUDGE_DATABASE_URL) {
  throw new Error("JUDGE_DATABASE_URL must be set (separate DB/schema from Cosmic Guidance's product DB).");
}

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: { url: process.env.JUDGE_DATABASE_URL },
});
