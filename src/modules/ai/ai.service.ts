// Shared AI gateway service for stateless AI feature requests.
//
// Every AI feature (Hint, Interview, Auditor, Refactor Coach, Test Case
// Generator) goes through `askAi`. When GEMINI_API_KEY is not configured —
// e.g. local development, or a deployment that hasn't set it yet —
// `askAi` returns null instead of throwing, and the caller is expected to
// fall back to a deterministic, rule-based response. This mirrors the
// project's existing Judge0 "Plan B" pattern: every AI-flavored endpoint
// works with zero setup, and gets smarter automatically once a real key
// is added.
//
// Provider: Google Gemini via Google AI Studio (generativelanguage.
// googleapis.com), not Anthropic Claude. This used to call the Claude
// Messages API, but Claude has no free tier — Gemini does, so this is
// the provider every AI feature in this project now runs on.
//
// Getting a key: https://aistudio.google.com/apikey — sign in with a
// Google account, "Create API key", copy it, and set it as GEMINI_API_KEY
// (locally in .env.local, and on the backend's Vercel project under
// Settings → Environment Variables). No billing/credit card needed for
// the free tier.

import { config } from "../../config/env.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// "gemini-2.5-flash": Google's fast, low-cost model, available on the
// Google AI Studio free tier. Gemini model names change fairly often —
// if this ever starts failing with a 404 "model not found", check the
// current names at https://ai.google.dev/gemini-api/docs/models (or the
// model picker in https://aistudio.google.com) and set GEMINI_MODEL in
// the environment to override this default without a code change.
const DEFAULT_MODEL = "gemini-2.5-flash";
const MODEL = config.geminiModel || DEFAULT_MODEL;

export interface AskAiOptions {
  system: string;
  prompt: string;
  maxTokens?: number;
}

export const isAiConfigured = () => Boolean(config.geminiApiKey);

export const askAi = async ({ system, prompt, maxTokens = 400 }: AskAiOptions): Promise<string | null> => {
  if (!config.geminiApiKey) return null;

  const url = `${GEMINI_API_BASE}/${MODEL}:generateContent?key=${config.geminiApiKey}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    });

    if (!response.ok) {
      console.error("Gemini API error:", response.status, await response.text().catch(() => ""));
      return null;
    }

    const payload = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
    };

    const text = payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("")
      .trim();

    return text || null;
  } catch (error) {
    console.error("Gemini API request failed:", (error as Error).message);
    return null;
  }
};

export const aiService = { askAi, isAiConfigured };
