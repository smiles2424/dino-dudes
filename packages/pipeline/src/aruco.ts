/**
 * ArUco marker bit patterns, sourced from **the same dictionary data the
 * detector will use** (`js-aruco2`), so the generator and Wave 2A's detector
 * can never drift apart.
 *
 * `4x4_50` is OpenCV's `DICT_4X4_50`, which is the first 50 codes of the
 * `ARUCO_4X4_1000` table js-aruco2 ships. Each code is a 16-character bit
 * string in row-major order where `'1'` means a WHITE cell.
 */
import { createRequire } from 'node:module';
import { MARKERS } from '@dino/shared';

const require = createRequire(import.meta.url);

interface ArucoDictionary {
  nBits: number;
  markSize: number;
  codeList: string[];
}

interface ArucoNamespace {
  DICTIONARIES: Record<string, unknown>;
  Dictionary: new (name: string) => ArucoDictionary;
}

let cached: ArucoDictionary | undefined;

function dictionary(): ArucoDictionary {
  if (cached) return cached;
  // js-aruco2 is CommonJS and its dictionary files self-register on `AR`.
  const { AR } = require('js-aruco2/src/aruco.js') as { AR: ArucoNamespace };
  require('js-aruco2/src/dictionaries/aruco_4x4_1000.js');
  cached = new AR.Dictionary(MARKERS.jsAruco2Dictionary);
  return cached;
}

/** Number of distinct marker IDs usable as `4x4_50`. */
export const DICT_4X4_50_SIZE = 50;

/**
 * The 4×4 data cells of `marker id`, as rows of booleans where `true` == white.
 * Excludes the mandatory black border.
 */
export function markerBits(id: number): boolean[][] {
  if (!Number.isInteger(id) || id < 0 || id >= DICT_4X4_50_SIZE) {
    throw new RangeError(`marker id ${id} out of range for 4x4_50 (0..${DICT_4X4_50_SIZE - 1})`);
  }
  const code = dictionary().codeList[id];
  const n = MARKERS.gridSize;
  if (code === undefined || code.length !== n * n) {
    throw new Error(`dictionary code ${id} is malformed`);
  }
  const rows: boolean[][] = [];
  for (let y = 0; y < n; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < n; x++) row.push(code[y * n + x] === '1');
    rows.push(row);
  }
  return rows;
}

/**
 * The full marker as a `cellsWithBorder`×`cellsWithBorder` grid, black border
 * included. `true` == white. This is exactly what gets printed.
 */
export function markerGrid(id: number): boolean[][] {
  const bits = markerBits(id);
  const size = MARKERS.cellsWithBorder;
  const grid: boolean[][] = [];
  for (let y = 0; y < size; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x++) {
      const inner = x > 0 && x < size - 1 && y > 0 && y < size - 1;
      row.push(inner ? (bits[y - 1]?.[x - 1] ?? false) : false);
    }
    grid.push(row);
  }
  return grid;
}
