import { ArrowRight, History, LoaderCircle, Play } from 'lucide-react';
import { useState } from 'react';
import { PRESETS, type Protocol } from '../../core';
import type { SavedRunMeta } from '../idbCache';
import omigatorLogoPng from '../../assets/omigator-logo.png';
import { KeyPrompt } from './KeyPrompt';
import { ParticleLogo } from './ParticleLogo';

export interface StartScreenProps {
  intent: string;
  onIntent: (text: string) => void;
  onDraft: () => void;
  drafting: boolean;
  draftError?: string;
  hasKey: boolean;
  rememberKeys: boolean;
  onKey: (key: string, remember: boolean) => void;
  onPreset: (p: Protocol) => void;
  onManual: () => void;
  onDemo: () => void;
  onOpenSettings: () => void;
  recent: SavedRunMeta[];
  onOpenRun: (id: string) => void;
}

const PLACEHOLDER = 'e.g. Mouse liver RNA-seq after high-fat diet versus chow, at least 3 animals per group';

export function StartScreen(p: StartScreenProps) {
  const [askKey, setAskKey] = useState(false);
  const draft = () => (p.hasKey ? p.onDraft() : setAskKey(true));

  return (
    <div className="min-h-full flex flex-col items-center px-5 py-10 md:py-14 scales-bg-soft">
      <div className="w-full max-w-3xl space-y-7">
        <ParticleLogo imageSrc={omigatorLogoPng} className="logo-wallpaper mx-auto" />

        <div className="space-y-3 text-center">
          <h1 className="font-display uppercase text-4xl md:text-5xl leading-none">What data do you need?</h1>
          <p className="text-lg text-[var(--color-muted)]">
            Describe it in a sentence or two, in any language. Omigator turns it into a GEO search and a checklist, checks every dataset
            against it (sample annotations included) and shows you why each one fits or not.
          </p>
        </div>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            draft();
          }}
        >
          <textarea
            className="intent-input min-h-[7.5rem]"
            value={p.intent}
            onChange={(e) => p.onIntent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && p.intent.trim()) draft();
            }}
            placeholder={PLACEHOLDER}
            aria-label="What data do you need?"
            autoFocus
          />
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className="brutal-button button-primary px-5 py-3 text-base" disabled={!p.intent.trim() || p.drafting}>
              {p.drafting ? <LoaderCircle className="w-5 h-5 animate-spin" /> : <ArrowRight className="w-5 h-5" />}
              {p.drafting ? 'Drafting search and checklist…' : 'Draft my protocol'}
            </button>
            <button type="button" className="text-sm link" onClick={p.onManual}>
              or write it myself
            </button>
          </div>
          {p.draftError && <p className="text-sm text-[var(--color-danger-ink)]">{p.draftError}</p>}
        </form>

        {askKey && !p.hasKey && (
          <KeyPrompt
            reason="Drafting uses a language model."
            remember={p.rememberKeys}
            onSave={(key, remember) => {
              // The parent stores the key and continues drafting with it.
              p.onKey(key, remember);
              setAskKey(false);
            }}
            onOpenSettings={p.onOpenSettings}
          />
        )}

        <div className="space-y-2">
          <div className="text-sm font-semibold">Or start from an example</div>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((preset) => (
              <button key={preset.name} className="brutal-button px-3 py-1.5 text-sm font-medium" onClick={() => p.onPreset(structuredClone(preset.protocol))}>
                {preset.name}
              </button>
            ))}
          </div>
        </div>

        {p.recent.length > 0 && (
          <div className="space-y-2">
            <div className="text-sm font-semibold flex items-center gap-1.5">
              <History className="w-4 h-4" /> Your recent runs (saved in this browser)
            </div>
            <ul className="card divide-y-2 divide-[var(--color-ink)]">
              {p.recent.slice(0, 5).map((r) => (
                <li key={r.id}>
                   <button className="w-full text-left px-3 py-2 hover-surface flex flex-wrap gap-x-3 items-baseline" onClick={() => p.onOpenRun(r.id)}>
                    <span className="font-medium flex-1 min-w-[12rem] truncate">{r.intent || 'Untitled run'}</span>
                    <span className="text-xs text-[var(--color-muted)]">
                      {r.include} include of {r.count} · {new Date(r.createdAt).toLocaleString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="card p-4 flex flex-wrap items-center gap-4">
          <div className="flex-1 min-w-[14rem]">
            <div className="font-semibold">Just looking?</div>
            <div className="text-sm text-[var(--color-muted)]">Replay a real, recorded run of 187 datasets. No key, nothing sent anywhere.</div>
          </div>
          <button className="brutal-button px-4 py-2.5" onClick={p.onDemo}>
            <Play className="w-4 h-4 fill-current" /> Watch the demo
          </button>
        </div>

        <ol className="grid gap-3 md:grid-cols-3 text-sm">
          {[
            ['Describe', 'Omigator drafts a GEO search with synonyms and a checklist you can edit.'],
            ['Screen', 'A decision model checks every dataset against every criterion: under one cent per 200 datasets.'],
            ['Decide', 'Ranked include / unclear / exclude, quotes checked against the record, export for your methods.'],
          ].map(([title, text], i) => (
            <li key={title} className="flex gap-3">
              <span className="step-badge">{i + 1}</span>
              <span>
                <b>{title}.</b> {text}
              </span>
            </li>
          ))}
        </ol>

        <footer className="text-xs text-[var(--color-muted)] flex gap-4 justify-center pt-4">
          <a className="link" href="/legal.html#privacy">Privacy</a>
          <a className="link" href="/legal.html#imprint">Imprint</a>
          <span>
            Made by{' '}
            <a className="link" href="https://rickinto.place" target="_blank" rel="noreferrer">
              rickinto.place
            </a>
          </span>
        </footer>
      </div>
    </div>
  );
}
