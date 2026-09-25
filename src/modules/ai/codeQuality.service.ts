// What an interviewer sees that a judge does not.
//
// The judge answers one question: does it pass. Every hiring conversation
// asks a second one — would anyone want to read this — and nothing here ever
// measured it. This scores an accepted submission on four things a reviewer
// actually comments on, and keeps the score so the trend is visible.
//
// The score is stored on the submission, which never changes after it is
// created, so it is computed once and read back for free afterwards.

import { Types } from "mongoose";
import { SubmissionModel } from "../../models/Submission.model.js";
import { ProblemModel } from "../../models/Problem.model.js";
import { AppError } from "../../utils/errors.js";
import { askAi, isAiConfigured } from "./ai.service.js";
import type { AiLanguageCode } from "./aiLanguage.js";

const MAX_CODE_CHARS = 6000;

const SYSTEM_PROMPT = `You review working code the way a senior engineer reviews a pull request: it already works, so the question is whether anyone would want to maintain it.

Score four things out of 25 each:
- naming: do the names say what the things are
- structure: is it broken into sensible pieces, or one long block
- clarity: can it be followed without running it
- robustness: does it handle the awkward inputs its own problem allows

Return ONLY JSON:
{"naming":0-25,"structure":0-25,"clarity":0-25,"robustness":0-25,"summary":"...","strengths":["..."],"improvements":["..."]}

Rules: summary is one sentence. At most two strengths and two improvements, each one short sentence naming something specific in the code. Never rewrite the code, never suggest a different algorithm — the algorithm already passed. Competitive-programming style is not a fault in itself; judge whether the names and shape are readable for what this code is.`;

export interface CodeQualityScore {
  total: number;
  naming: number;
  structure: number;
  clarity: number;
  robustness: number;
  summary: string;
  strengths: string[];
  improvements: string[];
  scoredAt: Date;
}

const clip = (value: unknown, max: number) => {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…[cut]` : text;
};

const clampPart = (value: unknown) => {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return 0;
  return Math.min(Math.max(number, 0), 25);
};

const shortList = (value: unknown) =>
  (Array.isArray(value) ? value : []).filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).slice(0, 2);

export const scoreSubmission = async ({
  userId,
  submissionId,
  language,
}: {
  userId: string;
  submissionId: string;
  language?: AiLanguageCode;
}): Promise<CodeQualityScore> => {
  if (!Types.ObjectId.isValid(submissionId)) throw new AppError("That submission does not exist.", 404);

  const submission = await SubmissionModel.findOne({ _id: submissionId, userId }).lean<{
    _id: unknown;
    problemId: unknown;
    language: string;
    code: string;
    verdict: string;
    qualityScore?: CodeQualityScore;
  } | null>();
  if (!submission) throw new AppError("That submission does not exist.", 404);
  if (submission.verdict !== "ACCEPTED") throw new AppError("Only an accepted solution is worth reviewing for style.", 400);

  // The code cannot change, so neither can its score.
  if (submission.qualityScore) return submission.qualityScore;
  if (!isAiConfigured()) throw new AppError("The reviewer is not available right now.", 503);

  const problem = await ProblemModel.findById(submission.problemId).select("title constraints").lean<{ title: string; constraints?: string } | null>();

  const prompt = [
    `Problem: ${problem?.title ?? "unknown"}`,
    problem?.constraints ? `Constraints:\n${clip(problem.constraints, 400)}` : "",
    `Accepted ${submission.language} solution:\n${clip(submission.code, MAX_CODE_CHARS)}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const raw = await askAi({ system: SYSTEM_PROMPT, prompt, maxTokens: 700, language });
  if (!raw) throw new AppError("The reviewer is busy right now. Try again in a moment.", 503);

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new AppError("The reviewer answered in a shape we could not read. Try again.", 503);
  }

  const naming = clampPart(parsed.naming);
  const structure = clampPart(parsed.structure);
  const clarity = clampPart(parsed.clarity);
  const robustness = clampPart(parsed.robustness);
  const score: CodeQualityScore = {
    naming,
    structure,
    clarity,
    robustness,
    total: naming + structure + clarity + robustness,
    summary: String(parsed.summary ?? "").trim() || "No summary came back.",
    strengths: shortList(parsed.strengths),
    improvements: shortList(parsed.improvements),
    scoredAt: new Date(),
  };

  await SubmissionModel.updateOne({ _id: submission._id }, { $set: { qualityScore: score } });
  return score;
};

/** The scores this person has collected, oldest first, for the trend. */
export const qualityHistory = async (userId: string, limit = 30) => {
  const rows = await SubmissionModel.find({ userId, verdict: "ACCEPTED", qualityScore: { $exists: true } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select("qualityScore createdAt problemId")
    .populate("problemId", "title slug")
    .lean();

  return rows
    .map((row) => {
      const problem = row.problemId as unknown as { title?: string; slug?: string } | null;
      const score = (row as unknown as { qualityScore: CodeQualityScore }).qualityScore;
      return {
        total: score.total,
        scoredAt: score.scoredAt,
        problem: problem?.title ? { title: problem.title, slug: problem.slug } : null,
      };
    })
    .reverse();
};

export const codeQualityService = { scoreSubmission, qualityHistory };
