/**
 * Structured API errors.
 *
 * Every failure a client can see is one of `ApiErrorCodeSchema`'s codes wrapped
 * in the frozen `ApiErrorSchema` envelope, so `apps/web` can branch on
 * `error` (a stable enum) instead of parsing prose. Fastify's default error
 * shape (`{statusCode, error, message}`) does NOT match that contract, hence
 * the app-wide error handler in `app.ts`.
 */
import type { ApiError, ApiErrorCode } from '@dino/shared';

/** Throw from any route; the app error handler renders it as `ApiErrorSchema`. */
export class ApiProblem extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly details: unknown;

  constructor(statusCode: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiProblem';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  toBody(): ApiError {
    return this.details === undefined
      ? { error: this.code, message: this.message }
      : { error: this.code, message: this.message, details: this.details };
  }
}

export const badRequest = (message: string, details?: unknown): ApiProblem =>
  new ApiProblem(400, 'bad_request', message, details);

export const notFound = (message: string, details?: unknown): ApiProblem =>
  new ApiProblem(404, 'not_found', message, details);

export const textureInvalid = (message: string, details?: unknown): ApiProblem =>
  new ApiProblem(422, 'texture_invalid', message, details);

export const textureTooLarge = (message: string, details?: unknown): ApiProblem =>
  new ApiProblem(413, 'texture_too_large', message, details);

export const lobbyClosed = (message: string, details?: unknown): ApiProblem =>
  new ApiProblem(409, 'lobby_closed', message, details);

/** Too many uploads from one phone / one IP — see `rate-limit.ts`. */
export const rateLimited = (message: string, details?: unknown): ApiProblem =>
  new ApiProblem(429, 'rate_limited', message, details);

/**
 * Used when a route needs Neon/Upstash but the process was booted without
 * credentials (CI on a forked PR). 503 + `internal` rather than a crash —
 * `/healthz` stays the place that reports *why*.
 */
export const notConfigured = (what: string): ApiProblem =>
  new ApiProblem(503, 'internal', `${what} is not configured on this server`);
