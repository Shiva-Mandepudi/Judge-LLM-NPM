import { eq, and, desc } from "drizzle-orm";
import type { Db } from "../db.js";
import { evalConfigVersions } from "../../shared/schema.js";
import { judgeConfigSchema, type JudgeConfig } from "../../shared/config-schema.js";
import { validateJudgeIndependence } from "../../shared/judge-independence.js";
import { logAudit } from "../services/audit-service.js";

const CONFIG_CACHE_TTL_MS = 30_000;
const cache = new Map<string, { value: JudgeConfig; id: string; version: number; expiresAt: number }>();

export async function getActiveConfig(db: Db, configKey: string): Promise<{ id: string; version: number; value: JudgeConfig }> {
  const cached = cache.get(configKey);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const [row] = await db
    .select()
    .from(evalConfigVersions)
    .where(and(eq(evalConfigVersions.configKey, configKey), eq(evalConfigVersions.isActive, true)))
    .orderBy(desc(evalConfigVersions.version))
    .limit(1);

  if (!row) {
    throw new Error(`No active config found for key "${configKey}". An admin must publish one via POST /api/admin/config.`);
  }
  const value = judgeConfigSchema.parse(row.value);
  const entry = { id: row.id, version: row.version, value, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS };
  cache.set(configKey, entry);
  return entry;
}

export function invalidateConfigCache(configKey?: string) {
  if (configKey) cache.delete(configKey);
  else cache.clear();
}

export async function publishConfigVersion(
  db: Db,
  params: { configKey: string; value: JudgeConfig; createdBy: string },
): Promise<{ id: string; version: number }> {
  const parsed = judgeConfigSchema.parse(params.value);

  const independenceProblems = validateJudgeIndependence(parsed);
  if (independenceProblems.length > 0) {
    throw new Error(`Judge config rejected — violates anti-bias rules: ${independenceProblems.join(" | ")}`);
  }

  const [latest] = await db
    .select({ version: evalConfigVersions.version })
    .from(evalConfigVersions)
    .where(eq(evalConfigVersions.configKey, params.configKey))
    .orderBy(desc(evalConfigVersions.version))
    .limit(1);
  const nextVersion = (latest?.version ?? 0) + 1;

  return db.transaction(async (tx) => {
    await tx
      .update(evalConfigVersions)
      .set({ isActive: false })
      .where(and(eq(evalConfigVersions.configKey, params.configKey), eq(evalConfigVersions.isActive, true)));

    const [inserted] = await tx
      .insert(evalConfigVersions)
      .values({ configKey: params.configKey, version: nextVersion, value: parsed, isActive: true, createdBy: params.createdBy })
      .returning({ id: evalConfigVersions.id, version: evalConfigVersions.version });

    invalidateConfigCache(params.configKey);
    await logAudit(tx as unknown as Db, {
      eventName: "config.published",
      actor: params.createdBy,
      configVersionId: inserted.id,
      metadata: { configKey: params.configKey, version: nextVersion },
    });
    return inserted;
  });
}
