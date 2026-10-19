import { ExternalLink, KeyRound } from 'lucide-react';
import { useState } from 'react';

/** Inline key entry: asks for the one thing that is missing, where it is missing. */
export function KeyPrompt({
  reason,
  remember,
  onSave,
  onOpenSettings,
}: {
  reason: string;
  remember: boolean;
  onSave: (key: string, remember: boolean) => void;
  onOpenSettings: () => void;
}) {
  const [key, setKey] = useState('');
  const [keep, setKeep] = useState(remember);
  return (
    <form
      className="card p-4 space-y-3 bg-[var(--color-warn)]"
      onSubmit={(e) => {
        e.preventDefault();
        if (key.trim()) onSave(key.trim(), keep);
      }}
    >
      <p className="text-sm flex gap-2">
        <KeyRound className="w-4 h-4 mt-0.5 shrink-0" />
        <span>
          {reason} Paste an <b>OpenRouter</b> key. It is sent only to OpenRouter.{' '}
          <a className="underline inline-flex items-center gap-0.5" href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
            Get a key <ExternalLink className="w-3 h-3" />
          </a>
        </span>
      </p>
      <div className="flex gap-2">
        <input type="password" className="brutal-input mono text-sm" placeholder="sk-or-v1-…" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" aria-label="OpenRouter API key" />
        <button type="submit" className="brutal-button button-primary px-4" disabled={!key.trim()}>
          Save
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Remember on this device
        </label>
        <button type="button" className="underline" onClick={onOpenSettings}>
          Other options (self-hosted models)
        </button>
      </div>
    </form>
  );
}
