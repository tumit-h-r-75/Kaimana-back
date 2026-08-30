import type { Response } from "express";
import httpStatus from "http-status";
import { Types } from "mongoose";
import { executeCode } from "../../integrations/judge0/judge0.service.js";
import type { JudgeLanguage } from "../../integrations/judge0/judge0.service.js";
import type { AuthenticatedRequest } from "../../middleware/auth.middleware.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/response.js";
import { AppError } from "../../utils/errors.js";
import { computeScore } from "../../utils/scoring.js";
import { SubmissionModel } from "../../models/Submission.model.js";
import { problemService } from "../problem/problem.service.js";
import { judgeSubmission } from "./judge.service.js";

const recentExecutions = new Map<string, number[]>();
const execute = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const userId = String(req.user?._id);
  const now = Date.now();
  const requests = (recentExecutions.get(userId) ?? []).filter((time) => now - time < 60_000);
  if (requests.length >= 10) return res.status(429).json({ success: false, message: "Execution limit reached. Try again in a minute." });
  recentExecutions.set(userId, [...requests, now]);
  const result = await executeCode(req.body);
  sendResponse(res, { success: true, statusCode: 200, message: "Code executed", data: result });
});

const judgeLanguages = new Set<JudgeLanguage>(["python", "cpp", "javascript"]);

// POST /api/submissions — the system-gate endpoint: create a PENDING
// submission, judge it synchronously against Judge0 (no queue/worker
// infrastructure on this Vercel deployment), then return the final verdict.
const submit = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const { problemId, code, language, contestId } = req.body as {
    problemId?: string;
    code?: string;
    language?: string;
    contestId?: string;
  };

  if (!problemId || !code?.trim() || !language) throw new AppError("problemId, code, and language are required.", 400);
  // A malformed id (or a stray "undefined"/"null" string from a broken
  // caller) reaches Mongoose as a CastError, which the global error handler
  // doesn't special-case — it falls through to a generic 500 instead of a
  // clean 400. Validate the shape up front instead.
  if (!Types.ObjectId.isValid(problemId)) throw new AppError("problemId is not a valid id.", 400);
  if (contestId && !Types.ObjectId.isValid(contestId)) throw new AppError("contestId is not a valid id.", 400);
  if (!judgeLanguages.has(language as JudgeLanguage)) throw new AppError("Unsupported language. Use python, cpp, or javascript.", 400);
  if (code.length > 20_000) throw new AppError("Code is outside the allowed size limit.", 400);

  const userId = String(req.user?._id);

  const submission = await SubmissionModel.create({
    userId,
    problemId,
    contestId: contestId || undefined,
    language,
    code,
    verdict: "RUNNING",
  });

  try {
    const problem = await problemService.getProblemForJudging(problemId);
    const result = await judgeSubmission({ problemId, language: language as JudgeLanguage, code });
    // Partial credit: score is proportional to how many test cases passed,
    // not gated to a full ACCEPTED verdict. judge.service.ts stops at the
    // first failing test, so `passedTests` already holds the count that
    // ran clean before that point (0 for a COMPILATION_ERROR, since it
    // never runs any test). computeScore() naturally returns 0 when
    // passedTests is 0, so nothing needs a separate zero-score branch.
    const score = computeScore({ basePoints: problem.basePoints, passedTests: result.passedTests, totalTests: result.totalTests });

    submission.set({
      verdict: result.verdict,
      passedTests: result.passedTests,
      totalTests: result.totalTests,
      runtimeMs: result.runtimeMs,
      memoryKb: result.memoryKb,
      score,
      errorMessage: result.errorMessage,
      failedTest: result.failedTest,
    });
    await submission.save();
  } catch (error) {
    // An infra failure (Judge0's free demo unavailable/overloaded/timed out
    // — surfaced as a 5xx AppError, see judge0.service.ts) is not the same
    // thing as the user's code actually being broken. Recording it as a
    // RUNTIME_ERROR with score 0 silently lied about why the submission
    // failed and permanently penalized a correct solution for a transient
    // outage. Delete the placeholder and return a clean, retryable error
    // instead — the frontend already surfaces submit() failures via
    // setSubmitError without creating a fake submission record.
    const isInfraFailure = error instanceof AppError && error.statusCode >= 500;
    if (isInfraFailure) {
      await SubmissionModel.findByIdAndDelete(submission._id);
      throw error;
    }
    submission.set({ verdict: "RUNTIME_ERROR", errorMessage: (error as Error).message?.slice(0, 500) ?? "Judging failed." });
    await submission.save();
  }

  sendResponse(res, { success: true, statusCode: httpStatus.CREATED, message: "Submission judged", data: submission });
});

const getById = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const submission = await SubmissionModel.findById(req.params.id);
  if (!submission) throw new AppError("Submission not found.", 404);
  if (String(submission.userId) !== String(req.user?._id) && req.user?.role !== "admin") {
    throw new AppError("You do not have access to this submission.", 403);
  }
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Submission loaded", data: submission });
});

const list = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const { problemId, page = "1", limit = "20" } = req.query as Record<string, string>;
  const filter: Record<string, unknown> = { userId: req.user?._id };
  if (problemId) filter.problemId = problemId;

  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);

  const [items, total] = await Promise.all([
    SubmissionModel.find(filter)
      .select("problemId language verdict passedTests totalTests runtimeMs score createdAt")
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit),
    SubmissionModel.countDocuments(filter),
  ]);

  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Submissions loaded", data: { items, total, page: safePage, limit: safeLimit } });
});

export const submissionController = { execute, submit, getById, list };
