// Service for contest lifecycle management, registration, and scoreboard logic.

import { Types } from "mongoose";
import { ContestModel, type IContest } from "../../models/Contest.model.js";
import { ContestParticipantModel } from "../../models/ContestParticipant.model.js";
import { ProblemModel } from "../../models/Problem.model.js";
import { SubmissionModel } from "../../models/Submission.model.js";
import { UserModel } from "../../models/User.model.js";
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

  // isPublished: true matches listProblems()/getBySlug() (public browsing) —
  // without this, an unpublished draft attached to a contest rendered as a
  // clickable problem-card link on the contest page (real slug, real title)
  // that 404'd the moment anyone clicked it, since the actual problem page
  // load does filter by isPublished. Now it degrades to the same
  // "(unavailable)" placeholder the frontend already renders for a missing
  // problem, instead of a dead link.
  const problems = await ProblemModel.find({
    _id: { $in: contest.problems.map((entry) => entry.problemId) },
    isPublished: true,
  })
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

// Checks that a submission tagged with this contest may count toward it and
// returns the contest's id. Any well-formed contestId used to be accepted, so
// submissions made before the contest started, after it ended, without
// registering, or for problems outside the contest all landed on its
// scoreboard.
const getSubmissionContext = async (contestId: string, userId: string, problemId: string) => {
  if (!Types.ObjectId.isValid(contestId)) throw new AppError("contestId is not a valid id.", 400);
  const contest = (await ContestModel.findById(contestId).lean()) as unknown as LeanContest | null;
  if (!contest || !contest.isPublished) throw new AppError("Contest not found.", 404);

  const status = getContestStatus(contest);
  if (status === "UPCOMING") throw new AppError("This contest hasn't started yet.", 403);
  if (status === "ENDED") throw new AppError("This contest has ended. Open the problem from the problem list to keep practicing.", 403);
  if (!contest.problems.some((entry) => String(entry.problemId) === problemId)) {
    throw new AppError("This problem is not part of the contest.", 400);
  }
  if (!(await ContestParticipantModel.exists({ contestId: contest._id, userId }))) {
    throw new AppError("Register for the contest before submitting.", 403);
  }

  return { contestId: contest._id };
};

// Scoreboard: for each participant, the best score per contest problem
// (their highest-scoring submission tagged with this contest), summed.
const getScoreboard = async (identifier: string) => {
  const contest = await findContestByIdentifier(identifier);
  if (!contest || !contest.isPublished) throw new AppError("Contest not found.", 404);

  const problemIds = contest.problems.map((entry) => entry.problemId);
  const pointsByProblem = new Map(contest.problems.map((entry) => [String(entry.problemId), entry.points]));
  const problems = (await ProblemModel.find({ _id: { $in: problemIds } })
    .select("basePoints")
    .lean()) as unknown as { _id: Types.ObjectId; basePoints: number }[];
  const basePointsByProblem = new Map(problems.map((problem) => [String(problem._id), problem.basePoints || 100]));

  // Only submissions made during the contest window, for the contest's own
  // problems, count — so the final standings can't change after it ends.
  const rows = (await SubmissionModel.aggregate([
    { $match: { contestId: contest._id, problemId: { $in: problemIds }, createdAt: { $gte: contest.startTime, $lte: contest.endTime } } },
    // Same split as the global leaderboard (see leaderboard.service.ts):
    // bestScore can include partial credit, so "solved" is tracked
    // separately off an actual ACCEPTED verdict rather than off score>0.
    {
      $group: {
        _id: { userId: "$userId", problemId: "$problemId" },
        bestScore: { $max: "$score" },
        solved: { $max: { $cond: [{ $eq: ["$verdict", "ACCEPTED"] }, 1, 0] } },
      },
    },
  ])) as { _id: { userId: Types.ObjectId; problemId: Types.ObjectId }; bestScore: number; solved: number }[];

  // A submission's score is out of the problem's basePoints, but the contest
  // advertises (and admins set) its own points per problem — rescale each
  // best score to those points instead of silently summing basePoints.
  const totals = new Map<string, { totalScore: number; problemsSolved: number }>();
  for (const row of rows) {
    const problemKey = String(row._id.problemId);
    const points = pointsByProblem.get(problemKey) ?? 0;
    const basePoints = basePointsByProblem.get(problemKey) ?? 100;
    const userKey = String(row._id.userId);
    const current = totals.get(userKey) ?? { totalScore: 0, problemsSolved: 0 };
    current.totalScore += Math.round(((row.bestScore ?? 0) / basePoints) * points);
    current.problemsSolved += row.solved;
    totals.set(userKey, current);
  }

  const scoredUserIds = [...totals.entries()].filter(([, total]) => total.totalScore > 0).map(([userId]) => userId);
  const users = (await UserModel.find({ _id: { $in: scoredUserIds } })
    .select("name")
    .lean()) as unknown as { _id: Types.ObjectId; name: string }[];
  const nameById = new Map(users.map((user) => [String(user._id), user.name]));

  const ranked = scoredUserIds
    .filter((userId) => nameById.has(userId))
    .map((userId) => ({ userId, name: nameById.get(userId) as string, ...(totals.get(userId) as { totalScore: number; problemsSolved: number }) }))
    // userId as the final tiebreaker keeps tied ranks stable between loads.
    .sort((a, b) => b.totalScore - a.totalScore || b.problemsSolved - a.problemsSolved || a.userId.localeCompare(b.userId));

  return {
    contestId: String(contest._id),
    entries: ranked.map((entry, index) => ({ rank: index + 1, ...entry })),
  };
};

export const contestService = {
  listContests,
  getContestByIdentifier,
  createContest,
  registerForContest,
  getSubmissionContext,
  getScoreboard,
};
