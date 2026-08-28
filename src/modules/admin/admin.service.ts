// Service backing the admin dashboard: platform-wide stats and user management.

import { FilterQuery, Types } from "mongoose";
import { UserModel, type IUser } from "../../models/User.model.js";
import { ProblemModel } from "../../models/Problem.model.js";
import { SubmissionModel } from "../../models/Submission.model.js";
import { ContestModel } from "../../models/Contest.model.js";
import { AppError } from "../../utils/errors.js";

type LeanUser = IUser & { _id: Types.ObjectId };

const getStats = async () => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [totalUsers, totalProblems, totalSubmissions, submissionsToday, activeContests, acceptedSubmissions, blockedUsers] = await Promise.all([
    UserModel.countDocuments(),
    ProblemModel.countDocuments(),
    SubmissionModel.countDocuments(),
    SubmissionModel.countDocuments({ createdAt: { $gte: startOfToday } }),
    ContestModel.countDocuments({ endTime: { $gte: new Date() } }),
    SubmissionModel.countDocuments({ verdict: "ACCEPTED" }),
    UserModel.countDocuments({ status: "blocked" }),
  ]);

  return {
    totalUsers,
    totalProblems,
    totalSubmissions,
    submissionsToday,
    activeContests,
    acceptedSubmissions,
    blockedUsers,
  };
};

interface IListUsersQuery {
  page?: number;
  limit?: number;
  search?: string;
}

const listUsers = async ({ page = 1, limit = 20, search }: IListUsersQuery) => {
  const filter: FilterQuery<IUser> = {};
  if (search) {
    filter.$or = [{ name: { $regex: search.trim(), $options: "i" } }, { email: { $regex: search.trim(), $options: "i" } }];
  }

  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const safePage = Math.max(page, 1);

  const [items, total] = (await Promise.all([
    UserModel.find(filter)
      .select("name email role status profilePicUrl createdAt")
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),
    UserModel.countDocuments(filter),
  ])) as unknown as [LeanUser[], number];

  return {
    items: items.map((user) => ({
      id: String(user._id),
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      profilePicUrl: user.profilePicUrl,
      createdAt: user.createdAt,
    })),
    total,
    page: safePage,
    limit: safeLimit,
  };
};

const updateUser = async (targetUserId: string, requestingUserId: string, payload: { role?: "user" | "admin"; status?: "active" | "blocked" }) => {
  if (!Types.ObjectId.isValid(targetUserId)) throw new AppError("Invalid user id.", 400);
  if (targetUserId === requestingUserId) {
    throw new AppError("You cannot change your own role or status.", 400);
  }

  const update: Partial<Pick<IUser, "role" | "status">> = {};
  if (payload.role) update.role = payload.role;
  if (payload.status) update.status = payload.status;
  if (Object.keys(update).length === 0) throw new AppError("Nothing to update.", 400);

  const user = await UserModel.findByIdAndUpdate(targetUserId, update, { new: true }).select("name email role status profilePicUrl createdAt");
  if (!user) throw new AppError("User not found.", 404);
  return user;
};

export const adminService = { getStats, listUsers, updateUser };
