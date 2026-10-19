import { Copy } from 'lucide-react';
import { useState } from 'react';
import { Dialog } from './ui';

export const GITHUB_URL = 'https://github.com/rickintoplace/Omigator';
export const DOI_URL = 'https://doi.org/10.5281/zenodo.19020074';
const TITLE = 'Omigator: LLM-driven dataset scouting and selection for NCBI GEO';

export function CiteDialog({ version, onClose }: { version: string; onClose: () => void }) {
  const year = new Date().getFullYear();
  const formats = {
    APA: `Heilmann, E. (${year}). ${TITLE} (Version ${version}) [Computer software]. ${DOI_URL}`,
    BibTeX: `@software{omigator_${year},\n  title   = {${TITLE}},\n  author  = {Heilmann, Eirik},\n  year    = {${year}},\n  version = {${version}},\n  url     = {${GITHUB_URL}},\n  doi     = {10.5281/zenodo.19020074}\n}`,
    DOI: DOI_URL,
  };
  const [format, setFormat] = useState<keyof typeof formats>('APA');
  const [copied, setCopied] = useState(false);

  return (
    <Dialog title="Cite Omigator" onClose={onClose}>
      <div className="flex flex-wrap gap-2">
        {(Object.keys(formats) as (keyof typeof formats)[]).map((f) => (
          <button key={f} className={`brutal-button px-3 py-1.5 text-sm ${format === f ? 'bg-ink text-white' : ''}`} onClick={() => setFormat(f)}>
            {f}
          </button>
        ))}
        <button
          className="brutal-button px-3 py-1.5 text-sm gap-2 ml-auto"
          onClick={async () => {
            await navigator.clipboard.writeText(formats[format]).catch(() => undefined);
            setCopied(true);
          }}
        >
          <Copy className="w-4 h-4" /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <textarea className="brutal-input font-mono text-xs min-h-[150px]" readOnly value={formats[format]} />
    </Dialog>
  );
}
