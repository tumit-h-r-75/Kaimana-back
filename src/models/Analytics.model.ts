// Mongoose schema and model for aggregated user analytics data.
//
// analytics.service.ts recomputes a user's stats live from Submission on
// every request (see getMyAnalytics) — that stays the source of truth for
// "right now" numbers, since it's always fresh. This model exists for the
// dimension a live query can't give you cheaply: a history over calendar
// days. Every call to getMyAnalytics also upserts one row here for
// "today", so getMyAnalyticsHistory() can chart problems-solved/accuracy
// trends over time without re-aggregating the entire submission history
// on every page load.

import mongoose, { model, Schema, Types } from "mongoose";

export interface IAnalyticsSnapshot {
  userId: Types.ObjectId;
  date: string; // "YYYY-MM-DD", UTC — one row per user per calendar day
  totalSubmissions: number;
  acceptedSubmissions: number;
  problemsSolved: number;
  accuracyPercent: number;
  currentStreakDays: number;
  createdAt: Date;
  updatedAt: Date;
}

const analyticsSnapshotSchema = new Schema<IAnalyticsSnapshot>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    date: { type: String, required: true },
    totalSubmissions: { type: Number, required: true, default: 0 },
    acceptedSubmissions: { type: Number, required: true, default: 0 },
    problemsSolved: { type: Number, required: true, default: 0 },
    accuracyPercent: { type: Number, required: true, default: 0 },
    currentStreakDays: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

// One snapshot per user per day — a later call the same day updates that
// day's row in place instead of piling up duplicates.
analyticsSnapshotSchema.index({ userId: 1, date: 1 }, { unique: true });

analyticsSnapshotSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret: any) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const AnalyticsSnapshotModel =
  mongoose.models.AnalyticsSnapshot || model<IAnalyticsSnapshot>("AnalyticsSnapshot", analyticsSnapshotSchema);
