/**
 * Runs every reference solution against that problem's real test cases.
 *
 * A reference solution is shown to a learner as the correct way to do it,
 * so a wrong one is worse than having none — it is wrong with authority,
 * and the learner has no reason to doubt it. Nothing in seed-solutions.ts
 * should reach the database until this passes.
 *
 * Uses a local Python rather than Judge0: this is a correctness check on
 * code we wrote, not a sandboxing problem, and the shared public judge
 * should not be asked to run a hundred submissions for it.
 *
 *   npx tsx src/scripts/verify-solutions.ts
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";
import { ProblemModel } from "../models/Problem.model.js";
import { TestCaseModel } from "../models/TestCase.model.js";
import { SOLUTIONS } from "./seed-solutions.js";

const PYTHON = process.env.PYTHON_BIN ?? "python";

/** Trailing whitespace differs harmlessly between a print and a fixture. */
const norm = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();

async function main() {
  await connectDatabase();
  const dir = mkdtempSync(join(tmpdir(), "kaimana-verify-"));
  let ok = 0;
  const failures: string[] = [];

  for (const [slug, code] of Object.entries(SOLUTIONS)) {
    const problem = (await ProblemModel.findOne({ slug }).select("_id title").lean()) as
      | { _id: unknown; title: string }
      | null;
    if (!problem) { failures.push(`${slug}: no such problem`); continue; }

    const cases = (await TestCaseModel.find({ problemId: problem._id })
      .sort({ order: 1 }).select("input expectedOutput").lean()) as unknown as
      { input: string; expectedOutput: string }[];
    if (!cases.length) { failures.push(`${slug}: no test cases`); continue; }

    const file = join(dir, `${slug}.py`);
    writeFileSync(file, code);

    let passed = 0;
    for (const [i, tc] of cases.entries()) {
      let actual: string;
      try {
        actual = execFileSync(PYTHON, [file], {
          input: tc.input, encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024,
        });
      } catch (e: unknown) {
        const err = e as { stderr?: string; message?: string };
        failures.push(`${slug} case ${i}: crashed — ${String(err.stderr ?? err.message).trim().split("\n").pop()}`);
        break;
      }
      if (norm(actual) === norm(tc.expectedOutput)) { passed++; continue; }
      failures.push(
        `${slug} case ${i}: expected ${JSON.stringify(norm(tc.expectedOutput))}, ` +
        `got ${JSON.stringify(norm(actual))}  (input ${JSON.stringify(tc.input)})`,
      );
      break;
    }
    if (passed === cases.length) { ok++; console.log(`  ok    ${slug} (${passed}/${cases.length})`); }
    else console.log(`  FAIL  ${slug}`);
  }

  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${ok}/${Object.keys(SOLUTIONS).length} solutions pass every test case`);
  if (failures.length) {
    console.log(`\n${failures.length} failure(s):`);
    failures.forEach((f) => console.log("  - " + f));
  }
  await mongoose.disconnect();
  process.exit(failures.length ? 1 : 0);
}

main().catch(async (error) => {
  console.error("verify-solutions failed:", error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
