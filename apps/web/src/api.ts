/**
 * Client side of the frozen API contract. Every response is parsed with the
 * shared Zod schema, so server drift surfaces as a loud error instead of
 * `undefined` deep in a component.
 */
import {
  API_ROUTES,
  ApiErrorSchema,
  CreateAvatarResponseSchema,
  GetLobbyResponseSchema,
  HealthSchema,
  type ApiErrorCode,
  type CreateAvatarResponse,
  type GetLobbyResponse,
  type Health,
  type ModelSlug,
} from '@dino/shared';

export const API_BASE: string = import.meta.env['VITE_API_URL'] ?? 'http://localhost:2567';

export async function fetchHealth(signal?: AbortSignal): Promise<Health> {
  const res = await fetch(`${API_BASE}${API_ROUTES.health}`, { signal });
  if (!res.ok) throw new Error(`${API_ROUTES.health} responded ${res.status}`);
  return HealthSchema.parse(await res.json());
}

/**
 * A failed API call, already carrying something a nine-year-old at a school
 * event can act on. `code` is the frozen {@link ApiErrorCode} when the server
 * answered in contract, and `null` when it did not answer at all.
 */
export class ApiClientError extends Error {
  readonly status: number | null;
  readonly code: ApiErrorCode | null;

  constructor(message: string, status: number | null, code: ApiErrorCode | null) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
  }
}

/**
 * `GET /api/lobbies/:code` — the capture flow's join-code validation.
 *
 * Checking the code *before* the photo step is deliberate: it is much kinder
 * to say "no lobby with that code" while the phone is still in the queue than
 * after someone has drawn, photographed and waited on an upload.
 */
export async function fetchLobby(code: string, signal?: AbortSignal): Promise<GetLobbyResponse> {
  const res = await request(`${API_BASE}/api/lobbies/${encodeURIComponent(code)}`, { signal });
  if (!res.ok) {
    throw await apiError(res, {
      404: `No lobby with the code ${code}. Check the code on the big screen.`,
      400: `${code} is not a valid lobby code.`,
    });
  }
  return GetLobbyResponseSchema.parse(await res.json());
}

export interface UploadAvatarInput {
  lobbyCode: string;
  playerName: string;
  modelSlug: ModelSlug;
  /** The canonical 1024² PNG from the pipeline. */
  texture: Blob;
  /** Optional; the server always re-derives the hash and verifies this. */
  textureHash?: string | null;
  signal?: AbortSignal;
}

/** `POST /api/avatars` — multipart, exactly the shape Chunk 3.2 accepts. */
export async function uploadAvatar(input: UploadAvatarInput): Promise<CreateAvatarResponse> {
  const body = new FormData();
  body.set('lobbyCode', input.lobbyCode);
  body.set('playerName', input.playerName);
  body.set('modelSlug', input.modelSlug);
  if (input.textureHash) body.set('textureHash', input.textureHash);
  // The filename matters: `@fastify/multipart` needs a file part, not a field.
  body.set('texture', input.texture, 'texture.png');

  const init: RequestInit = { method: 'POST', body };
  if (input.signal) init.signal = input.signal;
  const res = await request(`${API_BASE}${API_ROUTES.createAvatar}`, init);
  if (!res.ok) {
    throw await apiError(res, {
      404: 'That lobby has gone away. Check the code on the big screen.',
      413: 'That drawing came out too big to send. Take the photo again.',
    });
  }
  return CreateAvatarResponseSchema.parse(await res.json());
}

// ── Internals ──────────────────────────────────────────────────────────────

/** `fetch`, with a dead/unreachable server turned into an {@link ApiClientError}. */
async function request(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiClientError(
      "Couldn't reach the game server. Check the Wi-Fi and try again.",
      null,
      null,
    );
  }
}

/**
 * Turns a non-2xx response into an {@link ApiClientError}, preferring — in
 * order — a caller-supplied sentence for that status, the server's own
 * `ApiError.message`, then a last-resort generic.
 */
async function apiError(res: Response, overrides: Record<number, string>): Promise<ApiClientError> {
  let code: ApiErrorCode | null = null;
  let serverMessage: string | null = null;
  try {
    const parsed = ApiErrorSchema.safeParse(await res.json());
    if (parsed.success) {
      code = parsed.data.error;
      serverMessage = parsed.data.message;
    }
  } catch {
    // A non-JSON body (a proxy's HTML error page) is no reason to blow up.
  }

  const message =
    overrides[res.status] ??
    serverMessage ??
    `The game server said no (${res.status}). Try again in a moment.`;
  return new ApiClientError(message, res.status, code);
}
