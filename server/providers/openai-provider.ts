import type { JudgeProvider, JudgeCompletionRequest, JudgeCompletionResult } from "./types.js";

export const openaiProvider: JudgeProvider = {
  name: "openai",
  async complete(req: JudgeCompletionRequest, apiKey: string): Promise<JudgeCompletionResult> {
    const start = Date.now();
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: req.model,
        messages: [
          { role: "system", content: req.systemPrompt },
          { role: "user", content: req.userPrompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: req.schemaName, schema: req.jsonSchema, strict: true },
        },
      }),
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) throw new Error(`OpenAI judge call failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    const content = json.choices[0]?.message.content;
    if (!content) throw new Error("OpenAI judge call returned no content");
    return {
      parsed: JSON.parse(content),
      raw: json,
      promptTokens: json.usage.prompt_tokens,
      completionTokens: json.usage.completion_tokens,
      latencyMs,
      costUsd: null,
    };
  },
};
