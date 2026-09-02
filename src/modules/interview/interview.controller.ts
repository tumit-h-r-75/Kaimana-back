// Controller handling mock interview session lifecycle and dialogue endpoints.

import type { Response } from "express";
import httpStatus from "http-status";
import type { AuthenticatedRequest } from "../../middleware/auth.middleware.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/response.js";
import { AppError } from "../../utils/errors.js";
import { interviewService } from "./interview.service.js";

const start = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const { topic, difficulty, totalQuestions } = req.body as { topic?: string; difficulty?: string; totalQuestions?: number };
  if (!topic?.trim()) throw new AppError("topic is required.", 400);
  if (!difficulty || !["EASY", "MEDIUM", "HARD"].includes(difficulty)) {
    throw new AppError("difficulty is required and must be one of EASY, MEDIUM, HARD.", 400);
  }

  const userId = String(req.user?._id);
  const session = await interviewService.startSession(userId, {
    topic: topic.trim(),
    difficulty: difficulty as "EASY" | "MEDIUM" | "HARD",
    // Clamped server-side in startSession — an omitted, out-of-range, or
    // malformed value here just falls back to the default question count
    // rather than 400ing the whole request.
    totalQuestions,
  });

  sendResponse(res, { success: true, statusCode: httpStatus.CREATED, message: "Interview session started", data: session });
});

const respond = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const { answer } = req.body as { answer?: string };
  if (!answer?.trim()) throw new AppError("answer is required.", 400);

  const userId = String(req.user?._id);
  const session = await interviewService.respond(userId, String(req.params.id), answer.trim());

  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Response recorded", data: session });
});

const list = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const userId = String(req.user?._id);
  const sessions = await interviewService.listSessions(userId);
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Interview sessions loaded", data: sessions });
});

const getOne = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const userId = String(req.user?._id);
  const session = await interviewService.getSession(userId, String(req.params.id));
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Interview session loaded", data: session });
});

export const interviewController = { start, respond, list, getOne };
