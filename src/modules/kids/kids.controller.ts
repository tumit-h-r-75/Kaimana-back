// Controller for Code Quest (Kids section) progress.

import type { Response } from "express";
import httpStatus from "http-status";
import type { AuthenticatedRequest } from "../../middleware/auth.middleware.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/response.js";
import { kidsService } from "./kids.service.js";

// express.json() only fills req.body for JSON requests, and a JSON body may
// be an array or a primitive — only a plain object can carry `stars`.
const readStars = (body: unknown): unknown =>
  typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).stars : undefined;

// GET /api/kids/progress
const getProgress = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const result = await kidsService.listProgress(String(req.user?._id));
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Kids progress loaded", data: result });
});

// PUT /api/kids/progress/:levelId  { stars: 1 | 2 | 3 }
const saveProgress = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const result = await kidsService.saveLevelProgress(String(req.user?._id), req.params.levelId, readStars(req.body));
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Kids progress saved", data: result });
});

export const kidsController = { getProgress, saveProgress };
