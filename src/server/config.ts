import { createPrivateKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  ENABLE_BANKING_APP_ID: z.string().trim().optional(),
  ENABLE_BANKING_KEY_FILE: z
    .string()
    .optional()
    .transform((path) => path || './secrets/enablebanking.pem'),
  BANK_REDIRECT_URI: z
    .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
    .default('http://localhost:3080/api/bank/callback'),
});

/** The same for sandbox and production applications: the application decides which. */
export const ENABLE_BANKING_API = 'https://api.enablebanking.com';

/** Enable Banking (open banking API) for bank sync. */
export interface EnableBankingConfig {
  /** The application id: the JWT's `kid`. */
  appId: string;
  /** The application's private key (RS256). Never log it, nor the JWTs it signs. */
  privateKey: KeyObject;
  /** The API's origin, without a trailing slash (tests point it at a stub). */
  baseUrl: string;
  /** Where the bank sends the browser back to: this server's /api/bank/callback, registered with the application. */
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
  /** Bank sync; null (feature off) unless ENABLE_BANKING_APP_ID is set and ENABLE_BANKING_KEY_FILE holds a key. */
  enableBanking: EnableBankingConfig | null;
}

/**
 * Parses and validates the process environment; throws one error listing every invalid variable. `readFile` reads
 * the Enable Banking key file (injected for tests).
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): Config {
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
    enableBanking: enableBanking(e, readFile),
  };
}

/** Enable Banking, if ENABLE_BANKING_APP_ID is set and ENABLE_BANKING_KEY_FILE holds a private key; otherwise off. */
function enableBanking(
  e: z.infer<typeof EnvSchema>,
  readFile: (path: string) => string,
): EnableBankingConfig | null {
  if (!e.ENABLE_BANKING_APP_ID) return null;
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(readFile(e.ENABLE_BANKING_KEY_FILE));
  } catch {
    // Missing, unreadable or not a private key.
    return null;
  }
  return { appId: e.ENABLE_BANKING_APP_ID, privateKey, baseUrl: ENABLE_BANKING_API, redirectUri: e.BANK_REDIRECT_URI };
}
