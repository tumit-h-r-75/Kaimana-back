// Mongoose schema and model for problem test cases and expected outputs.

import mongoose, { model, Schema, Types } from "mongoose";

export type TestCaseSource = "manual" | "ai-generated";

export interface ITestCase {
  problemId: Types.ObjectId;
  input: string;
  expectedOutput: string;
  isSample: boolean;
  order: number;
  // Automated Test Case Generator (F10). A manually-entered case is trusted
  // the moment an admin types it in, so `reviewed` defaults true for it.
  // An `ai-generated` case starts `reviewed: false` and — critically — is
  // excluded from getTestCasesForJudging() until an admin approves it (see
  // testcase.service.ts): its expectedOutput was computed by running the
  // problem's reference solution against a Gemini-authored input, and while
  // that's a real execution rather than a guess, the *input* itself is
  // still AI-authored and unvetted, so nothing generated ever grades a
  // learner's submission before a human has looked at it.
  source: TestCaseSource;
  reviewed: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const testCaseSchema = new Schema<ITestCase>(
  {
    problemId: { type: Schema.Types.ObjectId, ref: "Problem", required: true, index: true },
    // Not `required: true`: Mongoose's built-in string required-validator
    // rejects an empty string, but "" is a legitimate value here — e.g. a
    // test case whose correct output (or input) is genuinely empty, like
    // merging two empty arrays. Both fields are still always supplied by
    // application code (testcase.service.ts, seed.ts); this only stops
    // valid empty values from being rejected at the database layer.
    input: { type: String, default: "" },
    expectedOutput: { type: String, default: "" },
    isSample: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    source: { type: String, enum: ["manual", "ai-generated"], default: "manual" },
    reviewed: { type: Boolean, default: true },
  },
  { timestamps: true },
);

testCaseSchema.index({ problemId: 1, order: 1 });

testCaseSchema.set("toJSON", {
  virtuals: true,
  // See Problem.model.ts for why `ret` is typed loosely here.
  transform: (_doc, ret: any) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const TestCaseModel = mongoose.models.TestCase || model<ITestCase>("TestCase", testCaseSchema);
