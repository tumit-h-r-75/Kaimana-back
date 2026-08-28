// Service for contest lifecycle management, registration, and scoreboard logic.

import { Types } from "mongoose";
import { ContestModel, type IContest } from "../../models/Contest.model.js";
import { ContestParticipantModel } from "../../models/ContestParticipant.model.js";
import { ProblemModel } from "../../models/Problem.model.js";
import { SubmissionModel } from "../../models/Submission.model.js";
import { AppError } from "../../utils/errors.js";

// mongoose.models.Contest || model<IContest>(...) widens to a loosely-typed
// Model union, so .findOne().lean() needs an explicit cast — same pattern
// used throughout problem.service.ts.
type LeanContest = IContest & { _id: Types.ObjectId };

export type ContestStatus = "UPCOMING" | "ONGOING" | "ENDED";

// Status is derived, never stored, so a contest never needs a background
// job to "start" or "end" it — it's always correct relative to `now`.
export const getContestStatus = (contest: { startTime: Date; endTime: Date }, now = new Date()): ContestStatus => {
  if (now < contest.startTime) return "UPCOMING";
  if (now > contest.endTime) return "ENDED";
  return "ONGOING";
};

const findContestByIdentifier = async (identifier: string) => {
  const filter = Types.ObjectId.isValid(identifier) ? { $or: [{ _id: identifier }, { slug: identifier }] } : { slug: identifier };
  return (await ContestModel.findOne(filter).lean()) as unknown as LeanContest | null;
};

const listContests = async ({ page = 1, limit = 20 }: { page?: number; limit?: number }) => {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const safePage = Math.max(page, 1);

  const [items, total] = (await Promise.all([
    ContestModel.find({ isPublished: true })
      .select("slug title description startTime endTime problems")
      .sort({ startTime: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),
    ContestModel.countDocuments({ isPublished: true }),
  ])) as unknown as [LeanContest[], number];

  const now = new Date();
  return {
    items: items.map((contest) => ({
      id: String(contest._id),
      slug: contest.slug,
      title: contest.title,
      description: contest.description,
      startTime: contest.startTime,
      endTime: contest.endTime,
      problemCount: contest.problems.length,
      status: getContestStatus(contest, now),
    })),
    total,
    page: safePage,
    limit: safeLimit,
  };
};

const getContestByIdentifier = async (identifier: string, userId?: string) => {
  const contest = await findContestByIdentifier(identifier);
  if (!contest || !contest.isPublished) throw new AppError("Contest not found.", 404);

  const problems = await ProblemModel.find({ _id: { $in: contest.problems.map((entry) => entry.problemId) } })
    .select("slug title difficulty")
    .lean();
  const problemById = new Map(problems.map((problem) => [String(problem._id), problem]));

  const isRegistered = userId
    ? Boolean(await ContestParticipantModel.exists({ contestId: contest._id, userId }))
    : false;

  return {
    id: String(contest._id),
    slug: contest.slug,
    title: contest.title,
    description: contest.description,
    startTime: contest.startTime,
    endTime: contest.endTime,
    status: getContestStatus(contest),
    isRegistered,
    problems: contest.problems
      .sort((a, b) => a.order - b.order)
      .map((entry) => {
        const problem = problemById.get(String(entry.problemId));
        return {
          problemId: String(entry.problemId),
          slug: problem?.slug ?? null,
          title: problem?.title ?? "Unknown problem",
          difficulty: problem?.difficulty ?? null,
          points: entry.points,
        };
      }),
  };
};

const createContest = async (
  payload: {
    title: string;
    slug: string;
    description?: string;
    startTime: string | Date;
    endTime: string | Date;
    problems?: { problemId: string; points?: number }[];
  },
  createdBy: string,
) => {
  if (!payload.title?.trim() || !payload.slug?.trim()) throw new AppError("title and slug are required.", 400);
  const startTime = new Date(payload.startTime);
  const endTime = new Date(payload.endTime);
  if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) throw new AppError("startTime and endTime must be valid dates.", 400);
  if (endTime <= startTime) throw new AppError("endTime must be after startTime.", 400);

  const contest = await ContestModel.create({
    title: payload.title.trim(),
    slug: payload.slug.trim().toLowerCase(),
    description: payload.description?.trim() ?? "",
    startTime,
    endTime,
    problems: (payload.problems ?? []).map((entry, index) => ({
      problemId: entry.problemId,
      points: entry.points ?? 100,
      order: index,
    })),
    createdBy,
  });

  return contest;
};

const registerForContest = async (identifier: string, userId: string) => {
  const contest = await findContestByIdentifier(identifier);
  if (!contest || !contest.isPublished) throw new AppError("Contest not found.", 404);
  if (getContestStatus(contest) === "ENDED") throw new AppError("This contest has already ended.", 400);

  await ContestParticipantModel.findOneAndUpdate(
    { contestId: contest._id, userId },
    { $setOnInsert: { contestId: contest._id, userId, registeredAt: new Date() } },
    { upsert: true, new: true },
  );

  return { registered: true };
};

// Scoreboard: for each participant, the best score per contest problem
// (their highest-scoring submission tagged with this contest), summed —
// identical shape to the global leaderboard, just scoped to one contest.
const getScoreboard = async (identifier: string) => {
  const contest = await findContestByIdentifier(identifier);
  if (!contest || !contest.isPublished) throw new AppError("Contest not found.", 404);

  const rows = await SubmissionModel.aggregate([
    { $match: { contestId: contest._id } },
    { $group: { _id: { userId: "$userId", problemId: "$problemId" }, bestScore: { $max: "$score" } } },
    { $group: { _id: "$_id.userId", totalScore: { $sum: "$bestScore" }, problemsSolved: { $sum: { $cond: [{ $gt: ["$bestScore", 0] }, 1, 0] } } } },
    { $match: { totalScore: { $gt: 0 } } },
    { $sort: { totalScore: -1, problemsSolved: -1 } },
    { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "user" } },
    { $unwind: "$user" },
    { $project: { _id: 0, userId: "$_id", totalScore: 1, problemsSolved: 1, name: "$user.name" } },
  ]);

  return {
    contestId: String(contest._id),
    entries: rows.map((row, index) => ({
      rank: index + 1,
      userId: String(row.userId),
      name: row.name,
      totalScore: row.totalScore,
      problemsSolved: row.problemsSolved,
    })),
  };
};

export const contestService = {
  listContests,
  getContestByIdentifier,
  createContest,
  registerForContest,
  getScoreboard,
};
