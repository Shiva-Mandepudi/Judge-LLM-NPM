import { resolveSecret } from "../lib/secrets.js";

type Provider = "openai" | "anthropic" | "gemini" | "mock" | "unset";

export async function listProviderModels(provider: Provider, secretRef: string): Promise<string[]> {
  if (provider === "mock") return ["mock-judge"];
  if (provider === "unset") return ["unset"];
  const apiKey = await resolveSecret(secretRef);

  if (provider === "openai") {
    const response = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${apiKey}` } });
    if (!response.ok) throw new Error(`OpenAI model catalog failed: ${response.status}`);
    const body = await response.json() as { data?: Array<{ id?: string }> };
    return (body.data ?? []).map((model) => model.id).filter((id): id is string => Boolean(id)).sort();
  }

  if (provider === "anthropic") {
    const models: string[] = [];
    let afterId = "";
    let hasMore = true;
    while (hasMore) {
      const query = new URLSearchParams({ limit: "1000", ...(afterId ? { after_id: afterId } : {}) });
      const response = await fetch(`https://api.anthropic.com/v1/models?${query}`, { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } });
      if (!response.ok) throw new Error(`Anthropic model catalog failed: ${response.status}`);
      const body = await response.json() as { data?: Array<{ id?: string }>; has_more?: boolean; last_id?: string | null };
      models.push(...(body.data ?? []).map((model) => model.id).filter((id): id is string => Boolean(id)));
      hasMore = Boolean(body.has_more && body.last_id);
      afterId = body.last_id ?? "";
    }
    return [...new Set(models)].sort();
  }

  const models: string[] = [];
  let pageToken = "";
  do {
    const query = new URLSearchParams({ pageSize: "1000", ...(pageToken ? { pageToken } : {}) });
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?${query}`, { headers: { "x-goog-api-key": apiKey } });
    if (!response.ok) throw new Error(`Gemini model catalog failed: ${response.status}`);
    const body = await response.json() as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>; nextPageToken?: string };
    for (const model of body.models ?? []) {
      if (model.name && model.supportedGenerationMethods?.includes("generateContent")) models.push(model.name.replace(/^models\//, ""));
    }
    pageToken = body.nextPageToken ?? "";
  } while (pageToken);
  return [...new Set(models)].sort();
}
