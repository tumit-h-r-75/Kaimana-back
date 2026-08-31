// Empirical complexity estimation via log-log regression.
//
// Given measured (size, value) pairs — size = an input's length as a
// proxy for "n", value = measured runtime or memory for that input — this
// fits a power law value ≈ c · size^k by linear-regressing
// ln(value) against ln(size). The resulting slope k is a standard,
// well-established way to estimate a polynomial growth exponent from
// measurements (this is exactly how you'd estimate an unknown exponent
// in any empirical curve-fitting context) and is then rounded to the
// nearest complexity class Kaimana reports.
//
// This is deliberately presented as an estimate with a confidence level,
// never as a proof — two data points sitting on a line is weak evidence,
// which is exactly what `confidence` communicates.

export interface DataPoint {
  size: number;
  value: number;
}

export type ComplexityClass = "O(1)" | "O(log n)" | "O(n)" | "O(n log n)" | "O(n^2)" | "O(n^3)" | "O(2^n)";
export type Confidence = "low" | "medium" | "high";

export interface CurveFitResult {
  complexity: ComplexityClass;
  slope: number;
  rSquared: number;
  confidence: Confidence;
  pointCount: number;
}

const classifySlope = (slope: number): ComplexityClass => {
  if (slope < 0.15) return "O(1)";
  if (slope < 0.65) return "O(log n)";
  if (slope < 1.35) return "O(n)";
  if (slope < 1.75) return "O(n log n)";
  if (slope < 2.5) return "O(n^2)";
  if (slope < 3.5) return "O(n^3)";
  return "O(2^n)";
};

const FLOOR = 0.001; // avoids ln(0) for a measurement that rounds to 0ms/0kb

export const estimateComplexityClass = (points: DataPoint[]): CurveFitResult | null => {
  // Need at least two distinct sizes to fit a line at all.
  const distinctSizes = new Set(points.map((p) => p.size));
  if (points.length < 2 || distinctSizes.size < 2) return null;

  const xs = points.map((p) => Math.log(Math.max(p.size, 1)));
  const ys = points.map((p) => Math.log(Math.max(p.value, FLOOR)));
  const n = xs.length;

  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i += 1) {
    sumXY += (xs[i] - meanX) * (ys[i] - meanY);
    sumXX += (xs[i] - meanX) ** 2;
  }
  const slope = sumXX === 0 ? 0 : sumXY / sumXX;
  const intercept = meanY - slope * meanX;

  // R² — how well the fitted line actually explains the measured points.
  // Low R² means the data is noisy relative to any clean power-law fit
  // (common on a shared, unreliable free judge instance), which should
  // pull confidence down rather than reporting false certainty.
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    const predicted = intercept + slope * xs[i];
    ssRes += (ys[i] - predicted) ** 2;
    ssTot += (ys[i] - meanY) ** 2;
  }
  const rSquared = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);

  let confidence: Confidence = "low";
  if (n >= 4 && rSquared >= 0.85) confidence = "high";
  else if (n >= 3 && rSquared >= 0.6) confidence = "medium";

  return {
    complexity: classifySlope(slope),
    slope: Math.round(slope * 100) / 100,
    rSquared: Math.round(rSquared * 100) / 100,
    confidence,
    pointCount: n,
  };
};

// Loop-depth signals from structuralAnalysis.ts, mapped to the complexity
// class they'd typically produce, for corroborating (or flagging
// disagreement with) the empirical fit above.
export const complexityClassForLoopDepth = (maxLoopDepth: number): ComplexityClass => {
  if (maxLoopDepth <= 0) return "O(1)";
  if (maxLoopDepth === 1) return "O(n)";
  if (maxLoopDepth === 2) return "O(n^2)";
  return "O(n^3)";
};
