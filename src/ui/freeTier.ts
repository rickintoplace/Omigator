/**
 * Browser side of the free tier (server/freeTier.ts): visitors without a key screen through
 * Omigator's server, which holds the key. Only after the visitor agrees, a session starts with a
 * proof-of-work challenge solved here (about a second) and the hash of a coarse device signature;
 * it lasts two hours, and the server counts a daily quota per device. With an own key, none of
 * this runs.
 */

import { solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/pbkdf2';
import { useEffect, useState } from 'react';
import { type Criterion, type DatasetResult, DEFAULT_DECISION_MODEL, type Dossier, type DraftResult, type Explanation, type Protocol, type Scorer, type ScoreResult } from '../core';

const API = `${import.meta.env.BASE_URL}api/free`;

export type Quota = 'datasets' | 'explanations' | 'drafts';
export interface FreeTierState {
  enabled: boolean;
  limits?: Record<Quota, number>;
  /** What is left today, per quota; a quota appears once the server has reported it. */
  left?: Partial<Record<Quota, number>>;
}

let state: FreeTierState = { enabled: false };
const listeners = new Set<(s: FreeTierState) => void>();
const publish = (patch: Partial<FreeTierState>) => {
  state = { ...state, ...patch, left: patch.left ? { ...state.left!, ...patch.left } : state.left };
  for (const l of listeners) l(state);
};

let statusRequest: Promise<void> | undefined;

/** Whether the free tier is available here, and how much of today's quota is left. */
export function useFreeTier(): FreeTierState {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    statusRequest ??= fetch(`${API}?action=status`)
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((body: FreeTierState) => publish(body.enabled ? body : { enabled: false }))
      .catch(() => publish({ enabled: false }));
    return () => void listeners.delete(setS);
  }, []);
  return s;
}

const CONSENT_KEY = 'omigator.freeTier.v1';

/** Whether the visitor agreed to the free tier's device signature. Only this choice is stored. */
export function loadFreeConsent(): boolean {
  try {
    return JSON.parse(localStorage.getItem(CONSENT_KEY) ?? '{}').consent === true;
  } catch {
    return false;
  }
}

export function saveFreeConsent(consent: boolean): void {
  try {
    if (consent) localStorage.setItem(CONSENT_KEY, JSON.stringify({ consent, at: new Date().toISOString().slice(0, 10) }));
    else localStorage.removeItem(CONSENT_KEY);
  } catch {
    /* storage unavailable: the choice lasts for this page only */
  }
  if (!consent) session = undefined;
}

/**
 * A coarse device signature, so devices behind one network share no quota: deliberately few,
 * low-detail properties (no canvas, WebGL, audio or font probing). Only its SHA-256 leaves the browser.
 */
export const DEVICE_SIGNALS = ['platform', 'language', 'time zone', 'screen size and colour depth', 'pixel ratio', 'CPU cores', 'memory class', 'touch points'];

async function deviceSignature(): Promise<string> {
  const n = navigator as Navigator & { deviceMemory?: number; userAgentData?: { platform?: string } };
  const signals = [
    n.userAgentData?.platform ?? n.platform,
    n.language,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    `${screen.width}x${screen.height}x${screen.colorDepth}`,
    devicePixelRatio,
    n.hardwareConcurrency,
    n.deviceMemory,
    n.maxTouchPoints,
  ];
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(signals)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let session: { token: string; expiresAt: number } | undefined;
let pending: Promise<string> | undefined;

async function token(): Promise<string> {
  if (session && session.expiresAt * 1000 > Date.now() + 60_000) return session.token;
  if (!loadFreeConsent()) throw new Error('The free tier needs your agreement first.');
  pending ??= (async () => {
    try {
      const challenge = await (await fetch(`${API}?action=challenge`)).json();
      if (challenge.error) throw new Error(challenge.error);
      const solution = await solveChallenge({ challenge, deriveKey });
      if (!solution) throw new Error('Could not start a free-tier session. Try again.');
      const res = await fetch(`${API}?action=session`, { method: 'POST', body: JSON.stringify({ challenge, solution, device: await deviceSignature() }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Free tier: HTTP ${res.status}`);
      session = { token: body.token, expiresAt: body.expiresAt };
      publish({ left: body.left });
      return session.token;
    } finally {
      pending = undefined;
    }
  })();
  return pending;
}

/** Once a quota is used up, further requests for it fail at once instead of reaching the server. */
const exhausted = new Map<Quota, string>();

async function call<T>(action: 'draft' | 'screen' | 'explain', quota: Quota, body: unknown, signal?: AbortSignal): Promise<T> {
  const stop = exhausted.get(quota);
  if (stop) throw new Error(stop);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}?action=${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
      body: JSON.stringify(body),
      signal,
    });
    const out = await res.json().catch(() => ({ error: `Free tier: HTTP ${res.status}` }));
    // A new day or a new network ends the session; solve a new challenge once.
    if (res.status === 401 && attempt === 0) {
      session = undefined;
      continue;
    }
    if (out.left) publish({ left: out.left });
    if (!res.ok) {
      if (res.status === 429 || res.status === 503) {
        exhausted.set(quota, out.error);
        if (res.status === 429) publish({ left: { [quota]: 0 } as Record<Quota, number> });
      }
      throw new Error(out.error ?? `Free tier: HTTP ${res.status}`);
    }
    return out as T;
  }
}

/** What the server accepts of a candidate; it fetches everything else from GEO itself. */
const candidateFields = (d: Dossier) => {
  const c = d.candidate;
  return { gse: c.gse, pmids: c.pmids, pubDate: c.pubDate, organisms: c.organisms, nSamples: c.nSamples };
};
const criteriaFields = (criteria: Criterion[]) => criteria.map(({ id, kind, text }) => ({ id, kind, text }));

/** Screens through the free tier with the default decision model. */
export class FreeTierScorer implements Scorer {
  readonly id = `free:${DEFAULT_DECISION_MODEL}`;
  readonly model = DEFAULT_DECISION_MODEL;

  score(_text: string, criteria: Criterion[], signal?: AbortSignal, record?: Dossier): Promise<ScoreResult> {
    if (!record) return Promise.reject(new Error('The free tier needs the dataset record.'));
    return call<ScoreResult>('screen', 'datasets', { candidate: candidateFields(record), criteria: criteriaFields(criteria) }, signal);
  }
}

export const freeDraft = (intent: string, signal?: AbortSignal) => call<DraftResult>('draft', 'drafts', { intent }, signal);

export async function freeExplain(result: DatasetResult, protocol: Protocol): Promise<DatasetResult> {
  if (!result.dossier) throw new Error('No dossier to explain.');
  const { explanation } = await call<{ explanation: Explanation }>('explain', 'explanations', {
    candidate: candidateFields(result.dossier),
    criteria: criteriaFields(protocol.criteria),
    p: result.screening?.p,
  });
  return { ...result, explanation };
}
