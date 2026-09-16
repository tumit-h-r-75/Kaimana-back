// "Run" button pipeline: executes the learner's code against a problem's
// sample tests (or custom stdin) without creating a Submission, and reports
// how each sample ended so the workspace can explain the result visually.

import { runProgram, type ExecutionResult, type JudgeLanguage } from "../../integrations/judge0/judge0.service.js";
import { TestCaseModel } from "../../models/TestCase.model.js";
import { AppError } from "../../utils/errors.js";
import { problemService } from "../problem/problem.service.js";
import { normalizeOutput } from "./judge.service.js";

export type RunOutcome =
  | "PASSED"
  | "WRONG_ANSWER"
  | "NO_EXPECTED"
  | "COMPILATION_ERROR"
  | "RUNTIME_ERROR"
  | "TIME_LIMIT_EXCEEDED"
  | "MEMORY_LIMIT_EXCEEDED"
  | "SKIPPED";

export interface RunCaseResult {
  index: number;
  input: string;
  expectedOutput: string | null;
  outcome: RunOutcome;
  stdout: string;
  stderr: string;
  compileOutput: string;
  exitCode: number | null;
  timeMs: number | null;
  memoryKb: number | null;
}

export interface RunResult {
  outcome: RunOutcome;
  passed: number;
  total: number;
  cases: RunCaseResult[];
  // Pre-redesign response shape, kept so a front end deployed before this
  // change still shows output while both deployments roll out.
  run?: { output: string; stderr: string };
  compile?: { output: string; stderr: string };
}

interface RunTest {
  input: string;
  expectedOutput: string | null;
}

// Samples only — hidden tests never run (or leak) through "Run".
const MAX_RUN_CASES = 5;
const DEFAULT_TIME_LIMIT_MS = 2000;
const DEFAULT_MEMORY_LIMIT_MB = 256;

// Languages with a separate compile step — a compile error there fails every
// sample identically. Python and JavaScript have none, so their samples all
// run in parallel.
const COMPILED_LANGUAGES = new Set<JudgeLanguage>(["cpp", "typescript"]);

const FAILING_OUTCOMES = new Set<RunOutcome>(["WRONG_ANSWER", "COMPILATION_ERROR", "RUNTIME_ERROR", "TIME_LIMIT_EXCEEDED", "MEMORY_LIMIT_EXCEEDED"]);

const toCaseResult = (index: number, test: RunTest, execution: ExecutionResult): RunCaseResult => {
  let outcome: RunOutcome;
  if (execution.outcome !== "OK") outcome = execution.outcome;
  else if (test.expectedOutput === null) outcome = "NO_EXPECTED";
  else outcome = normalizeOutput(execution.stdout) === normalizeOutput(test.expectedOutput) ? "PASSED" : "WRONG_ANSWER";

  return {
    index,
    input: test.input,
    expectedOutput: test.expectedOutput,
    outcome,
    stdout: execution.stdout,
    stderr: execution.stderr,
    compileOutput: execution.compileOutput,
    exitCode: execution.exitCode,
    timeMs: execution.runtimeMs,
    memoryKb: execution.memoryKb,
  };
};

const skippedCase = (index: number, test: RunTest): RunCaseResult => ({
  index,
  input: test.input,
  expectedOutput: test.expectedOutput,
  outcome: "SKIPPED",
  stdout: "",
  stderr: "",
  compileOutput: "",
  exitCode: null,
  timeMs: null,
  memoryKb: null,
});

export const runCode = async ({
  language,
  source,
  problemId,
  stdin,
  canSeeUnpublished,
}: {
  language: JudgeLanguage;
  source: string;
  problemId?: string;
  stdin?: string;
  canSeeUnpublished: boolean;
}): Promise<RunResult> => {
  let timeLimitMs = DEFAULT_TIME_LIMIT_MS;
  let memoryLimitMb = DEFAULT_MEMORY_LIMIT_MB;
  let tests: RunTest[] = [];

  if (problemId) {
    const problem = await problemService.getProblemForJudging(problemId);
    if (!problem.isPublished && !canSeeUnpublished) throw new AppError("Problem not found.", 404);
    timeLimitMs = problem.timeLimitMs;
    memoryLimitMb = problem.memoryLimitMb;

    if (stdin === undefined) {
      const samples = (await TestCaseModel.find({ problemId, isSample: true, reviewed: { $ne: false } })
        .sort({ order: 1, createdAt: 1 })
        .limit(MAX_RUN_CASES)
        .select("input expectedOutput")
        .lean()) as unknown as { input: string; expectedOutput: string }[];
      const source = samples.length ? samples : (problem.sampleTests ?? []).slice(0, MAX_RUN_CASES);
      tests = source.map(({ input, expectedOutput }) => ({ input, expectedOutput }));
    }
  }
  if (stdin !== undefined || !tests.length) tests = [{ input: stdin ?? "", expectedOutput: null }];

  const execute = async (test: RunTest, index: number) =>
    toCaseResult(index, test, await runProgram({ language, source, stdin: test.input, timeLimitMs, memoryLimitMb }));

  let cases: RunCaseResult[];
  if (COMPILED_LANGUAGES.has(language)) {
    // The first sample runs alone: if the code doesn't compile, every other
    // sample would fail the same way, so they're skipped instead of queued.
    const first = await execute(tests[0], 0);
    const rest =
      first.outcome === "COMPILATION_ERROR"
        ? tests.slice(1).map((test, offset) => skippedCase(offset + 1, test))
        : await Promise.all(tests.slice(1).map((test, offset) => execute(test, offset + 1)));
    cases = [first, ...rest];
  } else {
    cases = await Promise.all(tests.map((test, index) => execute(test, index)));
  }
  const first = cases[0];

  const firstFailure = cases.find((item) => FAILING_OUTCOMES.has(item.outcome));
  const outcome: RunOutcome = firstFailure?.outcome ?? (cases.every((item) => item.outcome === "PASSED") ? "PASSED" : "NO_EXPECTED");

  return {
    outcome,
    passed: cases.filter((item) => item.outcome === "PASSED").length,
    total: cases.length,
    cases,
    ...(first.outcome === "COMPILATION_ERROR"
      ? { compile: { output: first.compileOutput, stderr: first.compileOutput } }
      : { run: { output: first.stdout, stderr: first.stderr } }),
  };
};

export const runService = { runCode };
