// The numbers the overview could not show before.
//
// /api/admin/stats answers seven "how many" questions and nothing else, so
// the dashboard could only ever print totals: 531 submissions, 60% accepted.
// A total tells you where the site has been, never where it is going, and
// never why — which is the question an admin actually has. Is it busier than
// last week? Do people fail on wrong answers or on timeouts? Is there a
// problem nobody can solve?
//
// This answers those three, in one round trip, from aggregations the
// indexes already support.

import { ProblemModel } from "../../models/Problem.model.js";
import { SubmissionModel } from "../../models/Submission.model.js";
import { UserModel } from "../../models/User.model.js";

const DAYS = 14;
// A verdict below this many attempts says more about the sample than about
// the problem, so it never reaches the "hardest" list.
const MIN_ATTEMPTS = 5;

/** Midnight UTC, `back` days ago. The grouping below is UTC too, so they agree. */
const startOfDayUtc = (back: number) => {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - back);
  return date;
};

const dayKey = (date: Date) => date.toISOString().slice(0, 10);

/** Counts keyed by day, as one aggregation over a date field. */
const countByDay = async (model: typeof SubmissionModel | typeof UserModel, since: Date, match: Record<string, unknown> = {}) => {
  const rows = (await model.aggregate([
    { $match: { createdAt: { $gte: since }, ...match } },
    { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" } }, count: { $sum: 1 } } },
  ])) as { _id: string; count: number }[];

  const byDay = new Map<string, number>();
  for (const row of rows) byDay.set(row._id, row.count);
  return byDay;
};

export interface PulseDay {
  date: string;
  submissions: number;
  accepted: number;
  users: number;
}

const getPulse = async () => {
  const since = startOfDayUtc(DAYS - 1);

  const [submissionsByDay, acceptedByDay, usersByDay, verdictRows, libraryRows, hardestRows] = await Promise.all([
    countByDay(SubmissionModel, since),
    countByDay(SubmissionModel, since, { verdict: "ACCEPTED" }),
    countByDay(UserModel, since),

    // Why submissions fail, over the same window. PENDING and RUNNING are
    // not outcomes — they are rows the judge has not finished with.
    SubmissionModel.aggregate([
      { $match: { createdAt: { $gte: since }, verdict: { $nin: ["PENDING", "RUNNING"] } } },
      { $group: { _id: "$verdict", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]) as Promise<{ _id: string; count: number }[]>,

    ProblemModel.aggregate([
      { $group: { _id: "$difficulty", total: { $sum: 1 }, published: { $sum: { $cond: ["$isPublished", 1, 0] } } } },
    ]) as Promise<{ _id: string; total: number; published: number }[]>,

    // The problems people attempt and do not solve. Grouped over all time,
    // because a hard problem is hard whether or not it was tried this week.
    SubmissionModel.aggregate([
      { $match: { verdict: { $nin: ["PENDING", "RUNNING"] } } },
      {
        $group: {
          _id: "$problemId",
          attempts: { $sum: 1 },
          solvers: { $addToSet: { $cond: [{ $eq: ["$verdict", "ACCEPTED"] }, "$userId", null] } },
          triedBy: { $addToSet: "$userId" },
        },
      },
      { $match: { attempts: { $gte: MIN_ATTEMPTS } } },
      // The null placeholder is every non-accepted attempt collapsed into one
      // entry by $addToSet; dropping it leaves the people who actually solved it.
      { $project: { attempts: 1, solved: { $size: { $setDifference: ["$solvers", [null]] } }, tried: { $size: "$triedBy" } } },
      { $addFields: { solveRate: { $cond: [{ $gt: ["$tried", 0] }, { $divide: ["$solved", "$tried"] }, 0] } } },
      { $sort: { solveRate: 1, attempts: -1 } },
      { $limit: 5 },
      { $lookup: { from: "problems", localField: "_id", foreignField: "_id", as: "problem" } },
      { $unwind: "$problem" },
    ]) as Promise<{ _id: unknown; attempts: number; solved: number; tried: number; solveRate: number; problem: Record<string, unknown> }[]>,
  ]);

  // Every day in the window appears, including the quiet ones — a gap in a
  // chart reads as "nothing happened here", which is exactly right, but only
  // if the day is drawn at all.
  const days: PulseDay[] = [];
  for (let back = DAYS - 1; back >= 0; back -= 1) {
    const key = dayKey(startOfDayUtc(back));
    days.push({
      date: key,
      submissions: submissionsByDay.get(key) ?? 0,
      accepted: acceptedByDay.get(key) ?? 0,
      users: usersByDay.get(key) ?? 0,
    });
  }

  const library = { total: 0, published: 0, drafts: 0, easy: 0, medium: 0, hard: 0 };
  for (const row of libraryRows) {
    library.total += row.total;
    library.published += row.published;
    if (row._id === "EASY") library.easy = row.total;
    if (row._id === "MEDIUM") library.medium = row.total;
    if (row._id === "HARD") library.hard = row.total;
  }
  library.drafts = library.total - library.published;

  return {
    days,
    verdicts: verdictRows.map((row) => ({ verdict: row._id, count: row.count })),
    library,
    hardest: hardestRows.map((row) => ({
      id: String(row._id),
      title: String(row.problem.title ?? "Untitled"),
      slug: String(row.problem.slug ?? ""),
      difficulty: String(row.problem.difficulty ?? "EASY"),
      attempts: row.attempts,
      tried: row.tried,
      solved: row.solved,
      solveRate: Math.round(row.solveRate * 100),
    })),
  };
};

export const pulseService = { getPulse };
