import { z } from 'zod';

/** Spec §12: passwords have at least 12 characters. */
export const PASSWORD_MIN_LENGTH = 12;

export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(256, 'Use at most 256 characters.');
/** An existing password being re-entered (no strength rules). */
export const currentPasswordSchema = z.string().min(1, 'Enter your password.').max(256);
export const totpCodeSchema = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app.');
export const totpSecretSchema = z.string().regex(/^[A-Z2-7]{32}$/, 'Invalid authenticator secret.');

export const setupTotpRequestSchema = z.object({ setupToken: z.string().min(1, 'Enter the setup token.').max(256) });

export const setupRequestSchema = z.object({
  setupToken: z.string().min(1, 'Enter the setup token.').max(256),
  password: newPasswordSchema,
  totpSecret: totpSecretSchema,
  totpCode: totpCodeSchema,
});

const recoveryCodeSchema = z.string().min(1).max(64);

export const loginRequestSchema = z
  .object({
    password: currentPasswordSchema,
    totpCode: totpCodeSchema.optional(),
    recoveryCode: recoveryCodeSchema.optional(),
  })
  .refine((body) => (body.totpCode === undefined) !== (body.recoveryCode === undefined), {
    message: 'Enter either a code from your authenticator app or a recovery code.',
  });

export const changePasswordRequestSchema = z.object({
  currentPassword: currentPasswordSchema,
  newPassword: newPasswordSchema,
  totpCode: totpCodeSchema,
});

/** Switching authenticators: the password and the current code (or a recovery code), then the new secret and its code. */
export const confirmTotpRequestSchema = z
  .object({
    currentPassword: currentPasswordSchema,
    currentTotpCode: totpCodeSchema.optional(),
    recoveryCode: recoveryCodeSchema.optional(),
    totpSecret: totpSecretSchema,
    totpCode: totpCodeSchema,
  })
  .refine((body) => (body.currentTotpCode === undefined) !== (body.recoveryCode === undefined), {
    message: 'Enter either a code from your current authenticator app or a recovery code.',
  });

export const reauthRequestSchema = z.object({
  currentPassword: currentPasswordSchema,
  totpCode: totpCodeSchema,
});

export type SetupRequest = z.infer<typeof setupRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
export type ConfirmTotpRequest = z.infer<typeof confirmTotpRequestSchema>;
export type ReauthRequest = z.infer<typeof reauthRequestSchema>;

export interface LoginResponse {
  /** How many unused recovery codes are left (the UI warns when it gets low). */
  recoveryCodesRemaining: number;
}

export interface AuthStatus {
  setupRequired: boolean;
  authenticated: boolean;
}

export interface TotpSecretResponse {
  secret: string;
  /** otpauth:// URI to render as a QR code. */
  uri: string;
}

export interface RecoveryCodesResponse {
  recoveryCodes: string[];
}
