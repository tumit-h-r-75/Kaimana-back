// Service for managing test case CRUD operations and retrieving approved test cases.

import { Types } from "mongoose";
import { TestCaseModel, type TestCaseSource } from "../../models/TestCase.model.js";
import { AppError } from "../../utils/errors.js";

interface ITestCaseInput {
  input: string;
  expectedOutput: string;
  isSample?: boolean;
  order?: number;
  source?: TestCaseSource;
  reviewed?: boolean;
}

const addTestCase = async (problemId: string, payload: ITestCaseInput) => {
  if (!Types.ObjectId.isValid(problemId)) throw new AppError("Invalid problem id.", 400);
  return TestCaseModel.create({
    problemId,
    input: payload.input,
    expectedOutput: payload.expectedOutput,
    isSample: payload.isSample ?? false,
    order: payload.order ?? 0,
    source: payload.source ?? "manual",
    // A manually-entered case is trusted the moment an admin types it in;
    // only an explicit `reviewed: false` (the AI test-case generator's own
    // call path — see testgen.service.ts) leaves it pending.
    reviewed: payload.reviewed ?? true,
  });
};

const addManyTestCases = async (problemId: string, testCases: ITestCaseInput[]) => {
  if (!Types.ObjectId.isValid(problemId)) throw new AppError("Invalid problem id.", 400);
  if (!testCases.length) throw new AppError("At least one test case is required.", 400);
  return TestCaseModel.insertMany(
    testCases.map((testCase, index) => ({
      problemId,
      input: testCase.input,
      expectedOutput: testCase.expectedOutput,
      isSample: testCase.isSample ?? false,
      order: testCase.order ?? index,
      source: testCase.source ?? "manual",
      reviewed: testCase.reviewed ?? true,
    })),
  );
};

const listTestCasesForAdmin = async (problemId: string) => {
  if (!Types.ObjectId.isValid(problemId)) throw new AppError("Invalid problem id.", 400);
  return TestCaseModel.find({ problemId }).sort({ order: 1, createdAt: 1 });
};

// Used by the judge pipeline: every REVIEWED test case, sample and hidden
// alike, in a stable order so verdicts and failedTest indices are
// reproducible. `reviewed: false` cases (pending AI-generated suggestions —
// see TestCase.model.ts) are deliberately excluded: they must never affect
// a learner's verdict until an admin has approved them.
//
// The filter is `reviewed !== false` rather than `reviewed === true` on
// purpose: this query uses .lean(), which reads exactly what's stored and
// never backfills schema defaults, so every test case that already existed
// before this field was introduced has no `reviewed` key at all. Querying
// for `reviewed: true` would silently exclude all of them — every problem
// in production would look like it has zero test cases. `$ne: false`
// treats "field missing" the same as "reviewed" (correct for pre-existing,
// human-authored data) while still excluding anything explicitly marked
// `false` (freshly AI-generated, pending review).
const getTestCasesForJudging = async (problemId: string) => {
  if (!Types.ObjectId.isValid(problemId)) throw new AppError("Invalid problem id.", 400);
  const testCases = await TestCaseModel.find({ problemId, reviewed: { $ne: false } })
    .sort({ order: 1, createdAt: 1 })
    .lean();
  if (!testCases.length) throw new AppError("This problem has no test cases configured yet.", 422);
  return testCases;
};

// Used by the AI test-case generator to append new cases after whatever
// already exists, so `order` stays a stable, gap-free-ish ordering.
const countTestCases = async (problemId: string) => {
  if (!Types.ObjectId.isValid(problemId)) throw new AppError("Invalid problem id.", 400);
  return TestCaseModel.countDocuments({ problemId });
};

const updateTestCase = async (testCaseId: string, payload: Partial<ITestCaseInput>) => {
  if (!Types.ObjectId.isValid(testCaseId)) throw new AppError("Invalid test case id.", 400);
  const testCase = await TestCaseModel.findByIdAndUpdate(testCaseId, payload, { new: true });
  if (!testCase) throw new AppError("Test case not found.", 404);
  return testCase;
};

const deleteTestCase = async (testCaseId: string) => {
  if (!Types.ObjectId.isValid(testCaseId)) throw new AppError("Invalid test case id.", 400);
  const testCase = await TestCaseModel.findByIdAndDelete(testCaseId);
  if (!testCase) throw new AppError("Test case not found.", 404);
  return testCase;
};

export const testCaseService = {
  addTestCase,
  addManyTestCases,
  listTestCasesForAdmin,
  getTestCasesForJudging,
  countTestCases,
  updateTestCase,
  deleteTestCase,
};
