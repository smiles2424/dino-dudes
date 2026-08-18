/**
 * A tiny anti-aliased polyline rasterizer, plus the procedural "kid's drawing"
 * used by the synthetic fixture generator.
 *
 * The drawing is authored ONCE, in normalised [0,1]² coordinates. It is then
 * rendered twice through different mappings:
 *
 *   • into TEXTURE space   — [0,1]² → the safe-area box of the 1024² texture.
 *     This is the ground truth: what the pipeline should recover.
 *   • into SHEET space     — [0,1]² → the printed guide box, in page mm.
 *     This is what gets photographed.
 *
 * Because the safe-area box and the printed guide box are the same physical
 * region by construction (both are `TEMPLATE_MM.safeAreaInset` inside the
 * drawable quad), a correct pipeline maps one onto the other exactly. That is
 * what breaks the circularity in the golden test: the goldens can be checked
 * against a render that never touched the warp code.
 *
 * Isomorphic: no Node builtins.
 */
import type { ImageDataLike, Point } from './image.js';

export interface Stroke {
  /** Polyline vertices in normalised [0,1]² drawing space. */
  points: Point[];
  /** Stroke width as a fraction of the drawing box's side. */
  width: number;
  colour: [number, number, number];
  /** 0–1. Pencil strokes are semi-transparent; marker strokes are solid. */
  opacity: number;
  /** Fill the polygon rather than stroking it (used for the body blob). */
  fill?: boolean;
}

/** Maps normalised drawing coords to target pixels. */
export interface DrawMapping {
  /** Pixel position of drawing-space (0,0). */
  originX: number;
  originY: number;
  /** Pixels per unit of drawing space. Square by construction. */
  scale: number;
}

function blendPixel(
  img: ImageDataLike,
  x: number,
  y: number,
  colour: readonly [number, number, number],
  alpha: number,
): void {
  if (alpha <= 0 || x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const a = alpha > 1 ? 1 : alpha;
  const i = (y * img.width + x) * 4;
  for (let k = 0; k < 3; k++) {
    img.data[i + k] = (img.data[i + k] as number) * (1 - a) + (colour[k] as number) * a;
  }
  img.data[i + 3] = 255;
}

/** Distance from p to segment ab. */
function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Even-odd point-in-polygon. */
function pointInPolygon(px: number, py: number, poly: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as Point;
    const b = poly[j] as Point;
    if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Renders one stroke into `img` through `map`, anti-aliased over one pixel. */
export function drawStroke(img: ImageDataLike, stroke: Stroke, map: DrawMapping): void {
  const pts = stroke.points.map((p) => ({
    x: map.originX + p.x * map.scale,
    y: map.originY + p.y * map.scale,
  }));
  if (pts.length === 0) return;
  const halfWidth = Math.max(0.5, (stroke.width * map.scale) / 2);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const pad = halfWidth + 2;
  const x0 = Math.max(0, Math.floor(minX - pad));
  const y0 = Math.max(0, Math.floor(minY - pad));
  const x1 = Math.min(img.width - 1, Math.ceil(maxX + pad));
  const y1 = Math.min(img.height - 1, Math.ceil(maxY + pad));

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      let d = Infinity;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i] as Point;
        const b = pts[i + 1] as Point;
        d = Math.min(d, distanceToSegment(cx, cy, a.x, a.y, b.x, b.y));
        if (d <= 0) break;
      }
      if (pts.length === 1) {
        const a = pts[0] as Point;
        d = Math.hypot(cx - a.x, cy - a.y);
      }
      // Coverage: 1 inside, ramping to 0 across the last pixel of the edge.
      let coverage = Math.min(1, Math.max(0, halfWidth + 0.5 - d));
      if (stroke.fill && pointInPolygon(cx, cy, pts)) coverage = 1;
      if (coverage > 0) blendPixel(img, x, y, stroke.colour, coverage * stroke.opacity);
    }
  }
}

export function drawStrokes(img: ImageDataLike, strokes: readonly Stroke[], map: DrawMapping): void {
  for (const s of strokes) drawStroke(img, s, map);
}

// ── The procedural drawing ─────────────────────────────────────────────────

/** Deterministic 32-bit PRNG (mulberry32) — same seed, same fixture, forever. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GRAPHITE: [number, number, number] = [58, 58, 66];
const MARKER_COLOURS: [number, number, number][] = [
  [196, 48, 48],
  [36, 96, 190],
  [28, 140, 72],
  [214, 138, 24],
  [120, 52, 160],
];

/** Closed blob around a centre, with per-vertex radius jitter. */
function blob(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  vertices: number,
  jitter: number,
  rng: () => number,
): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < vertices; i++) {
    const t = (i / vertices) * Math.PI * 2;
    const j = 1 + (rng() - 0.5) * jitter;
    pts.push({ x: cx + Math.cos(t) * rx * j, y: cy + Math.sin(t) * ry * j });
  }
  pts.push(pts[0] as Point);
  return pts;
}

/**
 * A hand-drawn-looking dinosaur, deterministic in `seed`. Every fixture gets a
 * different one so the golden suite isn't measuring a single lucky drawing.
 */
export function createDrawing(seed: number): Stroke[] {
  const rng = createRng(seed);
  const strokes: Stroke[] = [];
  const ink = MARKER_COLOURS[Math.floor(rng() * MARKER_COLOURS.length)] as [number, number, number];
  const wobble = (): number => (rng() - 0.5) * 0.02;

  // Body.
  const bodyX = 0.46 + wobble();
  const bodyY = 0.55 + wobble();
  const body = blob(bodyX, bodyY, 0.26, 0.17, 16, 0.16, rng);
  strokes.push({ points: body, width: 0.012, colour: GRAPHITE, opacity: 0.9 });

  // Head + neck.
  const headX = bodyX + 0.3 + wobble();
  const headY = bodyY - 0.24 + wobble();
  strokes.push({
    points: [
      { x: bodyX + 0.18, y: bodyY - 0.1 },
      { x: bodyX + 0.26, y: bodyY - 0.2 },
      { x: headX - 0.05, y: headY + 0.04 },
    ],
    width: 0.014,
    colour: GRAPHITE,
    opacity: 0.9,
  });
  strokes.push({
    points: blob(headX, headY, 0.1, 0.08, 12, 0.12, rng),
    width: 0.012,
    colour: GRAPHITE,
    opacity: 0.9,
  });
  // Eye.
  strokes.push({
    points: blob(headX + 0.03, headY - 0.02, 0.014, 0.014, 8, 0.05, rng),
    width: 0.008,
    colour: GRAPHITE,
    opacity: 1,
    fill: true,
  });

  // Tail.
  strokes.push({
    points: [
      { x: bodyX - 0.2, y: bodyY - 0.02 },
      { x: bodyX - 0.34, y: bodyY - 0.1 + wobble() },
      { x: bodyX - 0.42, y: bodyY - 0.22 + wobble() },
    ],
    width: 0.016,
    colour: GRAPHITE,
    opacity: 0.9,
  });

  // Legs.
  for (let i = 0; i < 4; i++) {
    const lx = bodyX - 0.16 + i * 0.11 + wobble();
    strokes.push({
      points: [
        { x: lx, y: bodyY + 0.13 },
        { x: lx + wobble() * 2, y: bodyY + 0.26 },
        { x: lx + 0.04, y: bodyY + 0.28 },
      ],
      width: 0.013,
      colour: GRAPHITE,
      opacity: 0.88,
    });
  }

  // Back spikes.
  const spikes = 4 + Math.floor(rng() * 3);
  for (let i = 0; i < spikes; i++) {
    const t = i / (spikes - 1);
    const sx = bodyX - 0.18 + t * 0.36;
    const sy = bodyY - 0.17 - Math.sin(t * Math.PI) * 0.02;
    strokes.push({
      points: [
        { x: sx - 0.03, y: sy },
        { x: sx, y: sy - 0.07 - rng() * 0.03 },
        { x: sx + 0.03, y: sy },
      ],
      width: 0.011,
      colour: ink,
      opacity: 0.95,
    });
  }

  // Coloured hatching across the flank — the detail that a bad warp or an
  // over-aggressive levels pass destroys first.
  const hatchCount = 7 + Math.floor(rng() * 4);
  for (let i = 0; i < hatchCount; i++) {
    const t = (i + 0.5) / hatchCount;
    const hx = bodyX - 0.2 + t * 0.4;
    strokes.push({
      points: [
        { x: hx, y: bodyY - 0.1 + rng() * 0.02 },
        { x: hx - 0.03, y: bodyY + 0.1 - rng() * 0.02 },
      ],
      width: 0.008,
      colour: ink,
      opacity: 0.75,
    });
  }

  // Ground line + sun, because every kid draws them.
  strokes.push({
    points: [
      { x: 0.05, y: 0.9 },
      { x: 0.45, y: 0.89 + wobble() },
      { x: 0.95, y: 0.9 + wobble() },
    ],
    width: 0.01,
    colour: GRAPHITE,
    opacity: 0.7,
  });
  const sun = blob(0.12, 0.12, 0.055, 0.055, 12, 0.06, rng);
  strokes.push({ points: sun, width: 0.01, colour: [222, 168, 30], opacity: 0.95 });
  for (let i = 0; i < 8; i++) {
    const t = (i / 8) * Math.PI * 2;
    strokes.push({
      points: [
        { x: 0.12 + Math.cos(t) * 0.07, y: 0.12 + Math.sin(t) * 0.07 },
        { x: 0.12 + Math.cos(t) * 0.1, y: 0.12 + Math.sin(t) * 0.1 },
      ],
      width: 0.008,
      colour: [222, 168, 30],
      opacity: 0.9,
    });
  }

  return strokes;
}
