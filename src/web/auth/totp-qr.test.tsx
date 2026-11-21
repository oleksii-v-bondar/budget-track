import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TotpQrCode, TotpSecret } from './totp-qr';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
// As the server's totpUri() makes it.
const URI = `otpauth://totp/Budget%20Track:owner?secret=${SECRET}&issuer=Budget%20Track`;

describe('TotpQrCode', () => {
  it('draws the QR code as inline SVG, not an image the CSP would block', () => {
    const { container } = render(<TotpQrCode uri={URI} />);
    const svg = screen.getByRole('img', { name: 'QR code for your authenticator app' });
    expect(svg.tagName).toBe('svg');
    expect(container.querySelector('img')).toBeNull();
    // 97 characters need a version 6 code at level M: 41 × 41 modules, plus a 4-module quiet zone on each side.
    expect(svg).toHaveAttribute('viewBox', '0 0 49 49');
    const d = svg.querySelector('path')!.getAttribute('d')!;
    expect(d).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/);
    // The three finder patterns start with a run of 7 dark modules in the first row.
    expect(d.startsWith('M0 0h7v1h-7z')).toBe(true);
  });

  it('draws a different code for a different secret', () => {
    const { container, rerender } = render(<TotpQrCode uri={URI} />);
    const before = container.querySelector('path')!.getAttribute('d');
    rerender(<TotpQrCode uri={URI.replaceAll(SECRET, 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU')} />);
    expect(container.querySelector('path')!.getAttribute('d')).not.toBe(before);
  });
});

describe('TotpSecret', () => {
  it('shows the key in groups of four for typing it in', () => {
    render(<TotpSecret secret={SECRET} />);
    expect(screen.getByTestId('totp-secret')).toHaveTextContent('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
  });
});
