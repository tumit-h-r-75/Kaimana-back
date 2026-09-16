// Code execution judge pipeline service interacting with Judge0 and test cases.

import type { JudgeLanguage } from "../../integrations/judge0/judge0.service.js";
import { runAgainstTestCase } from "../../integrations/judge0/judge0.service.js";
import { problemService } from "../problem/problem.service.js";
import { testCaseService } from "../problem/testcase.service.js";
import type { IFailedTest, Verdict } from "../../models/Submission.model.js";
import { AppError } from "../../utils/errors.js";

// Output comparison is intentionally lenient: trailing whitespace per line,
// trailing blank lines, and CRLF/LF differences should never cause a false
// Wrong Answer (see 02-FEATURE-SPECS.md's normalize note).
export const normalizeOutput = (raw: string): string =>
  raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n+$/g, "")
    .trim();

// How many test cases run on Judge0 at once. Strictly one-by-one made a
// 5-test Python submission take ~10 s inside a single serverless request;
// small batches checked in order keep the same "stop at the first failing
// test" verdict without flooding the shared public Judge0 instance.
const JUDGE_BATCH_SIZE = 3;

// Upper bound for one judging run. A serverless function that runs out of time
// is killed mid-request with no chance to respond; giving up before that
// (between batches) returns a clean, retryable 503 instead. Nothing is stored
// for a run that never reached a verdict (see submission.controller.ts).
const JUDGE_DEADLINE_MS = 45_000;

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
  const deadline = Date.now() + JUDGE_DEADLINE_MS;

  let maxRuntimeMs = 0;
  let maxMemoryKb = 0;

  for (let start = 0; start < testCases.length; start += JUDGE_BATCH_SIZE) {
    if (Date.now() > deadline) {
      throw new AppError("Judging is taking too long right now. Please submit again in a moment.", 503);
    }
    const batch = testCases.slice(start, start + JUDGE_BATCH_SIZE);
    const outcomes = await Promise.all(
      batch.map((testCase) =>
        runAgainstTestCase(params.language, params.code, testCase.input, problem.timeLimitMs, problem.memoryLimitMb),
      ),
    );

    for (let offset = 0; offset < batch.length; offset += 1) {
      const index = start + offset;
      const testCase = batch[offset];
      const outcome = outcomes[offset];
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

      if (outcome.memoryExceeded) {
        return {
          verdict: "MEMORY_LIMIT_EXCEEDED",
          passedTests: index,
          totalTests: testCases.length,
          runtimeMs: maxRuntimeMs,
          memoryKb: maxMemoryKb,
          failedTest: {
            index,
            input: testCase.isSample ? testCase.input : "[hidden]",
            expectedOutput: testCase.isSample ? testCase.expectedOutput : "[hidden]",
            actualOutput: "(memory limit exceeded)",
            isSample: testCase.isSample,
          },
        };
      }

      if (outcome.exitCode !== 0) {
        // A crash on a hidden test must not echo the program's stderr: a
        // submission could print its stdin to stderr and exit non-zero to
        // read the hidden test data back, one test at a time.
        return {
          verdict: "RUNTIME_ERROR",
          passedTests: index,
          totalTests: testCases.length,
          runtimeMs: maxRuntimeMs,
          memoryKb: maxMemoryKb,
          errorMessage: testCase.isSample
            ? outcome.stderr.slice(0, 2000)
            : "Your program crashed on a hidden test. Error details for hidden tests are not shown.",
          failedTest: {
            index,
            input: testCase.isSample ? testCase.input : "[hidden]",
            expectedOutput: testCase.isSample ? testCase.expectedOutput : "[hidden]",
            actualOutput: testCase.isSample ? outcome.stderr.slice(0, 500) || "(runtime error)" : "[hidden]",
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
  }

  return {
    verdict: "ACCEPTED",
    passedTests: testCases.length,
    totalTests: testCases.length,
    runtimeMs: maxRuntimeMs,
    memoryKb: maxMemoryKb,
  };
};
