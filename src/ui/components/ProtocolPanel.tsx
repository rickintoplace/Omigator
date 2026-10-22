import { LoaderCircle, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { type Criterion, type CriterionKind, type Protocol, slug } from '../../core';
import { Card, Field, Hint } from './ui';

export type InputMode = 'search' | 'list';

export interface ProtocolPanelProps {
  protocol: Protocol;
  onChange: (p: Protocol) => void;
  mode: InputMode;
  onMode: (m: InputMode) => void;
  retmax: number;
  onRetmax: (n: number) => void;
  gseText: string;
  onGseText: (t: string) => void;
  hitCount: { count?: number; loading: boolean; error?: string };
  drafting: boolean;
  draftError?: string;
  onDraft?: () => void;
  readOnly?: boolean;
}

const KINDS: { kind: CriterionKind; label: string; hint: string }[] = [
  { kind: 'require', label: 'Must', hint: 'must be true' },
  { kind: 'exclude', label: 'Must not', hint: 'disqualifies when true' },
  { kind: 'prefer', label: 'Nice', hint: 'only improves the ranking' },
];

export function ProtocolPanel(props: ProtocolPanelProps) {
  const { protocol, onChange, readOnly } = props;
  const set = (patch: Partial<Protocol>) => onChange({ ...protocol, ...patch });
  const setFilters = (patch: Partial<Protocol['filters']>) => set({ filters: { ...protocol.filters, ...patch } });
  const setCriterion = (i: number, patch: Partial<Criterion>) =>
    set({ criteria: protocol.criteria.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const f = protocol.filters;
  const activeFilters = [f.organism, f.assay && `assay: ${f.assay}`, f.minSamples ? `≥ ${f.minSamples} samples` : '', f.minDate && `from ${f.minDate}`, f.maxDate && `until ${f.maxDate}`].filter(Boolean);

  return (
    <fieldset className="space-y-5 min-w-0" disabled={readOnly}>
      <Card
        step="1"
        title="Your request"
        className="border-l-[6px]"
        aside={
          props.onDraft && (
            <button className="brutal-button px-2 py-1 text-xs" onClick={props.onDraft} disabled={props.drafting || !protocol.intent.trim()} title="Draft search and checklist again from this text">
              {props.drafting ? <LoaderCircle className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Redraft
            </button>
          )
        }
      >
        <textarea className="brutal-input min-h-[6rem] resize-y" value={protocol.intent} onChange={(e) => set({ intent: e.target.value })} placeholder="What data do you need?" aria-label="Your request" />
        {props.draftError && <p className="text-sm text-[var(--color-danger-ink)]">{props.draftError}</p>}
      </Card>

      <Card step="2" title="Where to look">
        <div className="grid grid-cols-2 brutal-border text-sm font-semibold">
          {(['search', 'list'] as const).map((m) => (
            <button key={m} className={`py-1.5 ${props.mode === m ? 'bg-ink text-white' : 'bg-[var(--color-paper)] hover-surface'}`} onClick={() => props.onMode(m)}>
              {m === 'search' ? 'Search GEO' : 'My GSE list'}
            </button>
          ))}
        </div>

        {props.mode === 'search' ? (
          <>
            <Field
              label="GEO search"
              hint={
                props.hitCount.loading ? (
                  'Counting matching series…'
                ) : props.hitCount.error ? (
                  <span className="text-[var(--color-danger-ink)]">{props.hitCount.error}</span>
                ) : props.hitCount.count !== undefined ? (
                  <>
                    <b className="text-[var(--color-ink)]">{props.hitCount.count.toLocaleString()}</b> series match, including the filters below.
                  </>
                ) : (
                  <>Entrez syntax, e.g. <code>(hypoxia OR anoxia) AND RNA-seq</code></>
                )
              }
            >
              <textarea className="brutal-input mono text-sm min-h-[6rem] resize-y" value={protocol.query} onChange={(e) => set({ query: e.target.value })} />
            </Field>
            <Field label="Screen at most" hint="Datasets are taken in GEO's order; raise this to screen everything that matches.">
              <input type="number" className="brutal-input" min={1} max={2000} value={props.retmax} onChange={(e) => props.onRetmax(Math.max(1, Math.min(2000, Number(e.target.value) || 1)))} />
            </Field>
          </>
        ) : (
          <Field label="GSE accessions" hint="Paste IDs, links or any text; every GSE number is picked up.">
            <textarea className="brutal-input mono text-sm min-h-[6rem] resize-y" value={props.gseText} onChange={(e) => props.onGseText(e.target.value)} placeholder="GSE52695, GSE139673 …" />
          </Field>
        )}

        <details className="brutal-border">
          <summary className="px-3 py-2 text-sm flex justify-between gap-2">
            <span className="font-semibold">Filters</span>
            <span className="text-[var(--color-muted)] truncate">{activeFilters.join(' · ') || 'none'}</span>
          </summary>
          <div className="p-3 pt-1 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Organism">
                <input className="brutal-input" list="organisms" value={f.organism ?? ''} onChange={(e) => setFilters({ organism: e.target.value })} placeholder="any" />
                <datalist id="organisms">
                  <option value="Homo sapiens" />
                  <option value="Mus musculus" />
                  <option value="Rattus norvegicus" />
                  <option value="Danio rerio" />
                </datalist>
              </Field>
              <Field label="Assay">
                <select className="brutal-select" value={f.assay ?? ''} onChange={(e) => setFilters({ assay: e.target.value })}>
                  <option value="">any</option>
                  <option value="high throughput sequencing">sequencing</option>
                  <option value="array">microarray</option>
                </select>
              </Field>
              <Field label="Min. samples">
                <input type="number" className="brutal-input" min={0} value={f.minSamples ?? 0} onChange={(e) => setFilters({ minSamples: Number(e.target.value) || 0 })} />
              </Field>
              <div />
              <Field label="Published from">
                <input type="date" className="brutal-input" value={f.minDate ?? ''} onChange={(e) => setFilters({ minDate: e.target.value })} />
              </Field>
              <Field label="until">
                <input type="date" className="brutal-input" value={f.maxDate ?? ''} onChange={(e) => setFilters({ maxDate: e.target.value })} />
              </Field>
            </div>
          </div>
        </details>
      </Card>

      <Card step="3" title="Checklist">
        <Hint>
          Every dataset is checked against each line, sample annotations included. One statement per line, phrased as what is true when it
          applies.
        </Hint>
        <ul className="space-y-2">
          {protocol.criteria.map((c, i) => (
            <li key={i} className="brutal-border">
              <div className="flex items-stretch brutal-border-b">
                {KINDS.map((k) => (
                  <button
                    key={k.kind}
                    className={`px-2 py-0.5 text-xs font-semibold border-r-2 border-[var(--color-ink)] ${c.kind === k.kind ? `kind-${k.kind}` : 'bg-[var(--color-paper)] text-[var(--color-muted)] hover-surface'}`}
                    onClick={() => setCriterion(i, { kind: k.kind })}
                    title={k.hint}
                    aria-pressed={c.kind === k.kind}
                  >
                    {k.label}
                  </button>
                ))}
                <span className="flex-1" />
                <button className="px-2 hover-surface" onClick={() => set({ criteria: protocol.criteria.filter((_, j) => j !== i) })} aria-label="Remove criterion" title="Remove">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <textarea
                className="w-full text-sm resize-y min-h-[3rem] px-2 py-1.5 outline-none focus:bg-[var(--color-surface)]"
                value={c.text}
                placeholder="e.g. Each condition has at least two biological replicates."
                onChange={(e) => setCriterion(i, { text: e.target.value })}
                onBlur={() => {
                  // Give new criteria a readable id (used as tag) once they have text.
                  if (!/^criterion_\d+$/.test(c.id) || !c.text.trim()) return;
                  const taken = new Set(protocol.criteria.filter((_, j) => j !== i).map((x) => x.id));
                  let id = slug(c.text);
                  for (let n = 2; taken.has(id); n++) id = `${slug(c.text)}_${n}`;
                  setCriterion(i, { id });
                }}
              />
            </li>
          ))}
        </ul>
        <button
          className="brutal-button w-full py-1.5 text-sm"
          onClick={() => {
            const ids = new Set(protocol.criteria.map((c) => c.id));
            let n = protocol.criteria.length + 1;
            while (ids.has(`criterion_${n}`)) n++;
            set({ criteria: [...protocol.criteria, { id: `criterion_${n}`, kind: 'require', text: '' }] });
          }}
        >
          <Plus className="w-4 h-4" /> Add criterion
        </button>
      </Card>
    </fieldset>
  );
}
