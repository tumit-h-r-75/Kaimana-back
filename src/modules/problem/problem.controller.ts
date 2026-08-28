// Controller handling problem CRUD operations, search filtering, and approval.

import httpStatus from "http-status";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/response.js";
import { problemService } from "./problem.service.js";
import { testCaseService } from "./testcase.service.js";
import type { AuthenticatedRequest } from "../../middleware/auth.middleware.js";

const list = catchAsync(async (req: AuthenticatedRequest, res) => {
  const { difficulty, tags, search, page, limit } = req.query;
  const result = await problemService.listProblems({
    difficulty: typeof difficulty === "string" ? difficulty : undefined,
    tags: typeof tags === "string" ? tags : undefined,
    search: typeof search === "string" ? search : undefined,
    page: page ? Number(page) : undefined,
    limit: limit ? Number(limit) : undefined,
    userId: req.user?._id ? String(req.user._id) : undefined,
  });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Problems loaded", data: result });
});

const getBySlug = catchAsync(async (req: AuthenticatedRequest, res) => {
  const problem = await problemService.getProblemBySlug(String(req.params.slug), req.user?._id ? String(req.user._id) : undefined);
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Problem loaded", data: problem });
});

const create = catchAsync(async (req: AuthenticatedRequest, res) => {
  const problem = await problemService.createProblem({ ...req.body, createdBy: req.user?._id });
  sendResponse(res, { success: true, statusCode: httpStatus.CREATED, message: "Problem created", data: problem });
});

const update = catchAsync(async (req, res) => {
  const problem = await problemService.updateProblem(String(req.params.id), req.body);
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Problem updated", data: problem });
});

const addTestCases = catchAsync(async (req, res) => {
  const testCases = Array.isArray(req.body.testCases) ? req.body.testCases : [req.body];
  const created = await testCaseService.addManyTestCases(String(req.params.id), testCases);
  sendResponse(res, { success: true, statusCode: httpStatus.CREATED, message: "Test cases added", data: created });
});

const listTestCases = catchAsync(async (req, res) => {
  const testCases = await testCaseService.listTestCasesForAdmin(String(req.params.id));
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Test cases loaded", data: testCases });
});

const updateTestCase = catchAsync(async (req, res) => {
  const testCase = await testCaseService.updateTestCase(String(req.params.testCaseId), req.body);
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Test case updated", data: testCase });
});

const deleteTestCase = catchAsync(async (req, res) => {
  await testCaseService.deleteTestCase(String(req.params.testCaseId));
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Test case deleted", data: null });
});

const listAllForAdmin = catchAsync(async (req, res) => {
  const { page, limit, search } = req.query;
  const result = await problemService.listAllForAdmin({
    page: page ? Number(page) : undefined,
    limit: limit ? Number(limit) : undefined,
    search: typeof search === "string" ? search : undefined,
  });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Problems loaded", data: result });
});

const getByIdForAdmin = catchAsync(async (req, res) => {
  const problem = await problemService.getProblemByIdForAdmin(String(req.params.id));
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Problem loaded", data: problem });
});

const deleteProblem = catchAsync(async (req, res) => {
  await problemService.deleteProblem(String(req.params.id));
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Problem deleted", data: null });
});

export const problemController = {
  list,
  getBySlug,
  create,
  update,
  addTestCases,
  listTestCases,
  updateTestCase,
  deleteTestCase,
  listAllForAdmin,
  getByIdForAdmin,
  deleteProblem,
};
