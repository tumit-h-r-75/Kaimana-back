import type { Response } from "express";
import httpStatus from "http-status";
import { Types } from "mongoose";
import { isJudgeLanguage } from "../../integrations/judge0/judge0.service.js";
import type { AuthenticatedRequest } from "../../middleware/auth.middleware.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/response.js";
import { AppError } from "../../utils/errors.js";
import { computeScore } from "../../utils/scoring.js";
import { gemsForDifficulty } from "../../utils/gems.js";
import { SubmissionModel } from "../../models/Submission.model.js";
import { UserModel } from "../../models/User.model.js";
import { HintUnlockModel, type IHintUnlock } from "../../models/HintUnlock.model.js";
import { contestService } from "../contest/contest.service.js";
import { problemService } from "../problem/problem.service.js";
import { testCaseService } from "../problem/testcase.service.js";
import { judgeSubmission } from "./judge.service.js";
import { runService } from "./run.service.js";

const MAX_CODE_LENGTH = 20_000;
const MAX_CUSTOM_INPUT_LENGTH = 5_000;
const UNSUPPORTED_LANGUAGE_MESSAGE = "Unsupported language. Use python, cpp, javascript, or typescript.";

// Runs aren't stored, so this limit can only be per serverless instance —
// best effort, not a guarantee.
const RUNS_PER_MINUTE = 10;
const recentExecutions = new Map<string, number[]>();

// POST /api/submissions/execute — the workspace's "Run" button: runs the code
// on the problem's sample tests (or custom stdin) and reports each result.
const execute = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const userId = String(req.user?._id);
  const now = Date.now();
  const requests = (recentExecutions.get(userId) ?? []).filter((time) => now - time < 60_000);
  if (requests.length >= RUNS_PER_MINUTE) throw new AppError("Run limit reached. Try again in a minute.", 429);
  recentExecutions.set(userId, [...requests, now]);

  const { language, source, stdin, problemId } = (req.body ?? {}) as Record<string, unknown>;
  if (!isJudgeLanguage(language)) throw new AppError(UNSUPPORTED_LANGUAGE_MESSAGE, 400);
  // A missing or non-string `source` used to reach `source.trim()` and 500.
  if (typeof source !== "string" || !source.trim()) throw new AppError("Write some code before running it.", 400);
  if (source.length > MAX_CODE_LENGTH) throw new AppError("Code is outside the allowed size limit.", 400);
  if (stdin !== undefined && (typeof stdin !== "string" || stdin.length > MAX_CUSTOM_INPUT_LENGTH)) {
    throw new AppError("Custom input must be text of at most 5,000 characters.", 400);
  }
  if (problemId !== undefined && (typeof problemId !== "string" || !Types.ObjectId.isValid(problemId))) {
    throw new AppError("problemId is not a valid id.", 400);
  }

  const result = await runService.runCode({
    language,
    source,
    stdin: stdin as string | undefined,
    problemId: problemId as string | undefined,
    canSeeUnpublished: req.user?.role === "admin",
  });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Code executed", data: result });
});

// Every submission fans out to one Judge0 run per test case on the shared
// public instance, so a script submitting in a loop could exhaust it for
// everyone. Counted from stored submissions, the limit holds across
// serverless instances and cold starts.
const SUBMISSIONS_PER_MINUTE = 6;

// POST /api/submissions — the system-gate endpoint: create a PENDING
// submission, judge it synchronously against Judge0 (no queue/worker
// infrastructure on this Vercel deployment), then return the final verdict.
const submit = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const { problemId, code, language, contestId } = (req.body ?? {}) as Record<string, unknown>;

  if (typeof problemId !== "string" || typeof code !== "string" || !code.trim() || typeof language !== "string") {
    throw new AppError("problemId, code, and language are required.", 400);
  }
  if (!Types.ObjectId.isValid(problemId)) throw new AppError("problemId is not a valid id.", 400);
  if (contestId !== undefined && contestId !== null && typeof contestId !== "string") throw new AppError("contestId is not a valid id.", 400);
  if (!isJudgeLanguage(language)) throw new AppError(UNSUPPORTED_LANGUAGE_MESSAGE, 400);
  if (code.length > MAX_CODE_LENGTH) throw new AppError("Code is outside the allowed size limit.", 400);

  const userId = String(req.user?._id);

  const recentSubmissions = await SubmissionModel.countDocuments({ userId, createdAt: { $gte: new Date(Date.now() - 60_000) } });
  if (recentSubmissions >= SUBMISSIONS_PER_MINUTE) throw new AppError("Too many submissions. Wait a minute before submitting again.", 429);

  // Pre-flight check: verify problem exists and has reviewed test cases BEFORE creating a DB record.
  // Fixes Bug #3: prevents unconfigured problems from saving fake RUNTIME_ERROR submissions.
  const problem = await problemService.getProblemForJudging(problemId);
  if (!problem.isPublished && req.user?.role !== "admin") throw new AppError("Problem not found.", 404);
  await testCaseService.getTestCasesForJudging(problemId);
  const contest = contestId ? await contestService.getSubmissionContext(contestId, userId, problemId) : null;

  const submission = await SubmissionModel.create({
    userId,
    problemId,
    contestId: contest?.contestId,
    language,
    code,
    verdict: "RUNNING",
  });

  // Set inside the try block below on a first-time ACCEPTED, then read
  // after — declared out here so it's in scope for the final response
  // regardless of which path the judging run took.
  let gemsAwarded = 0;

  try {
    const result = await judgeSubmission({ problemId, language, code });
    // Partial credit: score is proportional to how many test cases passed,
    // not gated to a full ACCEPTED verdict. judge.service.ts stops at the
    // first failing test, so `passedTests` already holds the count that
    // ran clean before that point (0 for a COMPILATION_ERROR, since it
    // never runs any test). computeScore() naturally returns 0 when
    // passedTests is 0, so nothing needs a separate zero-score branch.
    //
    // Hint penalty: any AI hints this learner has unlocked on this problem
    // (see hint.service.ts) forfeit a percentage of every submission's
    // score on it, not just the attempt made right after asking — a hint
    // read once still applies going forward, the same way a wrong answer
    // costs marks for good on a negative-marking exam.
    const hintUnlock = await HintUnlockModel.findOne({ userId, problemId })
      .select("penaltyPercent")
      .lean<Pick<IHintUnlock, "penaltyPercent"> | null>();
    const score = computeScore({
      basePoints: problem.basePoints,
      passedTests: result.passedTests,
      totalTests: result.totalTests,
      hintPenaltyPercent: hintUnlock?.penaltyPercent ?? 0,
    });

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

    // Gems: a fixed, difficulty-scaled reward the first time this user
    // gets ACCEPTED on this problem. Checked against every OTHER
    // submission (excluding the one just saved) so re-solving an
    // already-solved problem — or resubmitting the same passing code —
    // never pays out twice.
    if (result.verdict === "ACCEPTED") {
      const alreadySolved = await SubmissionModel.exists({
        userId,
        problemId,
        verdict: "ACCEPTED",
        _id: { $ne: submission._id },
      });
      if (!alreadySolved) {
        gemsAwarded = gemsForDifficulty(problem.difficulty);
        await UserModel.findByIdAndUpdate(userId, { $inc: { gems: gemsAwarded } });
      }
    }
  } catch (error) {
    // Judging never reached a verdict: Judge0 was unavailable, rate-limited
    // or too slow (all surfaced as 503 by judge0.service.ts), or something
    // unexpected broke. Neither says anything about the learner's code, so
    // don't keep a RUNTIME_ERROR record that would permanently cost them
    // score — the problem and its test cases were already validated above.
    // Delete the placeholder and return a clean, retryable error instead.
    await SubmissionModel.findByIdAndDelete(submission._id);
    throw error;
  }

  // gemsAwarded rides along on the response only (not persisted on the
  // submission document) so the frontend can show a "+N gems" toast right
  // when it happens, without a second round trip.
  sendResponse(res, {
    success: true,
    statusCode: httpStatus.CREATED,
    message: "Submission judged",
    data: { ...submission.toJSON(), gemsAwarded },
  });
});

const getById = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  if (!Types.ObjectId.isValid(String(req.params.id))) throw new AppError("Submission not found.", 404);
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
  if (problemId) {
    if (!Types.ObjectId.isValid(String(problemId))) throw new AppError("problemId is not a valid id.", 400);
    filter.problemId = problemId;
  }

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
