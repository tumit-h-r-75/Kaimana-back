// Shared Claude AI gateway service for stateless AI feature requests.
//
// Every AI feature (Hint, Auditor, Polish) goes through `askClaude`. When
// ANTHROPIC_API_KEY is not configured — e.g. local development, or a
// deployment that hasn't set it yet — `askClaude` returns null instead of
// throwing, and the caller is expected to fall back to a deterministic,
// rule-based response. This mirrors the project's existing Piston "Plan B"
// pattern: every AI-flavored endpoint works with zero setup, and gets
// smarter automatically once a real API key is added.

import { config } from "../../config/env.js";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = "claude-3-5-haiku-20241022";

export interface AskClaudeOptions {
  system: string;
  prompt: string;
  maxTokens?: number;
}

export const isAiConfigured = () => Boolean(config.anthropicApiKey);

export const askClaude = async ({ system, prompt, maxTokens = 400 }: AskClaudeOptions): Promise<string | null> => {
  if (!config.anthropicApiKey) return null;

  try {
    const response = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.anthropicApiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      console.error("Anthropic API error:", response.status, await response.text().catch(() => ""));
      return null;
    }

    const payload = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = payload.content?.find((block) => block.type === "text")?.text;
    return text?.trim() || null;
  } catch (error) {
    console.error("Anthropic API request failed:", (error as Error).message);
    return null;
  }
};
