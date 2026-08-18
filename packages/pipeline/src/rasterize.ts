/**
 * Dependency-free rasterizer for the template's marker geometry.
 *
 * The template is axis-aligned filled rectangles, so a canvas is overkill and
 * would drag a native dependency into CI. This produces an RGBA buffer that is
 * shaped exactly like `ImageData`, which is what js-aruco2's detector consumes
 * — letting the Wave 1 module test prove that the markers we *print* are the
 * markers the detector *reads*.
 *
 * Wave 2A can reuse this as the base layer of the synthetic fixture generator.
 */
import { computeLayout } from './template.js';
import { markerGrid } from './aruco.js';

export interface RasterImage {
  width: number;
  height: number;
  /** RGBA, row-major — same layout as `ImageData.data`. */
  data: Uint8ClampedArray;
}

function fillRect(
  img: RasterImage,
  xMm: number,
  yMm: number,
  wMm: number,
  hMm: number,
  pxPerMm: number,
  value: number,
): void {
  const x0 = Math.max(0, Math.round(xMm * pxPerMm));
  const y0 = Math.max(0, Math.round(yMm * pxPerMm));
  const x1 = Math.min(img.width, Math.round((xMm + wMm) * pxPerMm));
  const y1 = Math.min(img.height, Math.round((yMm + hMm) * pxPerMm));
  for (let y = y0; y < y1; y++) {
    let i = (y * img.width + x0) * 4;
    for (let x = x0; x < x1; x++) {
      img.data[i] = value;
      img.data[i + 1] = value;
      img.data[i + 2] = value;
      img.data[i + 3] = 255;
      i += 4;
    }
  }
}

/**
 * Renders the template's page + markers (and optionally the drawable-quad
 * guide box) to a greyscale-in-RGBA raster at `pixelsPerMm`.
 */
export function rasterizeTemplate(pixelsPerMm = 6): RasterImage {
  const l = computeLayout();
  const width = Math.round(l.page.width * pixelsPerMm);
  const height = Math.round(l.page.height * pixelsPerMm);
  const img: RasterImage = {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4).fill(255),
  };

  for (const m of l.markers) {
    fillRect(img, m.x, m.y, m.size, m.size, pixelsPerMm, 0);
    const grid = markerGrid(m.id);
    for (let gy = 0; gy < grid.length; gy++) {
      const row = grid[gy];
      if (!row) continue;
      for (let gx = 0; gx < row.length; gx++) {
        if (!row[gx]) continue;
        fillRect(
          img,
          m.x + gx * l.cellSize,
          m.y + gy * l.cellSize,
          l.cellSize,
          l.cellSize,
          pixelsPerMm,
          255,
        );
      }
    }
  }

  return img;
}
