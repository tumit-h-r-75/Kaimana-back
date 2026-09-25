// Service backing the admin dashboard: platform-wide stats and user management.

import { FilterQuery, Types } from "mongoose";
import { UserModel, type IUser } from "../../models/User.model.js";
import { ProblemModel } from "../../models/Problem.model.js";
import { SubmissionModel } from "../../models/Submission.model.js";
import { ContestModel } from "../../models/Contest.model.js";
import { AppError } from "../../utils/errors.js";
import { notificationService } from "../notification/notification.service.js";

type LeanUser = IUser & { _id: Types.ObjectId };

// "guest" is an approved contest host: a regular user who can also manage
// their own contests. The controller validates raw input against these lists.
export const USER_ROLES = ["user", "guest", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];
export const USER_STATUSES = ["active", "blocked"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

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
  role?: UserRole;
}

// Search text is matched literally and capped before it reaches $regex — same
// reasoning as the helper of the same name in problem.service.ts.
const MAX_SEARCH_LENGTH = 100;
const toSearchRegex = (search: string) => search.trim().slice(0, MAX_SEARCH_LENGTH).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
// Keeps (page - 1) * limit a sane skip() value for absurd ?page= input.
const MAX_PAGE = 1_000_000;

// page/limit come from the query string, so they can be NaN ("abc"), zero,
// negative or fractional. NaN used to reach skip()/limit() and 500; anything
// that isn't a positive number now falls back to the default instead.
const toPositiveInt = (value: number | undefined, fallback: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), max) : fallback;

const listUsers = async ({ page, limit, search, role }: IListUsersQuery) => {
  const filter: FilterQuery<IUser> = {};
  if (search) {
    const pattern = toSearchRegex(search);
    filter.$or = [{ name: { $regex: pattern, $options: "i" } }, { email: { $regex: pattern, $options: "i" } }];
  }
  if (role) filter.role = role;

  const safeLimit = toPositiveInt(limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const safePage = toPositiveInt(page, 1, MAX_PAGE);

  const [items, total] = (await Promise.all([
    UserModel.find(filter)
      .select("name email role status profilePicUrl createdAt")
      // _id breaks createdAt ties (e.g. seeded or bulk-imported users), so an
      // item can never repeat on, or vanish between, adjacent pages.
      .sort({ createdAt: -1, _id: -1 })
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

const updateUser = async (targetUserId: string, requestingUserId: string, payload: { role?: UserRole; status?: UserStatus }) => {
  if (!Types.ObjectId.isValid(targetUserId)) throw new AppError("Invalid user id.", 400);
  if (targetUserId === requestingUserId) {
    throw new AppError("You cannot change your own role or status.", 400);
  }

  const update: { role?: UserRole; status?: UserStatus } = {};
  if (payload.role) update.role = payload.role;
  if (payload.status) update.status = payload.status;
  if (Object.keys(update).length === 0) throw new AppError("Nothing to update.", 400);

  // runValidators: the schema enums are the last line of defence behind the
  // controller's checks (update queries skip them by default).
  const user = await UserModel.findByIdAndUpdate(targetUserId, update, { new: true, runValidators: true }).select(
    "name email role status profilePicUrl createdAt",
  );
  if (!user) throw new AppError("User not found.", 404);

  // The person whose account changed hears about it. A block needs no
  // message — they can no longer sign in to read one.
  if (payload.role) {
    const byRole = {
      admin: { title: "You're now an admin", body: "You can manage every problem, contest and account.", href: "/admin" },
      guest: { title: "You can host contests now", body: "The contest manager is open to you.", href: "/admin/contests" },
      user: { title: "Your role changed", body: "Your account is a regular learner account now.", href: "/profile" },
    } as const;
    await notificationService.notifyUser(targetUserId, { email: true, type: "role.changed", ...byRole[payload.role] });
  } else if (payload.status === "active") {
    await notificationService.notifyUser(targetUserId, {
      email: true,
      type: "role.changed",
      title: "Your account is active again",
      body: "Welcome back — everything is open to you.",
      href: "/problems",
    });
  }
  return user;
};

export const adminService = { getStats, listUsers, updateUser };
