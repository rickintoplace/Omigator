/** Ranking and decision metrics for a scored list against known positives. */

export interface Scored {
  id: string;
  score: number;
  positive: boolean;
}

export interface RankingMetrics {
  n: number;
  positives: number;
  auroc: number;
  averagePrecision: number;
  precisionAt: Record<number, number>;
  /** Recall@k; denominator is `totalPositives` (may include positives the search never retrieved). */
  recallAt: Record<number, number>;
  /** Work saved over sampling at 95% recall of the retrieved positives. */
  wss95: number;
  /** Items to read (top-down) to reach 95% recall of the retrieved positives. */
  readFor95: number;
}

export function rankingMetrics(items: Scored[], ks: number[] = [10, 20, 50, 100], totalPositives?: number): RankingMetrics {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const n = sorted.length;
  const P = sorted.filter((x) => x.positive).length;
  const G = totalPositives ?? P;
  const hitsAt = (k: number) => sorted.slice(0, k).filter((x) => x.positive).length;

  let ap = 0;
  let hits = 0;
  sorted.forEach((x, i) => {
    if (x.positive) ap += ++hits / (i + 1);
  });

  const pos = sorted.filter((x) => x.positive).map((x) => x.score);
  const neg = sorted.filter((x) => !x.positive).map((x) => x.score);
  let auc = 0;
  for (const a of pos) for (const b of neg) auc += a > b ? 1 : a === b ? 0.5 : 0;

  let readFor95 = n;
  for (let i = 0, c = 0; i < n; i++) {
    if (sorted[i].positive) c++;
    if (c >= Math.ceil(0.95 * P)) {
      readFor95 = i + 1;
      break;
    }
  }

  return {
    n,
    positives: P,
    auroc: pos.length && neg.length ? auc / (pos.length * neg.length) : NaN,
    averagePrecision: P ? ap / P : NaN,
    precisionAt: Object.fromEntries(ks.map((k) => [k, hitsAt(k) / k])),
    recallAt: Object.fromEntries(ks.map((k) => [k, G ? hitsAt(k) / G : NaN])),
    wss95: n ? (n - readFor95) / n - 0.05 : NaN,
    readFor95,
  };
}

export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
}

export function confusion(predicted: boolean[], actual: boolean[]): Confusion {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  predicted.forEach((p, i) => {
    if (p && actual[i]) tp++;
    else if (p) fp++;
    else if (actual[i]) fn++;
    else tn++;
  });
  return { tp, fp, fn, tn, precision: tp + fp ? tp / (tp + fp) : NaN, recall: tp + fn ? tp / (tp + fn) : NaN };
}

/** Deterministic PRNG (LCG) so bootstrap intervals are reproducible. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

/** Percentile bootstrap 95% interval of a statistic over resampled items. */
export function bootstrap(items: Scored[], stat: (xs: Scored[]) => number, B = 2000, seed = 20261019): [number, number] {
  const rnd = lcg(seed);
  const values: number[] = [];
  for (let b = 0; b < B; b++) {
    const sample = items.map(() => items[Math.floor(rnd() * items.length)]);
    const v = stat(sample);
    if (Number.isFinite(v)) values.push(v);
  }
  values.sort((a, b) => a - b);
  return [values[Math.floor(0.025 * values.length)], values[Math.floor(0.975 * values.length)]];
}
