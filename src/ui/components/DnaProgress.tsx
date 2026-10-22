import { useEffect, useRef } from 'react';
import { drawDna } from './dnaHelix';

/** Time constant with which the drawing follows the progress, so each step closes up smoothly. */
const FOLLOW_MS = 1200;
/** Time constant for the line to close up the rest once the run is over. */
const FINISH_MS = 150;
/** One turn of the molecule about its axis. */
const SPIN_MS = -1400;
/** Time constant for the strands to spread out of the line at the start and to lie back at the end. */
const EASE_MS = 350;

/**
 * Progress of a run as a double helix on a line (see dnaHelix.ts). It draws the toolbar's bottom
 * edge itself, so it takes no room and nothing lies behind the helix: at rest it is the plain edge;
 * when a run starts, the strands spread out of it and turn; as datasets are done they close up
 * into a strong line from the left; at the end the line (or whatever is still open, if the run
 * was stopped) lies back into the plain edge.
 */
export function DnaProgress({ progress, active, className = '' }: { progress: number; active: boolean; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const target = useRef(progress);
  target.current = progress;
  const activeRef = useRef(active);
  activeRef.current = active;
  const frame = useRef(0);
  const size = useRef({ width: 0, height: 0 });
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const ink = getComputedStyle(el).color;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let shown = 0;
    let spin = 0;
    let presence = 0;
    const render = () => {
      const { width, height } = size.current;
      const dpr = devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      drawDna(ctx, width, height, shown, spin, presence, ink);
    };
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(now - last, 100);
      last = now;
      const ease = (from: number, to: number, ms: number) => (still || Math.abs(to - from) < 1e-3 ? to : from + (to - from) * (1 - Math.exp(-dt / ms)));
      if (activeRef.current && presence === 0) shown = target.current; // a new run starts from its own progress
      // Once the run is over, the line closes up quickly instead of following at its usual pace.
      shown = ease(shown, target.current, activeRef.current ? FOLLOW_MS : FINISH_MS);
      // At the end the line first catches up with the progress, then lies back into the edge.
      const settled = Math.abs(shown - target.current) < 1e-3;
      presence = ease(presence, activeRef.current ? 1 : settled ? 0 : presence, EASE_MS);
      if (!activeRef.current && presence < 0.01) presence = 0; // by now a line as thin as the edge
      if (!still) spin = (spin + presence * (dt / SPIN_MS) * 2 * Math.PI) % (2 * Math.PI);
      render();
      frame.current = !activeRef.current && presence === 0 ? 0 : requestAnimationFrame(tick);
    };
    kick.current = () => {
      if (frame.current) return;
      last = performance.now();
      frame.current = requestAnimationFrame(tick);
    };
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      size.current = { width, height };
      const dpr = devicePixelRatio || 1;
      el.width = Math.round(width * dpr);
      el.height = Math.round(height * dpr);
      render();
    });
    observer.observe(el);
    if (activeRef.current) kick.current();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, []);

  useEffect(() => kick.current(), [progress, active]);

  return (
    <canvas
      ref={canvas}
      className={`block pointer-events-none ${className}`}
      role="progressbar"
      aria-label="Screening progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      aria-hidden={!active}
    />
  );
}
