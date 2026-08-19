/**
 * `/` — the capture flow (Wave 4, Chunk 4.2). This is the page a phone lands
 * on after scanning the projector's QR code, so every decision here is a
 * mobile-first, school-event-crowd decision: one question per screen, big
 * touch targets, a spinner on anything that takes longer than a blink, and no
 * button that can be pressed twice.
 *
 *   details  name + lobby code (prefilled from `?lobby=CODE`, checked against
 *            `GET /api/lobbies/:code` before anyone draws a thing)
 *      ↓
 *   model    which dinosaur — the picker draws the same silhouette the printed
 *            template carries
 *      ↓
 *   photo    `<input type="file" capture="environment">` → downscale → the
 *            REAL `@dino/pipeline` deskew, in this browser. A failure comes
 *            back as a four-entry per-corner diagnostic and becomes the retake
 *            UI; blur/distance warnings are advisory only.
 *      ↓
 *   preview  the drawing on the actual 3D model (`<WorldView>`, the projector's
 *            own renderer) → confirm → `POST /api/avatars` → `/play?…`
 *
 * There is no auth: name + lobby code is the identity, by design. The
 * `playerId` the upload returns is passed on to `/play` so the room adopts the
 * persisted player instead of minting a second dino for the same person.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  CORNER_LABELS,
  LobbyCodeSchema,
  MODEL_SLUGS,
  PlayerNameSchema,
  type ModelSlug,
  type PipelineErrorPayload,
} from '@dino/shared';
import { PipelineError } from '@dino/pipeline';
import { ApiClientError, fetchLobby, uploadAvatar } from '../api.js';
import { captureTexture, type CapturedTexture } from './photo.js';
import { DinoSilhouette } from './DinoSilhouette.js';
import { PreviewStage } from './PreviewStage.js';

type Step = 'details' | 'model' | 'photo' | 'preview';

/** What went wrong with a photo: markers we can explain, or anything else. */
type Failure =
  | { kind: 'corners'; payload: PipelineErrorPayload }
  | { kind: 'message'; message: string };

const STEP_ORDER: readonly Step[] = ['details', 'model', 'photo', 'preview'];

const MODEL_LABELS: Readonly<Record<ModelSlug, string>> = {
  trex: 'T. rex',
  stego: 'Stegosaurus',
  raptor: 'Raptor',
  bronto: 'Brontosaurus',
};

const WARNING_TEXT = {
  blurry: 'This one looks a little soft. It will still work — retake it if you want it crisper.',
  too_far: 'You were quite far back, so the drawing may look fuzzy. Closer is better.',
} as const;

export function CapturePage(): JSX.Element {
  const [step, setStep] = useState<Step>('details');

  const [name, setName] = useState('');
  const [code, setCode] = useState(readLobbyCode);
  const [modelSlug, setModelSlug] = useState<ModelSlug>(MODEL_SLUGS[0]);

  const [checking, setChecking] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  const [processing, setProcessing] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [captured, setCaptured] = useState<CapturedTexture | null>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Every capture holds an object URL for a ~1 MB PNG; drop the old one as
  // soon as it is replaced, and on unmount.
  const capturedUrl = captured?.url;
  useEffect(
    () => () => {
      if (capturedUrl) URL.revokeObjectURL(capturedUrl);
    },
    [capturedUrl],
  );

  // ── details ──────────────────────────────────────────────────────────────
  const submitDetails = useCallback(async (): Promise<void> => {
    if (checking) return;

    const parsedName = PlayerNameSchema.safeParse(name);
    if (!parsedName.success) {
      setDetailsError('Type your name, so everyone knows whose dinosaur it is.');
      return;
    }
    const parsedCode = LobbyCodeSchema.safeParse(code);
    if (!parsedCode.success) {
      setDetailsError('A lobby code is 5 letters and numbers, like ABC23.');
      return;
    }

    setChecking(true);
    setDetailsError(null);
    try {
      const found = await fetchLobby(parsedCode.data);
      if (found.lobby.closedAt !== null) {
        setDetailsError('That lobby has been closed. Ask for the new code on the big screen.');
        return;
      }
      setName(parsedName.data);
      setCode(parsedCode.data);
      setStep('model');
    } catch (error) {
      setDetailsError(readableMessage(error));
    } finally {
      setChecking(false);
    }
  }, [checking, code, name]);

  // ── photo ────────────────────────────────────────────────────────────────
  const takePhoto = useCallback(
    async (file: File): Promise<void> => {
      setProcessing(true);
      setFailure(null);
      setUploadError(null);

      // `processPhoto` is synchronous and blocks the main thread for a few
      // hundred milliseconds, so let the spinner actually paint first.
      await nextPaint();

      try {
        const result = await captureTexture(file);
        setCaptured((previous) => {
          if (previous) URL.revokeObjectURL(previous.url);
          return result;
        });
        setStep('preview');
      } catch (error) {
        if (error instanceof PipelineError) setFailure({ kind: 'corners', payload: error.payload });
        else setFailure({ kind: 'message', message: readableMessage(error) });
      } finally {
        setProcessing(false);
      }
    },
    [],
  );

  const retake = useCallback((): void => {
    setCaptured((previous) => {
      if (previous) URL.revokeObjectURL(previous.url);
      return null;
    });
    setFailure(null);
    setUploadError(null);
    setStep('photo');
  }, []);

  // ── confirm ──────────────────────────────────────────────────────────────
  const confirm = useCallback(async (): Promise<void> => {
    if (!captured || uploading) return;
    setUploading(true);
    setUploadError(null);
    try {
      const created = await uploadAvatar({
        lobbyCode: code,
        playerName: name,
        modelSlug,
        texture: captured.blob,
        textureHash: captured.hash,
      });
      // Hand `/play` the persisted player id — that is what stops the room
      // giving this person a second, empty dino (Chunk 4.1, note (b)).
      const params = new URLSearchParams({
        lobby: code,
        name,
        model: modelSlug,
        playerId: created.player.id,
      });
      // Deliberately NOT re-enabling the button: we are leaving the page.
      window.location.assign(`/play?${params.toString()}`);
    } catch (error) {
      setUploadError(readableMessage(error));
      setUploading(false);
    }
  }, [captured, code, modelSlug, name, uploading]);

  // ── render ───────────────────────────────────────────────────────────────
  return (
    <section className="capture" data-testid="capture-flow" data-step={step}>
      <ol className="capture-steps" data-testid="capture-progress">
        {STEP_ORDER.map((value, index) => (
          <li
            key={value}
            data-step={value}
            data-state={
              value === step
                ? 'current'
                : STEP_ORDER.indexOf(step) > index
                  ? 'done'
                  : 'todo'
            }
          >
            {index + 1}
          </li>
        ))}
      </ol>

      {step === 'details' ? (
        <form
          className="card capture-card"
          data-testid="capture-details"
          onSubmit={(event) => {
            event.preventDefault();
            void submitDetails();
          }}
        >
          <h2>Who are you?</h2>
          <label className="field">
            <span>Your name</span>
            <input
              name="playerName"
              autoComplete="given-name"
              enterKeyHint="next"
              placeholder="Sam"
              maxLength={24}
              value={name}
              onChange={(event) => setName(event.target.value)}
              data-testid="capture-name"
            />
          </label>
          <label className="field">
            <span>Lobby code</span>
            <input
              name="lobbyCode"
              className="code-input"
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="go"
              placeholder="ABC23"
              maxLength={5}
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase().trim())}
              data-testid="capture-code"
            />
            <small>It&rsquo;s on the big screen, next to the QR code.</small>
          </label>

          {detailsError ? (
            <p className="error" data-testid="capture-details-error" role="alert">
              {detailsError}
            </p>
          ) : null}

          <button
            type="submit"
            className="big"
            disabled={checking}
            data-testid="capture-details-submit"
          >
            {checking ? <Spinner label="Checking the code…" /> : 'Next'}
          </button>
        </form>
      ) : null}

      {step === 'model' ? (
        <div className="card capture-card" data-testid="capture-model">
          <h2>Pick your dinosaur</h2>
          <p className="hint">
            Draw on the sheet printed for this one — the outline shows which shape your drawing
            wraps onto.
          </p>
          <div className="model-grid" role="radiogroup" aria-label="Dinosaur">
            {MODEL_SLUGS.map((slug) => (
              <button
                key={slug}
                type="button"
                role="radio"
                aria-checked={slug === modelSlug}
                className={slug === modelSlug ? 'model-option is-selected' : 'model-option'}
                data-testid={`capture-model-${slug}`}
                data-selected={slug === modelSlug}
                onClick={() => setModelSlug(slug)}
              >
                <DinoSilhouette slug={slug} />
                <span>{MODEL_LABELS[slug]}</span>
              </button>
            ))}
          </div>
          <div className="capture-actions">
            <button type="button" className="ghost" onClick={() => setStep('details')}>
              Back
            </button>
            <button
              type="button"
              className="big"
              onClick={() => setStep('photo')}
              data-testid="capture-model-submit"
            >
              Next
            </button>
          </div>
        </div>
      ) : null}

      {step === 'photo' ? (
        <div className="card capture-card" data-testid="capture-photo">
          <h2>Photograph your drawing</h2>
          <p className="hint">
            Lay the sheet flat, hold the phone straight above it, and keep all four black corner
            squares in the picture.
          </p>

          {/*
            The input stays mounted for the whole step — a failed photo simply
            replaces the file, which is also what makes the retake loop a single
            control instead of a modal.
          */}
          <label className={processing ? 'photo-button is-busy' : 'photo-button'}>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              disabled={processing}
              data-testid="capture-photo-input"
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Clear it so picking the SAME file again still fires `change`.
                event.target.value = '';
                if (file) void takePhoto(file);
              }}
            />
            <span>{failure ? 'Take another photo' : 'Take a photo'}</span>
          </label>

          {processing ? (
            <p className="processing" data-testid="capture-processing" role="status">
              <Spinner label="Reading your drawing…" />
            </p>
          ) : null}

          {failure?.kind === 'corners' ? <CornerHints payload={failure.payload} /> : null}

          {failure?.kind === 'message' ? (
            <p className="error" data-testid="capture-photo-error" role="alert">
              {failure.message}
            </p>
          ) : null}

          <div className="capture-actions">
            <button type="button" className="ghost" onClick={() => setStep('model')}>
              Back
            </button>
          </div>
        </div>
      ) : null}

      {step === 'preview' && captured ? (
        <div className="card capture-card" data-testid="capture-preview">
          <h2>Meet your dinosaur</h2>
          <PreviewStage
            name={name}
            modelSlug={modelSlug}
            textureUrl={captured.url}
            textureKey={captured.hash ?? 'capture-preview-texture'}
          />

          {captured.warnings.map((warning) => (
            <p key={warning} className="warning" data-testid="capture-warning" data-warning={warning}>
              {WARNING_TEXT[warning]}
            </p>
          ))}

          {uploadError ? (
            <p className="error" data-testid="capture-upload-error" role="alert">
              {uploadError}
            </p>
          ) : null}

          <div className="capture-actions">
            <button
              type="button"
              className="ghost"
              onClick={retake}
              disabled={uploading}
              data-testid="capture-retake"
            >
              Retake
            </button>
            <button
              type="button"
              className="big"
              onClick={() => void confirm()}
              disabled={uploading}
              data-testid="capture-confirm"
            >
              {uploading ? <Spinner label="Sending…" /> : 'Send it to the world'}
            </button>
          </div>

          <p className="capture-meta" data-testid="capture-meta">
            <span data-testid="capture-texture-hash">{captured.hash ?? 'unhashed'}</span> ·{' '}
            <span data-testid="capture-elapsed">{captured.elapsedMs}</span> ms ·{' '}
            {captured.source.width}×{captured.source.height}
          </p>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The retake UI, straight off `PipelineError.payload.corners`.
 *
 * The pipeline is all-or-nothing — it needs all four markers — so a failure
 * always reports every corner. Showing the found ones too is the point: it
 * turns "it didn't work" into "three of four; move your thumb off the
 * bottom-left square".
 */
function CornerHints({ payload }: { payload: PipelineErrorPayload }): JSX.Element {
  return (
    <div className="corner-hints" data-testid="capture-corner-hints" data-error={payload.error}>
      <p className="error" role="alert" data-testid="capture-corner-summary">
        {payload.message}
      </p>

      {/* A little map of the sheet, so "bottom-left" needs no reading. */}
      <ul className="corner-grid">
        {['topLeft', 'topRight', 'bottomLeft', 'bottomRight'].map((name) => {
          const corner = payload.corners.find((entry) => entry.corner === name);
          if (!corner) return null;
          return (
            <li
              key={name}
              data-testid="capture-corner"
              data-corner={corner.corner}
              data-found={corner.found}
            >
              <span aria-hidden="true">{corner.found ? '✓' : '✕'}</span>
              {CORNER_LABELS[corner.corner]}
            </li>
          );
        })}
      </ul>

      <ul className="corner-hint-list">
        {payload.corners
          .filter((corner) => !corner.found)
          .map((corner) => (
            <li key={corner.corner} data-testid="capture-corner-hint" data-corner={corner.corner}>
              {corner.hint}
            </li>
          ))}
      </ul>
    </div>
  );
}

function Spinner({ label }: { label: string }): JSX.Element {
  return (
    <>
      <span className="spinner" aria-hidden="true" data-testid="capture-spinner" />
      {label}
    </>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

/** The code from a `/?lobby=CODE` join link (the QR code's payload). */
function readLobbyCode(): string {
  const raw = new URLSearchParams(window.location.search).get('lobby') ?? '';
  const parsed = LobbyCodeSchema.safeParse(raw);
  return parsed.success ? parsed.data : '';
}

/** Two frames is enough for React to have committed and the browser painted. */
function nextPaint(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function readableMessage(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Try that again.';
}
