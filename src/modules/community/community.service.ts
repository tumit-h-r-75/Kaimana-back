// Service backing the public community feed — every ACCEPTED submission is
// automatically visible here (there is no "share/make public" toggle, this
// mirrors how Codeforces/LeetCode public solution feeds work) — plus the
// comment thread (ReviewModel) attached to each one.

import { SubmissionModel } from "../../models/Submission.model.js";
import { ReviewModel } from "../../models/Review.model.js";
import { AppError } from "../../utils/errors.js";

const NOT_FOUND_MESSAGE = "This submission isn't available in the community.";

type PopulatedAuthor = { _id: unknown; name: string; profilePicUrl?: string } | null | undefined;
type PopulatedProblem = { _id: unknown; title: string; slug: string; difficulty: string } | null | undefined;

const toAuthor = (userId: PopulatedAuthor) => {
  if (!userId || typeof userId !== "object") return null;
  return { id: String(userId._id), name: userId.name, profilePicUrl: userId.profilePicUrl };
};

const toProblem = (problemId: PopulatedProblem) => {
  if (!problemId || typeof problemId !== "object") return null;
  return { id: String(problemId._id), title: problemId.title, slug: problemId.slug, difficulty: problemId.difficulty };
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

export const getFeed = async ({ page, limit }: { page: number; limit: number }) => {
  const skip = (page - 1) * limit;

  const [submissions, total] = await Promise.all([
    SubmissionModel.find({ verdict: "ACCEPTED" })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("userId", "name profilePicUrl")
      .populate("problemId", "title slug difficulty"),
    SubmissionModel.countDocuments({ verdict: "ACCEPTED" }),
  ]);

  const items = await Promise.all(
    submissions.map(async (submission) => {
      const commentCount = await ReviewModel.countDocuments({ submissionId: submission._id });
      return toFeedItem(submission, commentCount);
    }),
  );

  return { items, total, page, limit };
};

// Fetches a submission and guarantees it's a valid, community-visible
// (ACCEPTED) one — used by both the detail page and comment endpoints.
// Missing and non-ACCEPTED submissions are deliberately reported the same
// way (a 404) so a caller can't probe which submission ids exist.
const getAcceptedSubmissionOrThrow = async (submissionId: string) => {
  const submission = await SubmissionModel.findById(submissionId)
    .populate("userId", "name profilePicUrl")
    .populate("problemId", "title slug difficulty");

  if (!submission || submission.verdict !== "ACCEPTED") {
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
  const reviews = await ReviewModel.find({ submissionId }).sort({ createdAt: 1 }).populate("userId", "name profilePicUrl");
  return reviews.map(toCommentDto);
};

export const addComment = async (submissionId: string, userId: string, content: string) => {
  const trimmed = content?.trim() ?? "";
  if (!trimmed) throw new AppError("Comment cannot be empty.", 400);

  // Reuse the same "exists and is ACCEPTED" guard as the detail page.
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
