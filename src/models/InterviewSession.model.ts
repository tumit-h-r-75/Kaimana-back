// Mongoose schema and model for mock interview sessions and transcripts.

import mongoose, { model, Schema, Types } from "mongoose";

export interface IInterviewMessage {
  role: "interviewer" | "candidate";
  content: string;
  createdAt: Date;
}

export interface IInterviewSession {
  userId: Types.ObjectId;
  topic: string;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  status: "in_progress" | "completed";
  messages: IInterviewMessage[];
  feedback?: string;
  score?: number;
  createdAt: Date;
  updatedAt: Date;
}

const interviewMessageSchema = new Schema<IInterviewMessage>(
  {
    role: { type: String, enum: ["interviewer", "candidate"], required: true },
    content: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const interviewSessionSchema = new Schema<IInterviewSession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    topic: { type: String, required: true, trim: true },
    difficulty: { type: String, enum: ["EASY", "MEDIUM", "HARD"], required: true },
    status: { type: String, enum: ["in_progress", "completed"], default: "in_progress", index: true },
    messages: { type: [interviewMessageSchema], default: [] },
    feedback: { type: String },
    score: { type: Number, min: 0, max: 10 },
  },
  { timestamps: true },
);

interviewSessionSchema.index({ userId: 1, createdAt: -1 });

interviewSessionSchema.set("toJSON", {
  virtuals: true,
  // See Contest.model.ts for why `ret` is typed loosely here — Mongoose's
  // own toJSON transform type doesn't satisfy Record<string, unknown>
  // under this codebase's TS config.
  transform: (_doc, ret: any) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const InterviewSessionModel =
  mongoose.models.InterviewSession || model<IInterviewSession>("InterviewSession", interviewSessionSchema);
