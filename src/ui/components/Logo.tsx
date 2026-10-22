import { useEffect, useRef } from 'react';
import svgSource from '../../assets/omigator-logo.svg?raw';
import { parseMatrix, parsePath, swim } from './logoHelix';

/**
 * The Omigator logo. While a run is in progress its helix swims: a wave runs from the head to the
 * tail (see logoHelix.ts). The wave swells in when the run starts and dies down when it ends or is
 * stopped, back to the artwork as it is.
 */

const paths = [...svgSource.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
const transform = svgSource.match(/<g transform="([^"]+)"/)?.[1] ?? '';
/** Paths of the helix in the artwork, with the neck plate that shows between its strands. */
const HELIX_PATHS = new Set([1, 2, 6, 7, 9, 12, 14, 15, 16, 22, 23, 24]);
const HEAD = paths.filter((_, i) => !HELIX_PATHS.has(i));
const HELIX = paths.filter((_, i) => HELIX_PATHS.has(i)).map((d) => parsePath(d, parseMatrix(transform)));
const REST = swim(HELIX, 0, 0);

/** One stroke of the wave. */
const STROKE_MS = 2600;
/** Time constant for the wave to swell in and die down. */
const EASE_MS = 300;

export function Logo({ active = false, className = '' }: { active?: boolean; className?: string }) {
  const helixRefs = useRef<(SVGPathElement | null)[]>([]);
  const activeRef = useRef(active);
  activeRef.current = active;
  const frame = useRef(0);

  useEffect(() => {
    if (!active || frame.current || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let last = performance.now();
    let time = 0;
    let strength = 0;
    const draw = (ds: string[]) => ds.forEach((d, i) => helixRefs.current[i]?.setAttribute('d', d));
    const tick = (now: number) => {
      const dt = Math.min(now - last, 100);
      last = now;
      time += (dt / STROKE_MS) * 2 * Math.PI;
      const target = activeRef.current ? 1 : 0;
      strength += (target - strength) * (1 - Math.exp(-dt / EASE_MS));
      if (!target && strength < 0.01) {
        draw(REST);
        frame.current = 0;
        return;
      }
      draw(swim(HELIX, time, strength));
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }, [active]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  return (
    <svg viewBox="38 356 972 264" className={className} role="img" aria-label="Omigator">
      <g fill="currentColor">
        {REST.map((d, i) => (
          <path key={i} ref={(el) => void (helixRefs.current[i] = el)} d={d} />
        ))}
      </g>
      <g transform={transform} fill="currentColor">
        {HEAD.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
    </svg>
  );
}
