// What one solver's page shows to everyone else.
//
// Everything here is already public somewhere on the site — the leaderboard
// knows the rank, the community feed carries the accepted code — this only
// gathers it in one place, under a name you can link to. Nothing private
// goes in: no email, no failed attempts, no contest work while its contest
// is still running (the community's own visibility rule decides that, and is
// reused rather than restated).

import { Types } from "mongoose";
import { UserModel } from "../../models/User.model.js";
import { SubmissionModel } from "../../models/Submission.model.js";
import { ProblemModel } from "../../models/Problem.model.js";
import { ReviewModel } from "../../models/Review.model.js";
import { AppError } from "../../utils/errors.js";
import { leaderboardService } from "../leaderboard/leaderboard.service.js";
import { communityService } from "../community/community.service.js";

const DAY = 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 6;
const STREAK_WINDOW_DAYS = 90;

const dayKey = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Days in a row with at least one accepted solution, counting back from
 * today. Yesterday still counts as alive — a streak should not break just
 * because it is early in the day somewhere.
 */
const streakFrom = (days: Set<string>) => {
  const now = Date.now();
  if (!days.has(dayKey(new Date(now))) && !days.has(dayKey(new Date(now - DAY)))) return 0;
  let streak = 0;
  for (let offset = 0; offset < STREAK_WINDOW_DAYS; offset += 1) {
    if (days.has(dayKey(new Date(now - offset * DAY)))) streak += 1;
    else if (offset > 0) break;
  }
  return streak;
};

export const getPublicProfile = async (rawId: unknown) => {
  const id = String(rawId ?? "");
  if (!Types.ObjectId.isValid(id)) throw new AppError("No such solver.", 404);

  const user = await UserModel.findById(id)
    .select("name profilePicUrl gems role status createdAt")
    .lean<{ _id: unknown; name: string; profilePicUrl?: string; gems?: number; role: string; status?: string; createdAt: Date } | null>();
  // A blocked account is not shown at all: it should not be linkable from
  // anywhere, and "this person exists but is hidden" is itself information.
  if (!user || (user as { status?: string }).status === "blocked") throw new AppError("No such solver.", 404);

  const userId = new Types.ObjectId(id);

  const [accepted, totalSubmissions, acceptedCount, rank, days] = await Promise.all([
    SubmissionModel.distinct("problemId", { userId, verdict: "ACCEPTED" }),
    SubmissionModel.countDocuments({ userId }),
    SubmissionModel.countDocuments({ userId, verdict: "ACCEPTED" }),
    leaderboardService.getMyRank(id).catch(() => null),
    SubmissionModel.aggregate<{ _id: string }>([
      { $match: { userId, verdict: "ACCEPTED", createdAt: { $gte: new Date(Date.now() - STREAK_WINDOW_DAYS * DAY) } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } } } },
    ]),
  ]);

  const [solvedProblems, languages] = await Promise.all([
    ProblemModel.find({ _id: { $in: accepted } }).select("difficulty tags").lean(),
    SubmissionModel.distinct("language", { userId, verdict: "ACCEPTED" }),
  ]);

  const solved = { EASY: 0, MEDIUM: 0, HARD: 0 };
  const tagCounts = new Map<string, number>();
  for (const problem of solvedProblems) {
    const difficulty = problem.difficulty as keyof typeof solved;
    if (difficulty in solved) solved[difficulty] += 1;
    for (const tag of problem.tags ?? []) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }

  // The topics this person actually works in, strongest first — the one
  // thing a profile can say that a leaderboard row cannot.
  const topics = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([tag, count]) => ({ tag, solved: count }));

  const visibleFilter = await communityService.getVisibleFilter();
  const recent = await SubmissionModel.find({ ...visibleFilter, userId })
    .sort({ createdAt: -1 })
    .limit(RECENT_LIMIT)
    .select("language runtimeMs createdAt problemId")
    .populate("problemId", "title slug difficulty")
    .lean();

  const recentIds = recent.map((submission) => submission._id);
  const commentCounts = recentIds.length
    ? await ReviewModel.aggregate<{ _id: unknown; count: number }>([
        { $match: { submissionId: { $in: recentIds } } },
        { $group: { _id: "$submissionId", count: { $sum: 1 } } },
      ])
    : [];
  const commentsBySubmission = new Map(commentCounts.map((row) => [String(row._id), row.count]));

  return {
    id: String(user._id),
    name: user.name,
    profilePicUrl: user.profilePicUrl,
    role: user.role,
    joinedAt: user.createdAt,
    gems: user.gems ?? 0,
    rank: rank?.rank ?? null,
    totalRanked: rank?.totalRanked ?? 0,
    score: rank?.totalScore ?? 0,
    solved,
    solvedTotal: accepted.length,
    submissions: totalSubmissions,
    // Of everything they submitted, how much passed. Rounded here so every
    // caller shows the same number.
    acceptanceRate: totalSubmissions ? Math.round((acceptedCount / totalSubmissions) * 100) : 0,
    languages,
    topics,
    streakDays: streakFrom(new Set(days.map((day) => day._id))),
    recentSolutions: recent
      .filter((submission) => submission.problemId)
      .map((submission) => {
        const problem = submission.problemId as unknown as { _id: unknown; title: string; slug: string; difficulty: string };
        return {
          id: String(submission._id),
          language: submission.language,
          runtimeMs: submission.runtimeMs,
          createdAt: submission.createdAt,
          commentCount: commentsBySubmission.get(String(submission._id)) ?? 0,
          problem: { id: String(problem._id), title: problem.title, slug: problem.slug, difficulty: problem.difficulty },
        };
      }),
  };
};

export const publicProfileService = { getPublicProfile };
