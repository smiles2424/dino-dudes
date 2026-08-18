#!/usr/bin/env node
/**
 * `pnpm --filter @dino/pipeline generate-template`
 *
 * Writes the printable template into `assets/templates/`.
 *
 *   --model <slug>    generate for one dino (default: every slug in the spec,
 *                     plus a generic sheet)
 *   --out <dir>       output directory (default: <repo>/assets/templates)
 *   --no-pdf          SVG only
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_SLUGS } from '@dino/shared';
import { renderTemplatePdf, renderTemplateSvg, type TemplateOptions } from './template.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

interface Args {
  models: (string | undefined)[];
  outDir: string;
  pdf: boolean;
}

function parseArgs(argv: string[]): Args {
  const models: (string | undefined)[] = [];
  let outDir = path.join(repoRoot, 'assets', 'templates');
  let pdf = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--model') {
      const value = argv[++i];
      if (!value) throw new Error('--model requires a value');
      models.push(value);
    } else if (arg === '--out') {
      const value = argv[++i];
      if (!value) throw new Error('--out requires a value');
      outDir = path.resolve(value);
    } else if (arg === '--no-pdf') {
      pdf = false;
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: dino-template [--model <slug>]... [--out <dir>] [--no-pdf]');
      process.exit(0);
    } else if (arg !== undefined) {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (models.length === 0) models.push(undefined, ...MODEL_SLUGS);
  return { models, outDir, pdf };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.outDir, { recursive: true });

  for (const model of args.models) {
    const options: TemplateOptions = model ? { modelSlug: model } : {};
    const base = model ? `template-${model}` : 'template-generic';

    const svgPath = path.join(args.outDir, `${base}.svg`);
    await writeFile(svgPath, renderTemplateSvg(options), 'utf8');
    console.log(`wrote ${path.relative(repoRoot, svgPath)}`);

    if (args.pdf) {
      const pdfPath = path.join(args.outDir, `${base}.pdf`);
      await writeFile(pdfPath, renderTemplatePdf(options));
      console.log(`wrote ${path.relative(repoRoot, pdfPath)}`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
