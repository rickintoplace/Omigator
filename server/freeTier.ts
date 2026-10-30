/**
 * The free tier: visitors without an API key screen through Omigator's own OpenRouter key.
 *
 * The key never reaches the browser, and it can do only what Omigator does. The server does not
 * forward model requests: it accepts three actions (draft a protocol, screen a dataset, explain a
 * dataset), fetches the GEO record and abstracts itself, builds every prompt with the same core as
 * the app, and uses fixed models with capped inputs. From the browser it takes only the request
 * sentence, the criteria and a few validated fields (accession, PMIDs, date, organism).
 *
 * Fair use is kept heuristically, and abuse made unattractive and bounded, not impossible:
 *  - a proof-of-work challenge (ALTCHA, self-hosted, no cookies, no third party) per session;
 *  - a daily quota per device: the browser sends a hash of a coarse device signature (only after the
 *    visitor agreed to it), and the server counts under a keyed hash of that and the IP address,
 *    with a key that changes every day, so nothing can be reversed or linked across days. Different
 *    devices behind one university network get their own quota;
 *  - the key's own daily spending limit at OpenRouter as the hard cap.
 * Visitors with their own key never reach this server.
 *
 * Setup (Vercel; `npm run dev` runs it locally with `.env`):
 *   OPENROUTER_KEY_FAIRUSE  OpenRouter key with a daily credit limit, used for nothing else (required)
 *   FREE_TIER_SECRET        random string of at least 32 characters, e.g. `openssl rand -base64 48` (required)
 *   NCBI_API_KEY, NCBI_EMAIL  raise NCBI's rate limit for the server's own GEO and PubMed requests
 *   KV_REST_API_URL, KV_REST_API_TOKEN  optional Upstash Redis for exact quotas (two commands per paid
 *                           action); without it each instance counts in memory. Update legal.html if set.
 *   FREE_TIER_ORIGINS       allowed browser origins, comma-separated
 * Without the key or the secret the free tier stays off, and the app asks for a key.
 */

import { createChallenge, randomInt, verifySolution } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/pbkdf2';
import { DecisionsJudge } from 'veriquote';
import {
  buildDossier,
  type Candidate,
  type Criterion,
  DecisionScorer,
  DEFAULT_CHAT_MODEL,
  DEFAULT_DECISION_MODEL,
  draftProtocol,
  explain,
  type Explanation,
  fetchSeries,
  HttpError,
  judgeSupport,
  Ncbi,
  openrouter,
  PAPERS_PER_DATASET,
  type Paper,
  type Series,
} from '../src/core/index.js';

export const LIMITS = { datasets: 1000, explanations: 20, drafts: 20 } as const;
export type Quota = keyof typeof LIMITS;

const SESSION_SECONDS = 2 * 3600;
const CHALLENGE_SECONDS = 600;
const MAX_BODY = 32_000;

/**
 * Daily counters: Upstash Redis, or a Map (development, tests, or production without a database,
 * where each server instance counts on its own). The store is touched only by paid, authenticated
 * actions, so nobody can run up database requests without also spending the model budget.
 */
export interface Store {
  /** Adds `by` and returns the new value; the key expires `ttl` seconds after it was created. */
  incr(key: string, by: number, ttl: number): Promise<number>;
}

export function memoryStore(): Store {
  const m = new Map<string, { v: number; exp: number }>();
  const live = (k: string) => {
    const e = m.get(k);
    if (e && e.exp < Date.now()) m.delete(k);
    return m.get(k);
  };
  return {
    async incr(k, by, ttl) {
      const e = live(k) ?? { v: 0, exp: Date.now() + ttl * 1000 };
      e.v += by;
      m.set(k, e);
      // Bounded, so a flood of visitors cannot grow the instance's memory without end.
      if (m.size > 50_000) for (const key of [...m.keys()].slice(0, 10_000)) m.delete(key);
      return e.v;
    },
  };
}

export interface FreeTierConfig {
  /** OpenRouter key with a daily limit; used for nothing but the actions below. */
  openrouterKey: string;
  /** Random secret (≥ 32 characters) for challenge signatures, session tokens and IP hashes. */
  secret: string;
  store: Store;
  /** Origins allowed to call the API from a browser. Requests without an Origin header pass. */
  origins: string[];
  ncbiApiKey?: string;
  ncbiEmail?: string;
  /** For tests. */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

// --- crypto helpers (Web Crypto, so this runs in Node, edge runtimes and tests alike) ---

const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

/** Purpose-bound subkeys, so one secret serves challenges, tokens and IP hashes independently. */
const subkey = (secret: string, purpose: string) => hmac(secret, `omigator-free-tier:${purpose}`);

const day = (now: number) => new Date(now).toISOString().slice(0, 10);

const clientIp = (req: Request) => (req.headers.get('x-real-ip') || req.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown').trim();

/**
 * Keyed with the secret and the date: not reversible, and not linkable from one day to the next.
 * Without `device` it identifies the network (to bind a challenge), with it the device on that network.
 */
async function visitorId(cfg: FreeTierConfig, req: Request, now: number, device = ''): Promise<string> {
  return (await hmac(await subkey(cfg.secret, 'visitor'), `${day(now)}|${clientIp(req)}|${device}`)).slice(0, 32);
}

/** The browser's hash of its coarse device signature: SHA-256, hex. */
const DEVICE = /^[0-9a-f]{64}$/;

async function issueToken(cfg: FreeTierConfig, visitor: string, device: string, exp: number): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ v: visitor, d: device, exp })));
  return `${body}.${await hmac(await subkey(cfg.secret, 'token'), body)}`;
}

/** The visitor a valid session token stands for; refused when the day or the network has changed. */
async function checkToken(cfg: FreeTierConfig, req: Request, now: number): Promise<string> {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const [body, sig] = token.split('.');
  if (!body || !sig || sig !== (await hmac(await subkey(cfg.secret, 'token'), body))) throw new Refusal(401, 'session');
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as { v: string; d: string; exp: number };
  // A new day or a new network gives a new visitor id; the browser then solves a new challenge.
  if (claims.exp * 1000 < now || claims.v !== (await visitorId(cfg, req, now, claims.d))) throw new Refusal(401, 'session');
  return claims.v;
}

// --- quotas ---

const quotaKey = (visitor: string, q: Quota, now: number) => `omigator:q:${day(now)}:${visitor}:${q}`;

/** Visitors over a quota today, remembered per server instance so their retries cost no database request. */
const over = new Map<string, string>();

/** Takes one unit of quota for `work`, and gives it back when the work fails. */
async function withQuota<T>(cfg: FreeTierConfig, visitor: string, q: Quota, now: number, work: () => Promise<T>): Promise<T & { left: Partial<Record<Quota, number>> }> {
  const key = quotaKey(visitor, q, now);
  const refusal = () => new Refusal(429, `The free tier allows ${LIMITS[q].toLocaleString('en')} ${q} per day. Add your own OpenRouter key in Settings for more.`);
  if (over.get(key) === day(now)) throw refusal();
  const used = await cfg.store.incr(key, 1, 24 * 3600);
  if (used > LIMITS[q]) {
    if (over.size > 10_000) over.clear();
    over.set(key, day(now));
    throw refusal();
  }
  try {
    return { ...(await work()), left: { [q]: LIMITS[q] - used } };
  } catch (err) {
    await cfg.store.incr(key, -1, 24 * 3600);
    throw err;
  }
}

// --- input validation: only the shapes Omigator sends ---

function str(v: unknown, max: number, name: string, pattern?: RegExp): string {
  if (typeof v !== 'string' || v.length > max || (pattern && !pattern.test(v))) throw new Refusal(400, `Invalid ${name}.`);
  return v;
}

export function validCriteria(raw: unknown): Criterion[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 12) throw new Refusal(400, 'Send 1 to 12 criteria.');
  return raw.map((c) => ({
    id: str(c?.id, 64, 'criterion id', /^[a-z0-9_]+$/),
    kind: str(c?.kind, 10, 'criterion kind', /^(require|exclude|prefer)$/) as Criterion['kind'],
    text: str(c?.text, 400, 'criterion text', /\S/),
  }));
}

/**
 * The browser's candidate, reduced to fields the dossier takes from it when the GEO record is
 * there: accession, date, organism names, sample count and PMIDs. Titles and summaries come from GEO.
 */
export function validCandidate(raw: unknown): Candidate {
  const c = (raw ?? {}) as Record<string, unknown>;
  const pmids = Array.isArray(c.pmids) ? c.pmids.slice(0, PAPERS_PER_DATASET).map((p) => str(p, 12, 'PMID', /^\d+$/)) : [];
  const n = Number(c.nSamples);
  return {
    gse: str(c.gse, 16, 'accession', /^GSE\d+$/),
    uid: '',
    title: '',
    summary: '',
    seriesType: '',
    organisms: str(c.organisms ?? '', 300, 'organisms', /^[A-Za-z0-9 .;,()'/-]*$/),
    nSamples: Number.isInteger(n) && n >= 0 && n < 1e6 ? n : 0,
    pubDate: str(c.pubDate ?? '', 10, 'date', /^(\d{4}\/\d{2}\/\d{2})?$/),
    pmids,
  };
}

// --- the actions ---

async function dossierFor(cfg: FreeTierConfig, candidate: Candidate, signal: AbortSignal) {
  const ncbi = new Ncbi({ apiKey: cfg.ncbiApiKey, email: cfg.ncbiEmail });
  let series: Series | undefined;
  let c = candidate;
  try {
    series = await fetchSeries(c.gse, { signal, fetch: cfg.fetch });
  } catch {
    // Without the family file, the series text must come from NCBI, never from the browser.
    const [uid] = await ncbi.uidsForAccessions([c.gse], signal);
    const [summary] = uid ? await ncbi.summaries([uid], signal) : [];
    if (!summary) throw new Refusal(404, `GEO has no record for ${c.gse}.`);
    c = summary;
  }
  const papers: Paper[] = c.pmids.length ? [...(await ncbi.papers(c.pmids, signal).catch(() => new Map<string, Paper>())).values()] : [];
  const linked = c.pmids.flatMap((id) => papers.filter((p) => p.pmid === id));
  return buildDossier(c, series, linked, series ? [] : ['Sample metadata unavailable.']);
}

async function act(cfg: FreeTierConfig, action: string, req: Request, visitor: string, now: number, signal: AbortSignal) {
  const raw = await req.text();
  if (raw.length > MAX_BODY) throw new Refusal(413, 'Request too large.');
  const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
  const ep = openrouter(cfg.openrouterKey);

  switch (action) {
    case 'draft': {
      const intent = str(body.intent, 600, 'request', /\S/);
      return withQuota(cfg, visitor, 'drafts', now, async () => {
        const draft = await draftProtocol(intent, ep, DEFAULT_CHAT_MODEL, signal);
        // A protocol has a search and short criteria; anything longer is not a protocol.
        const { query, criteria } = draft.protocol;
        if (query.length > 2000 || criteria.length > 12 || criteria.some((c) => c.text.length > 400)) {
          throw new Refusal(422, 'The draft was not usable. Rephrase the request, or write the protocol yourself.');
        }
        return draft;
      });
    }
    case 'screen': {
      const criteria = validCriteria(body.criteria);
      const candidate = validCandidate(body.candidate);
      return withQuota(cfg, visitor, 'datasets', now, async () => {
        const dossier = await dossierFor(cfg, candidate, signal);
        return new DecisionScorer(ep, DEFAULT_DECISION_MODEL).score(dossier.text, criteria, signal);
      });
    }
    case 'explain': {
      const criteria = validCriteria(body.criteria);
      const candidate = validCandidate(body.candidate);
      const p: Record<string, number> = {};
      for (const c of criteria) {
        const v = (body.p as Record<string, unknown> | undefined)?.[c.id];
        if (typeof v === 'number' && v >= 0 && v <= 1) p[c.id] = v;
      }
      return withQuota(cfg, visitor, 'explanations', now, async () => {
        const dossier = await dossierFor(cfg, candidate, signal);
        const answer = await explain(dossier, criteria, p, ep, DEFAULT_CHAT_MODEL, signal);
        const judge = { judge: new DecisionsJudge({ apiKey: cfg.openrouterKey, model: DEFAULT_DECISION_MODEL }), id: `decisions:${DEFAULT_DECISION_MODEL}` };
        const support = await judgeSupport(answer, dossier, criteria, judge, signal);
        // Texts are capped at the lengths the prompt asks for: an explanation, not a free chat answer.
        const explanation: Explanation = {
          ...answer,
          summary: answer.summary.slice(0, 400),
          criteria: Object.fromEntries(
            Object.entries(answer.criteria).map(([id, ex]) => [
              id,
              { ...ex, note: ex.note?.slice(0, 200), quotes: ex.quotes.map((q) => ({ ...q, text: q.text.slice(0, 300) })), support: support[id] },
            ]),
          ),
        };
        return { explanation };
      });
    }
    default:
      throw new Refusal(404, 'Unknown action.');
  }
}

/** One endpoint: GET ?action=status|challenge, POST ?action=session|draft|screen|explain. */
export async function handleFreeTier(req: Request, cfg: FreeTierConfig): Promise<Response> {
  const now = cfg.now?.() ?? Date.now();
  const action = new URL(req.url).searchParams.get('action') ?? '';
  const origin = req.headers.get('origin');
  if (origin && !cfg.origins.includes(origin)) return json(403, { error: 'Origin not allowed.' });

  try {
    if (req.method === 'GET' && action === 'status') {
      return json(200, { enabled: true, limits: LIMITS });
    }

    if (req.method === 'GET' && action === 'challenge') {
      const challenge = await createChallenge({
        algorithm: 'PBKDF2/SHA-256',
        cost: 2000,
        counter: randomInt(2000, 6000),
        deriveKey,
        hmacSignatureSecret: await subkey(cfg.secret, 'altcha'),
        hmacKeySignatureSecret: await subkey(cfg.secret, 'altcha-key'),
        expiresAt: Math.floor(now / 1000) + CHALLENGE_SECONDS,
        data: { n: await visitorId(cfg, req, now) },
      });
      return json(200, challenge);
    }

    if (req.method !== 'POST') throw new Refusal(405, 'Method not allowed.');

    if (action === 'session') {
      const body = JSON.parse((await req.text()).slice(0, MAX_BODY)) as { challenge?: never; solution?: never; device?: unknown };
      if (!body.challenge || !body.solution) throw new Refusal(400, 'Missing solution.');
      if (typeof body.device !== 'string' || !DEVICE.test(body.device)) throw new Refusal(400, 'Missing device signature.');
      const result = await verifySolution({
        challenge: body.challenge,
        solution: body.solution,
        deriveKey,
        hmacSignatureSecret: await subkey(cfg.secret, 'altcha'),
        hmacKeySignatureSecret: await subkey(cfg.secret, 'altcha-key'),
      }).catch(() => ({ verified: false }));
      const params = (body.challenge as { parameters?: { data?: { n?: string } } }).parameters;
      // The challenge was issued to this network; the session is for this device on it.
      if (!result.verified || params?.data?.n !== (await visitorId(cfg, req, now))) throw new Refusal(403, 'Challenge not solved.');
      const exp = Math.floor(now / 1000) + SESSION_SECONDS;
      const visitor = await visitorId(cfg, req, now, body.device);
      return json(200, { token: await issueToken(cfg, visitor, body.device, exp), expiresAt: exp, limits: LIMITS });
    }

    const visitor = await checkToken(cfg, req, now);
    return json(200, await act(cfg, action, req, visitor, now, req.signal));
  } catch (err) {
    if (err instanceof Refusal) return json(err.status, { error: err.message });
    // OpenRouter answers 402/403 once the key's daily limit is spent.
    if (err instanceof HttpError && err.url.includes('openrouter.ai') && (err.status === 402 || err.status === 403)) {
      return json(503, { error: "The free tier has used up today's budget. Try again tomorrow, or add your own OpenRouter key in Settings." });
    }
    if (err instanceof SyntaxError) return json(400, { error: 'Invalid JSON.' });
    return json(502, { error: (err as Error).message.slice(0, 300) });
  }
}

/** Configuration from the environment; undefined when the free tier is not set up. */
export async function configFromEnv(env: Record<string, string | undefined>): Promise<FreeTierConfig | undefined> {
  const openrouterKey = env.OPENROUTER_KEY_FAIRUSE?.trim();
  // Local development (not on Vercel) may run without a secret.
  const secret = env.FREE_TIER_SECRET?.trim() || (!env.VERCEL ? b64url(crypto.getRandomValues(new Uint8Array(32))) : '');
  if (!openrouterKey || secret.length < 32) return undefined;
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  let store: Store;
  if (url && token) {
    const { Redis } = await import('@upstash/redis');
    const redis = new Redis({ url, token });
    store = {
      async incr(k, by, ttl) {
        const [v] = await redis.multi().incrby(k, by).expire(k, ttl, 'NX').exec<[number, number]>();
        return v;
      },
    };
  } else {
    // Without a database each server instance counts on its own: quotas are approximate, the OpenRouter limit holds.
    store = memoryStore();
  }
  return {
    openrouterKey,
    secret,
    store,
    origins: (env.FREE_TIER_ORIGINS ?? 'https://omigator.rickinto.place,http://localhost:3000,http://localhost:3001').split(',').map((s) => s.trim()),
    ncbiApiKey: env.NCBI_API_KEY?.trim() || undefined,
    ncbiEmail: env.NCBI_EMAIL?.trim() || undefined,
  };
}
