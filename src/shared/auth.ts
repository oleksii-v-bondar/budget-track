import { z } from 'zod';

/** Spec §12: passwords have at least 12 characters. */
export const PASSWORD_MIN_LENGTH = 12;

export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(256, 'Use at most 256 characters.');
/** An existing password being re-entered (no strength rules). */
export const currentPasswordSchema = z.string().min(1, 'Enter your password.').max(256, 'Use at most 256 characters.');
export const totpCodeSchema = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app.');
export const totpSecretSchema = z.string().regex(/^[A-Z2-7]{32}$/, 'Invalid authenticator secret.');

const setupTokenSchema = z.string().min(1, 'Enter the setup token.').max(256, 'That setup token is too long.');

/** First-run setup sets only the password: the authenticator app is off until the owner turns it on in Settings. */
export const setupRequestSchema = z.object({
  setupToken: setupTokenSchema,
  password: newPasswordSchema,
});

const recoveryCodeSchema = z.string().min(1, 'Enter a recovery code.').max(64, 'That recovery code is too long.');

const ONE_FACTOR = 'Enter either a code from your authenticator app or a recovery code.';

/**
 * The password, plus (only while an authenticator is on) an authenticator code or a recovery code. Without an
 * authenticator, a code sent is ignored; with one, sending neither is 422 `code_required`.
 */
export const loginRequestSchema = z
  .object({
    password: currentPasswordSchema,
    totpCode: totpCodeSchema.optional(),
    recoveryCode: recoveryCodeSchema.optional(),
  })
  .refine((body) => body.totpCode === undefined || body.recoveryCode === undefined, { message: ONE_FACTOR });

/** The authenticator code is needed (and checked) only while an authenticator is on. */
export const changePasswordRequestSchema = z.object({
  currentPassword: currentPasswordSchema,
  newPassword: newPasswordSchema,
  totpCode: totpCodeSchema.optional(),
});

/**
 * Turning the authenticator on (the password, the new secret and a code from it) or replacing it (also the current
 * code or a recovery code).
 */
export const confirmTotpRequestSchema = z
  .object({
    currentPassword: currentPasswordSchema,
    currentTotpCode: totpCodeSchema.optional(),
    recoveryCode: recoveryCodeSchema.optional(),
    totpSecret: totpSecretSchema,
    totpCode: totpCodeSchema,
  })
  .refine((body) => body.currentTotpCode === undefined || body.recoveryCode === undefined, {
    message: 'Enter either a code from your current authenticator app or a recovery code.',
  });

/** Turning the authenticator off: the password and the current code or a recovery code. */
export const disableTotpRequestSchema = z
  .object({
    currentPassword: currentPasswordSchema,
    totpCode: totpCodeSchema.optional(),
    recoveryCode: recoveryCodeSchema.optional(),
  })
  .refine((body) => (body.totpCode === undefined) !== (body.recoveryCode === undefined), { message: ONE_FACTOR });

/** The authenticator code is needed (and checked) only while an authenticator is on. */
export const reauthRequestSchema = z.object({
  currentPassword: currentPasswordSchema,
  totpCode: totpCodeSchema.optional(),
});

export type SetupRequest = z.infer<typeof setupRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
export type ConfirmTotpRequest = z.infer<typeof confirmTotpRequestSchema>;
export type DisableTotpRequest = z.infer<typeof disableTotpRequestSchema>;
export type ReauthRequest = z.infer<typeof reauthRequestSchema>;

export interface LoginResponse {
  /** Whether sign-in needed a code (the owner has turned on an authenticator app). */
  authenticatorEnabled: boolean;
  /** How many unused recovery codes are left (the UI warns when it gets low); 0 without an authenticator. */
  recoveryCodesRemaining: number;
}

export interface AuthStatus {
  setupRequired: boolean;
  authenticated: boolean;
  /** Whether sign-in asks for an authenticator code (off by default). Public: the sign-in page needs it. */
  authenticatorEnabled: boolean;
}

export interface TotpSecretResponse {
  secret: string;
  /** otpauth:// URI to render as a QR code. */
  uri: string;
}

export interface RecoveryCodesResponse {
  recoveryCodes: string[];
}

/**
 * `POST /api/auth/totp`. Turning the authenticator on also returns the ten new recovery codes (shown once); replacing
 * it keeps the existing codes and returns `{ ok: true }` only.
 */
export interface ConfirmTotpResponse {
  ok: true;
  recoveryCodes?: string[];
}
