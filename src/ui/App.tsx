import { Download, ExternalLink, FileJson, Link2, LoaderCircle, Lock, MessageSquareQuote, Play, Plus, Quote, Settings as SettingsIcon, Square } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { buildGdsTerm, type DatasetResult, type Decision, draftProtocol, fitPlatt, loadDossier, normalizeGseList, plattProbability, type Protocol } from '../core';
import { CiteDialog, GITHUB_URL } from './components/CiteDialog';
import { DnaProgress } from './components/DnaProgress';
import { InsightsView } from './components/InsightsView';
import { Logo } from './components/Logo';
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

/**
 * Navigation state. Every screen, tab and dialog is a history entry, so the browser's back button
 * does what one expects; the run itself is addressed in the hash (#run=…, #s=…, #demo, #edit).
 */
interface Nav {
  screen: 'start' | 'workspace';
  tab: Tab;
  dialog?: 'settings' | 'cite';
}

const TAB_PARAM: Record<Tab, string | undefined> = { results: undefined, insights: 'accuracy', log: 'log' };

function hashParams(): URLSearchParams {
  return new URLSearchParams(location.hash.slice(1));
}

function navFromUrl(): Nav {
  const p = hashParams();
  const tab = (Object.keys(TAB_PARAM) as Tab[]).find((t) => TAB_PARAM[t] && TAB_PARAM[t] === p.get('tab')) ?? 'results';
  const workspace = ['run', 's', 'demo', 'edit'].some((k) => p.has(k));
  return { screen: workspace ? 'workspace' : 'start', tab };
}

/** The run part of the hash: run=…, s=…, demo or edit. */
function runHashFromUrl(): string {
  const p = hashParams();
  for (const k of ['run', 's']) if (p.get(k)) return `${k}=${p.get(k)}`;
  return p.has('demo') ? 'demo' : '';
}

type Transition = { ready: Promise<void>; finished: Promise<void>; updateCallbackDone: Promise<void> };

function withTransition(update: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => Transition };
  if (!doc.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) return update();
  const t = doc.startViewTransition(() => flushSync(update));
  // A newer navigation skips the running animation; that is expected, not an error.
  for (const p of [t.ready, t.finished, t.updateCallbackDone]) p.catch(() => undefined);
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [keys, setKeys] = useState<Keys>(loadKeys);
  const [protocol, setProtocol] = useState<Protocol>(() => load('omigator.protocol.v2', EMPTY_PROTOCOL));
  const [workspace, setWorkspace] = useState(() => navFromUrl().screen === 'workspace');
  const [mode, setMode] = useState<InputMode>('search');
  const [retmax, setRetmax] = useState(200);
  const [gseText, setGseText] = useState('');
  const [labels, setLabels] = useState<Record<string, boolean>>(() => load('omigator.labels.v2', {}));
  const [goldText, setGoldText] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showCite, setShowCite] = useState(false);
  const [tab, setTab] = useState<Tab>(() => navFromUrl().tab);
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

  const navRef = useRef<Nav>(navFromUrl());
  // Read inside the popstate handler, which is registered once.
  const runningRef = useRef(false);
  runningRef.current = running;
  const stopRef = useRef(stop);
  stopRef.current = stop;
  const runHashRef = useRef(runHashFromUrl());
  const runIdRef = useRef<string | undefined>(undefined);
  runIdRef.current = runId;

  const urlFor = (n: Nav) => {
    if (n.screen === 'start') return `${location.pathname}${location.search}`;
    const parts = [runHashRef.current || 'edit'];
    if (TAB_PARAM[n.tab]) parts.push(`tab=${TAB_PARAM[n.tab]}`);
    return `#${parts.join('&')}`;
  };
  const applyNav = (n: Nav) => {
    // Leaving the workspace ends a run in progress; results so far are kept (and saved).
    if (n.screen === 'start' && runningRef.current) stopRef.current();
    navRef.current = n;
    setWorkspace(n.screen === 'workspace');
    setTab(n.tab);
    setShowSettings(n.dialog === 'settings');
    setShowCite(n.dialog === 'cite');
  };
  const navigate = (patch: Partial<Nav>, how: 'push' | 'replace' = 'push') => {
    const n: Nav = { ...navRef.current, dialog: undefined, ...patch };
    history[how === 'push' ? 'pushState' : 'replaceState']({ omigator: n }, '', urlFor(n));
    withTransition(() => applyNav(n));
  };
  /** Points the address bar at the current run without adding a history entry. */
  const setRunHash = (h: string) => {
    runHashRef.current = h;
    history.replaceState({ omigator: navRef.current }, '', urlFor(navRef.current));
  };
  const openSettings = () => navigate({ dialog: 'settings' });
  const closeDialog = () => (history.state?.omigator?.dialog ? history.back() : navigate({ dialog: undefined }, 'replace'));

  const showRun = (data: Parameters<typeof loadRun>[0], runHash: string, how: 'push' | 'replace') => {
    setProtocol(data.protocol);
    setMode(data.input.mode);
    if (data.input.mode === 'search') setRetmax(data.input.retmax);
    else setGseText(data.input.gses.join('\n'));
    setView('all');
    setExpanded(new Set());
    loadRun(data);
    runHashRef.current = runHash;
    navigate({ screen: 'workspace', tab: how === 'replace' ? navRef.current.tab : 'results' }, how);
  };

  const openSavedRun = async (id: string, how: 'push' | 'replace') => {
    const run = await fetchRun(id);
    if (!run) {
      setNotice('This run is not saved in this browser any more.');
      return;
    }
    setRunId(id);
    showRun({ ...run, message: `Saved run from ${(run.manifest?.createdAt ?? '').slice(0, 10)}`, source: 'saved' }, `run=${id}`, how);
  };

  const openSharedRun = (encoded: string, how: 'push' | 'replace') => {
    setNotice('Opening shared run…');
    openShared(encoded, makeNcbi(keys, settings))
      .then((run) => {
        setLabels((l) => ({ ...run.labels, ...l }));
        setRunId(undefined);
        showRun({ ...run, message: `Shared run from ${run.manifest.createdAt.slice(0, 10)}`, source: 'shared' }, `s=${encoded}`, how);
        setNotice(undefined);
      })
      .catch((err) => setNotice(`Could not open this link: ${(err as Error).message}`));
  };

  /** Shows whatever run the address points to, unless it is already on screen. */
  const openFromUrl = (how: 'push' | 'replace') => {
    const p = hashParams();
    if (p.get('run') && p.get('run') !== runIdRef.current) openSavedRun(p.get('run')!, how);
    else if (p.get('s') && `s=${p.get('s')}` !== runHashRef.current) openSharedRun(p.get('s')!, how);
    else if (p.has('demo') && !state.demo) openDemo();
  };

  useEffect(() => {
    listRuns().then(setRecent);
    history.replaceState({ omigator: navRef.current }, '', location.href);
    runHashRef.current = '';
    openFromUrl('replace');
    const onPop = (e: PopStateEvent) => {
      const n: Nav = e.state?.omigator ?? navFromUrl();
      const target = runHashFromUrl();
      if (target && target !== runHashRef.current) openFromUrl('replace');
      runHashRef.current = target || runHashRef.current;
      withTransition(() => applyNav(n));
    };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
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
      if (!runHashRef.current.startsWith('s=')) setRunHash(`run=${id}`);
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
      if (!workspace) startFresh();
    } catch (err) {
      setDraftError((err as Error).message);
    } finally {
      setDrafting(false);
    }
  };

  const screen = (withKeys: Keys = keys) => {
    if (blocker) return;
    setRunId(undefined);
    runHashRef.current = '';
    navigate({ tab: 'results' }, 'replace');
    setView('all');
    setExpanded(new Set());
    start(protocol, mode === 'search' ? { mode, retmax } : { mode, gses: normalizeGseList(gseText) }, makeNcbi(withKeys, settings), makeScorer(withKeys, settings));
  };

  async function openDemo() {
    try {
      const rec = await loadDemo();
      setProtocol(rec.protocol);
      setMode('search');
      setRetmax(rec.retmax);
      setGoldText(rec.gold.join(', '));
      setRunId(undefined);
      runHashRef.current = 'demo';
      navigate({ screen: 'workspace', tab: 'results' }, hashParams().has('demo') ? 'replace' : 'push');
      setView('all');
      setExpanded(new Set());
      startDemo(rec);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  /** Clears the run on screen; the previous one stays reachable with the back button. */
  function clearRun() {
    reset();
    setRunId(undefined);
    runHashRef.current = '';
    setNotice(undefined);
    setGoldText('');
    setAudit([]);
  }

  /** From the start screen into an empty workspace for the protocol just chosen or drafted. */
  function startFresh() {
    clearRun();
    navigate({ screen: 'workspace', tab: 'results' });
  }

  const newRequest = () => {
    clearRun();
    setProtocol(EMPTY_PROTOCOL);
    setGseText('');
    navigate({ screen: 'start', tab: 'results' });
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
    if (tab !== 'results') navigate({ tab: 'results' });
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
      <button className="brutal-button button-primary w-full py-2.5" onClick={newRequest}>
        <Plus className="w-4 h-4" /> Start your own request
      </button>
    </div>
  ) : !scorerReady && needsOpenRouterKey ? (
    <KeyPrompt reason="Screening uses a decision model." remember={settings.rememberKeys} onSave={(k, r) => screen(saveOpenRouterKey(k, r))} onOpenSettings={openSettings} />
  ) : (
    <div className="space-y-1.5">
      <button className="brutal-button button-primary w-full py-3 text-base" onClick={() => (scorerReady ? screen() : openSettings())} disabled={Boolean(blocker)}>
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
      {showSettings && <SettingsDialog settings={settings} keys={keys} onSettings={setSettings} onKeys={setKeys} onClose={closeDialog} />}
      {showCite && <CiteDialog version={VERSION} onClose={closeDialog} />}

      <header className="site-header flex items-center gap-3 px-4 py-2 brutal-border-b bg-[var(--color-accent)] shrink-0">
        <button className="logo-home flex items-center gap-2" onClick={() => navigate({ screen: 'start' })} title="Home">
          <Logo active={running} className="h-10 w-auto" />
          <span className="font-display text-xl uppercase leading-none">Omigator</span>
        </button>
        <span className="text-xs mono hidden sm:inline">v{VERSION}</span>
        <span className="flex-1" />
        {workspace && (
          <button className="brutal-button px-3 py-1.5 text-sm bg-white" onClick={newRequest}>
            <Plus className="w-4 h-4" /> New request
          </button>
        )}
        <button className="brutal-button px-3 py-1.5 text-sm bg-white" onClick={openSettings}>
          <SettingsIcon className="w-4 h-4" /> Settings
          <span className={`w-2 h-2 rounded-full ${scorerReady ? 'bg-green-600' : 'bg-red-500'}`} title={scorerReady ? 'Ready' : 'Key missing'} />
        </button>
        <button className="brutal-button px-3 py-1.5 text-sm bg-white hidden md:inline-flex" onClick={() => navigate({ dialog: 'cite' })}>
          <Quote className="w-4 h-4" /> Cite
        </button>
        <a className="brutal-button px-3 py-1.5 text-sm bg-white hidden md:inline-flex" href={GITHUB_URL} target="_blank" rel="noreferrer">
          Code <ExternalLink className="w-3.5 h-3.5" />
        </a>
        <span className="hidden lg:flex flex-col text-xs leading-tight">
          <a className="link" href="/legal.html#privacy">Privacy</a>
          <a className="link" href="/legal.html#imprint">Imprint</a>
        </span>
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
              startFresh();
            }}
            onManual={startFresh}
            onDemo={openDemo}
            onOpenSettings={openSettings}
            recent={recent}
            onOpenRun={(id) => openSavedRun(id, 'push')}
          />
        </main>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col md:flex-row">
          <aside className="md:w-[27rem] shrink-0 flex flex-col brutal-border-r bg-[var(--color-surface)] min-h-0">
            {(demo || running) && (
              <div className="flex items-center gap-2 px-4 py-2 brutal-border-b bg-[var(--color-warn)] text-sm">
                <Lock className="w-4 h-4 shrink-0" />
                {demo ? 'Recorded demo: this protocol is read-only.' : 'Locked while screening. Stop the run to edit.'}
              </div>
            )}
            <div className={`flex-1 overflow-y-auto p-4 ${demo || running ? 'locked' : ''}`} title={demo ? 'Read-only in the demo' : running ? 'Locked while screening' : undefined}>
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
                  <button key={t} className={`px-3 py-1 ${i ? 'border-l-2 border-[var(--color-ink)]' : ''} ${tab === t ? 'bg-ink text-white' : 'hover-surface'}`} onClick={() => tab !== t && navigate({ tab: t })}>
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
              <div className="px-4 py-1.5 brutal-border-b bg-[var(--color-surface)] shrink-0">
                <DnaProgress done={state.done} total={state.total} className="h-6" />
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
                <button className="link" onClick={() => setNotice(undefined)}>Dismiss</button>
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
                          className={`brutal-button px-2.5 py-1 text-sm ${view === v ? 'bg-ink text-white' : v in DECISION_STYLE ? DECISION_STYLE[v as Decision] : ''}`}
                          aria-pressed={view === v}
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
                    onDetails={() => navigate({ tab: 'insights' })}
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
        <button className="link text-sm" onClick={onHintSeen}>Got it</button>
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
      <button className="link" onClick={onDetails}>Details</button>
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
