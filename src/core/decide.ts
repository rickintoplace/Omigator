/**
 * From per-criterion probabilities to a ranking key and a three-way decision. The logic lives in
 * code, not in the model: LLMs asked for one overall verdict sometimes treat AND as OR.
 */

import type { Criterion, Decision, Screening } from './types';

export interface Thresholds {
  /** A criterion counts as met at p ≥ this (or, for exclusions, as not applying at p ≤ 1 − this). */
  meet: number;
  /** A required criterion counts as clearly failed below this; an exclusion as clearly applying above 1 − this. */
  fail: number;
  /** Weight of `prefer` criteria in the ranking key. */
  preferWeight: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { meet: 0.5, fail: 0.2, preferWeight: 0.1 };

const EPS = 1e-9;
const log = (p: number) => Math.log(Math.min(Math.max(p, EPS), 1 - EPS));

/** Probability that the dataset passes this criterion (for exclusions: that the exclusion does not apply). */
export function passProbability(c: Criterion, p: number): number {
  return c.kind === 'exclude' ? 1 - p : p;
}

export function aggregate(
  criteria: Criterion[],
  p: Record<string, number>,
  t: Thresholds = DEFAULT_THRESHOLDS,
): Pick<Screening, 'logScore' | 'eligibility' | 'decision' | 'tags'> {
  let hard = 0;
  let soft = 0;
  let clearlyFails = false;
  let allMet = true;
  const tags: string[] = [];

  for (const c of criteria) {
    const pass = passProbability(c, p[c.id] ?? 0.5);
    if (c.kind === 'prefer') {
      soft += log(pass);
      if (pass >= t.meet) tags.push(c.id);
      continue;
    }
    hard += log(pass);
    if (pass < t.fail) clearlyFails = true;
    if (pass < t.meet) allMet = false;
    if (c.kind === 'require') tags.push(pass >= t.meet ? c.id : `no_${c.id}`);
    else if (pass < t.meet) tags.push(c.id);
  }

  const decision: Decision = clearlyFails ? 'exclude' : allMet ? 'include' : 'unclear';
  return { logScore: hard + t.preferWeight * soft, eligibility: Math.exp(hard), decision, tags };
}

/** Criteria sorted by how strongly they argue against inclusion (weakest pass first). */
export function weakestCriteria(criteria: Criterion[], p: Record<string, number>): Criterion[] {
  return [...criteria]
    .filter((c) => c.kind !== 'prefer')
    .sort((a, b) => passProbability(a, p[a.id] ?? 0.5) - passProbability(b, p[b.id] ?? 0.5));
}
