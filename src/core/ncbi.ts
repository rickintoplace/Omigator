/** NCBI E-utilities client (GEO DataSets + PubMed). Called directly; E-utilities send CORS headers. */

import { type Fetch, RateLimiter, request } from './http.js';
import type { Candidate, Filters, Paper } from './types.js';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

export interface NcbiOptions {
  /** Optional NCBI API key: raises the limit from 3 to 10 requests per second. */
  apiKey?: string;
  /** Contact address NCBI asks tools to send. */
  email?: string;
  tool?: string;
  fetch?: Fetch;
}

/** E-utilities share one limit per IP (or key); one limiter per key keeps parallel runs polite. */
const limiters = new Map<string, RateLimiter>();

export class Ncbi {
  private readonly limiter: RateLimiter;

  constructor(private readonly opts: NcbiOptions = {}) {
    const key = opts.apiKey ?? '';
    if (!limiters.has(key)) limiters.set(key, new RateLimiter(opts.apiKey ? 110 : 350));
    this.limiter = limiters.get(key)!;
  }

  get hasApiKey(): boolean {
    return Boolean(this.opts.apiKey);
  }

  private async eutils(tool: string, params: Record<string, string>, signal?: AbortSignal): Promise<Response> {
    const qs = new URLSearchParams({ ...params, tool: this.opts.tool ?? 'omigator' });
    if (this.opts.email) qs.set('email', this.opts.email);
    if (this.opts.apiKey) qs.set('api_key', this.opts.apiKey);
    await this.limiter.wait(signal);
    // POST keeps long id lists and queries out of the URL length limit.
    return request(
      `${EUTILS}/${tool}.fcgi`,
      { method: 'POST', body: qs, headers: { 'content-type': 'application/x-www-form-urlencoded' } },
      { signal, fetch: this.opts.fetch, timeoutMs: 45_000 },
    );
  }

  /** esearch on GEO DataSets; returns the total count and the first `retmax` uids. */
  async searchGds(term: string, retmax: number, signal?: AbortSignal): Promise<{ count: number; uids: string[] }> {
    const res = await this.eutils('esearch', { db: 'gds', term, retmax: String(retmax), retmode: 'json' }, signal);
    const json = await res.json();
    const r = json.esearchresult ?? {};
    if (r.ERROR) throw new Error(`NCBI search error: ${r.ERROR}`);
    return { count: Number(r.count ?? 0), uids: r.idlist ?? [] };
  }

  /** Maps GSE accessions to gds uids (GSE series only). */
  async uidsForAccessions(gses: string[], signal?: AbortSignal): Promise<string[]> {
    const out: string[] = [];
    for (let i = 0; i < gses.length; i += 100) {
      const chunk = gses.slice(i, i + 100);
      const term = `(${chunk.map((g) => `${g}[ACCN]`).join(' OR ')}) AND gse[ETYP]`;
      out.push(...(await this.searchGds(term, chunk.length * 2, signal)).uids);
    }
    return [...new Set(out)];
  }

  async summaries(uids: string[], signal?: AbortSignal): Promise<Candidate[]> {
    const out: Candidate[] = [];
    for (let i = 0; i < uids.length; i += 200) {
      const res = await this.eutils('esummary', { db: 'gds', id: uids.slice(i, i + 200).join(','), retmode: 'json' }, signal);
      const json = await res.json();
      for (const uid of json.result?.uids ?? []) {
        const d = json.result[uid];
        if (!d?.accession?.startsWith('GSE')) continue;
        out.push({
          gse: d.accession,
          uid,
          title: d.title ?? '',
          summary: d.summary ?? '',
          organisms: d.taxon ?? '',
          seriesType: d.gdstype ?? '',
          nSamples: Number(d.n_samples ?? 0),
          pubDate: d.pdat ?? '',
          pmids: (d.pubmedids ?? []).map(String),
        });
      }
    }
    return out;
  }

  async papers(pmids: string[], signal?: AbortSignal): Promise<Map<string, Paper>> {
    const out = new Map<string, Paper>();
    const unique = [...new Set(pmids)];
    for (let i = 0; i < unique.length; i += 150) {
      const res = await this.eutils('efetch', { db: 'pubmed', id: unique.slice(i, i + 150).join(','), retmode: 'xml' }, signal);
      for (const paper of parsePubmedXml(await res.text())) out.set(paper.pmid, paper);
    }
    return out;
  }
}

/** Adds the filters that E-utilities can apply server-side, so `retmax` is not spent on non-matches. */
export function buildGdsTerm(query: string, filters: Filters = {}): string {
  const parts = [`(${query.trim()})`, 'gse[ETYP]'];
  if (filters.organism?.trim()) parts.push(`"${filters.organism.trim()}"[ORGN]`);
  if (filters.minDate || filters.maxDate) {
    const min = (filters.minDate || '1900-01-01').replace(/-/g, '/');
    const max = (filters.maxDate || '3000-12-31').replace(/-/g, '/');
    parts.push(`("${min}"[PDAT] : "${max}"[PDAT])`);
  }
  return parts.join(' AND ');
}

export interface FilterReport {
  kept: Candidate[];
  removed: { organism: number; assay: number; samples: number; date: number };
}

/** Client-side check of the hard filters (also covers what the query could not express). */
export function applyFilters(candidates: Candidate[], filters: Filters = {}): FilterReport {
  const removed = { organism: 0, assay: 0, samples: 0, date: 0 };
  const org = filters.organism?.trim().toLowerCase();
  const assay = filters.assay?.trim().toLowerCase();
  const min = filters.minDate ? new Date(filters.minDate) : undefined;
  const max = filters.maxDate ? new Date(filters.maxDate) : undefined;

  const kept = candidates.filter((c) => {
    if (org && !c.organisms.toLowerCase().includes(org)) return (removed.organism++, false);
    if (assay && !c.seriesType.toLowerCase().includes(assay)) return (removed.assay++, false);
    if ((filters.minSamples ?? 0) > 0 && c.nSamples < filters.minSamples!) return (removed.samples++, false);
    if (min || max) {
      const d = new Date(c.pubDate.replace(/\//g, '-'));
      if (Number.isNaN(d.getTime()) || (min && d < min) || (max && d > max)) return (removed.date++, false);
    }
    return true;
  });
  return { kept, removed };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e] ?? m;
  });
}

const stripTags = (s: string) => decodeXml(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

export function parsePubmedXml(xml: string): Paper[] {
  const papers: Paper[] = [];
  for (const block of xml.split(/<PubmedArticle[\s>]/).slice(1)) {
    const pmid = block.match(/<PMID[^>]*>(\d+)<\/PMID>/)?.[1];
    if (!pmid) continue;
    const sections = [...block.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)].map(([, attrs, body]) => {
      const label = attrs.match(/Label="([^"]+)"/)?.[1];
      return label ? `${label}: ${stripTags(body)}` : stripTags(body);
    });
    papers.push({
      pmid,
      title: stripTags(block.match(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/)?.[1] ?? ''),
      abstract: sections.join(' '),
      journal: stripTags(block.match(/<ISOAbbreviation>([\s\S]*?)<\/ISOAbbreviation>/)?.[1] ?? ''),
      year: block.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/)?.[1] ?? '',
    });
  }
  return papers;
}
