/** Protocols: what a run looks for. Drafted from one sentence of intent, then edited by the user. */

import { type Endpoint, chat, parseJsonObject } from './llm';
import type { Criterion, CriterionKind, Filters, Protocol } from './types';

const KINDS: CriterionKind[] = ['require', 'exclude', 'prefer'];

export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'criterion'
  );
}

/** Normalizes criteria: valid kinds, non-empty text, unique snake_case ids. */
export function normalizeCriteria(raw: unknown): Criterion[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Criterion[] = [];
  for (const item of raw) {
    const text = String(item?.text ?? '').trim();
    if (!text) continue;
    const kind: CriterionKind = KINDS.includes(item?.kind) ? item.kind : 'require';
    let id = slug(String(item?.id ?? '') || text);
    for (let n = 2; seen.has(id); n++) id = `${slug(String(item?.id ?? '') || text)}_${n}`;
    seen.add(id);
    out.push({ id, kind, text });
  }
  return out;
}

const DRAFT_SYSTEM = `You help researchers find public gene-expression datasets in NCBI GEO.
Turn the researcher's intent into a screening protocol. Reply with one JSON object:
{
  "query": "NCBI GEO DataSets search term",
  "filters": { "organism": "Homo sapiens" | "" , "assay": "high throughput sequencing" | "array" | "", "minSamples": number },
  "criteria": [ { "id": "snake_case", "kind": "require" | "exclude" | "prefer", "text": "..." } ]
}
Rules for "query":
- Boolean Entrez syntax. Group synonyms with OR in parentheses, combine concepts with AND,
  quote multi-word phrases: (hypoxia OR hypoxic OR anoxia OR "low oxygen") AND (RNA-seq OR transcriptome).
- Aim for high recall: include common synonyms, abbreviations and gene/protein aliases.
- Do NOT put organism, dataset type or dates in the query; they go into "filters".
Rules for "criteria" (3 to 7):
- Each criterion is ONE checkable statement about a GEO series, decidable from its title, summary,
  design, sample characteristics, protocols and linked abstract.
- Phrase every criterion as a positive statement that is TRUE when it applies, e.g.
  "The samples are human cells cultured in vitro." For "exclude", state the disqualifying property
  ("The dataset is single-cell RNA-seq."), never a negation.
- "require": must hold. "exclude": disqualifies. "prefer": only improves ranking.
- Do not invent requirements the researcher did not ask for; put plausible extras under "prefer".
Write the criteria in English even if the intent is in another language.`;

export interface DraftResult {
  protocol: Protocol;
  model: string;
  cost: number;
}

export async function draftProtocol(intent: string, ep: Endpoint, model: string, signal?: AbortSignal): Promise<DraftResult> {
  const res = await chat(
    ep,
    {
      model,
      messages: [
        { role: 'system', content: DRAFT_SYSTEM },
        { role: 'user', content: `Researcher's intent:\n${intent.trim()}` },
      ],
      json: true,
      temperature: 0,
    },
    { signal },
  );
  const json = parseJsonObject<{ query?: string; filters?: Filters; criteria?: unknown }>(res.content);
  const filters: Filters = {};
  if (json.filters?.organism) filters.organism = String(json.filters.organism);
  if (json.filters?.assay) filters.assay = String(json.filters.assay);
  if (Number(json.filters?.minSamples) > 0) filters.minSamples = Number(json.filters!.minSamples);
  const criteria = normalizeCriteria(json.criteria);
  if (!json.query || !criteria.length) throw new Error('The model did not return a usable protocol. Try again or edit by hand.');
  return { protocol: { intent, query: String(json.query), filters, criteria }, model: res.model, cost: res.cost };
}

export interface Preset {
  name: string;
  protocol: Protocol;
}

export const PRESETS: Preset[] = [
  {
    name: 'Hypoxia vs normoxia (benchmark)',
    protocol: {
      intent:
        'Bulk RNA-seq datasets of human cells cultured in vitro that compare hypoxia (reduced oxygen) with normoxia, for a meta-analysis.',
      query: 'hypoxia[Description] AND "expression profiling by high throughput sequencing"[DataSet Type]',
      filters: { organism: 'Homo sapiens', assay: 'high throughput sequencing', minSamples: 4, maxDate: '2021-02-11' },
      criteria: [
        { id: 'bulk_rnaseq', kind: 'require', text: 'The dataset contains bulk RNA-seq expression profiling (not only single-cell RNA-seq, not only ChIP/ATAC/other non-expression assays).' },
        { id: 'human_in_vitro', kind: 'require', text: 'The dataset includes human cells cultured in vitro (cell lines or primary cells).' },
        { id: 'hypoxia_low_o2', kind: 'require', text: 'Cells were exposed to hypoxia or anoxia by reduced oxygen tension (not only chemical hypoxia mimetics such as DMOG, CoCl2 or FG-4592, and not only intermittent/cyclic hypoxia).' },
        { id: 'normoxia_control', kind: 'require', text: 'The design includes a normoxia or baseline-oxygen control condition to compare against hypoxia.' },
      ],
    },
  },
  {
    name: 'Tumor vs matched normal tissue',
    protocol: {
      intent: 'Bulk RNA-seq of human primary tumors with matched adjacent normal tissue from the same patients.',
      query: '(tumor OR tumour OR carcinoma OR cancer) AND (normal OR adjacent OR "non-tumor" OR paired OR matched)',
      filters: { organism: 'Homo sapiens', assay: 'high throughput sequencing', minSamples: 10 },
      criteria: [
        { id: 'bulk_rnaseq', kind: 'require', text: 'The dataset contains bulk RNA-seq expression profiling.' },
        { id: 'primary_tumor', kind: 'require', text: 'The samples include human primary tumor tissue from patients.' },
        { id: 'matched_normal', kind: 'require', text: 'Normal or adjacent non-tumor tissue from the same patients is included as a control.' },
        { id: 'cell_lines_only', kind: 'exclude', text: 'All samples are cell lines, organoids or xenografts rather than patient tissue.' },
        { id: 'large_cohort', kind: 'prefer', text: 'The dataset includes at least 20 patients.' },
      ],
    },
  },
];
