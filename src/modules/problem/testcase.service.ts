// Service for managing test case CRUD operations and retrieving approved test cases.

import { Types } from "mongoose";
import { TestCaseModel } from "../../models/TestCase.model.js";
import { AppError } from "../../utils/errors.js";

interface ITestCaseInput {
  input: string;
  expectedOutput: string;
  isSample?: boolean;
  order?: number;
}

const addTestCase = async (problemId: string, payload: ITestCaseInput) => {
  if (!Types.ObjectId.isValid(problemId)) throw new AppError("Invalid problem id.", 400);
  return TestCaseModel.create({
    problemId,
    input: payload.input,
    expectedOutput: payload.expectedOutput,
    isSample: payload.isSample ?? false,
    order: payload.order ?? 0,
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
    })),
  );
};

const listTestCasesForAdmin = async (problemId: string) => {
  if (!Types.ObjectId.isValid(problemId)) throw new AppError("Invalid problem id.", 400);
  return TestCaseModel.find({ problemId }).sort({ order: 1, createdAt: 1 });
};

// Used by the judge pipeline: every test case, sample and hidden alike, in a
// stable order so verdicts and failedTest indices are reproducible.
const getTestCasesForJudging = async (problemId: string) => {
  if (!Types.ObjectId.isValid(problemId)) throw new AppError("Invalid problem id.", 400);
  const testCases = await TestCaseModel.find({ problemId }).sort({ order: 1, createdAt: 1 }).lean();
  if (!testCases.length) throw new AppError("This problem has no test cases configured yet.", 422);
  return testCases;
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
  updateTestCase,
  deleteTestCase,
};
