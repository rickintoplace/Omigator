import { ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CHAT_MODELS, DECISION_MODELS, listModels, openrouter } from '../../core';
import { clearIdbCache } from '../idbCache';
import type { Keys, ScoringMethod, Settings } from '../settings';
import { Dialog, Field, Hint } from './ui';

const SCORING: { id: ScoringMethod; label: string; hint: string }[] = [
  { id: 'openrouter-decisions', label: 'Decision model on OpenRouter', hint: 'Default. One request per dataset returns a probability per criterion.' },
  { id: 'openrouter-logprobs', label: 'Chat model on OpenRouter, read through logprobs', hint: 'One Yes/No request per criterion; routed to providers that return logprobs.' },
  { id: 'custom-logprobs', label: 'Your own endpoint, read through logprobs', hint: 'Self-hosted vLLM, llama.cpp, Ollama or an institute gateway.' },
];

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-base font-semibold border-b-2 border-[var(--color-ink)] pb-1">{title}</h3>
      {children}
    </section>
  );
}

export function SettingsDialog({
  settings,
  keys,
  onSettings,
  onKeys,
  onClose,
  onWithdrawFreeTier,
}: {
  settings: Settings;
  keys: Keys;
  onSettings: (s: Settings) => void;
  onKeys: (k: Keys) => void;
  onClose: () => void;
  /** Set while the visitor has agreed to the free tier on this device. */
  onWithdrawFreeTier?: () => void;
}) {
  const [withdrawn, setWithdrawn] = useState(false);
  const set = (patch: Partial<Settings>) => onSettings({ ...settings, ...patch });
  const setKey = (patch: Partial<Keys>) => onKeys({ ...keys, ...patch });
  const [available, setAvailable] = useState<Set<string> | null>(null);
  const [cleared, setCleared] = useState(false);

  // OpenRouter's catalogue is public: flag retired models before a run fails on them.
  useEffect(() => {
    const ep = openrouter();
    Promise.all([listModels(ep, 'decisions'), listModels(ep, 'chat')])
      .then(([d, c]) => setAvailable(new Set([...d, ...c].map((m) => m.id))))
      .catch(() => setAvailable(null));
  }, []);
  const tag = (id: string) => (available && !available.has(id) ? ' — unavailable' : '');
  const advanced = settings.scoring !== 'openrouter-decisions' || settings.chatEndpoint === 'custom';

  return (
    <Dialog title="Settings" onClose={onClose} wide>
      {(onWithdrawFreeTier || withdrawn) && (
        <Group title="Free tier">
          {withdrawn ? (
            <Hint>Withdrawn. The device signature is no longer sent; you will be asked again before the free tier is used.</Hint>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>You agreed to the free tier on this device; a hash of a coarse device signature counts your daily use.</span>
              <button className="brutal-button px-3 py-1 text-sm" onClick={() => (onWithdrawFreeTier!(), setWithdrawn(true))}>
                Withdraw
              </button>
            </div>
          )}
        </Group>
      )}
      <Group title="API key">
        <Field
          label="OpenRouter key"
          hint={
            <>
              Used for screening, drafting and explanations. Sent only to OpenRouter.{' '}
              <a className="link inline-flex items-center gap-0.5" href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
                Get a key <ExternalLink className="w-3 h-3" />
              </a>{' '}
              — a few dollars of credit cover many thousands of datasets.
            </>
          }
        >
          <input type="password" className="brutal-input mono" value={keys.openrouter} onChange={(e) => setKey({ openrouter: e.target.value })} placeholder="sk-or-v1-…" autoComplete="off" />
        </Field>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={settings.rememberKeys} onChange={(e) => set({ rememberKeys: e.target.checked })} />
          Remember keys on this device
        </label>
      </Group>

      <Group title="Models">
        {settings.scoring === 'openrouter-decisions' && (
          <Field label="Screening" hint={DECISION_MODELS.find((m) => m.id === settings.decisionModel)?.note}>
            <select className="brutal-select" value={settings.decisionModel} onChange={(e) => set({ decisionModel: e.target.value })}>
              {DECISION_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {tag(m.id)}
                </option>
              ))}
            </select>
          </Field>
        )}
        {settings.chatEndpoint === 'openrouter' && (
          <Field label="Drafting and explanations" hint={CHAT_MODELS.find((m) => m.id === settings.chatModel)?.note}>
            <select className="brutal-select" value={settings.chatModel} onChange={(e) => set({ chatModel: e.target.value })}>
              {CHAT_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {tag(m.id)}
                </option>
              ))}
            </select>
          </Field>
        )}
        {advanced && <Hint>Advanced options are active (see below).</Hint>}
      </Group>

      <details className="brutal-border" open={advanced}>
        <summary className="px-3 py-2 font-semibold">Self-hosted models and other scoring methods</summary>
        <div className="p-3 pt-1 space-y-4">
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold mb-1">Screening method</legend>
            {SCORING.map((m) => (
              <label key={m.id} className="flex gap-3 items-start p-1.5 hover-surface">
                <input type="radio" className="mt-1" name="scoring" checked={settings.scoring === m.id} onChange={() => set({ scoring: m.id })} />
                <span>
                  <span className="block text-sm font-medium">{m.label}</span>
                  <span className="block text-xs text-[var(--color-muted)]">{m.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {settings.scoring === 'openrouter-logprobs' && (
            <Field label="Logprob model (OpenRouter id)" hint="Must return logprobs with reasoning off. DeepSeek V4.1 Flash is routed to Together, which does.">
              <input className="brutal-input mono text-sm" value={settings.logprobModel} onChange={(e) => set({ logprobModel: e.target.value })} />
            </Field>
          )}

          <Field label="Drafting and explanations run on">
            <select className="brutal-select" value={settings.chatEndpoint} onChange={(e) => set({ chatEndpoint: e.target.value as Settings['chatEndpoint'] })}>
              <option value="openrouter">OpenRouter</option>
              <option value="custom">Your own endpoint</option>
            </select>
          </Field>

          <div className="space-y-3 p-3 bg-[var(--color-surface)] brutal-border">
            <div className="text-sm font-semibold">Your own endpoint</div>
            <Field label="Base URL" hint={<>OpenAI-compatible, ending in <code>/v1</code>. It must allow this page's origin (vLLM: <code>--allowed-origins</code>, Ollama: <code>OLLAMA_ORIGINS</code>).</>}>
              <input className="brutal-input mono text-sm" value={settings.customBaseUrl} onChange={(e) => set({ customBaseUrl: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Model name">
                <input className="brutal-input mono text-sm" value={settings.customModel} onChange={(e) => set({ customModel: e.target.value })} placeholder="qwen3.8-27b" />
              </Field>
              <Field label="API key (optional)">
                <input type="password" className="brutal-input mono text-sm" value={keys.custom} onChange={(e) => setKey({ custom: e.target.value })} autoComplete="off" />
              </Field>
            </div>
          </div>
        </div>
      </details>

      <details className="brutal-border">
        <summary className="px-3 py-2 font-semibold">NCBI (optional)</summary>
        <div className="p-3 pt-1 grid grid-cols-2 gap-3">
          <Field label="NCBI API key" hint="Raises the limit from 3 to 10 requests per second.">
            <input type="password" className="brutal-input mono text-sm" value={keys.ncbi} onChange={(e) => setKey({ ncbi: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="Contact e-mail" hint="NCBI asks tools to send one with each request.">
            <input type="email" className="brutal-input" value={settings.ncbiEmail} onChange={(e) => set({ ncbiEmail: e.target.value })} />
          </Field>
        </div>
      </details>

      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        <button
          className="text-sm link"
          onClick={async () => {
            await clearIdbCache();
            setCleared(true);
          }}
        >
          {cleared ? 'Cache cleared' : 'Clear cached GEO records and model answers'}
        </button>
        <button className="brutal-button button-primary px-5 py-2" onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
}
