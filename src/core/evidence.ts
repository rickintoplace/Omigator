/**
 * Turns a GEO series (plus linked abstracts) into a dossier: a structured design summary for the UI
 * and a compact, deterministic text the models judge. Sample-level metadata matters: conditions,
 * controls and replicate counts are often only stated per sample, not in the series summary.
 */

import type { Candidate, ComputedLine, Design, Dossier, Paper, Sample, SampleGroup, Series } from './types.js';

const SINGLE_CELL = /\b(single[- ]cell|single[- ]nucle(?:us|i)|scRNA[- ]?seq|snRNA[- ]?seq|10x genomics|chromium|drop-?seq|in-?drop|smart-?seq\d?|cite-?seq)\b/gi;

const MISSING = '—';

/** Names of fields that usually tell replicates apart rather than conditions (donor, patient, batch …). */
const REPLICATE_NAME = /\b(donors?|patients?|subjects?|individuals?|participants?|replicates?|rep|biological rep\w*|animals?|batch(es)?|ids?)\b/i;

/**
 * Fields that number the replicates of a condition, such as "donor: Donor1 … Donor6" crossed with
 * treatment and time. Grouping by them would split every condition into groups of n = 1. A field
 * qualifies only if its name says so and, within every group of the remaining fields, each of its
 * values occurs at most once; "patient: healthy / diseased" is a condition and does not qualify.
 */
function replicateKeysOf(varying: string[], fields: Record<string, string>[]): string[] {
  const candidates = varying.filter((k) => REPLICATE_NAME.test(k));
  if (!candidates.length) return [];
  const rest = varying.filter((k) => !candidates.includes(k));
  return candidates.filter((k) => {
    const seen = new Map<string, Set<string>>();
    for (const f of fields) {
      const group = JSON.stringify(rest.map((r) => f[r] ?? MISSING));
      const values = seen.get(group) ?? new Set<string>();
      const v = f[k] ?? MISSING;
      if (values.has(v)) return false;
      values.add(v);
      seen.set(group, values);
    }
    // At least one condition must have two or more replicates, or there is nothing to pool.
    return [...seen.values()].some((v) => v.size > 1);
  });
}

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

  const replicateKeys = replicateKeysOf(varyingKeys, fields);
  const conditionKeys = varyingKeys.filter((k) => !replicateKeys.includes(k));

  const groupMap = new Map<string, SampleGroup>();
  for (const [i, f] of fields.entries()) {
    const values = Object.fromEntries(conditionKeys.map((k) => [k, f[k] ?? MISSING]));
    const id = JSON.stringify(values);
    const g = groupMap.get(id);
    if (g) {
      g.count++;
      g.gsms!.push(samples[i].gsm);
    } else groupMap.set(id, { values, count: 1, gsms: [samples[i].gsm] });
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

  const replicates = Object.fromEntries(replicateKeys.map((k) => [k, [...new Set(fields.map((f) => f[k] ?? MISSING))]]));
  return { varyingKeys: conditionKeys, groups, shared, identifierKeys, replicates, libraryStrategies, singleCellHints };
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
  const samples = series?.samples ?? [];
  const all = samples.map((s) => s.gsm);
  const lines: string[] = [];
  const computed: ComputedLine[] = [];
  const push = (label: string, value: string | undefined) => {
    if (value) lines.push(`${label}: ${value}`);
  };
  /** Lines Omigator writes itself (counts, groups, joins, scans); quotes from them are not record text. */
  const pushComputed = (line: string | undefined, gsms: string[]) => {
    if (!line) return;
    lines.push(line);
    computed.push({ text: line, gsms });
  };
  const labelled = (label: string, value: string | undefined) => (value ? `${label}: ${value}` : undefined);

  pushComputed(`GEO series ${candidate.gse} (published ${candidate.pubDate || 'unknown'})`, []);
  push('Title', series?.title || candidate.title);
  push('Series type', series?.types.join('; ') || candidate.seriesType);
  push('Organisms', candidate.organisms);
  push('Platforms', series?.platforms.join(', '));
  if (series?.superSeriesOf?.length) {
    pushComputed(labelled('SuperSeries', `bundles ${series.superSeriesOf.join(', ')}; its samples are those of these SubSeries`), []);
  }
  if (series?.subSeriesOf?.length) push('Part of SuperSeries', series.subSeriesOf.join(', '));

  const sampleLine = [`${samples.length || candidate.nSamples}`];
  if (design) {
    const strategies = counts(samples.map((s) => s.libraryStrategy));
    const molecules = counts(samples.map((s) => s.molecule));
    if (strategies) sampleLine.push(`library strategy: ${strategies}`);
    if (molecules) sampleLine.push(`molecule: ${molecules}`);
  }
  pushComputed(labelled('Samples', sampleLine.join(' · ')), all);
  push('Summary', cap(series?.summary || candidate.summary, caps.summary));
  push('Overall design', cap(series?.overallDesign, caps.design));

  if (design) {
    if (design.varyingKeys.length) {
      pushComputed('Sample groups (characteristics that differ between samples; n = number of samples):', all);
      for (const g of design.groups.slice(0, caps.groups)) {
        pushComputed(`- ${Object.entries(g.values).map(([k, v]) => `${k}: ${v}`).join(' | ')} (n=${g.count})`, g.gsms ?? []);
      }
      if (design.groups.length > caps.groups) pushComputed(`- … ${design.groups.length - caps.groups} more groups`, all);
    }
    const shared = Object.entries(design.shared).map(([k, v]) => `${k}: ${v}`).join('; ');
    pushComputed(labelled('Shared by all samples', cap(shared, 800)), all);
    for (const [k, values] of Object.entries(design.replicates ?? {})) {
      const shown = values.length > 6 ? `${values.slice(0, 6).join(', ')}, …` : values.join(', ');
      const pooled = design.varyingKeys.length ? `the groups above pool them, so n counts ${k} values` : `all samples share one condition, so n = ${values.length}`;
      pushComputed(`Replicates by ${k}: ${values.length} values (${shown}); ${pooled}`, all);
    }
    if (design.identifierKeys.length) pushComputed(labelled('Per-sample identifiers', design.identifierKeys.join(', ')), all);
    pushComputed(labelled('Sample titles', cap(samples.map((s) => s.title).join('; '), caps.titles)), all);
    pushComputed(labelled('Treatment protocol', distinctText(samples.map((s) => s.treatmentProtocol), caps.protocol)), all);
    pushComputed(labelled('Growth protocol', distinctText(samples.map((s) => s.growthProtocol), caps.protocol)), all);
    pushComputed(labelled('Single-cell indicators', design.singleCellHints.length ? design.singleCellHints.join(', ') : 'none found'), all);
  }
  push('Supplementary files', cap(series?.supplementaryFiles.join(', '), 400));

  for (const p of papers) {
    lines.push(
      `Linked publication PMID ${p.pmid}${p.journal ? ` (${p.journal}${p.year ? ` ${p.year}` : ''})` : ''}: ${p.title}`,
    );
    push('Abstract', cap(p.abstract, caps.abstract) || 'not available');
  }
  if (!series) pushComputed('Note: sample-level metadata could not be retrieved; judge from the series summary only.', []);

  return { candidate, series, design, papers, text: lines.join('\n'), computed, warnings };
}

/** One part of the original record a quote can come from. */
export interface RecordSource {
  /** "series", a GSM accession or "PMID <id>". */
  where: string;
  text: string;
}

/**
 * The record as GEO and PubMed publish it, split by where a quote can be checked: the series page,
 * each sample page (field labels as GEO shows them) and each linked abstract. Nothing computed.
 */
export function recordSources(d: Dossier): RecordSource[] {
  const s = d.series;
  const c = d.candidate;
  const join = (parts: (string | undefined | false)[]) => parts.filter(Boolean).join('\n');
  const out: RecordSource[] = [
    {
      where: 'series',
      text: join([
        s?.title || c.title,
        s?.summary || c.summary,
        s?.overallDesign,
        ...(s?.types ?? [c.seriesType]),
        c.organisms,
        ...(s?.platforms ?? []),
        ...(s?.supplementaryFiles ?? []),
      ]),
    },
  ];
  for (const x of s?.samples ?? []) {
    out.push({
      where: x.gsm,
      text: join([
        x.title,
        x.source && `Source name: ${x.source}`,
        ...Object.entries(x.characteristics).map(([k, v]) => `${k}: ${v}`),
        x.molecule && `Extracted molecule: ${x.molecule}`,
        x.libraryStrategy && `Library strategy: ${x.libraryStrategy}`,
        x.librarySource && `Library source: ${x.librarySource}`,
        x.description,
        x.treatmentProtocol,
        x.growthProtocol,
      ]),
    });
  }
  for (const p of d.papers) out.push({ where: `PMID ${p.pmid}`, text: join([p.title, p.abstract]) });
  return out;
}
