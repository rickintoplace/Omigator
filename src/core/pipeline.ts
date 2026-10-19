/**
 * A run: search (or a GSE list) → summaries → hard filters → dossier per dataset → screening.
 * One scorer and one model per run; a failed dataset is reported as failed, never re-scored by
 * another model behind the user's back. Explanations are a separate, on-demand step.
 */

import { aggregate, DEFAULT_THRESHOLDS, type Thresholds } from './decide';
import { buildDossier, DEFAULT_CAPS, type DossierCaps } from './evidence';
import { explain } from './explain';
import { fetchSeries } from './geo';
import { type Fetch, isAbort, mapPool, sha256 } from './http';
import type { Endpoint } from './llm';
import { applyFilters, buildGdsTerm, type FilterReport, Ncbi } from './ncbi';
import type { Scorer } from './scorers';
import type { Candidate, DatasetResult, Paper, Protocol, Series } from './types';

export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export const noCache: Cache = { get: async () => undefined, set: async () => {} };

export type RunInput = { mode: 'search'; retmax: number } | { mode: 'list'; gses: string[] };

export type RunEvent =
  | { type: 'phase'; phase: 'search' | 'filter' | 'screen' | 'done'; message: string }
  | { type: 'search'; term: string; count: number; retrieved: number }
  | { type: 'candidates'; candidates: Candidate[]; removed: FilterReport['removed'] }
  | { type: 'result'; result: DatasetResult }
  | { type: 'log'; message: string };

export interface RunOptions {
  protocol: Protocol;
  input: RunInput;
  ncbi: Ncbi;
  scorer: Scorer;
  thresholds?: Thresholds;
  /** Datasets processed in parallel. */
  concurrency?: number;
  cache?: Cache;
  fetch?: Fetch;
  signal?: AbortSignal;
  onEvent?: (e: RunEvent) => void;
  appVersion?: string;
  /** Dossier size limits and contents (for ablations). */
  caps?: DossierCaps;
}

export interface RunManifest {
  omigator: string;
  createdAt: string;
  durationMs: number;
  protocol: Protocol;
  input: RunInput;
  search?: { term: string; count: number; retrieved: number };
  removedByFilters: FilterReport['removed'];
  scorer: { id: string; model: string; snapshots: string[] };
  thresholds: Thresholds;
  counts: { candidates: number; screened: number; failed: number; include: number; unclear: number; exclude: number };
  cost: { screening: number; explanations: number };
  ncbiApiKey: boolean;
}

export interface RunOutput {
  results: DatasetResult[];
  manifest: RunManifest;
}

export const SERIES_CACHE = 'series:v2:';
const PAPERS_PER_DATASET = 2;

export function normalizeGseList(text: string): string[] {
  return [...new Set((text.match(/GSE\d+/gi) ?? []).map((g) => g.toUpperCase()))];
}

/** Ranking order: screened datasets by score, failed ones last. */
export function sortResults(results: DatasetResult[]): DatasetResult[] {
  return [...results].sort((a, b) => (b.screening?.logScore ?? -Infinity) - (a.screening?.logScore ?? -Infinity));
}

export async function run(opts: RunOptions): Promise<RunOutput> {
  const started = Date.now();
  const { protocol, input, ncbi, scorer, signal } = opts;
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const cache = opts.cache ?? noCache;
  const emit = opts.onEvent ?? (() => {});
  if (!protocol.criteria.length) throw new Error('The protocol has no criteria.');

  // 1. Candidates
  let uids: string[];
  let search: RunManifest['search'];
  if (input.mode === 'search') {
    const term = buildGdsTerm(protocol.query, protocol.filters);
    emit({ type: 'phase', phase: 'search', message: 'Searching GEO…' });
    const r = await ncbi.searchGds(term, input.retmax, signal);
    uids = r.uids;
    search = { term, count: r.count, retrieved: r.uids.length };
    emit({ type: 'search', ...search });
  } else {
    emit({ type: 'phase', phase: 'search', message: `Looking up ${input.gses.length} accessions…` });
    uids = await ncbi.uidsForAccessions(input.gses, signal);
  }

  emit({ type: 'phase', phase: 'filter', message: `Fetching summaries for ${uids.length} series…` });
  const summaries = await ncbi.summaries(uids, signal);
  const { kept, removed } = applyFilters(summaries, protocol.filters);
  emit({ type: 'candidates', candidates: kept, removed });

  // 2. Linked abstracts in batches (one E-utilities call per 150 papers)
  const pmids = kept.flatMap((c) => c.pmids.slice(0, PAPERS_PER_DATASET));
  let papers = new Map<string, Paper>();
  if (pmids.length) {
    emit({ type: 'phase', phase: 'screen', message: `Fetching ${pmids.length} linked abstracts…` });
    papers = await ncbi.papers(pmids, signal).catch((err) => {
      if (isAbort(err, signal)) throw err;
      emit({ type: 'log', message: `Abstracts unavailable: ${(err as Error).message}` });
      return new Map<string, Paper>();
    });
  }

  // 3. Dossier + screening per dataset
  emit({ type: 'phase', phase: 'screen', message: `Screening ${kept.length} datasets with ${scorer.model}…` });
  const criteriaKey = JSON.stringify(protocol.criteria);
  const results = await mapPool(
    kept,
    opts.concurrency ?? 4,
    async (candidate): Promise<DatasetResult> => {
      const result: DatasetResult = { gse: candidate.gse, candidate };
      try {
        const warnings: string[] = [];
        let series = await cache.get<Series>(SERIES_CACHE + candidate.gse);
        if (!series) {
          try {
            series = await fetchSeries(candidate.gse, { signal, fetch: opts.fetch });
            await cache.set(SERIES_CACHE + candidate.gse, series);
          } catch (err) {
            if (isAbort(err, signal)) throw err;
            warnings.push(`Sample metadata unavailable: ${(err as Error).message}`);
          }
        }
        const linked = candidate.pmids.slice(0, PAPERS_PER_DATASET).flatMap((id) => papers.get(id) ?? []);
        result.dossier = buildDossier(candidate, series, linked, warnings, opts.caps ?? DEFAULT_CAPS);

        const key = `score:${scorer.id}:${await sha256(criteriaKey + result.dossier.text)}`;
        let scored = await cache.get<{ p: Record<string, number>; model: string; cost: number }>(key);
        if (!scored) {
          scored = await scorer.score(result.dossier.text, protocol.criteria, signal);
          await cache.set(key, scored);
        }
        result.screening = { ...scored, ...aggregate(protocol.criteria, scored.p, thresholds) };
      } catch (err) {
        if (isAbort(err, signal)) throw err;
        result.error = (err as Error).message;
      }
      emit({ type: 'result', result });
      return result;
    },
    signal,
  );

  const sorted = sortResults(results);
  const screened = sorted.filter((r) => r.screening);
  const manifest: RunManifest = {
    omigator: opts.appVersion ?? 'dev',
    createdAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    protocol,
    input,
    search,
    removedByFilters: removed,
    scorer: { id: scorer.id, model: scorer.model, snapshots: [...new Set(screened.map((r) => r.screening!.model))] },
    thresholds,
    counts: {
      candidates: kept.length,
      screened: screened.length,
      failed: sorted.length - screened.length,
      include: screened.filter((r) => r.screening!.decision === 'include').length,
      unclear: screened.filter((r) => r.screening!.decision === 'unclear').length,
      exclude: screened.filter((r) => r.screening!.decision === 'exclude').length,
    },
    cost: { screening: screened.reduce((s, r) => s + r.screening!.cost, 0), explanations: 0 },
    ncbiApiKey: ncbi.hasApiKey,
  };
  emit({ type: 'phase', phase: 'done', message: `Screened ${screened.length} of ${kept.length} datasets.` });
  return { results: sorted, manifest };
}

/** Rescreens one dataset (e.g. after an error) with the run's scorer. */
export async function rescreen(
  result: DatasetResult,
  protocol: Protocol,
  scorer: Scorer,
  opts: { thresholds?: Thresholds; signal?: AbortSignal; fetch?: Fetch; cache?: Cache } = {},
): Promise<DatasetResult> {
  const cache = opts.cache ?? noCache;
  let dossier = result.dossier;
  if (!dossier?.series) {
    const series = await fetchSeries(result.gse, { signal: opts.signal, fetch: opts.fetch }).catch(() => undefined);
    if (series) await cache.set(SERIES_CACHE + result.gse, series);
    dossier = buildDossier(result.candidate, series, dossier?.papers ?? [], series ? [] : ['Sample metadata unavailable.']);
  }
  const scored = await scorer.score(dossier.text, protocol.criteria, opts.signal);
  return {
    ...result,
    dossier,
    error: undefined,
    screening: { ...scored, ...aggregate(protocol.criteria, scored.p, opts.thresholds ?? DEFAULT_THRESHOLDS) },
  };
}

export async function explainResult(
  result: DatasetResult,
  protocol: Protocol,
  ep: Endpoint,
  model: string,
  opts: { signal?: AbortSignal; cache?: Cache } = {},
): Promise<DatasetResult> {
  if (!result.dossier) throw new Error('No dossier to explain.');
  const cache = opts.cache ?? noCache;
  const key = `explain:${model}:${await sha256(JSON.stringify(protocol.criteria) + result.dossier.text)}`;
  let explanation = await cache.get<DatasetResult['explanation']>(key);
  if (!explanation) {
    explanation = await explain(result.dossier.text, protocol.criteria, result.screening?.p, ep, model, opts.signal);
    await cache.set(key, explanation);
  }
  return { ...result, explanation };
}
