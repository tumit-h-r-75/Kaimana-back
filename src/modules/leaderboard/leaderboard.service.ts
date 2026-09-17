// Service for aggregating submission data to compute global user rankings.
import { Types, type PipelineStage } from "mongoose";
import { SubmissionModel } from "../../models/Submission.model.js";
import { UserModel } from "../../models/User.model.js";

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  name: string;
  profilePicUrl?: string;
  totalScore: number;
  problemsSolved: number;
}

// A user's "best score" on a problem is the highest score across all of
// their submissions to it — re-submitting a worse attempt never lowers
// their standing. Submissions now carry partial credit (see
// submission.controller.ts), so a problem can contribute points to
// totalScore without ever being fully solved — "problemsSolved" is
// therefore tracked separately from score, off whether any submission for
// that problem actually got a full ACCEPTED verdict.
const bestScoresPipeline = (): PipelineStage[] => [
  {
    $group: {
      _id: { userId: "$userId", problemId: "$problemId" },
      bestScore: { $max: "$score" },
      solved: { $max: { $cond: [{ $eq: ["$verdict", "ACCEPTED"] }, 1, 0] } },
      lastSubmitTime: { $max: "$submittedAt" },
    },
  },
  { $match: { bestScore: { $gt: 0 } } },
  {
    $group: {
      _id: "$_id.userId",
      totalScore: { $sum: "$bestScore" },
      problemsSolved: { $sum: "$solved" },
      lastSubmitTime: { $max: "$lastSubmitTime" },
    },
  },
  // _id (the user id) is a unique final tiebreaker: without it, users tied
  // on score, solves, and submit time have no defined order, so $skip/$limit pages could
  // repeat or drop them from one request to the next.
  { $sort: { totalScore: -1, problemsSolved: -1, lastSubmitTime: 1, _id: 1 } },
];

export const getGlobalLeaderboard = async ({ page, limit }: { page: number; limit: number }) => {
  const skip = (page - 1) * limit;

  const [rows, totalRanked] = await Promise.all([
    SubmissionModel.aggregate([
      ...bestScoresPipeline(),
      { $skip: skip },
      { $limit: limit },
      {
        $lookup: {
          from: UserModel.collection.name,
          localField: "_id",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: "$user" },
      {
        $project: {
          _id: 0,
          userId: "$_id",
          totalScore: 1,
          problemsSolved: 1,
          name: "$user.name",
          profilePicUrl: "$user.profilePicUrl",
        },
      },
    ]),
    SubmissionModel.aggregate([...bestScoresPipeline(), { $count: "count" }]),
  ]);

  const entries: LeaderboardEntry[] = rows.map((row, index) => ({
    rank: skip + index + 1,
    userId: String(row.userId),
    name: row.name,
    profilePicUrl: row.profilePicUrl,
    totalScore: row.totalScore,
    problemsSolved: row.problemsSolved,
  }));

  return {
    entries,
    total: totalRanked[0]?.count ?? 0,
    page,
    limit,
  };
};

// Ranks are computed over the full standings (no skip/limit) so a user far
// down the list still gets an accurate position — fine at this dataset size.
export const getMyRank = async (userId: string) => {
  // 1. Get the user's own totals and the timestamp used for tie-breaking.
  const userScores = await SubmissionModel.aggregate([
    { $match: { userId: new Types.ObjectId(userId) } },
    ...bestScoresPipeline(),
  ]);

  if (!userScores.length) {
    return { rank: null, totalScore: 0, problemsSolved: 0, totalRanked: 0 };
  }

  const { _id, totalScore, problemsSolved, lastSubmitTime } = userScores[0];
  const normalizedLastSubmitTime = lastSubmitTime ?? new Date(0);

  // 2. Count how many users are strictly ahead of this user in MongoDB, using
  //    the same ordering as the public leaderboard: score desc, solves desc,
  //    submit time asc, then ObjectId asc as the last deterministic tie-break.
  const aheadCount = await SubmissionModel.aggregate([
    ...bestScoresPipeline(),
    {
      $match: {
        $or: [
          { totalScore: { $gt: totalScore } },
          { totalScore: totalScore, problemsSolved: { $gt: problemsSolved } },
          {
            totalScore: totalScore,
            problemsSolved: problemsSolved,
            lastSubmitTime: { $lt: normalizedLastSubmitTime },
          },
          {
            totalScore: totalScore,
            problemsSolved: problemsSolved,
            lastSubmitTime: normalizedLastSubmitTime,
            _id: { $lt: new Types.ObjectId(String(_id)) },
          },
        ],
      },
    },
    { $count: "count" },
  ]);

  const totalRanked = await SubmissionModel.aggregate([...bestScoresPipeline(), { $count: "count" }]);
  const usersAhead = aheadCount[0]?.count ?? 0;

  return {
    rank: usersAhead + 1,
    totalScore,
    problemsSolved,
    totalRanked: totalRanked[0]?.count ?? 0,
  };
};

export const leaderboardService = { getGlobalLeaderboard, getMyRank };
