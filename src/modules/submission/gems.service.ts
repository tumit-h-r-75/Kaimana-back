// Exactly-once first-solve gem payouts, backed by the GemAward ledger.

import mongoose from "mongoose";
import { GemAwardModel } from "../../models/GemAward.model.js";
import { UserModel } from "../../models/User.model.js";
import { gemsForDifficulty } from "../../utils/gems.js";

const isDuplicateKeyError = (error: unknown) => typeof error === "object" && error !== null && (error as { code?: unknown }).code === 11000;

// Pays a problem's gems the first time a user gets ACCEPTED on it and returns
// how many were awarded — 0 when this user was already paid for the problem.
//
// The old check ("does any OTHER accepted submission for this problem
// exist?") raced: two accepted submissions judged at the same moment each saw
// the other and neither paid out, or — when neither was saved yet — both did.
// Now the ledger row and the balance change commit together in one
// transaction, and the ledger's unique (userId, problemId) index lets exactly
// one payout through no matter how many requests arrive at once.
export const awardFirstSolveGems = async ({
  userId,
  problemId,
  submissionId,
  difficulty,
}: {
  userId: string;
  problemId: string;
  submissionId: unknown;
  difficulty: string;
}): Promise<number> => {
  const gems = gemsForDifficulty(difficulty);
  if (gems <= 0) return 0;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await GemAwardModel.create([{ userId, problemId, submissionId, gems }], { session });
      await UserModel.updateOne({ _id: userId }, { $inc: { gems } }, { session });
    });
    return gems;
  } catch (error) {
    // Already paid for this problem (possibly by a submission judged a few
    // milliseconds earlier) — the transaction rolled back, nothing changed.
    if (isDuplicateKeyError(error)) return 0;
    throw error;
  } finally {
    await session.endSession();
  }
};

export const gemsService = { awardFirstSolveGems };
