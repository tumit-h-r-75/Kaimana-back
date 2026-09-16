// AI service for generating context-aware problem hints.
//
// Hints are progressive (level 1 = gentle nudge, level 2 = approach,
// level 3 = near-implementation detail) and NEVER reveal the reference
// solution's code. When GEMINI_API_KEY is configured, Gemini generates a
// hint grounded in the problem statement and the learner's current code.
// Otherwise a deterministic, tag-driven hint bank keeps the feature useful
// with zero setup — the same "Plan B" philosophy the judge already uses
// for Judge0.

import { Types } from "mongoose";
import { ProblemModel, type IProblem } from "../../models/Problem.model.js";
import { HintUnlockModel } from "../../models/HintUnlock.model.js";
import { AppError } from "../../utils/errors.js";
import { askAi } from "./ai.service.js";

const MAX_HINT_LEVEL = 3;

// Negative marking, university-admission-test style: unlocking a hint tier
// costs this percentage of the problem's basePoints, forfeited permanently
// from every future submission's score on this problem (see scoring.ts and
// HintUnlock.model.ts). Costs are cumulative and tiers unlock strictly in
// order — index 0 is tier 1's cost, and so on. The frontend mirrors these
// same numbers (components/hints/HintPanel.tsx) to show the cost in a
// confirmation modal before the learner spends it; this array is the
// source of truth the backend actually charges against.
export const HINT_TIER_COSTS = [5, 15, 30];

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
  userId,
  problemId,
  level,
  code,
  role,
}: {
  userId: string;
  problemId: string;
  level: number;
  code?: string;
  role?: string;
}) => {
  const requestedLevel = Math.min(Math.max(Math.trunc(level) || 1, 1), MAX_HINT_LEVEL);

  // Checked up front: a malformed id would otherwise reach Mongoose as a
  // CastError and surface as a 500.
  if (typeof problemId !== "string" || !Types.ObjectId.isValid(problemId)) throw new AppError("Invalid problem id.", 400);

  const problem = await ProblemModel.findById(problemId).select("title statement constraints tags difficulty isPublished").lean<IProblem | null>();
  // Unpublished drafts are hidden from non-admins everywhere else (see
  // problem.service.ts), so their hints — grounded in the statement — are
  // too, reported as missing rather than forbidden.
  if (!problem || (!problem.isPublished && role !== "admin")) throw new AppError("Problem not found.", 404);

  // Lazily create the unlock record on this learner's first hint request
  // for this problem — everyone starts at tier 0 (nothing unlocked, no
  // penalty) until they actually spend score on a hint. One atomic upsert
  // rather than findOne-then-create: two near-simultaneous requests (a
  // double-click) would otherwise both miss and both insert, and the second
  // would hit the unique (userId, problemId) index as a 500. If the upsert
  // itself still races into a duplicate-key error, the record now exists,
  // so a single retry simply reads it.
  const findOrCreateUnlock = () =>
    HintUnlockModel.findOneAndUpdate(
      { userId, problemId },
      { $setOnInsert: { unlockedTier: 0, penaltyPercent: 0 } },
      { upsert: true, new: true },
    );
  let unlock;
  try {
    unlock = await findOrCreateUnlock();
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    unlock = await findOrCreateUnlock();
  }

  // Tiers unlock strictly in order and can't be skipped: a request for a
  // level further ahead than the next purchasable tier is clamped down to
  // that tier, so a stale client (or a re-ordered request) can never pay
  // for tier 1 and receive tier 3. A request for a tier already unlocked
  // is a free replay — re-reading a hint you already paid for costs
  // nothing more.
  const nextPurchasableTier = unlock.unlockedTier + 1;
  const safeLevel = requestedLevel > nextPurchasableTier ? nextPurchasableTier : requestedLevel;
  const isNewUnlock = safeLevel > unlock.unlockedTier;

  let cost = 0;
  if (isNewUnlock) {
    cost = HINT_TIER_COSTS[safeLevel - 1] ?? HINT_TIER_COSTS[HINT_TIER_COSTS.length - 1];
    unlock.unlockedTier = safeLevel;
    unlock.penaltyPercent = Math.min(100, unlock.penaltyPercent + cost);
    await unlock.save();
  }

  const prompt = `Problem: ${problem.title} (${problem.difficulty})
Statement: ${problem.statement}
Constraints: ${problem.constraints || "not specified"}
Hint level requested: ${safeLevel} of ${MAX_HINT_LEVEL}
${code?.trim() ? `The learner's current code attempt:\n${code.trim().slice(0, 2000)}` : "The learner has not written any code yet."}

Give exactly one level-${safeLevel} hint.`;

  const aiHint = await askAi({ system: SYSTEM_PROMPT, prompt, maxTokens: 220 });

  return {
    level: safeLevel,
    maxLevel: MAX_HINT_LEVEL,
    hint: aiHint ?? buildFallbackHint(problem, safeLevel),
    source: aiHint ? "ai" : "rule-based",
    // Score forfeited by this specific call (0 for a free replay of an
    // already-unlocked tier) and the learner's running total on this
    // problem — both as a percentage of the problem's basePoints.
    cost,
    penaltyPercent: unlock.penaltyPercent,
  };
};

export const hintService = { getHint };
