import svgSource from '../../assets/omigator-logo.svg?raw';

/**
 * The Omigator logo as inline SVG, cropped to its drawing. While `active`, the DNA strand behind the
 * head sways like it is drifting in water: a slowly travelling noise field displaces it vertically.
 */

const paths = [...svgSource.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
const transform = svgSource.match(/<g transform="([^"]+)"/)?.[1] ?? '';
/** Paths of the double helix (measured from the drawing; the rest is the head). */
const DNA = new Set([1, 2, 6, 7, 9, 12, 14, 15, 16, 22, 23]);

export function Logo({ active = false, className = '' }: { active?: boolean; className?: string }) {
  return (
    <svg viewBox="38 356 972 264" className={className} role="img" aria-label="Omigator" data-active={active || undefined}>
      <defs>
        <filter id="omigator-sway" filterUnits="userSpaceOnUse" x="380" y="320" width="680" height="340">
          <feTurbulence type="fractalNoise" baseFrequency="0.0045 0.0008" numOctaves="1" seed="7" result="noise" />
          <feOffset in="noise" dx="0" result="moving">
            <animate attributeName="dx" values="0;420;0" dur="7s" repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1" />
          </feOffset>
          <feDisplacementMap in="SourceGraphic" in2="moving" scale="26" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
      <g transform={transform} fill="currentColor">
        {paths.map((d, i) => (DNA.has(i) ? null : <path key={i} d={d} />))}
      </g>
      <g filter={active ? 'url(#omigator-sway)' : undefined} className="logo-dna">
        <g transform={transform} fill="currentColor">
          {paths.map((d, i) => (DNA.has(i) ? <path key={i} d={d} /> : null))}
        </g>
      </g>
    </svg>
  );
}
