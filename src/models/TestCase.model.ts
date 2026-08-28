// Mongoose schema and model for problem test cases and expected outputs.

import mongoose, { model, Schema, Types } from "mongoose";

export interface ITestCase {
  problemId: Types.ObjectId;
  input: string;
  expectedOutput: string;
  isSample: boolean;
  order: number;
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
  },
  { timestamps: true },
);

testCaseSchema.index({ problemId: 1, order: 1 });

export const TestCaseModel = mongoose.models.TestCase || model<ITestCase>("TestCase", testCaseSchema);
