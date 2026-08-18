/**
 * Template generator v1 — emits the printable A4 sheet that people draw on.
 *
 * The geometry is derived entirely from the frozen Texture Spec in
 * `@dino/shared`, so a printed sheet and the pipeline's deskew step can never
 * disagree about where the drawable quad is.
 */
import { MARKERS, TEMPLATE_MM, TEMPLATE_QUAD_MM, TEXTURE, TEXTURE_SPEC } from '@dino/shared';
import { markerGrid } from './aruco.js';
import { buildPdf, type PdfOp } from './pdf.js';

export interface TemplateOptions {
  /** Dino this sheet is for; printed in the header. */
  modelSlug?: string;
  /** Overrides the default header. */
  title?: string;
}

export interface MarkerPlacement {
  id: number;
  corner: 'topLeft' | 'topRight' | 'bottomRight' | 'bottomLeft';
  /** Top-left of the marker's outer square, in page mm. */
  x: number;
  y: number;
  /** Outer side length in mm (includes the black border). */
  size: number;
}

export interface TemplateLayout {
  page: { width: number; height: number };
  /** Drawable quad: its corners are the markers' inner corners. */
  quad: { x: number; y: number; size: number };
  /** The printed "draw inside here" box, inset from the quad. */
  guide: { x: number; y: number; size: number };
  markers: MarkerPlacement[];
  /** One ArUco cell, in mm. */
  cellSize: number;
}

/** Resolves the frozen spec into concrete page coordinates. */
export function computeLayout(): TemplateLayout {
  const { markerSize, safeAreaInset, page } = TEMPLATE_MM;
  const quad = { x: TEMPLATE_QUAD_MM.x, y: TEMPLATE_QUAD_MM.y, size: TEMPLATE_QUAD_MM.size };
  const right = quad.x + quad.size;
  const bottom = quad.y + quad.size;

  // Each marker sits diagonally outside its quad corner, so the marker's inner
  // corner *is* the quad corner — the rule the detector relies on.
  const markers: MarkerPlacement[] = [
    { id: MARKERS.ids.topLeft, corner: 'topLeft', x: quad.x - markerSize, y: quad.y - markerSize, size: markerSize },
    { id: MARKERS.ids.topRight, corner: 'topRight', x: right, y: quad.y - markerSize, size: markerSize },
    { id: MARKERS.ids.bottomRight, corner: 'bottomRight', x: right, y: bottom, size: markerSize },
    { id: MARKERS.ids.bottomLeft, corner: 'bottomLeft', x: quad.x - markerSize, y: bottom, size: markerSize },
  ];

  return {
    page: { width: page.width, height: page.height },
    quad,
    guide: {
      x: quad.x + safeAreaInset,
      y: quad.y + safeAreaInset,
      size: quad.size - safeAreaInset * 2,
    },
    markers,
    cellSize: markerSize / MARKERS.cellsWithBorder,
  };
}

const INSTRUCTIONS = [
  '1. Draw inside the dashed box. Keep the four corner squares clean and unmarked.',
  '2. Photograph the whole sheet flat, in even light, with all four corner squares visible.',
  '3. Upload it in the app - your drawing wraps onto your dinosaur in the shared world.',
];

function headerTitle(options: TemplateOptions): string {
  if (options.title) return options.title;
  return options.modelSlug ? `DINO DUDES - ${options.modelSlug.toUpperCase()}` : 'DINO DUDES';
}

function footerText(options: TemplateOptions): string {
  const slug = options.modelSlug ?? 'generic';
  return `spec v${TEXTURE_SPEC.version} | ArUco ${MARKERS.dictionary} ids 0-3 | quad ${TEMPLATE_MM.drawableQuad}mm -> ${TEXTURE.width}px | model: ${slug}`;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

// ── SVG ────────────────────────────────────────────────────────────────────

/** Renders the printable template as an SVG string (1 user unit == 1 mm). */
export function renderTemplateSvg(options: TemplateOptions = {}): string {
  const l = computeLayout();
  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${l.page.width}mm" height="${l.page.height}mm" ` +
      `viewBox="0 0 ${l.page.width} ${l.page.height}">`,
  );
  parts.push(`<title>${escapeXml(headerTitle(options))}</title>`);
  parts.push(`<rect x="0" y="0" width="${l.page.width}" height="${l.page.height}" fill="#ffffff"/>`);

  // Header + instructions.
  parts.push(
    `<text x="${l.page.width / 2}" y="20" font-family="Helvetica, Arial, sans-serif" font-size="8" ` +
      `font-weight="bold" text-anchor="middle" fill="#111111">${escapeXml(headerTitle(options))}</text>`,
  );
  INSTRUCTIONS.forEach((line, i) => {
    parts.push(
      `<text x="${TEMPLATE_MM.contentOrigin.x}" y="${28 + i * 5}" font-family="Helvetica, Arial, sans-serif" ` +
        `font-size="3.2" fill="#333333">${escapeXml(line)}</text>`,
    );
  });

  // Markers.
  for (const m of l.markers) {
    parts.push(renderMarkerSvg(m, l.cellSize));
  }

  // Guide box + label.
  parts.push(
    `<rect x="${round(l.guide.x)}" y="${round(l.guide.y)}" width="${round(l.guide.size)}" ` +
      `height="${round(l.guide.size)}" fill="none" stroke="#b0b0b0" stroke-width="0.4" ` +
      `stroke-dasharray="3 2"/>`,
  );
  parts.push(
    `<text x="${l.page.width / 2}" y="${round(l.guide.y - 2.5)}" font-family="Helvetica, Arial, sans-serif" ` +
      `font-size="3" text-anchor="middle" fill="#b0b0b0">DRAW INSIDE THIS BOX</text>`,
  );

  // Footer.
  parts.push(
    `<text x="${l.page.width / 2}" y="${l.page.height - 12}" font-family="Helvetica, Arial, sans-serif" ` +
      `font-size="2.8" text-anchor="middle" fill="#999999">${escapeXml(footerText(options))}</text>`,
  );

  parts.push('</svg>');
  return parts.join('\n');
}

function renderMarkerSvg(m: MarkerPlacement, cell: number): string {
  const grid = markerGrid(m.id);
  const out: string[] = [
    `<g id="aruco-${m.id}-${m.corner}">`,
    // Quiet zone: an explicit white square so the marker survives being placed
    // on any future non-white background.
    `<rect x="${round(m.x - TEMPLATE_MM.markerQuietZone)}" y="${round(m.y - TEMPLATE_MM.markerQuietZone)}" ` +
      `width="${round(m.size + TEMPLATE_MM.markerQuietZone * 2)}" ` +
      `height="${round(m.size + TEMPLATE_MM.markerQuietZone * 2)}" fill="#ffffff"/>`,
    `<rect x="${round(m.x)}" y="${round(m.y)}" width="${round(m.size)}" height="${round(m.size)}" fill="#000000"/>`,
  ];
  for (let gy = 0; gy < grid.length; gy++) {
    const row = grid[gy];
    if (!row) continue;
    for (let gx = 0; gx < row.length; gx++) {
      if (!row[gx]) continue;
      out.push(
        `<rect x="${round(m.x + gx * cell)}" y="${round(m.y + gy * cell)}" ` +
          `width="${round(cell)}" height="${round(cell)}" fill="#ffffff"/>`,
      );
    }
  }
  out.push('</g>');
  return out.join('');
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── PDF ────────────────────────────────────────────────────────────────────

/** Renders the same template as a print-ready single-page A4 PDF. */
export function renderTemplatePdf(options: TemplateOptions = {}): Uint8Array {
  const l = computeLayout();
  const ops: PdfOp[] = [];

  ops.push({ kind: 'rect', x: 0, y: 0, w: l.page.width, h: l.page.height, gray: 1 });

  ops.push({ kind: 'text', x: l.page.width / 2, y: 20, size: 8, text: headerTitle(options), align: 'center', gray: 0.07, bold: true });
  INSTRUCTIONS.forEach((line, i) => {
    ops.push({ kind: 'text', x: TEMPLATE_MM.contentOrigin.x, y: 28 + i * 5, size: 3.2, text: line, align: 'left', gray: 0.2 });
  });

  for (const m of l.markers) {
    const grid = markerGrid(m.id);
    ops.push({
      kind: 'rect',
      x: m.x - TEMPLATE_MM.markerQuietZone,
      y: m.y - TEMPLATE_MM.markerQuietZone,
      w: m.size + TEMPLATE_MM.markerQuietZone * 2,
      h: m.size + TEMPLATE_MM.markerQuietZone * 2,
      gray: 1,
    });
    ops.push({ kind: 'rect', x: m.x, y: m.y, w: m.size, h: m.size, gray: 0 });
    for (let gy = 0; gy < grid.length; gy++) {
      const row = grid[gy];
      if (!row) continue;
      for (let gx = 0; gx < row.length; gx++) {
        if (!row[gx]) continue;
        ops.push({
          kind: 'rect',
          x: m.x + gx * l.cellSize,
          y: m.y + gy * l.cellSize,
          w: l.cellSize,
          h: l.cellSize,
          gray: 1,
        });
      }
    }
  }

  ops.push({
    kind: 'dashedRect',
    x: l.guide.x,
    y: l.guide.y,
    w: l.guide.size,
    h: l.guide.size,
    gray: 0.69,
    lineWidth: 0.4,
    dash: [3, 2],
  });
  ops.push({ kind: 'text', x: l.page.width / 2, y: l.guide.y - 2.5, size: 3, text: 'DRAW INSIDE THIS BOX', align: 'center', gray: 0.69 });
  ops.push({ kind: 'text', x: l.page.width / 2, y: l.page.height - 12, size: 2.8, text: footerText(options), align: 'center', gray: 0.6 });

  return buildPdf({ widthMm: l.page.width, heightMm: l.page.height, ops, title: headerTitle(options) });
}
