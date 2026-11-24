import { createSign, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import type { Clock } from '../clock';
import type { EnableBankingConfig } from '../config';
import type { Logger } from '../logger';

/** Every call to Enable Banking must answer within 30 s (transaction reads go through to the bank). */
export const ENABLE_BANKING_TIMEOUT_MS = 30_000;
/** Guards against a continuation key that never ends. */
const MAX_PAGES = 100;
const JWT_TTL_S = 3600;
/** A JWT is reused until 5 minutes before it expires. */
const JWT_RENEW_BEFORE_S = 300;
const BANK_LIST_TTL_MS = 24 * 60 * 60 * 1000;
/** The error codes of a session that is over: its bank has to be reconnected. */
const SESSION_OVER = new Set(['EXPIRED_SESSION', 'REVOKED_SESSION', 'CLOSED_SESSION']);

/** A failed call: its HTTP status (0 without a usable answer) and Enable Banking's error code, e.g. EXPIRED_SESSION. */
export class EnableBankingError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'EnableBankingError';
  }

  /** A 401/403/422 saying the session has expired (or was revoked or closed). */
  get sessionExpired(): boolean {
    return [401, 403, 422].includes(this.status) && this.code !== null && SESSION_OVER.has(this.code);
  }
}

/** A bank (ASPSP) a session can be started with. */
export interface Aspsp {
  name: string;
  country: string;
  /** In seconds. */
  maximumConsentValidity: number | null;
}

export interface SessionAccount {
  uid: string;
  iban: string | null;
  name: string;
  currency: string;
}

export interface Session {
  sessionId: string;
  aspsp: { name: string; country: string };
  validUntil: Date;
  accounts: SessionAccount[];
}

const text = z.string().nullish();
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/)
  .transform((date) => date.slice(0, 10))
  .nullish();
const party = z.looseObject({ name: text }).nullish();

const aspspSchema = z.looseObject({
  name: z.string().min(1),
  country: z.string().min(1),
  maximum_consent_validity: z.number().int().positive().nullish(),
  psu_types: z.array(z.string()).nullish(),
});

const accountSchema = z
  .looseObject({
    uid: z.string().min(1),
    account_id: z.looseObject({ iban: text }).nullish(),
    // `name` is the account holder's; `details` and `product` describe the account.
    name: text,
    details: text,
    product: text,
    currency: z.string().min(1),
  })
  .transform((a): SessionAccount => {
    const iban = a.account_id?.iban?.replace(/\s+/g, '') || null;
    return {
      uid: a.uid,
      iban,
      name: a.details?.trim() || a.product?.trim() || a.name?.trim() || iban || a.uid,
      currency: a.currency.toUpperCase(),
    };
  });

const transactionSchema = z.looseObject({
  entry_reference: text,
  transaction_id: text,
  transaction_amount: z.looseObject({ currency: z.string(), amount: z.string().regex(/^[-+]?\d+(\.\d+)?$/) }),
  credit_debit_indicator: z.enum(['CRDT', 'DBIT']),
  status: z.string(),
  booking_date: isoDate,
  value_date: isoDate,
  transaction_date: isoDate,
  creditor: party,
  debtor: party,
  remittance_information: z.array(z.string()).nullish(),
});

/** A transaction as Enable Banking sends it (only the fields the sync reads). */
export type BankTransaction = z.infer<typeof transactionSchema>;

const errorSchema = z.looseObject({ message: text, error: text });
const aspspList = z.looseObject({ aspsps: z.array(z.unknown()) });
const authResponse = z.looseObject({ url: z.url({ protocol: /^https?$/ }) });
const sessionResponse = z.looseObject({
  session_id: z.string().min(1),
  accounts: z.array(z.unknown()),
  aspsp: z.looseObject({ name: z.string().min(1), country: z.string().min(1) }),
  access: z.looseObject({ valid_until: z.string().refine((at) => !Number.isNaN(Date.parse(at))) }),
});
const transactionPage = z.looseObject({ transactions: z.array(z.unknown()), continuation_key: text });

const keysOf = (value: unknown) => (typeof value === 'object' && value !== null ? Object.keys(value) : typeof value);
const issuesOf = (error: z.ZodError) => error.issues.map((issue) => issue.path.join('.'));
const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** The application's JWT (RS256, `kid` = the application id), valid for an hour from `iat` (seconds). */
export function signJwt(appId: string, privateKey: KeyObject, iat: number): string {
  const header = base64url({ typ: 'JWT', alg: 'RS256', kid: appId });
  const payload = base64url({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat, exp: iat + JWT_TTL_S });
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

/** The Enable Banking API. The key and the JWTs are never logged. */
export function enableBankingClient(
  config: EnableBankingConfig,
  logger: Logger,
  clock: Clock,
  timeoutMs = ENABLE_BANKING_TIMEOUT_MS,
) {
  let jwt: { token: string; renewAt: number } | null = null;
  const banks = new Map<string, { until: number; list: Aspsp[] }>();

  function authorization(): string {
    const now = Math.floor(clock.now().getTime() / 1000);
    if (!jwt || now >= jwt.renewAt) {
      jwt = { token: signJwt(config.appId, config.privateKey, now), renewAt: now + JWT_TTL_S - JWT_RENEW_BEFORE_S };
    }
    return `Bearer ${jwt.token}`;
  }

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${config.baseUrl}${path}`, {
        method,
        headers: {
          authorization: authorization(),
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new EnableBankingError(0, null, `Enable Banking is unreachable (${(err as Error).name})`);
    }
    if (!res.ok) {
      const problem = errorSchema.safeParse(await res.json().catch(() => null));
      const code = (problem.success && problem.data.error) || null;
      const message = (problem.success && problem.data.message?.slice(0, 200)) || '';
      throw new EnableBankingError(
        res.status,
        code,
        `Enable Banking answered ${res.status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`,
      );
    }
    return res.json().catch(() => {
      throw new EnableBankingError(0, null, 'Enable Banking answered with something other than JSON');
    });
  }

  /** The answer, if it has the expected shape; otherwise only its keys are logged. */
  function parse<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
    const parsed = schema.safeParse(body);
    if (parsed.success) return parsed.data;
    logger.warn({ keys: keysOf(body), issues: issuesOf(parsed.error) }, `unexpected Enable Banking ${what}`);
    throw new EnableBankingError(0, null, `Unexpected ${what} from Enable Banking`);
  }

  /** The items of a list that parse; the others are logged and skipped. */
  function items<T>(schema: z.ZodType<T>, list: unknown[], what: string): T[] {
    return list.flatMap((item) => {
      const parsed = schema.safeParse(item);
      if (parsed.success) return [parsed.data];
      logger.warn({ keys: keysOf(item), issues: issuesOf(parsed.error) }, `skipped an unexpected Enable Banking ${what}`);
      return [];
    });
  }

  return {
    /** The country's banks for personal customers, by name; kept for 24 hours. */
    async aspsps(country: string): Promise<Aspsp[]> {
      const now = clock.now().getTime();
      const cached = banks.get(country);
      if (cached && now < cached.until) return cached.list;
      const { aspsps } = parse(aspspList, await call('GET', `/aspsps?country=${encodeURIComponent(country)}`), 'bank list');
      const list = items(aspspSchema, aspsps, 'bank')
        .filter((a) => !a.psu_types || a.psu_types.includes('personal'))
        .map((a) => ({
          name: a.name,
          country: a.country,
          maximumConsentValidity: a.maximum_consent_validity ?? null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'pl'));
      banks.set(country, { until: now + BANK_LIST_TTL_MS, list });
      return list;
    },

    /** Starts the bank's consent; returns where to send the browser. The bank comes back with `code` and `state`. */
    async startAuthorization(aspsp: { name: string; country: string }, validUntil: Date, state: string): Promise<string> {
      const body = {
        access: { valid_until: validUntil.toISOString() },
        aspsp: { name: aspsp.name, country: aspsp.country },
        state,
        redirect_url: config.redirectUri,
        psu_type: 'personal',
      };
      return parse(authResponse, await call('POST', '/auth', body), 'authorization').url;
    },

    /** Turns the code from the bank's redirect into a session and the accounts it covers. */
    async createSession(code: string): Promise<Session> {
      const session = parse(sessionResponse, await call('POST', '/sessions', { code }), 'session');
      return {
        sessionId: session.session_id,
        aspsp: { name: session.aspsp.name, country: session.aspsp.country },
        validUntil: new Date(session.access.valid_until),
        accounts: items(accountSchema, session.accounts, 'account'),
      };
    },

    /** Every transaction of the account between two dates (inclusive), all pages. */
    async transactions(uid: string, dateFrom: string, dateTo: string): Promise<BankTransaction[]> {
      const all: BankTransaction[] = [];
      let continuationKey: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const query = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
        if (continuationKey) query.set('continuation_key', continuationKey);
        const body = await call('GET', `/accounts/${encodeURIComponent(uid)}/transactions?${query}`);
        const result = parse(transactionPage, body, 'transaction list');
        all.push(...items(transactionSchema, result.transactions, 'transaction'));
        continuationKey = result.continuation_key || null;
        if (!continuationKey) return all;
      }
      throw new EnableBankingError(0, null, 'Enable Banking sent too many pages of transactions');
    },

    async deleteSession(sessionId: string): Promise<void> {
      await call('DELETE', `/sessions/${encodeURIComponent(sessionId)}`);
    },
  };
}

export type EnableBankingClient = ReturnType<typeof enableBankingClient>;
