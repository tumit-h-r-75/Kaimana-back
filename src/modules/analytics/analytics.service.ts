// Service for computing user submission statistics and solve rate metrics.
import { Types, type PipelineStage } from "mongoose";
import { SubmissionModel } from "../../models/Submission.model.js";
import { ProblemModel } from "../../models/Problem.model.js";
import { AnalyticsSnapshotModel } from "../../models/Analytics.model.js";
import type { Difficulty } from "../../models/Problem.model.js";

export interface VerdictBreakdownEntry {
  verdict: string;
  count: number;
}

export interface LanguageBreakdownEntry {
  language: string;
  count: number;
}

export interface DifficultyBreakdownEntry {
  difficulty: Difficulty;
  count: number;
}

export interface ActivityEntry {
  date: string;
  count: number;
}

export interface MyAnalytics {
  totalSubmissions: number;
  acceptedSubmissions: number;
  problemsSolved: number;
  accuracyPercent: number;
  verdictBreakdown: VerdictBreakdownEntry[];
  languageBreakdown: LanguageBreakdownEntry[];
  difficultyBreakdown: DifficultyBreakdownEntry[];
  activity: ActivityEntry[];
  currentStreakDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVITY_WINDOW_DAYS = 30;

const toDateKey = (date: Date): string => date.toISOString().slice(0, 10);

// NOTE: SubmissionModel.aggregate() sends its pipeline straight to the
// MongoDB driver — unlike .find()/.countDocuments(), Mongoose does NOT
// auto-cast a string userId to ObjectId in a raw $match here. Every
// pipeline below must be given an actual Types.ObjectId, or $match would
// silently match zero documents (stored userId is a BSON ObjectId).

const verdictBreakdownPipeline = (userId: Types.ObjectId): PipelineStage[] => [
  { $match: { userId } },
  { $group: { _id: "$verdict", count: { $sum: 1 } } },
  { $sort: { count: -1 } },
];

const languageBreakdownPipeline = (userId: Types.ObjectId): PipelineStage[] => [
  { $match: { userId } },
  { $group: { _id: "$language", count: { $sum: 1 } } },
  { $sort: { count: -1 } },
];

// Distinct solved (ACCEPTED) problems per difficulty — first collapse each
// problem down to a single row, then join Problem to bucket by difficulty.
const difficultyBreakdownPipeline = (userId: Types.ObjectId): PipelineStage[] => [
  { $match: { userId, verdict: "ACCEPTED" } },
  { $group: { _id: "$problemId" } },
  {
    $lookup: {
      from: ProblemModel.collection.name,
      localField: "_id",
      foreignField: "_id",
      as: "problem",
    },
  },
  { $unwind: "$problem" },
  { $group: { _id: "$problem.difficulty", count: { $sum: 1 } } },
  { $sort: { _id: 1 } },
];

const activityPipeline = (userId: Types.ObjectId, since: Date): PipelineStage[] => [
  { $match: { userId, createdAt: { $gte: since } } },
  {
    $group: {
      _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
      count: { $sum: 1 },
    },
  },
];

// All submission days (any verdict, unbounded lookback) are needed to walk
// the streak backward from today until the first gap is hit.
const submissionDaysPipeline = (userId: Types.ObjectId): PipelineStage[] => [
  { $match: { userId } },
  {
    $group: {
      _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
    },
  },
];

export const getMyAnalytics = async (userId: string): Promise<MyAnalytics> => {
  const now = new Date();
  const since = new Date(now.getTime() - (ACTIVITY_WINDOW_DAYS - 1) * DAY_MS);
  since.setUTCHours(0, 0, 0, 0);

  // .countDocuments()/.distinct() auto-cast a string userId to ObjectId;
  // .aggregate() does not, so the raw pipelines above need a real ObjectId.
  const userObjectId = new Types.ObjectId(userId);

  const [
    totalSubmissions,
    acceptedSubmissions,
    distinctSolved,
    verdictRows,
    languageRows,
    difficultyRows,
    activityRows,
    submissionDayRows,
  ] = await Promise.all([
    SubmissionModel.countDocuments({ userId }),
    SubmissionModel.countDocuments({ userId, verdict: "ACCEPTED" }),
    SubmissionModel.distinct("problemId", { userId, verdict: "ACCEPTED" }),
    SubmissionModel.aggregate(verdictBreakdownPipeline(userObjectId)),
    SubmissionModel.aggregate(languageBreakdownPipeline(userObjectId)),
    SubmissionModel.aggregate(difficultyBreakdownPipeline(userObjectId)),
    SubmissionModel.aggregate(activityPipeline(userObjectId, since)),
    SubmissionModel.aggregate(submissionDaysPipeline(userObjectId)),
  ]);

  const problemsSolved = distinctSolved.length;
  const accuracyPercent = totalSubmissions > 0 ? Math.round((acceptedSubmissions / totalSubmissions) * 100) : 0;

  const verdictBreakdown: VerdictBreakdownEntry[] = verdictRows
    .filter((row) => row.count > 0)
    .map((row) => ({ verdict: String(row._id), count: row.count as number }));

  const languageBreakdown: LanguageBreakdownEntry[] = languageRows
    .filter((row) => row.count > 0)
    .map((row) => ({ language: String(row._id), count: row.count as number }));

  const difficultyBreakdown: DifficultyBreakdownEntry[] = difficultyRows
    .filter((row) => row.count > 0)
    .map((row) => ({ difficulty: row._id as Difficulty, count: row.count as number }));

  const activityByDay = new Map<string, number>();
  for (const row of activityRows) {
    activityByDay.set(String(row._id), row.count as number);
  }

  const activity: ActivityEntry[] = [];
  for (let i = 0; i < ACTIVITY_WINDOW_DAYS; i++) {
    const date = new Date(since.getTime() + i * DAY_MS);
    const key = toDateKey(date);
    activity.push({ date: key, count: activityByDay.get(key) ?? 0 });
  }

  const submissionDays = new Set<string>(submissionDayRows.map((row) => String(row._id)));
  let currentStreakDays = 0;
  const cursor = new Date(now);
  cursor.setUTCHours(0, 0, 0, 0);
  while (submissionDays.has(toDateKey(cursor))) {
    currentStreakDays += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  // Best-effort: persist today's numbers so getMyAnalyticsHistory() can
  // chart progress over calendar days. Never let a snapshot-write failure
  // fail the analytics read itself — the live numbers above are already
  // computed and correct regardless of whether this succeeds.
  try {
    await AnalyticsSnapshotModel.findOneAndUpdate(
      { userId: userObjectId, date: toDateKey(now) },
      { totalSubmissions, acceptedSubmissions, problemsSolved, accuracyPercent, currentStreakDays },
      { upsert: true },
    );
  } catch (snapshotError) {
    console.error(`Failed to save analytics snapshot for user ${userId}:`, snapshotError);
  }

  return {
    totalSubmissions,
    acceptedSubmissions,
    problemsSolved,
    accuracyPercent,
    verdictBreakdown,
    languageBreakdown,
    difficultyBreakdown,
    activity,
    currentStreakDays,
  };
};

export interface AnalyticsHistoryEntry {
  date: string;
  totalSubmissions: number;
  acceptedSubmissions: number;
  problemsSolved: number;
  accuracyPercent: number;
  currentStreakDays: number;
}

const MAX_HISTORY_DAYS = 90;
const DEFAULT_HISTORY_DAYS = 30;

// Snapshots are written newest-last as they accumulate day by day, but a
// chart wants them oldest-first — fetch the most recent `days` rows
// (sorted newest-first so `.limit()` keeps the right end of the range),
// then reverse back into chronological order.
export const getMyAnalyticsHistory = async (userId: string, days: number = DEFAULT_HISTORY_DAYS): Promise<AnalyticsHistoryEntry[]> => {
  const safeDays = Math.min(Math.max(Math.trunc(days) || DEFAULT_HISTORY_DAYS, 1), MAX_HISTORY_DAYS);
  const rows = await AnalyticsSnapshotModel.find({ userId: new Types.ObjectId(userId) })
    .sort({ date: -1 })
    .limit(safeDays)
    .select("date totalSubmissions acceptedSubmissions problemsSolved accuracyPercent currentStreakDays -_id")
    .lean();

  return rows.reverse().map((row) => ({
    date: row.date,
    totalSubmissions: row.totalSubmissions,
    acceptedSubmissions: row.acceptedSubmissions,
    problemsSolved: row.problemsSolved,
    accuracyPercent: row.accuracyPercent,
    currentStreakDays: row.currentStreakDays,
  }));
};

export const analyticsService = { getMyAnalytics, getMyAnalyticsHistory };
