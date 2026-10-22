/**
 * Motion of the logo's helix: the artwork's own helix paths, bent by a wave (user units of the SVG).
 *
 * The helix is held still at the head and swims: a wave runs from JOINT towards the tail that
 * slides the windings to and fro along the axis (which is how a turning helix looks from the side)
 * and sways the axis a little, both growing with the distance from the joint. Only the points of
 * the paths move, so the helix keeps the artwork's shapes and stays attached to the head; with
 * strength 0 it is exactly the artwork.
 */

/** Where the motion starts; from here it grows in until the tail at X_END. */
export const JOINT = 630;
const X_END = 1010;
/**
 * Largest slide along the axis and sway across it (user units), reached at the tail. The tail only
 * slides back towards the head (from 0 to −SLIDE) and sways little: the image has no room around it.
 */
const SLIDE = 56;
const SWAY = 8;
/**
 * Wave numbers of the slide and the sway. The slide's wave is long, so the slide stretches the
 * helix only a little (the bend must never fold a path over itself); the sway's is shorter.
 */
const SLIDE_WAVE = (2 * Math.PI) / 1400;
const SWAY_WAVE = (2 * Math.PI) / 650;

export type Segment = { cmd: 'M' | 'C' | 'L' | 'Z'; pts: number[] };

/**
 * Parses path data with M/m, L/l, C/c and Z/z (all the artwork uses) into absolute segments and
 * applies the group's transform matrix, so the paths can be drawn without it.
 */
export function parsePath(d: string, matrix: number[]): Segment[] {
  const [a, b, c, dd, e, f] = matrix;
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const out: Segment[] = [];
  let i = 0;
  let cmd = '';
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  const num = () => Number(tokens[i++]);
  const map = (px: number, py: number) => [a * px + c * py + e, b * px + dd * py + f];
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case 'M':
        x = ox + num();
        y = oy + num();
        startX = x;
        startY = y;
        out.push({ cmd: 'M', pts: map(x, y) });
        cmd = rel ? 'l' : 'L'; // further pairs are line-tos
        break;
      case 'L':
        x = ox + num();
        y = oy + num();
        out.push({ cmd: 'L', pts: map(x, y) });
        break;
      case 'C': {
        const p = [ox + num(), oy + num(), ox + num(), oy + num(), ox + num(), oy + num()];
        x = p[4];
        y = p[5];
        out.push({ cmd: 'C', pts: [...map(p[0], p[1]), ...map(p[2], p[3]), ...map(p[4], p[5])] });
        break;
      }
      case 'Z':
        x = startX;
        y = startY;
        out.push({ cmd: 'Z', pts: [] });
        break;
      default:
        throw new Error(`Unsupported path command ${cmd}`);
    }
  }
  return out;
}

export function parseMatrix(transform: string): number[] {
  const m = transform.match(/matrix\(([^)]+)\)/);
  return m ? m[1].split(/[\s,]+/).map(Number) : [1, 0, 0, 1, 0, 0];
}

const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The paths at `time` (radians, one stroke of the wave per 2π) with the motion at `strength`
 * (0 at rest, 1 in full swing), as path data.
 */
export function swim(paths: Segment[][], time: number, strength: number): string[] {
  const move = (x: number, y: number) => {
    const g = strength * smoothstep(JOINT, X_END, x);
    if (!g) return `${x.toFixed(2)} ${y.toFixed(2)}`;
    const d = x - JOINT;
    const nx = x + (g * SLIDE * (Math.sin(time - SLIDE_WAVE * d) - 1)) / 2;
    const ny = y + g * SWAY * Math.sin(time - SWAY_WAVE * d - 1.2);
    return `${nx.toFixed(2)} ${ny.toFixed(2)}`;
  };
  return paths.map((segments) =>
    segments
      .map(({ cmd, pts }) => {
        if (cmd === 'Z') return 'Z';
        const coords: string[] = [];
        for (let k = 0; k < pts.length; k += 2) coords.push(move(pts[k], pts[k + 1]));
        return cmd + coords.join(' ');
      })
      .join(''),
  );
}
