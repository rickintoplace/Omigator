import { ExternalLink, Gift, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { DEVICE_SIGNALS } from '../freeTier';

export interface FreeOffer {
  limits?: { datasets: number; explanations: number; drafts: number };
  /** The visitor agreed; go on with the free tier. */
  onUse: () => void;
}

/** The free tier, offered with everything it collects stated up front: agreeing is the click. */
function FreeTierOffer({ free }: { free: FreeOffer }) {
  const l = free.limits ?? { datasets: 1000, explanations: 20, drafts: 20 };
  return (
    <div className="card p-4 space-y-3 bg-[var(--color-tint)]">
      <p className="text-sm flex gap-2">
        <Gift className="w-4 h-4 mt-0.5 shrink-0" />
        <span>
          <b>Use it for free.</b> Up to {l.datasets.toLocaleString()} datasets, {l.explanations} explanations and {l.drafts} drafts a day, paid by
          Omigator. No account, no key.
        </span>
      </p>
      <p className="text-xs leading-relaxed">
        To share this fairly between devices, your browser computes a coarse signature of this device ({DEVICE_SIGNALS.join(', ')}) and sends
        only a hash of it. Omigator's server combines it with your IP address under a key that changes every day, counts today's use, and
        forgets it within 24 hours. Your request and checklist go through that server to OpenRouter. Nothing is stored on your device except
        this choice, which you can withdraw in Settings.{' '}
        <a className="link" href="/legal.html#privacy" target="_blank" rel="noreferrer">
          Privacy notice
        </a>
      </p>
      <button type="button" className="brutal-button button-primary px-4 py-2" onClick={free.onUse}>
        Agree and use the free tier
      </button>
    </div>
  );
}

/** Inline key entry: asks for the one thing that is missing, where it is missing. */
export function KeyPrompt({
  reason,
  remember,
  onSave,
  onOpenSettings,
  free,
}: {
  reason: string;
  remember: boolean;
  onSave: (key: string, remember: boolean) => void;
  onOpenSettings: () => void;
  /** Offered first when the free tier is available and the visitor has not agreed yet. */
  free?: FreeOffer;
}) {
  const [key, setKey] = useState('');
  const [keep, setKeep] = useState(remember);
  const form = (
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
          {free ? 'Or use your own key: nothing of the above is collected, and there is no daily limit.' : reason} Paste an <b>OpenRouter</b>{' '}
          key. It is sent only to OpenRouter.{' '}
          <a className="link inline-flex items-center gap-0.5" href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
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
        <button type="button" className="link" onClick={onOpenSettings}>
          Other options (self-hosted models)
        </button>
      </div>
    </form>
  );
  return free ? (
    <div className="space-y-3">
      <FreeTierOffer free={free} />
      {form}
    </div>
  ) : (
    form
  );
}
