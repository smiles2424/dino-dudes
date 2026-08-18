/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  DINO MODEL SPEC — ADDITIVE (Wave 2B, WS-C)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The *other half* of the Texture Spec. `texture-spec.ts` says what the
 * canonical 1024² texture is; this file says **where on the animal each part
 * of that texture ends up**, so that:
 *
 *   • WS-C (`apps/web`) can build the low-poly geometry and its UVs, and
 *   • WS-A (`packages/pipeline`) can print a matching outline guide on the
 *     template ("draw the head here, the tail there") from the same numbers.
 *
 * Nothing here changes an existing contract — it only adds.
 *
 * ── Model space ────────────────────────────────────────────────────────────
 *
 *   +X = forward (the snout), −X = backward (the tail tip)
 *   +Y = up (Y = 0 is the ground the feet stand on)
 *   ±Z = the two flanks (the sides that carry the drawing)
 *   Units are metres. A dino is ~3–5 m long.
 *
 * Every dino is a handful of axis-aligned boxes, optionally tapered along X
 * and/or rotated about Z (rotation in the XY plane — necks, plates, spikes).
 * Boxes flagged `mirrorZ` exist twice, once at +Z and once at −Z (legs, arms).
 *
 * ── The unwrap: mirrored planar side projection ────────────────────────────
 *
 * UVs are a pure **planar projection along Z**: a vertex's (u, v) depends only
 * on its (x, y). Consequences:
 *
 *   • Both flanks get the *same* UVs, so the drawing appears on the left and
 *     the right side of the animal, correctly anchored — the bit of the
 *     drawing you put over the head lands on the head on BOTH sides. Seen from
 *     the −Z side the image is left-right mirrored, which is what "mirror the
 *     side projection to both flanks" means and is exactly how a drawing on a
 *     real animal behaves.
 *   • Top/bottom/front/back faces get the smeared edge colours of the
 *     projection. That is normal and intended for a v1 low-poly look.
 *
 * The model's side-view bounding box is stretched to **exactly fill
 * `TEXTURE_SAFE_AREA`** (the 64 px-inset 896×896 region) — never the full
 * 1024², because only the safe area is inside the printed "draw in here" box.
 *
 * In the PNG (image pixel coordinates, y down, (0,0) = top-left):
 *
 *      x = 64  ────────────────────────────────  x = 960
 *   y = 64  ┌───────────────────────────────────────┐  ← top of the animal
 *           │  tail tip                     snout   │    (back / crest / head)
 *           │      ← the animal's side view →       │
 *   y = 960 └───────────────────────────────────────┘  ← the feet
 *
 * i.e. **left edge of your drawing = tail tip, right edge = snout, top edge =
 * spine/head-top, bottom edge = soles of the feet.** Because the drawable quad
 * is square and a dinosaur is not, the side view is stretched to fill it: a
 * circle drawn on paper reads as a horizontally-stretched blob on a long dino.
 * `dinoTextureOutline()` gives the exact silhouette so the template can print
 * the pre-stretched outline and the artist never has to guess.
 */
import { TEXTURE, TEXTURE_SAFE_AREA } from './texture-spec.js';
import { MODEL_SLUGS, type ModelSlug } from './texture-spec.js';

/** One box of a dino. All numbers are metres/radians in model space. */
export interface DinoPart {
  /** Debug/authoring label, e.g. `'tail'`. Not used at runtime. */
  readonly name: string;
  /** Box centre `[x, y, z]` before mirroring. */
  readonly center: readonly [number, number, number];
  /** Full extents `[width (X), height (Y), depth (Z)]`. */
  readonly size: readonly [number, number, number];
  /**
   * Scale applied to the box's Y and Z extents at its `−X` end and its `+X`
   * end respectively. `[1, 1]` (the default) is an untapered box; `[0.2, 1]`
   * is a tail that thins towards the back.
   */
  readonly taper?: readonly [number, number];
  /** Rotation about Z (radians), applied about the box centre before translation. */
  readonly rotZ?: number;
  /** When true the part is duplicated with its Z centre negated (limbs). */
  readonly mirrorZ?: boolean;
}

const NO_TAPER: readonly [number, number] = [1, 1];

/**
 * The four dinos, as box lists. Deliberately chunky and few-poly: ~10–16
 * boxes each, which is ~120–200 triangles once merged.
 */
export const DINO_PARTS: Readonly<Record<ModelSlug, readonly DinoPart[]>> = {
  trex: [
    { name: 'tail', center: [-1.5, 1.35, 0], size: [1.8, 0.5, 0.5], taper: [0.2, 1] },
    { name: 'body', center: [-0.2, 1.35, 0], size: [1.6, 1.05, 0.9], taper: [1, 0.85] },
    { name: 'neck', center: [0.75, 1.8, 0], size: [0.75, 0.6, 0.55], rotZ: -0.35, taper: [1, 0.85] },
    { name: 'head', center: [1.4, 2.05, 0], size: [0.9, 0.5, 0.45], taper: [1, 0.7] },
    { name: 'jaw', center: [1.35, 1.72, 0], size: [0.8, 0.22, 0.38], taper: [1, 0.7] },
    { name: 'browRidge', center: [1.15, 2.34, 0], size: [0.3, 0.14, 0.42] },
    { name: 'thigh', center: [-0.3, 0.95, 0.33], size: [0.6, 0.9, 0.36], mirrorZ: true },
    { name: 'shin', center: [-0.02, 0.45, 0.33], size: [0.3, 0.9, 0.28], mirrorZ: true },
    { name: 'foot', center: [0.2, 0.09, 0.33], size: [0.66, 0.18, 0.3], mirrorZ: true },
    { name: 'arm', center: [0.72, 1.45, 0.3], size: [0.42, 0.16, 0.14], rotZ: -0.5, mirrorZ: true },
  ],
  stego: [
    { name: 'tail', center: [-1.45, 1.0, 0], size: [1.6, 0.4, 0.4], taper: [0.22, 1] },
    { name: 'body', center: [-0.2, 1.05, 0], size: [2.0, 1.1, 1.05], taper: [0.85, 0.7] },
    { name: 'neck', center: [1.0, 0.95, 0], size: [0.55, 0.45, 0.45], taper: [1, 0.72] },
    { name: 'head', center: [1.45, 0.85, 0], size: [0.5, 0.3, 0.3], taper: [1, 0.85] },
    { name: 'plateA', center: [-0.85, 1.75, 0], size: [0.42, 0.5, 0.1], rotZ: 0.25 },
    { name: 'plateB', center: [-0.42, 1.85, 0], size: [0.5, 0.62, 0.1], rotZ: 0.1 },
    { name: 'plateC', center: [0.08, 1.86, 0], size: [0.5, 0.64, 0.1], rotZ: -0.05 },
    { name: 'plateD', center: [0.55, 1.72, 0], size: [0.42, 0.48, 0.1], rotZ: -0.2 },
    { name: 'spikeA', center: [-2.0, 1.25, 0.1], size: [0.45, 0.12, 0.12], rotZ: 0.5, mirrorZ: true },
    { name: 'spikeB', center: [-1.75, 1.28, 0.1], size: [0.45, 0.12, 0.12], rotZ: 0.75, mirrorZ: true },
    { name: 'frontLeg', center: [0.6, 0.36, 0.34], size: [0.34, 0.72, 0.32], mirrorZ: true },
    { name: 'frontFoot', center: [0.62, 0.07, 0.34], size: [0.44, 0.14, 0.36], mirrorZ: true },
    { name: 'hindLeg', center: [-0.7, 0.43, 0.38], size: [0.44, 0.86, 0.36], mirrorZ: true },
    { name: 'hindFoot', center: [-0.7, 0.08, 0.38], size: [0.54, 0.16, 0.4], mirrorZ: true },
  ],
  raptor: [
    { name: 'tail', center: [-1.25, 1.05, 0], size: [1.7, 0.3, 0.3], taper: [0.18, 1] },
    { name: 'body', center: [-0.12, 1.02, 0], size: [1.25, 0.7, 0.6], taper: [1, 0.85] },
    { name: 'neck', center: [0.66, 1.22, 0], size: [0.55, 0.34, 0.32], rotZ: -0.45 },
    { name: 'head', center: [1.1, 1.45, 0], size: [0.66, 0.3, 0.28], taper: [1, 0.6] },
    { name: 'jaw', center: [1.07, 1.26, 0], size: [0.6, 0.14, 0.24], taper: [1, 0.6] },
    { name: 'thigh', center: [-0.18, 0.72, 0.23], size: [0.46, 0.66, 0.26], mirrorZ: true },
    { name: 'shin', center: [0.05, 0.33, 0.23], size: [0.24, 0.66, 0.18], mirrorZ: true },
    { name: 'foot', center: [0.24, 0.07, 0.23], size: [0.54, 0.14, 0.2], mirrorZ: true },
    { name: 'arm', center: [0.5, 1.0, 0.24], size: [0.42, 0.12, 0.11], rotZ: -0.7, mirrorZ: true },
    { name: 'claw', center: [0.3, 0.16, 0.23], size: [0.2, 0.08, 0.1], mirrorZ: true },
  ],
  bronto: [
    { name: 'tail', center: [-2.05, 1.55, 0], size: [2.3, 0.5, 0.5], taper: [0.12, 1] },
    { name: 'body', center: [-0.35, 1.55, 0], size: [2.1, 1.35, 1.3], taper: [0.9, 0.85] },
    { name: 'shoulder', center: [0.75, 1.7, 0], size: [0.8, 1.0, 1.0], taper: [1, 0.7] },
    { name: 'neck', center: [1.35, 2.35, 0], size: [1.5, 0.55, 0.55], rotZ: 0.7, taper: [1, 0.62] },
    { name: 'head', center: [1.85, 3.05, 0], size: [0.55, 0.32, 0.32], taper: [1, 0.85] },
    { name: 'frontLeg', center: [0.72, 0.725, 0.44], size: [0.46, 1.45, 0.44], mirrorZ: true },
    { name: 'frontFoot', center: [0.74, 0.1, 0.44], size: [0.6, 0.2, 0.5], mirrorZ: true },
    { name: 'hindLeg', center: [-0.85, 0.8, 0.48], size: [0.55, 1.6, 0.5], mirrorZ: true },
    { name: 'hindFoot', center: [-0.85, 0.11, 0.48], size: [0.7, 0.22, 0.56], mirrorZ: true },
  ],
} as const;

/** The side-view (XY) bounding box a dino's UVs are normalised against. */
export interface DinoSideBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/**
 * The four XY corners a part occupies in side view, after taper + rotation +
 * translation. Order: (−X,−Y), (+X,−Y), (+X,+Y), (−X,+Y) in the part's own
 * frame — i.e. a quad, not necessarily axis-aligned once `rotZ` is used.
 */
export function partSideQuad(part: DinoPart): readonly (readonly [number, number])[] {
  const [w, h] = part.size;
  const [sMin, sMax] = part.taper ?? NO_TAPER;
  const [cx, cy] = part.center;
  const rot = part.rotZ ?? 0;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);

  const local: readonly (readonly [number, number])[] = [
    [-w / 2, (-h / 2) * sMin],
    [w / 2, (-h / 2) * sMax],
    [w / 2, (h / 2) * sMax],
    [-w / 2, (h / 2) * sMin],
  ];

  return local.map(([x, y]) => [cx + x * cos - y * sin, cy + x * sin + y * cos] as const);
}

const boundsCache = new Map<ModelSlug, DinoSideBounds>();

/**
 * Exact side-view bounds of a dino, computed from {@link DINO_PARTS}. WS-C
 * builds UVs against this; WS-A normalises the printed outline against it.
 */
export function dinoSideBounds(slug: ModelSlug): DinoSideBounds {
  const cached = boundsCache.get(slug);
  if (cached) return cached;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const part of DINO_PARTS[slug]) {
    for (const [x, y] of partSideQuad(part)) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  const bounds: DinoSideBounds = { minX, maxX, minY, maxY };
  boundsCache.set(slug, bounds);
  return bounds;
}

/**
 * The UV rectangle the whole animal is squeezed into — i.e.
 * {@link TEXTURE_SAFE_AREA} expressed in 0..1 UV space.
 *
 * `v` is GL-style (0 at the BOTTOM of the image) because three.js uploads
 * textures with `flipY = true`: `v = v1` is the safe area's TOP scanline
 * (image row 64) and `v = v0` its BOTTOM one (image row 960).
 */
export const DINO_UV_RECT = {
  u0: TEXTURE_SAFE_AREA.x / TEXTURE.width,
  u1: (TEXTURE_SAFE_AREA.x + TEXTURE_SAFE_AREA.width) / TEXTURE.width,
  v0: TEXTURE_SAFE_AREA.y / TEXTURE.height,
  v1: (TEXTURE_SAFE_AREA.y + TEXTURE_SAFE_AREA.height) / TEXTURE.height,
} as const;

/**
 * The unwrap itself: model-space (x, y) → texture (u, v), clamped into the
 * safe area. Pure planar projection along Z, so both flanks share it.
 */
export function sideProjectionUv(x: number, y: number, bounds: DinoSideBounds): [number, number] {
  const spanX = bounds.maxX - bounds.minX || 1;
  const spanY = bounds.maxY - bounds.minY || 1;
  const fx = clamp01((x - bounds.minX) / spanX);
  const fy = clamp01((y - bounds.minY) / spanY);
  return [
    DINO_UV_RECT.u0 + fx * (DINO_UV_RECT.u1 - DINO_UV_RECT.u0),
    DINO_UV_RECT.v0 + fy * (DINO_UV_RECT.v1 - DINO_UV_RECT.v0),
  ];
}

/**
 * The dino's silhouette in **texture image pixels** (origin top-left, y down —
 * the coordinate system of the PNG and of the template SVG), one polygon per
 * box. Feed this to the template generator to print the "your drawing lands
 * here" outline inside the safe area.
 */
export function dinoTextureOutline(slug: ModelSlug): readonly (readonly [number, number][])[] {
  const bounds = dinoSideBounds(slug);
  return DINO_PARTS[slug].map((part) =>
    partSideQuad(part).map(([x, y]) => {
      const [u, v] = sideProjectionUv(x, y, bounds);
      // u → column directly; v is bottom-up, image rows are top-down.
      return [u * TEXTURE.width, (1 - v) * TEXTURE.height] as [number, number];
    }),
  );
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Bundled, for `console.log`-style introspection and for tests. */
export const DINO_MODEL_SPEC = {
  version: 1,
  slugs: MODEL_SLUGS,
  parts: DINO_PARTS,
  uvRect: DINO_UV_RECT,
  projection: 'planar-side-mirrored',
} as const;
