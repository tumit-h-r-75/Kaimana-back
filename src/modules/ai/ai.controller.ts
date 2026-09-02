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

  const { problemId, level, code } = req.body as { problemId?: string; level?: number; code?: string };
  if (!problemId) throw new AppError("problemId is required.", 400);

  const result = await hintService.getHint({ userId, problemId, level: level ?? 1, code });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Hint generated", data: result });
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

  const result = await auditService.runComplexityAudit({ userId, submissionId });
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

  const result = await refactorService.generateRefactorSuggestions({ userId, submissionId });
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

export const aiController = { getHint, runAudit, runRefactor, verifyRefactor, generateTests };
