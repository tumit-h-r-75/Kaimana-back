// Controller handling user analytics and solve performance metric endpoints.
import type { Response } from "express";
import httpStatus from "http-status";
import type { AuthenticatedRequest } from "../../middleware/auth.middleware.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/response.js";
import { analyticsService } from "./analytics.service.js";

const getMine = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const userId = String(req.user?._id);
  const result = await analyticsService.getMyAnalytics(userId);
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Analytics loaded", data: result });
});

const getHistory = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const userId = String(req.user?._id);
  const days = Number(req.query.days);
  const result = await analyticsService.getMyAnalyticsHistory(userId, Number.isFinite(days) ? days : undefined);
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Analytics history loaded", data: result });
});

export const analyticsController = { getMine, getHistory };
