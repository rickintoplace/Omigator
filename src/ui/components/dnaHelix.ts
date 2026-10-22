/**
 * Drawing of the progress helix (CSS pixels). It lies on a line (the toolbar's bottom edge): a
 * faint double helix turning about that line, whose two strands close up into one strong line
 * where the work is done. Its height is set where it is used (DnaProgress in App.tsx); the look
 * is set by the constants below.
 *
 * A strand at angle α = 2π·x/turn + spin lies at y = mid − swing·cos α and faces the viewer where
 * sin α > 0. Where the work is done the swing is 0, with a soft front of FRONT pixels. `presence`
 * spreads the strands out of the line when a run starts and lays them back into it at the end;
 * at 0 nothing is drawn, and just before that everything is a line of LINE_REST width, the same
 * as the edge it lies on.
 */

// ---- Look (sizes relative to the bar's height unless noted) ----
/** Length of one turn of the helix. */
const TURN = 4.2;
/** Swing of the strands from the middle (0.5 reaches the edges). */
const SWING = 0.34;
/** Width of a strand facing the viewer; it narrows to EDGE_ON of that where seen edge-on. */
const STRAND = 0.12;
const EDGE_ON = 0.3;
/** Gap a front strand leaves around itself where it crosses one behind. */
const GAP = 0.08;
/** Width of a base pair, relative to a strand. */
const PAIR = 0.45;
/** Base pairs per turn. */
const PAIRS = 6;
/** Width of the soft front where the strands close up (pixels). */
const FRONT = 60;
/** Width of the line the strands close up into, and of the edge it lies on (pixels). */
const LINE = 4;
const LINE_REST = 2;
/** Opacity of the part done and of the helix still ahead. */
const DONE = 1;
const AHEAD = 0.3;

type Pt = { x: number; y: number; w: number };

const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Outline of a ribbon of varying width along a polyline: its two long sides. */
function sides(pts: Pt[]): [number, number][][] {
  const upper: [number, number][] = [];
  const lower: [number, number][] = [];
  pts.forEach((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = (-(b.y - a.y) / len) * (p.w / 2);
    const ny = ((b.x - a.x) / len) * (p.w / 2);
    upper.push([p.x + nx, p.y + ny]);
    lower.push([p.x - nx, p.y - ny]);
  });
  return [upper, lower];
}

function ribbon(ctx: CanvasRenderingContext2D, pts: Pt[]) {
  const [upper, lower] = sides(pts);
  ctx.beginPath();
  upper.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  lower.reverse().forEach(([x, y]) => ctx.lineTo(x, y));
  ctx.closePath();
}

/**
 * Draws the helix at `progress` (0–1), turned by `spin` (radians), spread out by `presence` (0–1),
 * into a cleared context of `width` × `height` CSS pixels.
 */
export function drawDna(ctx: CanvasRenderingContext2D, width: number, height: number, progress: number, spin: number, presence: number, ink: string) {
  if (presence <= 0) return;
  const mid = height / 2;
  const swing = height * SWING * presence;
  const strandWidth = Math.max(1.2, height * STRAND);
  const gap = Math.max(0.8, height * GAP);
  const K = (2 * Math.PI) / (height * TURN);
  const line = LINE_REST + (LINE - LINE_REST) * presence;
  // The front moves from just before the left edge to just past the right one.
  const front = -FRONT / 2 + progress * (width + FRONT);
  const closedAt = (x: number) => 1 - smoothstep(front - FRONT / 2, front + FRONT / 2, x);
  const n = Math.ceil(width) + 1;

  const fronts: Pt[][] = [];
  const backs: Pt[][] = [];
  for (const offset of [0, Math.PI]) {
    let run: Pt[] = [];
    let runFront: boolean | undefined;
    for (let i = 0; i < n; i++) {
      const x = Math.min(width, i);
      const closed = closedAt(x);
      const a = K * x + spin + offset;
      const facing = Math.sin(a);
      const isFront = facing >= 0;
      // Edge-on a strand narrows; closing up, both strands become the line.
      const open = strandWidth * (EDGE_ON + (1 - EDGE_ON) * Math.abs(facing) ** 0.7);
      const p = { x, y: mid - swing * (1 - closed) * Math.cos(a), w: open + (line - open) * closed };
      if (isFront !== runFront && run.length) {
        run.push(p);
        (runFront ? fronts : backs).push(run);
        run = [];
      }
      runFront = isFront;
      run.push(p);
    }
    if (run.length > 1) (runFront ? fronts : backs).push(run);
  }

  ctx.save();
  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;
  // Behind: back halves of the strands and the base pairs.
  for (const r of backs) {
    ribbon(ctx, r);
    ctx.fill();
  }
  ctx.lineWidth = Math.max(0.8, strandWidth * PAIR);
  const spacing = (height * TURN) / PAIRS;
  // Base pairs sit at fixed points of the molecule and turn with it.
  const shift = (((spin / K) % spacing) + spacing) % spacing;
  for (let x = spacing / 2 - shift; x < width; x += spacing) {
    if (x < 0) continue;
    const spread = Math.abs(Math.cos(K * x + spin));
    // Near a crossing a pair is short and hidden behind the front strand; let it fade out there.
    const half = (swing * (1 - closedAt(x)) * spread - strandWidth * 0.6) * smoothstep(0.3, 0.6, spread);
    if (half < 1) continue;
    ctx.beginPath();
    ctx.moveTo(x, mid - half);
    ctx.lineTo(x, mid + half);
    ctx.stroke();
  }
  // Front halves cut a gap into what lies behind them, then go on top. The gap runs along their
  // sides only, so a strand that passes from behind to the front stays in one piece.
  ctx.lineWidth = 2 * gap;
  ctx.lineJoin = 'round';
  for (const r of fronts) {
    ctx.globalCompositeOperation = 'destination-out';
    for (const side of sides(r)) {
      ctx.beginPath();
      side.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    ribbon(ctx, r);
    ctx.fill();
  }
  // Where the strands have closed up they are one solid line (gaps cut there are filled again).
  ctx.fillRect(0, mid - line / 2, Math.max(0, front - FRONT / 2), line);
  // Ahead the helix stays faint; laid back into the line at the end, it is solid again.
  ctx.globalCompositeOperation = 'destination-in';
  const fade = ctx.createLinearGradient(front - FRONT / 2, 0, front + FRONT / 2, 0);
  fade.addColorStop(0, `rgba(0,0,0,${DONE})`);
  fade.addColorStop(1, `rgba(0,0,0,${AHEAD + (DONE - AHEAD) * (1 - presence)})`);
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}
