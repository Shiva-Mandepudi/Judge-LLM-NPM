import type { JudgeProvider, JudgeCompletionRequest, JudgeCompletionResult } from "./types.js";

// Keep the provider on the native structured-output path. This avoids a
// second parser contract and lets Anthropic enforce the same schema used by
// the OpenAI and Gemini judge adapters.
export const anthropicProvider: JudgeProvider = {
  name: "anthropic",
  async complete(req: JudgeCompletionRequest, apiKey: string): Promise<JudgeCompletionResult> {
    const start = Date.now();
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: 4096,
        system: [{ type: "text", text: req.systemPrompt, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: req.userPrompt }],
        thinking: { type: "adaptive" },
        output_config: { format: { type: "json_schema", schema: req.jsonSchema } },
      }),
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) throw new Error(`Anthropic judge call failed: ${res.status} ${await res.text()}`);
    const providerRequestId = res.headers.get("request-id") ?? undefined;
    const json = (await res.json()) as {
      content: Array<{ type: string; text?: string }>;
      usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    };
    const text = json.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
    if (!text) throw new Error("Anthropic judge call returned no JSON content");
    return {
      parsed: JSON.parse(text),
      raw: json,
      promptTokens: json.usage.input_tokens,
      completionTokens: json.usage.output_tokens,
      cacheReadInputTokens: json.usage.cache_read_input_tokens ?? 0,
      cacheWriteInputTokens: json.usage.cache_creation_input_tokens ?? 0,
      totalTokens: json.usage.input_tokens + json.usage.output_tokens,
      providerRequestId,
      latencyMs,
      costUsd: null,
    };
  },
};
