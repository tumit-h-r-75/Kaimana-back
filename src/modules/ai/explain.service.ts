// "Why did my code fail?" — in words, on the reader's own submission.
//
// A verdict of WRONG_ANSWER on test 7 tells you that you are wrong, and
// nothing about why. Everything needed to answer properly is already
// stored: the problem, the code, and the exact input that broke it with
// what it produced against what was wanted. This puts those three in front
// of the model and asks for the smallest true explanation.
//
// It is deliberately not a hint and costs no score: a hint tells you what
// to do next, and this only tells you what already happened. The line
// between them is the whole reason it can be free.

import { Types } from "mongoose";
import { SubmissionModel, type ISubmission } from "../../models/Submission.model.js";
import { ProblemModel } from "../../models/Problem.model.js";
import { AppError } from "../../utils/errors.js";
import { askAi, isAiConfigured } from "./ai.service.js";
import type { AiLanguageCode } from "./aiLanguage.js";

const MAX_CODE_CHARS = 6000;
const MAX_FIELD_CHARS = 600;

const SYSTEM_PROMPT = `You explain why a specific program failed a specific test, to a student who is learning.

Rules:
- Explain what THEIR code actually does with the given input, step by step, in at most four short sentences.
- Then say, in one sentence, what the problem wanted instead.
- Then name the single most likely place it goes wrong — quote the line or the expression, do not rewrite it.
- NEVER give the fix, the corrected code, or the algorithm they should use. No code blocks at all.
- If the verdict is a crash, a timeout or a compile error, explain what that verdict means for this code rather than inventing a logic error.
- Be concrete about this input and this output. Never speak in generalities.`;

const clip = (value: unknown, max: number) => {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…[cut]` : text;
};

const verdictInPlainWords: Record<string, string> = {
  WRONG_ANSWER: "the output did not match what was expected",
  TIME_LIMIT_EXCEEDED: "it did not finish inside the time limit",
  MEMORY_LIMIT_EXCEEDED: "it used more memory than allowed",
  RUNTIME_ERROR: "it crashed while running",
  COMPILATION_ERROR: "it did not compile",
};

export const explainFailure = async ({
  userId,
  submissionId,
  language,
}: {
  userId: string;
  submissionId: string;
  language?: AiLanguageCode;
}) => {
  if (!Types.ObjectId.isValid(submissionId)) throw new AppError("That submission does not exist.", 404);

  // Only your own submission: this hands back the code and the failing
  // input, which is not public information.
  const submission = await SubmissionModel.findOne({ _id: submissionId, userId }).lean<ISubmission | null>();
  if (!submission) throw new AppError("That submission does not exist.", 404);
  if (submission.verdict === "ACCEPTED") throw new AppError("This submission passed — there is nothing to explain.", 400);
  if (submission.verdict === "PENDING" || submission.verdict === "RUNNING") {
    throw new AppError("This submission is still being judged.", 400);
  }

  const problem = await ProblemModel.findById(submission.problemId)
    .select("title statement constraints")
    .lean<{ title: string; statement: string; constraints?: string } | null>();
  if (!problem) throw new AppError("That problem no longer exists.", 404);

  if (!isAiConfigured()) {
    // Still worth something without a model: the facts, arranged.
    const failed = submission.failedTest;
    return {
      explanation: failed
        ? `Test ${failed.index + 1} gave the input below and expected "${clip(failed.expectedOutput, 200)}", but your program produced "${clip(failed.actualOutput, 200)}".\n\n${clip(failed.input, 400)}`
        : `The judge reported ${submission.verdict.replace(/_/g, " ").toLowerCase()}${submission.errorMessage ? `: ${clip(submission.errorMessage, 300)}` : "."}`,
      source: "facts" as const,
    };
  }

  const failed = submission.failedTest;
  const prompt = [
    `Problem: ${problem.title}`,
    `Statement:\n${clip(problem.statement, 2000)}`,
    problem.constraints ? `Constraints:\n${clip(problem.constraints, 500)}` : "",
    `Language: ${submission.language}`,
    `Verdict: ${submission.verdict} — ${verdictInPlainWords[submission.verdict] ?? "it did not pass"}`,
    `Tests passed: ${submission.passedTests} of ${submission.totalTests}`,
    submission.errorMessage ? `Judge message:\n${clip(submission.errorMessage, MAX_FIELD_CHARS)}` : "",
    failed
      ? [
          `The first failing test (number ${failed.index + 1}):`,
          `Input:\n${clip(failed.input, MAX_FIELD_CHARS)}`,
          `Expected output:\n${clip(failed.expectedOutput, MAX_FIELD_CHARS)}`,
          `Their program printed:\n${clip(failed.actualOutput, MAX_FIELD_CHARS)}`,
        ].join("\n")
      : "No single failing test was recorded — reason about the verdict itself.",
    `Their code:\n${clip(submission.code, MAX_CODE_CHARS)}`,
    "",
    "Explain why this code failed this test. Do not give the fix.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const explanation = await askAi({ system: SYSTEM_PROMPT, prompt, maxTokens: 700, language });
  if (!explanation) throw new AppError("The explainer is busy right now. Try again in a moment.", 503);

  return { explanation, source: "ai" as const };
};

export const explainService = { explainFailure };
