/**
 * Minimal PNG header inspection.
 *
 * The pipeline already produced a canonical texture client-side, but the server
 * must never trust that: `POST /api/avatars` accepts arbitrary bytes from a
 * phone. Reading the 8-byte signature + IHDR chunk is enough to prove "this is
 * a PNG of exactly the Texture Spec's dimensions" without pulling an image
 * decoder into the server (nothing here ever needs the pixels).
 */
import { TEXTURE } from '@dino/shared';

/** The 8 bytes every PNG starts with. */
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngInfo {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
}

/** Parses signature + IHDR. Returns `null` when the bytes are not a PNG. */
export function readPngInfo(bytes: Buffer): PngInfo | null {
  // 8 signature + 4 length + 4 type + 13 data = 29 bytes minimum.
  if (bytes.length < 29) return null;
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  // IHDR must be the first chunk, and is always 13 bytes of data.
  if (bytes.readUInt32BE(8) !== 13) return null;
  if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return null;

  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24] ?? 0,
    colorType: bytes[25] ?? 0,
  };
}

export type TextureCheck =
  | { ok: true; info: PngInfo }
  | { ok: false; reason: 'not_png' | 'wrong_dimensions' | 'too_large' | 'empty'; details: unknown };

/**
 * Validates an uploaded file against the frozen Texture Spec:
 * a real PNG, exactly {@link TEXTURE.width}×{@link TEXTURE.height},
 * no larger than {@link TEXTURE.maxBytes}.
 */
export function checkTexturePng(bytes: Buffer): TextureCheck {
  if (bytes.length === 0) return { ok: false, reason: 'empty', details: { bytes: 0 } };

  if (bytes.length > TEXTURE.maxBytes) {
    return {
      ok: false,
      reason: 'too_large',
      details: { bytes: bytes.length, maxBytes: TEXTURE.maxBytes },
    };
  }

  const info = readPngInfo(bytes);
  if (!info) {
    return {
      ok: false,
      reason: 'not_png',
      details: { expectedMimeType: TEXTURE.mimeType, signature: bytes.subarray(0, 8).toString('hex') },
    };
  }

  if (info.width !== TEXTURE.width || info.height !== TEXTURE.height) {
    return {
      ok: false,
      reason: 'wrong_dimensions',
      details: {
        width: info.width,
        height: info.height,
        expected: { width: TEXTURE.width, height: TEXTURE.height },
      },
    };
  }

  return { ok: true, info };
}
