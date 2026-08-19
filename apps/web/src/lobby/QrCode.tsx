/**
 * A QR code, rendered as inline SVG.
 *
 * `qrcode-generator` is a 20 KB dependency-free encoder; we read its module
 * matrix ourselves instead of using `createSvgTag`, so nothing goes through
 * `dangerouslySetInnerHTML` and the markup is plain React.
 *
 * Error-correction level M with a quiet zone of 4 modules is what the QR spec
 * asks for — the projector code has to survive being photographed at an angle
 * across a room.
 */
import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

const QUIET_ZONE = 4;

export interface QrCodeProps {
  /** The URL (or any text) to encode. */
  value: string;
  /** Rendered edge length in CSS pixels. */
  size?: number;
  className?: string;
  title?: string;
}

export function QrCode({ value, size = 132, className, title }: QrCodeProps): JSX.Element {
  const { path, span } = useMemo(() => buildPath(value), [value]);

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${span} ${span}`}
      role="img"
      aria-label={title ?? `QR code for ${value}`}
      data-testid="lobby-qr"
      data-qr-value={value}
      shapeRendering="crispEdges"
    >
      <rect width={span} height={span} fill="#ffffff" />
      <path d={path} fill="#101418" />
    </svg>
  );
}

/** One `<path>` for the whole matrix — far fewer nodes than a rect per module. */
function buildPath(value: string): { path: string; span: number } {
  // Type 0 = pick the smallest version that fits.
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();

  const count = qr.getModuleCount();
  const span = count + QUIET_ZONE * 2;
  let path = '';
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!qr.isDark(row, col)) continue;
      path += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
    }
  }
  return { path, span };
}
