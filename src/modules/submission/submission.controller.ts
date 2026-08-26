import type { Response } from "express";
import { executeCode } from "../../integrations/piston/piston.service.js";
import type { AuthenticatedRequest } from "../../middleware/auth.middleware.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/response.js";

const recentExecutions = new Map<string, number[]>();
const execute = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const userId = String(req.user?._id);
  const now = Date.now();
  const requests = (recentExecutions.get(userId) ?? []).filter((time) => now - time < 60_000);
  if (requests.length >= 10) return res.status(429).json({ success: false, message: "Execution limit reached. Try again in a minute." });
  recentExecutions.set(userId, [...requests, now]);
  const result = await executeCode(req.body);
  sendResponse(res, { success: true, statusCode: 200, message: "Code executed", data: result });
});
export const submissionController = { execute };
