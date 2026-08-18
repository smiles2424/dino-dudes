/**
 * The single place `js-aruco2` is loaded, plus the marker bit patterns.
 *
 * Both the template GENERATOR and the photo DETECTOR read the dictionary from
 * here, so the markers we print can never drift from the markers we read.
 *
 * `4x4_50` is OpenCV's `DICT_4X4_50`, which is the first 50 codes of the
 * `ARUCO_4X4_1000` table js-aruco2 ships. Each code is a 16-character bit
 * string in row-major order where `'1'` means a WHITE cell.
 *
 * ── Isomorphism ────────────────────────────────────────────────────────────
 * Wave 1 reached js-aruco2 through `createRequire('node:module')`, which made
 * this module — and therefore the package entry point — Node-only. Wave 2A
 * needs the detector in the browser too, so it is a plain static ESM import of
 * the CommonJS files. Node resolves them through its CJS interop (verified);
 * Vite/esbuild converts them at bundle time. Both dictionary and detector go
 * through the same CJS module instance, which is what makes the
 * self-registering dictionary side-effect import work.
 */
import arucoModule from 'js-aruco2/src/aruco.js';
// Side-effect import: registers `ARUCO_4X4_1000` on the AR namespace above.
import 'js-aruco2/src/dictionaries/aruco_4x4_1000.js';
import { MARKERS } from '@dino/shared';
import type { ArucoDetector, ArucoDictionary, ArucoNamespace } from 'js-aruco2/src/aruco.js';

const AR: ArucoNamespace = arucoModule.AR;

let cachedDictionary: ArucoDictionary | undefined;

function dictionary(): ArucoDictionary {
  cachedDictionary ??= new AR.Dictionary(MARKERS.jsAruco2Dictionary);
  return cachedDictionary;
}

/**
 * A detector configured for the frozen spec. `maxHammingDistance: 0` means we
 * only accept exact code matches — with a 4×4 dictionary and only four ids in
 * play, tolerating bit errors buys nothing and invites false positives from
 * dark rectangles elsewhere in a photo.
 */
export function createDetector(maxHammingDistance = 0): ArucoDetector {
  return new AR.Detector({
    dictionaryName: MARKERS.jsAruco2Dictionary,
    maxHammingDistance,
  });
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
