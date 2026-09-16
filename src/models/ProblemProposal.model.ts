// Mongoose schema and model for problem proposals: a learner with enough gems
// suggests a new problem (statement, limits and test cases), and an admin
// accepts it into the problem library or rejects it (see modules/proposal).

import mongoose, { model, Schema, Types } from "mongoose";
import type { Difficulty } from "./Problem.model.js";

export type ProblemProposalStatus = "pending" | "accepted" | "rejected";
export type ProposalLanguage = "python" | "cpp" | "javascript" | "typescript";

export interface IProposalTestCase {
  input: string;
  expectedOutput: string;
  explanation?: string;
  isSample: boolean;
}

export interface IProblemProposal {
  userId: Types.ObjectId;
  title: string;
  statement: string;
  inputFormat: string;
  outputFormat: string;
  constraints: string;
  difficulty: Difficulty;
  tags: string[];
  timeLimitMs: number;
  memoryLimitMb: number;
  testCases: IProposalTestCase[];
  starterCode: Partial<Record<ProposalLanguage, string>>;
  referenceSolution?: { language: ProposalLanguage; code: string };
  noteToReviewer: string;
  status: ProblemProposalStatus;
  // When the proposal last entered the review queue: on creation, and again
  // when an edited rejected proposal is sent back for review.
  submittedAt: Date;
  reviewNote?: string;
  reviewedBy?: Types.ObjectId;
  reviewedAt?: Date;
  // The problem created when the proposal was accepted.
  problemId?: Types.ObjectId;
  // Gem accounting (see modules/proposal): every time the proposal is sent
  // for review it costs PROPOSAL_COST_GEMS. `pendingCharge` is what the
  // current review was paid with — refunded in full if the author deletes the
  // proposal before review, half if it's rejected, and kept if it's accepted.
  gemsSpent: number;
  gemsRefunded: number;
  pendingCharge: number;
  createdAt: Date;
  updatedAt: Date;
}

// Not `required: true` for the same reason as TestCase.model.ts: an empty
// input or expected output is a legitimate test case.
const proposalTestCaseSchema = new Schema<IProposalTestCase>(
  {
    input: { type: String, default: "" },
    expectedOutput: { type: String, default: "" },
    explanation: { type: String },
    isSample: { type: Boolean, default: false },
  },
  { _id: false },
);

const problemProposalSchema = new Schema<IProblemProposal>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true, trim: true },
    statement: { type: String, required: true },
    inputFormat: { type: String, default: "" },
    outputFormat: { type: String, default: "" },
    constraints: { type: String, default: "" },
    difficulty: { type: String, enum: ["EASY", "MEDIUM", "HARD"], required: true },
    tags: { type: [String], default: [] },
    timeLimitMs: { type: Number, default: 2000 },
    memoryLimitMb: { type: Number, default: 256 },
    testCases: { type: [proposalTestCaseSchema], default: [] },
    starterCode: {
      python: { type: String, default: "" },
      cpp: { type: String, default: "" },
      javascript: { type: String, default: "" },
      typescript: { type: String, default: "" },
    },
    referenceSolution: {
      language: { type: String, enum: ["python", "cpp", "javascript", "typescript"] },
      code: { type: String },
    },
    noteToReviewer: { type: String, default: "" },
    status: { type: String, enum: ["pending", "accepted", "rejected"], default: "pending" },
    submittedAt: { type: Date, default: Date.now },
    reviewNote: { type: String },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    reviewedAt: { type: Date },
    problemId: { type: Schema.Types.ObjectId, ref: "Problem" },
    gemsSpent: { type: Number, default: 0, min: 0 },
    gemsRefunded: { type: Number, default: 0, min: 0 },
    pendingCharge: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

// A learner's own proposals, newest first (profile page).
problemProposalSchema.index({ userId: 1, createdAt: -1 });
// Admin review queue: newest first within a status.
problemProposalSchema.index({ status: 1, submittedAt: -1 });

export const ProblemProposalModel =
  mongoose.models.ProblemProposal || model<IProblemProposal>("ProblemProposal", problemProposalSchema);
