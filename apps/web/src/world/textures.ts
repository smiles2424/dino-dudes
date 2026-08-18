/**
 * Texture loading + the placeholder shown while a drawing is in flight.
 *
 * Everything here is content-addressed: a texture is fetched once per URL and
 * shared by every dino wearing that hash. Nothing in this file creates or
 * touches geometry — swapping a texture must never rebuild a model.
 */
import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  UnsignedByteType,
} from 'three';
import type { ModelSlug } from '@dino/shared';

const loader = new TextureLoader();
const inFlight = new Map<string, Promise<Texture>>();

/** Fetch (or reuse) the texture at `url`, ready to be dropped on a material. */
export async function loadWorldTexture(url: string): Promise<Texture> {
  const existing = inFlight.get(url);
  if (existing) return existing;

  const pending = loader.loadAsync(url).then((texture) => {
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = 1;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return texture;
  });

  inFlight.set(url, pending);
  try {
    return await pending;
  } catch (error) {
    inFlight.delete(url);
    throw error;
  }
}

/** Base hues used for the "no drawing yet" skin, one per species. */
const SLUG_TINT: Record<ModelSlug, [number, number, number]> = {
  trex: [104, 142, 92],
  stego: [122, 132, 168],
  raptor: [178, 138, 88],
  bronto: [126, 154, 138],
};

const fallbackCache = new Map<ModelSlug, DataTexture>();

/**
 * The placeholder skin: a soft two-tone check generated in code (no canvas, no
 * fonts, no network) so it renders identically on every machine. Shown from
 * mount until the real drawing arrives, and left in place if the fetch fails.
 */
export function getFallbackTexture(slug: ModelSlug): DataTexture {
  const cached = fallbackCache.get(slug);
  if (cached) return cached;

  const size = 32;
  const data = new Uint8Array(size * size * 4);
  const [r, g, b] = SLUG_TINT[slug];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dark = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0;
      const shade = dark ? 0.82 : 1;
      const i = (y * size + x) * 4;
      data[i] = Math.round(r * shade);
      data[i + 1] = Math.round(g * shade);
      data[i + 2] = Math.round(b * shade);
      data[i + 3] = 255;
    }
  }

  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  fallbackCache.set(slug, texture);
  return texture;
}

/** A tiling two-tone check for the ground. Code-generated, stable. */
export function makeCheckerTexture(
  a: [number, number, number],
  b: [number, number, number],
  repeat: number,
): DataTexture {
  const size = 16;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const color = (Math.floor(x / (size / 2)) + Math.floor(y / (size / 2))) % 2 === 0 ? a : b;
      const i = (y * size + x) * 4;
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
      data[i + 3] = 255;
    }
  }

  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.anisotropy = 1;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** A vertical gradient used as the sky dome's skin. Code-generated, stable. */
export function makeGradientTexture(
  bottom: [number, number, number],
  top: [number, number, number],
  steps = 64,
): DataTexture {
  const data = new Uint8Array(steps * 4);
  for (let i = 0; i < steps; i += 1) {
    const t = steps === 1 ? 0 : i / (steps - 1);
    data[i * 4] = Math.round(bottom[0] + (top[0] - bottom[0]) * t);
    data[i * 4 + 1] = Math.round(bottom[1] + (top[1] - bottom[1]) * t);
    data[i * 4 + 2] = Math.round(bottom[2] + (top[2] - bottom[2]) * t);
    data[i * 4 + 3] = 255;
  }

  const texture = new DataTexture(data, 1, steps, RGBAFormat, UnsignedByteType);
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
