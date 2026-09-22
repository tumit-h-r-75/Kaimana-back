// Controller for the public community feed — accepted-solution browsing and
// their comment threads.

import httpStatus from "http-status";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/response.js";
import { communityService } from "./community.service.js";
import type { AuthenticatedRequest } from "../../middleware/auth.middleware.js";

const DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;
const LANGUAGES = ["python", "cpp", "javascript", "typescript"] as const;
const SORTS = ["newest", "oldest", "fastest"] as const;

// An unknown value is ignored rather than rejected: these come from a
// shareable URL, and a stale link should still show the feed.
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;

const feed = catchAsync(async (req: AuthenticatedRequest, res) => {
  const { page, limit, search, difficulty, language, sort } = req.query;
  const safePage = Math.max(Number(page) || 1, 1);
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);

  const result = await communityService.getFeed({
    page: safePage,
    limit: safeLimit,
    search: typeof search === "string" ? search : undefined,
    difficulty: oneOf(difficulty, DIFFICULTIES),
    language: oneOf(language, LANGUAGES),
    sort: oneOf(sort, SORTS),
  });
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Community feed loaded", data: result });
});

const detail = catchAsync(async (req: AuthenticatedRequest, res) => {
  const submission = await communityService.getSubmissionDetail(String(req.params.id));
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Submission loaded", data: submission });
});

const comments = catchAsync(async (req, res) => {
  const result = await communityService.listComments(String(req.params.id));
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Comments loaded", data: result });
});

const addComment = catchAsync(async (req: AuthenticatedRequest, res) => {
  const comment = await communityService.addComment(String(req.params.id), String(req.user?._id), String(req.body?.content ?? ""));
  sendResponse(res, { success: true, statusCode: httpStatus.CREATED, message: "Comment posted", data: comment });
});

const deleteComment = catchAsync(async (req: AuthenticatedRequest, res) => {
  await communityService.deleteComment(String(req.params.id), String(req.user?._id), req.user?.role === "admin");
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Comment deleted", data: null });
});

export const communityController = { feed, detail, comments, addComment, deleteComment };
