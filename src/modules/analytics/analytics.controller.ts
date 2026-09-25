// Controller handling user analytics and solve performance metric endpoints.
import type { Response } from "express";
import httpStatus from "http-status";
import type { AuthenticatedRequest } from "../../middleware/auth.middleware.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/response.js";
import { analyticsService } from "./analytics.service.js";
import { insightsService } from "./insights.service.js";

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

// GET /api/analytics/insights?days=30&tz=Asia/Dhaka
// The charts read submissions directly rather than the daily snapshots, so
// a day nobody opened the page still appears. `tz` decides which hour of
// the day a submission falls in; anything unrecognised falls back to UTC.
const getInsights = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const userId = String(req.user?._id);
  const days = Number(req.query.days);
  const result = await insightsService.getMyInsights(userId, {
    days: Number.isFinite(days) ? days : undefined,
    timeZone: insightsService.safeTimeZone(req.query.tz),
  });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Insights loaded", data: result });
});

export const analyticsController = { getMine, getHistory, getInsights };
