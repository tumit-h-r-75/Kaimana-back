// Service for problem CRUD, search filtering, and per-user submission summaries.

import { FilterQuery, Types } from "mongoose";
import { IProblem, ProblemModel } from "../../models/Problem.model.js";
import { SubmissionModel } from "../../models/Submission.model.js";
import { AppError } from "../../utils/errors.js";

// mongoose.models.Problem || model<IProblem>(...) (see Problem.model.ts) widens
// to a loosely-typed Model union, which makes .findOne().lean() resolve to an
// ambiguous array-or-single type. Casting through this alias keeps call sites
// readable instead of repeating `as unknown as ...` everywhere.
type LeanProblem = IProblem & { _id: Types.ObjectId };

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
  if (search) filter.title = { $regex: search.trim(), $options: "i" };

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
  if (userId) {
    mySubmissionsCount = await SubmissionModel.countDocuments({ userId, problemId: problem._id });
    const bestAccepted = await SubmissionModel.exists({ userId, problemId: problem._id, verdict: "ACCEPTED" });
    if (bestAccepted) {
      myBestVerdict = "ACCEPTED";
    } else {
      const latest = (await SubmissionModel.findOne({ userId, problemId: problem._id }).sort({ createdAt: -1 }).select("verdict").lean()) as unknown as { verdict: string } | null;
      myBestVerdict = latest?.verdict ?? null;
    }
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
    sampleTests: problem.sampleTests,
    starterCode: problem.starterCode,
    mySubmissionsCount,
    myBestVerdict,
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

const updateProblem = async (problemId: string, payload: Partial<ICreateProblemInput>) => {
  if (!Types.ObjectId.isValid(problemId)) throw new AppError("Invalid problem id.", 400);
  const problem = await ProblemModel.findByIdAndUpdate(problemId, payload, { new: true });
  if (!problem) throw new AppError("Problem not found.", 404);
  return problem;
};

const getProblemForJudging = async (problemId: string) => {
  if (!Types.ObjectId.isValid(problemId)) throw new AppError("Invalid problem id.", 400);
  const problem = (await ProblemModel.findById(problemId).lean()) as unknown as LeanProblem | null;
  if (!problem) throw new AppError("Problem not found.", 404);
  return problem;
};

export const problemService = {
  listProblems,
  getProblemBySlug,
  createProblem,
  updateProblem,
  getProblemForJudging,
};
