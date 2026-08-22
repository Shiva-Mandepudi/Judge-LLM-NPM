import "dotenv/config";
import { db, pool } from "../server/db.js";
import { getActiveConfig, publishConfigVersion } from "../server/config/config-service.js";

// Token-priced models only (per developers.openai.com/api/docs/pricing,
// synced against the org's actual Tier 5 "Models in use"/"Latest models"
// list). Per-minute/per-image/per-second models (audio, tts, whisper,
// transcribe, image, realtime, sora) are excluded — they don't fit the
// promptPer1k/completionPer1k USD-per-token shape this config uses.
const OPENAI_RATES_USD_PER_1K: Record<string, { promptPer1k: number; completionPer1k: number }> = {
  "gpt-5.6-sol": { promptPer1k: 0.005, completionPer1k: 0.03 },
  "gpt-5.6-terra": { promptPer1k: 0.002, completionPer1k: 0.012 },
  "gpt-5.6-luna": { promptPer1k: 0.0002, completionPer1k: 0.0012 },
  "gpt-5.5": { promptPer1k: 0.005, completionPer1k: 0.03 },
  "gpt-5.5-pro": { promptPer1k: 0.03, completionPer1k: 0.18 },
  "gpt-5.4": { promptPer1k: 0.0025, completionPer1k: 0.015 },
  "gpt-5.4-mini": { promptPer1k: 0.00075, completionPer1k: 0.0045 },
  "gpt-5.4-nano": { promptPer1k: 0.0002, completionPer1k: 0.00125 },
  "gpt-5.4-pro": { promptPer1k: 0.03, completionPer1k: 0.18 },
  "gpt-5.2": { promptPer1k: 0.00175, completionPer1k: 0.014 },
  "gpt-5.2-pro": { promptPer1k: 0.021, completionPer1k: 0.168 },
  "gpt-5.1": { promptPer1k: 0.00125, completionPer1k: 0.01 },
  "gpt-5": { promptPer1k: 0.00125, completionPer1k: 0.01 },
  "gpt-5-mini": { promptPer1k: 0.00025, completionPer1k: 0.002 },
  "gpt-5-nano": { promptPer1k: 0.00005, completionPer1k: 0.0004 },
  "gpt-5-pro": { promptPer1k: 0.015, completionPer1k: 0.12 },
  "gpt-5.3-codex": { promptPer1k: 0.00175, completionPer1k: 0.014 },
  "gpt-4.1": { promptPer1k: 0.002, completionPer1k: 0.008 },
  "gpt-4.1-mini": { promptPer1k: 0.0004, completionPer1k: 0.0016 },
  "gpt-4.1-nano": { promptPer1k: 0.0001, completionPer1k: 0.0004 },
  "gpt-4o": { promptPer1k: 0.0025, completionPer1k: 0.01 },
  "gpt-4o-mini": { promptPer1k: 0.00015, completionPer1k: 0.0006 },
  "gpt-4": { promptPer1k: 0.03, completionPer1k: 0.06 },
  o3: { promptPer1k: 0.002, completionPer1k: 0.008 },
  "o3-pro": { promptPer1k: 0.02, completionPer1k: 0.08 },
  "o4-mini": { promptPer1k: 0.0011, completionPer1k: 0.0044 },
  "chat-latest": { promptPer1k: 0.005, completionPer1k: 0.03 },
  "text-embedding-3-large": { promptPer1k: 0.00013, completionPer1k: 0 },
  "text-embedding-3-small": { promptPer1k: 0.00002, completionPer1k: 0 },
  "text-embedding-ada-002": { promptPer1k: 0.0001, completionPer1k: 0 },
  "omni-moderation-latest": { promptPer1k: 0, completionPer1k: 0 },
};

async function main() {
  const { value: active } = await getActiveConfig(db, "global");
  const merged = {
    ...active,
    costRatesUsdPer1kTokens: { ...active.costRatesUsdPer1kTokens, ...OPENAI_RATES_USD_PER_1K },
  };
  const result = await publishConfigVersion(db, { configKey: "global", value: merged, createdBy: "openai-pricing-sync" });
  console.log(`Published config version ${result.version} with ${Object.keys(OPENAI_RATES_USD_PER_1K).length} model rates.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
