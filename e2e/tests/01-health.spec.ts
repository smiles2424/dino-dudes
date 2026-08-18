/**
 * E2E #1 — Wave 1.
 *
 * Boots the real Fastify+Colyseus server and the real web build, loads the app
 * in a browser, and asserts the healthy server status is rendered. This covers
 * the whole Wave 1 chain: server boots and reads `.env` → `/healthz` answers
 * the frozen contract → web app fetches and parses it with the shared Zod
 * schema → React renders it.
 *
 * Later waves append to this suite; nothing here may be deleted.
 */
import { expect, test } from '@playwright/test';
import { HealthSchema } from '@dino/shared';
import { SERVER_BASE_URL } from '../playwright.config.js';

test('web app loads and displays a healthy server status', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: /hello world, dino dudes/i })).toBeVisible();

  const health = page.getByTestId('server-health');
  await expect(health).toHaveAttribute('data-status', 'healthy');
  await expect(page.getByTestId('server-status')).toHaveText('Healthy');

  // The app really talked to the server, rather than rendering a stale default.
  await expect(page.getByTestId('server-version')).not.toHaveText('—');
  await expect(page.getByTestId('server-error')).toHaveCount(0);
});

test('/healthz matches the frozen Health contract', async ({ request }) => {
  const res = await request.get(`${SERVER_BASE_URL}/healthz`);
  expect(res.ok()).toBe(true);

  const parsed = HealthSchema.safeParse(await res.json());
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  expect(parsed.data?.status).toBe('ok');
});
