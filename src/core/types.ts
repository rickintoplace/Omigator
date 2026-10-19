/** Shared data model. Everything in `core/` runs unchanged in the browser and in Node. */

export type Decision = 'include' | 'unclear' | 'exclude';

/**
 * - `require`: must hold for the dataset to be eligible.
 * - `exclude`: disqualifies the dataset when it holds.
 * - `prefer`: nice to have; only moves the ranking.
 */
export type CriterionKind = 'require' | 'exclude' | 'prefer';

export interface Criterion {
  /** Short snake_case id, also used as tag. */
  id: string;
  kind: CriterionKind;
  /** One checkable statement about the dataset, phrased so that "true" means the statement holds. */
  text: string;
}

export interface Filters {
  /** Substring match against the organisms GEO lists for the series (e.g. "Homo sapiens"). */
  organism?: string;
  /** Substring match against the GEO series type (e.g. "high throughput sequencing"). */
  assay?: string;
  minSamples?: number;
  /** ISO dates (YYYY-MM-DD), compared with the GEO publication date. */
  minDate?: string;
  maxDate?: string;
}

/** Everything that defines *what* a run looks for. Serializable; stored in the manifest. */
export interface Protocol {
  intent: string;
  query: string;
  filters: Filters;
  criteria: Criterion[];
}

/** One GEO series as returned by E-utilities esummary (db=gds). */
export interface Candidate {
  gse: string;
  uid: string;
  title: string;
  summary: string;
  organisms: string;
  seriesType: string;
  nSamples: number;
  /** YYYY/MM/DD as reported by GEO. */
  pubDate: string;
  pmids: string[];
}

export interface Sample {
  gsm: string;
  title: string;
  source: string;
  organisms: string[];
  characteristics: Record<string, string>;
  libraryStrategy?: string;
  librarySource?: string;
  molecule?: string;
  description?: string;
  treatmentProtocol?: string;
  growthProtocol?: string;
}

export interface Series {
  gse: string;
  title: string;
  summary: string;
  overallDesign: string;
  types: string[];
  pmids: string[];
  platforms: string[];
  supplementaryFiles: string[];
  /** GEO SuperSeries bundle other series; their samples are duplicates of the SubSeries' samples. */
  superSeriesOf: string[];
  subSeriesOf: string[];
  samples: Sample[];
  /** Where the record came from: the GEO FTP family file or the GEO web endpoint. */
  origin: 'ftp' | 'web';
}

export interface Paper {
  pmid: string;
  title: string;
  abstract: string;
  journal: string;
  year: string;
}

/** A group of samples that share the values of all characteristics that vary within the series. */
export interface SampleGroup {
  values: Record<string, string>;
  count: number;
}

export interface Design {
  varyingKeys: string[];
  groups: SampleGroup[];
  shared: Record<string, string>;
  /** Keys whose value differs for (almost) every sample, e.g. donor ids. Listed, not grouped. */
  identifierKeys: string[];
  libraryStrategies: Record<string, number>;
  singleCellHints: string[];
}

/** All evidence about one dataset, structured for display and rendered as text for the models. */
export interface Dossier {
  candidate: Candidate;
  series?: Series;
  design?: Design;
  papers: Paper[];
  text: string;
  warnings: string[];
}

export interface Screening {
  /** Probability per criterion id that the criterion's statement holds. */
  p: Record<string, number>;
  /** Sum of log-probabilities; the ranking key. */
  logScore: number;
  /** Product of the probabilities of eligibility (uncalibrated model probability). */
  eligibility: number;
  decision: Decision;
  tags: string[];
  /** Model snapshot that served the request. */
  model: string;
  cost: number;
}

export type Verdict = 'yes' | 'no' | 'unclear';

export interface QuoteCheck {
  text: string;
  /** VeriQuote match score against the dossier text: 1 = literal hit. */
  score: number;
  verified: boolean;
}

export interface CriterionExplanation {
  verdict: Verdict;
  quotes: QuoteCheck[];
  note?: string;
  /** True when the explanation contradicts the screening probability. */
  disagrees: boolean;
}

export interface Explanation {
  summary: string;
  criteria: Record<string, CriterionExplanation>;
  model: string;
  cost: number;
}

export interface DatasetResult {
  gse: string;
  candidate: Candidate;
  dossier?: Dossier;
  screening?: Screening;
  explanation?: Explanation;
  error?: string;
  /** GEO SuperSeries relation, kept when the dossier is not (restored or shared runs). */
  superSeriesOf?: string[];
}
