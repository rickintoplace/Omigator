import { useEffect, useRef } from 'react';
import { drawDna } from './dnaHelix';

/** Time constant with which the drawing follows the progress, so each step winds on smoothly. */
const FOLLOW_MS = 220;

/** Progress of a run as a double strand that winds up into a helix (see dnaHelix.ts). */
export function DnaProgress({ done, total, className = '' }: { done: number; total: number; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const target = useRef(0);
  target.current = total ? done / total : 0;
  const shown = useRef(0);
  const frame = useRef(0);
  const size = useRef({ width: 0, height: 0 });
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const ink = getComputedStyle(el).color;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const render = () => {
      const { width, height } = size.current;
      const dpr = devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      drawDna(ctx, width, height, shown.current, ink);
    };
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(now - last, 100);
      last = now;
      const diff = target.current - shown.current;
      shown.current = Math.abs(diff) < 1e-4 || still ? target.current : shown.current + diff * (1 - Math.exp(-dt / FOLLOW_MS));
      render();
      frame.current = shown.current === target.current ? 0 : requestAnimationFrame(tick);
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
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, []);

  useEffect(() => kick.current(), [done, total]);

  return (
    <canvas
      ref={canvas}
      className={`block w-full ${className}`}
      role="progressbar"
      aria-label="Screening progress"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
    />
  );
}
