/**
 * Drawing of the progress helix (CSS pixels): a double strand that is a flat ladder at the start
 * and winds up into a helix as the run progresses.
 *
 * The twist per pixel is K where the work is done and 0 ahead of it, with a soft front of FRONT
 * pixels. Strand angles add up the twist from the right: the ladder ahead stays still, and every
 * step of progress turns the wound part a little further, so the strand visibly winds on.
 * A strand at angle α lies at y = mid − amp·cos α and faces the viewer where sin α > 0.
 */

/** One turn of the helix. */
const PERIOD = 62;
const K = (2 * Math.PI) / PERIOD;
/** Width of the soft front between helix and ladder. */
const FRONT = 70;
/** Base pairs per turn; the ladder keeps them at the same spacing. */
const PAIRS = 8;
/** Opacity of the part not done yet. */
const AHEAD = 0.22;

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

/** Draws the helix at `progress` (0–1) into a cleared context of `width` × `height` CSS pixels. */
export function drawDna(ctx: CanvasRenderingContext2D, width: number, height: number, progress: number, ink: string) {
  const mid = height / 2;
  const amp = height * 0.32;
  const strandWidth = Math.max(2, height * 0.13);
  const gap = Math.max(1.5, height * 0.07);
  // The front moves from just before the left edge to just past the right one.
  const front = -FRONT / 2 + progress * (width + FRONT);
  const step = 1;
  const n = Math.ceil(width / step) + 1;
  const xs = new Float64Array(n);
  const angle = new Float64Array(n);
  const wound = new Float64Array(n);
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) {
    const x = Math.min(width, i * step);
    xs[i] = x;
    wound[i] = 1 - smoothstep(front - FRONT / 2, front + FRONT / 2, x);
    angle[i] = acc;
    acc += K * wound[i] * step;
  }

  const front_: Pt[][] = [];
  const back: Pt[][] = [];
  for (const offset of [0, Math.PI]) {
    let run: Pt[] = [];
    let runFront: boolean | undefined;
    for (let i = 0; i < n; i++) {
      const a = angle[i] + offset;
      const facing = Math.sin(a);
      // The flat ladder has no front and back; only a strand that is wound can pass behind.
      const isFront = facing >= 0 || wound[i] < 0.3;
      // Edge-on, a wound strand narrows; the flat ladder keeps its full width.
      const helixWidth = 0.3 + 0.7 * Math.abs(facing) ** 0.7;
      const w = strandWidth * (1 - wound[i] + wound[i] * helixWidth);
      const p = { x: xs[i], y: mid - amp * Math.cos(a), w };
      if (isFront !== runFront && run.length) {
        run.push(p);
        (runFront ? front_ : back).push(run);
        run = [];
      }
      runFront = isFront;
      run.push(p);
    }
    if (run.length > 1) (runFront ? front_ : back).push(run);
  }

  ctx.save();
  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;
  // Behind: back halves of the strands and the base pairs.
  for (const r of back) {
    ribbon(ctx, r);
    ctx.fill();
  }
  ctx.lineWidth = Math.max(1, strandWidth * 0.45);
  ctx.lineCap = 'round';
  const spacing = PERIOD / PAIRS;
  for (let x = spacing / 2; x < width; x += spacing) {
    const i = Math.round(x / step);
    const spread = Math.abs(Math.cos(angle[i]));
    // Near a crossing a pair is short and hidden behind the front strand; let it fade out there.
    const half = (amp * spread - strandWidth * 0.6) * smoothstep(0.3, 0.6, spread);
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
  ctx.lineCap = 'butt';
  for (const r of front_) {
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
  // The part not done yet stays faint.
  ctx.globalCompositeOperation = 'destination-in';
  const fade = ctx.createLinearGradient(front - FRONT / 2, 0, front + FRONT / 2, 0);
  fade.addColorStop(0, 'rgba(0,0,0,1)');
  fade.addColorStop(1, `rgba(0,0,0,${AHEAD})`);
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}
