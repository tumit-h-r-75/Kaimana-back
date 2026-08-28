// Controller handling AI features such as hints, complexity audits, and refactor suggestions.
import type { Response } from "express";
import httpStatus from "http-status";
import type { AuthenticatedRequest } from "../../middleware/auth.middleware.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/response.js";
import { AppError } from "../../utils/errors.js";
import { hintService } from "./hint.service.js";

// A learner asking for hints repeatedly in a short window is expected
// behavior, but this keeps a single user from hammering the Claude API.
const recentHintRequests = new Map<string, number[]>();
const HINT_LIMIT_PER_MINUTE = 15;

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

  const result = await hintService.getHint({ problemId, level: level ?? 1, code });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Hint generated", data: result });
});

export const aiController = { getHint };
