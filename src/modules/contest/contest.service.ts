// Service for contest lifecycle management, registration, and scoreboard logic.

import { FilterQuery, Types } from "mongoose";
import { ContestModel, type IContest, type IContestProblem } from "../../models/Contest.model.js";
import { ContestParticipantModel } from "../../models/ContestParticipant.model.js";
import { ProblemModel, type Difficulty } from "../../models/Problem.model.js";
import { SubmissionModel } from "../../models/Submission.model.js";
import { UserModel, type IUser } from "../../models/User.model.js";
import { AppError } from "../../utils/errors.js";

// mongoose.models.Contest || model<IContest>(...) widens to a loosely-typed
// Model union, so .findOne().lean() needs an explicit cast — same pattern
// used throughout problem.service.ts.
type LeanContest = IContest & { _id: Types.ObjectId };

export type ContestStatus = "UPCOMING" | "ONGOING" | "ENDED";

// Status is derived, never stored, so a contest never needs a background
// job to "start" or "end" it — it's always correct relative to `now`.
export const getContestStatus = (contest: { startTime: Date; endTime: Date }, now = new Date()): ContestStatus => {
  if (now < contest.startTime) return "UPCOMING";
  if (now > contest.endTime) return "ENDED";
  return "ONGOING";
};

const findContestByIdentifier = async (identifier: string) => {
  const filter = Types.ObjectId.isValid(identifier) ? { $or: [{ _id: identifier }, { slug: identifier }] } : { slug: identifier };
  return (await ContestModel.findOne(filter).lean()) as unknown as LeanContest | null;
};

const listContests = async ({ page = 1, limit = 20 }: { page?: number; limit?: number }) => {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const safePage = Math.max(page, 1);

  const [items, total] = (await Promise.all([
    ContestModel.find({ isPublished: true })
      .select("slug title description startTime endTime problems")
      .sort({ startTime: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),
    ContestModel.countDocuments({ isPublished: true }),
  ])) as unknown as [LeanContest[], number];

  const now = new Date();
  return {
    items: items.map((contest) => ({
      id: String(contest._id),
      slug: contest.slug,
      title: contest.title,
      description: contest.description,
      startTime: contest.startTime,
      endTime: contest.endTime,
      problemCount: contest.problems.length,
      status: getContestStatus(contest, now),
    })),
    total,
    page: safePage,
    limit: safeLimit,
  };
};

const getContestByIdentifier = async (identifier: string, userId?: string) => {
  const contest = await findContestByIdentifier(identifier);
  if (!contest || !contest.isPublished) throw new AppError("Contest not found.", 404);

  // isPublished: true matches listProblems()/getBySlug() (public browsing) —
  // without this, an unpublished draft attached to a contest rendered as a
  // clickable problem-card link on the contest page (real slug, real title)
  // that 404'd the moment anyone clicked it, since the actual problem page
  // load does filter by isPublished. Now it degrades to the same
  // "(unavailable)" placeholder the frontend already renders for a missing
  // problem, instead of a dead link.
  const problems = await ProblemModel.find({
    _id: { $in: contest.problems.map((entry) => entry.problemId) },
    isPublished: true,
  })
    .select("slug title difficulty")
    .lean();
  const problemById = new Map(problems.map((problem) => [String(problem._id), problem]));

  const isRegistered = userId
    ? Boolean(await ContestParticipantModel.exists({ contestId: contest._id, userId }))
    : false;

  return {
    id: String(contest._id),
    slug: contest.slug,
    title: contest.title,
    description: contest.description,
    startTime: contest.startTime,
    endTime: contest.endTime,
    status: getContestStatus(contest),
    isRegistered,
    problems: contest.problems
      .sort((a, b) => a.order - b.order)
      .map((entry) => {
        const problem = problemById.get(String(entry.problemId));
        return {
          problemId: String(entry.problemId),
          slug: problem?.slug ?? null,
          title: problem?.title ?? "Unknown problem",
          difficulty: problem?.difficulty ?? null,
          points: entry.points,
        };
      }),
  };
};

// Who is calling a management endpoint (POST / and the /manage routes).
// Admins can manage every contest; a guest — a user whose host request was
// approved, see modules/host — only the contests they created themselves.
export type ContestManager = { userId: string; role: string };

const isAdmin = (manager: ContestManager) => manager.role === "admin";

// A guest's view is narrowed in the query itself, so someone else's contest
// is simply "not found" (404) rather than "forbidden" (403) — the status code
// can't be used to probe which contest ids exist.
const manageScope = (manager: ContestManager): FilterQuery<IContest> => (isAdmin(manager) ? {} : { createdBy: manager.userId });

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// GET /api/contests/manage is the management list (see contest.route.ts), so
// a contest with this slug could never be opened at its public URL.
const RESERVED_SLUGS = new Set(["manage"]);
const MAX_CONTEST_PROBLEMS = 50;
const SLUG_CONFLICT_MESSAGE = "A contest with this slug already exists.";

// Search text is matched literally and capped before it reaches $regex — same
// helper as in problem.service.ts / admin.service.ts.
const MAX_SEARCH_LENGTH = 100;
const toSearchRegex = (search: string) => search.trim().slice(0, MAX_SEARCH_LENGTH).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toPositiveInt = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : fallback;
};

const isDuplicateKeyError = (error: unknown) => typeof error === "object" && error !== null && (error as { code?: unknown }).code === 11000;

// Besides _id, slug is a contest's only unique index, so a duplicate-key error
// on create/update means a racing request took the slug after our check.
const rethrowSlugConflict = (error: unknown): never => {
  if (isDuplicateKeyError(error)) throw new AppError(SLUG_CONFLICT_MESSAGE, 409);
  throw error;
};

// Every field is type-checked before use: req.body is whatever JSON the
// client sent (or undefined when there is no body at all), so a wrong type
// has to be a clear 400 rather than a TypeError surfacing as a 500.
const toBodyObject = (payload: unknown) => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new AppError("Request body must be a JSON object.", 400);
  }
  return payload as Record<string, unknown>;
};

const parseTitle = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) throw new AppError("title is required.", 400);
  const title = value.trim();
  if (title.length < 3 || title.length > 120) throw new AppError("title must be between 3 and 120 characters.", 400);
  return title;
};

const parseSlug = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) throw new AppError("slug is required.", 400);
  const slug = value.trim().toLowerCase();
  if (slug.length < 3 || slug.length > 80) throw new AppError("slug must be between 3 and 80 characters.", 400);
  if (!SLUG_PATTERN.test(slug)) {
    throw new AppError("slug may only contain lowercase letters and numbers, separated by single hyphens (e.g. weekly-contest-12).", 400);
  }
  if (RESERVED_SLUGS.has(slug)) throw new AppError(`"${slug}" is reserved and can't be used as a contest slug.`, 400);
  return slug;
};

const parseDescription = (value: unknown) => {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new AppError("description must be a string.", 400);
  const description = value.trim();
  if (description.length > 5000) throw new AppError("description must be at most 5000 characters.", 400);
  return description;
};

const parseDate = (value: unknown, field: "startTime" | "endTime") => {
  if (value === undefined || value === null) throw new AppError(`${field} is required.`, 400);
  const date = typeof value === "string" || typeof value === "number" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw new AppError(`${field} must be a valid date.`, 400);
  return date;
};

const parseIsPublished = (value: unknown) => {
  if (typeof value !== "boolean") throw new AppError("isPublished must be true or false.", 400);
  return value;
};

// problems: [{ problemId, points? }] in display order. A guest may only add
// published problems — except ones already in the contest being edited
// (`keepProblemIds`): a problem unpublished after it was added, or attached
// by an admin, mustn't make the rest of the guest's contest unsaveable when
// the client sends the unchanged list back.
const parseProblems = async (value: unknown, manager: ContestManager, keepProblemIds = new Set<string>()): Promise<IContestProblem[]> => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new AppError("problems must be an array.", 400);
  if (value.length > MAX_CONTEST_PROBLEMS) throw new AppError(`A contest can have at most ${MAX_CONTEST_PROBLEMS} problems.`, 400);

  const seen = new Set<string>();
  const entries = value.map((entry: unknown, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new AppError(`problems[${index}] must be an object with a problemId.`, 400);
    }
    const { problemId, points: rawPoints } = entry as Record<string, unknown>;
    if (typeof problemId !== "string" || !Types.ObjectId.isValid(problemId)) {
      throw new AppError(`problems[${index}].problemId must be a valid problem id.`, 400);
    }
    const id = new Types.ObjectId(problemId);
    if (seen.has(String(id))) throw new AppError("The same problem can't be added to a contest twice.", 400);
    seen.add(String(id));

    const points = rawPoints === undefined || rawPoints === null ? 100 : rawPoints;
    if (typeof points !== "number" || !Number.isInteger(points) || points < 1 || points > 10000) {
      throw new AppError(`problems[${index}].points must be a whole number between 1 and 10000.`, 400);
    }
    return { problemId: id, points, order: index };
  });
  if (entries.length === 0) return entries;

  const found = (await ProblemModel.find({ _id: { $in: entries.map((entry) => entry.problemId) } })
    .select("isPublished")
    .lean()) as unknown as { _id: Types.ObjectId; isPublished: boolean }[];
  const problemById = new Map(found.map((problem) => [String(problem._id), problem]));
  for (const [index, entry] of entries.entries()) {
    const problem = problemById.get(String(entry.problemId));
    if (isAdmin(manager)) {
      if (!problem) throw new AppError(`problems[${index}] refers to a problem that doesn't exist.`, 400);
    } else if (!problem || (!problem.isPublished && !keepProblemIds.has(String(entry.problemId)))) {
      // One message for both cases, so a guest can't tell an unpublished
      // draft's id apart from an id that doesn't exist.
      throw new AppError(`problems[${index}] refers to a problem that doesn't exist or isn't published.`, 400);
    }
  }
  return entries;
};

const assertSlugAvailable = async (slug: string, excludeContestId?: Types.ObjectId) => {
  const filter: FilterQuery<IContest> = excludeContestId ? { slug, _id: { $ne: excludeContestId } } : { slug };
  if (await ContestModel.exists(filter)) throw new AppError(SLUG_CONFLICT_MESSAGE, 409);
};

// Open to admins and guests (see contest.route.ts). The response is still the
// saved document itself, whose toJSON adds `id`.
const createContest = async (payload: unknown, manager: ContestManager) => {
  const body = toBodyObject(payload);
  const title = parseTitle(body.title);
  const slug = parseSlug(body.slug);
  const description = parseDescription(body.description);
  const startTime = parseDate(body.startTime, "startTime");
  const endTime = parseDate(body.endTime, "endTime");
  if (endTime <= startTime) throw new AppError("endTime must be after startTime.", 400);
  const isPublished = body.isPublished === undefined ? true : parseIsPublished(body.isPublished);
  const problems = await parseProblems(body.problems, manager);
  await assertSlugAvailable(slug);

  try {
    return await ContestModel.create({ title, slug, description, startTime, endTime, problems, isPublished, createdBy: manager.userId });
  } catch (error) {
    return rethrowSlugConflict(error);
  }
};

const registerForContest = async (identifier: string, userId: string) => {
  const contest = await findContestByIdentifier(identifier);
  if (!contest || !contest.isPublished) throw new AppError("Contest not found.", 404);
  if (getContestStatus(contest) === "ENDED") throw new AppError("This contest has already ended.", 400);

  await ContestParticipantModel.findOneAndUpdate(
    { contestId: contest._id, userId },
    { $setOnInsert: { contestId: contest._id, userId, registeredAt: new Date() } },
    { upsert: true, new: true },
  );

  return { registered: true };
};

// Checks that a submission tagged with this contest may count toward it and
// returns the contest's id. Any well-formed contestId used to be accepted, so
// submissions made before the contest started, after it ended, without
// registering, or for problems outside the contest all landed on its
// scoreboard.
const getSubmissionContext = async (contestId: string, userId: string, problemId: string) => {
  if (!Types.ObjectId.isValid(contestId)) throw new AppError("contestId is not a valid id.", 400);
  const contest = (await ContestModel.findById(contestId).lean()) as unknown as LeanContest | null;
  if (!contest || !contest.isPublished) throw new AppError("Contest not found.", 404);

  const status = getContestStatus(contest);
  if (status === "UPCOMING") throw new AppError("This contest hasn't started yet.", 403);
  if (status === "ENDED") throw new AppError("This contest has ended. Open the problem from the problem list to keep practicing.", 403);
  if (!contest.problems.some((entry) => String(entry.problemId) === problemId)) {
    throw new AppError("This problem is not part of the contest.", 400);
  }
  if (!(await ContestParticipantModel.exists({ contestId: contest._id, userId }))) {
    throw new AppError("Register for the contest before submitting.", 403);
  }

  return { contestId: contest._id };
};

// Scoreboard: for each participant, the best score per contest problem
// (their highest-scoring submission tagged with this contest), summed.
const getScoreboard = async (identifier: string) => {
  const contest = await findContestByIdentifier(identifier);
  if (!contest || !contest.isPublished) throw new AppError("Contest not found.", 404);

  const problemIds = contest.problems.map((entry) => entry.problemId);
  const pointsByProblem = new Map(contest.problems.map((entry) => [String(entry.problemId), entry.points]));
  const problems = (await ProblemModel.find({ _id: { $in: problemIds } })
    .select("basePoints")
    .lean()) as unknown as { _id: Types.ObjectId; basePoints: number }[];
  const basePointsByProblem = new Map(problems.map((problem) => [String(problem._id), problem.basePoints || 100]));

  // Only submissions made during the contest window, for the contest's own
  // problems, count — so the final standings can't change after it ends.
  // The window is checked against submittedAt (when the user pressed Submit),
  // not createdAt: the record is only saved once judging finishes, so its
  // createdAt lands a few seconds late and would drop last-second submissions.
  const rows = (await SubmissionModel.aggregate([
    { $match: { contestId: contest._id, problemId: { $in: problemIds }, submittedAt: { $gte: contest.startTime, $lte: contest.endTime } } },
    // Same split as the global leaderboard (see leaderboard.service.ts):
    // bestScore can include partial credit, so "solved" is tracked
    // separately off an actual ACCEPTED verdict rather than off score>0.
    {
      $group: {
        _id: { userId: "$userId", problemId: "$problemId" },
        bestScore: { $max: "$score" },
        solved: { $max: { $cond: [{ $eq: ["$verdict", "ACCEPTED"] }, 1, 0] } },
      },
    },
  ])) as { _id: { userId: Types.ObjectId; problemId: Types.ObjectId }; bestScore: number; solved: number }[];

  // A submission's score is out of the problem's basePoints, but the contest
  // advertises (and admins set) its own points per problem — rescale each
  // best score to those points instead of silently summing basePoints.
  const totals = new Map<string, { totalScore: number; problemsSolved: number }>();
  for (const row of rows) {
    const problemKey = String(row._id.problemId);
    const points = pointsByProblem.get(problemKey) ?? 0;
    const basePoints = basePointsByProblem.get(problemKey) ?? 100;
    const userKey = String(row._id.userId);
    const current = totals.get(userKey) ?? { totalScore: 0, problemsSolved: 0 };
    current.totalScore += Math.round(((row.bestScore ?? 0) / basePoints) * points);
    current.problemsSolved += row.solved;
    totals.set(userKey, current);
  }

  const scoredUserIds = [...totals.entries()].filter(([, total]) => total.totalScore > 0).map(([userId]) => userId);
  const users = (await UserModel.find({ _id: { $in: scoredUserIds } })
    .select("name")
    .lean()) as unknown as { _id: Types.ObjectId; name: string }[];
  const nameById = new Map(users.map((user) => [String(user._id), user.name]));

  const ranked = scoredUserIds
    .filter((userId) => nameById.has(userId))
    .map((userId) => ({ userId, name: nameById.get(userId) as string, ...(totals.get(userId) as { totalScore: number; problemsSolved: number }) }))
    // userId as the final tiebreaker keeps tied ranks stable between loads.
    .sort((a, b) => b.totalScore - a.totalScore || b.problemsSolved - a.problemsSolved || a.userId.localeCompare(b.userId));

  return {
    contestId: String(contest._id),
    entries: ranked.map((entry, index) => ({ rank: index + 1, ...entry })),
  };
};

type ContestCreator = { id: string; name: string; role: IUser["role"] };

// Invalid id, missing contest, and another host's contest all read the same.
const findManagedContest = async (id: string, manager: ContestManager) => {
  if (!Types.ObjectId.isValid(id)) throw new AppError("Contest not found.", 404);
  const contest = (await ContestModel.findOne({ _id: id, ...manageScope(manager) }).lean()) as unknown as LeanContest | null;
  if (!contest) throw new AppError("Contest not found.", 404);
  return contest;
};

const loadCreators = async (userIds: string[]) => {
  const creators = new Map<string, ContestCreator>();
  if (userIds.length === 0) return creators;
  const users = (await UserModel.find({ _id: { $in: userIds } })
    .select("name role")
    .lean()) as unknown as { _id: Types.ObjectId; name: string; role: IUser["role"] }[];
  for (const user of users) creators.set(String(user._id), { id: String(user._id), name: user.name, role: user.role });
  return creators;
};

// One grouped count for a whole page of contests instead of a query per row.
const countParticipantsByContest = async (contestIds: Types.ObjectId[]) => {
  if (contestIds.length === 0) return new Map<string, number>();
  const rows = (await ContestParticipantModel.aggregate([
    { $match: { contestId: { $in: contestIds } } },
    { $group: { _id: "$contestId", count: { $sum: 1 } } },
  ])) as { _id: Types.ObjectId; count: number }[];
  return new Map(rows.map((row) => [String(row._id), row.count]));
};

const toCreatorSummary = (contest: LeanContest, creators: Map<string, ContestCreator>) =>
  contest.createdBy ? (creators.get(String(contest.createdBy)) ?? null) : null;

const buildManagedContestDetail = async (contest: LeanContest) => {
  const [problems, participantCount, creators] = (await Promise.all([
    ProblemModel.find({ _id: { $in: contest.problems.map((entry) => entry.problemId) } })
      .select("slug title difficulty")
      .lean(),
    ContestParticipantModel.countDocuments({ contestId: contest._id }),
    loadCreators(contest.createdBy ? [String(contest.createdBy)] : []),
  ])) as unknown as [{ _id: Types.ObjectId; slug: string; title: string; difficulty: Difficulty }[], number, Map<string, ContestCreator>];
  const problemById = new Map(problems.map((problem) => [String(problem._id), problem]));

  return {
    id: String(contest._id),
    slug: contest.slug,
    title: contest.title,
    description: contest.description,
    startTime: contest.startTime,
    endTime: contest.endTime,
    isPublished: Boolean(contest.isPublished),
    status: getContestStatus(contest),
    createdBy: toCreatorSummary(contest, creators),
    participantCount,
    // Unlike the public contest page, unpublished problems keep their real
    // title here — this view is only for the people managing the contest.
    problems: [...contest.problems]
      .sort((a, b) => a.order - b.order)
      .map((entry) => {
        const problem = problemById.get(String(entry.problemId));
        return {
          problemId: String(entry.problemId),
          title: problem?.title ?? null,
          slug: problem?.slug ?? null,
          difficulty: problem?.difficulty ?? null,
          points: entry.points,
        };
      }),
  };
};

interface IListManagedContestsQuery {
  page?: unknown;
  limit?: unknown;
  search?: unknown;
}

// Admins see every contest, drafts included; guests only their own.
const listManagedContests = async (manager: ContestManager, { page, limit, search }: IListManagedContestsQuery) => {
  const safeLimit = Math.min(toPositiveInt(limit, 20), 100);
  const safePage = toPositiveInt(page, 1);

  const filter: FilterQuery<IContest> = { ...manageScope(manager) };
  if (typeof search === "string" && search.trim()) {
    filter.title = { $regex: toSearchRegex(search), $options: "i" };
  }

  const [contests, total] = (await Promise.all([
    ContestModel.find(filter)
      .select("slug title startTime endTime isPublished problems createdBy")
      .sort({ startTime: -1, _id: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),
    ContestModel.countDocuments(filter),
  ])) as unknown as [LeanContest[], number];

  const creatorIds = [...new Set(contests.flatMap((contest) => (contest.createdBy ? [String(contest.createdBy)] : [])))];
  const [participantCounts, creators] = await Promise.all([
    countParticipantsByContest(contests.map((contest) => contest._id)),
    loadCreators(creatorIds),
  ]);

  const now = new Date();
  return {
    items: contests.map((contest) => ({
      id: String(contest._id),
      slug: contest.slug,
      title: contest.title,
      status: getContestStatus(contest, now),
      startTime: contest.startTime,
      endTime: contest.endTime,
      isPublished: Boolean(contest.isPublished),
      problemCount: contest.problems.length,
      participantCount: participantCounts.get(String(contest._id)) ?? 0,
      createdBy: toCreatorSummary(contest, creators),
      // Always true today (a guest's list only holds their own contests), but
      // spares the client from re-deriving the permission rule per row.
      canEdit: isAdmin(manager) || String(contest.createdBy) === manager.userId,
    })),
    total,
    page: safePage,
    limit: safeLimit,
  };
};

const getManagedContest = async (id: string, manager: ContestManager) => buildManagedContestDetail(await findManagedContest(id, manager));

// Partial update: only the fields present in the body change.
const updateManagedContest = async (id: string, manager: ContestManager, payload: unknown) => {
  // Ownership is checked before the body is looked at, so a guest can't use
  // "400 invalid body" vs "404 not found" to probe other hosts' contest ids.
  const contest = await findManagedContest(id, manager);
  const body = toBodyObject(payload);

  const update: Partial<Pick<IContest, "title" | "slug" | "description" | "startTime" | "endTime" | "problems" | "isPublished">> = {};
  if (body.title !== undefined) update.title = parseTitle(body.title);
  if (body.slug !== undefined) update.slug = parseSlug(body.slug);
  if (body.description !== undefined) update.description = parseDescription(body.description);
  if (body.startTime !== undefined) update.startTime = parseDate(body.startTime, "startTime");
  if (body.endTime !== undefined) update.endTime = parseDate(body.endTime, "endTime");
  if (body.isPublished !== undefined) update.isPublished = parseIsPublished(body.isPublished);

  // Checked against the merged window, so moving only one end can't put the
  // end before the start.
  if (update.startTime || update.endTime) {
    const startTime = update.startTime ?? contest.startTime;
    const endTime = update.endTime ?? contest.endTime;
    if (new Date(endTime).getTime() <= new Date(startTime).getTime()) throw new AppError("endTime must be after startTime.", 400);
  }

  if (body.problems !== undefined) {
    update.problems = await parseProblems(body.problems, manager, new Set(contest.problems.map((entry) => String(entry.problemId))));
  }
  if (update.slug !== undefined && update.slug !== contest.slug) await assertSlugAvailable(update.slug, contest._id);

  if (Object.keys(update).length === 0) return buildManagedContestDetail(contest);

  let updated: LeanContest | null;
  try {
    updated = (await ContestModel.findOneAndUpdate(
      { _id: contest._id, ...manageScope(manager) },
      { $set: update },
      { new: true, runValidators: true },
    ).lean()) as unknown as LeanContest | null;
  } catch (error) {
    return rethrowSlugConflict(error);
  }
  // Deleted by someone else between the lookup and the update.
  if (!updated) throw new AppError("Contest not found.", 404);
  return buildManagedContestDetail(updated);
};

const deleteManagedContest = async (id: string, manager: ContestManager) => {
  const contest = await findManagedContest(id, manager);
  await ContestModel.deleteOne({ _id: contest._id, ...manageScope(manager) });
  // Registrations mean nothing without the contest. Submissions tagged with
  // it are deliberately kept — they're the users' submission history.
  await ContestParticipantModel.deleteMany({ contestId: contest._id });
  return { deleted: true };
};

export const contestService = {
  listContests,
  getContestByIdentifier,
  createContest,
  registerForContest,
  getSubmissionContext,
  getScoreboard,
  listManagedContests,
  getManagedContest,
  updateManagedContest,
  deleteManagedContest,
};
