import type { JudgeProvider, JudgeCompletionRequest, JudgeCompletionResult } from "./types.js";

// No SDK dependency — the Messages API forced-tool-use pattern is a single
// HTTP call, and avoiding the SDK keeps this service's dependency surface
// (and its Secret Manager blast radius) minimal.
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
        system: req.systemPrompt,
        messages: [{ role: "user", content: req.userPrompt }],
        tools: [{ name: req.schemaName, description: "Emit the judge scoring result.", input_schema: req.jsonSchema }],
        tool_choice: { type: "tool", name: req.schemaName },
      }),
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) throw new Error(`Anthropic judge call failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as {
      content: Array<{ type: string; input?: Record<string, unknown> }>;
      usage: { input_tokens: number; output_tokens: number };
    };
    const toolUse = json.content.find((c) => c.type === "tool_use");
    if (!toolUse?.input) throw new Error("Anthropic judge call returned no tool_use block");
    return {
      parsed: toolUse.input,
      raw: json,
      promptTokens: json.usage.input_tokens,
      completionTokens: json.usage.output_tokens,
      latencyMs,
      costUsd: null,
    };
  },
};
