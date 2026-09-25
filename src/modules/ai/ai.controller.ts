// Controller handling AI features such as hints, complexity audits, and refactor suggestions.
import type { Response } from "express";
import httpStatus from "http-status";
import type { AuthenticatedRequest } from "../../middleware/auth.middleware.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/response.js";
import { AppError } from "../../utils/errors.js";
import { hintService } from "./hint.service.js";
import { auditService } from "./audit.service.js";
import { refactorService } from "./refactor.service.js";
import { testgenService } from "./testgen.service.js";
import { explainService } from "./explain.service.js";
import { followUpService } from "./followUp.service.js";
import { explainSolutionService } from "./explainSolution.service.js";
import { proposalReviewService } from "./proposalReview.service.js";
import { codeQualityService } from "./codeQuality.service.js";
import { resolveAiLanguage } from "./aiLanguage.js";

// A learner asking for hints repeatedly in a short window is expected
// behavior, but this keeps a single user from hammering the Gemini API.
const recentHintRequests = new Map<string, number[]>();
const HINT_LIMIT_PER_MINUTE = 15;

// A complexity audit runs several Judge0 executions per request (see
// audit.service.ts's sampled test cases), so this stays much stricter
// than the hint limiter above. A cached (already-audited) submission
// never actually re-runs Judge0, but the limiter is applied before that
// check so it still bounds the worst case of a user hitting many
// different, never-audited submissions in a row.
const recentAuditRequests = new Map<string, number[]>();
const AUDIT_LIMIT_PER_MINUTE = 5;

// Refactor suggestions also cost a real Gemini call (a larger one — full
// rewritten source, up to 3 suggestions), so it gets its own conservative
// limiter, same shape as the audit one above. Verification re-runs Judge0
// rather than Gemini, so it is limited separately and a bit more loosely.
const recentRefactorRequests = new Map<string, number[]>();
const REFACTOR_LIMIT_PER_MINUTE = 5;
const recentVerifyRequests = new Map<string, number[]>();
const VERIFY_LIMIT_PER_MINUTE = 10;

// Admin-only (see ai.route.ts's requireAdmin) and runs up to MAX_GENERATED
// Judge0 executions plus a Gemini call per request, so this stays tight —
// there's no learner-scale traffic to accommodate here.
const recentGenerateTestsRequests = new Map<string, number[]>();
const GENERATE_TESTS_LIMIT_PER_MINUTE = 3;

const getHint = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const userId = String(req.user?._id);
  const now = Date.now();
  const requests = (recentHintRequests.get(userId) ?? []).filter((time) => now - time < 60_000);
  if (requests.length >= HINT_LIMIT_PER_MINUTE) {
    throw new AppError("Too many hint requests. Try again in a minute.", 429);
  }
  recentHintRequests.set(userId, [...requests, now]);

  const { problemId, level, code, language } = req.body as { problemId?: string; level?: number; code?: string; language?: string };
  if (!problemId) throw new AppError("problemId is required.", 400);

  // role comes from requireAuth's live user lookup — admins may request
  // hints on unpublished drafts, everyone else gets a 404 for them.
  const result = await hintService.getHint({ userId, problemId, level: level ?? 1, code, role: req.user?.role, language: resolveAiLanguage(language) });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Hint generated", data: result });
});

// Reading an explanation of your own failure is cheap for us and the most
// common thing anyone will do after a red verdict, so the limit is the
// hint limiter's, not the audit one's.
const recentExplainRequests = new Map<string, number[]>();
const EXPLAIN_LIMIT_PER_MINUTE = 10;

const explainFailure = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const userId = String(req.user?._id);
  const now = Date.now();
  const requests = (recentExplainRequests.get(userId) ?? []).filter((time) => now - time < 60_000);
  if (requests.length >= EXPLAIN_LIMIT_PER_MINUTE) {
    throw new AppError("Too many requests. Try again in a minute.", 429);
  }
  recentExplainRequests.set(userId, [...requests, now]);

  const { submissionId, language } = req.body as { submissionId?: string; language?: string };
  if (!submissionId) throw new AppError("submissionId is required.", 400);

  const result = await explainService.explainFailure({ userId, submissionId, language: resolveAiLanguage(language) });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Failure explained", data: result });
});

// Two model calls per set of questions at most, and answering is the slow
// part, so this sits between the hint limiter and the audit one.
const recentFollowUpRequests = new Map<string, number[]>();
const FOLLOW_UP_LIMIT_PER_MINUTE = 8;

const guardFollowUps = (userId: string) => {
  const now = Date.now();
  const requests = (recentFollowUpRequests.get(userId) ?? []).filter((time) => now - time < 60_000);
  if (requests.length >= FOLLOW_UP_LIMIT_PER_MINUTE) throw new AppError("Too many requests. Try again in a minute.", 429);
  recentFollowUpRequests.set(userId, [...requests, now]);
};

const askFollowUps = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const userId = String(req.user?._id);
  guardFollowUps(userId);
  const { submissionId, language } = req.body as { submissionId?: string; language?: string };
  if (!submissionId) throw new AppError("submissionId is required.", 400);
  const result = await followUpService.askFollowUps({ userId, submissionId, language: resolveAiLanguage(language) });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Follow-up questions", data: result });
});

const markFollowUp = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const userId = String(req.user?._id);
  guardFollowUps(userId);
  const { submissionId, question, answer, language } = req.body as {
    submissionId?: string;
    question?: string;
    answer?: string;
    language?: string;
  };
  if (!submissionId) throw new AppError("submissionId is required.", 400);
  const result = await followUpService.markFollowUp({ userId, submissionId, question, answer, language: resolveAiLanguage(language) });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Answer marked", data: result });
});

const explainSolution = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const userId = String(req.user?._id);
  const now = Date.now();
  const requests = (recentExplainRequests.get(userId) ?? []).filter((time) => now - time < 60_000);
  if (requests.length >= EXPLAIN_LIMIT_PER_MINUTE) {
    throw new AppError("Too many requests. Try again in a minute.", 429);
  }
  recentExplainRequests.set(userId, [...requests, now]);

  const { submissionId, language } = req.body as { submissionId?: string; language?: string };
  if (!submissionId) throw new AppError("submissionId is required.", 400);

  const result = await explainSolutionService.explainSolution({ userId, submissionId, language: resolveAiLanguage(language) });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Solution explained", data: result });
});

// A draft review is one long model call, and an author will run it a few
// times as they edit — often enough to want its own modest limit.
const recentProposalReviews = new Map<string, number[]>();
const PROPOSAL_REVIEW_LIMIT_PER_MINUTE = 4;

const reviewProposalDraft = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const userId = String(req.user?._id);
  const now = Date.now();
  const requests = (recentProposalReviews.get(userId) ?? []).filter((time) => now - time < 60_000);
  if (requests.length >= PROPOSAL_REVIEW_LIMIT_PER_MINUTE) {
    throw new AppError("Too many reviews. Try again in a minute.", 429);
  }
  recentProposalReviews.set(userId, [...requests, now]);

  const { title, statement, constraints, difficulty, testCases, language } = req.body as Record<string, unknown>;
  const result = await proposalReviewService.reviewProposalDraft({
    title,
    statement,
    constraints,
    difficulty,
    testCases,
    language: resolveAiLanguage(language),
  });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Draft reviewed", data: result });
});

const scoreCodeQuality = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const userId = String(req.user?._id);
  const now = Date.now();
  const requests = (recentExplainRequests.get(userId) ?? []).filter((time) => now - time < 60_000);
  if (requests.length >= EXPLAIN_LIMIT_PER_MINUTE) throw new AppError("Too many requests. Try again in a minute.", 429);
  recentExplainRequests.set(userId, [...requests, now]);

  const { submissionId, language } = req.body as { submissionId?: string; language?: string };
  if (!submissionId) throw new AppError("submissionId is required.", 400);
  const result = await codeQualityService.scoreSubmission({ userId, submissionId, language: resolveAiLanguage(language) });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Code reviewed", data: result });
});

const codeQualityHistory = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const result = await codeQualityService.qualityHistory(String(req.user?._id));
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Code quality over time", data: result });
});

const runAudit = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const userId = String(req.user?._id);
  const now = Date.now();
  const requests = (recentAuditRequests.get(userId) ?? []).filter((time) => now - time < 60_000);
  if (requests.length >= AUDIT_LIMIT_PER_MINUTE) {
    throw new AppError("Too many complexity audit requests. Try again in a minute.", 429);
  }
  recentAuditRequests.set(userId, [...requests, now]);

  const { submissionId } = req.body as { submissionId?: string };
  if (!submissionId) throw new AppError("submissionId is required.", 400);

  const result = await auditService.runComplexityAudit({ userId, submissionId, language: resolveAiLanguage((req.body as { language?: string }).language) });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Complexity audit complete", data: result });
});

const runRefactor = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const userId = String(req.user?._id);
  const now = Date.now();
  const requests = (recentRefactorRequests.get(userId) ?? []).filter((time) => now - time < 60_000);
  if (requests.length >= REFACTOR_LIMIT_PER_MINUTE) {
    throw new AppError("Too many refactor requests. Try again in a minute.", 429);
  }
  recentRefactorRequests.set(userId, [...requests, now]);

  const { submissionId } = req.body as { submissionId?: string };
  if (!submissionId) throw new AppError("submissionId is required.", 400);

  const result = await refactorService.generateRefactorSuggestions({ userId, submissionId, language: resolveAiLanguage((req.body as { language?: string }).language) });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Refactor suggestions generated", data: result });
});

const verifyRefactor = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const userId = String(req.user?._id);
  const now = Date.now();
  const requests = (recentVerifyRequests.get(userId) ?? []).filter((time) => now - time < 60_000);
  if (requests.length >= VERIFY_LIMIT_PER_MINUTE) {
    throw new AppError("Too many verification requests. Try again in a minute.", 429);
  }
  recentVerifyRequests.set(userId, [...requests, now]);

  const { submissionId, suggestionIndex } = req.body as { submissionId?: string; suggestionIndex?: number };
  if (!submissionId) throw new AppError("submissionId is required.", 400);
  if (typeof suggestionIndex !== "number") throw new AppError("suggestionIndex is required.", 400);

  const result = await refactorService.verifyRefactorSuggestion({ userId, submissionId, suggestionIndex });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Refactor suggestion verified", data: result });
});

const generateTests = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const userId = String(req.user?._id);
  const now = Date.now();
  const requests = (recentGenerateTestsRequests.get(userId) ?? []).filter((time) => now - time < 60_000);
  if (requests.length >= GENERATE_TESTS_LIMIT_PER_MINUTE) {
    throw new AppError("Too many test-generation requests. Try again in a minute.", 429);
  }
  recentGenerateTestsRequests.set(userId, [...requests, now]);

  const { problemId } = req.body as { problemId?: string };
  if (!problemId) throw new AppError("problemId is required.", 400);

  const result = await testgenService.generateTestCases({ problemId });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Test cases generated", data: result });
});

export const aiController = {
  getHint,
  explainFailure,
  explainSolution,
  reviewProposalDraft,
  scoreCodeQuality,
  codeQualityHistory,
  askFollowUps,
  markFollowUp,
  runAudit,
  runRefactor,
  verifyRefactor,
  generateTests,
};
