import "dotenv/config";
import pg from "pg";

const expectedTables = [
  "eval_silver_outputs",
  "eval_rows",
  "eval_model_map",
  "eval_judgements_v2",
  "eval_run_manifests",
];

const client = new pg.Client({ connectionString: process.env.JUDGE_DATABASE_URL });
await client.connect();
try {
  const tables = await client.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = current_schema() and table_name = any($1::text[]) order by table_name",
    [expectedTables],
  );
  const found = tables.rows.map((row) => row.table_name);
  const missing = expectedTables.filter((table) => !found.includes(table));
  if (missing.length) throw new Error(`Phase 0 tables missing: ${missing.join(", ")}`);

  const keys = await client.query<{ table_name: string; constraint_type: string; columns: string }>(
    "select tc.table_name, tc.constraint_type, string_agg(kcu.column_name, ',' order by kcu.ordinal_position) as columns from information_schema.table_constraints tc join information_schema.key_column_usage kcu on kcu.constraint_schema = tc.constraint_schema and kcu.constraint_name = tc.constraint_name and kcu.table_name = tc.table_name where tc.table_schema = current_schema() and tc.constraint_type = 'PRIMARY KEY' and tc.table_name = any($1::text[]) group by tc.table_name, tc.constraint_type order by tc.table_name",
    [expectedTables],
  );
  const keySet = new Set(keys.rows.map((row) => `${row.table_name}:${row.columns}`));
  for (const key of ["eval_silver_outputs:id", "eval_rows:row_id", "eval_model_map:run_id,model_ref", "eval_judgements_v2:id", "eval_run_manifests:run_id"]) {
    if (!keySet.has(key)) throw new Error(`Phase 0 primary key missing: ${key}`);
  }

  const artifacts = await client.query<{ runs: number; rows: number; maps: number; manifests: number }>(
    "select count(distinct run_id)::int as runs, count(*)::int as rows, (select count(*)::int from eval_model_map) as maps, (select count(*)::int from eval_run_manifests) as manifests from eval_rows",
  );
  console.log(JSON.stringify({ phase0: "verified", tables: found, primaryKeys: keys.rows, artifacts: artifacts.rows[0] }, null, 2));
} finally {
  await client.end();
}
