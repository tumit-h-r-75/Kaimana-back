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
    input: { type: String, required: true },
    expectedOutput: { type: String, required: true },
    isSample: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);

testCaseSchema.index({ problemId: 1, order: 1 });

export const TestCaseModel = mongoose.models.TestCase || model<ITestCase>("TestCase", testCaseSchema);
