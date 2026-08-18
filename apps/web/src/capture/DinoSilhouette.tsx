/**
 * The little species preview in the dino picker.
 *
 * It is the *same* silhouette the printed template carries:
 * `dinoTextureOutline(slug)` returns one polygon per box of the model, already
 * projected into texture pixels by WS-C's side-projection unwrap. Drawing it
 * here rather than hand-authoring four icons means the picker can never show a
 * shape the paper does not.
 */
import { useMemo } from 'react';
import { TEXTURE, dinoTextureOutline, type ModelSlug } from '@dino/shared';

export interface DinoSilhouetteProps {
  slug: ModelSlug;
  /** Rendered width in px; the SVG keeps the texture's square aspect. */
  size?: number;
}

export function DinoSilhouette({ slug, size = 84 }: DinoSilhouetteProps): JSX.Element {
  const polygons = useMemo(
    () => dinoTextureOutline(slug).map((poly) => poly.map(([x, y]) => `${x},${y}`).join(' ')),
    [slug],
  );

  return (
    <svg
      className="dino-silhouette"
      width={size}
      height={size}
      viewBox={`0 0 ${TEXTURE.width} ${TEXTURE.height}`}
      role="img"
      aria-label={`${slug} outline`}
      data-testid="dino-silhouette"
      data-slug={slug}
    >
      {polygons.map((points, index) => (
        // eslint-disable-next-line react/no-array-index-key -- polygons are positional
        <polygon key={index} points={points} />
      ))}
    </svg>
  );
}
