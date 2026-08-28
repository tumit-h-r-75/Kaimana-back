// Controller handling admin dashboard stats and user management endpoints.

import httpStatus from "http-status";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/response.js";
import { adminService } from "./admin.service.js";
import type { AuthenticatedRequest } from "../../middleware/auth.middleware.js";

const stats = catchAsync(async (_req, res) => {
  const result = await adminService.getStats();
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Stats loaded", data: result });
});

const listUsers = catchAsync(async (req, res) => {
  const { page, limit, search } = req.query;
  const result = await adminService.listUsers({
    page: page ? Number(page) : undefined,
    limit: limit ? Number(limit) : undefined,
    search: typeof search === "string" ? search : undefined,
  });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Users loaded", data: result });
});

const updateUser = catchAsync(async (req: AuthenticatedRequest, res) => {
  const user = await adminService.updateUser(String(req.params.id), String(req.user?._id), req.body);
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "User updated", data: user });
});

export const adminController = { stats, listUsers, updateUser };
