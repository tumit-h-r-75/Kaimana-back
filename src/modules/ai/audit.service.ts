// AI service for evaluating and auditing code quality and complexity.
//
// Combines two signals per SRS F4 (Complexity Auditor):
//   - Empirical: re-runs the submitted code (unchanged) against a
//     size-diverse sample of the problem's own test cases via Judge0,
//     then fits growth curves against the measured runtime/memory
//     (curveFit.ts) — the primary evidence.
//   - Structural: a lightweight, dependency-free scan of the code itself
//     (structuralAnalysis.ts) for nested-loop depth and recursion, used
//     to corroborate — or flag disagreement with — the empirical estimate.
// Gemini then turns both signals into a plain-language explanation; with
// no GEMINI_API_KEY configured, a templated explanation built from the
// same numbers is used instead (same "Plan B" pattern as hint.service.ts
// and interview.service.ts).
//
// Reports are cached on the submission itself (complexityReport) — a
// submission's code never changes after it's created, so re-opening the
// panel returns the cached report instead of re-running Judge0/Gemini
// (per SRS FR-BE-06's caching requirement).

import { Types } from "mongoose";
import { SubmissionModel, type IComplexityReport, type IScalingDataPoint } from "../../models/Submission.model.js";
import { problemService } from "../problem/problem.service.js";
import { testCaseService } from "../problem/testcase.service.js";
import { runAgainstTestCase, type JudgeLanguage } from "../../integrations/judge0/judge0.service.js";
import { analyzeStructure } from "../../utils/complexity/structuralAnalysis.js";
import { estimateComplexityClass, complexityClassForLoopDepth, type CurveFitResult } from "../../utils/complexity/curveFit.js";
import { AppError } from "../../utils/errors.js";
import { askAi } from "./ai.service.js";

const MAX_SAMPLED_TEST_CASES = 6;

// Picks up to MAX_SAMPLED_TEST_CASES test cases spread across the
// problem's size range (by input length) rather than just the first few —
// a curve fit needs size *diversity*, not more points clustered together.
const pickSizeDiverseTestCases = <T extends { input: string }>(testCases: T[]): T[] => {
  const sorted = [...testCases].sort((a, b) => a.input.length - b.input.length);
  if (sorted.length <= MAX_SAMPLED_TEST_CASES) return sorted;

  const picked: T[] = [];
  const step = (sorted.length - 1) / (MAX_SAMPLED_TEST_CASES - 1);
  for (let i = 0; i < MAX_SAMPLED_TEST_CASES; i += 1) {
    picked.push(sorted[Math.round(i * step)]);
  }
  return picked;
};

const SYSTEM_PROMPT = `You are Kaimana's Complexity Auditor, explaining a measured time/space complexity result to a learner on a competitive programming platform.
Rules you must always follow:
- You are given an already-computed time complexity, space complexity, a confidence level, and supporting signals (empirical growth measurements and/or static loop-nesting depth). Do not re-derive or contradict the given complexity classes.
- Write a clear, plain-language explanation (3-5 sentences) of why the code likely has this complexity, referencing the loop structure or measured growth pattern.
- If confidence is "low", say so plainly and suggest what would improve the estimate (e.g. more test cases of varying size).
- Never suggest specific code changes here — that belongs to a different feature (Refactor Recommendations).`;

const buildFallbackExplanation = (
  timeFit: CurveFitResult | null,
  spaceFit: CurveFitResult | null,
  structural: { maxLoopDepth: number; usesRecursion: boolean },
  timeComplexity: string,
  spaceComplexity: string,
  confidence: string,
): string => {
  const parts: string[] = [];
  parts.push(
    structural.maxLoopDepth > 0
      ? `The code's deepest nested loop structure is ${structural.maxLoopDepth} level${structural.maxLoopDepth > 1 ? "s" : ""} deep, which lines up with an estimated time complexity of ${timeComplexity}.`
      : `No nested loops were detected in the code's structure, consistent with the estimated time complexity of ${timeComplexity}.`,
  );
  if (timeFit) {
    parts.push(
      `Measured runtime across ${timeFit.pointCount} differently-sized test cases grew at roughly the rate expected for ${timeComplexity} (fit quality R² ≈ ${timeFit.rSquared}).`,
    );
  }
  if (structural.usesRecursion) {
    parts.push("The code also appears to call itself recursively, which this estimate doesn't fully account for — treat the complexity above as approximate.");
  }
  parts.push(`Estimated space complexity: ${spaceComplexity}${spaceFit ? ` (from measured memory across ${spaceFit.pointCount} test cases).` : "."}`);
  if (confidence === "low") {
    parts.push("Confidence in this estimate is low — running against more test cases with a wider range of input sizes would sharpen it.");
  }
  return parts.join(" ");
};

export const runComplexityAudit = async ({ userId, submissionId }: { userId: string; submissionId: string }): Promise<IComplexityReport> => {
  if (!Types.ObjectId.isValid(submissionId)) throw new AppError("Submission not found.", 404);
  const submission = await SubmissionModel.findById(submissionId);
  if (!submission) throw new AppError("Submission not found.", 404);
  if (String(submission.userId) !== String(userId)) throw new AppError("This submission belongs to another user.", 403);

  // Cached — a submission's code never changes after it's created, so a
  // previously computed report is still valid.
  if (submission.complexityReport) return submission.complexityReport;

  const problem = await problemService.getProblemForJudging(String(submission.problemId));
  const allTestCases = await testCaseService.getTestCasesForJudging(String(submission.problemId));
  const sampled = pickSizeDiverseTestCases(allTestCases as unknown as { input: string }[]);

  const scalingData: IScalingDataPoint[] = await Promise.all(
    sampled.map(async (testCase) => {
      const outcome = await runAgainstTestCase(submission.language as JudgeLanguage, submission.code, testCase.input, problem.timeLimitMs);
      return { size: testCase.input.length, runtimeMs: outcome.runtimeMs, memoryKb: outcome.memoryKb };
    }),
  );

  const structural = analyzeStructure(submission.code, submission.language as JudgeLanguage);

  const timeFit = estimateComplexityClass(scalingData.map((p) => ({ size: p.size, value: p.runtimeMs })));
  const spaceFit = estimateComplexityClass(scalingData.map((p) => ({ size: p.size, value: p.memoryKb })));

  const structuralTimeClass = complexityClassForLoopDepth(structural.maxLoopDepth);
  const timeComplexity = timeFit?.complexity ?? structuralTimeClass;
  const spaceComplexity = spaceFit?.complexity ?? (structural.maxLoopDepth > 0 ? "O(n)" : "O(1)");

  // Confidence starts from the empirical fit's own confidence (it already
  // accounts for point count and fit quality), then only ever downgrades —
  // never upgrades — when the structural signal disagrees, or when there
  // was no empirical fit to lean on at all.
  let confidence: "low" | "medium" | "high" = timeFit?.confidence ?? "low";
  if (timeFit && timeFit.complexity !== structuralTimeClass && confidence === "high") confidence = "medium";

  const prompt = `Time complexity: ${timeComplexity}
Space complexity: ${spaceComplexity}
Confidence: ${confidence}
Max nested loop depth detected: ${structural.maxLoopDepth}
Recursion detected: ${structural.usesRecursion ? "yes" : "no"}
Empirical time fit: ${timeFit ? `slope ${timeFit.slope}, R² ${timeFit.rSquared}, from ${timeFit.pointCount} test cases` : "not enough size variety among this problem's test cases"}
Empirical space fit: ${spaceFit ? `slope ${spaceFit.slope}, R² ${spaceFit.rSquared}` : "not enough size variety"}

Explain this result to the learner.`;

  const aiExplanation = await askAi({ system: SYSTEM_PROMPT, prompt, maxTokens: 260 });
  const explanation = aiExplanation ?? buildFallbackExplanation(timeFit, spaceFit, structural, timeComplexity, spaceComplexity, confidence);

  const report: IComplexityReport = {
    timeComplexity,
    spaceComplexity,
    confidence,
    scalingData,
    explanation,
    generatedAt: new Date(),
  };

  submission.complexityReport = report;
  await submission.save();

  return report;
};

export const auditService = { runComplexityAudit };
