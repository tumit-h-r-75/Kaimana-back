// Mongoose schema and model for submission peer reviews and comments.
//
// Despite the "Review" filename (kept for historical reasons — this file
// started life as a stub for a broader peer-review feature), this model
// currently stores just one thing: comments left on a community submission
// thread. See src/modules/community for the feature that reads/writes it.

import mongoose, { model, Schema, Types } from "mongoose";

export interface IReview {
  submissionId: Types.ObjectId;
  userId: Types.ObjectId;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

const reviewSchema = new Schema<IReview>(
  {
    submissionId: { type: Schema.Types.ObjectId, ref: "Submission", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String, required: true, trim: true, maxlength: 2000 },
  },
  { timestamps: true },
);

reviewSchema.set("toJSON", {
  virtuals: true,
  // See Contest.model.ts for why `ret` is typed loosely here — Mongoose's
  // own transform type doesn't satisfy Record<string, unknown> in this
  // codebase.
  transform: (_doc, ret: any) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const ReviewModel = mongoose.models.Review || model<IReview>("Review", reviewSchema);
