/**
 * Model endpoints. OpenRouter is called directly from the browser (it sends CORS headers). A custom endpoint is any OpenAI-compatible server: vLLM, llama.cpp, Ollama, an
 * institute gateway. It must allow the app's origin (vLLM `--allowed-origins`, Ollama `OLLAMA_ORIGINS`).
 */

import { type Fetch, request } from './http.js';

export type EndpointKind = 'openrouter' | 'custom';

export interface Endpoint {
  kind: EndpointKind;
  baseUrl: string;
  apiKey?: string;
}

export const openrouter = (apiKey?: string): Endpoint => ({ kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey });
export const customEndpoint = (baseUrl: string, apiKey?: string): Endpoint => ({
  kind: 'custom',
  baseUrl: baseUrl.replace(/\/+$/, ''),
  apiKey,
});

export interface CallOptions {
  signal?: AbortSignal;
  fetch?: Fetch;
  timeoutMs?: number;
}

function headers(ep: Endpoint): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (ep.apiKey) h.authorization = `Bearer ${ep.apiKey}`;
  if (ep.kind === 'openrouter') {
    h['X-Title'] = 'Omigator';
    h['HTTP-Referer'] = (globalThis as { location?: Location }).location?.origin ?? 'https://github.com/rickintoplace/Omigator';
  }
  return h;
}

async function postJson(url: string, ep: Endpoint, body: unknown, opts: CallOptions) {
  const res = await request(url, { method: 'POST', headers: headers(ep), body: JSON.stringify(body) }, {
    signal: opts.signal,
    fetch: opts.fetch,
    timeoutMs: opts.timeoutMs ?? 90_000,
  });
  return res.json();
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Number of alternatives per token to return (0 = no logprobs). */
  topLogprobs?: number;
  json?: boolean;
  /** Reasoning on/off; undefined leaves the model default. */
  thinking?: boolean;
  /** OpenRouter only: route to these providers and nowhere else. */
  providers?: string[];
  /** Merged into the request body as-is (endpoint-specific switches). */
  extra?: Record<string, unknown>;
}

export interface TokenLogprob {
  token: string;
  top: { token: string; logprob: number }[];
}

export interface ChatResult {
  content: string;
  model: string;
  provider?: string;
  cost: number;
  logprobs: TokenLogprob[];
}

export async function chat(ep: Endpoint, req: ChatRequest, opts: CallOptions = {}): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    temperature: req.temperature ?? 0,
  };
  if (req.maxTokens) body.max_tokens = req.maxTokens;
  if (req.topLogprobs) Object.assign(body, { logprobs: true, top_logprobs: req.topLogprobs });
  if (req.json) body.response_format = { type: 'json_object' };
  if (req.thinking !== undefined) {
    if (ep.kind === 'openrouter') body.reasoning = { enabled: req.thinking };
    else body.chat_template_kwargs = { enable_thinking: req.thinking };
  }
  if (ep.kind === 'openrouter') {
    const provider: Record<string, unknown> = {};
    if (req.topLogprobs || req.json) provider.require_parameters = true;
    if (req.providers?.length) Object.assign(provider, { order: req.providers, allow_fallbacks: false });
    if (Object.keys(provider).length) body.provider = provider;
  }
  Object.assign(body, req.extra);

  const json = await postJson(`${ep.baseUrl}/chat/completions`, ep, body, opts);
  const choice = json.choices?.[0];
  return {
    content: choice?.message?.content ?? '',
    model: json.model ?? req.model,
    provider: json.provider,
    cost: Number(json.usage?.cost ?? 0),
    logprobs: (choice?.logprobs?.content ?? []).map((t: { token: string; top_logprobs?: TokenLogprob['top'] }) => ({
      token: t.token,
      top: t.top_logprobs ?? [],
    })),
  };
}

export type DecisionQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> };

export interface DecisionResult {
  /** For `noul` questions: probability that the statement is true. */
  answers: Record<string, { noul?: number; choice?: string; probabilities?: Record<string, number> }>;
  /** Dated snapshot that served the request. */
  model: string;
  cost: number;
}

export function decisionsUrl(ep: Endpoint): string {
  return ep.kind === 'openrouter' ? 'https://openrouter.ai/api/alpha/decisions' : `${ep.baseUrl}/decisions`;
}

/** Decision models: one forward pass, a probability per question, no generated text. */
export async function decide(
  ep: Endpoint,
  req: { model: string; state: Record<string, unknown>; questions: Record<string, DecisionQuestion> },
  opts: CallOptions = {},
): Promise<DecisionResult> {
  const json = await postJson(decisionsUrl(ep), ep, req, { timeoutMs: 45_000, ...opts });
  if (!json.answers) throw new Error(`Decisions API returned no answers: ${JSON.stringify(json).slice(0, 200)}`);
  return { answers: json.answers, model: json.model ?? req.model, cost: Number(json.usage?.cost ?? 0) };
}

export interface ModelInfo {
  id: string;
  /** USD per million input tokens, if known. */
  inputPrice?: number;
  outputPrice?: number;
  logprobs?: boolean;
}

/** Lists models an endpoint serves. OpenRouter's catalogue is public; decision models are listed separately. */
export async function listModels(ep: Endpoint, kind: 'chat' | 'decisions' = 'chat', opts: CallOptions = {}): Promise<ModelInfo[]> {
  const url =
    ep.kind === 'openrouter' && kind === 'decisions' ? `${ep.baseUrl}/models?output_modalities=decisions` : `${ep.baseUrl}/models`;
  const res = await request(url, { headers: ep.kind === 'custom' && ep.apiKey ? headers(ep) : {} }, {
    signal: opts.signal,
    fetch: opts.fetch,
    timeoutMs: 20_000,
    retries: 1,
  });
  const json = await res.json();
  return (json.data ?? []).map((m: { id: string; pricing?: { prompt?: string; completion?: string }; supported_parameters?: string[] }) => ({
    id: m.id,
    inputPrice: m.pricing?.prompt ? Number(m.pricing.prompt) * 1e6 : undefined,
    outputPrice: m.pricing?.completion ? Number(m.pricing.completion) * 1e6 : undefined,
    logprobs: m.supported_parameters?.includes('top_logprobs'),
  }));
}

/** Extracts the first JSON object from model text (tolerates code fences and surrounding prose). */
export function parseJsonObject<T = unknown>(text: string): T {
  const start = text.indexOf('{');
  if (start === -1) throw new Error(`No JSON object in model output: ${text.slice(0, 160)}`);
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error(`Unterminated JSON object in model output: ${text.slice(start, start + 160)}`);
}
