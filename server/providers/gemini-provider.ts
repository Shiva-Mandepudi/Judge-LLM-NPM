import type { JudgeProvider, JudgeCompletionRequest, JudgeCompletionResult } from "./types.js";

export const geminiProvider: JudgeProvider = {
  name: "gemini",
  async complete(req: JudgeCompletionRequest, apiKey: string): Promise<JudgeCompletionResult> {
    const start = Date.now();
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: req.userPrompt }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: req.jsonSchema },
      }),
    });
    const latencyMs = Date.now() - start;
    if (!response.ok) throw new Error(`Gemini judge call failed: ${response.status} ${await response.text()}`);
    const json = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number; cachedContentTokenCount?: number; thoughtsTokenCount?: number } };
    const content = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("");
    if (!content) throw new Error("Gemini judge call returned no JSON content");
    return { parsed: JSON.parse(content), raw: json, promptTokens: json.usageMetadata?.promptTokenCount ?? 0, completionTokens: json.usageMetadata?.candidatesTokenCount ?? 0, totalTokens: json.usageMetadata?.totalTokenCount ?? 0, cacheReadInputTokens: json.usageMetadata?.cachedContentTokenCount ?? 0, reasoningTokens: json.usageMetadata?.thoughtsTokenCount ?? 0, latencyMs, costUsd: null };
  },
};
