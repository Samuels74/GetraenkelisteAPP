import { useMemo } from 'react';
import { qrSvgPath } from '../lib/qr';

/** Crisp SVG QR code (black on white, with quiet zone). */
export function QrCode({ value, className, margin = 4 }: { value: string; className?: string; margin?: number }) {
  const { path, size } = useMemo(() => qrSvgPath(value, margin), [value, margin]);
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className={className}
      role="img"
      aria-label={`QR-Code für Nummer ${value}`}
      shapeRendering="crispEdges"
      data-testid="qr-code"
      data-qr-value={value}
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
