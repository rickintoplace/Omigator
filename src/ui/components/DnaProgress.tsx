import { useEffect, useRef } from 'react';
import { drawDna } from './dnaHelix';

/** Time constant with which the drawing follows the progress, so each step winds on smoothly. */
const FOLLOW_MS = 220;
/** One turn of the molecule about its axis while active. */
const SPIN_MS = 3200;
/** Time constant for the turning to start and to die down. */
const EASE_MS = 500;

/**
 * Progress of a run as a double strand that winds up into a helix while turning (see dnaHelix.ts).
 * It always takes its place, so nothing shifts when a run starts or ends. While inactive it shows
 * the finished helix, still and faint; a new run unwinds it to the ladder and winds it up again.
 */
export function DnaProgress({ progress, active, className = '' }: { progress: number; active: boolean; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const target = useRef(progress);
  target.current = progress;
  const activeRef = useRef(active);
  activeRef.current = active;
  const shown = useRef(progress);
  const frame = useRef(0);
  const size = useRef({ width: 0, height: 0 });
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const ink = getComputedStyle(el).color;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let spin = 0;
    let speed = 0;
    const render = () => {
      const { width, height } = size.current;
      const dpr = devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      drawDna(ctx, width, height, shown.current, spin, ink);
    };
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(now - last, 100);
      last = now;
      const diff = target.current - shown.current;
      shown.current = Math.abs(diff) < 1e-4 || still ? target.current : shown.current + diff * (1 - Math.exp(-dt / FOLLOW_MS));
      const goal = activeRef.current && !still ? 1 : 0;
      speed += (goal - speed) * (1 - Math.exp(-dt / EASE_MS));
      if (!goal && speed < 0.01) speed = 0;
      // Turning this way, the windings run from the front towards the start.
      spin = (spin - speed * (dt / SPIN_MS) * 2 * Math.PI) % (2 * Math.PI);
      render();
      frame.current = shown.current === target.current && !speed && !goal ? 0 : requestAnimationFrame(tick);
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

  useEffect(() => kick.current(), [progress, active]);

  return (
    <canvas
      ref={canvas}
      className={`block w-full transition-opacity duration-700 ${active ? '' : 'opacity-40'} ${className}`}
      role="progressbar"
      aria-label="Screening progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      aria-hidden={!active}
    />
  );
}
