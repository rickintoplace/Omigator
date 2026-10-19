import { Download, ExternalLink, FileJson, Link2, LoaderCircle, MessageSquareQuote, Play, Plus, Quote, Settings as SettingsIcon, Square } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { buildGdsTerm, type DatasetResult, type Decision, draftProtocol, fitPlatt, loadDossier, normalizeGseList, plattProbability, type Protocol } from '../core';
import omigatorLogo from '../assets/omigator-logo.png';
import { CiteDialog, GITHUB_URL } from './components/CiteDialog';
import { InsightsView } from './components/InsightsView';
import { KeyPrompt } from './components/KeyPrompt';
import { type InputMode, ProtocolPanel } from './components/ProtocolPanel';
import { ResultRow } from './components/ResultRow';
import { SettingsDialog } from './components/SettingsDialog';
import { StartScreen } from './components/StartScreen';
import { DECISION_STYLE, usd } from './components/ui';
import { loadDemo } from './demo';
import { exportCsv, exportJson } from './export';
import { listRuns, type SavedRunMeta } from './idbCache';
import { fetchRun, newRunId, openShared, shareUrl, storeRun } from './persistence';
import { chatTarget, isReady, type Keys, load, loadKeys, loadSettings, makeNcbi, makeScorer, save, saveKeys, saveSettings, type Settings } from './settings';
import { useRun } from './useRun';

const VERSION = __APP_VERSION__;
const EMPTY_PROTOCOL: Protocol = { intent: '', query: '', filters: { organism: 'Homo sapiens' }, criteria: [] };
/** Measured on the hypoxia benchmark: $0.0066 for 187 datasets with pplx-decider-v1.2. */
const COST_PER_DATASET = 0.00004;

type Tab = 'results' | 'insights' | 'log';
type View = 'all' | Decision | 'failed' | 'audit';

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [keys, setKeys] = useState<Keys>(loadKeys);
  const [protocol, setProtocol] = useState<Protocol>(() => load('omigator.protocol.v2', EMPTY_PROTOCOL));
  const [workspace, setWorkspace] = useState(() => protocol.criteria.length > 0);
  const [mode, setMode] = useState<InputMode>('search');
  const [retmax, setRetmax] = useState(200);
  const [gseText, setGseText] = useState('');
  const [labels, setLabels] = useState<Record<string, boolean>>(() => load('omigator.labels.v2', {}));
  const [goldText, setGoldText] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showCite, setShowCite] = useState(false);
  const [tab, setTab] = useState<Tab>('results');
  const [view, setView] = useState<View>('all');
  const [audit, setAudit] = useState<string[]>([]);
  const [filterText, setFilterText] = useState('');
  const [hideSuperSeries, setHideSuperSeries] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string>();
  const [hitCount, setHitCount] = useState<{ count?: number; loading: boolean; error?: string }>({ loading: false });

  const { state, busy, start, startDemo, stop, reset, load: loadRun, patch, explainMany, retry, cache } = useRun(VERSION);
  const running = state.status === 'running';
  const demo = state.demo;
  const [runId, setRunId] = useState<string>();
  const [recent, setRecent] = useState<SavedRunMeta[]>([]);
  const [notice, setNotice] = useState<string>();
  const [labelHintSeen, setLabelHintSeen] = useState(() => load('omigator.labelHint', { seen: false }).seen);
  const loadingDossiers = useRef(new Set<string>());

  const setHash = (hash: string) => history.replaceState(null, '', hash ? `#${hash}` : `${location.pathname}${location.search}`);
  const showRun = (data: Parameters<typeof loadRun>[0]) => {
    setProtocol(data.protocol);
    setMode(data.input.mode);
    if (data.input.mode === 'search') setRetmax(data.input.retmax);
    else setGseText(data.input.gses.join('\n'));
    setWorkspace(true);
    setTab('results');
    setView('all');
    setExpanded(new Set());
    loadRun(data);
  };

  // Open what the URL points to: a shared run (#s=…) or a run saved in this browser (#run=…).
  useEffect(() => {
    listRuns().then(setRecent);
    const params = new URLSearchParams(location.hash.slice(1));
    const shared = params.get('s');
    const saved = params.get('run');
    if (shared) {
      setWorkspace(true);
      setNotice('Opening shared run…');
      openShared(shared, makeNcbi(keys, settings))
        .then((run) => {
          setLabels((l) => ({ ...run.labels, ...l }));
          showRun({ ...run, message: `Shared run from ${run.manifest.createdAt.slice(0, 10)}`, source: 'shared' });
          setNotice(undefined);
        })
        .catch((err) => setNotice(`Could not open this link: ${(err as Error).message}`));
    } else if (saved) {
      fetchRun(saved).then((run) => {
        if (!run) return setHash('');
        setRunId(saved);
        showRun({ ...run, message: `Saved run from ${(run.manifest?.createdAt ?? '').slice(0, 10)}`, source: 'saved' });
      });
    }
  }, []);

  // Every finished run is saved in this browser and its address put in the URL, so a reload or a
  // misclick does not lose it. Explanations added later are saved too.
  useEffect(() => {
    if (state.status !== 'done' || demo || !state.protocol || !state.input || !state.results.some((r) => r.screening)) return;
    if (state.source !== 'run' && state.source !== 'saved') return;
    const id = runId ?? newRunId();
    if (!runId) setRunId(id);
    const timer = setTimeout(() => {
      storeRun(id, { results: state.results, protocol: state.protocol!, input: state.input!, manifest: state.manifest }).then(() => listRuns().then(setRecent));
      setHash(`run=${id}`);
    }, 600);
    return () => clearTimeout(timer);
  }, [state.status, state.results, state.source]);

  // Shared and saved runs carry no sample records; load them when a dataset is opened.
  useEffect(() => {
    for (const r of state.results) {
      if (!expanded.has(r.gse) || r.dossier || loadingDossiers.current.has(r.gse)) continue;
      loadingDossiers.current.add(r.gse);
      loadDossier(r, makeNcbi(keys, settings), { cache: cache.current })
        .then(patch)
        .finally(() => loadingDossiers.current.delete(r.gse));
    }
  }, [expanded, state.results]);

  const share = async () => {
    if (!state.protocol || !state.input) return;
    try {
      const { url, withExplanations } = await shareUrl({ results: state.results, protocol: state.protocol, input: state.input, manifest: state.manifest }, labels);
      await navigator.clipboard.writeText(url).catch(() => undefined);
      setNotice(`Link copied (${Math.round(url.length / 1000)} KB${withExplanations ? '' : ', without explanations to keep it short'}). Anyone with the link sees this ranking; no key needed.`);
    } catch (err) {
      setNotice(`Could not create a link: ${(err as Error).message}`);
    }
  };

  useEffect(() => saveSettings(settings), [settings]);
  useEffect(() => saveKeys(keys, settings.rememberKeys), [keys, settings.rememberKeys]);
  useEffect(() => save('omigator.protocol.v2', protocol), [protocol]);
  useEffect(() => save('omigator.labels.v2', labels), [labels]);

  // Live count of matching GEO series while the search is edited.
  useEffect(() => {
    if (!workspace || mode !== 'search' || !protocol.query.trim()) return setHitCount({ loading: false });
    setHitCount((h) => ({ ...h, loading: true }));
    const controller = new AbortController();
    const timer = setTimeout(() => {
      makeNcbi(keys, settings)
        .searchGds(buildGdsTerm(protocol.query, protocol.filters), 0, controller.signal)
        .then((r) => setHitCount({ count: r.count, loading: false }))
        .catch((err) => !controller.signal.aborted && setHitCount({ loading: false, error: (err as Error).message }));
    }, 700);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [workspace, mode, protocol.query, protocol.filters.organism, protocol.filters.minDate, protocol.filters.maxDate]);

  const scorerReady = isReady(keys, settings);
  const chatReady = (() => {
    try {
      chatTarget(keys, settings);
      return true;
    } catch {
      return false;
    }
  })();
  const needsOpenRouterKey = !keys.openrouter.trim() && settings.scoring !== 'custom-logprobs';

  const toScreen = mode === 'search' ? Math.min(hitCount.count ?? retmax, retmax) : normalizeGseList(gseText).length;
  const blocker = useMemo(() => {
    if (!protocol.criteria.length || protocol.criteria.some((c) => !c.text.trim())) return 'Add at least one complete line to the checklist.';
    if (mode === 'search' && !protocol.query.trim()) return 'Enter a GEO search.';
    if (mode === 'search' && hitCount.count === 0) return 'The search matches no series.';
    if (mode === 'list' && !toScreen) return 'Paste at least one GSE accession.';
    return undefined;
  }, [protocol, mode, toScreen, hitCount.count]);

  const saveOpenRouterKey = (key: string, remember: boolean) => {
    const next = { ...keys, openrouter: key };
    setKeys(next);
    setSettings((s) => ({ ...s, rememberKeys: remember }));
    return next;
  };

  const draft = async (withKeys: Keys = keys) => {
    setDrafting(true);
    setDraftError(undefined);
    try {
      const { ep, model } = chatTarget(withKeys, settings);
      const { protocol: drafted } = await draftProtocol(protocol.intent, ep, model);
      setProtocol({ ...drafted, filters: { ...protocol.filters, ...drafted.filters } });
      setMode('search');
      setWorkspace(true);
    } catch (err) {
      setDraftError((err as Error).message);
    } finally {
      setDrafting(false);
    }
  };

  const screen = (withKeys: Keys = keys) => {
    if (blocker) return;
    setRunId(undefined);
    setHash('');
    setTab('results');
    setView('all');
    setExpanded(new Set());
    start(protocol, mode === 'search' ? { mode, retmax } : { mode, gses: normalizeGseList(gseText) }, makeNcbi(withKeys, settings), makeScorer(withKeys, settings));
  };

  const openDemo = async () => {
    try {
      const rec = await loadDemo();
      setProtocol(rec.protocol);
      setMode('search');
      setRetmax(rec.retmax);
      setGoldText(rec.gold.join(', '));
      setWorkspace(true);
      setTab('results');
      setView('all');
      setExpanded(new Set());
      startDemo(rec);
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const newRequest = () => {
    reset();
    setRunId(undefined);
    setHash('');
    setNotice(undefined);
    setProtocol(EMPTY_PROTOCOL);
    setGseText('');
    setGoldText('');
    setAudit([]);
    setWorkspace(false);
  };

  const shownProtocol = state.protocol ?? protocol;
  const results = state.results;
  const counts = useMemo(() => {
    const c: Record<View, number> = { all: results.length, include: 0, unclear: 0, exclude: 0, failed: 0, audit: audit.length };
    for (const r of results) {
      if (r.screening) c[r.screening.decision]++;
      else if (r.error) c.failed++;
    }
    return c;
  }, [results, audit]);

  // Platt scaling from the user's labels: a probability of relevance per dataset.
  const platt = useMemo(() => {
    const labelled = results.filter((r) => r.screening && labels[r.gse] !== undefined);
    return fitPlatt(labelled.map((r) => r.screening!.logScore), labelled.map((r) => labels[r.gse]));
  }, [results, labels]);

  // A SuperSeries whose SubSeries are also in the list only repeats their samples.
  const duplicates = useMemo(() => {
    const listed = new Set(results.map((r) => r.gse));
    return new Set(results.filter((r) => (r.dossier?.series?.superSeriesOf ?? r.superSeriesOf)?.some((g) => listed.has(g))).map((r) => r.gse));
  }, [results]);

  const visible = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    return results
      .map((r, i) => ({ r, rank: i + 1 }))
      .filter(({ r }) => {
        if (view === 'audit') return audit.includes(r.gse);
        if (view === 'failed') return !r.screening && r.error;
        if (view !== 'all') return r.screening?.decision === view;
        return true;
      })
      .filter(({ r }) => !hideSuperSeries || view === 'audit' || !duplicates.has(r.gse))
      .filter(({ r }) => !q || `${r.gse} ${r.candidate.title} ${r.candidate.summary}`.toLowerCase().includes(q));
  }, [results, view, audit, filterText, hideSuperSeries, duplicates]);

  const startAudit = () => {
    const pool = results.filter((r) => r.screening && labels[r.gse] === undefined).map((r) => r.gse);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    setAudit(pool.slice(0, 10));
    setView('audit');
    setTab('results');
  };

  const canExplain = Boolean(demo) || chatReady;
  const explainTargets = async (rs: DatasetResult[]) => {
    if (demo) return explainMany(rs);
    const { ep, model } = chatTarget(keys, settings);
    // Shared and saved runs load the evidence first; explanations quote from it.
    const ready = await Promise.all(rs.map((r) => (r.dossier ? r : loadDossier(r, makeNcbi(keys, settings), { cache: cache.current }).then((x) => (patch(x), x)))));
    return explainMany(ready, ep, model);
  };
  const topToExplain = results.filter((r) => r.screening && !r.explanation && (!demo || demo.explanations[r.gse])).slice(0, 10);

  const runControl = running ? (
    <button className="brutal-button w-full py-3 text-base bg-[var(--color-danger)] text-white" onClick={stop}>
      <Square className="w-4 h-4 fill-current" /> Stop
    </button>
  ) : demo ? (
    <div className="text-sm space-y-2">
      <p>This is a recorded demo; the checklist on the left is the one the run used.</p>
      <button className="brutal-button button-primary w-full py-2.5" onClick={newRequest}>
        <Plus className="w-4 h-4" /> Start your own request
      </button>
    </div>
  ) : !scorerReady && needsOpenRouterKey ? (
    <KeyPrompt reason="Screening uses a decision model." remember={settings.rememberKeys} onSave={(k, r) => screen(saveOpenRouterKey(k, r))} onOpenSettings={() => setShowSettings(true)} />
  ) : (
    <div className="space-y-1.5">
      <button className="brutal-button button-primary w-full py-3 text-base" onClick={() => (scorerReady ? screen() : setShowSettings(true))} disabled={Boolean(blocker)}>
        <Play className="w-4 h-4 fill-current" />
        {results.length ? 'Screen again' : `Screen ${toScreen ? `${toScreen} ` : ''}datasets`}
      </button>
      <p className="text-xs text-center text-[var(--color-muted)]">
        {blocker ??
          (scorerReady
            ? `About ${usd(toScreen * COST_PER_DATASET)} with ${settings.scoring === 'openrouter-decisions' ? settings.decisionModel.split('/')[1] : 'your model'}.`
            : 'Finish the setup in Settings.')}
      </p>
    </div>
  );

  return (
    <div className="h-screen flex flex-col bg-[var(--color-paper)]">
      {showSettings && <SettingsDialog settings={settings} keys={keys} onSettings={setSettings} onKeys={setKeys} onClose={() => setShowSettings(false)} />}
      {showCite && <CiteDialog version={VERSION} onClose={() => setShowCite(false)} />}

      <header className="flex items-center gap-3 px-4 py-2 brutal-border-b bg-[var(--color-accent)] shrink-0">
        <button className="flex items-center gap-2" onClick={newRequest} title="Start a new request">
          <img src={omigatorLogo} alt="" className="h-10 w-auto" />
          <span className="font-display text-xl uppercase leading-none">Omigator</span>
        </button>
        <span className="text-xs mono hidden sm:inline">v{VERSION}</span>
        <span className="flex-1" />
        {workspace && (
          <button className="brutal-button px-3 py-1.5 text-sm bg-white" onClick={newRequest}>
            <Plus className="w-4 h-4" /> New request
          </button>
        )}
        <button className="brutal-button px-3 py-1.5 text-sm bg-white" onClick={() => setShowSettings(true)}>
          <SettingsIcon className="w-4 h-4" /> Settings
          <span className={`w-2 h-2 rounded-full ${scorerReady ? 'bg-green-600' : 'bg-red-500'}`} title={scorerReady ? 'Ready' : 'Key missing'} />
        </button>
        <button className="brutal-button px-3 py-1.5 text-sm bg-white hidden md:inline-flex" onClick={() => setShowCite(true)}>
          <Quote className="w-4 h-4" /> Cite
        </button>
        <a className="brutal-button px-3 py-1.5 text-sm bg-white hidden md:inline-flex" href={GITHUB_URL} target="_blank" rel="noreferrer">
          Code <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </header>

      {!workspace ? (
        <main className="flex-1 overflow-auto">
          <StartScreen
            intent={protocol.intent}
            onIntent={(intent) => setProtocol({ ...protocol, intent })}
            onDraft={() => draft()}
            drafting={drafting}
            draftError={draftError}
            hasKey={chatReady}
            rememberKeys={settings.rememberKeys}
            onKey={(k, r) => {
              const next = saveOpenRouterKey(k, r);
              if (protocol.intent.trim()) draft(next);
            }}
            onPreset={(p) => {
              setProtocol(p);
              setMode('search');
              setWorkspace(true);
            }}
            onManual={() => setWorkspace(true)}
            onDemo={openDemo}
            onOpenSettings={() => setShowSettings(true)}
            recent={recent}
            onOpenRun={async (id) => {
              const run = await fetchRun(id);
              if (!run) return;
              setRunId(id);
              setHash(`run=${id}`);
              showRun({ ...run, message: `Saved run from ${(run.manifest?.createdAt ?? '').slice(0, 10)}`, source: 'saved' });
            }}
          />
        </main>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col md:flex-row">
          <aside className="md:w-[27rem] shrink-0 flex flex-col brutal-border-r bg-[var(--color-surface)] min-h-0">
            <div className="flex-1 overflow-y-auto p-4">
              <ProtocolPanel
                protocol={protocol}
                onChange={setProtocol}
                mode={mode}
                onMode={setMode}
                retmax={retmax}
                onRetmax={setRetmax}
                gseText={gseText}
                onGseText={setGseText}
                hitCount={hitCount}
                drafting={drafting}
                draftError={draftError}
                onDraft={chatReady ? () => draft() : undefined}
                readOnly={Boolean(demo) || running}
              />
            </div>
            {/* While the ready panel is shown, it carries the run control; no second copy here. */}
            {(results.length > 0 || running || demo || tab !== 'results') && <div className="p-4 brutal-border-t bg-[var(--color-paper)]">{runControl}</div>}
          </aside>

          <main className="flex-1 min-w-0 min-h-0 flex flex-col">
            <div className="brutal-border-b px-4 py-2 bg-[var(--color-paper)] flex flex-wrap items-center gap-2 shrink-0">
              <nav className="flex brutal-border text-sm font-semibold">
                {(
                  [
                    ['results', 'Results'],
                    ['insights', 'Check accuracy'],
                    ['log', 'Log'],
                  ] as [Tab, string][]
                ).map(([t, label], i) => (
                  <button key={t} className={`px-3 py-1 ${i ? 'border-l-2 border-[var(--color-ink)]' : ''} ${tab === t ? 'bg-ink text-white' : 'hover:bg-[var(--color-surface)]'}`} onClick={() => setTab(t)}>
                    {label}
                  </button>
                ))}
              </nav>
              <div className="flex-1 min-w-[10rem] text-sm text-[var(--color-muted)] truncate">
                {running && <LoaderCircle className="inline w-3.5 h-3.5 mr-1 animate-spin" />}
                {state.message}
                {state.total > 0 && ` · ${state.done}/${state.total}`}
                {state.manifest && ` · ${usd(state.manifest.cost.screening + state.manifest.cost.explanations)}`}
              </div>
              <button className="brutal-button px-2 py-1 text-sm" onClick={share} disabled={!results.some((r) => r.screening) || running || Boolean(demo)} title="Copy a link that opens this ranking for anyone, without a key">
                <Link2 className="w-4 h-4" /> Share link
              </button>
              <button className="brutal-button px-2 py-1 text-sm" onClick={() => exportCsv(results, shownProtocol, labels)} disabled={!results.length}>
                <Download className="w-4 h-4" /> CSV
              </button>
              <button className="brutal-button px-2 py-1 text-sm" onClick={() => exportJson(results, state.manifest, labels)} disabled={!state.manifest} title="Protocol, models, thresholds and all per-dataset results">
                <FileJson className="w-4 h-4" /> Run file
              </button>
            </div>
            {running && state.total > 0 && (
              <div className="h-1.5 bg-[var(--color-surface)] shrink-0">
                <div className="h-full bg-[var(--color-ink)] transition-all" style={{ width: `${(100 * state.done) / state.total}%` }} />
              </div>
            )}
            {demo && (
              <div className="px-4 py-2 brutal-border-b bg-[var(--color-warn)] text-sm shrink-0">
                <b>Demo:</b> {demo.note}
              </div>
            )}
            {state.source === 'shared' && !demo && (
              <div className="px-4 py-2 brutal-border-b bg-[var(--color-accent)] text-sm shrink-0">
                <b>Shared run</b> from {state.manifest?.createdAt.slice(0, 10)}, screened with {state.manifest?.scorer.snapshots.join(', ') || 'an unknown model'}. Sample
                details load from GEO when you open a dataset; explanations need your own key.
              </div>
            )}
            {notice && (
              <div className="px-4 py-2 brutal-border-b bg-[var(--color-paper)] text-sm shrink-0 flex items-start gap-3">
                <p className="flex-1">{notice}</p>
                <button className="underline" onClick={() => setNotice(undefined)}>Dismiss</button>
              </div>
            )}

            <div className="flex-1 overflow-auto dotted-bg">
              {tab === 'log' ? (
                <pre className="p-4 text-xs whitespace-pre-wrap">{state.log.join('\n') || 'Nothing yet.'}</pre>
              ) : tab === 'insights' ? (
                <InsightsView results={results} labels={labels} goldText={goldText} onGoldText={setGoldText} onAudit={startAudit} />
              ) : !results.length && !running ? (
                <ReadyPanel protocol={protocol} toScreen={toScreen} mode={mode} hitCount={hitCount.count} error={state.error}>
                  {runControl}
                </ReadyPanel>
              ) : (
                <div className="p-4 space-y-3 max-w-6xl">
                  <div className="flex flex-wrap items-center gap-2">
                    {(['all', 'include', 'unclear', 'exclude', 'failed', 'audit'] as View[])
                      .filter((v) => v === 'all' || counts[v] > 0)
                      .map((v) => (
                        <button
                          key={v}
                          className={`px-2.5 py-1 text-sm font-semibold brutal-border ${view === v ? 'bg-ink text-white' : v in DECISION_STYLE ? DECISION_STYLE[v as Decision] : 'bg-[var(--color-paper)]'}`}
                          onClick={() => setView(v)}
                        >
                          {v === 'audit' ? 'Random sample' : v[0].toUpperCase() + v.slice(1)} <span className="mono">{counts[v]}</span>
                        </button>
                      ))}
                    <input className="brutal-input !w-52 !py-1 text-sm" placeholder="Filter by text…" value={filterText} onChange={(e) => setFilterText(e.target.value)} />
                    {duplicates.size > 0 && (
                      <label className="flex items-center gap-1.5 text-sm cursor-pointer" title="SuperSeries that bundle series already in this list">
                        <input type="checkbox" checked={hideSuperSeries} onChange={(e) => setHideSuperSeries(e.target.checked)} />
                        Hide {duplicates.size} duplicate SuperSeries
                      </label>
                    )}
                    <span className="flex-1" />
                    {canExplain && topToExplain.length > 0 && !running && (
                      <button className="brutal-button px-2.5 py-1 text-sm" onClick={() => explainTargets(topToExplain)} disabled={topToExplain.some((r) => busy.has(r.gse))}>
                        <MessageSquareQuote className="w-4 h-4" /> Explain top {topToExplain.length}
                      </button>
                    )}
                  </div>
                  <LabelBar
                    results={results}
                    labels={labels}
                    calibrated={Boolean(platt)}
                    hintSeen={labelHintSeen}
                    onHintSeen={() => {
                      setLabelHintSeen(true);
                      save('omigator.labelHint', { seen: true });
                    }}
                    onDetails={() => setTab('insights')}
                    onAudit={startAudit}
                  />
                  {view === 'audit' && (
                    <p className="text-sm card p-3">
                      Ten datasets picked at random. Mark each as relevant 👍 or not 👎. Random picks give an honest estimate of how many relevant
                      datasets the decisions keep; see <b>Check accuracy</b>.
                    </p>
                  )}
                  {visible.map(({ r, rank }) => (
                    <ResultRow
                      key={r.gse}
                      result={r}
                      rank={rank}
                      protocol={shownProtocol}
                      expanded={expanded.has(r.gse)}
                      onToggle={() =>
                        setExpanded((s) => {
                          const n = new Set(s);
                          n.has(r.gse) ? n.delete(r.gse) : n.add(r.gse);
                          return n;
                        })
                      }
                      label={labels[r.gse]}
                      onLabel={(v) =>
                        setLabels((l) => {
                          const n = { ...l };
                          if (v === undefined) delete n[r.gse];
                          else n[r.gse] = v;
                          return n;
                        })
                      }
                      busy={busy.has(r.gse)}
                      onExplain={canExplain && (!demo || demo.explanations[r.gse]) ? () => explainTargets([r]) : undefined}
                      onRetry={r.error && !demo ? () => retry(r) : undefined}
                      calibrated={platt && r.screening ? plattProbability(platt, r.screening.logScore) : undefined}
                    />
                  ))}
                  {!visible.length && <p className="text-sm text-[var(--color-muted)]">Nothing in this view.</p>}
                </div>
              )}
            </div>
          </main>
        </div>
      )}
    </div>
  );
}

/** Explains what the thumbs do and, once used, what they told us. */
function LabelBar({
  results,
  labels,
  calibrated,
  hintSeen,
  onHintSeen,
  onDetails,
  onAudit,
}: {
  results: DatasetResult[];
  labels: Record<string, boolean>;
  calibrated: boolean;
  hintSeen: boolean;
  onHintSeen: () => void;
  onDetails: () => void;
  onAudit: () => void;
}) {
  const screened = results.filter((r) => r.screening);
  const marked = screened.filter((r) => labels[r.gse] !== undefined);
  const relevant = marked.filter((r) => labels[r.gse]);
  const kept = relevant.filter((r) => r.screening!.decision === 'include').length;
  const wrongIncludes = marked.filter((r) => !labels[r.gse] && r.screening!.decision === 'include').length;

  if (!marked.length) {
    if (hintSeen) return null;
    return (
      <div className="card p-3 text-sm flex flex-wrap items-start gap-3">
        <p className="flex-1 min-w-[16rem]">
          <b>Tip:</b> mark datasets you checked as relevant 👍 or not 👎 (buttons on the right). With a few marks Omigator tells you how many
          relevant datasets <i>include</i> keeps, shows a personal probability of relevance per dataset, and how far down the list you need
          to read. Marks are saved with the run and go into exports and share links.
        </p>
        <button className="brutal-button px-2 py-1 text-sm" onClick={onAudit}>Mark 10 random ones</button>
        <button className="underline text-sm" onClick={onHintSeen}>Got it</button>
      </div>
    );
  }
  return (
    <div className="card p-3 text-sm flex flex-wrap items-center gap-x-4 gap-y-1">
      <span>
        Your marks: <b>{relevant.length}</b> 👍 · <b>{marked.length - relevant.length}</b> 👎
      </span>
      {relevant.length > 0 && (
        <span>
          <i>Include</i> keeps <b>{kept} of {relevant.length}</b> relevant
          {wrongIncludes > 0 && <> · {wrongIncludes} of your 👎 are marked include</>}
        </span>
      )}
      <span className="text-[var(--color-muted)]">
        {calibrated ? 'P(relevant) per dataset is now calibrated to your marks.' : 'Mark at least 2 relevant and 2 not relevant to calibrate.'}
      </span>
      <span className="flex-1" />
      <button className="underline" onClick={onDetails}>Details</button>
    </div>
  );
}

function ReadyPanel({
  protocol,
  toScreen,
  mode,
  hitCount,
  error,
  children,
}: {
  protocol: Protocol;
  toScreen: number;
  mode: InputMode;
  hitCount?: number;
  error?: string;
  children: ReactNode;
}) {
  const n = (k: string) => protocol.criteria.filter((c) => c.kind === k).length;
  return (
    <div className="p-6 md:p-10">
      <div className="max-w-xl card brutal-shadow p-6 space-y-5">
        <h2 className="font-display uppercase text-2xl">Check the protocol, then screen</h2>
        {error && <p className="p-3 bg-[var(--color-danger)] text-white text-sm">{error}</p>}
        <ul className="space-y-2 text-sm">
          <li>
            <b>Where:</b>{' '}
            {mode === 'search'
              ? hitCount !== undefined
                ? `${hitCount.toLocaleString()} GEO series match the search; the first ${toScreen} will be screened.`
                : 'GEO search (counting matches…)'
              : `${toScreen} GSE accessions from your list.`}
          </li>
          <li>
            <b>Checklist:</b> {protocol.criteria.length} lines ({n('require')} must, {n('exclude')} must not, {n('prefer')} nice to have). Each
            dataset is checked against every line, sample annotations and linked abstract included.
          </li>
          <li>
            <b>Result:</b> a ranked list with include / unclear / exclude and the probability behind each line.
          </li>
        </ul>
        <p className="text-sm text-[var(--color-muted)]">Edit anything on the left; the checklist matters most. “Redraft” writes a new one from your request.</p>
        {children}
      </div>
    </div>
  );
}
