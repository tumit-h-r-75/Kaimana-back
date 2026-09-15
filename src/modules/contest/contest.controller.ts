// Controller handling contest management, registration, and scoreboard endpoints.
import type { Response } from "express";
import httpStatus from "http-status";
import type { AuthenticatedRequest } from "../../middleware/auth.middleware.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/response.js";
import { contestService, type ContestManager } from "./contest.service.js";

// requireAuth refreshes role from the database on every request, so this is
// the caller's current role rather than the one baked into their token.
const toManager = (req: AuthenticatedRequest): ContestManager => ({ userId: String(req.user?._id), role: String(req.user?.role) });

const list = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const { page = "1", limit = "20" } = req.query as Record<string, string>;
  const result = await contestService.listContests({ page: Number(page), limit: Number(limit) });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Contests loaded", data: result });
});

const getByIdentifier = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const contest = await contestService.getContestByIdentifier(String(req.params.identifier), req.user?._id ? String(req.user._id) : undefined);
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Contest loaded", data: contest });
});

const create = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const contest = await contestService.createContest(req.body, toManager(req));
  sendResponse(res, { success: true, statusCode: httpStatus.CREATED, message: "Contest created", data: contest });
});

const register = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const result = await contestService.registerForContest(String(req.params.identifier), String(req.user?._id));
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Registered for contest", data: result });
});

const getScoreboard = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const result = await contestService.getScoreboard(String(req.params.identifier));
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Scoreboard loaded", data: result });
});

const listManaged = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const { page, limit, search } = req.query;
  const result = await contestService.listManagedContests(toManager(req), { page, limit, search });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Contests loaded", data: result });
});

const getManaged = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const contest = await contestService.getManagedContest(String(req.params.id), toManager(req));
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Contest loaded", data: contest });
});

const updateManaged = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const contest = await contestService.updateManagedContest(String(req.params.id), toManager(req), req.body);
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Contest updated", data: contest });
});

const deleteManaged = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const result = await contestService.deleteManagedContest(String(req.params.id), toManager(req));
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Contest deleted", data: result });
});

export const contestController = {
  list,
  getByIdentifier,
  create,
  register,
  getScoreboard,
  listManaged,
  getManaged,
  updateManaged,
  deleteManaged,
};
