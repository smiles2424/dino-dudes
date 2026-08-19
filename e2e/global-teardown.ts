/**
 * Playwright global teardown (Wave 4, Chunk 4.3): remove the rows the browser
 * suite left in Neon.
 *
 * The work itself lives in `scripts/cleanup-e2e-rows.mjs` at the repo root,
 * where `pg` and `dotenv` are already dependencies and where a human can run it
 * by hand (`pnpm e2e:cleanup`). Spawning it keeps the `@dino/e2e` package free
 * of a database driver — this program's job is browsers.
 *
 * Never throws: cleanup failing (or being skipped for want of secrets) must not
 * turn a green suite red. The script itself exits 0 in both cases; this only
 * guards against it being missing or the runtime refusing to start it.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default function globalTeardown(): void {
  try {
    execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'cleanup-e2e-rows.mjs')], {
      stdio: 'inherit',
      cwd: repoRoot,
    });
  } catch (cause) {
    console.warn(`WARN  e2e cleanup could not run — ${(cause as Error).message}`);
  }
}
