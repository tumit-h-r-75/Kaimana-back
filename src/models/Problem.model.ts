// Mongoose schema and model for coding problems and metadata.

import mongoose, { model, Schema, Types } from "mongoose";

export type Difficulty = "EASY" | "MEDIUM" | "HARD";

export interface ISampleTest {
  input: string;
  expectedOutput: string;
  explanation?: string;
}

export interface IProblem {
  slug: string;
  title: string;
  statement: string;
  inputFormat: string;
  outputFormat: string;
  constraints: string;
  difficulty: Difficulty;
  tags: string[];
  timeLimitMs: number;
  memoryLimitMb: number;
  basePoints: number;
  sampleTests: ISampleTest[];
  starterCode: {
    python?: string;
    cpp?: string;
    javascript?: string;
  };
  referenceSolution?: {
    language: "python" | "cpp" | "javascript";
    code: string;
  };
  isPublished: boolean;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const sampleTestSchema = new Schema<ISampleTest>(
  {
    input: { type: String, required: true },
    expectedOutput: { type: String, required: true },
    explanation: { type: String },
  },
  { _id: false },
);

const problemSchema = new Schema<IProblem>(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    title: { type: String, required: true, trim: true },
    statement: { type: String, required: true },
    inputFormat: { type: String, default: "" },
    outputFormat: { type: String, default: "" },
    constraints: { type: String, default: "" },
    difficulty: { type: String, enum: ["EASY", "MEDIUM", "HARD"], required: true, index: true },
    tags: { type: [String], default: [], index: true },
    timeLimitMs: { type: Number, default: 2000 },
    memoryLimitMb: { type: Number, default: 256 },
    basePoints: { type: Number, default: 100 },
    sampleTests: { type: [sampleTestSchema], default: [] },
    starterCode: {
      python: { type: String, default: "" },
      cpp: { type: String, default: "" },
      javascript: { type: String, default: "" },
    },
    referenceSolution: {
      language: { type: String, enum: ["python", "cpp", "javascript"] },
      code: { type: String },
    },
    isPublished: { type: Boolean, default: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

problemSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret: Record<string, unknown>) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    delete ret.referenceSolution;
    return ret;
  },
});

export const ProblemModel = mongoose.models.Problem || model<IProblem>("Problem", problemSchema);
