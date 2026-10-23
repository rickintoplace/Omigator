import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type Cache,
  type Candidate,
  type DatasetResult,
  explainResult,
  isAbort,
  mapPool,
  noCache,
  type Protocol,
  rescreen,
  run,
  type RunInput,
  type RunManifest,
  type Scorer,
  sleep,
  sortResults,
  type Ncbi,
  type Endpoint,
} from '../core';
import type { DemoRecording } from './demo';
import { createIdbCache } from './idbCache';

export type RunStatus = 'idle' | 'running' | 'done' | 'error';

export interface RunState {
  status: RunStatus;
  message: string;
  total: number;
  done: number;
  results: DatasetResult[];
  manifest?: RunManifest;
  protocol?: Protocol;
  scorer?: Scorer;
  error?: string;
  log: string[];
  /** Set while showing the recorded demo run. */
  demo?: DemoRecording;
  input?: RunInput;
  /** Where the results came from: a run in this tab, a saved run, or a shared link. */
  source?: 'run' | 'saved' | 'shared';
}

const INITIAL: RunState = { status: 'idle', message: '', total: 0, done: 0, results: [], log: [] };

export function useRun(appVersion: string) {
  const [state, setState] = useState<RunState>(INITIAL);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);
  const cacheRef = useRef<Cache>(noCache);

  useEffect(() => {
    createIdbCache().then((c) => (cacheRef.current = c));
  }, []);

  /** Ends the current run; a cancelled run no longer writes to the state. */
  const cancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
  };

  const log = (message: string) =>
    setState((s) => ({ ...s, log: [...s.log.slice(-300), `${new Date().toLocaleTimeString()}  ${message}`] }));

  const start = useCallback(
    async (protocol: Protocol, input: RunInput, ncbi: Ncbi, scorer: Scorer) => {
      cancel();
      const controller = new AbortController();
      abortRef.current = controller;
      // A run replaced by another (or by reset/load) finishes in the background; only the current one reports.
      const current = () => abortRef.current === controller;
      const byGse = new Map<string, DatasetResult>();
      setState({ ...INITIAL, status: 'running', message: 'Starting…', protocol, scorer, input, source: 'run' });

      try {
        const out = await run({
          protocol,
          input,
          ncbi,
          scorer,
          cache: cacheRef.current,
          signal: controller.signal,
          appVersion,
          onEvent: (e) => {
            if (!current()) return;
            if (e.type === 'phase') {
              setState((s) => ({ ...s, message: e.message }));
              log(e.message);
            } else if (e.type === 'search') {
              log(`Query: ${e.term} → ${e.count} series, ${e.retrieved} retrieved`);
            } else if (e.type === 'candidates') {
              const r = e.removed;
              log(`${e.candidates.length} pass filters (removed: organism ${r.organism}, assay ${r.assay}, samples ${r.samples}, date ${r.date})`);
              for (const c of e.candidates) byGse.set(c.gse, { gse: c.gse, candidate: c as Candidate });
              setState((s) => ({ ...s, total: e.candidates.length, results: [...byGse.values()] }));
            } else if (e.type === 'result') {
              byGse.set(e.result.gse, e.result);
              if (e.result.error) log(`${e.result.gse}: ${e.result.error}`);
              setState((s) => ({ ...s, done: s.done + 1, results: sortResults([...byGse.values()]) }));
            } else if (e.type === 'log') log(e.message);
          },
        });
        if (!current()) return;
        setState((s) => ({ ...s, status: 'done', results: out.results, manifest: out.manifest, message: out.manifest.counts.failed ? `${out.manifest.counts.failed} datasets failed — retry them from their row.` : 'Done.' }));
      } catch (err) {
        if (!current()) return;
        if (isAbort(err, controller.signal)) {
          setState((s) => ({ ...s, status: 'done', message: 'Stopped. Results so far are kept.' }));
        } else {
          setState((s) => ({ ...s, status: 'error', error: (err as Error).message, message: (err as Error).message }));
          log(`Error: ${(err as Error).message}`);
        }
      }
    },
    [appVersion],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const reset = useCallback(() => {
    cancel();
    setState(INITIAL);
  }, []);

  /** Shows results that were saved or shared (no run in progress). */
  const load = useCallback(
    (data: { results: DatasetResult[]; protocol: Protocol; input: RunInput; manifest?: RunManifest; message: string; source: 'saved' | 'shared' }) => {
      cancel();
      setState({ ...INITIAL, status: 'done', total: data.results.length, done: data.results.length, ...data });
    },
    [],
  );

  /** Replaces one result in place (e.g. after loading its evidence on demand). */
  const patch = useCallback((r: DatasetResult) => update(r), []);

  /** Replays a recorded run with roughly the pacing of a real one (about 8 s in total). */
  const startDemo = useCallback(async (demo: DemoRecording) => {
    cancel();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    const pending = demo.results.map((r) => ({ gse: r.gse, candidate: r.candidate }));
    const shown = new Map<string, DatasetResult>(pending.map((r) => [r.gse, r]));
    setState({ ...INITIAL, status: 'running', demo, protocol: demo.protocol, input: { mode: 'search', retmax: demo.retmax }, message: 'Searching GEO… (recorded run)', total: pending.length, results: [] });
    try {
      await sleep(700, signal);
      setState((s) => ({ ...s, message: `Screening ${pending.length} datasets with ${demo.manifest.scorer.model}… (recorded run)`, results: [...shown.values()] }));
      // Datasets finish in a shuffled order, as they do with parallel requests.
      const order = [...demo.results].sort((a, b) => hash(a.gse) - hash(b.gse));
      const step = Math.max(10, 7000 / order.length);
      for (const r of order) {
        await sleep(step, signal);
        shown.set(r.gse, r);
        setState((s) => ({ ...s, done: s.done + 1, results: sortResults([...shown.values()]) }));
      }
      setState((s) => ({ ...s, status: 'done', manifest: demo.manifest, results: demo.results, message: `Recorded run from ${demo.recordedAt}.` }));
    } catch {
      if (abortRef.current !== controller) return;
      setState((s) => ({ ...s, status: 'done', message: 'Demo stopped.' }));
    }
  }, []);

  const update = (r: DatasetResult) =>
    setState((s) => {
      const results = sortResults(s.results.map((x) => (x.gse === r.gse ? r : x)));
      const extra = (r.explanation?.cost ?? 0) - (s.results.find((x) => x.gse === r.gse)?.explanation?.cost ?? 0);
      const manifest = s.manifest && { ...s.manifest, cost: { ...s.manifest.cost, explanations: s.manifest.cost.explanations + Math.max(0, extra) } };
      return { ...s, results, manifest };
    });

  const withBusy = async (gses: string[], fn: () => Promise<void>) => {
    setBusy((b) => new Set([...b, ...gses]));
    try {
      await fn();
    } finally {
      setBusy((b) => new Set([...b].filter((g) => !gses.includes(g))));
    }
  };

  const explainMany = useCallback(
    async (targets: DatasetResult[], ep?: Endpoint, model?: string) => {
      const protocol = state.protocol;
      if (!protocol) return;
      const demo = state.demo;
      if (demo) {
        await withBusy(targets.map((t) => t.gse), async () => {
          await sleep(900);
          for (const t of targets) if (demo.explanations[t.gse]) update({ ...t, explanation: demo.explanations[t.gse] });
        });
        return;
      }
      if (!ep || !model) return;
      await withBusy(
        targets.map((t) => t.gse),
        async () => {
          await mapPool(targets, 4, async (t) => {
            try {
              update(await explainResult(t, protocol, ep, model, { cache: cacheRef.current }));
            } catch (err) {
              log(`Explain ${t.gse}: ${(err as Error).message}`);
            }
          });
        },
      );
    },
    [state.protocol, state.demo],
  );

  const retry = useCallback(
    async (target: DatasetResult) => {
      if (!state.protocol || !state.scorer) return;
      const { protocol, scorer } = state;
      await withBusy([target.gse], async () => {
        try {
          update(await rescreen(target, protocol, scorer, { cache: cacheRef.current }));
        } catch (err) {
          update({ ...target, error: (err as Error).message });
        }
      });
    },
    [state.protocol, state.scorer],
  );

  return { state, busy, start, startDemo, stop, reset, load, patch, explainMany, retry, cache: cacheRef };
}

/** Stable pseudo-random order for the demo replay. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
