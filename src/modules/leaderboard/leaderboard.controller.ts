// Controller handling global user ranking requests.
import type { Response } from "express";
import httpStatus from "http-status";
import type { AuthenticatedRequest } from "../../middleware/auth.middleware.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/response.js";
import { leaderboardService } from "./leaderboard.service.js";

const getGlobal = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const { page = "1", limit = "20" } = req.query as Record<string, string>;
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);

  const result = await leaderboardService.getGlobalLeaderboard({ page: safePage, limit: safeLimit });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Leaderboard loaded", data: result });
});

const getMyRank = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const userId = String(req.user?._id);
  const result = await leaderboardService.getMyRank(userId);
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Rank loaded", data: result });
});

export const leaderboardController = { getGlobal, getMyRank };
