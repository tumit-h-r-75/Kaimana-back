// Shared AI gateway service for stateless AI feature requests.
//
// Every AI feature (Hint, Interview, Auditor, Refactor Coach, Test Case
// Generator) goes through `askAi`. When neither provider below is
// configured — e.g. local development, or a deployment that hasn't set
// anything up yet — `askAi` returns null instead of throwing, and the
// caller is expected to fall back to a deterministic, rule-based response.
// This mirrors the project's existing Judge0 "Plan B" pattern: every
// AI-flavored endpoint works with zero setup, and gets smarter
// automatically once a real key is added.
//
// Two providers, tried in this order:
//
//   1. Groq (api.groq.com) — PRIMARY. A free, no-credit-card API tier with
//      much lower latency than Gemini's free tier — this is a direct
//      response to Gemini being reported as noticeably slow in practice.
//      OpenAI-compatible request/response shape. Getting a key:
//      https://console.groq.com/keys — sign in, "Create API Key", copy it,
//      set GROQ_API_KEY (locally in .env.local, and on the backend's
//      Vercel project under Settings → Environment Variables). No card
//      needed for the free tier.
//
//   2. Gemini (generativelanguage.googleapis.com) — FALLBACK, used only
//      when GROQ_API_KEY isn't set. Kept working rather than removed so an
//      existing Gemini setup still functions on its own (e.g. while its
//      account-level access issue, if any, gets sorted out with Google).
//      Getting a key: https://aistudio.google.com/apikey.
//
// Both providers' errors are surfaced through the same
// isAiConfigured()/getLastAiErrorDetail() pair so callers (interview.
// service.ts's diagnostic suffix, etc.) don't need to know which provider
// actually ran.

import { config } from "../../config/env.js";

export interface AskAiOptions {
  system: string;
  prompt: string;
  maxTokens?: number;
}

export const isAiConfigured = () => Boolean(config.groqApiKey || config.geminiApiKey);

// Diagnostic only — never includes either key itself. Lets a caller tell
// "not configured" apart from "configured but this exact call failed"
// (and why, and which provider) without needing access to server logs.
// Module-scoped state reflecting only the most recent askAi() call is good
// enough for that; it's read right after the specific call it describes,
// never across unrelated requests.
let lastErrorDetail: string | null = null;
export const getLastAiErrorDetail = () => lastErrorDetail;

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
// openai/gpt-oss-120b: a Production (generally-available), non-Enterprise-
// gated model on Groq's own model list — good quality/speed tradeoff for
// short system+user-prompt text generation. (llama-3.3-70b-versatile was
// used here originally but Groq deprecated it/gated it to Enterprise
// accounts, which started 404ing with model_not_found — Groq rotates its
// supported model list more often than most providers, so re-check
// https://console.groq.com/docs/models before assuming this one is still
// current if it ever starts erroring the same way.) Override with
// GROQ_MODEL if this gets retired before the code is updated.
const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";
const GROQ_MODEL = config.groqModel || DEFAULT_GROQ_MODEL;

const askGroq = async ({ system, prompt, maxTokens = 400 }: AskAiOptions): Promise<string | null> => {
  if (!config.groqApiKey) return null; // guarded by askAi's caller; re-checked here so this is safe to call directly too
  try {
    const response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.groqApiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        // Groq's current API documents max_completion_tokens, not the
        // older OpenAI max_tokens field — the request is silently ignored
        // (uncapped) rather than erroring if the wrong field name is used,
        // which would be a much harder bug to notice than a 400.
        max_completion_tokens: maxTokens,
      }),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      console.error("Groq API error:", response.status, bodyText);
      lastErrorDetail = `Groq: HTTP ${response.status} (model: ${GROQ_MODEL}) — ${bodyText.slice(0, 300)}`;
      return null;
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    };

    const text = payload.choices?.[0]?.message?.content?.trim();
    if (!text) {
      lastErrorDetail = `Groq returned no text (finish_reason: ${payload.choices?.[0]?.finish_reason ?? "unknown"})`;
      return null;
    }

    lastErrorDetail = null;
    return text;
  } catch (error) {
    lastErrorDetail = `Groq: request failed: ${(error as Error).message}`;
    console.error("Groq API request failed:", (error as Error).message);
    return null;
  }
};

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// "gemini-flash-latest": an alias Google keeps pointed at its current
// recommended fast/low-cost model, instead of a version pinned by name
// like "gemini-2.5-flash" — Gemini model names get retired often enough
// (see https://ai.google.dev/gemini-api/docs/changelog) that a pinned
// name tends to silently start 404ing a few months later. Override with
// GEMINI_MODEL in the environment if this ever needs to be pinned again.
const DEFAULT_GEMINI_MODEL = "gemini-flash-latest";
const GEMINI_MODEL = config.geminiModel || DEFAULT_GEMINI_MODEL;

const askGemini = async ({ system, prompt, maxTokens = 400 }: AskAiOptions): Promise<string | null> => {
  if (!config.geminiApiKey) return null; // guarded by askAi's caller; re-checked here so this is safe to call directly too, and narrows the header value below to `string`
  const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent`;

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
      lastErrorDetail = `Gemini: HTTP ${response.status} (model: ${GEMINI_MODEL}) — ${bodyText.slice(0, 300)}`;
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
    lastErrorDetail = `Gemini: request failed: ${(error as Error).message}`;
    console.error("Gemini API request failed:", (error as Error).message);
    return null;
  }
};

export const askAi = async (options: AskAiOptions): Promise<string | null> => {
  if (config.groqApiKey) {
    const result = await askGroq(options);
    // Genuinely fall back to Gemini when Groq is configured but the call
    // itself failed (bad model name, rate limit, outage, account issue —
    // see ai.service.ts's module comment) and Gemini is ALSO configured,
    // not just when Groq isn't set up at all. Without this, having both
    // keys set only ever protected against Groq being unconfigured, never
    // against Groq being configured-but-broken — which is exactly the
    // failure mode a "fallback provider" is supposed to cover.
    if (result !== null || !config.geminiApiKey) return result;
    return askGemini(options);
  }
  if (config.geminiApiKey) {
    return askGemini(options);
  }
  lastErrorDetail = null;
  return null;
};

export const aiService = { askAi, isAiConfigured, getLastAiErrorDetail };
