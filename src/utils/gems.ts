// Gems — a lightweight reward currency shown in the site header, separate
// from a problem's score (which already feeds the leaderboard). A learner
// earns a fixed amount the first time they get ACCEPTED on a given
// problem; resubmitting or resolving it again never pays out twice (see
// the "first ACCEPTED for this problem?" check in submission.controller.ts).
export const GEMS_BY_DIFFICULTY: Record<"EASY" | "MEDIUM" | "HARD", number> = {
  EASY: 10,
  MEDIUM: 20,
  HARD: 30,
};

export const gemsForDifficulty = (difficulty: string): number =>
  GEMS_BY_DIFFICULTY[difficulty as keyof typeof GEMS_BY_DIFFICULTY] ?? GEMS_BY_DIFFICULTY.EASY;
