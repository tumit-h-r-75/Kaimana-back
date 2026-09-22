// Controller for the signed-in user's notifications.

import httpStatus from "http-status";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/response.js";
import type { AuthenticatedRequest } from "../../middleware/auth.middleware.js";
import { notificationService } from "./notification.service.js";

const list = catchAsync(async (req: AuthenticatedRequest, res) => {
  const limit = Number(req.query.limit) || 20;
  const result = await notificationService.listForUser(String(req.user?._id), limit);
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Notifications loaded", data: result });
});

const markSeen = catchAsync(async (req: AuthenticatedRequest, res) => {
  const result = await notificationService.markSeen(String(req.user?._id));
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Notifications marked as seen", data: result });
});

export const notificationController = { list, markSeen };
