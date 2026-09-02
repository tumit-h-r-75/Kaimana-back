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

// "gemini-flash-latest": an alias Google keeps pointed at its current
// recommended fast/low-cost model, instead of a version pinned by name
// like "gemini-2.5-flash" — Gemini model names get retired often enough
// (see https://ai.google.dev/gemini-api/docs/changelog) that a pinned
// name tends to silently start 404ing a few months later. Override with
// GEMINI_MODEL in the environment if this ever needs to be pinned again.
const DEFAULT_MODEL = "gemini-flash-latest";
const MODEL = config.geminiModel || DEFAULT_MODEL;

export interface AskAiOptions {
  system: string;
  prompt: string;
  maxTokens?: number;
}

export const isAiConfigured = () => Boolean(config.geminiApiKey);

// Diagnostic only — never includes the key itself. Lets a caller tell
// "not configured" apart from "configured but this exact call failed"
// (and why) without needing access to server logs. Module-scoped state
// reflecting only the most recent askAi() call is good enough for that;
// it's read right after the specific call it describes, never across
// unrelated requests.
let lastErrorDetail: string | null = null;
export const getLastAiErrorDetail = () => lastErrorDetail;

export const askAi = async ({ system, prompt, maxTokens = 400 }: AskAiOptions): Promise<string | null> => {
  if (!config.geminiApiKey) {
    lastErrorDetail = null;
    return null;
  }

  const url = `${GEMINI_API_BASE}/${MODEL}:generateContent`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Google is moving from "AIzaSy…"-format keys passed as a ?key=
        // query parameter to newer "AQ."-format keys sent via this
        // header instead — AI Studio now issues AQ-format keys by
        // default, and those are documented to fail the old query-param
        // style with 401 ACCESS_TOKEN_TYPE_UNSUPPORTED. The header works
        // for both key formats, so this is a strict upgrade either way.
        "x-goog-api-key": config.geminiApiKey,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      console.error("Gemini API error:", response.status, bodyText);
      lastErrorDetail = `HTTP ${response.status} (model: ${MODEL}) — ${bodyText.slice(0, 300)}`;
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

    if (!text) {
      lastErrorDetail = `Gemini returned no text (finishReason: ${payload.candidates?.[0]?.finishReason ?? "unknown"})`;
      return null;
    }

    lastErrorDetail = null;
    return text;
  } catch (error) {
    lastErrorDetail = `Request failed: ${(error as Error).message}`;
    console.error("Gemini API request failed:", (error as Error).message);
    return null;
  }
};

export const aiService = { askAi, isAiConfigured, getLastAiErrorDetail };
