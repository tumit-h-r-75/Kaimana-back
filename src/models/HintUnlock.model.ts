// Tracks, per user and per problem, how many AI hint tiers a learner has
// paid for — the "negative marking" side of the hint system (see
// hint.service.ts). Unlocking further tiers costs a percentage of the
// problem's basePoints, forfeited from that problem's score the same way a
// wrong answer on a university admission test costs marks.
//
// One document per (userId, problemId) pair, created lazily on first hint
// request and updated in place as more tiers unlock — never deleted, so a
// learner can't reset their penalty by re-requesting hints after a reload.

import mongoose, { model, Schema, Types } from "mongoose";

export interface IHintUnlock {
  userId: Types.ObjectId;
  problemId: Types.ObjectId;
  // How many hint tiers (0-3) have been paid for on this problem so far.
  unlockedTier: number;
  // Cumulative percentage of basePoints forfeited — the sum of each
  // unlocked tier's cost (see hint.service.ts's HINT_TIER_COSTS). Read by
  // scoring.ts's computeScore() when a submission for this problem is
  // judged, so the penalty follows the learner to every attempt.
  penaltyPercent: number;
  createdAt: Date;
  updatedAt: Date;
}

const hintUnlockSchema = new Schema<IHintUnlock>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    problemId: { type: Schema.Types.ObjectId, ref: "Problem", required: true, index: true },
    unlockedTier: { type: Number, default: 0, min: 0, max: 3 },
    penaltyPercent: { type: Number, default: 0, min: 0, max: 100 },
  },
  { timestamps: true },
);

// One unlock record per learner per problem.
hintUnlockSchema.index({ userId: 1, problemId: 1 }, { unique: true });

export const HintUnlockModel = mongoose.models.HintUnlock || model<IHintUnlock>("HintUnlock", hintUnlockSchema);
