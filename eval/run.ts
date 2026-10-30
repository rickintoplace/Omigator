#!/usr/bin/env node
/**
 * Runs a screening task from the command line with the same core as the web app.
 *
 *   npm run eval -- --task eval/tasks/hypoxia.json [--model perplexity/pplx-decider-flash-v1.2] [--explain 20]
 *
 * Keys come from the environment or `.env`: OPENROUTER_API_KEY (or OPENROUTER_KEY), optionally
 * CUSTOM_BASE_URL and CUSTOM_API_KEY (self-hosted endpoint), NCBI_API_KEY, NCBI_EMAIL. Every model call is cached in
 * eval/.cache/ (keyed by model, criteria and evidence), so a rerun costs nothing.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DecisionsJudge } from 'veriquote';
import {
  bootstrap,
  DEFAULT_CAPS,
  type Cache,
  confusion,
  customEndpoint,
  DEFAULT_CHAT_MODEL,
  DEFAULT_DECISION_MODEL,
  DecisionScorer,
  type DatasetResult,
  type Endpoint,
  explainResult,
  LogprobScorer,
  mapPool,
  Ncbi,
  normalizeGseList,
  openrouter,
  type Protocol,
  rankingMetrics,
  run,
  type RunInput,
  type Scorer,
} from '../src/core';
import pkg from '../package.json' with { type: 'json' };

interface Task {
  name: string;
  protocol: Protocol;
  input: RunInput;
  scorer: { kind: 'decisions' | 'logprobs'; endpoint?: 'openrouter' | 'custom'; model: string; providers?: string[]; baseUrl?: string };
  /** File with the GSE accessions known to be relevant. */
  gold?: string;
  concurrency?: number;
}

const { values: args } = parseArgs({
  options: {
    task: { type: 'string' },
    model: { type: 'string' },
    out: { type: 'string' },
    explain: { type: 'string', default: '0' },
    /** Ablation: 'series' leaves sample-level metadata out of the dossier. */
    evidence: { type: 'string', default: 'full' },
    /** Reference list to score against (overrides the task's). */
    gold: { type: 'string' },
    'explain-model': { type: 'string', default: DEFAULT_CHAT_MODEL },
  },
});
if (!args.task) {
  console.error('Usage: npm run eval -- --task eval/tasks/<task>.json [--model <id>] [--explain <top-k>]');
  process.exit(1);
}
if (existsSync('.env')) process.loadEnvFile('.env');
const env = process.env;
const orKey = env.OPENROUTER_API_KEY || env.OPENROUTER_KEY;

const task: Task = JSON.parse(readFileSync(args.task, 'utf8'));
const scorerCfg = { ...task.scorer, ...(args.model ? { model: args.model } : {}) };

function endpointFor(kind: Task['scorer']['endpoint'] = 'openrouter', baseUrl?: string): Endpoint {
  if (kind === 'custom') return customEndpoint(baseUrl ?? env.CUSTOM_BASE_URL ?? '', env.CUSTOM_API_KEY);
  if (!orKey) throw new Error('Set OPENROUTER_API_KEY (or OPENROUTER_KEY) in the environment or .env');
  return openrouter(orKey);
}

const ep = endpointFor(scorerCfg.endpoint, scorerCfg.baseUrl);
const scorer: Scorer =
  scorerCfg.kind === 'decisions' ? new DecisionScorer(ep, scorerCfg.model) : new LogprobScorer(ep, scorerCfg.model, { providers: scorerCfg.providers });

/** Append-only JSONL cache shared by all eval runs. */
function fileCache(file: string): Cache {
  mkdirSync(path.dirname(file), { recursive: true });
  const map = new Map<string, unknown>();
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      const { k, v } = JSON.parse(line);
      map.set(k, v);
    }
  }
  return {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    set: async (key, value) => {
      map.set(key, value);
      appendFileSync(file, `${JSON.stringify({ k: key, v: value })}\n`);
    },
  };
}

const cache = fileCache('eval/.cache/cache.jsonl');
const ncbi = new Ncbi({ apiKey: env.NCBI_API_KEY, email: env.NCBI_EMAIL });
const stamp = new Date().toISOString().slice(0, 10);
const evidence = args.evidence === 'series' ? 'series' : 'full';
const outDir =
  args.out ?? path.join('eval', 'runs', `${task.name}-${scorer.model.replace(/[^\w.-]+/g, '_')}${evidence === 'series' ? '-series-only' : ''}-${stamp}`);
mkdirSync(outDir, { recursive: true });

let done = 0;
const { results, manifest } = await run({
  protocol: task.protocol,
  input: task.input,
  ncbi,
  scorer,
  cache,
  concurrency: task.concurrency ?? 6,
  appVersion: pkg.version,
  caps: { ...DEFAULT_CAPS, samples: evidence === 'full' },
  onEvent: (e) => {
    if (e.type === 'phase') console.log(`[${e.phase}] ${e.message}`);
    if (e.type === 'search') console.log(`  term: ${e.term}\n  ${e.count} hits, ${e.retrieved} retrieved`);
    if (e.type === 'candidates') console.log(`  ${e.candidates.length} pass filters; removed ${JSON.stringify(e.removed)}`);
    if (e.type === 'result') {
      done++;
      if (e.result.error) console.log(`  ! ${e.result.gse}: ${e.result.error}`);
      else if (done % 25 === 0) console.log(`  ${done} screened`);
    }
    if (e.type === 'log') console.log(`  ${e.message}`);
  },
});

// Optional explanations for the top-k
const k = Number(args.explain);
if (k > 0) {
  console.log(`[explain] top ${k} with ${args['explain-model']}`);
  const top = results.filter((r) => r.screening).slice(0, k);
  const judge = { judge: new DecisionsJudge({ apiKey: orKey, model: DEFAULT_DECISION_MODEL }), id: `decisions:${DEFAULT_DECISION_MODEL}` };
  const explained = await mapPool(top, 4, (r) =>
    explainResult(r, task.protocol, endpointFor('openrouter'), args['explain-model']!, { cache, judge }).catch((err) => {
      console.log(`  ! explain ${r.gse}: ${(err as Error).message}`);
      return r;
    }),
  );
  for (const r of explained) results[results.findIndex((x) => x.gse === r.gse)] = r;
  manifest.cost.explanations = explained.reduce((s, r) => s + (r.explanation?.cost ?? 0), 0);
}

// Outputs
const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const crit = task.protocol.criteria.map((c) => c.id);
const header = ['rank', 'gse', 'decision', 'log_score', 'eligibility', ...crit.map((c) => `p_${c}`), 'title', 'n_samples', 'pub_date', 'model', 'error'];
const rows = results.map((r: DatasetResult, i) => [
  i + 1,
  r.gse,
  r.screening?.decision ?? 'error',
  r.screening?.logScore.toFixed(4),
  r.screening?.eligibility.toFixed(4),
  ...crit.map((c) => r.screening?.p[c]?.toFixed(4)),
  r.candidate.title,
  r.candidate.nSamples,
  r.candidate.pubDate,
  r.screening?.model,
  r.error,
]);
writeFileSync(path.join(outDir, 'results.csv'), [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n'));
writeFileSync(path.join(outDir, 'results.jsonl'), results.map((r) => JSON.stringify({ ...r, dossier: r.dossier && { text: r.dossier.text, warnings: r.dossier.warnings } })).join('\n'));
writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log(
  `\n${manifest.counts.screened} screened, ${manifest.counts.failed} failed · include ${manifest.counts.include}, unclear ${manifest.counts.unclear}, exclude ${manifest.counts.exclude}` +
    ` · cost $${manifest.cost.screening.toFixed(4)} (+$${manifest.cost.explanations.toFixed(4)} explanations) · ${(manifest.durationMs / 1000).toFixed(0)} s`,
);
console.log(`snapshots: ${manifest.scorer.snapshots.join(', ')}`);

const goldFile = args.gold ?? task.gold;
if (goldFile) {
  const gold = new Set(normalizeGseList(readFileSync(goldFile, 'utf8')));
  const scored = results.filter((r) => r.screening).map((r) => ({ id: r.gse, score: r.screening!.logScore, positive: gold.has(r.gse) }));
  const ks = [10, 20, 50, 100];
  const m = rankingMetrics(scored, ks, gold.size);
  const ci = bootstrap(scored, (xs) => rankingMetrics(xs).auroc);
  const dec = confusion(
    results.filter((r) => r.screening).map((r) => r.screening!.decision === 'include'),
    scored.map((s) => s.positive),
  );
  const decLenient = confusion(
    results.filter((r) => r.screening).map((r) => r.screening!.decision !== 'exclude'),
    scored.map((s) => s.positive),
  );
  const metrics = { goldFile, gold: gold.size, retrievedGold: m.positives, ...m, aurocCI: ci, decisionInclude: dec, decisionNotExcluded: decLenient };
  writeFileSync(path.join(outDir, 'metrics.json'), JSON.stringify(metrics, null, 2));
  const f = (x: number) => x.toFixed(3);
  console.log(`\nGold: ${gold.size} (${m.positives} among the ${m.n} screened)`);
  console.log(`AUROC ${f(m.auroc)} [${f(ci[0])}–${f(ci[1])}]  AP ${f(m.averagePrecision)}  WSS@95 ${f(m.wss95)} (read ${m.readFor95})`);
  console.log(ks.map((k) => `P@${k} ${f(m.precisionAt[k])}  R@${k} ${f(m.recallAt[k])}`).join('\n'));
  console.log(`include:        precision ${f(dec.precision)} recall ${f(dec.recall)} (tp ${dec.tp}, fp ${dec.fp}, fn ${dec.fn})`);
  console.log(`not excluded:   precision ${f(decLenient.precision)} recall ${f(decLenient.recall)} (tp ${decLenient.tp}, fp ${decLenient.fp}, fn ${decLenient.fn})`);
}
console.log(`\nWritten to ${outDir}/`);
