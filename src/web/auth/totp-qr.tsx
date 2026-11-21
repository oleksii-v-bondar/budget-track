import QRCode from 'qrcode';
import { useMemo } from 'react';

/** One SVG path with a 1 × 1 square per dark module, merging runs of modules in a row. */
function qrPath(text: string): { d: string; size: number } {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  let d = '';
  for (let row = 0; row < modules.size; row++) {
    for (let col = 0; col < modules.size; col++) {
      if (!modules.get(row, col)) continue;
      let run = 1;
      while (col + run < modules.size && modules.get(row, col + run)) run++;
      d += `M${col} ${row}h${run}v1h-${run}z`;
      col += run - 1;
    }
  }
  return { d, size: modules.size };
}

const QUIET_ZONE = 4;

/**
 * The authenticator's otpauth:// URI as a QR code, drawn as inline SVG: the strict CSP (img-src 'self') blocks data:
 * images, and nothing is sent anywhere to render it.
 */
export function TotpQrCode({ uri }: { uri: string }) {
  const { d, size } = useMemo(() => qrPath(uri), [uri]);
  const box = size + 2 * QUIET_ZONE;
  return (
    <svg
      role="img"
      aria-label="QR code for your authenticator app"
      viewBox={`0 0 ${box} ${box}`}
      shapeRendering="crispEdges"
      className="mx-auto size-56 rounded-lg bg-white"
    >
      <path d={d} fill="#000" transform={`translate(${QUIET_ZONE} ${QUIET_ZONE})`} />
    </svg>
  );
}

/** The secret in groups of four, for typing it into an authenticator app by hand. */
export function TotpSecret({ secret }: { secret: string }) {
  return (
    <p className="text-center text-sm text-gray-600">
      Can't scan it? Enter this key instead:
      <span data-testid="totp-secret" className="mt-1 block font-mono text-base tracking-wider text-gray-900 select-all">
        {secret.match(/.{1,4}/g)?.join(' ')}
      </span>
    </p>
  );
}
