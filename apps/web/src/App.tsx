/**
 * `/` — the phone's entry point.
 *
 * Chunk 4.2 turned this from a hello-world into the **capture flow** (see
 * `./capture/CapturePage.tsx`); what is left here is the frame around it: the
 * title, the live server-health readout that E2E #1 has asserted since Wave 1,
 * and the links to the other two entry points.
 *
 * The health card stays deliberately: at a school event with a projector, one
 * phone that can say "the server is unreachable" is worth the two lines of
 * markup, and it is the only end-to-end proof the web build is talking to the
 * API it was built against.
 */
import { useEffect, useState } from 'react';
import { API_BASE, fetchHealth } from './api.js';
import { CapturePage } from './capture/CapturePage.js';
import type { Health } from '@dino/shared';

type Status = 'checking' | 'healthy' | 'degraded' | 'unreachable';

const LABEL: Record<Status, string> = {
  checking: 'Checking…',
  healthy: 'Healthy',
  degraded: 'Degraded',
  unreachable: 'Unreachable',
};

const POLL_MS = 5000;

export function App(): JSX.Element {
  const [status, setStatus] = useState<Status>('checking');
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const poll = async (): Promise<void> => {
      try {
        const result = await fetchHealth(controller.signal);
        if (cancelled) return;
        setHealth(result);
        setStatus(result.status === 'ok' ? 'healthy' : 'degraded');
        setError(null);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setHealth(null);
        setStatus('unreachable');
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  return (
    <main className="app">
      <h1>Hello world, dino dudes 🦕</h1>
      <p className="tagline">
        Draw on paper, photograph it, watch your dinosaur walk into the shared world.
      </p>

      <CapturePage />

      <details className="card server-card" data-testid="server-health" data-status={status}>
        <summary className="status-line">
          Server: <strong data-testid="server-status">{LABEL[status]}</strong>
        </summary>
        <dl>
          <dt>API</dt>
          <dd data-testid="api-base">{API_BASE}</dd>
          <dt>Version</dt>
          <dd data-testid="server-version">{health?.version ?? '—'}</dd>
          <dt>Uptime</dt>
          <dd data-testid="server-uptime">{health ? `${health.uptimeSeconds}s` : '—'}</dd>
          <dt>Redis</dt>
          <dd data-testid="check-redis">{describeCheck(health?.checks.redis)}</dd>
          <dt>Postgres</dt>
          <dd data-testid="check-postgres">{describeCheck(health?.checks.postgres)}</dd>
        </dl>
        {error ? (
          <p className="error" data-testid="server-error">
            {error}
          </p>
        ) : null}
        <p className="server-links">
          <a href="/play" data-testid="play-link">
            Game view
          </a>{' '}
          ·{' '}
          <a href="/debug/world" data-testid="world-link">
            World harness
          </a>
        </p>
      </details>
    </main>
  );
}

function describeCheck(value: boolean | null | undefined): string {
  if (value === undefined || value === null) return 'not configured';
  return value ? 'reachable' : 'unreachable';
}
