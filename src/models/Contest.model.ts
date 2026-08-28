// Mongoose schema and model for coding contests and schedules.

import mongoose, { model, Schema, Types } from "mongoose";

export interface IContestProblem {
  problemId: Types.ObjectId;
  points: number;
  order: number;
}

export interface IContest {
  slug: string;
  title: string;
  description: string;
  startTime: Date;
  endTime: Date;
  problems: IContestProblem[];
  isPublished: boolean;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const contestProblemSchema = new Schema<IContestProblem>(
  {
    problemId: { type: Schema.Types.ObjectId, ref: "Problem", required: true },
    points: { type: Number, default: 100 },
    order: { type: Number, default: 0 },
  },
  { _id: false },
);

const contestSchema = new Schema<IContest>(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    startTime: { type: Date, required: true, index: true },
    endTime: { type: Date, required: true, index: true },
    problems: { type: [contestProblemSchema], default: [] },
    isPublished: { type: Boolean, default: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

contestSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret: any) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const ContestModel = mongoose.models.Contest || model<IContest>("Contest", contestSchema);
