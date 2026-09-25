// "How does this one work?" — on somebody else's accepted solution.
//
// The community feed hands you other people's code and nothing else. Reading
// an unfamiliar approach is exactly where a learner stalls: the code is
// correct, it is short, and it is not obvious why it works.
//
// This explains the approach in steps, and — when the reader has an accepted
// solution of their own on the same problem — says how the two differ. That
// comparison is the part that teaches; the rest is a walkthrough.

import { Types } from "mongoose";
import { SubmissionModel } from "../../models/Submission.model.js";
import { ProblemModel } from "../../models/Problem.model.js";
import { AppError } from "../../utils/errors.js";
import { communityService } from "../community/community.service.js";
import { askAi, isAiConfigured } from "./ai.service.js";
import type { AiLanguageCode } from "./aiLanguage.js";

const MAX_CODE_CHARS = 5000;

const SYSTEM_PROMPT = `You explain someone else's working solution to a learner who has the problem in front of them.

Write:
1. The idea in one sentence — what the solution is doing, not how.
2. Three to five short steps walking through the code, naming the variables and structures it actually uses.
3. One sentence on why it is efficient: what it avoids doing.

If the reader's own solution is given, add a final short paragraph comparing the two: what this one does differently, and when that difference matters. Never say one is "better" without saying in what way.

Rules: no code blocks, no rewriting, no invented details. If something in the code is unclear, say so plainly rather than guessing.`;

const clip = (value: unknown, max: number) => {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…[cut]` : text;
};

export const explainSolution = async ({
  userId,
  submissionId,
  language,
}: {
  userId: string;
  submissionId: string;
  language?: AiLanguageCode;
}) => {
  if (!Types.ObjectId.isValid(submissionId)) throw new AppError("That solution does not exist.", 404);

  // The community's own visibility rule decides what may be read, so a
  // contest still running cannot be explained out from under it.
  const visible = await communityService.getVisibleFilter();
  const submission = await SubmissionModel.findOne({ ...visible, _id: submissionId }).lean<{
    _id: unknown;
    problemId: unknown;
    userId: unknown;
    language: string;
    code: string;
    runtimeMs: number;
  } | null>();
  if (!submission) throw new AppError("That solution does not exist.", 404);

  const problem = await ProblemModel.findById(submission.problemId)
    .select("title statement")
    .lean<{ title: string; statement: string } | null>();
  if (!problem) throw new AppError("That problem no longer exists.", 404);

  if (!isAiConfigured()) throw new AppError("The explainer is not available right now.", 503);

  // Their own accepted code on the same problem, if there is any — this is
  // what turns a walkthrough into a comparison.
  const mine =
    String(submission.userId) === userId
      ? null
      : await SubmissionModel.findOne({ userId, problemId: submission.problemId, verdict: "ACCEPTED" })
          .sort({ createdAt: -1 })
          .select("code language")
          .lean<{ code: string; language: string } | null>();

  const prompt = [
    `Problem: ${problem.title}`,
    `Statement:\n${clip(problem.statement, 1500)}`,
    `The solution to explain (${submission.language}, ran in ${submission.runtimeMs}ms):\n${clip(submission.code, MAX_CODE_CHARS)}`,
    mine ? `The reader's own accepted ${mine.language} solution:\n${clip(mine.code, MAX_CODE_CHARS)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const explanation = await askAi({ system: SYSTEM_PROMPT, prompt, maxTokens: 900, language });
  if (!explanation) throw new AppError("The explainer is busy right now. Try again in a moment.", 503);

  return { explanation, comparedWithYours: Boolean(mine) };
};

export const explainSolutionService = { explainSolution };
