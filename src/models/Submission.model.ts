// Mongoose schema and model for code submissions and execution status.

import mongoose, { model, Schema, Types } from "mongoose";

export type Verdict =
  | "PENDING"
  | "RUNNING"
  | "ACCEPTED"
  | "WRONG_ANSWER"
  | "TIME_LIMIT_EXCEEDED"
  | "MEMORY_LIMIT_EXCEEDED"
  | "RUNTIME_ERROR"
  | "COMPILATION_ERROR";

export interface IFailedTest {
  index: number;
  input: string;
  expectedOutput: string;
  actualOutput: string;
  isSample: boolean;
}

export interface ISubmission {
  userId: Types.ObjectId;
  problemId: Types.ObjectId;
  contestId?: Types.ObjectId;
  language: "python" | "cpp" | "javascript";
  code: string;
  verdict: Verdict;
  passedTests: number;
  totalTests: number;
  runtimeMs: number;
  memoryKb: number;
  score: number;
  errorMessage?: string;
  failedTest?: IFailedTest;
  submittedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const failedTestSchema = new Schema<IFailedTest>(
  {
    index: { type: Number, required: true },
    input: { type: String, required: true },
    expectedOutput: { type: String, required: true },
    actualOutput: { type: String, required: true },
    isSample: { type: Boolean, required: true },
  },
  { _id: false },
);

const submissionSchema = new Schema<ISubmission>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    problemId: { type: Schema.Types.ObjectId, ref: "Problem", required: true, index: true },
    contestId: { type: Schema.Types.ObjectId, ref: "Contest" },
    language: { type: String, enum: ["python", "cpp", "javascript"], required: true },
    code: { type: String, required: true },
    verdict: {
      type: String,
      enum: [
        "PENDING",
        "RUNNING",
        "ACCEPTED",
        "WRONG_ANSWER",
        "TIME_LIMIT_EXCEEDED",
        "MEMORY_LIMIT_EXCEEDED",
        "RUNTIME_ERROR",
        "COMPILATION_ERROR",
      ],
      default: "PENDING",
      index: true,
    },
    passedTests: { type: Number, default: 0 },
    totalTests: { type: Number, default: 0 },
    runtimeMs: { type: Number, default: 0 },
    memoryKb: { type: Number, default: 0 },
    score: { type: Number, default: 0 },
    errorMessage: { type: String },
    failedTest: { type: failedTestSchema },
    submittedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

submissionSchema.index({ userId: 1, problemId: 1, createdAt: -1 });

submissionSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret: Record<string, unknown>) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const SubmissionModel = mongoose.models.Submission || model<ISubmission>("Submission", submissionSchema);
