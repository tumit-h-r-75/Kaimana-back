// AI service for generating code refactoring and optimization recommendations.
//
// On an Accepted submission (per SRS F5), asks Gemini for 1-3 concrete
// refactor suggestions as structured JSON (title + rationale + full
// refactored code) — schema-validated with one retry on a malformed
// response, per SRS FR-BE-06. There's no rule-based Plan-B here unlike
// hint/interview/audit: a credible code rewrite needs actual language
// understanding, and synthesizing one without an LLM risks silently
// handing back broken code labeled as an "improvement." Without
// GEMINI_API_KEY configured, this returns zero suggestions with an
// explicit reason instead.
//
// "Apply" happens client-side (replaces the editor's content); "Verified"
// is earned server-side by re-running the refactored code (stored, not
// client-supplied) against every one of the problem's test cases and
// confirming it still gets a clean ACCEPTED.

import { Types } from "mongoose";
import { SubmissionModel, type IRefactorSuggestion } from "../../models/Submission.model.js";
import { judgeSubmission } from "../submission/judge.service.js";
import { AppError } from "../../utils/errors.js";
import { askAi, isAiConfigured } from "./ai.service.js";
import type { AiLanguageCode } from "./aiLanguage.js";
import type { JudgeLanguage } from "../../integrations/judge0/judge0.service.js";

const MAX_SUGGESTIONS = 3;

const SYSTEM_PROMPT = `You are Kaimana's Code Refactor Advisor, reviewing an already-ACCEPTED competitive programming solution for a learner.
Rules you must always follow:
- Suggest up to 3 concrete improvements to readability and/or performance. Do not suggest changes that would alter the program's behavior or output.
- Respond with ONLY a JSON array, no prose before or after. Each element: {"title": string (<=60 chars), "rationale": string (2-3 sentences explaining the improvement), "refactoredCode": string (the FULL rewritten source, complete and runnable, same language)}.
- refactoredCode must be a complete, compilable/runnable replacement for the entire file — never a snippet or diff.
- If the code is already clean and nothing meaningful can be improved, respond with an empty JSON array: [].`;

interface ParsedSuggestion {
  title: string;
  rationale: string;
  refactoredCode: string;
}

const parseSuggestions = (raw: string): ParsedSuggestion[] | null => {
  try {
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "");
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return null;
    const valid = parsed.every(
      (item) =>
        item &&
        typeof item.title === "string" &&
        typeof item.rationale === "string" &&
        typeof item.refactoredCode === "string" &&
        item.refactoredCode.trim().length > 0,
    );
    if (!valid) return null;
    return (parsed as ParsedSuggestion[]).slice(0, MAX_SUGGESTIONS);
  } catch {
    return null;
  }
};

export const generateRefactorSuggestions = async ({
  userId,
  submissionId,
  language,
}: {
  userId: string;
  submissionId: string;
  language?: AiLanguageCode;
}) => {
  if (!Types.ObjectId.isValid(submissionId)) throw new AppError("Submission not found.", 404);
  const submission = await SubmissionModel.findById(submissionId);
  if (!submission) throw new AppError("Submission not found.", 404);
  if (String(submission.userId) !== String(userId)) throw new AppError("This submission belongs to another user.", 403);
  if (submission.verdict !== "ACCEPTED") throw new AppError("Refactor suggestions are only available for an Accepted submission.", 400);

  if (submission.refactorSuggestions && submission.refactorSuggestions.length > 0) {
    return { suggestions: submission.refactorSuggestions, source: "ai" as const };
  }

  if (!isAiConfigured()) {
    return {
      suggestions: [] as IRefactorSuggestion[],
      source: "unavailable" as const,
      message: "AI refactor suggestions need a GEMINI_API_KEY configured on the server.",
    };
  }

  const prompt = `Language: ${submission.language}\n\nAccepted solution:\n${submission.code}\n\nSuggest improvements now.`;

  let parsed: ParsedSuggestion[] | null = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
    const raw = await askAi({ system: SYSTEM_PROMPT, prompt, maxTokens: 1800, language });
    if (raw) parsed = parseSuggestions(raw);
  }

  if (!parsed) {
    return {
      suggestions: [] as IRefactorSuggestion[],
      source: "unavailable" as const,
      message: "Could not generate refactor suggestions right now — try again in a moment.",
    };
  }

  const suggestions: IRefactorSuggestion[] = parsed.map((s) => ({
    title: s.title,
    rationale: s.rationale,
    refactoredCode: s.refactoredCode,
    isVerified: false,
  }));

  submission.refactorSuggestions = suggestions;
  await submission.save();

  return { suggestions, source: "ai" as const };
};

export const verifyRefactorSuggestion = async ({
  userId,
  submissionId,
  suggestionIndex,
}: {
  userId: string;
  submissionId: string;
  suggestionIndex: number;
}) => {
  if (!Types.ObjectId.isValid(submissionId)) throw new AppError("Submission not found.", 404);
  const submission = await SubmissionModel.findById(submissionId);
  if (!submission) throw new AppError("Submission not found.", 404);
  if (String(submission.userId) !== String(userId)) throw new AppError("This submission belongs to another user.", 403);

  const suggestion = submission.refactorSuggestions?.[suggestionIndex];
  if (!suggestion) throw new AppError("Refactor suggestion not found.", 404);

  if (suggestion.isVerified) return suggestion;

  const result = await judgeSubmission({
    problemId: String(submission.problemId),
    language: submission.language as JudgeLanguage,
    code: suggestion.refactoredCode,
  });

  if (result.verdict !== "ACCEPTED") {
    throw new AppError(
      `The refactored code did not pass all tests when re-run (${result.verdict.replace(/_/g, " ").toLowerCase()}) — not marking it Verified.`,
      422,
    );
  }

  suggestion.isVerified = true;
  await submission.save();

  return suggestion;
};

export const refactorService = { generateRefactorSuggestions, verifyRefactorSuggestion };
