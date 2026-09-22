// Service backing the public community feed — every ACCEPTED submission is
// automatically visible here (there is no "share/make public" toggle, this
// mirrors how Codeforces/LeetCode public solution feeds work) — plus the
// comment thread (ReviewModel) attached to each one. The one exception is
// code that would give away a contest still in progress — see
// getCommunityVisibleFilter below.

import { Types } from "mongoose";
import { SubmissionModel } from "../../models/Submission.model.js";
import { ReviewModel } from "../../models/Review.model.js";
import { ContestModel } from "../../models/Contest.model.js";
import { ProblemModel } from "../../models/Problem.model.js";
import { UserModel } from "../../models/User.model.js";
import { AppError } from "../../utils/errors.js";
import { toSearchRegex } from "../../utils/search.js";

const NOT_FOUND_MESSAGE = "This submission isn't available in the community.";

type PopulatedAuthor = { _id: unknown; name: string; profilePicUrl?: string } | null | undefined;
type PopulatedProblem = { _id: unknown; title: string; slug: string; difficulty: string; tags?: string[] } | null | undefined;

const toAuthor = (userId: PopulatedAuthor) => {
  if (!userId || typeof userId !== "object") return null;
  return { id: String(userId._id), name: userId.name, profilePicUrl: userId.profilePicUrl };
};

const toProblem = (problemId: PopulatedProblem) => {
  if (!problemId || typeof problemId !== "object") return null;
  return {
    id: String(problemId._id),
    title: problemId.title,
    slug: problemId.slug,
    difficulty: problemId.difficulty,
    // Only populated on the feed, where a card picks its icon from them.
    ...(problemId.tags ? { tags: problemId.tags } : {}),
  };
};

// Shared shape for a feed card and a detail page's summary section.
const toFeedItem = (submission: any, commentCount: number) => ({
  id: String(submission._id),
  language: submission.language,
  verdict: submission.verdict,
  score: submission.score,
  runtimeMs: submission.runtimeMs,
  createdAt: submission.createdAt,
  author: toAuthor(submission.userId as PopulatedAuthor),
  problem: toProblem(submission.problemId as PopulatedProblem),
  commentCount,
});

// Publishing every ACCEPTED solution the moment it's judged would hand live
// contest answers to anyone watching the feed. A submission stays hidden
// while (a) the contest it was submitted to hasn't ended yet, or (b) its
// problem belongs to a published contest that is running right now — which
// also covers a practice-mode solve of a problem currently in a contest.
// Recomputed against the clock on every request, so hidden code reappears
// on its own once the contest is over.
const getCommunityVisibleFilter = async () => {
  const now = new Date();
  const [unfinishedContestIds, liveContestProblemIds] = await Promise.all([
    ContestModel.distinct("_id", { endTime: { $gt: now } }),
    ContestModel.distinct("problems.problemId", { isPublished: true, startTime: { $lte: now }, endTime: { $gt: now } }),
  ]);
  return {
    verdict: "ACCEPTED",
    contestId: { $nin: unfinishedContestIds },
    problemId: { $nin: liveContestProblemIds },
  };
};

export type FeedSort = "newest" | "oldest" | "fastest";

export interface FeedQuery {
  page: number;
  limit: number;
  /** Matched against the problem's title and the solver's name. */
  search?: string;
  difficulty?: "EASY" | "MEDIUM" | "HARD";
  language?: "python" | "cpp" | "javascript" | "typescript";
  sort?: FeedSort;
}

const SORTS: Record<FeedSort, Record<string, 1 | -1>> = {
  newest: { createdAt: -1, _id: -1 },
  oldest: { createdAt: 1, _id: 1 },
  fastest: { runtimeMs: 1, createdAt: -1, _id: -1 },
};

export const getFeed = async ({ page, limit, search, difficulty, language, sort = "newest" }: FeedQuery) => {
  const skip = (page - 1) * limit;
  const visibleFilter = await getCommunityVisibleFilter();

  // The visibility rule already constrains problemId, so every narrowing is
  // added under $and rather than merged into the same keys.
  const conditions: Record<string, unknown>[] = [visibleFilter];
  if (difficulty) {
    conditions.push({ problemId: { $in: await ProblemModel.distinct("_id", { difficulty }) } });
  }
  if (language) conditions.push({ language });
  if (search?.trim()) {
    const pattern = { $regex: toSearchRegex(search), $options: "i" };
    const [problemIds, userIds] = await Promise.all([
      ProblemModel.distinct("_id", { title: pattern }),
      UserModel.distinct("_id", { name: pattern }),
    ]);
    conditions.push({ $or: [{ problemId: { $in: problemIds } }, { userId: { $in: userIds } }] });
  }
  const filter = conditions.length === 1 ? visibleFilter : { $and: conditions };

  const [submissions, total] = await Promise.all([
    SubmissionModel.find(filter)
      .sort(SORTS[sort])
      .skip(skip)
      .limit(limit)
      .populate("userId", "name profilePicUrl")
      .populate("problemId", "title slug difficulty tags"),
    SubmissionModel.countDocuments(filter),
  ]);

  const items = await Promise.all(
    submissions.map(async (submission) => {
      const commentCount = await ReviewModel.countDocuments({ submissionId: submission._id });
      return toFeedItem(submission, commentCount);
    }),
  );

  return { items, total, page, limit };
};

// Fetches a submission and guarantees it's a valid, community-visible one
// (ACCEPTED and not hidden by a live contest) — used by both the detail page
// and comment endpoints. Missing, non-ACCEPTED and contest-hidden
// submissions are deliberately reported the same way (a 404) so a caller
// can't probe which submission ids exist.
const getAcceptedSubmissionOrThrow = async (submissionId: string) => {
  if (!Types.ObjectId.isValid(submissionId)) throw new AppError(NOT_FOUND_MESSAGE, 404);

  const submission = await SubmissionModel.findOne({ ...(await getCommunityVisibleFilter()), _id: submissionId })
    .populate("userId", "name profilePicUrl")
    .populate("problemId", "title slug difficulty");

  if (!submission) {
    throw new AppError(NOT_FOUND_MESSAGE, 404);
  }

  return submission;
};

export const getSubmissionDetail = async (submissionId: string) => {
  const submission = await getAcceptedSubmissionOrThrow(submissionId);
  const commentCount = await ReviewModel.countDocuments({ submissionId: submission._id });
  return { ...toFeedItem(submission, commentCount), code: submission.code };
};

const toCommentDto = (review: any) => ({
  id: String(review._id),
  content: review.content,
  createdAt: review.createdAt,
  author: toAuthor(review.userId as PopulatedAuthor),
});

export const listComments = async (submissionId: string) => {
  // Same visibility guard as the detail page — a thread on a hidden
  // submission can quote or discuss its code, so it's hidden too.
  await getAcceptedSubmissionOrThrow(submissionId);

  const reviews = await ReviewModel.find({ submissionId }).sort({ createdAt: 1 }).populate("userId", "name profilePicUrl");
  return reviews.map(toCommentDto);
};

export const addComment = async (submissionId: string, userId: string, content: string) => {
  const trimmed = content?.trim() ?? "";
  if (!trimmed) throw new AppError("Comment cannot be empty.", 400);

  // Reuse the same "exists and is visible" guard as the detail page.
  await getAcceptedSubmissionOrThrow(submissionId);

  const review = await ReviewModel.create({ submissionId, userId, content: trimmed });
  const populated = await review.populate("userId", "name profilePicUrl");
  return toCommentDto(populated);
};

export const deleteComment = async (commentId: string, userId: string, isAdmin: boolean) => {
  const comment = await ReviewModel.findById(commentId);
  if (!comment) throw new AppError("Comment not found.", 404);
  if (String(comment.userId) !== userId && !isAdmin) {
    throw new AppError("You can only delete your own comments.", 403);
  }
  await comment.deleteOne();
};

export const communityService = {
  getFeed,
  getSubmissionDetail,
  listComments,
  addComment,
  deleteComment,
};
