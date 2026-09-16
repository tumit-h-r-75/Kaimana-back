// Service for Code Quest progress: list a learner's completed levels and
// record a completion, keeping the best stars and the first completion time.

import { Types } from "mongoose";
import { KIDS_LEVEL_ID_MAX_LENGTH, KIDS_LEVEL_ID_PATTERN, KidsProgressModel } from "../../models/KidsProgress.model.js";
import { AppError } from "../../utils/errors.js";

// Far more than the curriculum has levels; stops one account from filling
// the collection with made-up level ids.
export const MAX_KIDS_PROGRESS_PER_USER = 500;

export interface KidsLevelProgressDto {
  levelId: string;
  stars: number;
  completedAt: Date;
}

type LeanKidsProgress = { levelId: string; stars: number; completedAt: Date };

const toDto = (doc: LeanKidsProgress): KidsLevelProgressDto => ({ levelId: doc.levelId, stars: doc.stars, completedAt: doc.completedAt });

const isDuplicateKeyError = (error: unknown) => typeof error === "object" && error !== null && (error as { code?: unknown }).code === 11000;

export const parseLevelId = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > KIDS_LEVEL_ID_MAX_LENGTH || !KIDS_LEVEL_ID_PATTERN.test(value)) {
    throw new AppError(`levelId must be lowercase letters and numbers separated by single dashes (at most ${KIDS_LEVEL_ID_MAX_LENGTH} characters).`, 400);
  }
  return value;
};

export const parseStars = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 3) {
    throw new AppError("stars must be a whole number from 1 to 3.", 400);
  }
  return value;
};

const toUserObjectId = (userId: string) => {
  if (!Types.ObjectId.isValid(userId)) throw new AppError("Invalid or expired session.", 401);
  return new Types.ObjectId(userId);
};

export const listProgress = async (userId: string) => {
  const docs = (await KidsProgressModel.find({ userId: toUserObjectId(userId) })
    .sort({ completedAt: 1, levelId: 1 })
    .limit(MAX_KIDS_PROGRESS_PER_USER)
    .select("levelId stars completedAt")
    .lean()) as unknown as LeanKidsProgress[];
  return { levels: docs.map(toDto) };
};

export const saveLevelProgress = async (userId: string, rawLevelId: unknown, rawStars: unknown): Promise<KidsLevelProgressDto> => {
  const levelId = parseLevelId(rawLevelId);
  const stars = parseStars(rawStars);
  const owner = toUserObjectId(userId);
  const filter = { userId: owner, levelId };

  // Updating a level already on record never counts against the cap. The
  // check isn't atomic with the insert, so parallel requests could overshoot
  // by a few documents — fine for an abuse limit this far above real use.
  if (!(await KidsProgressModel.exists(filter))) {
    const count = await KidsProgressModel.countDocuments({ userId: owner });
    if (count >= MAX_KIDS_PROGRESS_PER_USER) {
      throw new AppError(`Progress can be saved for at most ${MAX_KIDS_PROGRESS_PER_USER} levels.`, 400);
    }
  }

  // One atomic upsert: $max only ever raises the stars, and $setOnInsert
  // stamps completedAt on the first completion only.
  const upsertBest = () =>
    KidsProgressModel.findOneAndUpdate(filter, { $max: { stars }, $setOnInsert: { completedAt: new Date() } }, { upsert: true, new: true })
      .select("levelId stars completedAt")
      .lean();

  let saved: unknown;
  try {
    saved = await upsertBest();
  } catch (error) {
    // Two first completions of the same level racing: one insert wins the
    // unique index, the other hits E11000 — retrying turns it into an update.
    if (!isDuplicateKeyError(error)) throw error;
    saved = await upsertBest();
  }

  if (!saved) throw new AppError("Could not save progress. Please try again.", 500);
  return toDto(saved as LeanKidsProgress);
};

export const kidsService = { listProgress, saveLevelProgress };
