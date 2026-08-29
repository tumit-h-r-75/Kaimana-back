import { config } from "../../config/env.js";
import { AppError } from "../../utils/errors.js";

// The free public Piston API (emkc.org) went whitelist-only on 2026-02-15,
// and the whitelist explicitly excludes portfolio/personal projects — so
// this integration now targets Judge0 instead, defaulting to its free
// public demo instance (ce.judge0.com, no API key required). Set
// JUDGE0_URL to point at a self-hosted Judge0 (or RapidAPI-fronted)
// instance for higher/more reliable limits; see config/env.ts.

const allowedLanguages = new Set(["javascript", "typescript", "python", "cpp"]);

// Judge-facing languages only: Python, C++, JavaScript (matches project scope).
export type JudgeLanguage = "python" | "cpp" | "javascript";

// Judge0 identifies runtimes by a numeric language_id rather than a name, and
// that id is tied to a specific interpreter/compiler version. Pinned here (via
// GET /languages on the public instance) to recent, stable versions rather
// than baked into every call site.
const languageIds: Record<string, number> = {
  python: 109, // Python (3.13.2)
  cpp: 105, // C++ (GCC 14.1.0)
  javascript: 102, // JavaScript (Node.js 22.08.0)
  typescript: 101, // TypeScript (5.6.2) — "Run" only, not judge-supported
};

interface Judge0Status {
  id: number;
  description: string;
}

interface Judge0Result {
  token?: string;
  stdout: string | null;
  stderr: string | null;
  compile_output: string | null;
  message: string | null;
  time: string | null;
  memory: number | null;
  status: Judge0Status;
}

// Judge0 status ids (from GET /statuses on the public instance):
// 1 In Queue, 2 Processing, 3 Accepted, 4 Wrong Answer, 5 Time Limit Exceeded,
// 6 Compilation Error, 7-12 Runtime Error (SIGSEGV/SIGXFSZ/SIGFPE/SIGABRT/
// NZEC/Other), 13 Internal Error, 14 Exec Format Error.
const STATUS_TIME_LIMIT_EXCEEDED = 5;
const STATUS_COMPILATION_ERROR = 6;
const RUNTIME_ERROR_STATUS_IDS = new Set([7, 8, 9, 10, 11, 12, 14]);
const STATUS_INTERNAL_ERROR = 13;

const POLL_INTERVAL_MS = 700;
const MAX_POLLS = 12;

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
  compileError: string | null;
  runtimeMs: number;
  memoryKb: number;
}

// Runs one submission's code against a single test case's stdin, for the
// judge pipeline. Distinguishes compile errors, timeouts, and runtime
// errors so judge.service.ts can map them to the right verdict. We never
// send `expected_output` to Judge0 — judge.service.ts does its own lenient
// whitespace-tolerant comparison, so a plain "Accepted" here just means
// "ran to completion with exit code 0", not "matched the expected output".
export const runAgainstTestCase = async (
  language: JudgeLanguage,
  source: string,
  stdin: string,
  timeLimitMs: number,
): Promise<JudgeRunOutcome> => {
  const languageId = languageIds[language];
  if (!languageId) throw new AppError("Unsupported judge language.", 400);

  // cpuTimeLimit must respect the problem's configured limit closely (a 1s
  // floor here used to make any sub-second time limit unenforceable — a
  // solution that should TLE at 500ms would get a full second and pass) and
  // must never exceed wallTimeLimit's own cap, or Judge0 rejects the pair as
  // invalid — the problem admin form allows any positive ms value with no
  // upper bound, so both ends need clamping independently.
  const cpuTimeLimit = Math.min(Math.max(timeLimitMs / 1000, 0.5), 15);
  const wallTimeLimit = Math.min(cpuTimeLimit + 5, 20);

  const startedAt = Date.now();
  const result = await submitToJudge0({
    language_id: languageId,
    source_code: source,
    stdin,
    cpu_time_limit: cpuTimeLimit,
    wall_time_limit: wallTimeLimit,
  });
  const runtimeMs = measuredRuntimeMs(result, startedAt);
  const memoryKb = result.memory ?? 0;

  if (result.status.id === STATUS_COMPILATION_ERROR) {
    const message = result.compile_output || result.message || "Compilation failed.";
    return { stdout: "", stderr: message, exitCode: 1, timedOut: false, compileError: message, runtimeMs, memoryKb };
  }

  if (result.status.id === STATUS_TIME_LIMIT_EXCEEDED) {
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: null, timedOut: true, compileError: null, runtimeMs, memoryKb };
  }

  if (RUNTIME_ERROR_STATUS_IDS.has(result.status.id)) {
    const message = result.stderr || result.message || result.status.description;
    return { stdout: result.stdout ?? "", stderr: message, exitCode: 1, timedOut: false, compileError: null, runtimeMs, memoryKb };
  }

  // Accepted (3), or Wrong Answer (4) — unreachable since we never pass
  // expected_output, kept only as a defensive fallback — both mean the
  // program ran to completion with exit code 0.
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: 0, timedOut: false, compileError: null, runtimeMs, memoryKb };
};
