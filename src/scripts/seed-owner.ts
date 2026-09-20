/**
 * Gives the two owner accounts a solve history, with one clearly on top.
 *
 * Separate from seed-demo.ts on purpose: that script invents learners, this
 * one writes against real accounts, and the two should not be entangled.
 * Both are idempotent — each account's submissions are cleared before being
 * rewritten, so scores never accumulate across runs.
 *
 *   npx tsx src/scripts/seed-owner.ts
 */

import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";
import { ProblemModel } from "../models/Problem.model.js";
import { UserModel } from "../models/User.model.js";
import { SubmissionModel } from "../models/Submission.model.js";

const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const rand = rng(77001);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const LANGS = ["python", "cpp", "javascript", "typescript"] as const;
const FAILS = ["WRONG_ANSWER", "TIME_LIMIT_EXCEEDED", "RUNTIME_ERROR"] as const;

const CODE: Record<string, string> = {
  python: "import sys\n\ndef solve(data: str) -> str:\n    return data\n\nif __name__ == \"__main__\":\n    print(solve(sys.stdin.read().strip()))\n",
  cpp: "#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n    return 0;\n}\n",
  javascript: "const data = require(\"fs\").readFileSync(0, \"utf8\").trim();\nconsole.log(data);\n",
  typescript: "const data: string = require(\"fs\").readFileSync(0, \"utf8\").trim();\nconsole.log(data);\n",
};

/** first entry ends up rank 1 — it takes every problem. */
const OWNERS = [
  { email: "tumit.exprovia@gmail.com", solveAll: true },
  { email: "tumithr@gmail.com", solveAll: false },
];

const daysAgo = (d: number, h = 0) => new Date(Date.now() - d * 864e5 - h * 36e5);

async function main() {
  await connectDatabase();
  console.log("Connected.\n");

  const problems = await ProblemModel.find({ isPublished: true })
    .select("_id title basePoints difficulty").lean();
  const maxScore = problems.reduce((s, p) => s + (p.basePoints ?? 100), 0);
  console.log(`${problems.length} published problems, ${maxScore} points available in total\n`);

  for (const { email, solveAll } of OWNERS) {
    const user = await UserModel.findOne({ email });
    if (!user) { console.log(`  ! no account for ${email} — skipped`); continue; }

    // The second account takes a subset, so the two do not tie. A tie would
    // be broken by solve count and then submit time, which reads as
    // arbitrary on a leaderboard people are meant to trust.
    const solved = solveAll
      ? problems
      : [...problems].sort(() => rand() - 0.5).slice(0, Math.floor(problems.length * 0.72));

    const rows = [];
    for (const [i, problem] of solved.entries()) {
      const language = pick(LANGS);
      const day = Math.max(0, 74 - Math.floor((i / solved.length) * 74));
      const points = problem.basePoints ?? 100;

      // A couple of near-misses on the harder ones, so the history reads as
      // someone working rather than someone inserted.
      if (problem.difficulty !== "EASY" && rand() < 0.45) {
        for (let a = 0; a < between(1, 2); a++) {
          rows.push({
            userId: user._id, problemId: problem._id, language, code: CODE[language],
            verdict: pick(FAILS), passedTests: between(1, 2), totalTests: 3,
            runtimeMs: between(60, 780), memoryKb: between(9000, 40000),
            score: 0, submittedAt: daysAgo(day, between(2, 18)),
          });
        }
      }
      rows.push({
        userId: user._id, problemId: problem._id, language, code: CODE[language],
        verdict: "ACCEPTED", passedTests: 3, totalTests: 3,
        runtimeMs: between(18, 260), memoryKb: between(8500, 26000),
        score: points, submittedAt: daysAgo(day),
      });
    }

    const removed = await SubmissionModel.deleteMany({ userId: user._id });
    await SubmissionModel.insertMany(rows);
    const total = solved.reduce((s, p) => s + (p.basePoints ?? 100), 0);

    await UserModel.updateOne({ _id: user._id }, { $set: { gems: Math.round(total / 10) } });

    console.log(`  ${user.name} <${email}>`);
    console.log(`    -${removed.deletedCount} old, +${rows.length} submissions ` +
      `(${solved.length} solved, ${rows.length - solved.length} failed attempts)`);
    console.log(`    score ${total}  ·  gems ${Math.round(total / 10)}\n`);
  }

  console.log("Done.");
  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (error) => {
  console.error("seed-owner failed:", error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
