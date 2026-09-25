// The mail nobody asks for by clicking: a contest about to start, the
// standings once it is over, and a weekly summary.
//
// All three run from one scheduled call (see mail.route.ts). None of them
// may send twice — a reminder that arrives every hour is worse than no
// reminder — so each one marks what it has done before it queues anything,
// and every recipient is checked against their own preferences first.

import { ContestModel } from "../../models/Contest.model.js";
import { ContestParticipantModel } from "../../models/ContestParticipant.model.js";
import { SubmissionModel } from "../../models/Submission.model.js";
import { ProblemModel } from "../../models/Problem.model.js";
import { UserModel } from "../../models/User.model.js";
import { contestService } from "../contest/contest.service.js";
import { mailService } from "./mail.service.js";
import { mailTemplates } from "./mail.templates.js";
import { randomBytes } from "crypto";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** People are mailed at most this many at a time, so one run stays bounded. */
const MAX_DIGESTS_PER_RUN = 200;

type Recipient = { _id: unknown; name: string; email: string; unsubscribeToken?: string; emailPrefs?: { contestReminders?: boolean; weeklyDigest?: boolean } };

/**
 * The token that makes an unsubscribe link work without a session. Created
 * the first time one is needed rather than for every account up front.
 */
const unsubscribeTokenFor = async (user: Recipient) => {
  if (user.unsubscribeToken) return user.unsubscribeToken;
  const token = randomBytes(24).toString("base64url");
  await UserModel.updateOne({ _id: user._id }, { $set: { unsubscribeToken: token } });
  return token;
};

const wants = (user: Recipient, kind: "contestReminders" | "weeklyDigest") => user.emailPrefs?.[kind] !== false;

const humanLeadTime = (ms: number) => {
  const hours = Math.round(ms / HOUR);
  if (hours <= 1) return "in an hour";
  if (hours < 24) return `in ${hours} hours`;
  return "tomorrow";
};

/** "Starting soon", to everyone registered, once per contest. */
const sendContestReminders = async () => {
  const now = new Date();
  const contests = await ContestModel.find({
    isPublished: true,
    remindersSentAt: { $exists: false },
    startTime: { $gt: now, $lte: new Date(now.getTime() + DAY) },
  })
    .select("title slug startTime")
    .lean();

  let queued = 0;
  for (const contest of contests) {
    // Marked first: a crash halfway through must not mean everyone gets a
    // second copy on the next run.
    await ContestModel.updateOne({ _id: contest._id }, { $set: { remindersSentAt: new Date() } });

    const participants = await ContestParticipantModel.find({ contestId: contest._id }).select("userId").lean();
    if (!participants.length) continue;
    const users = (await UserModel.find({ _id: { $in: participants.map((entry) => entry.userId) }, status: { $ne: "blocked" } })
      .select("name email emailPrefs +unsubscribeToken")
      .lean()) as unknown as Recipient[];

    for (const user of users) {
      if (!user.email || !wants(user, "contestReminders")) continue;
      const token = await unsubscribeTokenFor(user);
      await mailService.deliver(
        user.email,
        mailTemplates.contestReminder({
          name: user.name,
          contest: { title: contest.title, slug: contest.slug, startTime: new Date(contest.startTime) },
          startsIn: humanLeadTime(new Date(contest.startTime).getTime() - now.getTime()),
          unsubscribeToken: token,
        }),
      );
      queued += 1;
    }
  }
  return { contests: contests.length, queued };
};

/** Final standings, to everyone who took part, once per contest. */
const sendContestResults = async () => {
  const now = new Date();
  const contests = await ContestModel.find({
    isPublished: true,
    resultsSentAt: { $exists: false },
    endTime: { $lt: now, $gte: new Date(now.getTime() - 2 * DAY) },
  })
    .select("title slug")
    .lean();

  let queued = 0;
  for (const contest of contests) {
    await ContestModel.updateOne({ _id: contest._id }, { $set: { resultsSentAt: new Date() } });

    let board: { entries?: { userId?: string; rank?: number; totalScore?: number; problemsSolved?: number }[] } = {};
    try {
      board = (await contestService.getScoreboard(contest.slug)) as typeof board;
    } catch (error) {
      console.error(`Could not read the scoreboard for ${contest.slug}:`, error);
      continue;
    }
    const rows = board.entries ?? [];
    if (!rows.length) continue;

    const users = (await UserModel.find({ _id: { $in: rows.map((row) => row.userId).filter(Boolean) }, status: { $ne: "blocked" } })
      .select("name email emailPrefs +unsubscribeToken")
      .lean()) as unknown as Recipient[];
    const byId = new Map(users.map((user) => [String(user._id), user]));

    for (const row of rows) {
      const user = byId.get(String(row.userId));
      if (!user?.email || !wants(user, "contestReminders")) continue;
      const token = await unsubscribeTokenFor(user);
      await mailService.deliver(
        user.email,
        mailTemplates.contestResults({
          name: user.name,
          contest: { title: contest.title, slug: contest.slug },
          rank: row.rank ?? null,
          total: rows.length,
          score: row.totalScore ?? 0,
          solved: row.problemsSolved ?? 0,
          unsubscribeToken: token,
        }),
      );
      queued += 1;
    }
  }
  return { contests: contests.length, queued };
};

/**
 * The week in a few numbers. Only to people who have been here recently —
 * mailing a dormant account a summary of a week it did not spend here is
 * how a digest becomes junk.
 */
const sendWeeklyDigest = async () => {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * DAY);
  const monthAgo = new Date(now.getTime() - 30 * DAY);

  const activeUserIds = await SubmissionModel.distinct("userId", { createdAt: { $gte: monthAgo } });
  if (!activeUserIds.length) return { users: 0, queued: 0 };

  const users = (await UserModel.find({ _id: { $in: activeUserIds }, status: { $ne: "blocked" } })
    .select("name email gems emailPrefs +unsubscribeToken")
    .limit(MAX_DIGESTS_PER_RUN)
    .lean()) as unknown as (Recipient & { gems?: number })[];

  const [newProblems, upcomingContests] = await Promise.all([
    ProblemModel.find({ isPublished: true, createdAt: { $gte: weekAgo } })
      .select("title slug difficulty")
      .sort({ createdAt: -1 })
      .limit(4)
      .lean(),
    ContestModel.find({ isPublished: true, startTime: { $gt: now, $lte: new Date(now.getTime() + 14 * DAY) } })
      .select("title slug startTime")
      .sort({ startTime: 1 })
      .limit(3)
      .lean(),
  ]);

  let queued = 0;
  for (const user of users) {
    if (!user.email || !wants(user, "weeklyDigest")) continue;

    const solvedThisWeek = (await SubmissionModel.distinct("problemId", {
      userId: user._id,
      verdict: "ACCEPTED",
      createdAt: { $gte: weekAgo },
    })).length;

    // A digest with nothing in it is not worth an inbox: skip anyone with no
    // solves, no new problems to show and nothing coming up.
    if (!solvedThisWeek && !newProblems.length && !upcomingContests.length) continue;

    // Days in a row ending today or yesterday, counted from accepted work.
    const days = await SubmissionModel.aggregate<{ _id: string }>([
      { $match: { userId: user._id, verdict: "ACCEPTED", createdAt: { $gte: new Date(now.getTime() - 60 * DAY) } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } } } },
      { $sort: { _id: -1 } },
    ]);
    const daySet = new Set(days.map((day) => day._id));
    let streakDays = 0;
    for (let offset = 0; offset < 60; offset += 1) {
      const key = new Date(now.getTime() - offset * DAY).toISOString().slice(0, 10);
      if (daySet.has(key)) streakDays += 1;
      else if (offset > 0) break;
    }

    const token = await unsubscribeTokenFor(user);
    await mailService.deliver(
      user.email,
      mailTemplates.weeklyDigest({
        name: user.name,
        solvedThisWeek,
        streakDays,
        gems: user.gems ?? 0,
        newProblems: newProblems.map((problem) => ({ title: problem.title, slug: problem.slug, difficulty: problem.difficulty })),
        upcomingContests: upcomingContests.map((contest) => ({ title: contest.title, slug: contest.slug, startTime: new Date(contest.startTime) })),
        unsubscribeToken: token,
      }),
    );
    queued += 1;
  }
  return { users: users.length, queued };
};

/**
 * Everything the schedule runs. The digest is weekly, so it only goes on a
 * Monday; the other two check their own windows and are safe to call daily
 * or hourly.
 */
const runScheduled = async ({ includeDigest = new Date().getUTCDay() === 1 }: { includeDigest?: boolean } = {}) => {
  const reminders = await sendContestReminders();
  const results = await sendContestResults();
  const digest = includeDigest ? await sendWeeklyDigest() : { users: 0, queued: 0, skipped: "not Monday" };
  return { reminders, results, digest };
};

export const mailJobs = { sendContestReminders, sendContestResults, sendWeeklyDigest, runScheduled };
