import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  aggregate,
  applyFilters,
  buildDossier,
  buildGdsTerm,
  type Candidate,
  conformalCutoff,
  type Criterion,
  familyFileUrl,
  fitPlatt,
  inferDesign,
  normalizeCriteria,
  normalizeGseList,
  parseJsonObject,
  parsePubmedXml,
  plattProbability,
  rankingMetrics,
  recallEstimate,
  seriesFromSoft,
  yesProbability,
} from '../src/core';

const soft = readFileSync(new URL('./fixtures/GSE52695_family.soft', import.meta.url), 'utf8');
const pubmed = readFileSync(new URL('./fixtures/pubmed_25351346.xml', import.meta.url), 'utf8');

const candidate: Candidate = {
  gse: 'GSE52695',
  uid: '200052695',
  title: 'RNA-seq analysis of Hypoxia and Normoxia cultured cancer cells',
  summary: '',
  organisms: 'Homo sapiens',
  seriesType: 'Expression profiling by high throughput sequencing',
  nSamples: 24,
  pubDate: '2016/10/20',
  pmids: ['25351346'],
};

describe('GEO SOFT', () => {
  const series = seriesFromSoft(soft, 'GSE52695', 'ftp');

  it('parses series fields and all samples', () => {
    expect(series.title).toMatch(/Hypoxia and Normoxia/);
    expect(series.overallDesign).toMatch(/A2780/);
    expect(series.pmids).toEqual(['25351346']);
    expect(series.subSeriesOf).toEqual(['GSE52744']);
    expect(series.superSeriesOf).toEqual([]);
    expect(series.samples).toHaveLength(24);
    expect(series.samples[0].libraryStrategy).toBe('RNA-Seq');
    expect(series.samples[0].characteristics['cell line']).toMatch(/A2780/);
  });

  it('infers the sample design from varying characteristics', () => {
    const d = inferDesign(series);
    expect(d.varyingKeys).toEqual(expect.arrayContaining(['stress', 'time']));
    expect(d.shared['tissue of origin']).toBe('Ovarian cancer');
    expect(d.groups.reduce((s, g) => s + g.count, 0)).toBe(24);
    expect(d.groups.some((g) => g.values.stress === 'Hypoxia')).toBe(true);
    expect(d.singleCellHints).toEqual([]);
  });

  it('renders a dossier with groups, protocols and the abstract', () => {
    const papers = parsePubmedXml(pubmed);
    const dossier = buildDossier(candidate, series, papers);
    expect(dossier.text).toContain('Sample groups');
    expect(dossier.text).toMatch(/stress: control/);
    expect(dossier.text).toMatch(/1% O2/);
    expect(dossier.text).toContain('Linked publication PMID 25351346');
    expect(dossier.text).toContain('Part of SuperSeries: GSE52744');
    expect(dossier.text.length).toBeLessThan(12_000);
  });

  it('builds FTP family file URLs', () => {
    expect(familyFileUrl('GSE52695')).toBe('https://ftp.ncbi.nlm.nih.gov/geo/series/GSE52nnn/GSE52695/soft/GSE52695_family.soft.gz');
    expect(familyFileUrl('GSE123')).toBe('https://ftp.ncbi.nlm.nih.gov/geo/series/GSEnnn/GSE123/soft/GSE123_family.soft.gz');
  });
});

describe('NCBI helpers', () => {
  it('parses PubMed XML', () => {
    const [p] = parsePubmedXml(pubmed);
    expect(p.pmid).toBe('25351346');
    expect(p.title.length).toBeGreaterThan(10);
    expect(p.abstract.length).toBeGreaterThan(100);
    expect(p.year).toMatch(/^\d{4}$/);
  });

  it('adds filters to the search term', () => {
    expect(buildGdsTerm('hypoxia', { organism: 'Homo sapiens', maxDate: '2021-02-11' })).toBe(
      '(hypoxia) AND gse[ETYP] AND "Homo sapiens"[ORGN] AND ("1900/01/01"[PDAT] : "2021/02/11"[PDAT])',
    );
  });

  it('applies hard filters and counts removals', () => {
    const r = applyFilters(
      [candidate, { ...candidate, gse: 'GSE2', organisms: 'Mus musculus' }, { ...candidate, gse: 'GSE3', nSamples: 2 }],
      { organism: 'homo sapiens', minSamples: 4 },
    );
    expect(r.kept.map((c) => c.gse)).toEqual(['GSE52695']);
    expect(r.removed).toMatchObject({ organism: 1, samples: 1 });
  });

  it('normalizes GSE lists', () => {
    expect(normalizeGseList('gse1, GSE22 https://…acc=GSE1')).toEqual(['GSE1', 'GSE22']);
  });
});

describe('decision logic', () => {
  const criteria: Criterion[] = [
    { id: 'a', kind: 'require', text: 'A' },
    { id: 'b', kind: 'require', text: 'B' },
    { id: 'sc', kind: 'exclude', text: 'single cell' },
    { id: 'big', kind: 'prefer', text: 'large' },
  ];

  it('includes when all requirements are met and no exclusion applies', () => {
    const r = aggregate(criteria, { a: 0.9, b: 0.8, sc: 0.1, big: 0.3 });
    expect(r.decision).toBe('include');
    expect(r.tags).toEqual(['a', 'b']);
  });

  it('marks borderline datasets unclear and clear failures excluded', () => {
    expect(aggregate(criteria, { a: 0.9, b: 0.4, sc: 0.1, big: 0.9 }).decision).toBe('unclear');
    expect(aggregate(criteria, { a: 0.9, b: 0.1, sc: 0.1, big: 0.9 }).decision).toBe('exclude');
    expect(aggregate(criteria, { a: 0.9, b: 0.9, sc: 0.95, big: 0.9 }).decision).toBe('exclude');
  });

  it('ranks by summed log-probabilities; prefer criteria only refine the order', () => {
    const base = { a: 0.99, b: 0.99, sc: 0.01 };
    expect(aggregate(criteria, { ...base, big: 0.9 }).logScore).toBeGreaterThan(aggregate(criteria, { ...base, big: 0.1 }).logScore);
    const unmetPreference = aggregate(criteria, { ...base, big: 0.01 });
    const doubtfulRequirement = aggregate(criteria, { ...base, b: 0.3, big: 0.99 });
    expect(unmetPreference.logScore).toBeGreaterThan(doubtfulRequirement.logScore);
  });

  it('normalizes drafted criteria', () => {
    const c = normalizeCriteria([{ text: 'Human cells', kind: 'bogus' }, { id: 'x', text: 'X' }, { id: 'x', text: 'Y' }, { text: '' }]);
    expect(c).toEqual([
      { id: 'human_cells', kind: 'require', text: 'Human cells' },
      { id: 'x', kind: 'require', text: 'X' },
      { id: 'x_2', kind: 'require', text: 'Y' },
    ]);
  });
});

describe('model output parsing', () => {
  it('reads P(yes) from top logprobs, skipping non-answer tokens', () => {
    const tok = (pairs: [string, number][]) => ({ top: pairs.map(([token, p]) => ({ token, logprob: Math.log(p) })) });
    expect(yesProbability([tok([['Answer', 0.9]]), tok([[' Yes', 0.6], [' No', 0.3], ['yes', 0.05]])])).toBeCloseTo(0.65 / 0.95);
    expect(() => yesProbability([tok([['Maybe', 0.9]])])).toThrow();
  });

  it('extracts JSON objects from fenced or chatty output', () => {
    expect(parseJsonObject('Sure:\n```json\n{"a": "x}", "b": {"c": 1}}\n```')).toEqual({ a: 'x}', b: { c: 1 } });
  });
});

describe('metrics and calibration', () => {
  const items = [
    { id: '1', score: 0.9, positive: true },
    { id: '2', score: 0.8, positive: false },
    { id: '3', score: 0.7, positive: true },
    { id: '4', score: 0.1, positive: false },
  ];

  it('computes ranking metrics', () => {
    const m = rankingMetrics(items, [1, 2]);
    expect(m.auroc).toBeCloseTo(0.75);
    expect(m.averagePrecision).toBeCloseTo((1 + 2 / 3) / 2);
    expect(m.precisionAt[2]).toBe(0.5);
    expect(m.readFor95).toBe(3);
  });

  it('fits a monotone Platt model', () => {
    const m = fitPlatt([-5, -4, -3, -1, 0, 1, 2], [false, false, false, true, false, true, true])!;
    expect(plattProbability(m, 2)).toBeGreaterThan(plattProbability(m, -4));
  });

  it('gives a conformal cutoff only with enough positives', () => {
    expect(conformalCutoff([1, 2, 3], 0.05).guaranteed).toBe(false);
    const scores = Array.from({ length: 39 }, (_, i) => i);
    expect(conformalCutoff(scores, 0.05)).toMatchObject({ guaranteed: true, cutoff: 1 });
    expect(recallEstimate([1, 2, 3, 4], 2.5).recall).toBe(0.5);
  });
});
