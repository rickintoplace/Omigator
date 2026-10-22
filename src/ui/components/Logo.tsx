import { useEffect, useRef } from 'react';
import svgSource from '../../assets/omigator-logo.svg?raw';

/**
 * The Omigator logo: the crocodile head from the original artwork and a double helix drawn from
 * its geometry (measured from the artwork), so the helix can turn while a run is in progress.
 *
 * Each strand is y = CENTER ∓ AMP·cos(θ), θ = 2π(x − PEAK_X)/PERIOD + phase. A strand is in front
 * where it rises; back parts and base pairs get gaps where a front part crosses them.
 */

const paths = [...svgSource.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
const transform = svgSource.match(/<g transform="([^"]+)"/)?.[1] ?? '';
/** Paths of the drawn helix in the artwork; everything else is the head. */
const HELIX_PATHS = new Set([1, 2, 6, 7, 9, 12, 14, 15, 16, 22, 23]);
const HEAD = paths.filter((_, i) => !HELIX_PATHS.has(i));

const CENTER = 486;
const AMP = 108;
const PERIOD = 515;
const PEAK_X = 680;
const X_START = 380;
const X_END = 1004;
const RUNGS = [643, 695, 747, 893, 942, 992];
/** Ribbon width (user units) where a strand faces the viewer; it narrows to MIN_WIDTH edge-on. */
const FRONT_WIDTH = 36;
const BACK_WIDTH = 26;
const MIN_WIDTH = 3;
const RUNG_WIDTH = 11;
const GAP = 8;
/** One full turn while screening. */
const TURN_MS = 5200;

type Pt = { x: number; y: number; w: number };

/** A ribbon of varying width along a polyline, as a closed path. */
function ribbon(pts: Pt[]): string {
  const upper: string[] = [];
  const lower: string[] = [];
  pts.forEach((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    upper.push(`${(p.x + (nx * p.w) / 2).toFixed(1)} ${(p.y + (ny * p.w) / 2).toFixed(1)}`);
    lower.push(`${(p.x - (nx * p.w) / 2).toFixed(1)} ${(p.y - (ny * p.w) / 2).toFixed(1)}`);
  });
  return `M${upper.join('L')}L${lower.reverse().join('L')}Z`;
}

function helix(phase: number) {
  const front: string[] = [];
  const back: string[] = [];
  for (const sign of [-1, 1]) {
    let run: Pt[] = [];
    let runFront: boolean | undefined;
    const flush = () => {
      if (run.length > 1) (runFront ? front : back).push(ribbon(run));
      run = [];
    };
    for (let x = X_START; x <= X_END + 0.1; x += 3) {
      const theta = (2 * Math.PI * (x - PEAK_X)) / PERIOD + phase;
      const y = CENTER + sign * AMP * Math.cos(theta);
      const facing = sign * Math.sin(theta);
      // Rising (towards the top of the image) means facing the viewer.
      const isFront = facing > 0;
      const w = MIN_WIDTH + ((isFront ? FRONT_WIDTH : BACK_WIDTH) - MIN_WIDTH) * Math.abs(facing) ** 0.7;
      if (isFront !== runFront && run.length) {
        run.push({ x, y, w: MIN_WIDTH });
        flush();
      }
      runFront = isFront;
      run.push({ x, y, w });
    }
    flush();
  }
  const rungs = RUNGS.map((x) => {
    const theta = (2 * Math.PI * (x - PEAK_X)) / PERIOD + phase;
    const half = AMP * Math.abs(Math.cos(theta)) - 14;
    return half > 6 ? `M${x} ${CENTER - half}L${x} ${CENTER + half}` : '';
  }).join('');
  return { front: front.join(''), back: back.join(''), rungs };
}

/** Phase at which the drawn helix matches the original artwork. */
const REST = helix(0);

export function Logo({ active = false, className = '' }: { active?: boolean; className?: string }) {
  const frontRef = useRef<SVGPathElement>(null);
  const frontMaskRef = useRef<SVGPathElement>(null);
  const backRef = useRef<SVGPathElement>(null);
  const rungsRef = useRef<SVGPathElement>(null);
  const phase = useRef(0);

  useEffect(() => {
    if (!active || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      phase.current = (phase.current + ((now - last) / TURN_MS) * 2 * Math.PI) % (2 * Math.PI);
      last = now;
      const h = helix(phase.current);
      frontRef.current?.setAttribute('d', h.front);
      frontMaskRef.current?.setAttribute('d', h.front);
      backRef.current?.setAttribute('d', h.back);
      rungsRef.current?.setAttribute('d', h.rungs);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return (
    <svg viewBox="38 356 972 264" className={className} role="img" aria-label="Omigator">
      <defs>
        {/* Front strands cut gaps into what lies behind them. */}
        <mask id="omigator-helix-gaps" maskUnits="userSpaceOnUse" x="300" y="300" width="800" height="380">
          <rect x="300" y="300" width="800" height="380" fill="white" />
          <path ref={frontMaskRef} d={REST.front} fill="black" stroke="black" strokeWidth={2 * GAP} strokeLinejoin="round" />
        </mask>
        {/* The head hides the start of the helix, including the gaps between its facets. */}
        <mask id="omigator-behind-head" maskUnits="userSpaceOnUse" x="0" y="300" width="1100" height="380">
          <rect x="0" y="300" width="1100" height="380" fill="white" />
          <g transform={transform}>
            {HEAD.map((d, i) => (
              <path key={i} d={d} fill="black" stroke="black" strokeWidth={65} strokeLinejoin="round" />
            ))}
          </g>
        </mask>
        <clipPath id="omigator-helix-end">
          <rect x="0" y="300" width={X_END + 2} height="380" />
        </clipPath>
      </defs>
      <g mask="url(#omigator-behind-head)" clipPath="url(#omigator-helix-end)" fill="currentColor">
        <g mask="url(#omigator-helix-gaps)">
          <path ref={backRef} d={REST.back} />
          <path ref={rungsRef} d={REST.rungs} fill="none" stroke="currentColor" strokeWidth={RUNG_WIDTH} />
        </g>
        <path ref={frontRef} d={REST.front} />
      </g>
      <g transform={transform} fill="currentColor">
        {HEAD.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
    </svg>
  );
}
