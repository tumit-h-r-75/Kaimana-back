import { config } from "../../config/env.js";
import { AppError } from "../../utils/errors.js";

// Code runs on Judge0 — by default its free public instance (ce.judge0.com,
// no API key; the public Piston API used before went whitelist-only in
// Feb 2026). Set JUDGE0_URL to a self-hosted or RapidAPI-fronted Judge0 for
// higher/more reliable limits (see config/env.ts).

// Languages accepted by both "Run" and "Submit".
export type JudgeLanguage = "python" | "cpp" | "javascript" | "typescript";

export const JUDGE_LANGUAGES: readonly JudgeLanguage[] = ["python", "cpp", "javascript", "typescript"];

export const isJudgeLanguage = (value: unknown): value is JudgeLanguage =>
  typeof value === "string" && (JUDGE_LANGUAGES as readonly string[]).includes(value);

// Judge0 numeric language IDs pinned to stable interpreter/compiler versions
const languageIds: Record<JudgeLanguage, number> = {
  python: 109, // Python 3.13.2
  cpp: 105, // C++ GCC 14.1.0
  javascript: 102, // JavaScript Node.js 22.08.0
  typescript: 101, // TypeScript 5.6.2
};

export interface Judge0Status {
  id: number;
  description: string;
}

export interface Judge0Result {
  token?: string;
  stdout: string | null;
  stderr: string | null;
  compile_output: string | null;
  message: string | null;
  time: string | null;
  memory: number | null;
  status: Judge0Status;
}

// Judge0 status ids (GET /statuses on the public instance): 1 In Queue,
// 2 Processing, 3 Accepted, 4 Wrong Answer, 5 Time Limit Exceeded,
// 6 Compilation Error, 7 Runtime Error (SIGSEGV), 8 (SIGXFSZ), 9 (SIGFPE),
// 10 (SIGABRT), 11 (NZEC), 12 (Other), 13 Internal Error, 14 Exec Format Error.
// There is no memory-limit status: the public instance reports almost every
// crash as 11 (NZEC), and a program that hits the memory cap is SIGKILLed
// ("Killed", exit status 137) — see classifyExecution below.
const STATUS_TIME_LIMIT_EXCEEDED = 5;
const STATUS_COMPILATION_ERROR = 6;
const RUNTIME_ERROR_STATUS_IDS = new Set([7, 8, 9, 10, 11, 12, 14]);
const STATUS_INTERNAL_ERROR = 13;

const POLL_INTERVAL_MS = 700;
const MAX_POLLS = 12;

// Any non-OK answer from Judge0 — a 429 from the shared public instance, a
// 5xx, an auth error from a misconfigured JUDGE0_URL — is an infrastructure
// failure, never a verdict on the learner's code. Passing Judge0's own status
// through used to record a rate-limited submission as a permanent RUNTIME_ERROR
// (only >= 500 counted as infra), and a 401/403 looked like an expired session
// to the front end.
const runnerUnavailable = (status?: number) =>
  new AppError(
    status === 429 ? "The code runner is busy right now. Please try again in a moment." : "Code runner is temporarily unavailable.",
    503,
  );

// POST + poll against Judge0's REST API. `wait=true` asks Judge0 to hold the
// HTTP request open until the run finishes, but on the shared public demo
// that's best-effort under load — so if it comes back still queued/
// processing, this polls the submission's token until a terminal status
// (or gives up and surfaces a 503, same as a network failure would).
const submitToJudge0 = async (body: Record<string, unknown>): Promise<Judge0Result> => {
  const baseUrl = config.judge0Url.replace(/\/$/, "");

  let response: globalThis.Response;
  try {
    response = await fetch(`${baseUrl}/submissions?base64_encoded=false&wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw runnerUnavailable();
  }
  if (!response.ok) throw runnerUnavailable(response.status);
  let result = (await response.json()) as Judge0Result;

  let attempts = 0;
  while (result.status.id <= 2 && result.token && attempts < MAX_POLLS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    let pollResponse: globalThis.Response;
    try {
      pollResponse = await fetch(`${baseUrl}/submissions/${result.token}?base64_encoded=false`);
    } catch {
      throw runnerUnavailable();
    }
    if (!pollResponse.ok) throw runnerUnavailable(pollResponse.status);
    result = (await pollResponse.json()) as Judge0Result;
    attempts += 1;
  }

  if (result.status.id <= 2) throw new AppError("Code runner is taking too long to respond. Try again in a moment.", 503);
  if (result.status.id === STATUS_INTERNAL_ERROR) throw runnerUnavailable();

  return result;
};

const measuredRuntimeMs = (result: Judge0Result, startedAt: number): number =>
  result.time ? Math.round(parseFloat(result.time) * 1000) : Date.now() - startedAt;

// Judge0 counts interpreter start-up as CPU time — about 1.1 s for both Python
// and Node on the public instance, more under load. With the raw per-problem
// limit (2 s for every seeded problem) correct Python/JavaScript solutions
// timed out even on trivial inputs, so interpreted languages get the usual
// contest-style multiplier plus a fixed start-up allowance. The 0.5 s floor
// keeps sub-second C++ limits enforceable; both caps stay below the public
// instance's maximums (20 s CPU, 30 s wall), which Judge0 rejects beyond.
const TIME_ALLOWANCE: Record<JudgeLanguage, { factor: number; startupSeconds: number }> = {
  cpp: { factor: 1, startupSeconds: 0 },
  python: { factor: 2, startupSeconds: 1.5 },
  javascript: { factor: 1.5, startupSeconds: 1.5 },
  typescript: { factor: 1.5, startupSeconds: 1.5 },
};
const MAX_CPU_TIME_LIMIT_SECONDS = 15;
const MAX_WALL_TIME_LIMIT_SECONDS = 25;
// Node and Python need ~50 MB just to start, so a tiny admin-configured limit
// must not make every submission in those languages crash.
const MIN_MEMORY_LIMIT_MB = 128;
const MAX_MEMORY_LIMIT_MB = 1024;

export const executionLimits = (language: JudgeLanguage, timeLimitMs: number, memoryLimitMb: number) => {
  const { factor, startupSeconds } = TIME_ALLOWANCE[language];
  const cpuTimeLimit = Math.min(Math.max((timeLimitMs / 1000) * factor + startupSeconds, 0.5), MAX_CPU_TIME_LIMIT_SECONDS);
  const wallTimeLimit = Math.min(cpuTimeLimit + 5, MAX_WALL_TIME_LIMIT_SECONDS);
  const memoryLimitKb = Math.min(Math.max(memoryLimitMb || 256, MIN_MEMORY_LIMIT_MB), MAX_MEMORY_LIMIT_MB) * 1024;
  return { cpuTimeLimit, wallTimeLimit, memoryLimitKb };
};

// Judge0 compiles TypeScript with a bare tsc (no @types/node), so the usual
// `require('fs')` / `process.stdin` input handling failed to compile with
// "Cannot find name 'require'". Declare whichever of those globals the
// learner didn't declare themselves on an extra first line (declaring one
// twice is a "Duplicate identifier" error), then shift compiler line numbers
// back so they still point at the learner's own code.
const TYPESCRIPT_NODE_GLOBALS = ["require", "process"];

// That tsc also defaults to an ES5 target, where Map, Set, String#includes,
// Object.entries and friends don't exist — ordinary modern solutions failed to
// compile. es2020 is the newest target/lib the public instance's compiler
// accepts (it rejects es2021+); the code then runs on Node 20, which supports it.
const TYPESCRIPT_COMPILER_OPTIONS = "--target es2020 --lib es2020,dom";

const prepareSource = (language: JudgeLanguage, source: string) => {
  if (language !== "typescript") return { source, lineOffset: 0 };
  const undeclared = TYPESCRIPT_NODE_GLOBALS.filter((name) => !new RegExp(`\\bdeclare\\s+(?:var|let|const|function)\\s+${name}\\b`).test(source));
  if (!undeclared.length) return { source, lineOffset: 0 };
  return { source: `declare var ${undeclared.map((name) => `${name}: any`).join(", ")};\n${source}`, lineOffset: 1 };
};

const shiftTypeScriptLines = (text: string, lineOffset: number) =>
  lineOffset ? text.replace(/script\.ts\((\d+),(\d+)\)/g, (_match, line, column) => `script.ts(${Math.max(Number(line) - lineOffset, 1)},${column})`) : text;

// Crashes reported by the shell look like
// "run.sh: line 1:     3 Segmentation fault      (core dumped) ./a.out";
// keep just the part a learner can read. Only those lines are touched, so a
// Python traceback's indentation survives.
const cleanStderr = (stderr: string) =>
  stderr.replace(/^run\.sh: line \d+:\s+\d+\s+(.*)$/gm, (_match, rest: string) => rest.replace(/\s{2,}/g, " ").trim());

const exitCodeOf = (result: Judge0Result): number | null => {
  if (result.status.id === 3 || result.status.id === 4) return 0;
  const match = result.message?.match(/status (\d+)/);
  return match ? Number(match[1]) : null;
};

export type ExecutionOutcome = "OK" | "COMPILATION_ERROR" | "RUNTIME_ERROR" | "TIME_LIMIT_EXCEEDED" | "MEMORY_LIMIT_EXCEEDED";

const OUT_OF_MEMORY_PATTERN = /\bMemoryError\b|std::bad_alloc|heap out of memory|Cannot allocate memory/;

const classifyExecution = (result: Judge0Result, exitCode: number | null, memoryLimitKb: number): ExecutionOutcome => {
  const statusId = result.status.id;
  if (statusId === STATUS_COMPILATION_ERROR) return "COMPILATION_ERROR";
  if (statusId === STATUS_TIME_LIMIT_EXCEEDED) return "TIME_LIMIT_EXCEEDED";
  if (!RUNTIME_ERROR_STATUS_IDS.has(statusId)) return "OK";
  const stderr = result.stderr ?? "";
  const killedAtMemoryCap = (exitCode === 137 || /\bKilled\b/.test(stderr)) && (result.memory ?? 0) >= memoryLimitKb * 0.9;
  return killedAtMemoryCap || OUT_OF_MEMORY_PATTERN.test(stderr) ? "MEMORY_LIMIT_EXCEEDED" : "RUNTIME_ERROR";
};

export interface ExecutionResult {
  outcome: ExecutionOutcome;
  stdout: string;
  stderr: string;
  compileOutput: string;
  exitCode: number | null;
  runtimeMs: number;
  memoryKb: number;
}

// Runs code once against the given stdin and classifies how it ended. Shared
// by the judge (runAgainstTestCase) and the workspace's Run button.
export const runProgram = async ({
  language,
  source,
  stdin,
  timeLimitMs,
  memoryLimitMb,
}: {
  language: JudgeLanguage;
  source: string;
  stdin: string;
  timeLimitMs: number;
  memoryLimitMb: number;
}): Promise<ExecutionResult> => {
  const { cpuTimeLimit, wallTimeLimit, memoryLimitKb } = executionLimits(language, timeLimitMs, memoryLimitMb);
  const prepared = prepareSource(language, source);

  const startedAt = Date.now();
  const result = await submitToJudge0({
    language_id: languageIds[language],
    source_code: prepared.source,
    stdin,
    cpu_time_limit: cpuTimeLimit,
    wall_time_limit: wallTimeLimit,
    memory_limit: memoryLimitKb,
    ...(language === "typescript" ? { compiler_options: TYPESCRIPT_COMPILER_OPTIONS } : {}),
  });
  const exitCode = exitCodeOf(result);

  return {
    outcome: classifyExecution(result, exitCode, memoryLimitKb),
    stdout: result.stdout ?? "",
    stderr: cleanStderr(shiftTypeScriptLines(result.stderr ?? "", prepared.lineOffset)),
    compileOutput: shiftTypeScriptLines(result.compile_output ?? "", prepared.lineOffset),
    exitCode,
    runtimeMs: measuredRuntimeMs(result, startedAt),
    memoryKb: result.memory ?? 0,
  };
};

export interface JudgeRunOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  memoryExceeded: boolean;
  compileError: string | null;
  runtimeMs: number;
  memoryKb: number;
}

// Runs one submission's code against a single test case's stdin, for the
// judge pipeline. Distinguishes compile errors, timeouts, memory limit overruns,
// and runtime errors so judge.service.ts can map them to the right verdict.
// We never send `expected_output` to Judge0 — judge.service.ts does its own
// whitespace-tolerant comparison, so exitCode 0 here only means "ran to
// completion", not "matched the expected output".
export const runAgainstTestCase = async (
  language: JudgeLanguage,
  source: string,
  stdin: string,
  timeLimitMs: number,
  memoryLimitMb: number = 256,
): Promise<JudgeRunOutcome> => {
  if (!isJudgeLanguage(language)) throw new AppError("Unsupported judge language.", 400);

  const execution = await runProgram({ language, source, stdin, timeLimitMs, memoryLimitMb });
  const base = { stdout: execution.stdout, runtimeMs: execution.runtimeMs, memoryKb: execution.memoryKb };

  switch (execution.outcome) {
    case "COMPILATION_ERROR": {
      const message = execution.compileOutput || execution.stderr || "Compilation failed.";
      return { ...base, stdout: "", stderr: message, exitCode: 1, timedOut: false, memoryExceeded: false, compileError: message };
    }
    case "TIME_LIMIT_EXCEEDED":
      return { ...base, stderr: execution.stderr, exitCode: null, timedOut: true, memoryExceeded: false, compileError: null };
    case "MEMORY_LIMIT_EXCEEDED":
      return { ...base, stderr: execution.stderr || "Memory limit exceeded.", exitCode: null, timedOut: false, memoryExceeded: true, compileError: null };
    case "RUNTIME_ERROR":
      return {
        ...base,
        stderr: execution.stderr || `Exited with status ${execution.exitCode ?? "unknown"}.`,
        exitCode: execution.exitCode || 1,
        timedOut: false,
        memoryExceeded: false,
        compileError: null,
      };
    default:
      return { ...base, stderr: execution.stderr, exitCode: 0, timedOut: false, memoryExceeded: false, compileError: null };
  }
};
