import { z } from 'zod';
import type { AiiaConfig } from '../config';
import type { Logger } from '../logger';

/** Every call to Aiia must answer within 15 s. */
export const AIIA_TIMEOUT_MS = 15_000;
/** Guards against a paging token that never ends. */
const MAX_PAGES = 100;

/** A failed call to Aiia: its HTTP status, or 0 without a usable answer (network error, timeout, unexpected body). */
export class AiiaError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AiiaError';
  }
}

export interface AiiaTokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds the access token lives (Aiia: one hour). */
  expiresIn: number;
}

export interface AiiaAccount {
  id: string;
  name: string;
  currency: string | null;
  providerName: string | null;
}

export interface AiiaTransaction {
  /** Unique within its account. */
  id: string;
  /** The booking date, 'YYYY-MM-DD'. */
  date: string;
  text: string | null;
  /** In major units, e.g. -12.5. */
  amount: number;
  currency: string | null;
  /** 'Booked', 'Reserved', 'Scheduled', … */
  state: string;
}

// The field names aren't certain, so the schemas let unknown keys through and try the known variants.
const decimal = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/).transform(Number)]);
const money = z.looseObject({ value: decimal, currency: z.string().nullish() });
const text = z.string().nullish();

const tokenSchema = z
  .looseObject({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    expires_in: z.number().positive().default(3600),
  })
  .transform((t): AiiaTokens => ({ accessToken: t.access_token, refreshToken: t.refresh_token, expiresIn: t.expires_in }));

const accountSchema = z
  .looseObject({
    id: z.string().min(1),
    name: text,
    currency: text,
    booked: money.nullish(),
    available: money.nullish(),
    bookedBalance: z.union([money, decimal]).nullish(),
    provider: z.looseObject({ name: text }).nullish(),
  })
  .transform(
    (a): AiiaAccount => ({
      id: a.id,
      name: a.name?.trim() || a.id,
      currency:
        a.currency ??
        a.booked?.currency ??
        a.available?.currency ??
        (typeof a.bookedBalance === 'object' ? a.bookedBalance?.currency : null) ??
        null,
      providerName: a.provider?.name ?? null,
    }),
  );

const transactionSchema = z
  .looseObject({
    id: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
    text,
    description: text,
    originalText: text,
    amount: z.union([decimal, money]),
    currency: text,
    state: text,
  })
  .transform(
    (t): AiiaTransaction => ({
      id: t.id,
      date: t.date.slice(0, 10),
      text: (t.text || t.description || t.originalText)?.trim() || null,
      amount: typeof t.amount === 'number' ? t.amount : t.amount.value,
      currency: (typeof t.amount === 'number' ? null : t.amount.currency) ?? t.currency ?? null,
      // Aiia gives every transaction a state; one without is taken as booked.
      state: t.state ?? 'Booked',
    }),
  );

const keysOf = (value: unknown) => (typeof value === 'object' && value !== null ? Object.keys(value) : typeof value);
const issuesOf = (error: z.ZodError) => error.issues.map((issue) => issue.path.join('.'));

/** The Aiia Data API (Mastercard Open Banking). Tokens and the client secret are never logged. */
export function aiiaClient(config: AiiaConfig, logger: Logger, timeoutMs = AIIA_TIMEOUT_MS) {
  const basic = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;

  async function call(path: string, authorization: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${config.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization, accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new AiiaError(0, `Aiia is unreachable (${(err as Error).name})`);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new AiiaError(res.status, `Aiia answered ${res.status}`);
    }
    return res.json().catch(() => {
      throw new AiiaError(0, 'Aiia answered with something other than JSON');
    });
  }

  /** The answer, if it has the expected shape; otherwise its keys are logged (never its values: they may be tokens). */
  function parse<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
    const parsed = schema.safeParse(body);
    if (parsed.success) return parsed.data;
    logger.warn({ keys: keysOf(body), issues: issuesOf(parsed.error) }, `unexpected Aiia ${what}`);
    throw new AiiaError(0, `Unexpected ${what} from Aiia`);
  }

  /** The items of a list that parse; the others are logged and skipped. */
  function items<T>(schema: z.ZodType<T>, list: unknown[], what: string): T[] {
    return list.flatMap((item) => {
      const parsed = schema.safeParse(item);
      if (parsed.success) return [parsed.data];
      logger.warn({ keys: keysOf(item), issues: issuesOf(parsed.error) }, `skipped an unexpected Aiia ${what}`);
      return [];
    });
  }

  const token = async (body: Record<string, string>) =>
    parse(tokenSchema, await call('/v1/oauth/token', basic, body), 'token');
  const accountList = z.looseObject({ accounts: z.array(z.unknown()) });
  const transactionPage = z.looseObject({ transactions: z.array(z.unknown()), pagingToken: text });

  return {
    /** Where the browser goes to consent; Aiia sends it back to the redirect URI with `code` and `state`. */
    connectUrl(state: string): string {
      const query = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        scope: 'accounts offline_access',
        response_type: 'code',
        state,
      });
      return `${config.baseUrl}/v1/oauth/connect?${query.toString().replace(/\+/g, '%20')}`;
    },

    exchangeCode: (code: string): Promise<AiiaTokens> =>
      token({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri }),

    /** A new token pair; the refresh token sent is spent. */
    refresh: (refreshToken: string): Promise<AiiaTokens> =>
      token({ grant_type: 'refresh_token', refresh_token: refreshToken }),

    async accounts(accessToken: string): Promise<AiiaAccount[]> {
      const { accounts } = parse(accountList, await call('/v1/accounts', `Bearer ${accessToken}`), 'account list');
      return items(accountSchema, accounts, 'account');
    },

    /** Every transaction of the account between two ISO instants, all pages. */
    async transactions(accessToken: string, accountId: string, from: string, to: string): Promise<AiiaTransaction[]> {
      const path = `/v1/accounts/${encodeURIComponent(accountId)}/transactions/query`;
      const all: AiiaTransaction[] = [];
      let pagingToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const body = await call(path, `Bearer ${accessToken}`, { interval: `${from}/${to}`, pageSize: 100, pagingToken });
        const result = parse(transactionPage, body, 'transaction list');
        all.push(...items(transactionSchema, result.transactions, 'transaction'));
        pagingToken = result.pagingToken || undefined;
        if (!pagingToken) break;
      }
      return all;
    },
  };
}

export type AiiaClient = ReturnType<typeof aiiaClient>;
