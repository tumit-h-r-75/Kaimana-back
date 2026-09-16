// Mongoose schema and model for the first-solve gem payout ledger.

import mongoose, { model, Schema, Types } from "mongoose";

// One row per (user, problem) whose first-solve gems have been paid. The
// unique index is what makes the payout exactly-once: when two ACCEPTED
// submissions for the same problem are judged at the same moment, both try
// to insert this row, the database lets exactly one through, and only that
// one credits the user's balance (see submission/gems.service.ts, which
// writes the row and the balance change in one transaction).
export interface IGemAward {
  userId: Types.ObjectId;
  problemId: Types.ObjectId;
  submissionId?: Types.ObjectId;
  gems: number;
  createdAt: Date;
  updatedAt: Date;
}

const gemAwardSchema = new Schema<IGemAward>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    problemId: { type: Schema.Types.ObjectId, ref: "Problem", required: true },
    submissionId: { type: Schema.Types.ObjectId, ref: "Submission" },
    gems: { type: Number, required: true, min: 0 },
  },
  { timestamps: true },
);

gemAwardSchema.index({ userId: 1, problemId: 1 }, { unique: true });

export const GemAwardModel = mongoose.models.GemAward || model<IGemAward>("GemAward", gemAwardSchema);
