// Scoring formula for judged submissions.
// score = basePoints x (passedTests / totalTests), rounded to the nearest
// integer. Contest time-decay, hint penalties, and efficiency bonuses are
// intentionally left as clear extension points (see 02-FEATURE-SPECS.md)
// once contests and the AI hint system are wired up.

export const computeScore = ({
  basePoints,
  passedTests,
  totalTests,
}: {
  basePoints: number;
  passedTests: number;
  totalTests: number;
}): number => {
  if (totalTests <= 0) return 0;
  const ratio = Math.min(Math.max(passedTests / totalTests, 0), 1);
  return Math.round(basePoints * ratio);
};
