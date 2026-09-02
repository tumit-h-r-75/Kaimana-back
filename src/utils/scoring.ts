// Scoring formula for judged submissions.
// score = basePoints x (passedTests / totalTests) x (1 - hintPenaltyPercent
// / 100), rounded to the nearest integer. The hint penalty (see
// hint.service.ts / HintUnlock.model.ts) is the "negative marking" side of
// the AI hint system: once wired up here, it applies to every submission on
// a problem a learner has spent hints on, not just the one they were
// looking at the hint for. Contest time-decay and efficiency bonuses are
// still open extension points.

export const computeScore = ({
  basePoints,
  passedTests,
  totalTests,
  hintPenaltyPercent = 0,
}: {
  basePoints: number;
  passedTests: number;
  totalTests: number;
  hintPenaltyPercent?: number;
}): number => {
  if (totalTests <= 0) return 0;
  const ratio = Math.min(Math.max(passedTests / totalTests, 0), 1);
  const safePenaltyPercent = Math.min(Math.max(hintPenaltyPercent, 0), 100);
  return Math.round(basePoints * ratio * (1 - safePenaltyPercent / 100));
};
