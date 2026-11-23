import { z } from 'zod';

export const loginRequestSchema = z.object({
  username: z.string().min(1, 'Enter your username.').max(256, 'Use at most 256 characters.'),
  password: z.string().min(1, 'Enter your password.').max(256, 'Use at most 256 characters.'),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export interface AuthStatus {
  authenticated: boolean;
}
