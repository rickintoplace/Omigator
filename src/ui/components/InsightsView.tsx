import { Shuffle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { bootstrap, confusion, conformalCutoff, type DatasetResult, normalizeGseList, rankingMetrics, recallEstimate } from '../../core';
import { pct } from './ui';

export interface InsightsProps {
  results: DatasetResult[];
  labels: Record<string, boolean>;
  goldText: string;
  onGoldText: (t: string) => void;
  onAudit: () => void;
}

const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : '–');

export function InsightsView({ results, labels, goldText, onGoldText, onAudit }: InsightsProps) {
  const [target, setTarget] = useState(0.95);
  const screened = useMemo(() => results.filter((r) => r.screening), [results]);
  const labelled = screened.filter((r) => labels[r.gse] !== undefined);
  const positives = labelled.filter((r) => labels[r.gse]);
  const negatives = labelled.length - positives.length;

  const cut = conformalCutoff(positives.map((r) => r.screening!.logScore), 1 - target);
  const reviewRank = positives.length ? screened.filter((r) => r.screening!.logScore >= cut.cutoff).length : undefined;
  const includeRecall = recallEstimate(
    positives.map((r) => (r.screening!.decision === 'include' ? 1 : 0)),
    1,
  );

  const gold = useMemo(() => new Set(normalizeGseList(goldText)), [goldText]);
  const goldMetrics = useMemo(() => {
    if (!gold.size || !screened.length) return undefined;
    const items = screened.map((r) => ({ id: r.gse, score: r.screening!.logScore, positive: gold.has(r.gse) }));
    const m = rankingMetrics(items, [10, 20, 50, 100], gold.size);
    const ci = bootstrap(items, (xs) => rankingMetrics(xs).auroc, 1000);
    const actual = items.map((x) => x.positive);
    return {
      m,
      ci,
      include: confusion(screened.map((r) => r.screening!.decision === 'include'), actual),
      kept: confusion(screened.map((r) => r.screening!.decision !== 'exclude'), actual),
    };
  }, [gold, screened]);

  return (
    <div className="p-6 space-y-8 max-w-4xl">
      <section className="brutal-border bg-[var(--color-paper)] p-4 space-y-3">
        <h3 className="font-display text-xl uppercase">How much can you trust the cut-off?</h3>
        <p className="text-sm">
          Model probabilities are not calibrated for your question. Mark datasets as relevant 👍 or not 👎 in the list and Omigator
          estimates how many relevant datasets the decisions keep. Label a <b>random</b> sample, not just the top of the list — otherwise
          the estimate is too optimistic.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button className="brutal-button px-3 py-2 text-sm gap-2" onClick={onAudit} disabled={!screened.length}>
            <Shuffle className="w-4 h-4" /> Label a random sample of 10
          </button>
          <span className="text-sm">
            Labelled: <b>{positives.length}</b> relevant, <b>{negatives}</b> not relevant
          </span>
        </div>

        {positives.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2 text-sm">
            <div className="brutal-border p-3 bg-[var(--color-surface)]">
              <div className="text-xs font-bold uppercase mb-1">“Include” keeps</div>
              <div className="font-display text-2xl">{pct(includeRecall.recall)}</div>
              <div className="text-xs text-[var(--color-muted)]">
                of your relevant labels (95% CI {pct(includeRecall.low)}–{pct(includeRecall.high)}, n = {positives.length})
              </div>
            </div>
            <div className="brutal-border p-3 bg-[var(--color-surface)]">
              <div className="text-xs font-bold uppercase mb-1 flex items-center gap-2">
                To keep
                <select className="brutal-border px-1 text-xs" value={target} onChange={(e) => setTarget(Number(e.target.value))}>
                  <option value={0.9}>90%</option>
                  <option value={0.95}>95%</option>
                  <option value={0.99}>99%</option>
                </select>
                of relevant datasets
              </div>
              <div className="font-display text-2xl">read the top {reviewRank}</div>
              <div className="text-xs text-[var(--color-muted)]">
                {cut.guaranteed
                  ? `Conformal bound from ${positives.length} relevant labels; holds if they are a random sample of all relevant datasets.`
                  : `Rough estimate. A guarantee at this level needs ≥ ${cut.positivesNeeded} relevant labels from a random sample.`}{' '}
                {reviewRank !== undefined && `The remaining ${screened.length - reviewRank} can be skipped.`}
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="brutal-border bg-[var(--color-paper)] p-4 space-y-3">
        <h3 className="font-display text-xl uppercase">Compare with a reference list</h3>
        <p className="text-sm">
          Paste the GSE accessions a published meta-analysis included. Everything else counts as not relevant, so precision is a lower bound.
        </p>
        <textarea className="brutal-input min-h-[70px] font-mono text-sm" value={goldText} onChange={(e) => onGoldText(e.target.value)} placeholder="GSE101526, GSE104193, …" />
        {goldMetrics && (
          <div className="text-sm space-y-2">
            <p>
              {gold.size} reference datasets; <b>{goldMetrics.m.positives}</b> of them were screened in this run (the rest were not found by the
              search or removed by filters).
            </p>
            <table className="text-sm border-collapse">
              <tbody>
                {[
                  ['AUROC', `${f3(goldMetrics.m.auroc)} [${f3(goldMetrics.ci[0])}–${f3(goldMetrics.ci[1])}]`],
                  ['Average precision', f3(goldMetrics.m.averagePrecision)],
                  ['Precision @20 / @50', `${f3(goldMetrics.m.precisionAt[20])} / ${f3(goldMetrics.m.precisionAt[50])}`],
                  ['Recall @20 / @50 / @100', `${f3(goldMetrics.m.recallAt[20])} / ${f3(goldMetrics.m.recallAt[50])} / ${f3(goldMetrics.m.recallAt[100])}`],
                  ['Work saved at 95% recall', `${pct(goldMetrics.m.wss95)} (read ${goldMetrics.m.readFor95} of ${goldMetrics.m.n})`],
                  ['“Include”: precision / recall', `${f3(goldMetrics.include.precision)} / ${f3(goldMetrics.include.recall)}`],
                  ['Not excluded: precision / recall', `${f3(goldMetrics.kept.precision)} / ${f3(goldMetrics.kept.recall)}`],
                ].map(([k, v]) => (
                  <tr key={k} className="border-t border-[var(--color-line)]">
                    <td className="py-1 pr-6 font-bold">{k}</td>
                    <td className="py-1 font-mono">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
