// Controller handling "host a contest" requests and their admin review.

import type { Response } from "express";
import httpStatus from "http-status";
import type { AuthenticatedRequest } from "../../middleware/auth.middleware.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/response.js";
import { hostService } from "./host.service.js";

const create = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const request = await hostService.createRequest(String(req.user?._id), req.body);
  sendResponse(res, { success: true, statusCode: httpStatus.CREATED, message: "Host request submitted", data: request });
});

const getMine = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  // req.user.role was refreshed from the database by requireAuth.
  const result = await hostService.getMyRequest(String(req.user?._id), req.user?.role);
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Host request loaded", data: result });
});

const list = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const { status, page, limit } = req.query;
  const result = await hostService.listRequests({ status, page, limit });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Host requests loaded", data: result });
});

const review = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const request = await hostService.reviewRequest(String(req.params.id), String(req.user?._id), req.body);
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Host request reviewed", data: request });
});

export const hostController = { create, getMine, list, review };
