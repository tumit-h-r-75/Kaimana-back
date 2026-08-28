import { config } from "../../config/env.js";
import { AppError } from "../../utils/errors.js";

const allowedLanguages = new Set(["javascript", "typescript", "python", "cpp"]);

// Judge-facing languages only: Python, C++, JavaScript (matches project scope).
export type JudgeLanguage = "python" | "cpp" | "javascript";

// Piston's public runtime catalogue identifies C++ as "c++" (with a "cpp"
// alias), so this map keeps our internal language ids stable even if the
// underlying runner's naming changes.
const pistonLanguageMap: Record<JudgeLanguage, string> = {
  python: "python",
  cpp: "cpp",
  javascript: "javascript",
};

interface PistonRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
}

interface PistonResponse {
  language: string;
  version: string;
  run: PistonRunResult;
  compile?: PistonRunResult;
}

const callPiston = async (body: Record<string, unknown>): Promise<PistonResponse> => {
  const baseUrl = config.pistonUrl.replace(/\/$/, "");
  let response: globalThis.Response;
  try {
    response = await fetch(`${baseUrl}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AppError("Code runner is temporarily unavailable.", 503);
  }
  const result = await response.json();
  if (!response.ok) throw new AppError(result.message ?? "Code execution failed.", response.status);
  return result as PistonResponse;
};

export const executeCode = async ({ language, source, stdin = "" }: { language: string; source: string; stdin?: string }) => {
  if (!allowedLanguages.has(language)) throw new AppError("Unsupported language.", 400);
  if (!source.trim() || source.length > 20_000 || stdin.length > 5_000) throw new AppError("Code or input is outside the allowed limit.", 400);
  return callPiston({ language, version: "*", files: [{ content: source }], stdin, run_timeout: 3000, compile_timeout: 10000 });
};

export interface JudgeRunOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  compileError: string | null;
  runtimeMs: number;
}

// Runs one submission's code against a single test case's stdin, for the
// judge pipeline. Distinguishes compile errors, timeouts, and runtime
// errors so judge.service.ts can map them to the right verdict.
export const runAgainstTestCase = async (
  language: JudgeLanguage,
  source: string,
  stdin: string,
  timeLimitMs: number,
): Promise<JudgeRunOutcome> => {
  const pistonLanguage = pistonLanguageMap[language];
  if (!pistonLanguage) throw new AppError("Unsupported judge language.", 400);

  const startedAt = Date.now();
  const result = await callPiston({
    language: pistonLanguage,
    version: "*",
    files: [{ content: source }],
    stdin,
    run_timeout: timeLimitMs,
    compile_timeout: 10_000,
  });
  const runtimeMs = Date.now() - startedAt;

  if (result.compile && result.compile.code !== 0) {
    return {
      stdout: "",
      stderr: result.compile.stderr || result.compile.stdout,
      exitCode: result.compile.code,
      timedOut: false,
      compileError: result.compile.stderr || result.compile.stdout || "Compilation failed.",
      runtimeMs,
    };
  }

  const timedOut = result.run.signal === "SIGKILL" || result.run.signal === "SIGTERM";

  return {
    stdout: result.run.stdout ?? "",
    stderr: result.run.stderr ?? "",
    exitCode: result.run.code,
    timedOut,
    compileError: null,
    runtimeMs,
  };
};
