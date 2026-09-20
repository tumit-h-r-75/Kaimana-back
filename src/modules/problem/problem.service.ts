// Service for problem CRUD, search filtering, and per-user submission summaries.

import { FilterQuery, Types } from "mongoose";
import { IProblem, ProblemModel } from "../../models/Problem.model.js";
import { SubmissionModel } from "../../models/Submission.model.js";
import { TestCaseModel } from "../../models/TestCase.model.js";
import { HintUnlockModel } from "../../models/HintUnlock.model.js";
import { AppError } from "../../utils/errors.js";

// mongoose.models.Problem || model<IProblem>(...) (see Problem.model.ts) widens
// to a loosely-typed Model union, which makes .findOne().lean() resolve to an
// ambiguous array-or-single type. Casting through this alias keeps call sites
// readable instead of repeating `as unknown as ...` everywhere.
type LeanProblem = IProblem & { _id: Types.ObjectId };

// Search text goes into a $regex, so it's matched literally: an unescaped
// "(" is an invalid pattern (a 500 on a public endpoint), and arbitrary or
// very long patterns are a cheap way to make the database do heavy work.
const MAX_SEARCH_LENGTH = 100;
const toSearchRegex = (search: string) => search.trim().slice(0, MAX_SEARCH_LENGTH).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface IListProblemsQuery {
  difficulty?: string;
  tags?: string;
  search?: string;
  page?: number;
  limit?: number;
  userId?: string;
}

const listProblems = async ({ difficulty, tags, search, page = 1, limit = 20, userId }: IListProblemsQuery) => {
  const filter: FilterQuery<IProblem> = { isPublished: true };
  if (difficulty) filter.difficulty = difficulty.toUpperCase();
  if (tags) filter.tags = { $in: tags.split(",").map((tag) => tag.trim()).filter(Boolean) };
  if (search) filter.title = { $regex: toSearchRegex(search), $options: "i" };

  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const safePage = Math.max(page, 1);

  const [items, total] = await Promise.all([
    ProblemModel.find(filter)
      .select("slug title difficulty tags basePoints")
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),
    ProblemModel.countDocuments(filter),
  ]);

  let solvedProblemIds = new Set<string>();
  if (userId && items.length) {
    const solved = await SubmissionModel.find({
      userId,
      verdict: "ACCEPTED",
      problemId: { $in: items.map((item) => item._id) },
    })
      .distinct("problemId")
      .lean();
    solvedProblemIds = new Set(solved.map(String));
  }

  return {
    items: items.map((item) => ({
      id: String(item._id),
      slug: item.slug,
      title: item.title,
      difficulty: item.difficulty,
      tags: item.tags,
      basePoints: item.basePoints,
      solvedByMe: solvedProblemIds.has(String(item._id)),
    })),
    total,
    page: safePage,
    limit: safeLimit,
  };
};

const getProblemBySlug = async (slug: string, userId?: string) => {
  const problem = (await ProblemModel.findOne({ slug: slug.toLowerCase(), isPublished: true }).lean()) as unknown as LeanProblem | null;
  if (!problem) throw new AppError("Problem not found.", 404);

  let mySubmissionsCount = 0;
  let myBestVerdict: string | null = null;
  // The learner's hint progress on this problem (see hint.service.ts), so the
  // workspace can show which tiers are already paid for and the penalty so
  // far. Both stay 0 for anonymous requests and for users with no hints yet.
  let myHintTier = 0;
  let myHintPenaltyPercent = 0;
  if (userId) {
    mySubmissionsCount = await SubmissionModel.countDocuments({ userId, problemId: problem._id });
    const bestAccepted = await SubmissionModel.exists({ userId, problemId: problem._id, verdict: "ACCEPTED" });
    if (bestAccepted) {
      myBestVerdict = "ACCEPTED";
    } else {
      const latest = (await SubmissionModel.findOne({ userId, problemId: problem._id }).sort({ createdAt: -1 }).select("verdict").lean()) as unknown as { verdict: string } | null;
      myBestVerdict = latest?.verdict ?? null;
    }
    const hintUnlock = (await HintUnlockModel.findOne({ userId, problemId: problem._id }).select("unlockedTier penaltyPercent").lean()) as unknown as
      | { unlockedTier?: number; penaltyPercent?: number }
      | null;
    myHintTier = hintUnlock?.unlockedTier ?? 0;
    myHintPenaltyPercent = hintUnlock?.penaltyPercent ?? 0;
  }

  // The seed script only writes sample cases to the TestCase collection, never
  // to the embedded `sampleTests`, so every seeded problem came back with
  // `sampleTests: []` — the workspace showed no samples and its Run button
  // executed the learner's code against empty stdin (EOFError / undefined
  // input in every language). Fall back to the reviewed sample test cases
  // whenever the embedded list is empty.
  let sampleTests = problem.sampleTests ?? [];
  if (!sampleTests.length) {
    const sampleCases = (await TestCaseModel.find({ problemId: problem._id, isSample: true, reviewed: { $ne: false } })
      .sort({ order: 1, createdAt: 1 })
      .select("input expectedOutput")
      .lean()) as unknown as { input: string; expectedOutput: string }[];
    sampleTests = sampleCases.map(({ input, expectedOutput }) => ({ input, expectedOutput }));
  }

  return {
    id: String(problem._id),
    slug: problem.slug,
    title: problem.title,
    statement: problem.statement,
    inputFormat: problem.inputFormat,
    outputFormat: problem.outputFormat,
    constraints: problem.constraints,
    difficulty: problem.difficulty,
    tags: problem.tags,
    timeLimitMs: problem.timeLimitMs,
    memoryLimitMb: problem.memoryLimitMb,
    basePoints: problem.basePoints,
    sampleTests,
    starterCode: problem.starterCode,
    mySubmissionsCount,
    myBestVerdict,
    myHintTier,
    myHintPenaltyPercent,
    // Withheld until the learner has solved it themselves — before that it
    // is the answer key. Afterwards it is the thing they actually came for:
    // something to compare their own approach against, which the hints
    // deliberately never give. Without it, anyone who is stuck and out of
    // gems reaches a dead end and simply leaves.
    //
    // The lean() above skips the toJSON transform that normally strips this
    // field, so the value is already in hand; that transform still guards
    // every path which serialises a Problem document directly.
    referenceSolution: myBestVerdict === "ACCEPTED" ? (problem.referenceSolution ?? null) : null,
  };
};

interface ICreateProblemInput {
  slug: string;
  title: string;
  statement: string;
  inputFormat?: string;
  outputFormat?: string;
  constraints?: string;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  tags?: string[];
  timeLimitMs?: number;
  memoryLimitMb?: number;
  basePoints?: number;
  sampleTests?: IProblem["sampleTests"];
  starterCode?: IProblem["starterCode"];
  referenceSolution?: IProblem["referenceSolution"];
  createdBy?: string;
}

const createProblem = async (payload: ICreateProblemInput) => {
  const existing = await ProblemModel.findOne({ slug: payload.slug.toLowerCase() });
  if (existing) throw new AppError("A problem with this slug already exists.", 409);
  return ProblemModel.create({ ...payload, slug: payload.slug.toLowerCase() });
};

// `referenceSolution: null` is how the admin edit form asks to clear a saved
// solution, so it becomes an explicit $unset that removes the stored object.
const updateProblem = async (
  problemId: string,
  payload: Partial<Omit<ICreateProblemInput, "referenceSolution">> & { referenceSolution?: IProblem["referenceSolution"] | null },
) => {
  if (!Types.ObjectId.isValid(problemId)) throw new AppError("Invalid problem id.", 400);
  const { referenceSolution, ...rest } = payload;
  const update = referenceSolution === null ? { ...rest, $unset: { referenceSolution: 1 } } : payload;
  const problem = await ProblemModel.findByIdAndUpdate(problemId, update, { new: true });
  if (!problem) throw new AppError("Problem not found.", 404);
  return problem;
};

const getProblemForJudging = async (problemId: string) => {
  if (!Types.ObjectId.isValid(problemId)) throw new AppError("Invalid problem id.", 400);
  const problem = (await ProblemModel.findById(problemId).lean()) as unknown as LeanProblem | null;
  if (!problem) throw new AppError("Problem not found.", 404);
  return problem;
};

// Admin problem manager needs to see everything, including unpublished
// drafts — unlike listProblems() (public browsing), which only surfaces
// isPublished problems.
interface IListAllProblemsQuery {
  page?: number;
  limit?: number;
  search?: string;
}

const listAllForAdmin = async ({ page, limit, search }: IListAllProblemsQuery) => {
  const filter: FilterQuery<IProblem> = {};
  if (search) filter.title = { $regex: toSearchRegex(search), $options: "i" };

  // The controller passes Number(req.query.x) straight through, so NaN
  // ("abc"), zero, negative and fractional values all arrive here — NaN in
  // skip()/limit() used to be a 500. Anything that isn't a positive number
  // falls back to the default; limit is capped at 100, page kept small enough
  // that (page - 1) * limit stays a sane skip() value.
  const toPositiveInt = (value: number | undefined, fallback: number, max: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), max) : fallback;
  const safeLimit = toPositiveInt(limit, 50, 100);
  const safePage = toPositiveInt(page, 1, 1_000_000);

  const [items, total] = await Promise.all([
    ProblemModel.find(filter)
      .select("slug title difficulty tags basePoints isPublished createdAt")
      // _id breaks createdAt ties (seeded problems share timestamps), so an
      // item can never repeat on, or vanish between, adjacent pages.
      .sort({ createdAt: -1, _id: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),
    ProblemModel.countDocuments(filter),
  ]);

  return {
    items: items.map((item) => ({
      id: String(item._id),
      slug: item.slug,
      title: item.title,
      difficulty: item.difficulty,
      tags: item.tags,
      basePoints: item.basePoints,
      isPublished: item.isPublished,
      createdAt: item.createdAt,
    })),
    total,
    page: safePage,
    limit: safeLimit,
  };
};

const getProblemByIdForAdmin = async (problemId: string) => {
  if (!Types.ObjectId.isValid(problemId)) throw new AppError("Invalid problem id.", 400);
  // .lean() skips the schema's toJSON transform (no automatic _id -> id),
  // so build the same shape the rest of the API returns by hand.
  const problem = (await ProblemModel.findById(problemId).lean()) as unknown as LeanProblem | null;
  if (!problem) throw new AppError("Problem not found.", 404);
  return {
    id: String(problem._id),
    slug: problem.slug,
    title: problem.title,
    statement: problem.statement,
    inputFormat: problem.inputFormat,
    outputFormat: problem.outputFormat,
    constraints: problem.constraints,
    difficulty: problem.difficulty,
    tags: problem.tags,
    timeLimitMs: problem.timeLimitMs,
    memoryLimitMb: problem.memoryLimitMb,
    basePoints: problem.basePoints,
    isPublished: problem.isPublished,
    sampleTests: problem.sampleTests,
    starterCode: problem.starterCode,
    // Was silently dropped here even though create/update already accept
    // and persist it — the admin edit form had no way to see or change a
    // problem's reference solution once saved. Needed now so the admin UI
    // can surface it (testgen.service.ts requires one to generate AI test
    // cases: it's what supplies the ground-truth expected output).
    referenceSolution: problem.referenceSolution,
  };
};

// Hard delete. Cascades to the problem's own test cases (orphaned test
// cases serve no purpose), but leaves past Submissions alone — they're a
// historical record even if their problem is later removed.
const deleteProblem = async (problemId: string) => {
  if (!Types.ObjectId.isValid(problemId)) throw new AppError("Invalid problem id.", 400);
  const problem = await ProblemModel.findByIdAndDelete(problemId);
  if (!problem) throw new AppError("Problem not found.", 404);
  await TestCaseModel.deleteMany({ problemId });
  return problem;
};

/** How many solves at a difficulty before we start offering the next one up. */
const READY_TO_LEVEL_UP = 3;
const DIFFICULTY_ORDER = ["EASY", "MEDIUM", "HARD"] as const;
type Difficulty = (typeof DIFFICULTY_ORDER)[number];

interface Recommendation {
  id: string;
  slug: string;
  title: string;
  difficulty: string;
  tags: string[];
  basePoints: number;
}

const summarise = (p: LeanProblem): Recommendation => ({
  id: String(p._id),
  slug: p.slug,
  title: p.title,
  difficulty: p.difficulty,
  tags: p.tags ?? [],
  basePoints: p.basePoints,
});

/**
 * Answers "what should I solve next?".
 *
 * The library is a list, and a list is a decision. People open it, look at
 * forty titles, pick something they already know how to do, and leave — the
 * data to do better than that was always there, it just was not being read.
 *
 * Two different suggestions, because they answer different moods:
 *
 *  - `resume` is the problem they most recently attempted and did not
 *    finish. Cheapest possible win: they already have the context loaded.
 *  - `next` is a problem in their weakest topic, at a difficulty they have
 *    shown they are ready for. Weakest means fewest solved relative to
 *    what exists, so a topic they have never touched outranks one they are
 *    merely slow at.
 *
 * Every suggestion carries the sentence explaining it. A recommendation
 * nobody can see the reasoning behind is just a shuffle.
 */
const getRecommendations = async (userId: string) => {
  const uid = new Types.ObjectId(userId);

  const perProblem = (await SubmissionModel.aggregate([
    { $match: { userId: uid } },
    {
      $group: {
        _id: "$problemId",
        solved: { $max: { $cond: [{ $eq: ["$verdict", "ACCEPTED"] }, 1, 0] } },
        attempts: { $sum: 1 },
        lastAttemptAt: { $max: "$submittedAt" },
      },
    },
  ])) as { _id: Types.ObjectId; solved: number; attempts: number; lastAttemptAt: Date }[];

  const solvedIds = new Set(perProblem.filter((p) => p.solved).map((p) => String(p._id)));
  const problems = (await ProblemModel.find({ isPublished: true }).lean()) as unknown as LeanProblem[];
  const byId = new Map(problems.map((p) => [String(p._id), p]));

  // ---- resume: started, not finished, most recently touched.
  const unfinished = perProblem
    .filter((p) => !p.solved && byId.has(String(p._id)))
    .sort((a, b) => +new Date(b.lastAttemptAt) - +new Date(a.lastAttemptAt))[0];

  const resume = unfinished
    ? {
        ...summarise(byId.get(String(unfinished._id))!),
        attempts: unfinished.attempts,
        lastAttemptAt: unfinished.lastAttemptAt,
        reason:
          unfinished.attempts === 1
            ? "You started this one and did not finish it."
            : `You have tried this ${unfinished.attempts} times without an accept yet.`,
      }
    : null;

  // ---- difficulty they are ready for: one step past whatever they have
  // done at least READY_TO_LEVEL_UP of, so the ladder moves but never skips.
  const solvedByDifficulty = { EASY: 0, MEDIUM: 0, HARD: 0 } as Record<Difficulty, number>;
  for (const id of solvedIds) {
    const d = byId.get(id)?.difficulty as Difficulty | undefined;
    if (d) solvedByDifficulty[d] += 1;
  }
  let target: Difficulty = "EASY";
  for (const d of DIFFICULTY_ORDER) {
    if (solvedByDifficulty[d] >= READY_TO_LEVEL_UP) {
      target = DIFFICULTY_ORDER[Math.min(DIFFICULTY_ORDER.indexOf(d) + 1, DIFFICULTY_ORDER.length - 1)];
    }
  }

  // ---- weakest tag: fewest solved as a share of what exists. A tag with
  // nothing solved scores 0 and therefore wins, which is the intent — an
  // untouched topic is a bigger gap than a half-finished one.
  const tally = new Map<string, { total: number; solved: number }>();
  for (const p of problems) {
    for (const tag of p.tags ?? []) {
      const t = tally.get(tag) ?? { total: 0, solved: 0 };
      t.total += 1;
      if (solvedIds.has(String(p._id))) t.solved += 1;
      tally.set(tag, t);
    }
  }
  const ranked = [...tally.entries()]
    .filter(([, t]) => t.solved < t.total)
    .sort((a, b) => a[1].solved / a[1].total - b[1].solved / b[1].total || b[1].total - a[1].total);
  const focusTag = ranked[0]?.[0] ?? null;

  // ---- next: unsolved, in the weak tag, at the target difficulty. Relax
  // the difficulty first and the tag only as a last resort — a slightly
  // easier problem in the right topic beats the right level in a topic
  // they have already covered.
  const unsolved = problems.filter((p) => !solvedIds.has(String(p._id)));
  const inFocus = focusTag ? unsolved.filter((p) => (p.tags ?? []).includes(focusTag)) : [];

  const chosen =
    inFocus.find((p) => p.difficulty === target) ??
    inFocus.sort((a, b) => DIFFICULTY_ORDER.indexOf(a.difficulty as Difficulty) - DIFFICULTY_ORDER.indexOf(b.difficulty as Difficulty))[0] ??
    unsolved.find((p) => p.difficulty === target) ??
    unsolved[0];

  const next = chosen
    ? {
        ...summarise(chosen),
        reason:
          focusTag && (chosen.tags ?? []).includes(focusTag)
            ? tally.get(focusTag)!.solved === 0
              ? `You have not solved a ${focusTag} problem yet.`
              : `${focusTag} is your thinnest topic so far — ${tally.get(focusTag)!.solved} of ${tally.get(focusTag)!.total} solved.`
            : "Next one up from what you have already done.",
      }
    : null;

  return {
    resume,
    next,
    focusTag,
    stats: {
      solved: solvedIds.size,
      attempted: perProblem.length,
      solvedByDifficulty,
      readyFor: target,
    },
  };
};

export const problemService = {
  listProblems,
  getProblemBySlug,
  getRecommendations,
  createProblem,
  updateProblem,
  getProblemForJudging,
  listAllForAdmin,
  getProblemByIdForAdmin,
  deleteProblem,
};
