// npm scripts run via cmd.exe on Windows, which doesn't glob-expand `*.test.ts` —
// tsx then receives the literal glob string and fails to find it (docs/REBUILD-PLAN.md
// §1.2 "test scripts currently fail before test discovery"). Expand the globs in Node
// itself instead of depending on the invoking shell.
import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const dirs = process.argv.slice(2);
const files = dirs.flatMap((dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".test.ts"))
    .map((e) => path.join(e.parentPath ?? e.path, e.name))
);

if (files.length === 0) {
  console.error(`No *.test.ts files found under: ${dirs.join(", ")}`);
  process.exit(1);
}

// Integration suites share one dev database, so test files must run one at a
// time: concurrent files each inserting pricing snapshots race on assertions
// about the global "latest valid snapshot" (observed flake: pricing-snapshots
// vs cost-analysis). Serialize with --test-concurrency=1.
const result = spawnSync(process.execPath, ["--import", "dotenv/config", "--import", "tsx", "--test", "--test-concurrency=1", ...files], {
  stdio: "inherit",
  shell: false,
});
process.exit(result.status ?? 1);
