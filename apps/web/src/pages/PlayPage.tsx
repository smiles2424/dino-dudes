/**
 * `/play?lobby=CODE` — the game view, i.e. the projector screen.
 *
 * The live twin of `/debug/world`: the harness feeds `<WorldView>` from static
 * JSON, this page feeds the same component from synchronized Colyseus state,
 * and neither knows about the other. Everything the E2E suite asserts lives
 * inside `<WorldView>`/`<Dino>`, so it is identical in both modes.
 *
 * `?name` joins as a player, `?model` picks the dinosaur, `?playerId` rejoins an
 * already-persisted player, `?spectator=1` forces spectating and `?static=1`
 * freezes motion. With no `name` the page spectates — it renders the whole
 * world and contributes no dino, which is what a projector wants.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  LobbyCodeSchema,
  MODEL_SLUGS,
  ModelSlugSchema,
  PlayerIdSchema,
  PlayerNameSchema,
  type LobbyJoinOptions,
} from '@dino/shared';
import { QrCode } from '../lobby/QrCode.js';
import { useLobbyRoom } from '../lobby/useLobbyRoom.js';
import { textureUrlFor } from '../lobby/room.js';
import { WorldView } from '../world/WorldView.js';

interface PlayParams {
  code: string | null;
  name: string | null;
  modelSlug: string | null;
  playerId: string | null;
  spectator: boolean;
  frozen: boolean;
}

/**
 * Screenshot mode renders at a fixed size, exactly as `/debug/world?static=1`
 * does, so a canvas assertion never depends on the window.
 */
const STATIC_SIZE = { width: 800, height: 500 };

const STATUS_LABEL = {
  connecting: 'Connecting…',
  connected: 'Live',
  error: 'Disconnected',
  closed: 'Disconnected',
} as const;

export function PlayPage(): JSX.Element {
  const [params, setParams] = useState<PlayParams>(readParams);

  const update = useCallback((patch: Partial<PlayParams>): void => {
    setParams((previous) => {
      const next = { ...previous, ...patch };
      writeParams(next);
      return next;
    });
  }, []);

  const options = useMemo(() => buildJoinOptions(params), [params]);
  const lobby = useLobbyRoom(options);

  const joinUrl = params.code ? `${window.location.origin}/?lobby=${params.code}` : null;
  const isSpectator = options?.spectator === true || !options?.name;

  if (!options || !params.code) {
    return <CodePrompt onSubmit={(code) => update({ code })} />;
  }

  return (
    <main className={params.frozen ? 'play play--static' : 'play'} data-testid="play-view">
      <div
        className="world-frame"
        data-testid="world-frame"
        style={params.frozen ? { width: STATIC_SIZE.width, height: STATIC_SIZE.height } : undefined}
      >
        <WorldView
          players={lobby.players}
          resolveTextureUrl={textureUrlFor}
          frozen={params.frozen}
          stateLoaded={lobby.status === 'connected'}
          // The server's seed + clock: what makes every screen showing this
          // lobby render the same dinosaur in the same place while it moves.
          {...(lobby.motion ? { motion: lobby.motion } : {})}
        />
      </div>

      <header className="play-banner">
        <div className="lobby-code-block">
          <span className="lobby-code-label">Lobby code</span>
          <strong className="lobby-code" data-testid="lobby-code">
            {params.code}
          </strong>
        </div>
        <p
          className="lobby-status"
          data-testid="lobby-status"
          data-status={lobby.status}
          data-dino-count={lobby.players.length}
        >
          {STATUS_LABEL[lobby.status]} · {lobby.players.length}{' '}
          {lobby.players.length === 1 ? 'dino' : 'dinos'}
          {isSpectator ? ' · spectating' : ''}
        </p>
      </header>

      {joinUrl ? (
        <aside className="join-panel" data-testid="lobby-join-panel">
          <QrCode value={joinUrl} size={132} title={`Join lobby ${params.code}`} />
          <p className="join-hint">
            Scan to draw a dino
            <br />
            <code data-testid="lobby-join-url">{joinUrl}</code>
          </p>
        </aside>
      ) : null}

      {lobby.error ? (
        <div className="play-overlay" data-testid="lobby-error">
          <div className="card">
            <h2>Lost the lobby</h2>
            <p data-testid="lobby-error-message">{lobby.error.message}</p>
            <p className="row">
              <button type="button" onClick={lobby.retry} data-testid="lobby-retry">
                Try again
              </button>
              <a href="/play" data-testid="lobby-change-code">
                Use a different code
              </a>
            </p>
          </div>
        </div>
      ) : null}

      {/*
        A deliberately bare name entry so the projector can also be used as a
        player. The real capture flow (name → dino → photo → upload) is Chunk
        4.2 and lands on `/?lobby=CODE`.
      */}
      {isSpectator && !lobby.error ? (
        <QuickJoin onJoin={(name, modelSlug) => update({ name, modelSlug, spectator: false })} />
      ) : null}
    </main>
  );
}

function QuickJoin({
  onJoin,
}: {
  onJoin: (name: string, modelSlug: string) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [modelSlug, setModelSlug] = useState<string>(MODEL_SLUGS[0] ?? 'trex');

  return (
    <form
      className="quick-join"
      data-testid="quick-join-form"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = PlayerNameSchema.safeParse(name);
        if (parsed.success) onJoin(parsed.data, modelSlug);
      }}
    >
      <input
        aria-label="Your name"
        placeholder="Your name"
        maxLength={24}
        value={name}
        onChange={(event) => setName(event.target.value)}
        data-testid="quick-join-name"
      />
      <select
        aria-label="Dinosaur"
        value={modelSlug}
        onChange={(event) => setModelSlug(event.target.value)}
        data-testid="quick-join-model"
      >
        {MODEL_SLUGS.map((slug) => (
          <option key={slug} value={slug}>
            {slug}
          </option>
        ))}
      </select>
      <button type="submit">Join</button>
    </form>
  );
}

function CodePrompt({ onSubmit }: { onSubmit: (code: string) => void }): JSX.Element {
  const [value, setValue] = useState('');
  const parsed = LobbyCodeSchema.safeParse(value);

  return (
    <main className="app" data-testid="lobby-code-prompt">
      <h1>Watch a lobby</h1>
      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          if (parsed.success) onSubmit(parsed.data);
        }}
      >
        <p>Enter the 5-character code shown on the big screen.</p>
        <p className="row">
          <input
            aria-label="Lobby code"
            placeholder="ABC23"
            maxLength={5}
            value={value}
            onChange={(event) => setValue(event.target.value.toUpperCase())}
            data-testid="lobby-code-input"
          />
          <button type="submit" disabled={!parsed.success} data-testid="lobby-code-submit">
            Watch
          </button>
        </p>
      </form>
    </main>
  );
}

// ── URL plumbing ───────────────────────────────────────────────────────────

function readParams(): PlayParams {
  const search = new URLSearchParams(window.location.search);
  const code = LobbyCodeSchema.safeParse(search.get('lobby') ?? '');
  return {
    code: code.success ? code.data : null,
    name: search.get('name'),
    modelSlug: search.get('model'),
    playerId: search.get('playerId'),
    spectator: search.get('spectator') === '1',
    frozen: search.get('static') === '1',
  };
}

/** Keep the address bar shareable/reloadable without pulling in a router. */
function writeParams(params: PlayParams): void {
  const search = new URLSearchParams(window.location.search);
  const set = (key: string, value: string | null): void => {
    if (value) search.set(key, value);
    else search.delete(key);
  };
  set('lobby', params.code);
  set('name', params.name);
  set('model', params.modelSlug);
  set('playerId', params.playerId);
  set('spectator', params.spectator ? '1' : null);
  window.history.replaceState(null, '', `${window.location.pathname}?${search.toString()}`);
}

/** `null` until there is a usable lobby code. */
function buildJoinOptions(params: PlayParams): LobbyJoinOptions | null {
  if (!params.code) return null;

  const options: LobbyJoinOptions = { code: params.code };
  const name = PlayerNameSchema.safeParse(params.name ?? '');
  const model = ModelSlugSchema.safeParse(params.modelSlug ?? '');

  // No name at all == the projector. Everything else is opt-in.
  if (!params.spectator && name.success) {
    options.name = name.data;
    if (model.success) options.modelSlug = model.data;
    // A malformed id would be rejected by the room, so drop it rather than
    // turning a shareable link into a join failure.
    const playerId = PlayerIdSchema.safeParse(params.playerId ?? '');
    if (playerId.success) options.playerId = playerId.data;
  } else {
    options.spectator = true;
  }
  return options;
}
