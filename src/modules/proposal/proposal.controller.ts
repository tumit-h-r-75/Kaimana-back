// Controller for problem proposals: learners propose problems from their
// profile, and admins accept them into the library or reject them.

import type { Response } from "express";
import httpStatus from "http-status";
import type { AuthenticatedRequest } from "../../middleware/auth.middleware.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/response.js";
import { proposalService } from "./proposal.service.js";

const getMine = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const result = await proposalService.getMyProposals(String(req.user?._id));
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Proposals loaded", data: result });
});

const create = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const proposal = await proposalService.createProposal(String(req.user?._id), req.body);
  sendResponse(res, { success: true, statusCode: httpStatus.CREATED, message: "Proposal submitted", data: proposal });
});

const getOne = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  // req.user.role was refreshed from the database by requireAuth.
  const proposal = await proposalService.getProposal(String(req.params.id), { userId: String(req.user?._id), role: req.user?.role });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Proposal loaded", data: proposal });
});

const update = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const proposal = await proposalService.updateProposal(String(req.params.id), String(req.user?._id), req.body);
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Proposal updated", data: proposal });
});

const remove = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const result = await proposalService.deleteProposal(String(req.params.id), String(req.user?._id));
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Proposal deleted", data: result });
});

const list = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const { status, page, limit } = req.query;
  const result = await proposalService.listProposals({ status, page, limit });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Proposals loaded", data: result });
});

const review = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const proposal = await proposalService.reviewProposal(String(req.params.id), String(req.user?._id), req.body);
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Proposal reviewed", data: proposal });
});

export const proposalController = { getMine, create, getOne, update, remove, list, review };
