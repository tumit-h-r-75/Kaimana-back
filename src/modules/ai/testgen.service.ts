// AI service for the Automated Test Case Generator (F10).
//
// The one thing this deliberately does NOT trust Gemini for is the
// expected output. Gemini is asked for INPUTS only — edge, random,
// adversarial, and boundary cases inferred from the problem's statement
// and constraints — and every generated input is then actually executed
// against the problem's own reference solution through the same Judge0
// pipeline the judge itself uses (runAgainstTestCase). The reference
// solution's real stdout becomes the expectedOutput, so a generated test
// case is only ever as wrong as the reference solution already was — never
// wrong because a language model "guessed" an output. An input the
// reference solution itself can't run (compile error, timeout, non-zero
// exit) is dropped rather than stored, since a broken input is not useful
// to keep around, reviewed or not.
//
// Every surviving case is still inserted with reviewed: false (see
// TestCase.model.ts / testcase.service.ts) — it never affects grading
// until an admin explicitly approves it via PATCH .../testcases/:id.
//
// No rule-based Plan-B, matching refactor.service.ts's reasoning: turning
// a constraints paragraph into meaningful edge/adversarial cases needs
// real language understanding, not string munging. Without
// GEMINI_API_KEY this returns zero generated cases with an explicit
// "unavailable" reason.

import { Types } from "mongoose";
import { TestCaseModel } from "../../models/TestCase.model.js";
import { problemService } from "../problem/problem.service.js";
import { testCaseService } from "../problem/testcase.service.js";
import { runAgainstTestCase, type JudgeLanguage } from "../../integrations/judge0/judge0.service.js";
import { AppError } from "../../utils/errors.js";
import { askAi, isAiConfigured } from "./ai.service.js";

const MAX_GENERATED = 8;

const SYSTEM_PROMPT = `You are Kaimana's Automated Test Case Generator, designing new test INPUTS for a competitive programming problem — never outputs, those are computed separately by actually running a reference solution.
Rules you must always follow:
- Generate up to ${MAX_GENERATED} test cases covering a mix of categories: "edge" (empty/minimal/degenerate input), "boundary" (values right at the stated constraint limits), "random" (a plausible mid-size case), and "adversarial" (a case likely to break a naive or inefficient solution, e.g. worst-case ordering or maximum size).
- Every input must satisfy the problem's stated input format and constraints exactly, and be immediately usable as a program's stdin — no comments, no annotations, no surrounding prose.
- Respond with ONLY a JSON array, no prose before or after. Each element: {"category": "edge"|"boundary"|"random"|"adversarial", "input": string}.
- If the constraints are too ambiguous to generate valid input safely, respond with an empty JSON array: [].`;

interface ParsedCase {
  category: "edge" | "boundary" | "random" | "adversarial";
  input: string;
}

const parseGeneratedCases = (raw: string): ParsedCase[] | null => {
  try {
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "");
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return null;
    const validCategories = new Set(["edge", "boundary", "random", "adversarial"]);
    const valid = parsed.every(
      (item) => item && validCategories.has(item.category) && typeof item.input === "string" && item.input.length > 0,
    );
    if (!valid) return null;
    return (parsed as ParsedCase[]).slice(0, MAX_GENERATED);
  } catch {
    return null;
  }
};

export const generateTestCases = async ({ problemId }: { problemId: string }) => {
  if (!Types.ObjectId.isValid(problemId)) throw new AppError("Problem not found.", 404);
  const problem = await problemService.getProblemForJudging(problemId);

  if (!problem.referenceSolution?.code?.trim()) {
    throw new AppError(
      "This problem needs a reference solution (set it on the problem's edit page) before AI test cases can be generated — it's what supplies the correct expected output.",
      400,
    );
  }

  if (!isAiConfigured()) {
    return {
      created: [],
      requested: 0,
      discarded: 0,
      source: "unavailable" as const,
      message: "AI test case generation needs a GEMINI_API_KEY configured on the server.",
    };
  }

  const sampleInputs = problem.sampleTests.map((sample) => sample.input).slice(0, 3);
  const prompt = `Problem: ${problem.title}

Statement:
${problem.statement}

Input format:
${problem.inputFormat || "(not specified)"}

Constraints:
${problem.constraints || "(not specified)"}

${sampleInputs.length ? `Existing sample input(s), for formatting reference only:\n${sampleInputs.join("\n---\n")}` : ""}

Generate the test case inputs now.`;

  let parsed: ParsedCase[] | null = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
    const raw = await askAi({ system: SYSTEM_PROMPT, prompt, maxTokens: 1200 });
    if (raw) parsed = parseGeneratedCases(raw);
  }

  if (!parsed) {
    return {
      created: [],
      requested: 0,
      discarded: 0,
      source: "unavailable" as const,
      message: "Could not generate test cases right now — try again in a moment.",
    };
  }

  if (parsed.length === 0) {
    return { created: [], requested: 0, discarded: 0, source: "ai" as const, message: "The model found the constraints too ambiguous to generate safe test inputs." };
  }

  const language = problem.referenceSolution.language as JudgeLanguage;
  const referenceCode = problem.referenceSolution.code;

  // Run every generated input against the reference solution to get its
  // real expected output, in parallel like audit.service.ts's scaling runs.
  const outcomes = await Promise.all(
    parsed.map((testCase) => runAgainstTestCase(language, referenceCode, testCase.input, problem.timeLimitMs)),
  );

  const survivors = parsed
    .map((testCase, index) => ({ testCase, outcome: outcomes[index] }))
    .filter(({ outcome }) => !outcome.compileError && !outcome.timedOut && outcome.exitCode === 0);

  const discarded = parsed.length - survivors.length;

  if (survivors.length === 0) {
    return {
      created: [],
      requested: parsed.length,
      discarded,
      source: "ai" as const,
      message: "The reference solution could not produce a valid output for any generated input — check that it's correct and matches the problem's language.",
    };
  }

  const startOrder = await testCaseService.countTestCases(problemId);
  const created = await TestCaseModel.insertMany(
    survivors.map(({ testCase, outcome }, index) => ({
      problemId,
      input: testCase.input,
      expectedOutput: outcome.stdout,
      isSample: false,
      order: startOrder + index,
      source: "ai-generated" as const,
      reviewed: false,
    })),
  );

  return {
    created,
    requested: parsed.length,
    discarded,
    source: "ai" as const,
  };
};

export const testgenService = { generateTestCases };
