#!/usr/bin/env node
/**
 * `pnpm --filter @dino/pipeline generate-fixtures`
 *
 * Regenerates `assets/fixtures/*.png` (synthetic "phone photos") and
 * `assets/goldens/*.png` (the textures the pipeline must reproduce).
 *
 * Deterministic — the output is byte-identical on every run and every machine,
 * so a dirty git tree after running this means the pipeline changed, which is
 * exactly the signal you want before re-approving goldens.
 *
 *   --check          don't write anything; run the committed fixtures through
 *                    the pipeline and report SSIM against the committed
 *                    goldens. This is the report to read at the Wave 2A human
 *                    checkpoint.
 *   --out <dir>      with --check, also dump each fixture's ACTUAL texture so
 *                    it can be eyeballed next to its golden.
 *
 * When the human supplies REAL phone photos, drop them into
 * `assets/fixtures/`, add an entry to `FIXTURE_SPECS` in `src/synth.ts` (the
 * test discovers fixtures from that list), and re-approve the goldens.
 */
import path from 'node:path';
import {
  FIXTURE_SPECS,
  GOLDEN_FIXTURES,
  GOLDEN_SSIM_THRESHOLD,
  PipelineError,
  processPhoto,
  ssim,
} from './index.js';
import {
  fixturePath,
  generateFixtureSet,
  goldenPath,
  readPng,
  repoRoot,
  writePng,
} from './node.js';

const kb = (n: number): string => `${(n / 1024).toFixed(0)} KB`;

async function generate(): Promise<void> {
  console.log(`generating ${FIXTURE_SPECS.length} fixtures + goldens (this takes ~1 min)...`);
  const started = Date.now();
  const reports = await generateFixtureSet();
  for (const r of reports) {
    console.log(
      `  ${r.name.padEnd(22)} photo ${kb(r.fixtureBytes).padStart(8)}` +
        (r.goldenBytes === null ? '   (failure fixture, no golden)' : `   golden ${kb(r.goldenBytes)}`),
    );
  }
  const total = reports.reduce((s, r) => s + r.fixtureBytes + (r.goldenBytes ?? 0), 0);
  console.log(
    `done in ${((Date.now() - started) / 1000).toFixed(1)}s — ${kb(total)} written under ` +
      `${path.relative(process.cwd(), repoRoot) || '.'}/assets`,
  );
}

async function check(outDir: string | undefined): Promise<void> {
  console.log(`checking ${FIXTURE_SPECS.length} committed fixtures (threshold ${GOLDEN_SSIM_THRESHOLD})\n`);
  const goldenNames = new Set(GOLDEN_FIXTURES.map((f) => f.name));
  let failures = 0;

  for (const spec of FIXTURE_SPECS) {
    const photo = await readPng(fixturePath(spec));
    let line = `  ${spec.name.padEnd(22)}`;
    try {
      const result = processPhoto(photo);
      if (goldenNames.has(spec.name)) {
        const score = ssim(result.texture, await readPng(goldenPath(spec)));
        const ok = score >= GOLDEN_SSIM_THRESHOLD;
        if (!ok) failures++;
        line += `${ok ? 'PASS' : 'FAIL'}  ssim ${score.toFixed(4)}  passes ${result.detection.passesUsed.join('+')}`;
        if (result.warnings.length > 0) line += `  warnings ${result.warnings.join(',')}`;
      } else {
        failures++;
        line += 'FAIL  expected this fixture to fail detection, but it succeeded';
      }
      if (outDir) await writePng(path.join(outDir, `${spec.name}.png`), result.texture, { rgb: true });
    } catch (err) {
      if (err instanceof PipelineError && !goldenNames.has(spec.name)) {
        line += `PASS  rejected as expected: ${err.code} (missing: ${err.missingCorners.join(', ')})`;
      } else {
        failures++;
        line += `FAIL  ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    console.log(line);
  }

  console.log(failures === 0 ? '\nall fixtures OK' : `\n${failures} fixture(s) FAILED`);
  if (outDir) console.log(`actual textures written to ${outDir}`);
  if (failures > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: dino-fixtures [--check [--out <dir>]]');
    return;
  }
  if (argv.includes('--check')) {
    const i = argv.indexOf('--out');
    await check(i >= 0 ? path.resolve(argv[i + 1] ?? '.') : undefined);
    return;
  }
  await generate();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
