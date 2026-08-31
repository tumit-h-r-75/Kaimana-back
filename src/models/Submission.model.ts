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

export interface IScalingDataPoint {
  size: number;
  runtimeMs: number;
  memoryKb: number;
}

// Complexity Auditor (F4) report — populated by POST /api/ai/audit and
// cached on the submission (see audit.service.ts) so re-opening the panel
// never re-runs Judge0/Claude for the same code.
export interface IComplexityReport {
  timeComplexity: string;
  spaceComplexity: string;
  confidence: "low" | "medium" | "high";
  scalingData: IScalingDataPoint[];
  explanation: string;
  generatedAt: Date;
}

// Code Refactor Recommendations (F5) — populated by POST /api/ai/refactor
// on an Accepted submission. `refactoredCode` is the full rewritten file
// (not a text diff): the frontend renders the before/after comparison
// with Monaco's own DiffEditor, which needs complete original/modified
// text rather than a precomputed diff string. `isVerified` only flips to
// true once POST /api/ai/refactor/verify has re-run this exact stored
// code against every one of the problem's test cases and confirmed it
// still gets a clean ACCEPTED (see refactor.service.ts).
export interface IRefactorSuggestion {
  title: string;
  rationale: string;
  refactoredCode: string;
  isVerified: boolean;
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
  complexityReport?: IComplexityReport;
  refactorSuggestions?: IRefactorSuggestion[];
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

const scalingDataPointSchema = new Schema<IScalingDataPoint>(
  {
    size: { type: Number, required: true },
    runtimeMs: { type: Number, required: true },
    memoryKb: { type: Number, required: true },
  },
  { _id: false },
);

const complexityReportSchema = new Schema<IComplexityReport>(
  {
    timeComplexity: { type: String, required: true },
    spaceComplexity: { type: String, required: true },
    confidence: { type: String, enum: ["low", "medium", "high"], required: true },
    scalingData: { type: [scalingDataPointSchema], default: [] },
    explanation: { type: String, required: true },
    generatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const refactorSuggestionSchema = new Schema<IRefactorSuggestion>(
  {
    title: { type: String, required: true },
    rationale: { type: String, required: true },
    refactoredCode: { type: String, required: true },
    isVerified: { type: Boolean, default: false },
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
    complexityReport: { type: complexityReportSchema },
    refactorSuggestions: { type: [refactorSuggestionSchema], default: [] },
    submittedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

submissionSchema.index({ userId: 1, problemId: 1, createdAt: -1 });

submissionSchema.set("toJSON", {
  virtuals: true,
  // See Problem.model.ts for why `ret` is typed loosely here.
  transform: (_doc, ret: any) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const SubmissionModel = mongoose.models.Submission || model<ISubmission>("Submission", submissionSchema);
