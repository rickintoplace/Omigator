import { useEffect, useState } from 'react';
import { ChevronRight, CircleAlert, CircleCheck, ExternalLink, LoaderCircle, MessageSquareQuote, RotateCcw, ThumbsDown, ThumbsUp } from 'lucide-react';
import { type Criterion, type DatasetResult, familyFileUrl, passProbability, type Protocol } from '../../core';
import { DecisionChip, passColor, pct, ProbBar } from './ui';

export interface ResultRowProps {
  result: DatasetResult;
  rank: number;
  protocol: Protocol;
  expanded: boolean;
  onToggle: () => void;
  label?: boolean;
  onLabel: (value: boolean | undefined) => void;
  busy: boolean;
  /** Undefined when explanations are not possible (no key, demo without recorded explanation). */
  onExplain?: () => void;
  onRetry?: () => void;
  calibrated?: number;
}

const KIND: Record<Criterion['kind'], string> = { require: 'must', exclude: 'must not', prefer: 'nice' };

export function ResultRow(props: ResultRowProps) {
  const { result: r, protocol, expanded } = props;
  // Details stay mounted while they animate closed, and open from zero height on the next frame.
  const [mounted, setMounted] = useState(expanded);
  const [open, setOpen] = useState(expanded);
  useEffect(() => {
    if (!expanded) return setOpen(false);
    setMounted(true);
    let inner = 0;
    const outer = requestAnimationFrame(() => (inner = requestAnimationFrame(() => setOpen(true))));
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [expanded]);
  const s = r.screening;
  const decision = s ? s.decision : r.error ? 'failed' : 'pending';
  const c = r.candidate;

  return (
    <article data-gse={r.gse} className={`brutal-border bg-[var(--color-paper)] ${expanded ? 'brutal-shadow' : 'brutal-shadow-sm'} transition-shadow`}>
      <div className="flex items-stretch">
        <button className="flex-1 min-w-0 text-left p-3 flex gap-3 items-start hover-surface" onClick={props.onToggle} aria-expanded={expanded}>
          <span className="pt-0.5">
            <ChevronRight className="w-4 h-4 chevron" data-open={open} />
          </span>
          <span className="w-8 shrink-0 text-right font-display text-lg leading-none pt-0.5 text-[var(--color-muted)]">{props.rank}</span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-bold">{r.gse}</span>
              <DecisionChip decision={decision} />
              {s && (
                <span className="flex gap-0.5" aria-label="Checklist">
                  {protocol.criteria.map((cr) => {
                    const pass = passProbability(cr, s.p[cr.id] ?? 0.5);
                    return <span key={cr.id} className="w-2.5 h-2.5 brutal-border-thin" style={{ background: passColor(pass) }} title={`${cr.id}: ${pct(pass)}`} />;
                  })}
                </span>
              )}
              {props.calibrated !== undefined && (
                <span className="text-xs px-1.5 brutal-border-thin" title="Probability that this dataset is relevant to you, fitted to your 👍/👎 marks">
                  relevant to you: {pct(props.calibrated)}
                </span>
              )}
            </span>
            <span className="block text-sm mt-1 line-clamp-2">{c.title}</span>
            <span className="flex flex-wrap gap-x-3 gap-y-1 mt-1 text-xs text-[var(--color-muted)]">
              <span>{c.organisms}</span>
              <span>n = {c.nSamples}</span>
              <span>{c.pubDate.slice(0, 4)}</span>
              {r.dossier?.design && <span>{r.dossier.design.groups.length} sample groups</span>}
              {r.dossier?.series?.superSeriesOf?.length ? (
                <span className="font-semibold text-[var(--color-ink)]" title="A SuperSeries bundles other GEO series; its samples belong to them">
                  SuperSeries of {r.dossier.series.superSeriesOf.join(', ')}
                </span>
              ) : null}
              {r.dossier && !r.dossier.series && <span className="text-[var(--color-danger-ink)]">sample metadata missing</span>}
              {r.error && <span className="text-[var(--color-danger-ink)]">{r.error.slice(0, 120)}</span>}
            </span>
          </span>
        </button>
        <div className="flex flex-col brutal-border-l">
          <button
            className={`flex-1 px-3 ${props.label === true ? 'bg-[var(--color-accent)]' : 'hover-surface'}`}
            onClick={() => props.onLabel(props.label === true ? undefined : true)}
            title="Relevant to me. Your marks estimate how many relevant datasets the decisions keep."
            aria-pressed={props.label === true}
          >
            <ThumbsUp className="w-4 h-4" />
          </button>
          <button
            className={`flex-1 px-3 brutal-border-t ${props.label === false ? 'bg-ink text-white' : 'hover-surface'}`}
            onClick={() => props.onLabel(props.label === false ? undefined : false)}
            title="Not relevant to me"
            aria-pressed={props.label === false}
          >
            <ThumbsDown className="w-4 h-4" />
          </button>
        </div>
      </div>

      {mounted && (
        <div className="collapsible" data-open={open} onTransitionEnd={(e) => e.target === e.currentTarget && !open && setMounted(false)}>
        <div>
        <div className="brutal-border-t p-4 space-y-5 bg-[var(--color-surface)] text-sm">
          <div className="flex flex-wrap gap-2">
            <a className="brutal-button px-2 py-1 text-xs gap-1" href={`https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${r.gse}`} target="_blank" rel="noreferrer">
              GEO <ExternalLink className="w-3 h-3" />
            </a>
            {c.pmids.slice(0, 3).map((id) => (
              <a key={id} className="brutal-button px-2 py-1 text-xs gap-1" href={`https://pubmed.ncbi.nlm.nih.gov/${id}/`} target="_blank" rel="noreferrer">
                PMID {id} <ExternalLink className="w-3 h-3" />
              </a>
            ))}
            <a className="brutal-button px-2 py-1 text-xs gap-1" href={familyFileUrl(r.gse)} target="_blank" rel="noreferrer">
              SOFT file <ExternalLink className="w-3 h-3" />
            </a>
            <span className="flex-1" />
            {props.onRetry && (
              <button className="brutal-button px-2 py-1 text-xs gap-1" onClick={props.onRetry} disabled={props.busy}>
                {props.busy ? <LoaderCircle className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />} Retry
              </button>
            )}
            {s && props.onExplain && !r.explanation && (
              <button className="brutal-button px-2 py-1 text-xs gap-1" onClick={props.onExplain} disabled={props.busy}>
                {props.busy ? <LoaderCircle className="w-3 h-3 animate-spin" /> : <MessageSquareQuote className="w-3 h-3" />} Explain with quotes
              </button>
            )}
          </div>

          {r.explanation?.summary && <p className="font-bold leading-snug">{r.explanation.summary}</p>}

          {s && (
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="text-xs uppercase text-[var(--color-muted)]">
                  <th className="py-1 pr-2 font-bold">Criterion</th>
                  <th className="py-1 pr-2 font-bold w-36">Passes</th>
                </tr>
              </thead>
              <tbody>
                {protocol.criteria.map((cr) => {
                  const pass = passProbability(cr, s.p[cr.id] ?? 0.5);
                  const ex = r.explanation?.criteria[cr.id];
                  return (
                    <tr key={cr.id} className="align-top border-t border-[var(--color-line)]">
                      <td className="py-2 pr-2">
                        <span className={`text-[11px] font-bold uppercase px-1 mr-2 brutal-border-thin kind-${cr.kind}`}>{KIND[cr.kind]}</span>
                        {cr.text}
                        {ex && (
                          <div className="mt-1.5 space-y-1">
                            {ex.disagrees && (
                              <div className="text-xs font-bold text-[var(--color-danger-ink)]">
                                The explanation says “{ex.verdict}” — the screening model disagrees. Check this one.
                              </div>
                            )}
                            {ex.quotes.map((q, i) => (
                              <blockquote key={i} className={`text-xs pl-2 border-l-4 ${q.verified ? 'border-[var(--color-pass)]' : 'border-[var(--color-danger)]'}`}>
                                “{q.text}”{' '}
                                {q.verified ? (
                                  <span className="inline-flex items-center gap-0.5 text-[11px] text-[var(--color-muted)]"><CircleCheck className="w-3 h-3" /> in record</span>
                                ) : (
                                  <span className="inline-flex items-center gap-0.5 text-[11px] font-bold text-[var(--color-danger-ink)]"><CircleAlert className="w-3 h-3" /> not found in record</span>
                                )}
                              </blockquote>
                            ))}
                            {ex.note && <div className="text-xs text-[var(--color-muted)]">{ex.note}</div>}
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-2 whitespace-nowrap">
                        <ProbBar p={pass} /> <span className="text-xs ml-1">{pct(pass)}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {r.dossier?.design && <DesignTable result={r} />}

          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <h4 className="font-semibold text-sm mb-1">Summary</h4>
              <p className="leading-relaxed text-[var(--color-muted)]">{r.dossier?.series?.summary || c.summary}</p>
            </div>
            <div>
              <h4 className="font-semibold text-sm mb-1">Overall design</h4>
              <p className="leading-relaxed text-[var(--color-muted)]">{r.dossier?.series?.overallDesign || '–'}</p>
            </div>
          </div>

          {r.dossier && (
            <details>
              <summary className="text-sm font-semibold cursor-pointer">What the model read</summary>
              <pre className="mt-2 p-3 brutal-border bg-[var(--color-paper)] text-xs whitespace-pre-wrap max-h-96 overflow-auto">{r.dossier.text}</pre>
            </details>
          )}
          {s && (
            <div className="text-xs text-[var(--color-muted)]">
              Screened by {s.model}
              {r.explanation && ` · explained by ${r.explanation.model}`}
            </div>
          )}
        </div>
        </div>
        </div>
      )}
    </article>
  );
}

function DesignTable({ result }: { result: DatasetResult }) {
  const d = result.dossier!.design!;
  const shared = Object.entries(d.shared);
  return (
    <div className="space-y-2">
      <h4 className="font-semibold text-sm">Sample design</h4>
      {d.varyingKeys.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="text-xs border-collapse bg-[var(--color-paper)] brutal-border">
            <thead>
              <tr>
                {d.varyingKeys.map((k) => (
                  <th key={k} className="px-2 py-1 text-left font-bold border-b border-[var(--color-line)]">{k}</th>
                ))}
                <th className="px-2 py-1 text-right font-bold border-b border-[var(--color-line)]">n</th>
              </tr>
            </thead>
            <tbody>
              {d.groups.slice(0, 24).map((g, i) => (
                <tr key={i}>
                  {d.varyingKeys.map((k) => (
                    <td key={k} className="px-2 py-0.5 border-t border-[var(--color-line)]">{g.values[k]}</td>
                  ))}
                  <td className="px-2 py-0.5 text-right border-t border-[var(--color-line)] font-bold">{g.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.groups.length > 24 && <div className="text-xs text-[var(--color-muted)]">… {d.groups.length - 24} more groups</div>}
        </div>
      ) : (
        <p className="text-xs text-[var(--color-muted)]">All samples share the same annotations.</p>
      )}
      {shared.length > 0 && (
        <p className="text-xs">
          <span className="font-bold">All samples: </span>
          {shared.map(([k, v]) => `${k}: ${v}`).join(' · ')}
        </p>
      )}
      <p className="text-xs">
        <span className="font-bold">Library: </span>
        {Object.entries(d.libraryStrategies).map(([k, v]) => `${k} ×${v}`).join(', ') || 'not stated'}
        {d.singleCellHints.length > 0 && <span className="ml-2 font-bold text-[var(--color-danger-ink)]">single-cell hints: {d.singleCellHints.join(', ')}</span>}
      </p>
    </div>
  );
}
