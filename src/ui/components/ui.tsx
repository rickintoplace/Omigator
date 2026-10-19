import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import type { Decision } from '../../core';

export function Card({ step, title, aside, children, className = '' }: { step?: string; title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 brutal-border-b">
        <h2 className="card-title">
          {step && <span className="step-badge">{step}</span>}
          {title}
        </h2>
        {aside}
      </div>
      <div className="p-4 space-y-4">{children}</div>
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-sm font-semibold">{label}</span>
      {children}
      {hint && <span className="block text-xs leading-snug text-[var(--color-muted)]">{hint}</span>}
    </label>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-snug text-[var(--color-muted)]">{children}</p>;
}

export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 md:py-10 overflow-y-auto" onMouseDown={onClose}>
      <div
        className={`w-full ${wide ? 'max-w-3xl' : 'max-w-2xl'} brutal-border bg-[var(--color-paper)] brutal-shadow`}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <div className="flex items-center justify-between gap-4 p-4 brutal-border-b bg-[var(--color-accent)]">
          <h2 className="font-display text-xl uppercase">{title}</h2>
          <button className="brutal-button px-2 py-1 text-sm gap-1" onClick={onClose} aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-5">{children}</div>
      </div>
    </div>
  );
}

export const DECISION_STYLE: Record<Decision | 'failed' | 'pending', string> = {
  include: 'bg-[var(--color-accent)]',
  unclear: 'bg-[var(--color-warn)]',
  exclude: 'bg-[var(--color-surface)] text-[var(--color-muted)]',
  failed: 'bg-[var(--color-danger)] text-white',
  pending: 'bg-[var(--color-paper)] text-[var(--color-muted)]',
};

export function DecisionChip({ decision }: { decision: Decision | 'failed' | 'pending' }) {
  return <span className={`inline-block px-1.5 py-px text-xs font-semibold uppercase tracking-wide brutal-border ${DECISION_STYLE[decision]}`}>{decision}</span>;
}

/** Colour for a pass probability: green when the criterion is met, red when it clearly fails. */
export function passColor(p: number): string {
  if (p >= 0.8) return 'var(--color-pass)';
  if (p >= 0.5) return 'var(--color-pass-weak)';
  if (p >= 0.2) return 'var(--color-warn)';
  return 'var(--color-danger)';
}

export function ProbBar({ p, width = 'w-24' }: { p: number; width?: string }) {
  return (
    <span className={`inline-block align-middle h-2.5 ${width} brutal-border-thin bg-[var(--color-paper)] relative`} title={`${(p * 100).toFixed(1)}%`}>
      <span className="absolute inset-y-0 left-0" style={{ width: `${Math.round(p * 100)}%`, background: passColor(p) }} />
    </span>
  );
}

export const pct = (p: number | undefined, digits = 0) => (p === undefined || Number.isNaN(p) ? '–' : `${(p * 100).toFixed(digits)}%`);
export const usd = (x: number) => (x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`);
