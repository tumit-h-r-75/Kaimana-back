// Controller handling admin dashboard stats and user management endpoints.

import httpStatus from "http-status";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/response.js";
import { AppError } from "../../utils/errors.js";
import { adminService, USER_ROLES, USER_STATUSES } from "./admin.service.js";
import { pulseService } from "./pulse.service.js";
import type { AuthenticatedRequest } from "../../middleware/auth.middleware.js";

// Validates an optional enum field from the query string or JSON body: absent
// stays undefined; anything else (a number, an array from ?role=a&role=b, an
// unknown string) is a 400 rather than reaching the database.
const optionalOneOf = <T extends string>(value: unknown, options: readonly T[], field: string): T | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === "string" && (options as readonly string[]).includes(value)) return value as T;
  throw new AppError(`${field} must be one of: ${options.join(", ")}.`, 400);
};

const stats = catchAsync(async (_req, res) => {
  const result = await adminService.getStats();
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Stats loaded", data: result });
});

// GET /api/admin/stats/pulse
// The same platform, over time: a day-by-day series, what verdicts the judge
// is handing out, the shape of the library and the problems nobody solves.
const pulse = catchAsync(async (_req, res) => {
  const result = await pulseService.getPulse();
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Pulse loaded", data: result });
});

// GET /api/admin/users?page=&limit=&search=&role=
// `role` (user | guest | admin) filters the list; an empty value means all roles.
const listUsers = catchAsync(async (req, res) => {
  const { page, limit, search, role } = req.query;
  const result = await adminService.listUsers({
    page: typeof page === "string" ? Number(page) : undefined,
    limit: typeof limit === "string" ? Number(limit) : undefined,
    search: typeof search === "string" ? search : undefined,
    role: optionalOneOf(role === "" ? undefined : role, USER_ROLES, "role"),
  });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Users loaded", data: result });
});

const updateUser = catchAsync(async (req: AuthenticatedRequest, res) => {
  // A missing or non-object body (no JSON, an array, a string) is treated as
  // empty, so it ends in the service's "Nothing to update." 400, never a 500.
  const body: Record<string, unknown> = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const role = optionalOneOf(body.role, USER_ROLES, "role");
  const status = optionalOneOf(body.status, USER_STATUSES, "status");

  const user = await adminService.updateUser(String(req.params.id), String(req.user?._id), { role, status });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "User updated", data: user });
});

export const adminController = { stats, pulse, listUsers, updateUser };
