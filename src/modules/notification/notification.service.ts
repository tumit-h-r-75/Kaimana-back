// Creating and reading notifications.
//
// Creating one never fails the action that caused it: a proposal review or a
// role change has already happened by the time we announce it, and a
// database hiccup writing the announcement must not turn that success into
// an error for the admin who did it. Every notify* call logs and moves on.

import { Types } from "mongoose";
import { NotificationModel, type NotificationType } from "../../models/Notification.model.js";
import { UserModel } from "../../models/User.model.js";

export interface NotificationInput {
  type: NotificationType;
  title: string;
  body?: string;
  href?: string;
}

const MAX_LIMIT = 50;

// Titles and bodies are built from user text (a review note, a comment), so
// they are cut to the schema's limits here rather than failing validation.
const clip = (text: unknown, max: number) => {
  const value = String(text ?? "").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

const create = async (doc: Record<string, unknown>) => {
  try {
    await NotificationModel.create({ ...doc, title: clip(doc.title, 140), body: clip(doc.body, 400) });
  } catch (error) {
    console.error("Could not record a notification:", error);
  }
};

/** To one user. No-op for an invalid id. */
const notifyUser = (userId: unknown, input: NotificationInput) => {
  const id = String(userId ?? "");
  if (!Types.ObjectId.isValid(id)) return Promise.resolve();
  return create({ audience: "user", userId: id, ...input });
};

const notifyAdmins = (input: NotificationInput) => create({ audience: "admins", ...input });

const notifyEveryone = (input: NotificationInput) => create({ audience: "all", ...input });

type LeanUser = { _id: Types.ObjectId; role: string; createdAt?: Date; notificationsSeenAt?: Date };

// What one user can see: their own, the admins' if they are one, and every
// broadcast since they joined (a new account doesn't inherit last month's
// announcements).
const audienceFilter = (user: LeanUser) => {
  const clauses: Record<string, unknown>[] = [
    { audience: "user", userId: user._id },
    { audience: "all", ...(user.createdAt ? { createdAt: { $gte: user.createdAt } } : {}) },
  ];
  if (user.role === "admin") clauses.push({ audience: "admins" });
  return { $or: clauses };
};

const loadUser = async (userId: string) =>
  (await UserModel.findById(userId).select("role createdAt notificationsSeenAt").lean()) as unknown as LeanUser | null;

/** The newest notifications and how many are unread. */
const listForUser = async (userId: string, limit = 20) => {
  const user = await loadUser(userId);
  if (!user) return { items: [], unreadCount: 0, seenAt: null };
  const filter = audienceFilter(user);
  const seenAt = user.notificationsSeenAt ?? null;
  const safeLimit = Math.min(Math.max(Math.floor(limit) || 20, 1), MAX_LIMIT);

  const [items, unreadCount] = await Promise.all([
    NotificationModel.find(filter).sort({ createdAt: -1, _id: -1 }).limit(safeLimit),
    NotificationModel.countDocuments(seenAt ? { $and: [filter, { createdAt: { $gt: seenAt } }] } : filter),
  ]);

  return {
    items: items.map((doc: { toJSON: () => Record<string, unknown> }) => {
      const json = doc.toJSON();
      // userId and audience are how it was addressed, not something the
      // bell shows.
      delete json.userId;
      delete json.audience;
      return json;
    }),
    unreadCount,
    seenAt,
  };
};

/** Marks everything up to now as seen. */
const markSeen = async (userId: string) => {
  const seenAt = new Date();
  await UserModel.updateOne({ _id: userId }, { $set: { notificationsSeenAt: seenAt } });
  return { seenAt };
};

export const notificationService = { notifyUser, notifyAdmins, notifyEveryone, listForUser, markSeen };
