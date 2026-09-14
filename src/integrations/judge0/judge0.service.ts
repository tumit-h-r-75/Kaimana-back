import { config } from "../../config/env.js";
import { AppError } from "../../utils/errors.js";

// Allowed languages for ad-hoc "Run" and official "Submit" execution
const allowedLanguages = new Set(["javascript", "typescript", "python", "cpp"]);

// Judge-supported languages (matches core project scope)
export type JudgeLanguage = "python" | "cpp" | "javascript";

// Judge0 numeric language IDs pinned to stable interpreter/compiler versions
const languageIds: Record<string, number> = {
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

// Judge0 Status IDs (from GET /statuses):
// 1: In Queue, 2: Processing, 3: Accepted, 4: Wrong Answer
// 5: Time Limit Exceeded, 6: Compilation Error
// 7-11, 14: Runtime Errors (SIGSEGV/SIGFPE/SIGABRT/NZEC)
// 12: Memory Limit Exceeded (SIGXFSZ)
// 13: Internal Error
export const STATUS_TIME_LIMIT_EXCEEDED = 5;
export const STATUS_COMPILATION_ERROR = 6;
export const STATUS_MEMORY_LIMIT_EXCEEDED = 12;
export const RUNTIME_ERROR_STATUS_IDS = new Set([7, 8, 9, 10, 11, 14]);
export const STATUS_INTERNAL_ERROR = 13;

export const POLL_INTERVAL_MS = 700;
export const MAX_POLLS = 12;

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
    throw new AppError("Code runner is temporarily unavailable.", 503);
  }
  if (!response.ok) throw new AppError("Code execution failed.", response.status);
  let result = (await response.json()) as Judge0Result;

  let attempts = 0;
  while (result.status.id <= 2 && result.token && attempts < MAX_POLLS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    let pollResponse: globalThis.Response;
    try {
      pollResponse = await fetch(`${baseUrl}/submissions/${result.token}?base64_encoded=false`);
    } catch {
      throw new AppError("Code runner is temporarily unavailable.", 503);
    }
    if (!pollResponse.ok) throw new AppError("Code execution failed.", pollResponse.status);
    result = (await pollResponse.json()) as Judge0Result;
    attempts += 1;
  }

  if (result.status.id <= 2) throw new AppError("Code runner is taking too long to respond. Try again in a moment.", 503);
  if (result.status.id === STATUS_INTERNAL_ERROR) throw new AppError("Code runner is temporarily unavailable.", 503);

  return result;
};

const measuredRuntimeMs = (result: Judge0Result, startedAt: number): number =>
  result.time ? Math.round(parseFloat(result.time) * 1000) : Date.now() - startedAt;

// Ad-hoc "Run" against arbitrary stdin (Run button — no persisted Submission,
// no test-case comparison). Shape matches what the frontend reads
// (lib/api/submissions.ts: `{ run?: { output, stderr }, compile?: { output, stderr } }`).
export const executeCode = async ({ language, source, stdin = "" }: { language: string; source: string; stdin?: string }) => {
  if (!allowedLanguages.has(language)) throw new AppError("Unsupported language.", 400);
  if (!source.trim() || source.length > 20_000 || stdin.length > 5_000) throw new AppError("Code or input is outside the allowed limit.", 400);
  const languageId = languageIds[language];
  if (!languageId) throw new AppError("Unsupported language.", 400);

  const startedAt = Date.now();
  const result = await submitToJudge0({
    language_id: languageId,
    source_code: source,
    stdin,
    cpu_time_limit: 5,
    wall_time_limit: 10,
  });

  if (result.status.id === STATUS_COMPILATION_ERROR) {
    const output = result.compile_output ?? result.message ?? "Compilation failed.";
    return { compile: { output, stderr: output } };
  }

  const timedOutSuffix = result.status.id === STATUS_TIME_LIMIT_EXCEEDED ? "\n(Time limit exceeded)" : "";
  const stderrText = result.stderr ?? (RUNTIME_ERROR_STATUS_IDS.has(result.status.id) ? result.status.description : "");
  return { run: { output: `${result.stdout ?? ""}${timedOutSuffix}`, stderr: stderrText } };
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
export const runAgainstTestCase = async (
  language: JudgeLanguage,
  source: string,
  stdin: string,
  timeLimitMs: number,
  memoryLimitMb: number = 256,
): Promise<JudgeRunOutcome> => {
  const languageId = languageIds[language];
  if (!languageId) throw new AppError("Unsupported judge language.", 400);

  const cpuTimeLimit = Math.min(Math.max(timeLimitMs / 1000, 0.5), 15);
  const wallTimeLimit = Math.min(cpuTimeLimit + 5, 20);
  const memoryLimitKb = Math.max(memoryLimitMb, 16) * 1024;

  const startedAt = Date.now();
  const result = await submitToJudge0({
    language_id: languageId,
    source_code: source,
    stdin,
    cpu_time_limit: cpuTimeLimit,
    wall_time_limit: wallTimeLimit,
    memory_limit: memoryLimitKb,
  });
  const runtimeMs = measuredRuntimeMs(result, startedAt);
  const memoryKb = result.memory ?? 0;

  if (result.status.id === STATUS_COMPILATION_ERROR) {
    const message = result.compile_output || result.message || "Compilation failed.";
    return { stdout: "", stderr: message, exitCode: 1, timedOut: false, memoryExceeded: false, compileError: message, runtimeMs, memoryKb };
  }

  if (result.status.id === STATUS_TIME_LIMIT_EXCEEDED) {
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: null, timedOut: true, memoryExceeded: false, compileError: null, runtimeMs, memoryKb };
  }

  if (result.status.id === STATUS_MEMORY_LIMIT_EXCEEDED) {
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "Memory Limit Exceeded", exitCode: null, timedOut: false, memoryExceeded: true, compileError: null, runtimeMs, memoryKb };
  }

  if (RUNTIME_ERROR_STATUS_IDS.has(result.status.id)) {
    const message = result.stderr || result.message || result.status.description;
    return { stdout: result.stdout ?? "", stderr: message, exitCode: 1, timedOut: false, memoryExceeded: false, compileError: null, runtimeMs, memoryKb };
  }

  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: 0, timedOut: false, memoryExceeded: false, compileError: null, runtimeMs, memoryKb };
};
