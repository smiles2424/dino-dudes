import { useEffect, useMemo, useState } from 'react';
import { LobbyCodeSchema, TEXTURE, TEXTURE_SPEC } from '@dino/shared';
import { API_BASE, fetchHealth } from './api.js';
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
  const lobbyCode = useMemo(readLobbyCode, []);

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

      <section className="card" data-testid="server-health" data-status={status}>
        <h2>Server</h2>
        <p className="status-line">
          Status: <strong data-testid="server-status">{LABEL[status]}</strong>
        </p>
        <dl>
          <dt>API</dt>
          <dd data-testid="api-base">{API_BASE}</dd>
          <dt>Version</dt>
          <dd data-testid="server-version">{health?.version ?? '—'}</dd>
          <dt>Uptime</dt>
          <dd data-testid="server-uptime">
            {health ? `${health.uptimeSeconds}s` : '—'}
          </dd>
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
      </section>

      {/*
        A lobby join link (`/?lobby=CODE`, the shape `POST /api/lobbies` hands
        out and the projector's QR code encodes) lands here. Chunk 4.2 turns
        this into the capture flow; for now it just forwards to the game view.
      */}
      {lobbyCode ? (
        <section className="card" data-testid="lobby-invite">
          <h2>
            Lobby <strong data-testid="invite-code">{lobbyCode}</strong>
          </h2>
          <p>
            <a href={`/play?lobby=${lobbyCode}`} data-testid="invite-watch-link">
              Open the game view
            </a>
          </p>
        </section>
      ) : null}

      <section className="card">
        <h2>3D world</h2>
        <p>
          <a href="/debug/world" data-testid="world-link">
            Open the world harness
          </a>{' '}
          — four low-poly dinos wearing test drawings, no backend required.
        </p>
        <p>
          <a href="/play" data-testid="play-link">
            Open the game view
          </a>{' '}
          — a live lobby on the projector screen.
        </p>
      </section>

      <section className="card">
        <h2>Texture spec v{TEXTURE_SPEC.version}</h2>
        <p>
          {TEXTURE.width}×{TEXTURE.height} PNG · ArUco {TEXTURE_SPEC.markers.dictionary} · corner
          IDs {TEXTURE_SPEC.markers.order.join(', ')}
        </p>
      </section>
    </main>
  );
}

/** The lobby code from a `/?lobby=CODE` join link, if it is a valid one. */
function readLobbyCode(): string | null {
  const raw = new URLSearchParams(window.location.search).get('lobby') ?? '';
  const parsed = LobbyCodeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function describeCheck(value: boolean | null | undefined): string {
  if (value === undefined || value === null) return 'not configured';
  return value ? 'reachable' : 'unreachable';
}
