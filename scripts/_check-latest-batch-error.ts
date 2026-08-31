import "dotenv/config";
import { pool } from "../server/db.js";
const result = await pool.query("SELECT metadata->'openaiBatch'->'errors' AS errors FROM eval_generation_runs WHERE id=$1", ["92c28246-7504-4c89-a2da-b54abce7d5a9"]);
console.log(JSON.stringify(result.rows[0], null, 2));
await pool.end();
