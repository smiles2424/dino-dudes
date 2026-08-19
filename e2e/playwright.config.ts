import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Ports are pinned so the web build's baked-in API URL matches the server. */
export const SERVER_PORT = 2567;
export const WEB_PORT = 5173;
export const WEB_BASE_URL = `http://127.0.0.1:${WEB_PORT}`;
export const SERVER_BASE_URL = `http://127.0.0.1:${SERVER_PORT}`;

const isCI = Boolean(process.env['CI']);

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 1 : undefined,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  /**
   * Every lobby test creates real rows in Neon. This deletes them afterwards
   * (and no-ops without `DATABASE_URL`) — see `scripts/cleanup-e2e-rows.mjs`.
   */
  globalTeardown: './global-teardown.ts',

  /**
   * One committed screenshot baseline for every OS (added in Wave 2B).
   *
   * Playwright's default template appends `{platform}`, which would mean a
   * `-win32` baseline that CI (ubuntu) can never satisfy. Instead the 3D tests
   * force SwiftShader, a fixed viewport/DPR and a fixed-size canvas, and keep
   * all text out of the canvas — so a single baseline is valid everywhere.
   */
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{arg}{ext}',

  use: {
    baseURL: WEB_BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  /**
   * Both servers run from the built output (`pnpm build` first — the root
   * `pnpm e2e` script does this for you). Building rather than using dev
   * servers keeps teardown clean on Windows and matches what CI ships.
   */
  webServer: [
    {
      command: 'node dist/index.js',
      cwd: path.join(repoRoot, 'apps', 'server'),
      url: `${SERVER_BASE_URL}/healthz`,
      reuseExistingServer: !isCI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PORT: String(SERVER_PORT),
        HOST: '127.0.0.1',
        NODE_ENV: 'test',
      },
    },
    {
      command: `pnpm exec vite preview --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      cwd: path.join(repoRoot, 'apps', 'web'),
      url: WEB_BASE_URL,
      reuseExistingServer: !isCI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
