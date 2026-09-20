/**
 * Demo dataset.
 *
 * seed.ts gives the library ten problems and nothing else, which leaves the
 * leaderboard, the analytics page and the contest list empty — the site
 * renders correctly and still looks broken. This fills in the parts that
 * only exist once people have used the product: learners, a history of
 * submissions behind them, and contests in all three states.
 *
 * Idempotent. Problems, users and contests upsert on their natural keys, and
 * the generated submissions are cleared per demo user before being rewritten,
 * so running it twice does not double anyone's score. Randomness is seeded,
 * so the same run produces the same leaderboard every time.
 *
 *   npx tsx src/scripts/seed-demo.ts
 */

import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";
import { ProblemModel } from "../models/Problem.model.js";
import { TestCaseModel } from "../models/TestCase.model.js";
import { UserModel } from "../models/User.model.js";
import { SubmissionModel } from "../models/Submission.model.js";
import { ContestModel } from "../models/Contest.model.js";
import { ContestParticipantModel } from "../models/ContestParticipant.model.js";

/** Deterministic PRNG — the demo leaderboard should not reshuffle per run. */
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const rand = rng(20260920);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

type Diff = "EASY" | "MEDIUM" | "HARD";
interface P {
  slug: string; title: string; difficulty: Diff; tags: string[];
  statement: string; io: [string, string][];
}

const P = (slug: string, title: string, difficulty: Diff, tags: string[], statement: string, io: [string, string][]): P =>
  ({ slug, title, difficulty, tags, statement, io });

// Problems beyond the ten in seed.ts. Statements are deliberately short —
// enough that a problem page reads as real, not enough to pretend this is
// a curated library.
const PROBLEMS: P[] = [
  P("contains-duplicate", "Contains Duplicate", "EASY", ["array", "hashset"],
    "Given an integer array, return true if any value appears at least twice, and false if every element is distinct.",
    [["4\n1 2 3 1", "true"], ["4\n1 2 3 4", "false"], ["1\n7", "false"]]),
  P("single-number", "Single Number", "EASY", ["bit-manipulation", "array"],
    "Every element appears twice except for one. Find that single one, using constant extra space.",
    [["5\n4 1 2 1 2", "4"], ["3\n2 2 1", "1"], ["1\n9", "9"]]),
  P("move-zeroes", "Move Zeroes", "EASY", ["array", "two-pointers"],
    "Move all zeroes to the end of the array while keeping the relative order of the non-zero elements. Do it in place.",
    [["5\n0 1 0 3 12", "1 3 12 0 0"], ["2\n0 0", "0 0"], ["3\n1 2 3", "1 2 3"]]),
  P("majority-element", "Majority Element", "EASY", ["array", "hashmap"],
    "Return the element that appears more than n/2 times. You may assume it always exists.",
    [["3\n3 2 3", "3"], ["7\n2 2 1 1 1 2 2", "2"], ["1\n5", "5"]]),
  P("best-time-to-buy-and-sell", "Best Time to Buy and Sell Stock", "EASY", ["array", "dp"],
    "Given prices on consecutive days, return the maximum profit from a single buy followed by a later sell. Return 0 if no profit is possible.",
    [["6\n7 1 5 3 6 4", "5"], ["5\n7 6 4 3 1", "0"], ["2\n1 2", "1"]]),
  P("valid-anagram", "Valid Anagram", "EASY", ["string", "hashmap"],
    "Given two strings, return true if the second is an anagram of the first.",
    [["anagram\nnagaram", "true"], ["rat\ncar", "false"], ["a\na", "true"]]),
  P("intersection-of-arrays", "Intersection of Two Arrays", "EASY", ["array", "hashset"],
    "Return the unique values present in both arrays, in ascending order.",
    [["4\n1 2 2 1\n2\n2 2", "2"], ["4\n4 9 5 4\n4\n9 4 9 8", "4 9"], ["1\n1\n1\n2", ""]]),
  P("plus-one", "Plus One", "EASY", ["array", "math"],
    "The digits of a non-negative integer are given most significant first. Add one and return the resulting digits.",
    [["3\n1 2 3", "1 2 4"], ["3\n9 9 9", "1 0 0 0"], ["1\n0", "1"]]),

  P("group-anagrams", "Group Anagrams", "MEDIUM", ["string", "hashmap"],
    "Group the strings that are anagrams of one another. Print each group sorted, one group per line, groups ordered by their first word.",
    [["6\neat tea tan ate nat bat", "ate eat tea\nbat\nnat tan"], ["1\na", "a"], ["2\nab ba", "ab ba"]]),
  P("product-except-self", "Product of Array Except Self", "MEDIUM", ["array", "prefix-sum"],
    "Return an array where each position holds the product of every other element. Solve it without division.",
    [["4\n1 2 3 4", "24 12 8 6"], ["5\n-1 1 0 -3 3", "0 0 9 0 0"], ["2\n3 7", "7 3"]]),
  P("longest-substring-no-repeat", "Longest Substring Without Repeating Characters", "MEDIUM", ["string", "sliding-window"],
    "Return the length of the longest substring containing no repeated character.",
    [["abcabcbb", "3"], ["bbbbb", "1"], ["pwwkew", "3"]]),
  P("three-sum", "3Sum", "MEDIUM", ["array", "two-pointers"],
    "Return the number of unique triplets that sum to zero.",
    [["6\n-1 0 1 2 -1 -4", "2"], ["3\n0 1 1", "0"], ["3\n0 0 0", "1"]]),
  P("container-with-most-water", "Container With Most Water", "MEDIUM", ["array", "two-pointers"],
    "Each value is the height of a vertical line. Return the largest area of water two lines can hold.",
    [["9\n1 8 6 2 5 4 8 3 7", "49"], ["2\n1 1", "1"], ["3\n4 3 2", "4"]]),
  P("coin-change", "Coin Change", "MEDIUM", ["dp"],
    "Return the fewest coins needed to make the amount, or -1 if it cannot be made.",
    [["3\n1 2 5\n11", "3"], ["1\n2\n3", "-1"], ["1\n1\n0", "0"]]),
  P("number-of-islands", "Number of Islands", "MEDIUM", ["graph", "dfs"],
    "The grid holds '1' for land and '0' for water. Return the number of islands, where land connects horizontally and vertically.",
    [["3 3\n110\n110\n001", "2"], ["1 1\n0", "0"], ["2 2\n11\n11", "1"]]),
  P("course-schedule", "Course Schedule", "MEDIUM", ["graph", "topological-sort"],
    "Given prerequisite pairs, return true if every course can be finished.",
    [["2 1\n1 0", "true"], ["2 2\n1 0\n0 1", "false"], ["1 0", "true"]]),
  P("rotate-image", "Rotate Image", "MEDIUM", ["matrix"],
    "Rotate the n x n matrix 90 degrees clockwise, in place.",
    [["3\n1 2 3\n4 5 6\n7 8 9", "7 4 1\n8 5 2\n9 6 3"], ["1\n5", "5"], ["2\n1 2\n3 4", "3 1\n4 2"]]),
  P("top-k-frequent", "Top K Frequent Elements", "MEDIUM", ["heap", "hashmap"],
    "Return the k most frequent values, most frequent first. Break ties by the smaller value.",
    [["6\n1 1 1 2 2 3\n2", "1 2"], ["1\n1\n1", "1"], ["4\n4 4 5 5\n2", "4 5"]]),
  P("search-rotated-array", "Search in Rotated Sorted Array", "MEDIUM", ["binary-search"],
    "A sorted array was rotated at an unknown pivot. Return the index of the target, or -1.",
    [["7\n4 5 6 7 0 1 2\n0", "4"], ["7\n4 5 6 7 0 1 2\n3", "-1"], ["1\n1\n1", "0"]]),
  P("subsets", "Subsets", "MEDIUM", ["backtracking"],
    "Return the number of distinct subsets of the given array.",
    [["3\n1 2 3", "8"], ["1\n0", "2"], ["2\n1 1", "3"]]),
  P("word-break", "Word Break", "MEDIUM", ["dp", "string"],
    "Return true if the string can be segmented into a sequence of dictionary words.",
    [["leetcode\n2\nleet code", "true"], ["applepenapple\n2\napple pen", "true"], ["catsandog\n3\ncats dog sand", "false"]]),

  P("median-two-sorted", "Median of Two Sorted Arrays", "HARD", ["binary-search", "array"],
    "Return the median of the two sorted arrays combined. Print it with one decimal place.",
    [["2\n1 3\n1\n2", "2.0"], ["2\n1 2\n2\n3 4", "2.5"], ["1\n0\n1\n0", "0.0"]]),
  P("trapping-rain-water", "Trapping Rain Water", "HARD", ["array", "two-pointers"],
    "Given an elevation map, return how much rain water it traps.",
    [["12\n0 1 0 2 1 0 1 3 2 1 2 1", "6"], ["6\n4 2 0 3 2 5", "9"], ["3\n1 2 3", "0"]]),
  P("edit-distance", "Edit Distance", "HARD", ["dp", "string"],
    "Return the minimum number of insertions, deletions or substitutions that turn the first word into the second.",
    [["horse\nros", "3"], ["intention\nexecution", "5"], ["a\na", "0"]]),
  P("word-ladder", "Word Ladder", "HARD", ["graph", "bfs"],
    "Return the length of the shortest transformation sequence from the start word to the end word, changing one letter at a time. Return 0 if none exists.",
    [["hit\ncog\n6\nhot dot dog lot log cog", "5"], ["hit\ncog\n5\nhot dot dog lot log", "0"], ["a\nc\n2\nb c", "2"]]),
  P("largest-rectangle-histogram", "Largest Rectangle in Histogram", "HARD", ["stack"],
    "Return the area of the largest rectangle that fits inside the histogram.",
    [["6\n2 1 5 6 2 3", "10"], ["2\n2 4", "4"], ["1\n1", "1"]]),
];

const POINTS: Record<Diff, number> = { EASY: 100, MEDIUM: 200, HARD: 350 };

const LEARNERS = [
  "Arif Hossain", "Nusrat Jahan", "Rakib Islam", "Tanvir Ahmed", "Sadia Rahman",
  "Mehedi Hasan", "Farhana Akter", "Shakil Mahmud", "Ishrat Binte", "Nayeem Chowdhury",
  "Priya Das", "Zahid Kabir", "Lamia Sultana", "Rifat Karim",
] as const;

const LANGS = ["python", "cpp", "javascript", "typescript"] as const;
const FAILS = ["WRONG_ANSWER", "TIME_LIMIT_EXCEEDED", "RUNTIME_ERROR"] as const;

const SOLUTION: Record<string, string> = {
  python: "import sys\n\ndef solve(data):\n    # worked through on Kaimana\n    return data\n\nif __name__ == \"__main__\":\n    print(solve(sys.stdin.read().strip()))\n",
  cpp: "#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    ios::sync_with_stdio(false);\n    // worked through on Kaimana\n    return 0;\n}\n",
  javascript: "const data = require(\"fs\").readFileSync(0, \"utf8\").trim();\n// worked through on Kaimana\nconsole.log(data);\n",
  typescript: "const data: string = require(\"fs\").readFileSync(0, \"utf8\").trim();\n// worked through on Kaimana\nconsole.log(data);\n",
};

const daysAgo = (d: number, jitterHours = 0) =>
  new Date(Date.now() - d * 864e5 - jitterHours * 36e5);

async function main() {
  await connectDatabase();
  console.log("Connected.\n");

  // ---------------------------------------------------------------- problems
  let added = 0;
  for (const p of PROBLEMS) {
    const doc = await ProblemModel.findOneAndUpdate(
      { slug: p.slug },
      {
        slug: p.slug,
        title: p.title,
        statement: p.statement,
        difficulty: p.difficulty,
        tags: p.tags,
        basePoints: POINTS[p.difficulty],
        inputFormat: "Read from standard input as described above.",
        outputFormat: "Print the answer on a single line.",
        constraints: "1 <= n <= 10^5",
        sampleTests: p.io.slice(0, 2).map(([input, expectedOutput]) => ({ input, expectedOutput })),
        isPublished: true,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    await TestCaseModel.deleteMany({ problemId: doc._id });
    await TestCaseModel.insertMany(
      p.io.map(([input, expectedOutput], order) => ({
        problemId: doc._id, input, expectedOutput, isSample: order < 2, order,
      })),
    );
    added++;
  }
  console.log(`problems  : +${added} upserted (${PROBLEMS.length} in this set)`);

  const allProblems = await ProblemModel.find({ isPublished: true })
    .select("_id difficulty basePoints").lean();
  console.log(`            ${allProblems.length} published in total`);

  // ------------------------------------------------------------------- users
  const users = [];
  for (const name of LEARNERS) {
    const email = `${name.toLowerCase().split(" ")[0]}.${name.toLowerCase().split(" ")[1]}@kaimana.dev`;
    users.push(await UserModel.findOneAndUpdate(
      { email },
      { name, email, role: "user", status: "active", gems: between(20, 320) },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ));
  }
  console.log(`users     : ${users.length} demo learners upserted`);

  // ------------------------------------------------------------- submissions
  // Rewritten per demo user so scores never double up on a second run.
  const ids = users.map((u) => u._id);
  const removed = await SubmissionModel.deleteMany({ userId: { $in: ids } });

  const rows = [];
  for (const user of users) {
    // A spread of engagement: a few heavy users, a long tail of light ones.
    const solves = between(4, Math.min(24, allProblems.length));
    const shuffled = [...allProblems].sort(() => rand() - 0.5).slice(0, solves);

    for (const problem of shuffled) {
      const language = pick(LANGS);
      const day = between(0, 58);

      // Most solves take a wrong turn or two first — a history of nothing but
      // green is the tell that a leaderboard was fabricated.
      const attempts = rand() < 0.55 ? between(1, 3) : 0;
      for (let a = 0; a < attempts; a++) {
        rows.push({
          userId: user._id, problemId: problem._id, language,
          code: SOLUTION[language], verdict: pick(FAILS),
          passedTests: between(0, 2), totalTests: 3,
          runtimeMs: between(40, 900), memoryKb: between(9000, 48000),
          score: 0, submittedAt: daysAgo(day, between(1, 20)),
        });
      }
      rows.push({
        userId: user._id, problemId: problem._id, language,
        code: SOLUTION[language], verdict: "ACCEPTED",
        passedTests: 3, totalTests: 3,
        runtimeMs: between(25, 420), memoryKb: between(9000, 32000),
        score: problem.basePoints, submittedAt: daysAgo(day),
      });
    }
  }
  await SubmissionModel.insertMany(rows);
  console.log(`submissions: -${removed.deletedCount} old, +${rows.length} new`);
  console.log(`            ${rows.filter((r) => r.verdict === "ACCEPTED").length} accepted, spread over 58 days`);

  // ---------------------------------------------------------------- contests
  const contestProblems = (n: number, from: number) =>
    allProblems.slice(from, from + n).map((p, order) => ({
      problemId: p._id, points: p.basePoints, order,
    }));

  const CONTESTS = [
    { slug: "kaimana-warmup-1", title: "Kaimana Warm-up #1",
      description: "Six approachable problems to get the judge under your fingers.",
      startTime: daysAgo(12), endTime: daysAgo(12, -3), problems: contestProblems(6, 0) },
    { slug: "weekly-sprint-live", title: "Weekly Sprint — Live Now",
      description: "Two hours, five problems, scoreboard updating as you submit.",
      startTime: daysAgo(0, 1), endTime: daysAgo(-1, 0), problems: contestProblems(5, 6) },
    { slug: "kaimana-open-round-2", title: "Kaimana Open — Round 2",
      description: "A longer round with a hard closer. Registration is open.",
      startTime: daysAgo(-6), endTime: daysAgo(-6, -4), problems: contestProblems(7, 11) },
  ];

  for (const c of CONTESTS) {
    const doc = await ContestModel.findOneAndUpdate(
      { slug: c.slug }, { ...c, isPublished: true },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    await ContestParticipantModel.deleteMany({ contestId: doc._id });
    await ContestParticipantModel.insertMany(
      users.slice(0, between(6, users.length)).map((u) => ({ contestId: doc._id, userId: u._id })),
    );
  }
  console.log(`contests  : ${CONTESTS.length} (one finished, one live, one upcoming) with participants`);

  console.log("\nDone.");
  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (error) => {
  console.error("seed-demo failed:", error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
