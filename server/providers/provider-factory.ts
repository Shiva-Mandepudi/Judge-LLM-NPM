import type { JudgeProvider } from "./types.js";
import { anthropicProvider } from "./anthropic-provider.js";
import { openaiProvider } from "./openai-provider.js";
import { mockProvider } from "./mock-provider.js";
import { geminiProvider } from "./gemini-provider.js";

const PROVIDERS: Record<string, JudgeProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  mock: mockProvider,
  gemini: geminiProvider,
};

export function getProvider(name: string): JudgeProvider {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown judge provider "${name}". Configure providers via admin config, not code.`);
  if (provider === mockProvider && process.env.NODE_ENV === "production") {
    throw new Error("The mock provider cannot be selected in production config.");
  }
  return provider;
}
