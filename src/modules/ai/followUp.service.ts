// The questions an interviewer asks after your code passes.
//
// An Accepted verdict ends the exercise here, and in a real interview it is
// where the conversation starts: what happens at ten million elements, can
// the memory come down, why that data structure and not another. Those are
// the questions people fail on, and nothing on this site ever asked them.
//
// Three questions, generated from the reader's own accepted code, then
// marked one at a time — the marking is what makes it practice rather than
// a quiz, so it says what a strong answer would have contained.

import { Types } from "mongoose";
import { SubmissionModel } from "../../models/Submission.model.js";
import { ProblemModel } from "../../models/Problem.model.js";
import { AppError } from "../../utils/errors.js";
import { askAi, isAiConfigured } from "./ai.service.js";
import type { AiLanguageCode } from "./aiLanguage.js";

const MAX_CODE_CHARS = 6000;
const QUESTION_COUNT = 3;

const ASK_SYSTEM = `You are a technical interviewer. The candidate has just solved a problem and their code passes every test.

Ask exactly ${QUESTION_COUNT} follow-up questions about THEIR solution — the kind asked after working code in a real interview:
- what happens as the input grows, or at the limits of the constraints
- whether the time or memory can be improved, and what that would cost
- why a data structure or approach was chosen over the obvious alternative
- an edge case their code handles, or quietly does not

Rules:
- Each question must refer to something concrete in their code — a loop, a structure, a branch.
- Never ask them to rewrite the whole solution, and never reveal a better algorithm in the question itself.
- One sentence each, no numbering, no preamble.
- Return ONLY a JSON array of ${QUESTION_COUNT} strings.`;

const MARK_SYSTEM = `You are marking one interview answer about the candidate's own code.

Return ONLY JSON: {"verdict":"strong"|"partial"|"off","feedback":"..."}
- "strong": correct and complete for what was asked.
- "partial": right idea, missing something that matters.
- "off": wrong, or answers a different question.
Feedback is at most three sentences: what was right, what was missing, and what a strong answer would have said. Never insult, never pad.`;

const clip = (value: unknown, max: number) => {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…[cut]` : text;
};

/** Models sometimes wrap JSON in prose or a code fence; take the first array. */
const parseQuestions = (raw: string): string[] => {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  } catch {
    return [];
  }
};

const loadAcceptedSubmission = async (userId: string, submissionId: string) => {
  if (!Types.ObjectId.isValid(submissionId)) throw new AppError("That submission does not exist.", 404);
  const submission = await SubmissionModel.findOne({ _id: submissionId, userId }).lean<{
    _id: unknown;
    problemId: unknown;
    language: string;
    code: string;
    verdict: string;
    runtimeMs: number;
  } | null>();
  if (!submission) throw new AppError("That submission does not exist.", 404);
  if (submission.verdict !== "ACCEPTED") throw new AppError("These questions come after an accepted solution.", 400);

  const problem = await ProblemModel.findById(submission.problemId)
    .select("title statement constraints difficulty")
    .lean<{ title: string; statement: string; constraints?: string; difficulty: string } | null>();
  if (!problem) throw new AppError("That problem no longer exists.", 404);
  return { submission, problem };
};

/** Three questions about this accepted solution. */
export const askFollowUps = async ({ userId, submissionId, language }: { userId: string; submissionId: string; language?: AiLanguageCode }) => {
  const { submission, problem } = await loadAcceptedSubmission(userId, submissionId);
  if (!isAiConfigured()) throw new AppError("The interviewer is not available right now.", 503);

  const prompt = [
    `Problem: ${problem.title} (${problem.difficulty.toLowerCase()})`,
    `Statement:\n${clip(problem.statement, 1500)}`,
    problem.constraints ? `Constraints:\n${clip(problem.constraints, 400)}` : "",
    `Their accepted ${submission.language} solution, which ran in ${submission.runtimeMs}ms:\n${clip(submission.code, MAX_CODE_CHARS)}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const raw = await askAi({ system: ASK_SYSTEM, prompt, maxTokens: 500, language });
  const questions = raw ? parseQuestions(raw).slice(0, QUESTION_COUNT) : [];
  if (questions.length === 0) throw new AppError("The interviewer is busy right now. Try again in a moment.", 503);
  return { questions };
};

/** Marks one answer to one of those questions. */
export const markFollowUp = async ({
  userId,
  submissionId,
  question,
  answer,
  language,
}: {
  userId: string;
  submissionId: string;
  question?: unknown;
  answer?: unknown;
  language?: AiLanguageCode;
}) => {
  if (typeof question !== "string" || !question.trim()) throw new AppError("Which question is this answering?", 400);
  if (typeof answer !== "string" || answer.trim().length < 2) throw new AppError("Write an answer first.", 400);

  const { submission, problem } = await loadAcceptedSubmission(userId, submissionId);
  if (!isAiConfigured()) throw new AppError("The interviewer is not available right now.", 503);

  const prompt = [
    `Problem: ${problem.title}`,
    `Their accepted ${submission.language} solution:\n${clip(submission.code, MAX_CODE_CHARS)}`,
    `Question: ${clip(question, 500)}`,
    `Their answer: ${clip(answer, 2000)}`,
  ].join("\n\n");

  const raw = await askAi({ system: MARK_SYSTEM, prompt, maxTokens: 400, language });
  if (!raw) throw new AppError("The interviewer is busy right now. Try again in a moment.", 503);

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { verdict?: string; feedback?: string };
    const verdict = parsed.verdict === "strong" || parsed.verdict === "partial" || parsed.verdict === "off" ? parsed.verdict : "partial";
    return { verdict, feedback: String(parsed.feedback ?? "").trim() || "No feedback came back for that one." };
  } catch {
    // The model answered in prose. That is still worth showing — it is the
    // feedback, just without the label.
    return { verdict: "partial" as const, feedback: raw.trim() };
  }
};

export const followUpService = { askFollowUps, markFollowUp };
