/**
 * Default models. Ids are dated snapshots where the provider offers them, so a run can be
 * reproduced; the served snapshot is also recorded per result. Availability is checked against the
 * live catalogue at startup (`listModels`), so a retired model shows up as unavailable instead of
 * failing silently.
 */

export interface ModelChoice {
  id: string;
  label: string;
  note: string;
}

/** Screening: decision models via a Decisions API. Measured on the hypoxia pilot (eval/pilot). */
export const DECISION_MODELS: ModelChoice[] = [
  {
    id: 'perplexity/pplx-decider-v1.2',
    label: 'pplx-decider v1.2 (27B)',
    note: 'Default. Open weights (Apache-2.0). Pilot: AUROC 0.91, P@20 0.85; ~$0.02 per 1,000 datasets.',
  },
  {
    id: 'perplexity/pplx-decider-flash-v1.2',
    label: 'pplx-decider flash v1.2 (4B)',
    note: 'Faster, open weights. Pilot: AUROC 0.89, misses more controls stated only in samples.',
  },
  {
    id: 'typesafe/jev-1.14',
    label: 'Jev 1.14 (TypeSafe)',
    note: 'Closed decision model; fewer false positives in VeriQuote benchmarks.',
  },
];

/** Drafting protocols and writing explanations with quotes. */
export const CHAT_MODELS: ModelChoice[] = [
  {
    id: 'deepseek/deepseek-v4.1-flash-1017',
    label: 'DeepSeek V4.1 Flash (2026-10-17)',
    note: 'Default. Cheap, strong reasoning; $0.15 / $0.60 per M tokens.',
  },
  {
    id: 'qwen/qwen3.8-27b',
    label: 'Qwen3.8 27B',
    note: 'Open weights; also self-hostable.',
  },
  {
    id: 'google/gemma-4-31b-it',
    label: 'Gemma 4 31B',
    note: 'Open weights; also self-hostable.',
  },
];

/**
 * Logprob screening through OpenRouter only works on providers that actually return logprobs.
 * In the pilot, unpinned routing sent 49 of 187 requests to providers that returned none.
 */
export const LOGPROB_PROVIDERS: Record<string, string[]> = {
  'deepseek/deepseek-v4.1-flash-1017': ['Together'],
};

export const DEFAULT_DECISION_MODEL = DECISION_MODELS[0].id;
export const DEFAULT_CHAT_MODEL = CHAT_MODELS[0].id;
