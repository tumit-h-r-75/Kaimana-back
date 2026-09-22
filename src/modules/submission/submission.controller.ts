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
import { ProblemModel } from "../../models/Problem.model.js";
import { LANGUAGE_ALIASES, toSearchRegex } from "../../utils/search.js";
import { UserModel } from "../../models/User.model.js";
import { HintUnlockModel, type IHintUnlock } from "../../models/HintUnlock.model.js";
import { contestService } from "../contest/contest.service.js";
import { problemService } from "../problem/problem.service.js";
import { testCaseService } from "../problem/testcase.service.js";
import { gemsService } from "./gems.service.js";
import { judgeSubmission } from "./judge.service.js";
import { runService } from "./run.service.js";
import { traceService } from "./trace.service.js";
import { config } from "../../config/env.js";
import { getIO } from "../../sockets/index.js";
import { getContestRoom, GLOBAL_LEADERBOARD_ROOM } from "../../sockets/handlers.js";
import { leaderboardService } from "../leaderboard/leaderboard.service.js";

const MAX_CODE_LENGTH = 20_000;
const MAX_CUSTOM_INPUT_LENGTH = 5_000;
const UNSUPPORTED_LANGUAGE_MESSAGE = "Unsupported language. Use python, cpp, javascript, or typescript.";

// Runs aren't stored, so this limit can only be per serverless instance —
// best effort, not a guarantee.
const RUNS_PER_MINUTE = 10;
const recentExecutions = new Map<string, number[]>();

// A traced run costs far more judge time than a plain one, so it gets its
// own, tighter budget rather than sharing the Run button's.
const TRACES_PER_MINUTE = 4;
const recentTraces = new Map<string, number[]>();

/** Shared sliding-window check; returns false when the caller is over budget. */
const withinRateLimit = (bucket: Map<string, number[]>, userId: string, limit: number) => {
  const now = Date.now();
  const recent = (bucket.get(userId) ?? []).filter((time) => now - time < 60_000);
  if (recent.length >= limit) return false;
  bucket.set(userId, [...recent, now]);
  return true;
};

// POST /api/submissions/execute — the workspace's "Run" button: runs the code
// on the problem's sample tests (or custom stdin) and reports each result.
const execute = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const userId = String(req.user?._id);
  if (!withinRateLimit(recentExecutions, userId, RUNS_PER_MINUTE)) {
    throw new AppError("Run limit reached. Try again in a minute.", 429);
  }

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

// POST /api/submissions/visualise — Execution Visualizer. Re-runs the code
// under a tracing harness and returns what each line did, for the timeline in
// the workspace. Never called as part of a normal run or submission.
const visualise = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  if (!config.executionVisualizerEnabled) throw new AppError("The execution visualizer is not enabled.", 404);

  const userId = String(req.user?._id);
  if (!withinRateLimit(recentTraces, userId, TRACES_PER_MINUTE)) {
    throw new AppError("Visualise limit reached. Try again in a minute.", 429);
  }

  const { language, source } = (req.body ?? {}) as Record<string, unknown>;
  if (!isJudgeLanguage(language)) throw new AppError(UNSUPPORTED_LANGUAGE_MESSAGE, 400);
  if (typeof source !== "string" || !source.trim()) throw new AppError("Write some code before visualising it.", 400);
  if (source.length > MAX_CODE_LENGTH) throw new AppError("Code is outside the allowed size limit.", 400);

  const result = await traceService.traceExecution({ language, source });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Execution traced", data: result });
});

// Every submission fans out to one Judge0 run per test case on the shared
// public instance, so a script submitting in a loop could exhaust it for
// everyone. Counted from stored submissions, the limit holds across
// serverless instances and cold starts.
const SUBMISSIONS_PER_MINUTE = 6;

// POST /api/submissions — the system-gate endpoint: judge the code
// synchronously against Judge0 (no queue/worker infrastructure on this Vercel
// deployment), store the submission with its final verdict, and return it.
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

  // When the learner pressed Submit. The contest scoreboard's time window is
  // checked against this, because the record itself is only created once
  // judging has finished, a few seconds later.
  const submittedAt = new Date();

  // Judge first, store after. The submission used to be created as a RUNNING
  // placeholder before judging and updated afterwards, so whenever the
  // serverless function was cut off mid-judging (a timeout, a crash, a
  // deploy) the update never ran and the record stayed RUNNING forever.
  // Storing only the final result makes that state impossible: an
  // interrupted run leaves nothing behind, and an infrastructure failure
  // (Judge0 unavailable, rate-limited or too slow — all 503s, see
  // judge0.service.ts and judge.service.ts's deadline) simply propagates as
  // a clean, retryable error with nothing to clean up.
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

  const submission = await SubmissionModel.create({
    userId,
    problemId,
    contestId: contest?.contestId,
    language,
    code,
    verdict: result.verdict,
    passedTests: result.passedTests,
    totalTests: result.totalTests,
    runtimeMs: result.runtimeMs,
    memoryKb: result.memoryKb,
    score,
    errorMessage: result.errorMessage,
    failedTest: result.failedTest,
    submittedAt,
  });

  // Gems: a fixed, difficulty-scaled reward paid exactly once per problem,
  // on the user's first ACCEPTED (see gems.service.ts). A failed payout must
  // not fail a submission that was already judged and stored — the ledger
  // has no row for it, so the next accepted submission pays it instead.
  let gemsAwarded = 0;
  if (result.verdict === "ACCEPTED") {
    try {
      gemsAwarded = await gemsService.awardFirstSolveGems({ userId, problemId, submissionId: submission._id, difficulty: problem.difficulty });
    } catch (error) {
      console.error("First-solve gem payout failed:", error);
    }
  }

  // Trigger real-time Socket.IO broadcasts asynchronously (must not delay HTTP response)
  void (async () => {
    try {
      const io = getIO();

      // 1. Broadcast updated contest scoreboard to users viewing this contest
      if (contest?.contestId) {
        const contestIdStr = String(contest.contestId);
        const scoreboard = await contestService.getScoreboard(contestIdStr);
        io.to(getContestRoom(contestIdStr)).emit("contest:scoreboard", scoreboard);
      }

      // 2. Broadcast updated global leaderboard to users viewing the leaderboard page
      const leaderboard = await leaderboardService.getGlobalLeaderboard({ page: 1, limit: 50 });
      io.to(GLOBAL_LEADERBOARD_ROOM).emit("leaderboard:update", leaderboard);
    } catch (err) {
      console.error("Socket broadcast failed after submission:", err);
    }
  })();

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

const VERDICTS = [
  "PENDING",
  "RUNNING",
  "ACCEPTED",
  "WRONG_ANSWER",
  "TIME_LIMIT_EXCEEDED",
  "MEMORY_LIMIT_EXCEEDED",
  "RUNTIME_ERROR",
  "COMPILATION_ERROR",
] as const;

type ProblemRef = { id: string; title: string; slug: string; difficulty: string };

const list = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const { problemId, page, limit, verdict, search } = req.query;
  const filter: Record<string, unknown> = { userId: req.user?._id };
  if (problemId) {
    // A repeated ?problemId=a&problemId=b arrives as an array, not a string.
    if (typeof problemId !== "string" || !Types.ObjectId.isValid(problemId)) throw new AppError("problemId is not a valid id.", 400);
    filter.problemId = problemId;
  }
  if (verdict !== undefined) {
    if (typeof verdict !== "string" || !(VERDICTS as readonly string[]).includes(verdict)) throw new AppError("verdict is not a valid verdict.", 400);
    filter.verdict = verdict;
  }
  // Search matches a problem's title, or — when the whole query is a
  // language's name (python, c++, ts…) — the language.
  if (typeof search === "string" && search.trim()) {
    const text = search.trim();
    const problemIds = await ProblemModel.distinct("_id", { title: { $regex: toSearchRegex(text), $options: "i" } });
    const matches: Record<string, unknown>[] = [{ problemId: { $in: problemIds } }];
    const language = LANGUAGE_ALIASES[text.toLowerCase()];
    if (language) matches.push({ language });
    filter.$or = matches;
  }

  // Non-numeric, zero, negative or fractional page/limit values fall back to
  // the defaults (a negative limit used to be clamped to 1 item per page);
  // limit is capped at 100 and page kept small enough for a sane skip().
  const toPositiveInt = (value: unknown, fallback: number, max: number) => {
    const parsed = typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(parsed) && parsed >= 1 ? Math.min(Math.floor(parsed), max) : fallback;
  };
  const safeLimit = toPositiveInt(limit, 20, 100);
  const safePage = toPositiveInt(page, 1, 1_000_000);

  // The history page's summary counts every verdict across the whole
  // history, whatever filter is applied; a single problem's panel in the
  // workspace has no use for them and skips the extra query.
  const countsQuery = problemId
    ? Promise.resolve(null)
    : SubmissionModel.aggregate<{ _id: string; count: number }>([
        { $match: { userId: new Types.ObjectId(String(req.user?._id)) } },
        { $group: { _id: "$verdict", count: { $sum: 1 } } },
      ]);

  const [docs, total, verdictCounts] = await Promise.all([
    SubmissionModel.find(filter)
      .select("problemId language verdict passedTests totalTests runtimeMs score createdAt")
      // _id breaks createdAt ties so an item never repeats on, or vanishes
      // between, adjacent pages.
      .sort({ createdAt: -1, _id: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit),
    SubmissionModel.countDocuments(filter),
    countsQuery,
  ]);

  // Each row names its problem. problemId stays the plain id every existing
  // caller reads; the title rides alongside in `problem`, fetched in one
  // query for the whole page.
  const problemIds = [...new Set(docs.map((doc: { problemId: unknown }) => String(doc.problemId)))];
  const problems = (await ProblemModel.find({ _id: { $in: problemIds } }).select("title slug difficulty").lean()) as unknown as {
    _id: Types.ObjectId;
    title: string;
    slug: string;
    difficulty: string;
  }[];
  const problemById = new Map<string, ProblemRef>(
    problems.map((p) => [String(p._id), { id: String(p._id), title: p.title, slug: p.slug, difficulty: p.difficulty }]),
  );
  const items = docs.map((doc: { problemId: unknown; toJSON: () => Record<string, unknown> }) => ({
    ...doc.toJSON(),
    problem: problemById.get(String(doc.problemId)) ?? null,
  }));

  const counts = verdictCounts ? Object.fromEntries(verdictCounts.map((entry) => [entry._id, entry.count])) : undefined;

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: "Submissions loaded",
    data: { items, total, page: safePage, limit: safeLimit, ...(counts ? { counts } : {}) },
  });
});

export const submissionController = { execute, visualise, submit, getById, list };
