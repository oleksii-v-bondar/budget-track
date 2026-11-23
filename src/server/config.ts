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
  APP_USERNAME: z.string().min(1, 'must be set'),
  APP_PASSWORD: z.string().min(1, 'must be set'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TZ: z.string().default('Europe/Warsaw').refine(isValidTimeZone, 'must be an IANA time zone, e.g. Europe/Warsaw'),
  COOKIE_SECURE: booleanString.default(true),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  MIGRATIONS_DIR: z.string().default('drizzle'),
  NBP_BASE_URL: z
    .url({ protocol: /^https?$/, error: 'must be an http(s) URL, e.g. https://api.nbp.pl' })
    .default('https://api.nbp.pl')
    .transform((url) => url.replace(/\/+$/, '')),
  WEB_DIR: z.string().default('dist/web'),
  AIIA_CLIENT_ID: z.string().optional(),
  AIIA_CLIENT_SECRET: z.string().optional(),
  AIIA_BASE_URL: z
    .url({ protocol: /^https?$/, error: 'must be an http(s) URL, e.g. https://api.aiia.eu' })
    .default('https://api.aiia.eu')
    .transform((url) => url.replace(/\/+$/, '')),
  AIIA_REDIRECT_URI: z
    .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
    .default('http://localhost:3080/api/bank/callback'),
});

/** Mastercard Open Banking (the Aiia Data API) for bank sync. */
export interface AiiaConfig {
  clientId: string;
  clientSecret: string;
  /** e.g. https://api.aiia.eu (no trailing slash). */
  baseUrl: string;
  /** Where Aiia sends the browser back to: this server's /api/bank/callback, registered in the Aiia console. */
  redirectUri: string;
}

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  databaseUrl: string;
  /** The one user's sign-in name and password. */
  appUsername: string;
  appPassword: string;
  port: number;
  /** IANA zone that defines "today" and month boundaries. */
  timeZone: string;
  /** Set the Secure flag on the session cookie (disable only for plain-http local development). */
  cookieSecure: boolean;
  logLevel: LogLevel;
  migrationsDir: string;
  /** Origin of the NBP exchange-rate API (spec §9), without a trailing slash. */
  nbpBaseUrl: string;
  /** The built web app (`npm run build:web`), served for every non-/api path. */
  webDir: string;
  /** Bank sync; null (feature off) unless both AIIA_CLIENT_ID and AIIA_CLIENT_SECRET are set. */
  aiia: AiiaConfig | null;
}

/** Parses and validates the process environment; throws one error listing every invalid variable. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    appUsername: e.APP_USERNAME,
    appPassword: e.APP_PASSWORD,
    port: e.PORT,
    timeZone: e.TZ,
    cookieSecure: e.COOKIE_SECURE,
    logLevel: e.LOG_LEVEL,
    migrationsDir: e.MIGRATIONS_DIR,
    nbpBaseUrl: e.NBP_BASE_URL,
    webDir: e.WEB_DIR,
    aiia:
      e.AIIA_CLIENT_ID && e.AIIA_CLIENT_SECRET
        ? {
            clientId: e.AIIA_CLIENT_ID,
            clientSecret: e.AIIA_CLIENT_SECRET,
            baseUrl: e.AIIA_BASE_URL,
            redirectUri: e.AIIA_REDIRECT_URI,
          }
        : null,
  };
}
