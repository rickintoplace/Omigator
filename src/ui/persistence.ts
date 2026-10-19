/** Saving runs locally and turning runs into share links. */

import {
  type DatasetResult,
  DEFAULT_THRESHOLDS,
  decodeSnapshot,
  encodeSnapshot,
  makeSnapshot,
  type Ncbi,
  type Protocol,
  restoreSnapshot,
  type RunInput,
  type RunManifest,
  type Snapshot,
} from '../core';
import { getRun, saveRun, type SavedRunMeta } from './idbCache';

export interface SavedRun {
  results: DatasetResult[];
  protocol: Protocol;
  input: RunInput;
  manifest?: RunManifest;
}

/** Per-sample records are only needed to build the dossier, which is kept; drop them to save space. */
const slim = (r: DatasetResult): DatasetResult =>
  r.dossier?.series ? { ...r, dossier: { ...r.dossier, series: { ...r.dossier.series, samples: [] } } } : r;

export function newRunId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function storeRun(id: string, run: SavedRun): Promise<void> {
  const screened = run.results.filter((r) => r.screening);
  const meta: SavedRunMeta = {
    id,
    createdAt: run.manifest?.createdAt ?? new Date().toISOString(),
    intent: run.protocol.intent || run.protocol.query,
    count: screened.length,
    include: screened.filter((r) => r.screening!.decision === 'include').length,
    model: run.manifest?.scorer.model ?? screened[0]?.screening?.model ?? '',
  };
  await saveRun(meta, { ...run, results: run.results.map(slim) });
}

export const fetchRun = (id: string) => getRun<SavedRun>(id);

/** Share links carry explanations only while the URL stays reasonably short. */
const MAX_LINK_CHARS = 30_000;

export async function shareUrl(run: SavedRun, labels: Record<string, boolean>): Promise<{ url: string; withExplanations: boolean }> {
  const base = `${location.origin}${location.pathname}`;
  for (const withExplanations of [true, false]) {
    const encoded = await encodeSnapshot(makeSnapshot(run.results, run.protocol, run.input, run.manifest, labels, { explanations: withExplanations }));
    if (encoded.length <= MAX_LINK_CHARS || !withExplanations) return { url: `${base}#s=${encoded}`, withExplanations };
  }
  throw new Error('unreachable');
}

/** A full manifest for a run restored from a link (the link stores only the parts that matter). */
function manifestFrom(s: Snapshot, results: DatasetResult[]): RunManifest {
  const screened = results.filter((r) => r.screening);
  const count = (d: string) => screened.filter((r) => r.screening!.decision === d).length;
  return {
    omigator: s.manifest?.omigator ?? 'unknown',
    createdAt: s.createdAt,
    durationMs: 0,
    protocol: s.protocol,
    input: s.input,
    search: s.manifest?.search,
    removedByFilters: { organism: 0, assay: 0, samples: 0, date: 0 },
    scorer: s.manifest?.scorer ?? { id: 'unknown', model: 'unknown', snapshots: [] },
    thresholds: DEFAULT_THRESHOLDS,
    counts: {
      candidates: results.length,
      screened: screened.length,
      failed: results.length - screened.length,
      include: count('include'),
      unclear: count('unclear'),
      exclude: count('exclude'),
    },
    cost: s.manifest?.cost ?? { screening: 0, explanations: 0 },
    ncbiApiKey: false,
  };
}

export async function openShared(encoded: string, ncbi: Ncbi): Promise<SavedRun & { labels: Record<string, boolean>; manifest: RunManifest }> {
  const s = await decodeSnapshot(encoded);
  const results = await restoreSnapshot(s, ncbi);
  const labels = Object.fromEntries(Object.entries(s.labels).map(([g, v]) => [g, v === 1]));
  return { results, protocol: s.protocol, input: s.input, manifest: manifestFrom(s, results), labels };
}
