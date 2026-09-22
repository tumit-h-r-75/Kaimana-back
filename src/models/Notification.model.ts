// Notifications shown in the site header's bell (and as toasts while the
// site is open).
//
// One document per event, addressed three ways: to a single user, to every
// admin, or to everyone. A broadcast is stored once rather than copied to
// every account; who has seen what is tracked by one timestamp per user
// (User.notificationsSeenAt), not per document.

import mongoose, { model, Schema, Types } from "mongoose";

export type NotificationAudience = "user" | "admins" | "all";

export type NotificationType =
  | "proposal.accepted"
  | "proposal.rejected"
  | "proposal.submitted"
  | "host.approved"
  | "host.rejected"
  | "host.requested"
  | "comment.new"
  | "role.changed"
  | "contest.published"
  | "problem.published";

export interface INotification {
  audience: NotificationAudience;
  userId?: Types.ObjectId;
  type: NotificationType;
  title: string;
  body: string;
  href?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Old notifications go on their own; the bell only ever shows the recent ones.
const RETENTION_SECONDS = 60 * 24 * 60 * 60;

const notificationSchema = new Schema<INotification>(
  {
    audience: { type: String, enum: ["user", "admins", "all"], required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    type: { type: String, required: true },
    title: { type: String, required: true, trim: true, maxlength: 140 },
    body: { type: String, default: "", trim: true, maxlength: 400 },
    href: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true },
);

notificationSchema.index({ audience: 1, userId: 1, createdAt: -1 });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });

notificationSchema.set("toJSON", {
  virtuals: true,
  // See Contest.model.ts for why `ret` is typed loosely here.
  transform: (_doc, ret: any) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const NotificationModel = mongoose.models.Notification || model<INotification>("Notification", notificationSchema);
