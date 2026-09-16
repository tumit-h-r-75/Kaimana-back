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

// Sending a problem proposal for review costs this many gems (see
// modules/proposal). A rejected proposal refunds half, an accepted one keeps
// the full cost, and one deleted before it's reviewed refunds it all.
export const PROPOSAL_COST_GEMS = 50;
export const PROPOSAL_REJECT_REFUND_GEMS = Math.floor(PROPOSAL_COST_GEMS / 2);
