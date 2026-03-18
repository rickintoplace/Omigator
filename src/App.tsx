import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  Search, Filter, Database, Play, Square, Download, AlertCircle,
  CheckCircle2, XCircle, HelpCircle, ChevronRight, ChevronDown,
  Key, Tag, Terminal, BarChart2, Github, ExternalLink, Quote, Copy, X
} from 'lucide-react';

import omigatorLogo from './assets/omigator-logo.svg';

import {
  searchGeo,
  fetchGeoSummaries,
  fetchPubMedAbstract,
  fetchGeoDesignAndPrimaryPmid,
  GeoResult,
  gseListToGdsIdsBatch
} from './services/ncbi';

import { evaluateDataset, LlmStrategy } from './services/llm';

import { ParticleLogo } from './components/ParticleLogo';
import omigatorLogoPng from "./assets/omigator-logo.png";

type Status = 'idle' | 'searching' | 'fetching_metadata' | 'llm_scoring' | 'done' | 'error';

interface LogEntry {
  time: string;
  msg: string;
}

interface EvalRun {
  id: string;
  date: string;
  query: string;
  llmPrompt: string;
  modelUsed: string;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  f1: number;
  tpIds?: string[];
  fpIds?: string[];
  fnIds?: string[];
  tnIds?: string[];
}

const version = __APP_VERSION__;

// --- Project links ---
const GITHUB_URL = "https://github.com/rickintoplace/Omigator";
const ISSUES_URL = "https://github.com/rickintoplace/Omigator/issues";
const RELEASE_URL = `https://github.com/rickintoplace/Omigator/releases/tag/v${__APP_VERSION__}`;
const DOI_URL = "https://doi.org/10.5281/zenodo.19020074";

// --- Citation metadata (keep minimal + correct) ---
const TOOL_TITLE = "Omigator: LLM-driven dataset scouting and selection for NCBI GEO";
const AUTHORS_APA = "Heilmann, E.";
const YEAR = "2026";

const bestPersistentUrl = DOI_URL || GITHUB_URL;

const CITATION_APA = `${AUTHORS_APA} (${YEAR}). ${TOOL_TITLE} (Version ${version}) [Computer software]. ${bestPersistentUrl}`;
const DOI_ID = DOI_URL ? DOI_URL.replace(/^https?:\/\/doi\.org\//, "") : "";
const CITATION_BIBTEX = `@software{omigator_${YEAR},
  title        = {${TOOL_TITLE}},
  author       = {Heilmann, Eirik},
  year         = {${YEAR}},
  version      = {${version}},
  url          = {${GITHUB_URL}}${DOI_ID ? `,\n  doi          = {${DOI_ID}}` : ""}
}`;

type CiteFormat = 'apa' | 'bibtex' | 'doi' | 'repo';

  async function runWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, idx: number) => Promise<R>
  ): Promise<R[]> {
    const results: R[] = new Array(items.length) as any;
    let nextIndex = 0;

    async function runner() {
      while (true) {
        const i = nextIndex++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    }

    const workers = Array.from({ length: Math.max(1, concurrency) }, () => runner());
    await Promise.all(workers);
    return results;
  }

export default function App() {
  // two keys + strategy
  const [saiaKey, setSaiaKey] = useState('');
  const [openRouterKey, setOpenRouterKey] = useState('');
  const [llmStrategy, setLlmStrategy] = useState<LlmStrategy>('saia_then_openrouter');

  const [inputMode, setInputMode] = useState<'search' | 'manual'>('search');
  const [query, setQuery] = useState('breast cancer RNA-seq tumor normal');
  const [manualInput, setManualInput] = useState('');
  const [maxResults, setMaxResults] = useState(5);

  const [organism, setOrganism] = useState('Homo sapiens');
  const [assay, setAssay] = useState('high throughput sequencing');
  const [minSamples, setMinSamples] = useState(10);
  const [minDate, setMinDate] = useState('');
  const [maxDate, setMaxDate] = useState('');

  const [llmPrompt, setLlmPrompt] = useState(
    'Find bulk RNA-seq datasets that directly compare primary tumor vs matched normal tissue in humans. Exclude single-cell and cell line-only studies. Prefer larger cohorts and clear case/control design.'
  );
  const [expectedTags, setExpectedTags] = useState(
    'bulk_rnaseq, tumor_normal, matched_pairs, cohort, clinical'
  );

  const [isEvalMode, setIsEvalMode] = useState(false);
  const [goldStandardInput, setGoldStandardInput] = useState('');
  const [evalHistory, setEvalHistory] = useState<EvalRun[]>([]);

  const [status, setStatus] = useState<Status>('idle');
  const [progressMsg, setProgressMsg] = useState('');
  const [results, setResults] = useState<GeoResult[]>([]);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<'scout' | 'eval'>('scout');
  const [evaluatingId, setEvaluatingId] = useState<string | null>(null);

  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  // NEW: cite modal state
  const [showCite, setShowCite] = useState(false);
  const [citeFormat, setCiteFormat] = useState<CiteFormat>('apa');

  useEffect(() => {
    const saved = localStorage.getItem('omigator_eval_history');
    if (saved) {
      try {
        setEvalHistory(JSON.parse(saved));
      } catch (e) {
        console.error("Failed to parse eval history", e);
      }
    }
  }, []);

  const addLog = (msg: string) => {
    setLogs(prev => [...prev, { time: new Date().toLocaleTimeString(), msg }]);
  };

  const getCiteText = (): string => {
    switch (citeFormat) {
      case 'apa': return CITATION_APA;
      case 'bibtex': return CITATION_BIBTEX;
      case 'doi': return DOI_URL || "(No DOI available yet)";
      case 'repo': return GITHUB_URL;
      default: return CITATION_APA;
    }
  };

  const copyCite = async () => {
    const txt = getCiteText();
    try {
      await navigator.clipboard.writeText(txt);
      addLog(`Copied ${citeFormat.toUpperCase()} citation to clipboard.`);
    } catch {
      addLog("Failed to copy citation (clipboard permissions).");
    }
  };

  useEffect(() => {
    if (showLogs && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, showLogs]);

  const toggleRow = (id: string) => {
    const newExpanded = new Set(expandedRows);
    if (newExpanded.has(id)) newExpanded.delete(id);
    else newExpanded.add(id);
    setExpandedRows(newExpanded);
  };

  const toggleTagFilter = (tag: string) => {
    const newTags = new Set(selectedTags);
    if (newTags.has(tag)) newTags.delete(tag);
    else newTags.add(tag);
    setSelectedTags(newTags);
  };

  const handleStop = () => {
    abortRef.current = true;
    abortControllerRef.current?.abort();
    addLog('Stop requested by user...');
  };

  const clearEvalHistory = () => {
    if (window.confirm("Are you sure you want to clear the evaluation history?")) {
      setEvalHistory([]);
      localStorage.removeItem('omigator_eval_history');
    }
  };

  const handleRun = async () => {
    abortRef.current = false;
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    let scoredDatasets: GeoResult[] = [];
    let lastModelUsed = 'Unknown';

    try {
      setStatus('searching');
      setResults([]);
      setLogs([]);
      setActiveTab('scout');

      let ids: string[] = [];
      if (inputMode === 'manual') {
        addLog('Parsing manual input for GSE IDs...');

        const matches = manualInput.match(/GSE\d+/gi) ?? [];
        const gses: string[] = Array.from(new Set<string>(matches.map(m => m.toUpperCase())));

        addLog(`Found ${gses.length} unique GSE IDs in manual input. Mapping to GDS IDs (batched)...`);
        ids = await gseListToGdsIdsBatch(gses, signal);
        addLog(`Mapped to ${ids.length} GDS IDs.`);
        addLog(`Found ${gses.length} unique GSE IDs in manual input, mapped to ${ids.length} GDS IDs.`);
      } else {
        addLog(`Starting run with query: "${query}", maxResults: ${maxResults}, minDate: ${minDate || 'any'}, maxDate: ${maxDate || 'any'}`);
        setProgressMsg('Querying NCBI E-utilities...');
        ids = await searchGeo(query, maxResults, minDate, maxDate, signal);
        addLog(`NCBI Search returned ${ids.length} GSE IDs.`);
      }

      if (ids.length === 0) {
        setStatus('done');
        setProgressMsg('No results found.');
        addLog('Run finished: No results found.');
        return;
      }

      if (abortRef.current) throw new Error('Aborted by user');

      setStatus('fetching_metadata');
      setProgressMsg(`Fetching metadata for ${ids.length} datasets...`);
      addLog(`Fetching summaries for ${ids.length} datasets in chunks...`);
      let datasets = await fetchGeoSummaries(ids, signal);
      addLog(`Successfully fetched metadata for ${datasets.length} datasets.`);

      if (abortRef.current) throw new Error('Aborted by user');

      // Hard Filters
      addLog(`Applying hard filters: Organism="${organism}", Assay="${assay}", MinSamples=${minSamples}, MinDate=${minDate}, MaxDate=${maxDate}`);
      let orgFiltered = 0;
      let assayFiltered = 0;
      let sampleFiltered = 0;
      let dateFiltered = 0;

      datasets = datasets.filter(d => {
        const dOrg = String(d.organism || '').toLowerCase();
        const dAssay = String(d.assay || '').toLowerCase();

        if (organism && !dOrg.includes(organism.toLowerCase())) { orgFiltered++; return false; }
        if (assay && !dAssay.includes(assay.toLowerCase())) { assayFiltered++; return false; }
        if (minSamples > 0 && d.n_samples < minSamples) { sampleFiltered++; return false; }

        if (minDate || maxDate) {
          if (!d.pubDate || d.pubDate === 'Unknown') { dateFiltered++; return false; }
          const dDate = new Date(d.pubDate);
          if (isNaN(dDate.getTime())) { dateFiltered++; return false; }
          if (minDate && dDate < new Date(minDate)) { dateFiltered++; return false; }
          if (maxDate && dDate > new Date(maxDate)) { dateFiltered++; return false; }
        }
        return true;
      });

      addLog(`Filter results: Removed ${orgFiltered} by Organism, ${assayFiltered} by Assay, ${sampleFiltered} by Min Samples, ${dateFiltered} by Date.`);
      addLog(`${datasets.length} datasets passed hard filters.`);

      if (datasets.length === 0) {
        setStatus('done');
        setProgressMsg('All results filtered out by hard filters.');
        addLog('Run finished: All datasets were removed by hard filters.');
        return;
      }

      if (abortRef.current) throw new Error('Aborted by user');

      setResults(datasets);
      setStatus('llm_scoring');

      addLog(`Starting context fetch + LLM pipeline for ${datasets.length} datasets ...`);

      if (!saiaKey.trim() && !openRouterKey.trim()) {
        throw new Error("Please enter a SAIA API key and/or an OpenRouter API key.");
      }

      const CONCURRENCY = 3; // best UX: 2–4 (NCBI rate limits + provider quotas)

      // process each dataset: context -> LLM
      const scoredByIndex = await runWithConcurrency(datasets, CONCURRENCY, async (d, i) => {
        if (abortRef.current) throw new Error('Aborted by user');

        setEvaluatingId(d.gseId);
        setProgressMsg(`Processing ${i + 1}/${datasets.length}: ${d.gseId} (context → LLM)...`);
        addLog(`Processing ${d.gseId}: fetching context...`);

        // 1) Fetch Overall Design + PRIMARY PMID (from GEO header)
        const { overallDesign, primaryPmid } = await fetchGeoDesignAndPrimaryPmid(d.gseId, 3, signal);
        const withDesign: GeoResult = { ...d, overallDesign };

        // 2) Fetch Abstract ONLY for the PRIMARY dataset paper
        if (primaryPmid) {
          withDesign.pmid = primaryPmid;
          withDesign.paperAbstract = await fetchPubMedAbstract(primaryPmid, 3, signal);
        } else {
          withDesign.pmid = undefined;
          withDesign.paperAbstract = undefined;
          addLog(`Dataset ${d.gseId} has no PRIMARY PMID in GEO (!Series_pubmed_id). Skipping abstract fetch.`);
        }

        if (abortRef.current) throw new Error('Aborted by user');

        // 3) LLM evaluation
        addLog(`Processing ${d.gseId}: LLM evaluating...`);
        const evaluation = await evaluateDataset(
          withDesign,
          llmPrompt,
          expectedTags,
          { saiaApiKey: saiaKey, openRouterApiKey: openRouterKey },
          signal,
          addLog,
          llmStrategy
        );

        const updated: GeoResult = { ...withDesign, ...evaluation };

        if (evaluation.llmModelUsed) {
          lastModelUsed = evaluation.llmModelUsed;
        }

        // live update in UI: replace entry in-place
        setResults(prev => {
          const copy = [...prev];
          const idx = copy.findIndex(x => x.gseId === updated.gseId);
          if (idx >= 0) copy[idx] = updated;
          return copy;
        });

        addLog(`Result for ${updated.gseId}: Decision=${updated.llmDecision}, Score=${updated.llmScore}`);
        return updated;
      });

      setEvaluatingId(null);

      // finalize
      scoredDatasets = scoredByIndex.filter(Boolean);

      setStatus('done');
      setProgressMsg(`Completed evaluation of ${scoredDatasets.length} datasets.`);
      addLog(`Run completely finished. Evaluated ${scoredDatasets.length} datasets.`);
    } catch (error: any) {
      setEvaluatingId(null);
      if (error.message === 'Aborted by user' || error.name === 'AbortError') {
        setStatus('done');
        setProgressMsg(`Run aborted by user. Evaluated ${scoredDatasets.length} datasets.`);
        addLog('Run aborted by user.');
      } else {
        console.error(error);
        setStatus('error');
        setProgressMsg(`Error: ${error.message}`);
        addLog(`FATAL ERROR: ${error.message}`);
      }
    } finally {
      if (scoredDatasets.length > 0) {
        addLog(`Sorting results by LLM score...`);
        scoredDatasets.sort((a, b) => (b.llmScore || 0) - (a.llmScore || 0));
        setResults(scoredDatasets);

        if (isEvalMode) {
          addLog('Running Self-Evaluation metrics on evaluated datasets...');
          const goldMatches = goldStandardInput.match(/GSE\d+/gi);
          const goldSet = new Set(goldMatches ? goldMatches.map(m => m.toUpperCase()) : []);

          const tpList = scoredDatasets.filter(d => goldSet.has(d.gseId) && d.llmDecision === 'include');
          const fpList = scoredDatasets.filter(d => !goldSet.has(d.gseId) && d.llmDecision === 'include');
          const fnList = scoredDatasets.filter(d => goldSet.has(d.gseId) && d.llmDecision !== 'include');
          const tnList = scoredDatasets.filter(d => !goldSet.has(d.gseId) && d.llmDecision !== 'include');

          const tp = tpList.length;
          const fp = fpList.length;
          const fn = fnList.length;
          const tn = tnList.length;

          const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
          const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
          const f1 = precision + recall > 0 ? 2 * (precision * recall) / (precision + recall) : 0;

          const newRun: EvalRun = {
            id: Date.now().toString(),
            date: new Date().toLocaleString(),
            query: inputMode === 'search' ? query : 'Manual Input',
            llmPrompt,
            modelUsed: lastModelUsed,
            tp, fp, fn, tn,
            precision, recall, f1,
            tpIds: tpList.map(d => d.gseId),
            fpIds: fpList.map(d => d.gseId),
            fnIds: fnList.map(d => d.gseId),
            tnIds: tnList.map(d => d.gseId)
          };

          const newHistory = [newRun, ...evalHistory];
          setEvalHistory(newHistory);
          localStorage.setItem('omigator_eval_history', JSON.stringify(newHistory));
          addLog(`Eval Metrics: Precision=${(precision*100).toFixed(1)}%, Recall=${(recall*100).toFixed(1)}%`);
        }
      }
    }
  };

  const exportCsv = () => {
    if (results.length === 0) return;
    const headers = ['GSE_ID', 'Title', 'Organism', 'Assay', 'Samples', 'Decision', 'Score', 'Tags', 'Reasoning', 'PMID', 'FTP_Link'];
    const rows = results.map(r => [
      r.gseId,
      `"${r.title.replace(/"/g, '""')}"`,
      `"${r.organism}"`,
      `"${r.assay}"`,
      r.n_samples,
      r.llmDecision || '',
      r.llmScore || '',
      `"${(r.llmTags || []).join(', ')}"`,
      `"${(r.llmReasoning || '').replace(/"/g, '""')}"`,
      r.pmid || '',
      r.ftpLink || ''
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'omigator_results.csv';
    a.click();
    URL.revokeObjectURL(url);
    addLog('Exported results to CSV.');
  };

  const getDecisionIcon = (decision?: string) => {
    switch (decision) {
      case 'include': return <CheckCircle2 className="w-5 h-5 text-green-600" />;
      case 'exclude': return <XCircle className="w-5 h-5 text-red-600" />;
      case 'unclear': return <HelpCircle className="w-5 h-5 text-yellow-600" />;
      default: return null;
    }
  };

  const allAvailableTags = useMemo(() => {
    const tags = new Set<string>();
    results.forEach(r => r.llmTags?.forEach(t => tags.add(t)));
    return Array.from(tags).sort();
  }, [results]);

  const filteredResults = useMemo(() => {
    if (selectedTags.size === 0) return results;
    return results.filter(r => r.llmTags?.some(tag => selectedTags.has(tag)));
  }, [results, selectedTags]);

  const isRunning = status === 'searching' || status === 'fetching_metadata' || status === 'llm_scoring';

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-[var(--color-paper)]">
      {/* Cite modal */}
      {showCite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={() => setShowCite(false)}>
          <div className="w-full max-w-2xl brutal-border bg-[var(--color-paper)] brutal-shadow p-4" onMouseDown={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs font-bold uppercase text-[var(--color-muted)]">Cite Omigator</div>
                <div className="font-bold">Choose format and copy</div>
              </div>
              <button className="brutal-button px-3 py-2 text-sm gap-2" onClick={() => setShowCite(false)}>
                <X className="w-4 h-4" /> Close
              </button>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button className={`brutal-button px-3 py-2 text-sm ${citeFormat === 'apa' ? 'bg-ink text-white' : ''}`} onClick={() => setCiteFormat('apa')}>APA</button>
              <button className={`brutal-button px-3 py-2 text-sm ${citeFormat === 'bibtex' ? 'bg-ink text-white' : ''}`} onClick={() => setCiteFormat('bibtex')}>BibTeX</button>
              <button className={`brutal-button px-3 py-2 text-sm ${citeFormat === 'repo' ? 'bg-ink text-white' : ''}`} onClick={() => setCiteFormat('repo')}>Repo URL</button>
              <button className={`brutal-button px-3 py-2 text-sm ${citeFormat === 'doi' ? 'bg-ink text-white' : ''}`} onClick={() => setCiteFormat('doi')} disabled={!DOI_URL}>
                DOI
              </button>

              <button className="brutal-button px-3 py-2 text-sm gap-2 ml-auto" onClick={copyCite}>
                <Copy className="w-4 h-4" /> Copy
              </button>
            </div>

            <textarea
              className="brutal-input mt-3 font-mono text-xs min-h-[160px]"
              readOnly
              value={getCiteText()}
            />

            <div className="mt-3 text-[10px] text-[var(--color-muted)]">
              Thank you for citing Omigator!
            </div>
          </div>
        </div>
      )}

      <aside className="w-full md:w-96 brutal-border-r flex flex-col h-screen sticky top-0 bg-[var(--color-surface)] z-10 overflow-y-auto">
        <div className="p-6 brutal-border-b bg-[var(--color-accent)]">
          <div className="logo">
            <img src={omigatorLogo} alt="Omigator Logo" />
          </div>

          <h1 className="logo-text font-display text-3xl tracking-tighter uppercase leading-none text-center">
            Omigator
          </h1>

          <div className="mt-1 flex items-center justify-center gap-2">
            <span className="version-text text-sm font-bold uppercase tracking-widest">v{version}</span>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <a className="brutal-button px-3 py-2 text-sm gap-2 bg-white/90 hover:bg-white" href={GITHUB_URL} target="_blank" rel="noreferrer" title="GitHub repository">
              <Github className="w-4 h-4" /> GitHub
            </a>

            {/* <a className="brutal-button px-3 py-2 text-sm gap-2 bg-white/90 hover:bg-white" href={ISSUES_URL} target="_blank" rel="noreferrer" title="Report issues / request features">
              <ExternalLink className="w-4 h-4" /> Issues
            </a>

            <a className="brutal-button px-3 py-2 text-sm gap-2 bg-white/90 hover:bg-white" href={RELEASE_URL} target="_blank" rel="noreferrer" title="Release notes">
              <ExternalLink className="w-4 h-4" /> Release
            </a> */}

            {DOI_URL && (
              <a className="brutal-button px-3 py-2 text-sm gap-2 bg-white/90 hover:bg-white" href={DOI_URL} target="_blank" rel="noreferrer" title="DOI">
                <ExternalLink className="w-4 h-4" /> DOI
              </a>
            )}

            <button
              type="button"
              onClick={() => setShowCite(true)}
              className="brutal-button px-3 py-2 text-sm gap-2 bg-white/90 hover:bg-white"
              title="Cite Omigator"
            >
              <Quote className="w-4 h-4" /> Cite
            </button>
          </div>
        </div>

        <div className="p-6 flex-1 space-y-8">
          {/* LLM Settings */}
          <section className="space-y-4">
            <h2 className="font-display text-xl uppercase flex items-center gap-2">
              <Key className="w-5 h-5" />LLM Settings
            </h2>

            <div className="space-y-2">
              <label className="block text-xs font-bold uppercase">SAIA API Key (GWDG)</label>
              <input type="password" className="brutal-input" value={saiaKey} onChange={e => setSaiaKey(e.target.value)} placeholder="Bearer ..." />
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-bold uppercase">OpenRouter API Key</label>
              <input type="password" className="brutal-input" value={openRouterKey} onChange={e => setOpenRouterKey(e.target.value)} placeholder="sk-or-v1-..." />
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-bold uppercase">Fallback Strategy</label>
              <select className="brutal-input" value={llmStrategy} onChange={e => setLlmStrategy(e.target.value as LlmStrategy)}>
                <option value="saia_then_openrouter">SAIA → OpenRouter (fallback)</option>
                <option value="openrouter_then_saia">OpenRouter → SAIA (fallback)</option>
                <option value="saia_only">SAIA only</option>
                <option value="openrouter_only">OpenRouter only</option>
              </select>
              <p className="text-[10px] text-[var(--color-muted)]">Providers without an API key are skipped automatically.</p>
            </div>
          </section>

          {/* Input */}
          <section className="space-y-4">
            <h2 className="font-display text-xl uppercase flex items-center gap-2">
              <Search className="w-5 h-5" />Input
            </h2>

            <div className="flex gap-2 mb-2">
              <button
                className={`flex-1 py-1 text-xs font-bold uppercase brutal-border ${inputMode === 'search' ? 'bg-ink text-white' : 'bg-[var(--color-paper)]'}`}
                onClick={() => setInputMode('search')}
              >
                NCBI Search
              </button>
              <button
                className={`flex-1 py-1 text-xs font-bold uppercase brutal-border ${inputMode === 'manual' ? 'bg-ink text-white' : 'bg-[var(--color-paper)]'}`}
                onClick={() => setInputMode('manual')}
              >
                Manual GSEs
              </button>
            </div>

            {inputMode === 'search' ? (
              <>
                <div className="space-y-2">
                  <label className="block text-xs font-bold uppercase">Search Query</label>
                  <textarea
                    className="brutal-input min-h-[44px] resize-y"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder="e.g. breast cancer RNA-seq"
                  />
                </div>
                <div className="space-y-2">
                  <label className="block text-xs font-bold uppercase">Max Results</label>
                  <input type="number" className="brutal-input" value={maxResults} onChange={e => setMaxResults(parseInt(e.target.value) || 20)} min={1} max={500} />
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <label className="block text-xs font-bold uppercase">GSE IDs / URLs</label>
                <textarea className="brutal-input min-h-[100px] resize-y" value={manualInput} onChange={e => setManualInput(e.target.value)} placeholder="Paste GSE IDs or GEO URLs here..." />
              </div>
            )}
          </section>

          {/* Hard Filters */}
          <section className="space-y-4">
            <h2 className="font-display text-xl uppercase flex items-center gap-2">
              <Filter className="w-5 h-5" />Hard Filters
            </h2>
            <div className="space-y-2">
              <label className="block text-xs font-bold uppercase">Organism</label>
              <input type="text" className="brutal-input" value={organism} onChange={e => setOrganism(e.target.value)} />
            </div>
            <div className="space-y-2">
              <label className="block text-xs font-bold uppercase">Assay Type</label>
              <input type="text" className="brutal-input" value={assay} onChange={e => setAssay(e.target.value)} />
            </div>
            <div className="space-y-2">
              <label className="block text-xs font-bold uppercase">Min Samples</label>
              <input type="number" className="brutal-input" value={minSamples} onChange={e => setMinSamples(parseInt(e.target.value) || 0)} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-2">
                <label className="block text-xs font-bold uppercase">Min Date</label>
                <input type="date" className="brutal-input" value={minDate} onChange={e => setMinDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <label className="block text-xs font-bold uppercase">Max Date</label>
                <input type="date" className="brutal-input" value={maxDate} onChange={e => setMaxDate(e.target.value)} />
              </div>
            </div>
          </section>

          {/* LLM Eval */}
          <section className="space-y-4">
            <h2 className="font-display text-xl uppercase flex items-center gap-2">
              <Database className="w-5 h-5" />LLM Eval
            </h2>
            <div className="space-y-2">
              <label className="block text-xs font-bold uppercase">Evaluation Prompt</label>
              <textarea className="brutal-input min-h-[120px] resize-y" value={llmPrompt} onChange={e => setLlmPrompt(e.target.value)} placeholder="Define criteria for inclusion/exclusion..." />
            </div>
            <div className="space-y-2">
              <label className="block text-xs font-bold uppercase">Expected Tags (Comma-separated)</label>
              <textarea
                className="brutal-input min-h-[44px] resize-y"
                value={expectedTags}
                onChange={e => setExpectedTags(e.target.value)}
              />
            </div>
          </section>

          {/* Self-Evaluation */}
          <section className="space-y-4">
            <h2 className="font-display text-xl uppercase flex items-center gap-2">
              <BarChart2 className="w-5 h-5" />Self-Evaluation
            </h2>
            <div className="space-y-2 pt-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" className="w-4 h-4 accent-[var(--color-accent)]" checked={isEvalMode} onChange={e => setIsEvalMode(e.target.checked)} />
                <span className="text-xs font-bold uppercase">Enable Evaluation Mode</span>
              </label>
              <p className="text-[10px] text-[var(--color-muted)] leading-tight">
                Compare the app's selection against a Gold Standard (e.g. from a meta-study).
              </p>
            </div>

            {isEvalMode && (
              <div className="space-y-2 mt-2 p-3 bg-[var(--color-paper)] brutal-border">
                <label className="block text-xs font-bold uppercase">Gold Standard GSE IDs</label>
                <textarea className="brutal-input min-h-[80px] resize-y" value={goldStandardInput} onChange={e => setGoldStandardInput(e.target.value)} placeholder="GSE12345, GSE67890..." />
              </div>
            )}
          </section>
        </div>

        <div className="p-6 brutal-border-t bg-[var(--color-paper)]" style={{ position: "sticky", bottom: 0 }}>
          {isRunning ? (
            <button className="brutal-button w-full py-4 text-lg gap-2 bg-red-500 hover:bg-red-600 border-red-900" onClick={handleStop}>
              <Square className="w-6 h-6 fill-current" /> Stop Run
            </button>
          ) : (
            <button className="brutal-button w-full py-4 text-lg gap-2" onClick={handleRun}>
              <Play className="w-6 h-6 fill-current" /> Start Scouting
            </button>
          )}
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col h-screen overflow-hidden relative">
        {/* Top Status Bar */}
        <header className="brutal-border-b p-4 flex justify-between items-center bg-[var(--color-paper)] z-10">
          <div className="flex items-center gap-4">
            <div className="font-bold uppercase text-sm flex items-center gap-2">
              Status:
              <span className={`px-2 py-1 brutal-border text-xs ${
                status === 'error' ? 'bg-red-500 text-white' :
                status === 'done' ? 'bg-green-400' :
                status !== 'idle' ? 'bg-[var(--color-accent)] text-white animate-pulse' : 'bg-[var(--color-surface)]'
              }`}>
                {status.replace('_', ' ').toUpperCase()}
              </span>
            </div>
            <div className="text-xs font-mono text-[var(--color-muted)] max-w-md truncate">
              {progressMsg}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button className={`brutal-button px-4 py-2 text-sm gap-2 ${showLogs ? 'bg-ink text-white' : ''}`} onClick={() => setShowLogs(!showLogs)}>
              <Terminal className="w-4 h-4" /> Logs
            </button>
            <button className="brutal-button px-4 py-2 text-sm gap-2" onClick={exportCsv} disabled={results.length === 0}>
              <Download className="w-4 h-4" /> Export CSV
            </button>
          </div>
        </header>

        {/* Tabs */}
        <div className="flex gap-4 p-4 brutal-border-b bg-[var(--color-surface)] z-10">
          <button
            onClick={() => setActiveTab('scout')}
            className={`text-sm font-bold uppercase px-4 py-2 brutal-border transition-colors ${activeTab === 'scout' ? 'bg-ink text-white' : 'bg-[var(--color-paper)] hover:bg-[var(--color-accent)] hover:text-white'}`}
          >
            Scout Results
          </button>
          <button
            onClick={() => setActiveTab('eval')}
            className={`text-sm font-bold uppercase px-4 py-2 brutal-border transition-colors ${activeTab === 'eval' ? 'bg-ink text-white' : 'bg-[var(--color-paper)] hover:bg-[var(--color-accent)] hover:text-white'}`}
          >
            Evaluation History
          </button>
        </div>

        {/* Content Area */}
        <div
          className="flex-1 overflow-auto bg-[var(--color-surface)] flex flex-col"
          style={{
            backgroundImage: 'radial-gradient(var(--color-muted) 1px, transparent 1px)',
            backgroundSize: '20px 20px',
            backgroundPosition: '0 0'
          }}
        >
          {activeTab === 'scout' ? (
            <>
              {/* Tag Filter Bar */}
              {allAvailableTags.length > 0 && (
                <div className="brutal-border-b p-4 bg-[var(--color-paper)] flex items-center gap-3 overflow-x-auto flex-shrink-0">
                  <Tag className="w-4 h-4 flex-shrink-0" />
                  <span className="text-xs font-bold uppercase flex-shrink-0">Filter by Tags:</span>
                  <div className="flex gap-2">
                    {allAvailableTags.map(tag => (
                      <button
                        key={tag}
                        onClick={() => toggleTagFilter(tag)}
                        className={`px-2 py-1 text-xs font-bold border-2 border-[var(--color-ink)] transition-colors whitespace-nowrap ${
                          selectedTags.has(tag)
                            ? 'bg-ink text-white'
                            : 'bg-[var(--color-surface)] hover:bg-[var(--color-accent)] hover:text-white'
                        }`}
                      >
                        #{tag}
                      </button>
                    ))}
                  </div>
                  {selectedTags.size > 0 && (
                    <button onClick={() => setSelectedTags(new Set())} className="text-xs underline ml-2 flex-shrink-0">
                      Clear
                    </button>
                  )}
                </div>
              )}

              <div className="p-6 flex-1">
                {results.length === 0 && status === 'idle' ? (
                  <div className="h-full flex flex-col items-center justify-center text-center opacity-80">
                    {/* <Database className="w-24 h-24 mb-6 stroke-1" /> */}


                    {/* <div className="logo-wallpaper" style={{ backgroundImage: 'url(/src/assets/logo-wallpaper.webp)' }}>
                    </div> */}

                    <ParticleLogo
                      imageSrc={omigatorLogoPng}
                      className="logo-wallpaper"
                    />

                    <h2 className="font-display text-4xl uppercase mb-4">Awaiting Input</h2>
                    <p className="max-w-md">Configure your search parameters in the sidebar and start scouting to retrieve and evaluate NCBI GEO datasets.</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {filteredResults.map((res) => (
                      <div key={res.gseId} className="brutal-border bg-[var(--color-paper)] brutal-shadow-sm transition-all hover:brutal-shadow relative overflow-hidden">
                        {evaluatingId === res.gseId && (
                          <div className="absolute bottom-0 left-0 h-1 w-full bg-[var(--color-surface)] z-10">
                            <div className="h-full bg-[var(--color-accent)] animate-pulse" style={{ width: '100%' }}></div>
                          </div>
                        )}

                        <div className="p-4 flex flex-col lg:flex-row gap-4 items-start lg:items-center cursor-pointer select-none" onClick={() => toggleRow(res.gseId)}>
                          <div className="flex-shrink-0 w-8 flex justify-center">
                            {expandedRows.has(res.gseId) ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                          </div>

                          <div className="flex-shrink-0 w-24 font-bold text-lg">
                            <a
                              href={`https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${res.gseId}`}
                              target="_blank"
                              rel="noreferrer"
                              className="hover:underline hover:text-[var(--color-accent)]"
                              onClick={e => e.stopPropagation()}
                            >
                              {res.gseId}
                            </a>
                          </div>

                          <div className="flex-1 min-w-0">
                            <h3 className="font-bold truncate text-sm lg:text-base" title={res.title}>{res.title}</h3>
                            <div className="flex flex-wrap gap-2 mt-2 text-xs text-[var(--color-muted)]">
                              <span className="brutal-border px-1">{res.organism}</span>
                              <span className="brutal-border px-1">{res.assay}</span>
                              <span className="brutal-border px-1">n={res.n_samples}</span>
                              {res.pmid && (
                                <a
                                  href={`https://pubmed.ncbi.nlm.nih.gov/${res.pmid}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="brutal-border px-1 bg-blue-50 text-blue-800 hover:bg-blue-100"
                                  onClick={e => e.stopPropagation()}
                                >
                                  PMID: {res.pmid}
                                </a>
                              )}
                            </div>
                          </div>

                          {res.llmDecision && (
                            <div className="flex-shrink-0 flex items-center gap-4 lg:w-48 justify-end">
                              <div className="text-right">
                                <div className="text-[10px] uppercase font-bold text-[var(--color-muted)]">Score</div>
                                <div className="font-display text-xl leading-none">{res.llmScore}</div>
                              </div>
                              <div className="flex flex-col items-center justify-center w-16">
                                {getDecisionIcon(res.llmDecision)}
                                <span className="text-[10px] uppercase font-bold mt-1">{res.llmDecision}</span>
                              </div>
                            </div>
                          )}
                        </div>

                        {expandedRows.has(res.gseId) && (
                          <div className="p-4 brutal-border-t bg-[var(--color-surface)] text-sm space-y-4">
                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                              <div>
                                <h4 className="font-bold uppercase text-xs mb-1">GEO Summary</h4>
                                <p className="text-[var(--color-muted)] leading-relaxed">{res.summary}</p>
                              </div>
                              <div>
                                <h4 className="font-bold uppercase text-xs mb-1">Overall Design</h4>
                                <p className="text-[var(--color-muted)] leading-relaxed">{res.overallDesign || 'Not available.'}</p>
                              </div>
                            </div>

                            {res.paperAbstract && (
                              <div>
                                <h4 className="font-bold uppercase text-xs mb-1">Paper Abstract</h4>
                                <p className="text-[var(--color-muted)] leading-relaxed">{res.paperAbstract}</p>
                              </div>
                            )}

                            {res.llmReasoning && (
                              <div className="brutal-border p-4 bg-[var(--color-paper)]">
                                <h4 className="font-bold uppercase text-xs mb-2 flex items-center gap-2">
                                  <Database className="w-4 h-4" /> LLM Reasoning
                                </h4>
                                <p className="leading-relaxed">{res.llmReasoning}</p>

                                {res.llmTags && res.llmTags.length > 0 && (
                                  <div className="mt-4 flex flex-wrap gap-2">
                                    {res.llmTags.map(tag => (
                                      <span key={tag} className="bg-ink text-white px-2 py-1 text-xs font-bold">
                                        #{tag}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                    {filteredResults.length === 0 && results.length > 0 && (
                      <div className="text-center p-8 text-[var(--color-muted)] font-bold uppercase">
                        No datasets match the selected tags.
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="p-6">
              <div className="flex justify-between items-center mb-6">
                <h2 className="font-display text-2xl uppercase">Evaluation History</h2>
                <button onClick={clearEvalHistory} className="brutal-button px-3 py-1 text-xs bg-red-100 text-red-800 border-red-800">
                  Clear History
                </button>
              </div>

              {evalHistory.length === 0 ? (
                <div className="text-center p-8 text-[var(--color-muted)] font-bold uppercase">
                  No evaluation history yet. Enable "Evaluation Mode" and run a scout.
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="text-xs bg-[var(--color-paper)] p-3 brutal-border flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <div>
                      <strong>Note on Gold Standard:</strong> Since the gold standard typically only contains positive examples, any evaluated dataset <em>not</em> in the gold standard is assumed to be a Negative. This means <strong>False Positives</strong> might contain valid datasets that were simply not labelled in your gold standard.
                    </div>
                  </div>

                  {evalHistory.map(run => (
                    <div key={run.id} className="brutal-border bg-[var(--color-paper)] p-4">
                      <div className="flex justify-between items-start mb-4">
                        <div>
                          <div className="text-xs font-bold uppercase text-[var(--color-muted)]">{run.date}</div>
                          <div className="font-bold text-lg mt-1">Model: {run.modelUsed}</div>
                        </div>
                        <div className="flex gap-4 text-center">
                          <div>
                            <div className="text-[10px] uppercase font-bold text-[var(--color-muted)]">Precision</div>
                            <div className="font-display text-2xl">{(run.precision * 100).toFixed(1)}%</div>
                          </div>
                          <div>
                            <div className="text-[10px] uppercase font-bold text-[var(--color-muted)]">Recall</div>
                            <div className="font-display text-2xl">{(run.recall * 100).toFixed(1)}%</div>
                          </div>
                          <div>
                            <div className="text-[10px] uppercase font-bold text-[var(--color-muted)]">F1 Score</div>
                            <div className="font-display text-2xl text-[var(--color-accent)]">{(run.f1 * 100).toFixed(1)}%</div>
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-4 gap-2 mb-4">
                        <div className="brutal-border p-2 text-center bg-green-50 flex flex-col">
                          <div className="text-[10px] uppercase font-bold">True Positives</div>
                          <div className="text-xl font-bold">{run.tp}</div>
                          {run.tpIds && run.tpIds.length > 0 && (
                            <div className="mt-2 text-[9px] text-left text-green-800 break-words overflow-y-auto max-h-32 flex-1">
                              {run.tpIds.join(', ')}
                            </div>
                          )}
                        </div>
                        <div className="brutal-border p-2 text-center bg-red-50 flex flex-col">
                          <div className="text-[10px] uppercase font-bold">False Positives</div>
                          <div className="text-xl font-bold">{run.fp}</div>
                          {run.fpIds && run.fpIds.length > 0 && (
                            <div className="mt-2 text-[9px] text-left text-red-800 break-words overflow-y-auto max-h-32 flex-1">
                              {run.fpIds.join(', ')}
                            </div>
                          )}
                        </div>
                        <div className="brutal-border p-2 text-center bg-yellow-50 flex flex-col">
                          <div className="text-[10px] uppercase font-bold">False Negatives</div>
                          <div className="text-xl font-bold">{run.fn}</div>
                          {run.fnIds && run.fnIds.length > 0 && (
                            <div className="mt-2 text-[9px] text-left text-yellow-800 break-words overflow-y-auto max-h-32 flex-1">
                              {run.fnIds.join(', ')}
                            </div>
                          )}
                        </div>
                        <div className="brutal-border p-2 text-center bg-gray-50 flex flex-col">
                          <div className="text-[10px] uppercase font-bold">True Negatives</div>
                          <div className="text-xl font-bold">{run.tn}</div>
                          {run.tnIds && run.tnIds.length > 0 && (
                            <div className="mt-2 text-[9px] text-left text-gray-600 break-words overflow-y-auto max-h-32 flex-1">
                              {run.tnIds.join(', ')}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="text-xs space-y-2 text-[var(--color-muted)]">
                        <p><strong className="uppercase">Query:</strong> {run.query}</p>
                        <p><strong className="uppercase">Prompt:</strong> {run.llmPrompt}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {showLogs && (
          <div className="h-64 brutal-border-t bg-ink text-white p-4 overflow-y-auto font-mono text-xs flex-shrink-0 z-20">
            <div className="flex justify-between items-center mb-4 sticky top-0 bg-ink pb-2 brutal-border-b border-[var(--color-muted)]">
              <h3 className="font-bold uppercase flex items-center gap-2">
                <Terminal className="w-4 h-4" /> System Logs
              </h3>
              <button onClick={() => setLogs([])} className="underline hover:text-[var(--color-accent)]">Clear Logs</button>
            </div>
            <div className="space-y-1">
              {logs.length === 0 ? (
                <div className="text-[var(--color-muted)] italic">No logs yet...</div>
              ) : (
                logs.map((log, i) => (
                  <div key={i} className="break-all">
                    <span className="text-[var(--color-muted)] mr-2">[{log.time}]</span>
                    <span className={log.msg.includes('Error') || log.msg.includes('FATAL') ? 'text-red-400' : ''}>
                      {log.msg}
                    </span>
                  </div>
                ))
              )}
              <div ref={logsEndRef} />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}