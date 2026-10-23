#!/usr/bin/env node
/**
 * Records the demo shown to visitors without an API key: a real run of the hypoxia benchmark
 * (paper criteria), replayed from the eval cache, plus explanations for a selection of datasets.
 *
 *   npm run make-demo            # needs OPENROUTER_API_KEY (or OPENROUTER_KEY) only for uncached explanations
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  type Cache,
  DEFAULT_CHAT_MODEL,
  DecisionScorer,
  type DatasetResult,
  type Explanation,
  explainResult,
  mapPool,
  Ncbi,
  normalizeGseList,
  openrouter,
  type Protocol,
  run,
  type RunInput,
} from '../src/core';
import pkg from '../package.json' with { type: 'json' };
import type { DemoRecording } from '../src/ui/demo';

if (existsSync('.env')) process.loadEnvFile('.env');
const key = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY || '';
const task = JSON.parse(readFileSync('eval/tasks/hypoxia-paper-criteria.json', 'utf8')) as {
  protocol: Protocol;
  input: RunInput & { retmax: number };
  scorer: { model: string };
  gold: string;
};

const cacheFile = 'eval/.cache/cache.jsonl';
const map = new Map<string, unknown>();
if (existsSync(cacheFile)) for (const line of readFileSync(cacheFile, 'utf8').split('\n')) if (line) map.set(JSON.parse(line).k, JSON.parse(line).v);
const cache: Cache = {
  get: async <T>(k: string) => map.get(k) as T | undefined,
  set: async (k, v) => {
    map.set(k, v);
    appendFileSync(cacheFile, `${JSON.stringify({ k, v })}\n`);
  },
};

const ep = openrouter(key);
const { results, manifest } = await run({
  protocol: task.protocol,
  input: task.input,
  ncbi: new Ncbi({ email: process.env.NCBI_EMAIL }),
  scorer: new DecisionScorer(ep, task.scorer.model),
  cache,
  appVersion: pkg.version,
  onEvent: (e) => e.type === 'phase' && console.log(e.message),
});

const gold = normalizeGseList(readFileSync(task.gold, 'utf8'));
const goldSet = new Set(gold);
const screened = results.filter((r) => r.screening);
const pick = new Set([
  ...screened.slice(0, 12).map((r) => r.gse),
  ...screened.filter((r) => r.screening!.decision === 'unclear').map((r) => r.gse),
  ...screened.filter((r) => goldSet.has(r.gse) && r.screening!.decision !== 'include').map((r) => r.gse),
]);
console.log(`Explaining ${pick.size} datasets with ${DEFAULT_CHAT_MODEL}…`);
const explained = await mapPool(
  results.filter((r) => pick.has(r.gse)),
  4,
  (r) => explainResult(r, task.protocol, ep, DEFAULT_CHAT_MODEL, { cache }).catch((err) => (console.log(`  ! ${r.gse}: ${err.message}`), r)),
);
const explanations: Record<string, Explanation> = {};
for (const r of explained) if (r.explanation) explanations[r.gse] = r.explanation;
manifest.cost.explanations = Object.values(explanations).reduce((s, e) => s + e.cost, 0);

/** Keeps what the UI shows; the per-sample records are summarized in `design` and `text`. */
const slim = (r: DatasetResult): DatasetResult => ({
  gse: r.gse,
  candidate: r.candidate,
  screening: r.screening,
  error: r.error,
  dossier: r.dossier && {
    ...r.dossier,
    series: r.dossier.series && { ...r.dossier.series, samples: [] },
    papers: r.dossier.papers.map((p) => ({ ...p, abstract: '' })),
  },
});

const recordedAt = manifest.createdAt.slice(0, 10);
const demo: DemoRecording = {
  title: 'Hypoxia vs normoxia, bulk RNA-seq, human cells',
  recordedAt,
  note: `a real run recorded on ${recordedAt}. ${screened.length} GEO series screened with against the inclusion criteria of a published meta-analysis (Puente-Santamaria et al. 2022).`,
  protocol: task.protocol,
  retmax: task.input.retmax,
  manifest,
  results: results.map(slim),
  explanations,
  gold,
};
mkdirSync('public/demo', { recursive: true });
writeFileSync('public/demo/hypoxia.json', JSON.stringify(demo));
console.log(`Wrote public/demo/hypoxia.json: ${results.length} datasets, ${Object.keys(explanations).length} explanations, explanation cost $${manifest.cost.explanations.toFixed(4)}`);
