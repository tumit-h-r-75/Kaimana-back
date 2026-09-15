// Service for problem proposals. A learner proposes a new problem for the
// library — the same fields as the admin "Create problem" form, except the
// slug, points and visibility, which the reviewing admin decides.
//
// Gems: sending a proposal for review costs PROPOSAL_COST_GEMS. A rejected
// proposal refunds half, an accepted one keeps the full cost, and deleting a
// proposal before it's reviewed refunds it all. Editing a rejected proposal
// sends it back for review, which costs the fee again. Every gem change is
// written in the same transaction as the proposal change it belongs to.
//
// Until a proposal is accepted its author can edit or delete it. Accepting one
// creates the problem and its test cases in a transaction.

import mongoose, { ClientSession, FilterQuery, Types } from "mongoose";
import {
  ProblemProposalModel,
  type IProblemProposal,
  type IProposalTestCase,
  type ProblemProposalStatus,
  type ProposalLanguage,
} from "../../models/ProblemProposal.model.js";
import { ProblemModel } from "../../models/Problem.model.js";
import { TestCaseModel } from "../../models/TestCase.model.js";
import { UserModel, type IUser } from "../../models/User.model.js";
import { PROPOSAL_COST_GEMS, PROPOSAL_REJECT_REFUND_GEMS } from "../../utils/gems.js";
import { AppError } from "../../utils/errors.js";

// Same loose `mongoose.models.X || model(...)` union as every other model, so
// .lean() results need an explicit cast (see host.service.ts).
type LeanProposal = IProblemProposal & { _id: Types.ObjectId };
type LeanProposer = Pick<IUser, "name" | "email" | "role"> & { _id: Types.ObjectId };
type LinkedProblem = { _id: Types.ObjectId; slug: string; isPublished: boolean };

export const MAX_PENDING_PROPOSALS = 5;

// Mirrored by the proposal form on the front end (components/proposals/ProposalForm.tsx).
const LIMITS = {
  titleMin: 3,
  titleMax: 120,
  statementMin: 20,
  statementMax: 10000,
  formatMax: 3000,
  constraintsMax: 2000,
  tagsMax: 8,
  tagMax: 30,
  timeLimitMin: 100,
  timeLimitMax: 10000,
  memoryLimitMin: 16,
  memoryLimitMax: 1024,
  testCasesMax: 20,
  testCaseTextMax: 10000,
  explanationMax: 1000,
  codeMax: 20000,
  noteMax: 1000,
  reviewNoteMax: 500,
  slugMin: 3,
  slugMax: 80,
  pointsMax: 10000,
} as const;

const PROPOSAL_STATUSES: ProblemProposalStatus[] = ["pending", "accepted", "rejected"];
const EDITABLE_STATUSES: ProblemProposalStatus[] = ["pending", "rejected"];
const DIFFICULTIES: IProblemProposal["difficulty"][] = ["EASY", "MEDIUM", "HARD"];
const LANGUAGES: ProposalLanguage[] = ["python", "cpp", "javascript", "typescript"];
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const PENDING_LIMIT_MESSAGE = `You already have ${MAX_PENDING_PROPOSALS} proposals waiting for review. Wait for a decision before sending another.`;
const ALREADY_REVIEWED_MESSAGE = "This proposal has already been reviewed.";
const SLUG_TAKEN_MESSAGE = "A problem with this slug already exists.";
const NOT_FOUND_MESSAGE = "Proposal not found.";
const STALE_EDIT_MESSAGE = "This proposal was just reviewed. Reload to see the decision.";

const notEnoughGemsMessage = (gems: number) =>
  `Sending a proposal costs ${PROPOSAL_COST_GEMS} gems — you have ${gems}. Solve more problems to earn gems.`;

export interface LinkedProblemDto {
  id: string;
  slug: string;
  isPublished: boolean;
}

export interface ProposalSummaryDto {
  id: string;
  status: ProblemProposalStatus;
  title: string;
  difficulty: IProblemProposal["difficulty"];
  tags: string[];
  testCaseCount: number;
  sampleCount: number;
  noteToReviewer: string;
  reviewNote: string | null;
  reviewedAt: string | null;
  submittedAt: string;
  createdAt: string;
  updatedAt: string;
  problem: LinkedProblemDto | null;
  // Gems this proposal has cost its author in total, and how many came back.
  gemsSpent: number;
  gemsRefunded: number;
  // Only on the admin endpoints.
  user?: { id: string; name: string; email: string; role: IUser["role"] };
}

export interface ProposalDetailDto extends ProposalSummaryDto {
  statement: string;
  inputFormat: string;
  outputFormat: string;
  constraints: string;
  timeLimitMs: number;
  memoryLimitMb: number;
  testCases: IProposalTestCase[];
  starterCode: Record<ProposalLanguage, string>;
  referenceSolution: { language: ProposalLanguage; code: string } | null;
}

const isDuplicateKeyError = (error: unknown) => typeof error === "object" && error !== null && (error as { code?: unknown }).code === 11000;

const toPositiveInt = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : fallback;
};

// req.body is whatever JSON the client sent (or undefined), so every field is
// type-checked before use and a wrong type is a clear 400, never a 500.
const toBodyObject = (payload: unknown) => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new AppError("Request body must be a JSON object.", 400);
  }
  return payload as Record<string, unknown>;
};

const isBlank = (value: unknown) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");

const requiredText = (value: unknown, field: string, min: number, max: number) => {
  if (typeof value !== "string" || !value.trim()) throw new AppError(`${field} is required.`, 400);
  const text = value.trim().replace(/\r\n?/g, "\n");
  if (text.length < min || text.length > max) throw new AppError(`${field} must be between ${min} and ${max} characters.`, 400);
  return text;
};

const optionalText = (value: unknown, field: string, max: number) => {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new AppError(`${field} must be text.`, 400);
  const text = value.trim().replace(/\r\n?/g, "\n");
  if (text.length > max) throw new AppError(`${field} must be at most ${max} characters.`, 400);
  return text;
};

const optionalInteger = (value: unknown, field: string, min: number, max: number, fallback: number) => {
  if (isBlank(value)) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new AppError(`${field} must be a whole number between ${min} and ${max}.`, 400);
  }
  return value;
};

// Test case text is kept exactly as typed (spaces can matter to a program's
// input); only Windows line endings are normalised.
const caseText = (value: unknown, field: string) => {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new AppError(`${field} must be text.`, 400);
  const text = value.replace(/\r\n?/g, "\n");
  if (text.length > LIMITS.testCaseTextMax) throw new AppError(`${field} must be at most ${LIMITS.testCaseTextMax} characters.`, 400);
  return text;
};

const code = (value: unknown, field: string) => {
  if (typeof value !== "string") throw new AppError(`${field} must be text.`, 400);
  if (value.length > LIMITS.codeMax) throw new AppError(`${field} must be at most ${LIMITS.codeMax} characters.`, 400);
  return value.replace(/\r\n?/g, "\n");
};

const toIsoOrNull = (value?: Date | null) => (value ? new Date(value).toISOString() : null);

const parseTags = (value: unknown) => {
  if (isBlank(value)) return [];
  const raw = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(raw) || raw.some((tag) => typeof tag !== "string")) throw new AppError("Tags must be a list of words.", 400);
  const tags: string[] = [];
  for (const tag of raw as string[]) {
    const text = tag.trim();
    if (!text || tags.some((existing) => existing.toLowerCase() === text.toLowerCase())) continue;
    if (text.length > LIMITS.tagMax) throw new AppError(`Each tag must be at most ${LIMITS.tagMax} characters.`, 400);
    tags.push(text);
  }
  if (tags.length > LIMITS.tagsMax) throw new AppError(`A proposal can have at most ${LIMITS.tagsMax} tags.`, 400);
  return tags;
};

const parseTestCases = (value: unknown): IProposalTestCase[] => {
  if (!Array.isArray(value)) throw new AppError("Add at least one test case.", 400);
  if (value.length > LIMITS.testCasesMax) throw new AppError(`A proposal can have at most ${LIMITS.testCasesMax} test cases.`, 400);
  const testCases = value
    .map((raw, index) => {
      const label = `Test case ${index + 1}`;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new AppError(`${label} is not valid.`, 400);
      const item = raw as Record<string, unknown>;
      if (item.isSample !== undefined && typeof item.isSample !== "boolean") throw new AppError(`${label}: isSample must be true or false.`, 400);
      const explanation = optionalText(item.explanation, `${label} explanation`, LIMITS.explanationMax);
      const testCase: IProposalTestCase = {
        input: caseText(item.input, `${label} input`),
        expectedOutput: caseText(item.expectedOutput, `${label} expected output`),
        isSample: item.isSample === true,
      };
      if (explanation) testCase.explanation = explanation;
      return testCase;
    })
    // A block left completely empty is ignored, the same as in the admin form.
    .filter((testCase) => testCase.input.trim() !== "" || testCase.expectedOutput.trim() !== "");
  if (!testCases.length) throw new AppError("Add at least one test case.", 400);
  if (!testCases.some((testCase) => testCase.isSample)) {
    throw new AppError("Mark at least one test case as a sample so learners can see an example.", 400);
  }
  return testCases;
};

const parseStarterCode = (value: unknown) => {
  const starterCode: Record<ProposalLanguage, string> = { python: "", cpp: "", javascript: "", typescript: "" };
  if (isBlank(value)) return starterCode;
  if (typeof value !== "object" || Array.isArray(value)) throw new AppError("Starter code must be an object.", 400);
  for (const language of LANGUAGES) {
    const languageCode = (value as Record<string, unknown>)[language];
    if (languageCode === undefined || languageCode === null) continue;
    starterCode[language] = code(languageCode, `Starter code (${language})`);
  }
  return starterCode;
};

const parseReferenceSolution = (value: unknown) => {
  if (isBlank(value)) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new AppError("Reference solution must be an object.", 400);
  const solution = value as Record<string, unknown>;
  if (isBlank(solution.code)) return undefined;
  if (typeof solution.language !== "string" || !LANGUAGES.includes(solution.language as ProposalLanguage)) {
    throw new AppError("Reference solution language must be one of: python, cpp, javascript, typescript.", 400);
  }
  return { language: solution.language as ProposalLanguage, code: code(solution.code, "Reference solution") };
};

const parseProposalInput = (payload: unknown) => {
  const body = toBodyObject(payload);
  if (typeof body.difficulty !== "string" || !DIFFICULTIES.includes(body.difficulty as IProblemProposal["difficulty"])) {
    throw new AppError("Difficulty must be one of: EASY, MEDIUM, HARD.", 400);
  }
  return {
    title: requiredText(body.title, "Title", LIMITS.titleMin, LIMITS.titleMax),
    statement: requiredText(body.statement, "Statement", LIMITS.statementMin, LIMITS.statementMax),
    inputFormat: optionalText(body.inputFormat, "Input format", LIMITS.formatMax),
    outputFormat: optionalText(body.outputFormat, "Output format", LIMITS.formatMax),
    constraints: optionalText(body.constraints, "Constraints", LIMITS.constraintsMax),
    difficulty: body.difficulty as IProblemProposal["difficulty"],
    tags: parseTags(body.tags),
    timeLimitMs: optionalInteger(body.timeLimitMs, "Time limit", LIMITS.timeLimitMin, LIMITS.timeLimitMax, 2000),
    memoryLimitMb: optionalInteger(body.memoryLimitMb, "Memory limit", LIMITS.memoryLimitMin, LIMITS.memoryLimitMax, 256),
    testCases: parseTestCases(body.testCases),
    starterCode: parseStarterCode(body.starterCode),
    referenceSolution: parseReferenceSolution(body.referenceSolution),
    noteToReviewer: optionalText(body.noteToReviewer, "Note for the reviewer", LIMITS.noteMax),
  };
};

// Built by hand rather than through toJSON so the API shape stays fixed no
// matter what gets added to the schema later.
const toSummaryDto = (proposal: LeanProposal, problem?: LinkedProblem | null, user?: LeanProposer | null): ProposalSummaryDto => {
  const testCases = proposal.testCases ?? [];
  const dto: ProposalSummaryDto = {
    id: String(proposal._id),
    status: proposal.status,
    title: proposal.title,
    difficulty: proposal.difficulty,
    tags: proposal.tags ?? [],
    testCaseCount: testCases.length,
    sampleCount: testCases.filter((testCase) => testCase.isSample).length,
    noteToReviewer: proposal.noteToReviewer ?? "",
    reviewNote: proposal.reviewNote ?? null,
    reviewedAt: toIsoOrNull(proposal.reviewedAt),
    submittedAt: new Date(proposal.submittedAt ?? proposal.createdAt).toISOString(),
    createdAt: new Date(proposal.createdAt).toISOString(),
    updatedAt: new Date(proposal.updatedAt).toISOString(),
    problem: problem ? { id: String(problem._id), slug: problem.slug, isPublished: problem.isPublished } : null,
    gemsSpent: proposal.gemsSpent ?? 0,
    gemsRefunded: proposal.gemsRefunded ?? 0,
  };
  if (user) dto.user = { id: String(user._id), name: user.name, email: user.email, role: user.role };
  return dto;
};

const toDetailDto = (proposal: LeanProposal, problem?: LinkedProblem | null, user?: LeanProposer | null): ProposalDetailDto => ({
  ...toSummaryDto(proposal, problem, user),
  statement: proposal.statement,
  inputFormat: proposal.inputFormat ?? "",
  outputFormat: proposal.outputFormat ?? "",
  constraints: proposal.constraints ?? "",
  timeLimitMs: proposal.timeLimitMs ?? 2000,
  memoryLimitMb: proposal.memoryLimitMb ?? 256,
  testCases: (proposal.testCases ?? []).map(({ input, expectedOutput, explanation, isSample }) => ({
    input: input ?? "",
    expectedOutput: expectedOutput ?? "",
    ...(explanation ? { explanation } : {}),
    isSample: Boolean(isSample),
  })),
  starterCode: {
    python: proposal.starterCode?.python ?? "",
    cpp: proposal.starterCode?.cpp ?? "",
    javascript: proposal.starterCode?.javascript ?? "",
    typescript: proposal.starterCode?.typescript ?? "",
  },
  referenceSolution: proposal.referenceSolution?.code
    ? { language: proposal.referenceSolution.language, code: proposal.referenceSolution.code }
    : null,
});

const loadLinkedProblems = async (proposals: LeanProposal[]) => {
  const problemIds = proposals.map((proposal) => proposal.problemId).filter(Boolean);
  if (!problemIds.length) return new Map<string, LinkedProblem>();
  const problems = (await ProblemModel.find({ _id: { $in: problemIds } })
    .select("slug isPublished")
    .lean()) as unknown as LinkedProblem[];
  return new Map(problems.map((problem) => [String(problem._id), problem]));
};

const loadProposer = async (userId: Types.ObjectId) =>
  (await UserModel.findById(userId).select("name email role").lean()) as unknown as LeanProposer | null;

// Runs `work` in a MongoDB transaction and returns its result. withTransaction
// can retry `work` after a transient error, so it must only write through the
// session.
const inTransaction = async <T>(work: (session: ClientSession) => Promise<T>) => {
  const session = await mongoose.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result as T;
  } finally {
    await session.endSession();
  }
};

// Takes the proposal cost only if the balance covers it, so two proposals sent
// at the same moment can never push the balance below zero.
const chargeProposalCost = async (userId: string, session: ClientSession) => {
  const charged = await UserModel.findOneAndUpdate(
    { _id: userId, gems: { $gte: PROPOSAL_COST_GEMS } },
    { $inc: { gems: -PROPOSAL_COST_GEMS } },
    { session },
  )
    .select("_id")
    .lean();
  if (charged) return;
  const user = (await UserModel.findById(userId).select("gems").session(session).lean()) as unknown as { gems?: number } | null;
  if (!user) throw new AppError("User not found.", 404);
  throw new AppError(notEnoughGemsMessage(user.gems ?? 0), 403);
};

// An author whose account has since been deleted simply gets nothing back.
const refundGems = async (userId: Types.ObjectId, amount: number, session: ClientSession) => {
  if (amount > 0) await UserModel.updateOne({ _id: userId }, { $inc: { gems: amount } }, { session });
};

// Lowercase ASCII words joined by hyphens; titles with no such characters
// (e.g. written in another script) fall back to "problem".
const slugify = (title: string) =>
  title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, LIMITS.slugMax - 10)
    .replace(/-+$/g, "") || "problem";

const findFreeSlug = async (base: string) => {
  const root = base.length >= LIMITS.slugMin ? base : `${base}-problem`;
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const candidate = attempt === 1 ? root : `${root}-${attempt}`;
    if (!(await ProblemModel.exists({ slug: candidate }))) return candidate;
  }
  return `${root}-${Date.now().toString(36)}`;
};

const getMyProposals = async (userId: string) => {
  const [user, proposals, pendingCount] = (await Promise.all([
    UserModel.findById(userId).select("gems").lean(),
    ProblemProposalModel.find({ userId }).sort({ createdAt: -1, _id: -1 }).limit(100).lean(),
    ProblemProposalModel.countDocuments({ userId, status: "pending" }),
  ])) as unknown as [{ gems?: number } | null, LeanProposal[], number];
  if (!user) throw new AppError("User not found.", 404);

  const gems = user.gems ?? 0;
  const problems = await loadLinkedProblems(proposals);
  return {
    gems,
    cost: PROPOSAL_COST_GEMS,
    rejectRefund: PROPOSAL_REJECT_REFUND_GEMS,
    maxPending: MAX_PENDING_PROPOSALS,
    pendingCount,
    canPropose: gems >= PROPOSAL_COST_GEMS && pendingCount < MAX_PENDING_PROPOSALS,
    items: proposals.map((proposal) => toSummaryDto(proposal, problems.get(String(proposal.problemId)))),
  };
};

const createProposal = async (userId: string, payload: unknown) => {
  const user = (await UserModel.findById(userId).select("gems").lean()) as unknown as { gems?: number } | null;
  if (!user) throw new AppError("User not found.", 404);
  if ((user.gems ?? 0) < PROPOSAL_COST_GEMS) throw new AppError(notEnoughGemsMessage(user.gems ?? 0), 403);
  if ((await ProblemProposalModel.countDocuments({ userId, status: "pending" })) >= MAX_PENDING_PROPOSALS) {
    throw new AppError(PENDING_LIMIT_MESSAGE, 409);
  }

  const input = parseProposalInput(payload);
  // The charge and the proposal are written together: a failure never takes
  // gems without saving the proposal, or saves it without taking them.
  const created = await inTransaction(async (session) => {
    await chargeProposalCost(userId, session);
    const [proposal] = (await ProblemProposalModel.create(
      [
        {
          userId,
          ...input,
          status: "pending",
          submittedAt: new Date(),
          gemsSpent: PROPOSAL_COST_GEMS,
          gemsRefunded: 0,
          pendingCharge: PROPOSAL_COST_GEMS,
        },
      ],
      { session },
    )) as unknown as { toObject: () => unknown }[];
    return proposal.toObject() as unknown as LeanProposal;
  });
  return toDetailDto(created);
};

// The author and admins can read a proposal; anyone else gets the same 404 as
// a missing one.
const getProposal = async (proposalId: string, requester: { userId: string; role?: string }) => {
  if (!Types.ObjectId.isValid(proposalId)) throw new AppError(NOT_FOUND_MESSAGE, 404);
  const proposal = (await ProblemProposalModel.findById(proposalId).lean()) as unknown as LeanProposal | null;
  const isAdmin = requester.role === "admin";
  if (!proposal || (!isAdmin && String(proposal.userId) !== requester.userId)) throw new AppError(NOT_FOUND_MESSAGE, 404);

  const [problems, user] = await Promise.all([loadLinkedProblems([proposal]), isAdmin ? loadProposer(proposal.userId) : null]);
  return toDetailDto(proposal, problems.get(String(proposal.problemId)), user);
};

const updateProposal = async (proposalId: string, userId: string, payload: unknown) => {
  if (!Types.ObjectId.isValid(proposalId)) throw new AppError(NOT_FOUND_MESSAGE, 404);
  const current = (await ProblemProposalModel.findOne({ _id: proposalId, userId }).select("status").lean()) as unknown as
    | { status: ProblemProposalStatus }
    | null;
  if (!current) throw new AppError(NOT_FOUND_MESSAGE, 404);
  if (!EDITABLE_STATUSES.includes(current.status)) {
    throw new AppError("This proposal was accepted and is already in the problem library, so it can't be edited.", 409);
  }

  const { referenceSolution, ...fields } = parseProposalInput(payload);
  // Editing a rejected proposal sends it back to the review queue. That's a
  // new submission, so it costs the proposal fee again.
  const resubmit = current.status === "rejected";
  if (resubmit) {
    if ((await ProblemProposalModel.countDocuments({ userId, status: "pending" })) >= MAX_PENDING_PROPOSALS) {
      throw new AppError(PENDING_LIMIT_MESSAGE, 409);
    }
    const user = (await UserModel.findById(userId).select("gems").lean()) as unknown as { gems?: number } | null;
    if ((user?.gems ?? 0) < PROPOSAL_COST_GEMS) throw new AppError(notEnoughGemsMessage(user?.gems ?? 0), 403);
  }

  const $set: Record<string, unknown> = { ...fields };
  const $unset: Record<string, 1> = {};
  const $inc: Record<string, number> = {};
  if (referenceSolution) $set.referenceSolution = referenceSolution;
  else $unset.referenceSolution = 1;
  if (resubmit) {
    $set.status = "pending";
    $set.submittedAt = new Date();
    $set.pendingCharge = PROPOSAL_COST_GEMS;
    $inc.gemsSpent = PROPOSAL_COST_GEMS;
    $unset.reviewNote = 1;
    $unset.reviewedBy = 1;
    $unset.reviewedAt = 1;
  }

  // Conditioned on the status read above, so an admin decision made in the
  // meantime is never overwritten by a stale edit.
  const save = async (session?: ClientSession) =>
    (await ProblemProposalModel.findOneAndUpdate(
      { _id: proposalId, userId, status: current.status },
      { $set, $unset, ...(resubmit ? { $inc } : {}) },
      { new: true, runValidators: true, session },
    ).lean()) as unknown as LeanProposal | null;

  const updated = resubmit
    ? await inTransaction(async (session) => {
        await chargeProposalCost(userId, session);
        const saved = await save(session);
        // Throwing inside the transaction also rolls the charge back.
        if (!saved) throw new AppError(STALE_EDIT_MESSAGE, 409);
        return saved;
      })
    : await save();
  if (!updated) throw new AppError(STALE_EDIT_MESSAGE, 409);
  return toDetailDto(updated);
};

const deleteProposal = async (proposalId: string, userId: string) => {
  if (!Types.ObjectId.isValid(proposalId)) throw new AppError(NOT_FOUND_MESSAGE, 404);
  const current = (await ProblemProposalModel.findOne({ _id: proposalId, userId }).select("status").lean()) as unknown as
    | { status: ProblemProposalStatus }
    | null;
  if (!current) throw new AppError(NOT_FOUND_MESSAGE, 404);
  if (!EDITABLE_STATUSES.includes(current.status)) {
    throw new AppError("An accepted proposal can't be deleted — it's part of the problem library now.", 409);
  }

  const gemsRefunded = await inTransaction(async (session) => {
    const removed = (await ProblemProposalModel.findOneAndDelete(
      { _id: proposalId, userId, status: { $in: EDITABLE_STATUSES } },
      { session },
    ).lean()) as unknown as LeanProposal | null;
    if (!removed) throw new AppError(STALE_EDIT_MESSAGE, 409);
    // Withdrawing a proposal nobody has reviewed yet returns what it cost. A
    // rejected one already got its half back when it was rejected.
    const refund = removed.status === "pending" ? (removed.pendingCharge ?? 0) : 0;
    await refundGems(removed.userId, refund, session);
    return refund;
  });
  return { deleted: true, gemsRefunded };
};

interface IListProposalsQuery {
  status?: unknown;
  page?: unknown;
  limit?: unknown;
}

const listProposals = async ({ status: rawStatus, page, limit }: IListProposalsQuery) => {
  const status = rawStatus === undefined || rawStatus === "" ? "pending" : rawStatus;
  if (status !== "all" && !PROPOSAL_STATUSES.includes(status as ProblemProposalStatus)) {
    throw new AppError("status must be one of: pending, accepted, rejected, all.", 400);
  }
  const filter: FilterQuery<IProblemProposal> = status === "all" ? {} : { status: status as ProblemProposalStatus };

  const safeLimit = Math.min(toPositiveInt(limit, 20), 100);
  const safePage = toPositiveInt(page, 1);

  // The list only needs summaries; the full statement, test cases and code
  // are loaded per proposal when an admin opens its details.
  const [proposals, total, pendingCount] = (await Promise.all([
    ProblemProposalModel.find(filter)
      .select({
        statement: 0,
        inputFormat: 0,
        outputFormat: 0,
        constraints: 0,
        starterCode: 0,
        referenceSolution: 0,
        "testCases.input": 0,
        "testCases.expectedOutput": 0,
        "testCases.explanation": 0,
      })
      .sort({ submittedAt: -1, _id: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),
    ProblemProposalModel.countDocuments(filter),
    ProblemProposalModel.countDocuments({ status: "pending" }),
  ])) as unknown as [LeanProposal[], number, number];

  const userIds = [...new Set(proposals.map((proposal) => String(proposal.userId)))];
  const [users, problems] = await Promise.all([
    userIds.length
      ? ((await UserModel.find({ _id: { $in: userIds } }).select("name email role").lean()) as unknown as LeanProposer[])
      : [],
    loadLinkedProblems(proposals),
  ]);
  const userById = new Map(users.map((user) => [String(user._id), user]));

  return {
    // A proposal whose author has since been deleted is listed without `user`.
    items: proposals.map((proposal) =>
      toSummaryDto(proposal, problems.get(String(proposal.problemId)), userById.get(String(proposal.userId))),
    ),
    total,
    page: safePage,
    limit: safeLimit,
    pendingCount,
  };
};

const reviewProposal = async (proposalId: string, reviewerId: string, payload: unknown) => {
  if (!Types.ObjectId.isValid(proposalId)) throw new AppError(NOT_FOUND_MESSAGE, 404);
  const body = toBodyObject(payload);
  const { action } = body;
  if (action !== "accept" && action !== "reject") throw new AppError('action must be "accept" or "reject".', 400);
  const note = optionalText(body.note, "Note", LIMITS.reviewNoteMax);

  const proposal = (await ProblemProposalModel.findById(proposalId).lean()) as unknown as LeanProposal | null;
  if (!proposal) throw new AppError(NOT_FOUND_MESSAGE, 404);
  if (proposal.status !== "pending") throw new AppError(ALREADY_REVIEWED_MESSAGE, 409);

  const reviewFields = { reviewedBy: reviewerId, reviewedAt: new Date(), ...(note ? { reviewNote: note } : {}) };

  if (action === "reject") {
    await inTransaction(async (session) => {
      // Conditioned on the proposal still being pending, so two admins
      // reviewing it at once can't both win (or refund twice). It returns the
      // document as it was, to read what this review was paid with.
      const before = (await ProblemProposalModel.findOneAndUpdate(
        { _id: proposal._id, status: "pending" },
        { $set: { status: "rejected", pendingCharge: 0, ...reviewFields } },
        { new: false, session },
      ).lean()) as unknown as LeanProposal | null;
      if (!before) throw new AppError(ALREADY_REVIEWED_MESSAGE, 409);
      // A rejected proposal gets half of what it cost back.
      const refund = Math.floor((before.pendingCharge ?? 0) / 2);
      if (refund > 0) {
        await ProblemProposalModel.updateOne({ _id: proposal._id }, { $inc: { gemsRefunded: refund } }, { session });
        await refundGems(before.userId, refund, session);
      }
    });
    const rejected = (await ProblemProposalModel.findById(proposal._id).lean()) as unknown as LeanProposal;
    return toDetailDto(rejected, null, await loadProposer(rejected.userId));
  }

  const basePoints = optionalInteger(body.basePoints, "Base points", 0, LIMITS.pointsMax, 100);
  if (body.publish !== undefined && typeof body.publish !== "boolean") throw new AppError("publish must be true or false.", 400);
  const publish = body.publish === true;

  let slug: string;
  if (isBlank(body.slug)) {
    slug = await findFreeSlug(slugify(proposal.title));
  } else {
    if (typeof body.slug !== "string") throw new AppError("Slug must be text.", 400);
    slug = body.slug.trim().toLowerCase();
    if (slug.length < LIMITS.slugMin || slug.length > LIMITS.slugMax || !SLUG_PATTERN.test(slug)) {
      throw new AppError(`Slug must be ${LIMITS.slugMin}–${LIMITS.slugMax} lowercase letters or numbers separated by single hyphens (e.g. two-sum).`, 400);
    }
    if (await ProblemModel.exists({ slug })) throw new AppError(SLUG_TAKEN_MESSAGE, 409);
  }

  const testCases = proposal.testCases ?? [];
  const session = await mongoose.startSession();
  try {
    // The status change, the problem and its test cases are written together:
    // a failure part-way never leaves an "accepted" proposal without a
    // problem, or a problem the judge can't grade.
    await session.withTransaction(async () => {
      const accepted = (await ProblemProposalModel.findOneAndUpdate(
        { _id: proposal._id, status: "pending" },
        // An accepted proposal keeps its full cost.
        { $set: { status: "accepted", pendingCharge: 0, ...reviewFields } },
        { new: true, session },
      ).lean()) as unknown as LeanProposal | null;
      if (!accepted) throw new AppError(ALREADY_REVIEWED_MESSAGE, 409);

      const [problem] = (await ProblemModel.create(
        [
          {
            slug,
            title: accepted.title,
            statement: accepted.statement,
            inputFormat: accepted.inputFormat ?? "",
            outputFormat: accepted.outputFormat ?? "",
            constraints: accepted.constraints ?? "",
            difficulty: accepted.difficulty,
            tags: accepted.tags ?? [],
            timeLimitMs: accepted.timeLimitMs ?? 2000,
            memoryLimitMb: accepted.memoryLimitMb ?? 256,
            basePoints,
            sampleTests: testCases
              .filter((testCase) => testCase.isSample)
              .map(({ input, expectedOutput, explanation }) => ({ input, expectedOutput, ...(explanation ? { explanation } : {}) })),
            starterCode: {
              python: accepted.starterCode?.python ?? "",
              cpp: accepted.starterCode?.cpp ?? "",
              javascript: accepted.starterCode?.javascript ?? "",
              typescript: accepted.starterCode?.typescript ?? "",
            },
            ...(accepted.referenceSolution?.code ? { referenceSolution: accepted.referenceSolution } : {}),
            isPublished: publish,
            // Credits the learner who proposed it.
            createdBy: accepted.userId,
          },
        ],
        { session },
      )) as unknown as { _id: Types.ObjectId }[];

      // Every case, sample and hidden, is graded — the same as the admin
      // "Create problem" flow. They were reviewed along with the proposal.
      await TestCaseModel.insertMany(
        testCases.map((testCase, index) => ({
          problemId: problem._id,
          input: testCase.input,
          expectedOutput: testCase.expectedOutput,
          isSample: testCase.isSample,
          order: index,
          source: "manual",
          reviewed: true,
        })),
        { session },
      );
      await ProblemProposalModel.updateOne({ _id: proposal._id }, { $set: { problemId: problem._id } }, { session });
    });
  } catch (error) {
    // Another problem took the slug between the check above and the insert.
    if (isDuplicateKeyError(error)) throw new AppError(SLUG_TAKEN_MESSAGE, 409);
    throw error;
  } finally {
    await session.endSession();
  }

  const accepted = (await ProblemProposalModel.findById(proposal._id).lean()) as unknown as LeanProposal;
  const [problems, user] = await Promise.all([loadLinkedProblems([accepted]), loadProposer(accepted.userId)]);
  return toDetailDto(accepted, problems.get(String(accepted.problemId)), user);
};

export const proposalService = {
  getMyProposals,
  createProposal,
  getProposal,
  updateProposal,
  deleteProposal,
  listProposals,
  reviewProposal,
};
