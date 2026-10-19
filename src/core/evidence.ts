/**
 * Turns a GEO series (plus linked abstracts) into a dossier: a structured design summary for the UI
 * and a compact, deterministic text the models judge. Sample-level metadata matters: conditions,
 * controls and replicate counts are often only stated per sample, not in the series summary.
 */

import type { Candidate, Design, Dossier, Paper, Sample, SampleGroup, Series } from './types';

const SINGLE_CELL = /\b(single[- ]cell|single[- ]nucle(?:us|i)|scRNA[- ]?seq|snRNA[- ]?seq|10x genomics|chromium|drop-?seq|in-?drop|smart-?seq\d?|cite-?seq)\b/gi;

const MISSING = '—';

/**
 * Fields a sample is grouped by. The library type comes first: series that mix assays (RNA-seq with
 * miRNA-seq, ChIP-seq or RIP-seq) must not count one RNA-seq and one miRNA-seq library as two
 * replicates of the same condition.
 */
function sampleFields(s: Sample): Record<string, string> {
  const library = [s.libraryStrategy, s.molecule].filter(Boolean).join(', ');
  return { ...(library ? { library } : {}), ...(s.source ? { 'source name': s.source } : {}), ...s.characteristics };
}

export function inferDesign(series: Series): Design {
  const samples = series.samples;
  const n = samples.length;
  const fields = samples.map(sampleFields);
  const keys = [...new Set(fields.flatMap((f) => Object.keys(f)))];

  const shared: Record<string, string> = {};
  const varyingKeys: string[] = [];
  const identifierKeys: string[] = [];
  for (const key of keys) {
    const values = fields.map((f) => f[key] ?? MISSING);
    const distinct = new Set(values);
    if (distinct.size === 1) {
      if (values[0] !== MISSING) shared[key] = values[0];
    } else if (n >= 6 && distinct.size >= 0.8 * n) {
      identifierKeys.push(key);
    } else {
      varyingKeys.push(key);
    }
  }

  const groupMap = new Map<string, SampleGroup>();
  for (const f of fields) {
    const values = Object.fromEntries(varyingKeys.map((k) => [k, f[k] ?? MISSING]));
    const id = JSON.stringify(values);
    const g = groupMap.get(id);
    if (g) g.count++;
    else groupMap.set(id, { values, count: 1 });
  }
  const groups = [...groupMap.values()].sort((a, b) => b.count - a.count);

  const libraryStrategies: Record<string, number> = {};
  for (const s of samples) {
    const label = [s.libraryStrategy, s.librarySource?.toLowerCase().includes('single cell') ? '(single cell)' : '']
      .filter(Boolean)
      .join(' ');
    if (label) libraryStrategies[label] = (libraryStrategies[label] ?? 0) + 1;
  }

  const haystack = [
    series.title,
    series.summary,
    series.overallDesign,
    ...samples.flatMap((s) => [s.title, s.description ?? '', s.librarySource ?? '', s.treatmentProtocol ?? '']),
    ...series.supplementaryFiles,
  ].join(' \n ');
  const singleCellHints = [...new Set([...haystack.matchAll(SINGLE_CELL)].map((m) => m[0].toLowerCase()))];

  return { varyingKeys, groups, shared, identifierKeys, libraryStrategies, singleCellHints };
}

const cap = (s: string | undefined, n: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

const counts = (values: (string | undefined)[]) => {
  const c: Record<string, number> = {};
  for (const v of values) if (v) c[v] = (c[v] ?? 0) + 1;
  return Object.entries(c)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ×${v}`)
    .join(', ');
};

/** Distinct values, in order of first appearance, joined; protocols repeat across samples. */
const distinctText = (values: (string | undefined)[], max: number) =>
  cap([...new Set(values.filter(Boolean))].join(' | '), max);

export interface DossierCaps {
  summary: number;
  design: number;
  groups: number;
  titles: number;
  protocol: number;
  abstract: number;
  /** Include sample-level metadata (groups, protocols, titles). Off only for ablations. */
  samples: boolean;
}

export const DEFAULT_CAPS: DossierCaps = { summary: 2000, design: 1500, groups: 30, titles: 1200, protocol: 700, abstract: 2500, samples: true };

export function buildDossier(
  candidate: Candidate,
  series: Series | undefined,
  papers: Paper[],
  warnings: string[] = [],
  caps: DossierCaps = DEFAULT_CAPS,
): Dossier {
  const design = caps.samples && series?.samples.length ? inferDesign(series) : undefined;
  const lines: string[] = [];
  const push = (label: string, value: string | undefined) => {
    if (value) lines.push(`${label}: ${value}`);
  };

  lines.push(`GEO series ${candidate.gse} (published ${candidate.pubDate || 'unknown'})`);
  push('Title', series?.title || candidate.title);
  push('Series type', series?.types.join('; ') || candidate.seriesType);
  push('Organisms', candidate.organisms);
  push('Platforms', series?.platforms.join(', '));
  if (series?.superSeriesOf?.length) {
    push('SuperSeries', `bundles ${series.superSeriesOf.join(', ')}; its samples are those of these SubSeries`);
  }
  if (series?.subSeriesOf?.length) push('Part of SuperSeries', series.subSeriesOf.join(', '));

  const samples = series?.samples ?? [];
  const sampleLine = [`${samples.length || candidate.nSamples}`];
  if (design) {
    const strategies = counts(samples.map((s) => s.libraryStrategy));
    const molecules = counts(samples.map((s) => s.molecule));
    if (strategies) sampleLine.push(`library strategy: ${strategies}`);
    if (molecules) sampleLine.push(`molecule: ${molecules}`);
  }
  push('Samples', sampleLine.join(' · '));
  push('Summary', cap(series?.summary || candidate.summary, caps.summary));
  push('Overall design', cap(series?.overallDesign, caps.design));

  if (design) {
    if (design.varyingKeys.length) {
      lines.push('Sample groups (characteristics that differ between samples; n = number of samples):');
      for (const g of design.groups.slice(0, caps.groups)) {
        lines.push(`- ${Object.entries(g.values).map(([k, v]) => `${k}: ${v}`).join(' | ')} (n=${g.count})`);
      }
      if (design.groups.length > caps.groups) lines.push(`- … ${design.groups.length - caps.groups} more groups`);
    }
    const shared = Object.entries(design.shared).map(([k, v]) => `${k}: ${v}`).join('; ');
    push('Shared by all samples', cap(shared, 800));
    if (design.identifierKeys.length) push('Per-sample identifiers', design.identifierKeys.join(', '));
    push('Sample titles', cap(samples.map((s) => s.title).join('; '), caps.titles));
    push('Treatment protocol', distinctText(samples.map((s) => s.treatmentProtocol), caps.protocol));
    push('Growth protocol', distinctText(samples.map((s) => s.growthProtocol), caps.protocol));
    push('Single-cell indicators', design.singleCellHints.length ? design.singleCellHints.join(', ') : 'none found');
  }
  push('Supplementary files', cap(series?.supplementaryFiles.join(', '), 400));

  for (const p of papers) {
    lines.push(
      `Linked publication PMID ${p.pmid}${p.journal ? ` (${p.journal}${p.year ? ` ${p.year}` : ''})` : ''}: ${p.title}`,
    );
    push('Abstract', cap(p.abstract, caps.abstract) || 'not available');
  }
  if (!series) lines.push('Note: sample-level metadata could not be retrieved; judge from the series summary only.');

  return { candidate, series, design, papers, text: lines.join('\n'), warnings };
}
