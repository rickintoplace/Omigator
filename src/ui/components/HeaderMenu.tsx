import { ExternalLink, Menu } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/**
 * Below lg the header has no room for Cite, Code and the legal links; they live in this menu,
 * so they stay one tap away on every screen.
 */
export function HeaderMenu({ codeUrl, onCite }: { codeUrl: string; onCite: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    const onDown = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    addEventListener('keydown', onKey);
    addEventListener('pointerdown', onDown);
    return () => {
      removeEventListener('keydown', onKey);
      removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  const item = 'flex items-center gap-2 px-4 py-2.5 hover-surface';
  return (
    <div ref={root} className="relative lg:hidden">
      <button ref={button} className="brutal-button px-3 py-1.5 text-sm bg-white" onClick={() => setOpen(!open)} aria-label="More" title="More" aria-expanded={open}>
        <Menu className="w-4 h-4" />
      </button>
      {open && (
        <nav className="absolute right-0 top-full mt-3 z-30 min-w-[11rem] flex flex-col py-1 text-sm font-semibold brutal-border bg-[var(--color-paper)] brutal-shadow" aria-label="More">
          <button
            className={`${item} text-left`}
            onClick={() => {
              setOpen(false);
              onCite();
            }}
          >
            Cite
          </button>
          <a className={item} href={codeUrl} target="_blank" rel="noreferrer">
            Code <ExternalLink className="w-3.5 h-3.5" />
          </a>
          <a className={item} href="/legal.html#privacy">
            Privacy
          </a>
          <a className={item} href="/legal.html#imprint">
            Imprint
          </a>
        </nav>
      )}
    </div>
  );
}
