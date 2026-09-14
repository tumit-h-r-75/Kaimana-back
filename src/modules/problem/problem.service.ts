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

const listAllForAdmin = async ({ page = 1, limit = 50, search }: IListAllProblemsQuery) => {
  const filter: FilterQuery<IProblem> = {};
  if (search) filter.title = { $regex: toSearchRegex(search), $options: "i" };

  const safeLimit = Math.min(Math.max(limit, 1), 200);
  const safePage = Math.max(page, 1);

  const [items, total] = await Promise.all([
    ProblemModel.find(filter)
      .select("slug title difficulty tags basePoints isPublished createdAt")
      .sort({ createdAt: -1 })
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

export const problemService = {
  listProblems,
  getProblemBySlug,
  createProblem,
  updateProblem,
  getProblemForJudging,
  listAllForAdmin,
  getProblemByIdForAdmin,
  deleteProblem,
};
