import assert from "node:assert/strict";
import { test } from "node:test";
import { ReadCache, catalogueCache, problemTopicsCache } from "../dist/utils/readCache.js";
import { problemService } from "../dist/modules/problem/problem.service.js";
import { ProblemModel } from "../dist/models/Problem.model.js";
import { SubmissionModel } from "../dist/models/Submission.model.js";
import { Types } from "mongoose";

test("public read cache coalesces work, expires, bounds memory and retries failures", async () => {
  let now = 0;
  let loads = 0;
  const cache = new ReadCache(2, () => now);
  const load = async () => ++loads;
  assert.deepEqual(await Promise.all([cache.read("page-1", 10, load), cache.read("page-1", 10, load)]), [1, 1]);
  now = 11;
  assert.equal(await cache.read("page-1", 10, load), 2);
  await cache.read("page-2", 10, load);
  await cache.read("page-3", 10, load);
  assert.equal(await cache.read("page-1", 10, load), 5);
  await assert.rejects(cache.read("failed", 10, async () => { throw new Error("Temporary outage"); }));
  assert.equal(await cache.read("failed", 10, async () => "recovered"), "recovered");
});

test("invalidation prevents an older pending query from repopulating the cache", async () => {
  const cache = new ReadCache();
  let resolve;
  const pending = cache.read("list", 60_000, () => new Promise((done) => { resolve = done; }));
  await Promise.resolve();
  cache.clear();
  resolve("before update");
  await pending;
  assert.equal(await cache.read("list", 60_000, async () => "after update"), "after update");
});

test("catalogue pages share public queries while keeping solved state private", async () => {
  catalogueCache.clear();
  problemTopicsCache.clear();
  const id = new Types.ObjectId();
  const document = { _id: id, slug: "two-sum", title: "Two Sum", difficulty: "EASY", tags: ["arrays"], basePoints: 100, statement: "Find two numbers." };
  const originals = { find: ProblemModel.find, count: ProblemModel.countDocuments, aggregate: SubmissionModel.aggregate, submissions: SubmissionModel.find, findById: ProblemModel.findById, update: ProblemModel.findByIdAndUpdate };
  let publicReads = 0;
  let tallies = 0;
  const offsets = [];
  const limits = [];
  const chain = (value) => ({ select() { return this; }, sort() { return this; }, skip(value) { offsets.push(value); return this; }, limit(value) { limits.push(value); return this; }, distinct() { return this; }, lean: async () => value });
  ProblemModel.find = () => { publicReads++; return chain([document]); };
  ProblemModel.countDocuments = async () => 60;
  SubmissionModel.aggregate = async () => { tallies++; return [{ _id: id, submissions: 5, accepted: 2 }]; };
  SubmissionModel.find = (filter) => chain(filter.userId === "learner-a" ? [id] : []);
  try {
    const [a, b] = await Promise.all([
      problemService.listProblems({ page: 1, limit: 20, userId: "learner-a" }),
      problemService.listProblems({ page: 1, limit: 20, userId: "learner-b" }),
    ]);
    assert.equal(a.items[0].solvedByMe, true);
    assert.equal(b.items[0].solvedByMe, false);
    assert.equal(a.items[0].acceptanceRate, 40);
    assert.equal(publicReads, 1);
    assert.equal(tallies, 1);
    await problemService.listProblems({ page: 2, limit: 20 });
    assert.equal(publicReads, 2);
    assert.deepEqual(offsets, [0, 20]);
    assert.deepEqual(limits, [20, 20]);
    await problemService.listProblems({ page: Number.NaN, limit: 2.5 });
    assert.equal(publicReads, 2); // Invalid pagination normalizes to the cached first page.
    assert.equal(a.items[0].statement, undefined);
    assert.equal(a.items[0].referenceSolution, undefined);
    ProblemModel.findById = () => chain({ isPublished: true });
    ProblemModel.findByIdAndUpdate = async (_id, update) => { Object.assign(document, update); return { ...document, isPublished: true }; };
    await problemService.updateProblem(String(id), { title: "Updated challenge" });
    const updated = await problemService.listProblems({ page: 1, limit: 20 });
    assert.equal(publicReads, 3);
    assert.equal(updated.items[0].title, "Updated challenge");
  } finally {
    ProblemModel.find = originals.find;
    ProblemModel.countDocuments = originals.count;
    SubmissionModel.aggregate = originals.aggregate;
    SubmissionModel.find = originals.submissions;
    ProblemModel.findById = originals.findById;
    ProblemModel.findByIdAndUpdate = originals.update;
    catalogueCache.clear();
  }
});
