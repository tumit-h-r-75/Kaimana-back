// Mongoose schema and model for AI analysis reports.
//
// A lightweight, append-only record created whenever an AI feature
// finishes grading something a user did — today that's just a completed
// mock interview (see interview.service.ts). `type` is an enum rather
// than being hardcoded to "interview" so a future AI feature (e.g. an AI
// code review of a submission) can reuse the same collection instead of
// growing its own bespoke one.
//
// Kept separate from the feature's own "live" document
// (InterviewSession) on purpose: InterviewSession.messages can grow large
// over a long conversation, so listing "my past AI feedback" against that
// collection would mean loading every transcript just to show a one-line
// summary. AIReport stores only the parts worth listing cheaply
// (topic/difficulty/score/summary), so interview.service.ts's
// listSessions() can join against it without ever touching `messages`.

import mongoose, { model, Schema, Types } from "mongoose";

export type AIReportType = "interview";

export interface IAIReport {
  userId: Types.ObjectId;
  type: AIReportType;
  sourceId: Types.ObjectId;
  topic: string;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  score?: number;
  summary: string;
  createdAt: Date;
  updatedAt: Date;
}

const aiReportSchema = new Schema<IAIReport>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, enum: ["interview"], required: true },
    sourceId: { type: Schema.Types.ObjectId, required: true, index: true },
    topic: { type: String, required: true, trim: true },
    difficulty: { type: String, enum: ["EASY", "MEDIUM", "HARD"], required: true },
    score: { type: Number, min: 0, max: 10 },
    summary: { type: String, required: true, trim: true, maxlength: 4000 },
  },
  { timestamps: true },
);

aiReportSchema.index({ userId: 1, createdAt: -1 });

aiReportSchema.set("toJSON", {
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

export const AIReportModel = mongoose.models.AIReport || model<IAIReport>("AIReport", aiReportSchema);
