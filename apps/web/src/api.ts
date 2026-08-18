/**
 * Client side of the frozen API contract. Every response is parsed with the
 * shared Zod schema, so server drift surfaces as a loud error instead of
 * `undefined` deep in a component.
 */
import { API_ROUTES, HealthSchema, type Health } from '@dino/shared';

export const API_BASE: string = import.meta.env['VITE_API_URL'] ?? 'http://localhost:2567';

export async function fetchHealth(signal?: AbortSignal): Promise<Health> {
  const res = await fetch(`${API_BASE}${API_ROUTES.health}`, { signal });
  if (!res.ok) throw new Error(`${API_ROUTES.health} responded ${res.status}`);
  return HealthSchema.parse(await res.json());
}
