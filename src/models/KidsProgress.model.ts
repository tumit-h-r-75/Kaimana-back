// Code Quest (the Kaimana Kids section) progress: one document per
// (userId, levelId) holding the best star rating a learner has earned on that
// level and when they first completed it. Level ids come from the front-end
// curriculum (e.g. "meadow-first-steps"); the back end only checks their
// shape, and kids.service.ts caps how many documents one user can create.

import mongoose, { model, Schema, Types } from "mongoose";

export const KIDS_LEVEL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const KIDS_LEVEL_ID_MAX_LENGTH = 64;

export interface IKidsProgress {
  userId: Types.ObjectId;
  levelId: string;
  // Best stars earned on this level (1-3) — never lowered by a later, worse run.
  stars: number;
  // First time the level was completed — never moved by later runs.
  completedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const kidsProgressSchema = new Schema<IKidsProgress>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    levelId: { type: String, required: true, maxlength: KIDS_LEVEL_ID_MAX_LENGTH, match: KIDS_LEVEL_ID_PATTERN },
    stars: {
      type: Number,
      required: true,
      min: 1,
      max: 3,
      validate: { validator: Number.isInteger, message: "stars must be a whole number." },
    },
    completedAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// One record per learner per level. The userId prefix also serves the
// "all progress for this user" list and the per-user document count.
kidsProgressSchema.index({ userId: 1, levelId: 1 }, { unique: true });

export const KidsProgressModel = mongoose.models.KidsProgress || model<IKidsProgress>("KidsProgress", kidsProgressSchema);
