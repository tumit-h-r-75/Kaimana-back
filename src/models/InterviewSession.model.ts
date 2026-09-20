// Mongoose schema and model for mock interview sessions and transcripts.

import mongoose, { model, Schema, Types } from "mongoose";

/** How the interviewer judged the answer it was replying to. */
export type InterviewVerdict = "correct" | "partial" | "incorrect";

export interface IInterviewMessage {
  role: "interviewer" | "candidate";
  /** The question, or the candidate's answer. Never the assessment. */
  content: string;
  /**
   * Set on interviewer turns that followed an answer. Splitting it out of
   * `content` is what lets the transcript show a verdict beside the answer
   * it belongs to, and what makes "which questions did they get right"
   * answerable without re-reading prose.
   */
  verdict?: InterviewVerdict;
  assessment?: string;
  createdAt: Date;
}

/**
 * The closing score, broken into the things an interview is actually
 * judged on. A single number out of ten tells a candidate nothing they can
 * act on; four tells them which one to work on.
 */
export interface IInterviewRubric {
  correctness: number;
  approach: number;
  complexity: number;
  communication: number;
}

export interface IInterviewSession {
  userId: Types.ObjectId;
  topic: string;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  // How many questions the candidate answers before the interview closes
  // out with feedback — chosen on the start form (see interview.service.ts's
  // MIN/MAX/DEFAULT_TOTAL_QUESTIONS), stored per-session so a session
  // already in progress isn't affected by the user changing the default
  // later.
  totalQuestions: number;
  status: "in_progress" | "completed";
  messages: IInterviewMessage[];
  feedback?: string;
  score?: number;
  rubric?: IInterviewRubric;
  createdAt: Date;
  updatedAt: Date;
}

const interviewMessageSchema = new Schema<IInterviewMessage>(
  {
    role: { type: String, enum: ["interviewer", "candidate"], required: true },
    content: { type: String, required: true },
    verdict: { type: String, enum: ["correct", "partial", "incorrect"] },
    assessment: { type: String },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const interviewSessionSchema = new Schema<IInterviewSession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    topic: { type: String, required: true, trim: true },
    difficulty: { type: String, enum: ["EASY", "MEDIUM", "HARD"], required: true },
    totalQuestions: { type: Number, required: true, default: 5, min: 1, max: 15 },
    status: { type: String, enum: ["in_progress", "completed"], default: "in_progress", index: true },
    messages: { type: [interviewMessageSchema], default: [] },
    feedback: { type: String },
    score: { type: Number, min: 0, max: 10 },
    rubric: {
      correctness: { type: Number, min: 0, max: 10 },
      approach: { type: Number, min: 0, max: 10 },
      complexity: { type: Number, min: 0, max: 10 },
      communication: { type: Number, min: 0, max: 10 },
    },
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
