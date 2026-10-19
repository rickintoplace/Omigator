import type { DatasetResult, Protocol, RunManifest } from '../core';

function download(name: string, type: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const cell = (v: unknown) => {
  const s = String(v ?? '');
  // Leading =,+,-,@ would be evaluated as formulas by spreadsheet apps.
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

export function exportCsv(results: DatasetResult[], protocol: Protocol, labels: Record<string, boolean>) {
  const ids = protocol.criteria.map((c) => c.id);
  const header = ['rank', 'gse', 'decision', 'your_label', 'log_score', ...ids.map((id) => `p_${id}`), 'title', 'organisms', 'n_samples', 'published', 'pmids', 'explanation', 'model', 'error'];
  const rows = results.map((r, i) => [
    i + 1,
    r.gse,
    r.screening?.decision ?? (r.error ? 'failed' : ''),
    labels[r.gse] === undefined ? '' : labels[r.gse] ? 'relevant' : 'not relevant',
    r.screening?.logScore.toFixed(4),
    ...ids.map((id) => r.screening?.p[id]?.toFixed(4)),
    r.candidate.title,
    r.candidate.organisms,
    r.candidate.nSamples,
    r.candidate.pubDate,
    r.candidate.pmids.join(' '),
    r.explanation?.summary,
    r.screening?.model,
    r.error,
  ]);
  download(`omigator-${stamp()}.csv`, 'text/csv', [header, ...rows].map((row) => row.map(cell).join(',')).join('\n'));
}

/** Everything needed to reproduce and audit the run: protocol, models, thresholds, per-dataset results. */
export function exportJson(results: DatasetResult[], manifest: RunManifest | undefined, labels: Record<string, boolean>) {
  const screened = results.filter((r) => r.screening);
  const counts = manifest && {
    ...manifest.counts,
    screened: screened.length,
    failed: results.length - screened.length,
    include: screened.filter((r) => r.screening!.decision === 'include').length,
    unclear: screened.filter((r) => r.screening!.decision === 'unclear').length,
    exclude: screened.filter((r) => r.screening!.decision === 'exclude').length,
  };
  const body = {
    manifest: manifest && { ...manifest, counts },
    labels,
    results: results.map((r) => ({
      gse: r.gse,
      candidate: r.candidate,
      screening: r.screening,
      explanation: r.explanation,
      error: r.error,
      evidence: r.dossier?.text,
    })),
  };
  download(`omigator-${stamp()}.json`, 'application/json', JSON.stringify(body, null, 2));
}
