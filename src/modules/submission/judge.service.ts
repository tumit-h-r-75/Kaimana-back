// Code execution judge pipeline service interacting with Judge0 and test cases.

import type { JudgeLanguage } from "../../integrations/judge0/judge0.service.js";
import { runAgainstTestCase } from "../../integrations/judge0/judge0.service.js";
import { problemService } from "../problem/problem.service.js";
import { testCaseService } from "../problem/testcase.service.js";
import type { IFailedTest, Verdict } from "../../models/Submission.model.js";

// Output comparison is intentionally lenient: trailing whitespace per line,
// trailing blank lines, and CRLF/LF differences should never cause a false
// Wrong Answer (see 02-FEATURE-SPECS.md's normalize note).
const normalizeOutput = (raw: string): string =>
  raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n+$/g, "")
    .trim();

export interface JudgeResult {
  verdict: Verdict;
  passedTests: number;
  totalTests: number;
  runtimeMs: number;
  memoryKb: number;
  errorMessage?: string;
  failedTest?: IFailedTest;
}

export const judgeSubmission = async (params: {
  problemId: string;
  language: JudgeLanguage;
  code: string;
}): Promise<JudgeResult> => {
  const problem = await problemService.getProblemForJudging(params.problemId);
  const testCases = await testCaseService.getTestCasesForJudging(params.problemId);

  let maxRuntimeMs = 0;
  let maxMemoryKb = 0;

  for (let index = 0; index < testCases.length; index += 1) {
    const testCase = testCases[index];
    const outcome = await runAgainstTestCase(params.language, params.code, testCase.input, problem.timeLimitMs);
    maxRuntimeMs = Math.max(maxRuntimeMs, outcome.runtimeMs);
    maxMemoryKb = Math.max(maxMemoryKb, outcome.memoryKb);

    if (outcome.compileError) {
      return {
        verdict: "COMPILATION_ERROR",
        passedTests: 0,
        totalTests: testCases.length,
        runtimeMs: maxRuntimeMs,
        memoryKb: maxMemoryKb,
        errorMessage: outcome.compileError.slice(0, 2000),
      };
    }

    if (outcome.timedOut) {
      return {
        verdict: "TIME_LIMIT_EXCEEDED",
        passedTests: index,
        totalTests: testCases.length,
        runtimeMs: maxRuntimeMs,
        memoryKb: maxMemoryKb,
        failedTest: {
          index,
          input: testCase.isSample ? testCase.input : "[hidden]",
          expectedOutput: testCase.isSample ? testCase.expectedOutput : "[hidden]",
          actualOutput: "(timed out)",
          isSample: testCase.isSample,
        },
      };
    }

    if (outcome.exitCode !== 0) {
      return {
        verdict: "RUNTIME_ERROR",
        passedTests: index,
        totalTests: testCases.length,
        runtimeMs: maxRuntimeMs,
        memoryKb: maxMemoryKb,
        errorMessage: outcome.stderr.slice(0, 2000),
        failedTest: {
          index,
          input: testCase.isSample ? testCase.input : "[hidden]",
          expectedOutput: testCase.isSample ? testCase.expectedOutput : "[hidden]",
          actualOutput: outcome.stderr.slice(0, 500) || "(runtime error)",
          isSample: testCase.isSample,
        },
      };
    }

    const actual = normalizeOutput(outcome.stdout);
    const expected = normalizeOutput(testCase.expectedOutput);
    if (actual !== expected) {
      return {
        verdict: "WRONG_ANSWER",
        passedTests: index,
        totalTests: testCases.length,
        runtimeMs: maxRuntimeMs,
        memoryKb: maxMemoryKb,
        failedTest: {
          index,
          input: testCase.isSample ? testCase.input : "[hidden]",
          expectedOutput: testCase.isSample ? testCase.expectedOutput : "[hidden]",
          actualOutput: testCase.isSample ? outcome.stdout.slice(0, 500) : "[hidden]",
          isSample: testCase.isSample,
        },
      };
    }
  }

  return {
    verdict: "ACCEPTED",
    passedTests: testCases.length,
    totalTests: testCases.length,
    runtimeMs: maxRuntimeMs,
    memoryKb: maxMemoryKb,
  };
};
