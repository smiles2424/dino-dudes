/**
 * `@dino/pipeline/node` — the Node-only half of WS-A.
 *
 * PNG codec + filesystem helpers for the fixture/golden rig. Kept off the
 * package root so `apps/web` can bundle the pipeline without a `node:zlib`
 * polyfill.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng, type EncodePngOptions } from './png.js';
import type { ImageDataLike } from './image.js';
import {
  FIXTURE_SPECS,
  GOLDEN_FIXTURES,
  generateFixture,
  renderGoldenTexture,
  type FixtureSpec,
} from './synth.js';

export { decodePng, encodePng, type EncodePngOptions };

/** Repo root, resolved from this file's location inside `dist/`. */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const FIXTURES_DIR = path.join(repoRoot, 'assets', 'fixtures');
export const GOLDENS_DIR = path.join(repoRoot, 'assets', 'goldens');

export async function readPng(file: string): Promise<ImageDataLike> {
  return decodePng(new Uint8Array(await readFile(file)));
}

export async function writePng(
  file: string,
  img: ImageDataLike,
  options?: EncodePngOptions,
): Promise<number> {
  const bytes = encodePng(img, options);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return bytes.length;
}

export const fixturePath = (spec: FixtureSpec): string => path.join(FIXTURES_DIR, `${spec.name}.png`);
export const goldenPath = (spec: FixtureSpec): string => path.join(GOLDENS_DIR, `${spec.name}.png`);

export interface GenerateReport {
  name: string;
  fixtureBytes: number;
  goldenBytes: number | null;
}

/**
 * Regenerates every fixture photo and every golden texture on disk.
 * Deterministic: re-running it produces byte-identical files.
 */
export async function generateFixtureSet(
  onProgress?: (name: string) => void,
): Promise<GenerateReport[]> {
  const reports: GenerateReport[] = [];
  const goldenNames = new Set(GOLDEN_FIXTURES.map((f) => f.name));

  for (const spec of FIXTURE_SPECS) {
    onProgress?.(spec.name);
    const { photo } = generateFixture(spec);
    const fixtureBytes = await writePng(fixturePath(spec), photo, { rgb: true });

    let goldenBytes: number | null = null;
    if (goldenNames.has(spec.name)) {
      goldenBytes = await writePng(goldenPath(spec), renderGoldenTexture(spec.seed), { rgb: true });
    }
    reports.push({ name: spec.name, fixtureBytes, goldenBytes });
  }
  return reports;
}
