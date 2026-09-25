// What the analytics page could not ask before.
//
// The existing service answers "how many" — submissions, accepted, solved —
// and charts the daily snapshot rows, which only exist for the days someone
// happened to open the page. That makes a trend line with holes in it.
//
// This reads the submissions themselves, and asks the questions a solver
// actually has: when do I do my best work, which topics am I weak at, how
// many tries does a problem usually cost me, and is the picture different
// per language. Everything here is scoped to one user.

import { Types, type PipelineStage } from "mongoose";
import { SubmissionModel } from "../../models/Submission.model.js";
import { ProblemModel } from "../../models/Problem.model.js";

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 120;
const MIN_DAYS = 7;
const TOP_TAGS = 8;
/** Beyond this the histogram stops counting and says "or more". */
const ATTEMPT_CAP = 5;

export interface InsightDay {
  date: string;
  submissions: number;
  accepted: number;
  /** Distinct problems that passed that day. */
  problems: number;
}

export interface HeatCell {
  /** 0 = Sunday, matching $dayOfWeek - 1. */
  day: number;
  hour: number;
  count: number;
  accepted: number;
}

const toDateKey = (date: Date) => date.toISOString().slice(0, 10);

/**
 * A caller's IANA zone, if it is one. The buckets below are hours of the
 * day, and an hour of the day means nothing in a zone the reader does not
 * live in — but the string arrives from a query parameter, so it is checked
 * against the platform's own zone list before it reaches the database.
 */
export const safeTimeZone = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 64) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return "UTC";
  }
};

const dailyPipeline = (userId: Types.ObjectId, since: Date, timeZone: string): PipelineStage[] => [
  { $match: { userId, createdAt: { $gte: since } } },
  {
    $group: {
      _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: timeZone } },
      submissions: { $sum: 1 },
      accepted: { $sum: { $cond: [{ $eq: ["$verdict", "ACCEPTED"] }, 1, 0] } },
      passed: { $addToSet: { $cond: [{ $eq: ["$verdict", "ACCEPTED"] }, "$problemId", null] } },
    },
  },
];

const heatmapPipeline = (userId: Types.ObjectId, since: Date, timeZone: string): PipelineStage[] => [
  { $match: { userId, createdAt: { $gte: since } } },
  {
    $group: {
      _id: {
        day: { $dayOfWeek: { date: "$createdAt", timezone: timeZone } },
        hour: { $hour: { date: "$createdAt", timezone: timeZone } },
      },
      count: { $sum: 1 },
      accepted: { $sum: { $cond: [{ $eq: ["$verdict", "ACCEPTED"] }, 1, 0] } },
    },
  },
];

const languagePipeline = (userId: Types.ObjectId): PipelineStage[] => [
  { $match: { userId } },
  {
    $group: {
      _id: "$language",
      count: { $sum: 1 },
      accepted: { $sum: { $cond: [{ $eq: ["$verdict", "ACCEPTED"] }, 1, 0] } },
      // Runtime only means something on a run that finished correctly.
      runtimeSum: { $sum: { $cond: [{ $eq: ["$verdict", "ACCEPTED"] }, "$runtimeMs", 0] } },
      solved: { $addToSet: { $cond: [{ $eq: ["$verdict", "ACCEPTED"] }, "$problemId", null] } },
    },
  },
  { $sort: { count: -1 } },
];

// Every problem this person has ever passed, and how many submissions it
// took to get there — the ones after the first accept do not count.
const attemptsPipeline = (userId: Types.ObjectId): PipelineStage[] => [
  { $match: { userId } },
  {
    $group: {
      _id: "$problemId",
      // $min skips nulls, so this is the first accepted run or nothing.
      firstAccepted: { $min: { $cond: [{ $eq: ["$verdict", "ACCEPTED"] }, "$createdAt", null] } },
      times: { $push: "$createdAt" },
    },
  },
  { $match: { firstAccepted: { $ne: null } } },
  {
    $project: {
      attempts: { $size: { $filter: { input: "$times", as: "at", cond: { $lte: ["$$at", "$firstAccepted"] } } } },
    },
  },
  { $group: { _id: { $min: ["$attempts", ATTEMPT_CAP] }, problems: { $sum: 1 } } },
  { $sort: { _id: 1 } },
];

// Tags live on the problem, so the join has to happen before the grouping.
// Distinct problems, not submissions: nine tries at one graph problem does
// not make someone good or bad at graphs.
const tagPipeline = (userId: Types.ObjectId): PipelineStage[] => [
  { $match: { userId } },
  {
    $group: {
      _id: "$problemId",
      solved: { $max: { $cond: [{ $eq: ["$verdict", "ACCEPTED"] }, 1, 0] } },
    },
  },
  { $lookup: { from: ProblemModel.collection.name, localField: "_id", foreignField: "_id", as: "problem" } },
  { $unwind: "$problem" },
  { $unwind: "$problem.tags" },
  { $group: { _id: "$problem.tags", attempted: { $sum: 1 }, solved: { $sum: "$solved" } } },
  { $sort: { attempted: -1, _id: 1 } },
  { $limit: TOP_TAGS },
];

const difficultyPipeline = (userId: Types.ObjectId): PipelineStage[] => [
  { $match: { userId } },
  {
    $group: {
      _id: "$problemId",
      submissions: { $sum: 1 },
      solved: { $max: { $cond: [{ $eq: ["$verdict", "ACCEPTED"] }, 1, 0] } },
    },
  },
  { $lookup: { from: ProblemModel.collection.name, localField: "_id", foreignField: "_id", as: "problem" } },
  { $unwind: "$problem" },
  {
    $group: {
      _id: "$problem.difficulty",
      attempted: { $sum: 1 },
      solved: { $sum: "$solved" },
      submissions: { $sum: "$submissions" },
    },
  },
];

export const getMyInsights = async (userId: string, { days = DEFAULT_DAYS, timeZone = "UTC" }: { days?: number; timeZone?: string } = {}) => {
  const windowDays = Math.min(Math.max(Math.trunc(days) || DEFAULT_DAYS, MIN_DAYS), MAX_DAYS);
  const since = new Date(Date.now() - (windowDays - 1) * DAY_MS);
  since.setUTCHours(0, 0, 0, 0);
  const objectId = new Types.ObjectId(userId);

  const [dailyRows, heatRows, languageRows, attemptRows, tagRows, difficultyRows] = await Promise.all([
    SubmissionModel.aggregate(dailyPipeline(objectId, since, timeZone)),
    SubmissionModel.aggregate(heatmapPipeline(objectId, since, timeZone)),
    SubmissionModel.aggregate(languagePipeline(objectId)),
    SubmissionModel.aggregate(attemptsPipeline(objectId)),
    SubmissionModel.aggregate(tagPipeline(objectId)),
    SubmissionModel.aggregate(difficultyPipeline(objectId)),
  ]);

  const byDay = new Map<string, { submissions: number; accepted: number; problems: number }>();
  for (const row of dailyRows) {
    const passed = (row.passed as (Types.ObjectId | null)[]).filter(Boolean);
    byDay.set(String(row._id), { submissions: row.submissions as number, accepted: row.accepted as number, problems: passed.length });
  }

  // A quiet day is data too, so the series carries every day in the window.
  const daily: InsightDay[] = [];
  for (let back = windowDays - 1; back >= 0; back -= 1) {
    const key = toDateKey(new Date(Date.now() - back * DAY_MS));
    const found = byDay.get(key);
    daily.push({ date: key, submissions: found?.submissions ?? 0, accepted: found?.accepted ?? 0, problems: found?.problems ?? 0 });
  }

  const heatmap: HeatCell[] = heatRows.map((row) => ({
    // $dayOfWeek is 1-7 starting Sunday; the grid counts from zero.
    day: (row._id.day as number) - 1,
    hour: row._id.hour as number,
    count: row.count as number,
    accepted: row.accepted as number,
  }));

  const languages = languageRows.map((row) => {
    const accepted = row.accepted as number;
    return {
      language: String(row._id),
      count: row.count as number,
      accepted,
      solved: (row.solved as (Types.ObjectId | null)[]).filter(Boolean).length,
      avgRuntimeMs: accepted > 0 ? Math.round((row.runtimeSum as number) / accepted) : null,
    };
  });

  const attempts = attemptRows.map((row) => ({
    attempts: row._id as number,
    problems: row.problems as number,
    capped: (row._id as number) >= ATTEMPT_CAP,
  }));

  const tags = tagRows.map((row) => ({
    tag: String(row._id),
    attempted: row.attempted as number,
    solved: row.solved as number,
    solveRate: row.attempted > 0 ? Math.round(((row.solved as number) / (row.attempted as number)) * 100) : 0,
  }));

  const difficulty = (["EASY", "MEDIUM", "HARD"] as const).map((level) => {
    const row = difficultyRows.find((entry) => entry._id === level);
    const attempted = (row?.attempted as number) ?? 0;
    const solved = (row?.solved as number) ?? 0;
    return {
      difficulty: level,
      attempted,
      solved,
      submissions: (row?.submissions as number) ?? 0,
      solveRate: attempted > 0 ? Math.round((solved / attempted) * 100) : 0,
    };
  });

  return { windowDays, timeZone, daily, heatmap, languages, attempts, tags, difficulty };
};

export const insightsService = { getMyInsights, safeTimeZone };
