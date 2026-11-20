import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const EnvSchema = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\/.+/, 'must be a postgres:// connection URL'),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[A-Za-z0-9+/]{43}=$/, 'must be 32 random bytes, base64-encoded (openssl rand -base64 32)'),
  SETUP_TOKEN: z.string().min(16, 'must be at least 16 characters'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TZ: z.string().default('Europe/Warsaw').refine(isValidTimeZone, 'must be an IANA time zone, e.g. Europe/Warsaw'),
  COOKIE_SECURE: booleanString.default(true),
  TRUST_PROXY: booleanString.default(false),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  MIGRATIONS_DIR: z.string().default('drizzle'),
});

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  databaseUrl: string;
  /** 32-byte AES-256-GCM key for secrets at rest (the TOTP secret). */
  encryptionKey: Buffer;
  setupToken: string;
  port: number;
  /** IANA zone that defines "today" and month boundaries. */
  timeZone: string;
  /** Set the Secure flag on the session cookie (disable only for plain-http local development). */
  cookieSecure: boolean;
  /** Take the client IP from X-Forwarded-For (only behind a trusted reverse proxy). */
  trustProxy: boolean;
  logLevel: LogLevel;
  migrationsDir: string;
}

/** Parses and validates the process environment; throws one error listing every invalid variable. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    encryptionKey: Buffer.from(e.ENCRYPTION_KEY, 'base64'),
    setupToken: e.SETUP_TOKEN,
    port: e.PORT,
    timeZone: e.TZ,
    cookieSecure: e.COOKIE_SECURE,
    trustProxy: e.TRUST_PROXY,
    logLevel: e.LOG_LEVEL,
    migrationsDir: e.MIGRATIONS_DIR,
  };
}
