/** Connection and model settings, persisted per browser. Keys are stored only when the user opts in. */

import { ChatCompletionsJudge, DecisionsJudge, type EntailmentJudge } from 'veriquote';
import {
  customEndpoint,
  DecisionScorer,
  DEFAULT_CHAT_MODEL,
  DEFAULT_DECISION_MODEL,
  type Endpoint,
  LogprobScorer,
  LOGPROB_PROVIDERS,
  Ncbi,
  openrouter,
  type Scorer,
} from '../core';

export type ScoringMethod = 'openrouter-decisions' | 'openrouter-logprobs' | 'custom-logprobs';
export type ChatEndpointChoice = 'openrouter' | 'custom';

export interface Keys {
  openrouter: string;
  custom: string;
  ncbi: string;
}

export interface Settings {
  scoring: ScoringMethod;
  decisionModel: string;
  logprobModel: string;
  chatModel: string;
  chatEndpoint: ChatEndpointChoice;
  customBaseUrl: string;
  customModel: string;
  ncbiEmail: string;
  rememberKeys: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  scoring: 'openrouter-decisions',
  decisionModel: DEFAULT_DECISION_MODEL,
  logprobModel: 'deepseek/deepseek-v4.1-flash-1017',
  chatModel: DEFAULT_CHAT_MODEL,
  chatEndpoint: 'openrouter',
  customBaseUrl: 'http://localhost:8000/v1',
  customModel: '',
  ncbiEmail: '',
  rememberKeys: false,
};

export const EMPTY_KEYS: Keys = { openrouter: '', custom: '', ncbi: '' };

const SETTINGS_KEY = 'omigator.settings.v2';
const KEYS_KEY = 'omigator.keys.v2';

/** localStorage can be unavailable (private mode, blocked storage); the app works without it. */
export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

export function loadSettings(): Settings {
  const s = load(SETTINGS_KEY, DEFAULT_SETTINGS);
  // Settings saved by an earlier version may name a method that no longer exists.
  return ['openrouter-decisions', 'openrouter-logprobs', 'custom-logprobs'].includes(s.scoring) ? s : { ...s, scoring: DEFAULT_SETTINGS.scoring };
}
export const saveSettings = (s: Settings) => save(SETTINGS_KEY, s);
export const loadKeys = () => load(KEYS_KEY, EMPTY_KEYS);
export const saveKeys = (k: Keys, remember: boolean) => save(KEYS_KEY, remember ? k : undefined);

export function makeNcbi(keys: Keys, s: Settings): Ncbi {
  return new Ncbi({ apiKey: keys.ncbi.trim() || undefined, email: s.ncbiEmail.trim() || undefined });
}

function custom(keys: Keys, s: Settings): Endpoint {
  if (!s.customBaseUrl.trim()) throw new Error('Set the base URL of your own endpoint in Settings.');
  return customEndpoint(s.customBaseUrl.trim(), keys.custom.trim() || undefined);
}

function needKey(value: string, name: string): string {
  if (!value.trim()) throw new Error(`Add your ${name} API key in Settings.`);
  return value.trim();
}

export function makeScorer(keys: Keys, s: Settings): Scorer {
  switch (s.scoring) {
    case 'openrouter-decisions':
      return new DecisionScorer(openrouter(needKey(keys.openrouter, 'OpenRouter')), s.decisionModel);
    case 'openrouter-logprobs':
      return new LogprobScorer(openrouter(needKey(keys.openrouter, 'OpenRouter')), s.logprobModel, {
        providers: LOGPROB_PROVIDERS[s.logprobModel],
      });
    case 'custom-logprobs':
      if (!s.customModel.trim()) throw new Error('Set the model name of your own endpoint in Settings.');
      return new LogprobScorer(custom(keys, s), s.customModel.trim());
  }
}

/** Endpoint and model for drafting protocols and writing explanations. */
export function chatTarget(keys: Keys, s: Settings): { ep: Endpoint; model: string } {
  if (s.chatEndpoint === 'custom') {
    if (!s.customModel.trim()) throw new Error('Set the model name of your own endpoint in Settings.');
    return { ep: custom(keys, s), model: s.customModel.trim() };
  }
  return { ep: openrouter(needKey(keys.openrouter, 'OpenRouter')), model: s.chatModel };
}

/**
 * VeriQuote's support judge for explanations: the decision model when there is an OpenRouter key,
 * otherwise the own endpoint as a chat judge. Undefined when neither is configured.
 */
export function supportJudge(keys: Keys, s: Settings): { judge: EntailmentJudge; id: string } | undefined {
  if (keys.openrouter.trim()) {
    return { judge: new DecisionsJudge({ apiKey: keys.openrouter.trim(), model: s.decisionModel }), id: `decisions:${s.decisionModel}` };
  }
  if (s.chatEndpoint === 'custom' && s.customBaseUrl.trim() && s.customModel.trim()) {
    const ep = custom(keys, s);
    return { judge: new ChatCompletionsJudge({ baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: s.customModel.trim() }), id: `chat:${s.customModel.trim()}` };
  }
  return undefined;
}

/** True when the configured scoring method has what it needs. */
export function isReady(keys: Keys, s: Settings): boolean {
  try {
    makeScorer(keys, s);
    return true;
  } catch {
    return false;
  }
}
