// AI service for generating context-aware problem hints.
//
// Hints are progressive (level 1 = gentle nudge, level 2 = approach,
// level 3 = near-implementation detail) and NEVER reveal the reference
// solution's code. When ANTHROPIC_API_KEY is configured, Claude generates a
// hint grounded in the problem statement and the learner's current code.
// Otherwise a deterministic, tag-driven hint bank keeps the feature useful
// with zero setup — the same "Plan B" philosophy the judge already uses
// for Judge0.

import { ProblemModel, type IProblem } from "../../models/Problem.model.js";
import { AppError } from "../../utils/errors.js";
import { askClaude } from "./ai.service.js";

const MAX_HINT_LEVEL = 3;

// Generic, tag-driven fallback hints. Keyed by the problem's first
// recognized tag; a catch-all covers every other tag.
const TAG_HINTS: Record<string, string[]> = {
  array: [
    "Think about what information you'd need to remember as you scan the array once, left to right.",
    "A single pass with a lookup structure (like a map of value → index) usually beats comparing every pair.",
    "For each element, check whether the value you still need has already been seen — that turns an O(n²) search into O(n).",
  ],
  hashmap: [
    "A hash map trades memory for speed: it lets you check 'have I seen this before?' in O(1).",
    "Store what you've seen so far as you iterate, keyed by the value you'd need to complete the answer.",
    "Before inserting the current element, first check whether its complement is already in the map.",
  ],
  math: [
    "Try working the problem out by hand on a small example first — the pattern often reveals the formula.",
    "Watch out for overflow and sign edge cases (zero, negative numbers, the smallest/largest representable value).",
    "Peel off digits or factors one at a time with modulo and integer division rather than converting to a string, when possible.",
  ],
  stack: [
    "A stack is a natural fit whenever you need to match the most recent 'open' thing with the next 'close' thing.",
    "Push opening symbols; when you hit a closing symbol, check the top of the stack for a match.",
    "An empty stack at the end (and never popping from an empty stack mid-way) is exactly what 'valid' means here.",
  ],
  string: [
    "Consider whether a single left-to-right pass, or two pointers from both ends, is enough.",
    "Comparing characters directly is usually simpler and faster than building intermediate strings.",
    "Watch the edge cases: empty input, all-identical characters, and inputs of length 1.",
  ],
  dp: [
    "Ask: what's the smallest version of this problem, and how does the answer build up from smaller answers?",
    "Define what state you need to remember at each step — often just the previous one or two results.",
    "A simple bottom-up loop that reuses a couple of running variables is usually enough; you rarely need a full table.",
  ],
  "two-pointers": [
    "Two pointers moving toward each other (or one behind the other) can replace a nested loop in many array problems.",
    "Decide what condition should move the left pointer forward, and what should move the right pointer backward.",
    "Track the best answer seen so far as the pointers move, rather than recomputing it from scratch each time.",
  ],
  "binary-search": [
    "If the search space is sorted or monotonic, you can likely narrow it in half each step instead of scanning linearly.",
    "Maintain a low and high bound, and decide clearly what makes you move each one — get this condition exactly right.",
    "Double-check the loop's exit condition so you don't miss the last candidate or loop forever.",
  ],
  implementation: [
    "Re-read the statement slowly and list every rule it states — implementation problems are usually about not missing one.",
    "Handle the straightforward case first, then walk through each edge case the constraints hint at.",
    "Trace your logic by hand against the sample input before trusting it against hidden tests.",
  ],
};

const DEFAULT_HINTS = [
  "Restate the problem in your own words — what exactly are you being asked to compute?",
  "Work through the given sample input by hand, step by step, before writing code.",
  "Check your solution against the stated constraints: what's the largest input it needs to handle efficiently?",
];

const hintsForProblem = (problem: Pick<IProblem, "tags">): string[] => {
  const tag = problem.tags.find((candidate) => TAG_HINTS[candidate]);
  return tag ? TAG_HINTS[tag] : DEFAULT_HINTS;
};

const buildFallbackHint = (problem: Pick<IProblem, "tags">, level: number) => {
  const hints = hintsForProblem(problem);
  return hints[level - 1] ?? hints[hints.length - 1];
}

const SYSTEM_PROMPT = `You are Kaimana's AI hint coach for a competitive programming platform. A learner is stuck on a problem and asked for a hint at a specific level (1 = gentle conceptual nudge, 2 = name the approach/technique, 3 = a concrete but partial step toward implementation).
Rules you must always follow:
- NEVER output a full or near-complete solution, and never output runnable code.
- Keep the hint to 2-4 sentences.
- Match the requested level exactly: do not jump straight to the answer.
- Be encouraging and specific to the problem given, not generic advice.`;

export const getHint = async ({
  problemId,
  level,
  code,
}: {
  problemId: string;
  level: number;
  code?: string;
}) => {
  const safeLevel = Math.min(Math.max(Math.trunc(level) || 1, 1), MAX_HINT_LEVEL);

  const problem = await ProblemModel.findById(problemId).select("title statement constraints tags difficulty").lean<IProblem | null>();
  if (!problem) throw new AppError("Problem not found.", 404);

  const prompt = `Problem: ${problem.title} (${problem.difficulty})
Statement: ${problem.statement}
Constraints: ${problem.constraints || "not specified"}
Hint level requested: ${safeLevel} of ${MAX_HINT_LEVEL}
${code?.trim() ? `The learner's current code attempt:\n${code.trim().slice(0, 2000)}` : "The learner has not written any code yet."}

Give exactly one level-${safeLevel} hint.`;

  const aiHint = await askClaude({ system: SYSTEM_PROMPT, prompt, maxTokens: 220 });

  return {
    level: safeLevel,
    maxLevel: MAX_HINT_LEVEL,
    hint: aiHint ?? buildFallbackHint(problem, safeLevel),
    source: aiHint ? "ai" : "rule-based",
  };
};

export const hintService = { getHint };
