// One query, every kind of thing on the site.
//
// The page-by-page filters stay where they are; this is for the person who
// knows a name and wants to get there — a problem title, a contest, a tag,
// somebody's handle. Each group is capped small on purpose: this feeds a
// palette that has to stay readable, not a results page.

import { ProblemModel } from "../../models/Problem.model.js";
import { ContestModel } from "../../models/Contest.model.js";
import { UserModel } from "../../models/User.model.js";
import { toSearchRegex } from "../../utils/search.js";

const PER_GROUP = 5;

export interface SearchResults {
  problems: { id: string; title: string; slug: string; difficulty: string; tags: string[] }[];
  contests: { id: string; title: string; slug: string; startTime: string; endTime: string }[];
  users: { id: string; name: string; profilePicUrl?: string }[];
  tags: string[];
}

export const searchEverything = async (rawQuery: unknown): Promise<SearchResults> => {
  const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
  if (query.length < 2) return { problems: [], contests: [], users: [], tags: [] };

  const pattern = { $regex: toSearchRegex(query), $options: "i" };

  // Four small queries in parallel: the palette shows whichever groups have
  // something, so one empty collection never holds up the rest.
  const [problems, contests, users, tags] = await Promise.all([
    ProblemModel.find({ isPublished: true, $or: [{ title: pattern }, { tags: pattern }] })
      .select("title slug difficulty tags")
      .sort({ title: 1 })
      .limit(PER_GROUP)
      .lean(),
    // Unpublished contests are drafts; a search must not leak them.
    ContestModel.find({ isPublished: true, title: pattern })
      .select("title slug startTime endTime")
      .sort({ startTime: -1 })
      .limit(PER_GROUP)
      .lean(),
    // Blocked accounts stay out of results.
    UserModel.find({ name: pattern, status: { $ne: "blocked" } })
      .select("name profilePicUrl")
      .sort({ gems: -1 })
      .limit(PER_GROUP)
      .lean(),
    ProblemModel.distinct("tags", { isPublished: true, tags: pattern }),
  ]);

  return {
    problems: problems.map((problem) => ({
      id: String(problem._id),
      title: problem.title,
      slug: problem.slug,
      difficulty: problem.difficulty,
      tags: (problem.tags ?? []).slice(0, 3),
    })),
    contests: contests.map((contest) => ({
      id: String(contest._id),
      title: contest.title,
      slug: contest.slug,
      startTime: new Date(contest.startTime).toISOString(),
      endTime: new Date(contest.endTime).toISOString(),
    })),
    users: users.map((user) => ({ id: String(user._id), name: user.name, profilePicUrl: user.profilePicUrl })),
    tags: tags.slice(0, PER_GROUP),
  };
};

export const searchService = { searchEverything };
