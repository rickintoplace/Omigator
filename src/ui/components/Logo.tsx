import { useEffect, useRef, useState } from 'react';
import svgSource from '../../assets/omigator-logo.svg?raw';

/**
 * The Omigator logo. At rest it is the original artwork. While a run is in progress the part of the
 * helix away from the head cross-fades to a helix drawn from the artwork's geometry, which turns so
 * that its windings travel away from the head; the part at the head stays still. When the run ends
 * or is stopped, it fades straight back to the artwork.
 *
 * Each strand is y = CENTER ∓ AMP·cos(θ), θ = 2π(x − PEAK_X)/PERIOD + phase. A strand is in front
 * where it rises; back parts and base pairs get gaps where a front part crosses them.
 */

const paths = [...svgSource.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
const transform = svgSource.match(/<g transform="([^"]+)"/)?.[1] ?? '';
/** Paths of the drawn helix in the artwork. */
const HELIX_PATHS = new Set([1, 2, 6, 7, 9, 12, 14, 15, 16, 22, 23]);
/** A neck plate that shows between the strands; it belongs to the still artwork only. */
const NECK_PLATE = 24;
const HEAD = paths.filter((_, i) => !HELIX_PATHS.has(i) && i !== NECK_PLATE);
const ART_ONLY = paths.filter((_, i) => HELIX_PATHS.has(i) || i === NECK_PLATE);

const CENTER = 486;
const AMP = 108;
const PERIOD = 515;
const PEAK_X = 680;
const X_START = 380;
const X_END = 1004;
const K = (2 * Math.PI) / PERIOD;
/** Base pairs: ten per turn, attached to the strands, so they travel with them. */
const RUNG_SPACING = PERIOD / 10;
const RUNG_ORIGIN = 638.5;
/** Ribbon width (user units) where a strand faces the viewer; it narrows to MIN_WIDTH edge-on. */
const FRONT_WIDTH = 36;
const BACK_WIDTH = 26;
const MIN_WIDTH = 3;
const RUNG_WIDTH = 11;
const GAP = 8;
/** The head's outline (hiding the helix behind it) is this soft. */
const SOFT_EDGE = 11;
/**
 * Next to the head the artwork's helix (with the neck plate) stays still while the drawn helix
 * turns; the two cross-fade over this x range, so the head stays joined to the helix.
 */
const BLEND_FROM = 612;
const BLEND_TO = 672;
/** Matches the CSS opacity transition of .logo-layer. */
const FADE_MS = 350;
/** One full turn. */
const TURN_MS = 4800;

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

const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

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
      const theta = K * (x - PEAK_X) + phase;
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
  // Base pairs move with the strands: x shifts by −phase/K.
  const shift = -phase / K;
  const first = Math.ceil((X_START - RUNG_ORIGIN - shift) / RUNG_SPACING);
  const rungs: string[] = [];
  for (let k = first; ; k++) {
    const x = RUNG_ORIGIN + shift + k * RUNG_SPACING;
    if (x > X_END - 6) break;
    const spread = Math.abs(Math.cos(K * (x - PEAK_X) + phase));
    // Near a crossing the pair is short and hidden behind the front strand; fade it out there.
    const half = (AMP * spread - 14) * smoothstep(0.45, 0.7, spread);
    if (half > 2) rungs.push(`M${x.toFixed(1)} ${(CENTER - half).toFixed(1)}L${x.toFixed(1)} ${(CENTER + half).toFixed(1)}`);
  }
  return { front: front.join(''), back: back.join(''), rungs: rungs.join('') };
}

const REST = helix(0);

export function Logo({ active = false, className = '' }: { active?: boolean; className?: string }) {
  const frontRef = useRef<SVGPathElement>(null);
  const frontMaskRef = useRef<SVGPathElement>(null);
  const backRef = useRef<SVGPathElement>(null);
  const rungsRef = useRef<SVGPathElement>(null);
  const phase = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  /** True while the drawn helix is shown instead of the artwork. */
  const [turning, setTurning] = useState(false);
  const frame = useRef(0);

  useEffect(() => {
    if (!active || frame.current || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setTurning(true);
    let last = performance.now();
    const draw = (p: number) => {
      const h = helix(p);
      frontRef.current?.setAttribute('d', h.front);
      frontMaskRef.current?.setAttribute('d', h.front);
      backRef.current?.setAttribute('d', h.back);
      rungsRef.current?.setAttribute('d', h.rungs);
    };
    let stoppedAt = 0;
    const tick = (now: number) => {
      // Decreasing phase moves the windings to the right, away from the head.
      phase.current = (phase.current - ((now - last) / TURN_MS) * 2 * Math.PI) % (2 * Math.PI);
      last = now;
      if (!activeRef.current && !stoppedAt) {
        // Run ended or was stopped: fade back to the artwork right away, keep turning while fading.
        stoppedAt = now;
        setTurning(false);
      }
      if (stoppedAt && now - stoppedAt > FADE_MS) {
        phase.current = 0;
        draw(0);
        frame.current = 0;
        return;
      }
      draw(phase.current);
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }, [active]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  return (
    <svg viewBox="38 356 972 264" className={className} role="img" aria-label="Omigator">
      <defs>
        {/* Front strands cut gaps into what lies behind them. */}
        <mask id="omigator-helix-gaps" maskUnits="userSpaceOnUse" x="300" y="300" width="800" height="380">
          <rect x="300" y="300" width="800" height="380" fill="white" />
          <path ref={frontMaskRef} d={REST.front} fill="black" stroke="black" strokeWidth={2 * GAP} strokeLinejoin="round" />
        </mask>
        {/*
          The helix grows out of the head: it fades in from FADE_FROM to FADE_TO, and the head's
          silhouette (blurred) hides it softly where the two overlap.
        */}
        <linearGradient id="omigator-fade" gradientUnits="userSpaceOnUse" x1={BLEND_FROM} y1="0" x2={BLEND_TO} y2="0">
          <stop offset="0" stopColor="black" />
          <stop offset="1" stopColor="white" />
        </linearGradient>
        <linearGradient id="omigator-rigid-fade" gradientUnits="userSpaceOnUse" x1={BLEND_FROM} y1="0" x2={BLEND_TO} y2="0">
          <stop offset="0" stopColor="white" />
          <stop offset="1" stopColor="black" />
        </linearGradient>
        <mask id="omigator-rigid" maskUnits="userSpaceOnUse" x="0" y="300" width="1100" height="380">
          <rect x="0" y="300" width="1100" height="380" fill="url(#omigator-rigid-fade)" />
        </mask>
        <filter id="omigator-soft" filterUnits="userSpaceOnUse" x="0" y="300" width="1100" height="380">
          <feGaussianBlur stdDeviation={SOFT_EDGE} />
        </filter>
        <mask id="omigator-behind-head" maskUnits="userSpaceOnUse" x="0" y="300" width="1100" height="380">
          <rect x="0" y="300" width="1100" height="380" fill="url(#omigator-fade)" />
          <g filter="url(#omigator-soft)">
            <g transform={transform}>
              {HEAD.map((d, i) => (
                <path key={i} d={d} fill="black" stroke="black" strokeWidth={65} strokeLinejoin="round" />
              ))}
            </g>
          </g>
        </mask>
        <clipPath id="omigator-helix-end">
          <rect x="0" y="300" width={X_END + 2} height="380" />
        </clipPath>
      </defs>
      {/* The artwork's helix: all of it at rest, only the part at the head while turning. */}
      <g className="logo-layer" data-visible={!turning} transform={transform} fill="currentColor">
        {ART_ONLY.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
      <g mask="url(#omigator-rigid)">
        <g transform={transform} fill="currentColor">
          {ART_ONLY.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </g>
      </g>
      <g className="logo-layer" data-visible={turning} mask="url(#omigator-behind-head)" clipPath="url(#omigator-helix-end)" fill="currentColor">
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
