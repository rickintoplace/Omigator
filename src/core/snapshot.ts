/**
 * Compact, shareable form of a run. It keeps what cannot be recomputed without a key (the model's
 * probabilities and explanations) and drops what anyone can fetch again from NCBI (titles, sample
 * annotations, abstracts). Probabilities are stored as rounded logits, so the ranking of saturated
 * probabilities (0.9994 vs 0.99999) survives.
 */

import { aggregate, DEFAULT_THRESHOLDS } from './decide.js';
import { buildDossier } from './evidence.js';
import { fetchSeries } from './geo.js';
import type { Fetch } from './http.js';
import type { Ncbi } from './ncbi.js';
import type { Cache, RunInput, RunManifest } from './pipeline.js';
import { SERIES_CACHE, sortResults } from './pipeline.js';
import type { Candidate, DatasetResult, Explanation, Protocol, Series } from './types.js';

export interface Snapshot {
  v: 1;
  createdAt: string;
  protocol: Protocol;
  input: RunInput;
  manifest?: Pick<RunManifest, 'omigator' | 'createdAt' | 'scorer' | 'cost' | 'search'>;
  /** [gse, logits×100 in criteria order, index into manifest.scorer.snapshots] */
  items: [string, number[], number][];
  failed: string[];
  labels: Record<string, 0 | 1>;
  explanations?: Record<string, Explanation>;
  /** SuperSeries among the results and the series they bundle (to hide duplicates). */
  superSeries?: Record<string, string[]>;
}

const clampP = (p: number) => Math.min(Math.max(p, 1e-9), 1 - 1e-9);
const toLogit = (p: number) => Math.round(Math.log(clampP(p) / (1 - clampP(p))) * 100);
const fromLogit = (l: number) => 1 / (1 + Math.exp(-l / 100));

export function makeSnapshot(
  results: DatasetResult[],
  protocol: Protocol,
  input: RunInput,
  manifest: RunManifest | undefined,
  labels: Record<string, boolean>,
  opts: { explanations?: boolean } = {},
): Snapshot {
  const snapshots = manifest?.scorer.snapshots.length ? manifest.scorer.snapshots : [...new Set(results.flatMap((r) => r.screening?.model ?? []))];
  const ids = new Set(results.map((r) => r.gse));
  const snap: Snapshot = {
    v: 1,
    createdAt: manifest?.createdAt ?? new Date().toISOString(),
    protocol,
    input: input.mode === 'list' ? input : { mode: 'search', retmax: input.retmax },
    manifest: manifest && {
      omigator: manifest.omigator,
      createdAt: manifest.createdAt,
      scorer: { ...manifest.scorer, snapshots },
      cost: manifest.cost,
      search: manifest.search,
    },
    items: results
      .filter((r) => r.screening)
      .map((r) => [r.gse, protocol.criteria.map((c) => toLogit(r.screening!.p[c.id] ?? 0.5)), Math.max(0, snapshots.indexOf(r.screening!.model))]),
    failed: results.filter((r) => !r.screening).map((r) => r.gse),
    labels: Object.fromEntries(Object.entries(labels).filter(([g]) => ids.has(g)).map(([g, v]) => [g, v ? 1 : 0])),
  };
  const sup = results.flatMap((r) => {
    const of = r.dossier?.series?.superSeriesOf ?? r.superSeriesOf;
    return of?.length ? [[r.gse, of] as const] : [];
  });
  if (sup.length) snap.superSeries = Object.fromEntries(sup);
  if (opts.explanations) {
    const ex = results.filter((r) => r.explanation).map((r) => [r.gse, r.explanation!] as const);
    if (ex.length) snap.explanations = Object.fromEntries(ex);
  }
  return snap;
}

const toBase64Url = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (text: string) => {
  const b = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function encodeSnapshot(s: Snapshot): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(s));
  return toBase64Url(await pipe(json, new CompressionStream('deflate-raw')));
}

export async function decodeSnapshot(text: string): Promise<Snapshot> {
  const json = await pipe(fromBase64Url(text), new DecompressionStream('deflate-raw'));
  const s = JSON.parse(new TextDecoder().decode(json));
  if (s?.v !== 1 || !s.protocol?.criteria || !Array.isArray(s.items)) throw new Error('This link does not contain an Omigator run.');
  return s as Snapshot;
}

/** Rebuilds a ranked result list from a snapshot; GEO summaries are fetched again (2–3 requests). */
export async function restoreSnapshot(s: Snapshot, ncbi: Ncbi, signal?: AbortSignal): Promise<DatasetResult[]> {
  const gses = [...s.items.map(([g]) => g), ...s.failed];
  const candidates = new Map<string, Candidate>();
  for (const c of await ncbi.summaries(await ncbi.uidsForAccessions(gses, signal), signal)) candidates.set(c.gse, c);
  const placeholder = (gse: string): Candidate => ({ gse, uid: '', title: '(no longer in GEO search)', summary: '', organisms: '', seriesType: '', nSamples: 0, pubDate: '', pmids: [] });
  const models = s.manifest?.scorer.snapshots ?? [];

  const results: DatasetResult[] = s.items.map(([gse, logits, m]) => {
    const p = Object.fromEntries(s.protocol.criteria.map((c, i) => [c.id, fromLogit(logits[i] ?? 0)]));
    return {
      gse,
      candidate: candidates.get(gse) ?? placeholder(gse),
      screening: { p, model: models[m] ?? 'unknown', cost: 0, ...aggregate(s.protocol.criteria, p, DEFAULT_THRESHOLDS) },
      explanation: s.explanations?.[gse],
      superSeriesOf: s.superSeries?.[gse],
    };
  });
  for (const gse of s.failed) results.push({ gse, candidate: candidates.get(gse) ?? placeholder(gse), error: 'Not screened in the original run.' });
  return sortResults(results);
}

/** Loads the evidence of one dataset on demand (shared or restored runs keep no dossiers). */
export async function loadDossier(
  result: DatasetResult,
  ncbi: Ncbi,
  opts: { cache?: Cache; fetch?: Fetch; signal?: AbortSignal } = {},
): Promise<DatasetResult> {
  const key = SERIES_CACHE + result.gse;
  let series = await opts.cache?.get<Series>(key);
  const warnings: string[] = [];
  if (!series) {
    series = await fetchSeries(result.gse, { fetch: opts.fetch, signal: opts.signal }).catch((err) => {
      warnings.push(`Sample metadata unavailable: ${(err as Error).message}`);
      return undefined;
    });
    if (series) await opts.cache?.set(key, series);
  }
  const ids = result.candidate.pmids.slice(0, 2);
  const papers = ids.length ? [...(await ncbi.papers(ids, opts.signal).catch(() => new Map())).values()] : [];
  return { ...result, dossier: buildDossier(result.candidate, series, papers, warnings) };
}
