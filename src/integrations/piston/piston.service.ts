import { config } from "../../config/env.js";
import { AppError } from "../../utils/errors.js";

const allowedLanguages = new Set(["javascript", "typescript", "python"]);

export const executeCode = async ({ language, source, stdin = "" }: { language: string; source: string; stdin?: string }) => {
  if (!allowedLanguages.has(language)) throw new AppError("Unsupported language.", 400);
  if (!source.trim() || source.length > 20_000 || stdin.length > 5_000) throw new AppError("Code or input is outside the allowed limit.", 400);
  if (!config.pistonUrl || config.pistonUrl.includes("localhost")) {
    throw new AppError("Code runner is not configured. Set PISTON_URL to a deployed Piston-compatible runner.", 503);
  }
  const baseUrl = config.pistonUrl.replace(/\/$/, "");
  let response: globalThis.Response;
  try { response = await fetch(`${baseUrl}/execute`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ language, version: "*", files: [{ content: source }], stdin, run_timeout: 3000, compile_timeout: 10000 }) }); } catch { throw new AppError("Code runner is temporarily unavailable.", 503); }
  const result = await response.json();
  if (!response.ok) throw new AppError(result.message ?? "Code execution failed.", response.status);
  return result;
};
