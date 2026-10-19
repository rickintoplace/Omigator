/**
 * Turning model scores into decisions the user can trust, from a few labels.
 *
 * Decision-model probabilities are over-confident on new tasks (Jev on screening: observed/expected
 * 0.13; pplx-decider card: ECE ≈ 0.05 on held-out tasks), so thresholds are set from labels:
 * - Platt scaling maps the ranking score to a probability of relevance.
 * - A split-conformal cutoff from labelled positives bounds the miss rate: excluding everything below
 *   it misses a new relevant dataset with probability ≤ α, *if* the labelled positives are a random
 *   sample of all positives (label a random audit sample, not just the top of the list).
 */

export interface Platt {
  a: number;
  b: number;
}

export function plattProbability(m: Platt, score: number): number {
  return 1 / (1 + Math.exp(-(m.a * score + m.b)));
}

/** Platt (1999) with his smoothed targets; Newton iterations on the 2-parameter logistic model. */
export function fitPlatt(scores: number[], labels: boolean[]): Platt | undefined {
  const nPos = labels.filter(Boolean).length;
  const nNeg = labels.length - nPos;
  if (nPos < 2 || nNeg < 2) return undefined;
  const hi = (nPos + 1) / (nPos + 2);
  const lo = 1 / (nNeg + 2);
  const t = labels.map((y) => (y ? hi : lo));

  let a = 0;
  let b = Math.log((nPos + 1) / (nNeg + 1));
  for (let iter = 0; iter < 100; iter++) {
    let ga = 0, gb = 0, haa = 1e-9, hab = 0, hbb = 1e-9;
    for (let i = 0; i < scores.length; i++) {
      const p = 1 / (1 + Math.exp(-(a * scores[i] + b)));
      const d = p - t[i];
      const w = p * (1 - p);
      ga += d * scores[i];
      gb += d;
      haa += w * scores[i] * scores[i];
      hab += w * scores[i];
      hbb += w;
    }
    const det = haa * hbb - hab * hab;
    if (Math.abs(det) < 1e-12) break;
    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;
    a -= da;
    b -= db;
    if (Math.abs(da) + Math.abs(db) < 1e-8) break;
  }
  return { a, b };
}

export interface ConformalCutoff {
  /** Exclude datasets scoring below this. */
  cutoff: number;
  /** False when there are too few labelled positives for the requested α. */
  guaranteed: boolean;
  /** Labelled positives needed for a guarantee at this α. */
  positivesNeeded: number;
}

export function conformalCutoff(positiveScores: number[], alpha = 0.05): ConformalCutoff {
  const sorted = [...positiveScores].sort((x, y) => x - y);
  const n = sorted.length;
  const positivesNeeded = Math.ceil(1 / alpha - 1);
  const k = Math.floor(alpha * (n + 1));
  if (k < 1) return { cutoff: n ? sorted[0] : -Infinity, guaranteed: false, positivesNeeded };
  return { cutoff: sorted[k - 1], guaranteed: true, positivesNeeded };
}

/** Share of labelled positives at or above a cutoff, with a Wilson 95% interval. */
export function recallEstimate(positiveScores: number[], cutoff: number): { recall: number; low: number; high: number } {
  const n = positiveScores.length;
  if (!n) return { recall: NaN, low: NaN, high: NaN };
  const k = positiveScores.filter((s) => s >= cutoff).length;
  const p = k / n;
  const z = 1.96;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { recall: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}
