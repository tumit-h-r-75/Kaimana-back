// Service for aggregating submission data to compute global user rankings.
import type { PipelineStage } from "mongoose";
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
// their standing. Only problems with a positive best score (i.e. at least
// one ACCEPTED submission scored them points) count toward problemsSolved.
const bestScoresPipeline = (): PipelineStage[] => [
  {
    $group: {
      _id: { userId: "$userId", problemId: "$problemId" },
      bestScore: { $max: "$score" },
    },
  },
  { $match: { bestScore: { $gt: 0 } } },
  {
    $group: {
      _id: "$_id.userId",
      totalScore: { $sum: "$bestScore" },
      problemsSolved: { $sum: 1 },
    },
  },
  { $sort: { totalScore: -1, problemsSolved: -1 } },
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
  const rows = await SubmissionModel.aggregate(bestScoresPipeline());
  const index = rows.findIndex((row) => String(row._id) === String(userId));

  if (index === -1) {
    return { rank: null, totalScore: 0, problemsSolved: 0, totalRanked: rows.length };
  }

  const row = rows[index];
  return {
    rank: index + 1,
    totalScore: row.totalScore,
    problemsSolved: row.problemsSolved,
    totalRanked: rows.length,
  };
};

export const leaderboardService = { getGlobalLeaderboard, getMyRank };
