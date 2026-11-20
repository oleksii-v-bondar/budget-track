# P2a — Server Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secured, containerised API server: the full Postgres schema with migrations and the ledger view, a Testcontainers test harness, a Hono app with error mapping, security headers, CSRF guard and `/healthz`, and complete authentication (first-run setup, password + TOTP + recovery codes, sessions, rate limiting/lockout, security settings), plus a Dockerfile and docker-compose.

**Architecture:** `src/server` is a Hono app built by `createApp(deps)` from injected dependencies (Drizzle `db`, `config`, `clock`, `logger`, `clientIp`), so every test runs it in-process with `app.request()` against a real Postgres database cloned from a migrated template. Auth state lives in Postgres (`app_user`, `session`, `login_attempt`). `src/shared` holds code used by both server and the future web app (zod request schemas, account-class mapping, API error shape). The engine from P1 is untouched apart from stricter purity lint rules.

**Tech Stack:** Node 22, TypeScript 6, Hono 4 + @hono/node-server 2 + @hono/zod-validator, zod 4, Drizzle ORM 0.45 + drizzle-kit 0.31, postgres.js 4, Postgres 16, pino 10, @node-rs/argon2 2, otplib 13, Vitest 5 (projects), @testcontainers/postgresql 11, esbuild, tsx, Docker.

**Spec:** `docs/superpowers/specs/2026-11-19-core-budgeting-design.md` (§2, §4, §12, §13, §14 "Server", §15). Plan P2a is the first of three server plans (P2a foundation → P2b ledger core → P2c workflows).

## Global Constraints

- Node `>=22`, npm, ESM. This machine has Node 22.14, so `@testcontainers/postgresql` must stay on `^11.14` (v12 pulls undici 8, which needs Node ≥ 22.19).
- TypeScript `strict` + `noUncheckedIndexedAccess`; `npm test`, `npm run typecheck` and `npm run lint` pass at the end of every task.
- Money is integer minor units: `bigint` columns in `mode: 'number'`; int8 values outside ±2^53 must throw, never lose precision.
- Calendar dates are `date` columns in `mode: 'string'` (`'YYYY-MM-DD'`); months are stored as the first day of the month (`'YYYY-MM-01'`).
- `src/engine/**` stays pure (no I/O, no Node modules, no `Date.now()`/`new Date()`/`Math.random()`); server code may use Node APIs.
- Error responses (spec §13): validation → 400 `{ code: "validation", message, fieldErrors, formErrors }`; `DomainError` → 422 `{ code, message }`; no session → 401 `unauthorized`; rate limited/locked → 429; unexpected → 500 `{ code: "internal", message: "Something went wrong.", requestId }`.
- Every mutating `/api` request must carry `X-Requested-With: budget-track` (403 `csrf` otherwise).
- Session cookie `bt_session`: HttpOnly, Secure (unless `COOKIE_SECURE=false`), SameSite=Strict, Path=/, 30-day sliding expiry; only the SHA-256 of the token is stored.
- Login limits: 5 attempts per minute per IP; 10 consecutive failures lock sign-in for 15 minutes.
- TOTP: 30-second step, ±1 step tolerance; 10 single-use recovery codes stored as argon2 hashes; passwords ≥ 12 characters, argon2id.
- "Today" and month boundaries use the configured `TZ` (default `Europe/Warsaw`) via an injected `Clock`.
- Testcontainers runs with Ryuk disabled (Docker Desktop's Enhanced Container Isolation blocks it); the global teardown stops the container.
- Every commit message ends with the trailer `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.

## File Structure

```
src/shared/accounts.ts        account types, accountClassOf, isLoanType, ACCOUNT_CLASS_SQL
src/shared/http.ts            CSRF header constants, ApiErrorBody
src/shared/auth.ts            zod request schemas + response types for auth endpoints
src/server/config.ts          env → Config (zod)
src/server/clock.ts           Clock, systemClock, todayIn, monthIn
src/server/logger.ts          pino factory
src/server/main.ts            entrypoint: config → migrate → serve, graceful shutdown
src/server/db/schema.ts       Drizzle tables, enums, ledgerLine view
src/server/db/client.ts       createDatabase (int8 parser), Db/Tx/Executor types
src/server/db/migrate.ts      runMigrations
src/server/db/seed.ts         seedBudget (system groups/categories)
src/server/db/errors.ts       isUniqueViolation
src/server/http/app.ts        createApp(deps), AppDeps, App
src/server/http/env.ts        AppEnv (context variables)
src/server/http/errors.ts     AppError, DomainError, ValidationError, errorHandler
src/server/http/validate.ts   validate(target, schema)
src/server/http/middleware.ts csrfGuard, requestLogger
src/server/http/client-ip.ts  clientIpResolver
src/server/auth/*.ts          secret-box, passwords, totp, recovery-codes, sessions, rate-limit, user,
                              setup-routes, login-routes, security-routes
src/server/test/*.ts          test harness: global-setup, db, pg-url, config, app, http-client, fake-clock, totp, auth
drizzle/                      0000_init.sql (generated), 0001_ledger_view.sql (custom), meta/
drizzle.config.ts, Dockerfile, .dockerignore, docker-compose.yml, .env.example, README.md
```

---

### Task 1: Server tooling, configuration and clock

**Files:**
- Modify: `package.json` (dependencies, scripts), `vitest.config.ts`, `eslint.config.js`
- Create: `src/server/config.ts`, `src/server/clock.ts`, `src/server/test/fake-clock.ts`
- Test: `src/server/config.test.ts`, `src/server/clock.test.ts`

**Interfaces:**
- Consumes: `IsoDate`, `Month` from `src/engine`.
- Produces:
  - `loadConfig(env?): Config` with `Config { databaseUrl; encryptionKey: Buffer; setupToken; port; timeZone; cookieSecure; trustProxy; logLevel: LogLevel; migrationsDir }`
  - `Clock { now(): Date }`, `systemClock`, `todayIn(timeZone, instant): IsoDate`, `monthIn(timeZone, instant): Month`
  - test helper `FakeClock(start)` with `now()` and `advance(ms)`
  - Vitest projects `engine` and `server`; scripts `test:engine`, `test:server`

- [ ] **Step 1: Install the server dependencies**

```bash
npm install hono@^4.13 @hono/node-server@^2.1 @hono/zod-validator@^0.9 zod@^4.6 drizzle-orm@^0.45 postgres@^4.1 pino@^10.4 @node-rs/argon2@^2.2 otplib@^13.6
npm install -D drizzle-kit@^0.31 @testcontainers/postgresql@^11.14 tsx@^4.23 esbuild@^0.28
```

Expected: both finish without errors (`npm audit` reports moderate advisories in Testcontainers' dev-only dependencies; leave them).

- [ ] **Step 2: Add test scripts.** In `package.json`, make `"scripts"` read:

```json
{
  "test": "vitest run",
  "test:engine": "vitest run --project engine",
  "test:server": "vitest run --project server",
  "test:watch": "vitest",
  "typecheck": "tsc --noEmit",
  "lint": "eslint ."
}
```

- [ ] **Step 3: Split Vitest into an `engine` and a `server` project.** Replace `vitest.config.ts` with:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'engine', include: ['src/engine/**/*.test.ts'] } },
      {
        test: {
          name: 'server',
          include: ['src/server/**/*.test.ts', 'src/shared/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
```

- [ ] **Step 4: Tighten the engine purity rules (P2 carry-over).** Replace `eslint.config.js` with:

```js
import { builtinModules } from 'node:module';
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const engineGlobalsMessage = 'src/engine must stay pure: no I/O or runtime globals.';
const engineDeterminismMessage = 'src/engine must be deterministic: pass time and randomness in as arguments.';

export default defineConfig(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Only paths that leave the current directory and enter server/ or web/;
              // same-directory engine modules such as './web' stay allowed.
              regex: '^(?:\\.{1,2}/)*\\.\\./(?:[^/]+/)*(?:server|web)(?:/|$)',
              message: 'src/engine must stay pure: no imports from server/ or web/.',
            },
            {
              regex: `^(node:|(?:${builtinModules.join('|')})(?:/|$))`,
              message: 'src/engine must stay pure: no I/O modules.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...[
          'process',
          'fetch',
          'Buffer',
          'require',
          '__dirname',
          '__filename',
          'setTimeout',
          'setInterval',
          'XMLHttpRequest',
        ].map((name) => ({ name, message: engineGlobalsMessage })),
      ],
      'no-restricted-syntax': [
        'error',
        { selector: 'ImportExpression', message: 'src/engine must stay pure: no dynamic import().' },
        { selector: "MemberExpression[object.name='globalThis']", message: engineGlobalsMessage },
        { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: engineDeterminismMessage },
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: engineDeterminismMessage },
        { selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']", message: engineDeterminismMessage },
      ],
    },
  },
);
```

- [ ] **Step 5: Verify the new lint rules**

Run:
```bash
printf "export const a = () => import('./x');\nexport const b = globalThis.process;\nexport const c = Date.now();\nexport const d = new Date();\nexport const e = Math.random();\nexport const f = new Date(Date.UTC(2026, 0, 1));\n" > src/engine/determinism-check.ts
npx eslint src/engine/determinism-check.ts; rm src/engine/determinism-check.ts
```
Expected: exactly 5 `no-restricted-syntax` errors (lines 1–5); line 6 is allowed. Then `npm run lint` exits 0.

- [ ] **Step 6: Write the failing tests**

`src/server/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const KEY = Buffer.alloc(32, 7).toString('base64');

const validEnv = {
  DATABASE_URL: 'postgres://budget:secret@localhost:5432/budget',
  ENCRYPTION_KEY: KEY,
  SETUP_TOKEN: 'a-long-setup-token-123',
};

describe('loadConfig', () => {
  it('applies defaults for optional variables', () => {
    const config = loadConfig(validEnv);
    expect(config).toMatchObject({
      databaseUrl: validEnv.DATABASE_URL,
      setupToken: validEnv.SETUP_TOKEN,
      port: 3000,
      timeZone: 'Europe/Warsaw',
      cookieSecure: true,
      trustProxy: false,
      logLevel: 'info',
      migrationsDir: 'drizzle',
    });
    expect(config.encryptionKey).toEqual(Buffer.alloc(32, 7));
  });

  it('parses explicit values', () => {
    const config = loadConfig({
      ...validEnv,
      PORT: '8080',
      TZ: 'UTC',
      COOKIE_SECURE: 'false',
      TRUST_PROXY: 'true',
      LOG_LEVEL: 'silent',
      MIGRATIONS_DIR: '/app/drizzle',
    });
    expect(config).toMatchObject({
      port: 8080,
      timeZone: 'UTC',
      cookieSecure: false,
      trustProxy: true,
      logLevel: 'silent',
      migrationsDir: '/app/drizzle',
    });
  });

  it('lists every invalid variable in one error', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*ENCRYPTION_KEY[\s\S]*SETUP_TOKEN/);
  });

  it('rejects keys that are not exactly 32 bytes of base64', () => {
    const short = Buffer.alloc(16, 1).toString('base64');
    expect(() => loadConfig({ ...validEnv, ENCRYPTION_KEY: short })).toThrow('ENCRYPTION_KEY');
  });

  it('rejects unknown time zones, short setup tokens and bad booleans', () => {
    expect(() => loadConfig({ ...validEnv, TZ: 'Mars/Olympus' })).toThrow('TZ');
    expect(() => loadConfig({ ...validEnv, SETUP_TOKEN: 'short' })).toThrow('SETUP_TOKEN');
    expect(() => loadConfig({ ...validEnv, COOKIE_SECURE: 'yes' })).toThrow('COOKIE_SECURE');
  });
});
```

`src/server/clock.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { monthIn, todayIn } from './clock';
import { FakeClock } from './test/fake-clock';

describe('todayIn / monthIn', () => {
  it('uses the configured zone, not UTC', () => {
    const lateNewYearsEveUtc = new Date('2026-12-31T23:30:00Z');
    expect(todayIn('Europe/Warsaw', lateNewYearsEveUtc)).toBe('2027-01-01');
    expect(todayIn('UTC', lateNewYearsEveUtc)).toBe('2026-12-31');
    expect(monthIn('Europe/Warsaw', lateNewYearsEveUtc)).toBe('2027-01');
  });

  it('handles daylight-saving transitions', () => {
    expect(todayIn('Europe/Warsaw', new Date('2026-03-29T00:30:00Z'))).toBe('2026-03-29');
    expect(todayIn('Europe/Warsaw', new Date('2026-10-24T22:30:00Z'))).toBe('2026-10-25');
  });
});

describe('FakeClock', () => {
  it('returns a fixed instant and advances on demand', () => {
    const clock = new FakeClock('2026-11-20T10:00:00Z');
    expect(clock.now().toISOString()).toBe('2026-11-20T10:00:00.000Z');
    clock.advance(90_000);
    expect(clock.now().toISOString()).toBe('2026-11-20T10:01:30.000Z');
  });
});
```

- [ ] **Step 7: Run them to verify they fail**

Run: `npx vitest run --project server`
Expected: FAIL — cannot find module `./config`, `./clock` and `./test/fake-clock`.

- [ ] **Step 8: Implement `src/server/config.ts`**

```ts
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
```

- [ ] **Step 9: Implement `src/server/clock.ts` and `src/server/test/fake-clock.ts`**

```ts
import type { IsoDate, Month } from '../engine';

/** Source of the current instant; injected so time-dependent logic is testable. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Calendar date of `instant` in `timeZone`, formatted 'YYYY-MM-DD'. */
export function todayIn(timeZone: string, instant: Date): IsoDate {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** Calendar month of `instant` in `timeZone`, formatted 'YYYY-MM'. */
export function monthIn(timeZone: string, instant: Date): Month {
  return todayIn(timeZone, instant).slice(0, 7);
}
```

```ts
import type { Clock } from '../clock';

/** Deterministic clock for tests. */
export class FakeClock implements Clock {
  private current: Date;

  constructor(start: string | Date) {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
```

- [ ] **Step 10: Run the tests**

Run: `npm test && npm run typecheck && npm run lint`
Expected: `Tests  186 passed (186)` (178 engine + 8 server); typecheck and lint exit 0.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json vitest.config.ts eslint.config.js src/server
git commit -m "chore(server): tooling, configuration and clock" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Database schema, client, migrations and test harness

**Files:**
- Create: `src/shared/accounts.ts`, `src/server/db/schema.ts`, `src/server/db/client.ts`, `src/server/db/migrate.ts`, `drizzle.config.ts`
- Create (test harness): `src/server/test/pg-url.ts`, `src/server/test/global-setup.ts`, `src/server/test/db.ts`
- Generate: `drizzle/0000_init.sql`, `drizzle/meta/*`
- Modify: `vitest.config.ts`, `tsconfig.json`, `package.json` (script)
- Test: `src/shared/accounts.test.ts`, `src/server/db/schema.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `ACCOUNT_TYPES`, `AccountType`, `AccountClass`, `accountClassOf(type)`, `isLoanType(type)`, `ACCOUNT_CLASS_SQL`
  - every table from spec §4 as Drizzle objects in `src/server/db/schema.ts` (`appUser`, `session`, `loginAttempt`, `account` with generated `accountClass`, `loanInterestOverride`, `categoryGroup`, `category`, `assignment`, `target`, `monthNote`, `payee`, `scheduledTransaction`, `scheduledSubtransaction`, `transaction`, `subtransaction`, `fxRate`, `undoEntry`) and their enums
  - `createDatabase(url, { max? }): Database { db: Db; close() }`, types `Db`, `Tx`, `Executor = Db | Tx`
  - `runMigrations(db, migrationsFolder)`
  - test helpers: `createTestDatabase(): Promise<TestDatabase { db; url; drop() }>` (a fresh migrated database per call), `withDatabase(url, name)`, `TEMPLATE_DATABASE`

- [ ] **Step 1: Shared account classes (spec §3).** Create `src/shared/accounts.ts`:

```ts
export const ACCOUNT_TYPES = [
  'checking',
  'savings',
  'cash',
  'credit_card',
  'line_of_credit',
  'mortgage',
  'auto_loan',
  'student_loan',
  'personal_loan',
  'medical_debt',
  'other_debt',
  'other_asset',
  'other_liability',
] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];

export type AccountClass = 'cash' | 'credit' | 'tracking';

const CASH_TYPES: readonly AccountType[] = ['checking', 'savings', 'cash'];
const CREDIT_TYPES: readonly AccountType[] = ['credit_card', 'line_of_credit'];
const LOAN_TYPES: readonly AccountType[] = [
  'mortgage',
  'auto_loan',
  'student_loan',
  'personal_loan',
  'medical_debt',
  'other_debt',
];

/** Spec §3: cash and credit accounts are on-budget; everything else is a tracking account. */
export function accountClassOf(type: AccountType): AccountClass {
  if (CASH_TYPES.includes(type)) return 'cash';
  if (CREDIT_TYPES.includes(type)) return 'credit';
  return 'tracking';
}

export function isLoanType(type: AccountType): boolean {
  return LOAN_TYPES.includes(type);
}

/** SQL CASE expression that mirrors accountClassOf; used by the generated `account.account_class` column. */
export const ACCOUNT_CLASS_SQL = `CASE
  WHEN type IN (${CASH_TYPES.map((t) => `'${t}'`).join(', ')}) THEN 'cash'
  WHEN type IN (${CREDIT_TYPES.map((t) => `'${t}'`).join(', ')}) THEN 'credit'
  ELSE 'tracking'
END`;
```

and its test `src/shared/accounts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ACCOUNT_TYPES, accountClassOf, isLoanType } from './accounts';

describe('accountClassOf', () => {
  it('maps every account type to its class (spec §3)', () => {
    const classes = Object.fromEntries(ACCOUNT_TYPES.map((t) => [t, accountClassOf(t)]));
    expect(classes).toEqual({
      checking: 'cash',
      savings: 'cash',
      cash: 'cash',
      credit_card: 'credit',
      line_of_credit: 'credit',
      mortgage: 'tracking',
      auto_loan: 'tracking',
      student_loan: 'tracking',
      personal_loan: 'tracking',
      medical_debt: 'tracking',
      other_debt: 'tracking',
      other_asset: 'tracking',
      other_liability: 'tracking',
    });
  });

  it('identifies loan types', () => {
    expect(ACCOUNT_TYPES.filter(isLoanType)).toEqual([
      'mortgage',
      'auto_loan',
      'student_loan',
      'personal_loan',
      'medical_debt',
      'other_debt',
    ]);
  });
});
```

- [ ] **Step 2: The schema.** Create `src/server/db/schema.ts`:

```ts
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { ACCOUNT_CLASS_SQL, ACCOUNT_TYPES } from '../../shared/accounts';

// Money is integer minor units (grosze); `mode: 'number'` maps int8 to a JS number (safe below 2^53).
const money = (name: string) => bigint(name, { mode: 'number' });
const day = (name: string) => date(name, { mode: 'string' });
const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const timestamps = {
  createdAt: instant('created_at').defaultNow().notNull(),
  updatedAt: instant('updated_at')
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
};

export const accountType = pgEnum('account_type', ACCOUNT_TYPES);
export const categoryGroupKind = pgEnum('category_group_kind', ['normal', 'cc_payments', 'debt_payments', 'internal']);
export const categorySystemKind = pgEnum('category_system_kind', ['rta', 'uncategorized']);
export const payeeSystemKind = pgEnum('payee_system_kind', [
  'starting_balance',
  'reconciliation_adjustment',
  'fx_revaluation',
]);
export const clearedStatus = pgEnum('cleared_status', ['uncleared', 'cleared', 'reconciled']);
export const flagColor = pgEnum('flag_color', ['red', 'orange', 'yellow', 'green', 'blue', 'purple']);
export const targetKind = pgEnum('target_kind', ['spending', 'balance', 'debt']);
export const targetCadence = pgEnum('target_cadence', ['weekly', 'monthly', 'yearly', 'custom', 'none']);
export const targetMode = pgEnum('target_mode', ['set_aside', 'refill']);
export const targetDebtMode = pgEnum('target_debt_mode', ['min_payment', 'fixed', 'payoff_by_date']);
export const repeatUnit = pgEnum('repeat_unit', ['month', 'year']);
export const frequency = pgEnum('frequency', [
  'once',
  'daily',
  'weekly',
  'every_other_week',
  'twice_a_month',
  'every_4_weeks',
  'monthly',
  'every_other_month',
  'every_3_months',
  'every_4_months',
  'twice_a_year',
  'yearly',
  'every_other_year',
]);
export const undoState = pgEnum('undo_state', ['done', 'undone']);

// ---------------------------------------------------------------- settings and auth (spec §4.1)

export const appUser = pgTable(
  'app_user',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    passwordHash: text('password_hash').notNull(),
    totpSecretEnc: text('totp_secret_enc').notNull(),
    recoveryCodeHashes: text('recovery_code_hashes').array().notNull().default(sql`'{}'::text[]`),
    baseCurrency: text('base_currency').notNull().default('PLN'),
    budgetStartMonth: day('budget_start_month').notNull(),
    ...timestamps,
  },
  // At most one row: every row has the same value for the indexed constant expression.
  () => [uniqueIndex('app_user_singleton').on(sql`(true)`)],
);

export const session = pgTable('session', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: instant('created_at').defaultNow().notNull(),
  expiresAt: instant('expires_at').notNull(),
  lastSeenAt: instant('last_seen_at').notNull(),
  userAgent: text('user_agent'),
});

export const loginAttempt = pgTable(
  'login_attempt',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: instant('at').notNull(),
    success: boolean('success').notNull(),
    ip: text('ip').notNull(),
  },
  (t) => [index('login_attempt_ip_at').on(t.ip, t.at), index('login_attempt_at').on(t.at)],
);

// ---------------------------------------------------------------- accounts (spec §4.2)

export const account = pgTable(
  'account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    type: accountType('type').notNull(),
    accountClass: text('account_class')
      .notNull()
      .generatedAlwaysAs(sql.raw(ACCOUNT_CLASS_SQL)),
    currency: text('currency').notNull().default('PLN'),
    closed: boolean('closed').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    note: text('note'),
    lastReconciledAt: instant('last_reconciled_at'),
    lastReconciledBalance: money('last_reconciled_balance'),
    interestRate: numeric('interest_rate', { precision: 7, scale: 4 }),
    minPayment: money('min_payment'),
    escrowAmount: money('escrow_amount'),
    pairedCategoryId: uuid('paired_category_id').references((): AnyPgColumn => category.id),
    ...timestamps,
  },
  (t) => [
    check('account_currency_iso', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('account_interest_rate_non_negative', sql`${t.interestRate} IS NULL OR ${t.interestRate} >= 0`),
  ],
);

export const loanInterestOverride = pgTable(
  'loan_interest_override',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id),
    month: day('month').notNull(),
    amount: money('amount').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.month] }),
    check('loan_interest_override_first_of_month', sql`extract(day from ${t.month}) = 1`),
  ],
);

// ---------------------------------------------------------------- categories and budget (spec §4.3)

export const categoryGroup = pgTable('category_group', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  hidden: boolean('hidden').notNull().default(false),
  kind: categoryGroupKind('kind').notNull().default('normal'),
  ...timestamps,
});

export const category = pgTable(
  'category',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => categoryGroup.id),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    hidden: boolean('hidden').notNull().default(false),
    note: text('note'),
    systemKind: categorySystemKind('system_kind'),
    linkedAccountId: uuid('linked_account_id').references((): AnyPgColumn => account.id),
    deletedAt: instant('deleted_at'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('category_one_per_system_kind').on(t.systemKind).where(sql`${t.systemKind} IS NOT NULL`),
    index('category_group_id').on(t.groupId),
  ],
);

export const assignment = pgTable(
  'assignment',
  {
    categoryId: uuid('category_id')
      .notNull()
      .references(() => category.id),
    month: day('month').notNull(),
    amount: money('amount').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.categoryId, t.month] }),
    check('assignment_first_of_month', sql`extract(day from ${t.month}) = 1`),
    check('assignment_non_zero', sql`${t.amount} <> 0`),
  ],
);

export const target = pgTable(
  'target',
  {
    categoryId: uuid('category_id')
      .primaryKey()
      .references(() => category.id),
    kind: targetKind('kind').notNull(),
    cadence: targetCadence('cadence').notNull(),
    amount: money('amount').notNull().default(0),
    mode: targetMode('mode'),
    dueWeekday: smallint('due_weekday'),
    dueDayOfMonth: smallint('due_day_of_month'),
    dueDate: day('due_date'),
    repeatUnit: repeatUnit('repeat_unit'),
    repeatEvery: integer('repeat_every'),
    startMonth: day('start_month').notNull(),
    debtMode: targetDebtMode('debt_mode'),
    snoozedMonth: day('snoozed_month'),
    ...timestamps,
  },
  (t) => [
    check('target_amount_non_negative', sql`${t.amount} >= 0`),
    check('target_due_weekday_range', sql`${t.dueWeekday} IS NULL OR ${t.dueWeekday} BETWEEN 0 AND 6`),
    check('target_due_day_range', sql`${t.dueDayOfMonth} IS NULL OR ${t.dueDayOfMonth} BETWEEN 1 AND 31`),
    check('target_repeat_every_positive', sql`${t.repeatEvery} IS NULL OR ${t.repeatEvery} >= 1`),
  ],
);

export const monthNote = pgTable(
  'month_note',
  {
    month: day('month').primaryKey(),
    note: text('note').notNull(),
    ...timestamps,
  },
  (t) => [check('month_note_first_of_month', sql`extract(day from ${t.month}) = 1`)],
);

// ---------------------------------------------------------------- payees and transactions (spec §4.4)

export const payee = pgTable(
  'payee',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    transferAccountId: uuid('transfer_account_id')
      .unique()
      .references(() => account.id),
    systemKind: payeeSystemKind('system_kind'),
    lastCategoryId: uuid('last_category_id').references(() => category.id),
    deletedAt: instant('deleted_at'),
    ...timestamps,
  },
  (t) => [uniqueIndex('payee_name_live').on(sql`lower(${t.name})`).where(sql`${t.deletedAt} IS NULL`)],
);

export const scheduledTransaction = pgTable('scheduled_transaction', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => account.id),
  payeeId: uuid('payee_id').references(() => payee.id),
  categoryId: uuid('category_id').references(() => category.id),
  memo: text('memo'),
  amount: money('amount').notNull(),
  fxRate: numeric('fx_rate', { precision: 14, scale: 6 }),
  fxRateManual: boolean('fx_rate_manual').notNull().default(false),
  flag: flagColor('flag'),
  transferAccountId: uuid('transfer_account_id').references(() => account.id),
  isSplit: boolean('is_split').notNull().default(false),
  frequency: frequency('frequency').notNull(),
  anchorDate: day('anchor_date').notNull(),
  nextDate: day('next_date').notNull(),
  ...timestamps,
});

export const scheduledSubtransaction = pgTable('scheduled_subtransaction', {
  id: uuid('id').primaryKey().defaultRandom(),
  scheduledId: uuid('scheduled_id')
    .notNull()
    .references(() => scheduledTransaction.id, { onDelete: 'cascade' }),
  amount: money('amount').notNull(),
  categoryId: uuid('category_id').references(() => category.id),
  payeeId: uuid('payee_id').references(() => payee.id),
  memo: text('memo'),
  transferAccountId: uuid('transfer_account_id').references(() => account.id),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const transaction = pgTable(
  'transaction',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id),
    date: day('date').notNull(),
    payeeId: uuid('payee_id').references(() => payee.id),
    categoryId: uuid('category_id').references(() => category.id),
    memo: text('memo'),
    amount: money('amount').notNull(),
    amountBase: money('amount_base').notNull(),
    fxRate: numeric('fx_rate', { precision: 14, scale: 6 }),
    fxRateManual: boolean('fx_rate_manual').notNull().default(false),
    cleared: clearedStatus('cleared').notNull().default('uncleared'),
    approved: boolean('approved').notNull().default(true),
    flag: flagColor('flag'),
    transferAccountId: uuid('transfer_account_id').references(() => account.id),
    transferTxnId: uuid('transfer_txn_id').references((): AnyPgColumn => transaction.id),
    transferSubtxnId: uuid('transfer_subtxn_id').references((): AnyPgColumn => subtransaction.id),
    isSplit: boolean('is_split').notNull().default(false),
    isStartingBalance: boolean('is_starting_balance').notNull().default(false),
    scheduledId: uuid('scheduled_id').references(() => scheduledTransaction.id, { onDelete: 'set null' }),
    importId: text('import_id'),
    externalId: text('external_id'),
    deletedAt: instant('deleted_at'),
    ...timestamps,
  },
  (t) => [
    index('transaction_account_date').on(t.accountId, t.date),
    index('transaction_date').on(t.date),
    uniqueIndex('transaction_import_id').on(t.accountId, t.importId).where(sql`${t.importId} IS NOT NULL`),
    uniqueIndex('transaction_external_id').on(t.accountId, t.externalId).where(sql`${t.externalId} IS NOT NULL`),
  ],
);

export const subtransaction = pgTable(
  'subtransaction',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    txnId: uuid('txn_id')
      .notNull()
      .references((): AnyPgColumn => transaction.id),
    amount: money('amount').notNull(),
    amountBase: money('amount_base').notNull(),
    categoryId: uuid('category_id').references(() => category.id),
    payeeId: uuid('payee_id').references(() => payee.id),
    memo: text('memo'),
    transferAccountId: uuid('transfer_account_id').references(() => account.id),
    transferTxnId: uuid('transfer_txn_id').references((): AnyPgColumn => transaction.id),
    sortOrder: integer('sort_order').notNull().default(0),
    deletedAt: instant('deleted_at'),
    ...timestamps,
  },
  (t) => [index('subtransaction_txn_id').on(t.txnId)],
);

// ---------------------------------------------------------------- support (spec §4.5)

export const fxRate = pgTable(
  'fx_rate',
  {
    currency: text('currency').notNull(),
    date: day('date').notNull(),
    rate: numeric('rate', { precision: 14, scale: 6 }).notNull(),
    source: text('source').notNull().default('nbp'),
    effectiveDate: day('effective_date').notNull(),
  },
  (t) => [primaryKey({ columns: [t.currency, t.date] })],
);

export const undoEntry = pgTable('undo_entry', {
  // Monotonic id orders the undo/redo stacks.
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  label: text('label').notNull(),
  changes: jsonb('changes').notNull(),
  state: undoState('state').notNull().default('done'),
  createdAt: instant('created_at').defaultNow().notNull(),
});
```

- [ ] **Step 3: Client and migrator.** Create `src/server/db/client.ts`:

```ts
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;
/** The handle passed to `db.transaction(async (tx) => ...)`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything that can run queries: the pool or an open transaction. */
export type Executor = Db | Tx;

export interface Database {
  db: Db;
  close(): Promise<void>;
}

const INT8_OID = 20;

/** int8 (bigint) arrives as text; money must stay an exact JS integer, so refuse anything beyond 2^53. */
function parseInt8(raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`int8 value ${raw} is outside the safe integer range`);
  return value;
}

export function createDatabase(url: string, options: { max?: number } = {}): Database {
  const client = postgres(url, {
    max: options.max ?? 10,
    onnotice: () => {},
    types: {
      int8: { to: INT8_OID, from: [INT8_OID], serialize: (value: number) => String(value), parse: parseInt8 },
    },
  });
  const db = drizzle({ client, schema });
  return { db, close: () => client.end({ timeout: 5 }) };
}
```

Create `src/server/db/migrate.ts`:

```ts
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Db } from './client';

/** Applies all pending SQL migrations from `migrationsFolder` (idempotent). */
export async function runMigrations(db: Db, migrationsFolder: string): Promise<void> {
  await migrate(db, { migrationsFolder });
}
```

- [ ] **Step 4: drizzle-kit config, tsconfig and script.** Create `drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/db/schema.ts',
  out: './drizzle',
  strict: true,
});
```

Replace `tsconfig.json` with:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": [
      "ES2022"
    ],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": [
      "node"
    ]
  },
  "include": [
    "src",
    "vitest.config.ts",
    "drizzle.config.ts"
  ]
}
```

Add `"db:generate": "drizzle-kit generate"` to `"scripts"` in `package.json`.

- [ ] **Step 5: Generate the initial migration**

Run: `npm run db:generate -- --name init`
Expected: a table summary (17 tables) and `[✓] Your SQL migration file ➜ drizzle/0000_init.sql`. Check that `drizzle/0000_init.sql` contains `CREATE UNIQUE INDEX "app_user_singleton" ON "app_user" USING btree ((true))` and `"account_class" text GENERATED ALWAYS AS (CASE`.

- [ ] **Step 6: Test harness.** Create `src/server/test/pg-url.ts`:

```ts
/** The same connection URL pointed at another database on the same server. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export const TEMPLATE_DATABASE = 'bt_template';
```

`src/server/test/global-setup.ts`:

```ts
import { sql } from 'drizzle-orm';
import type { TestProject } from 'vitest/node';
import { createDatabase } from '../db/client';
import { runMigrations } from '../db/migrate';
import { TEMPLATE_DATABASE, withDatabase } from './pg-url';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

/**
 * Starts one Postgres 16 container for the server test run and migrates a template database.
 * Each test file then clones the template (see createTestDatabase), so files run in parallel in isolation.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  // Docker Desktop's Enhanced Container Isolation forbids Ryuk (it mounts the Docker socket),
  // so the reaper is disabled and the teardown below stops the container.
  process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const adminUrl = container.getConnectionUri();

  const admin = createDatabase(adminUrl, { max: 1 });
  try {
    await admin.db.execute(sql.raw(`CREATE DATABASE ${TEMPLATE_DATABASE}`));
  } finally {
    await admin.close();
  }
  const template = createDatabase(withDatabase(adminUrl, TEMPLATE_DATABASE), { max: 1 });
  try {
    await runMigrations(template.db, 'drizzle');
  } finally {
    await template.close();
  }

  project.provide('pgAdminUrl', adminUrl);
  return async () => {
    await container.stop();
  };
}
```

`src/server/test/db.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { inject } from 'vitest';
import { createDatabase, type Db } from '../db/client';
import { TEMPLATE_DATABASE, withDatabase } from './pg-url';

export interface TestDatabase {
  db: Db;
  url: string;
  /** Closes connections and drops the database. */
  drop(): Promise<void>;
}

async function admin(statement: string): Promise<void> {
  const database = createDatabase(inject('pgAdminUrl'), { max: 1 });
  try {
    await database.db.execute(sql.raw(statement));
  } finally {
    await database.close();
  }
}

/** A fresh, fully migrated database cloned from the template created in global-setup. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `t_${randomUUID().replaceAll('-', '')}`;
  await admin(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DATABASE}`);
  const url = withDatabase(inject('pgAdminUrl'), name);
  const database = createDatabase(url, { max: 5 });
  return {
    db: database.db,
    url,
    async drop() {
      await database.close();
      await admin(`DROP DATABASE ${name} WITH (FORCE)`);
    },
  };
}
```

Replace `vitest.config.ts` with:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'engine', include: ['src/engine/**/*.test.ts'] } },
      {
        test: {
          name: 'server',
          include: ['src/server/**/*.test.ts', 'src/shared/**/*.test.ts'],
          globalSetup: ['src/server/test/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
```

- [ ] **Step 7: Write the schema tests** at `src/server/db/schema.test.ts`:

```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNT_TYPES, accountClassOf } from '../../shared/accounts';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { account, appUser, assignment, category, categoryGroup, payee } from './schema';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.drop();
});

describe('migrations', () => {
  it('create every table from spec §4', async () => {
    const rows = await t.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'account',
      'app_user',
      'assignment',
      'category',
      'category_group',
      'fx_rate',
      'loan_interest_override',
      'login_attempt',
      'month_note',
      'payee',
      'scheduled_subtransaction',
      'scheduled_transaction',
      'session',
      'subtransaction',
      'target',
      'transaction',
      'undo_entry',
    ]);
  });
});

describe('int8 handling', () => {
  it('returns bigint columns and bigint aggregates as exact JS numbers', async () => {
    const [created] = await t.db
      .insert(account)
      .values({ name: 'Big', type: 'checking', minPayment: Number.MAX_SAFE_INTEGER })
      .returning();
    expect(created?.minPayment).toBe(Number.MAX_SAFE_INTEGER);
    const [row] = await t.db.execute<{ total: number }>(
      sql`select sum(x)::bigint as total from (values (1::bigint), (2::bigint)) v(x)`,
    );
    expect(row?.total).toBe(3);
  });

  it('refuses int8 values outside the safe integer range', async () => {
    const error = await t.db.execute(sql`select 9007199254740993::bigint as v`).then(
      () => undefined,
      (e: unknown) => e,
    );
    // Drizzle wraps driver errors ("Failed query: ...") and keeps the original as `cause`.
    expect(String((error as Error | undefined)?.cause)).toContain('safe integer range');
  });
});

describe('constraints', () => {
  it('allows at most one app_user row', async () => {
    const row = { passwordHash: 'x', totpSecretEnc: 'y', budgetStartMonth: '2026-11-01' };
    await t.db.insert(appUser).values(row);
    await expect(t.db.insert(appUser).values(row)).rejects.toThrow();
  });

  it('derives account_class from the account type exactly like accountClassOf', async () => {
    const rows = await t.db
      .insert(account)
      .values(ACCOUNT_TYPES.map((type) => ({ name: `acc-${type}`, type })))
      .returning({ type: account.type, accountClass: account.accountClass });
    for (const row of rows) expect(row.accountClass).toBe(accountClassOf(row.type));
  });

  it('keeps assignments sparse and on the first day of a month', async () => {
    const [group] = await t.db.insert(categoryGroup).values({ name: 'Bills' }).returning();
    const [rent] = await t.db.insert(category).values({ name: 'Rent', groupId: group!.id }).returning();
    await expect(
      t.db.insert(assignment).values({ categoryId: rent!.id, month: '2026-11-15', amount: 100 }),
    ).rejects.toThrow();
    await expect(t.db.insert(assignment).values({ categoryId: rent!.id, month: '2026-11-01', amount: 0 })).rejects.toThrow();
    await t.db.insert(assignment).values({ categoryId: rent!.id, month: '2026-11-01', amount: 100 });
  });

  it('keeps live payee names unique, ignoring case, but frees the name on soft delete', async () => {
    const [first] = await t.db.insert(payee).values({ name: 'Biedronka' }).returning();
    await expect(t.db.insert(payee).values({ name: 'BIEDRONKA' })).rejects.toThrow();
    await t.db.execute(sql`update payee set deleted_at = now() where id = ${first!.id}`);
    await t.db.insert(payee).values({ name: 'biedronka' });
  });

  it('rejects malformed currency codes', async () => {
    await expect(t.db.insert(account).values({ name: 'Bad', type: 'checking', currency: 'pln' })).rejects.toThrow();
  });
});
```

- [ ] **Step 8: Run the server tests**

Run: `npm run test:server` (Docker must be running; the first run pulls `postgres:16-alpine`).
Expected: `Tests  18 passed (18)` (8 schema + 2 accounts + 8 from Task 1). If it fails with "Docker socket mount denied ... ryuk", the `TESTCONTAINERS_RYUK_DISABLED` line in global-setup is missing.

- [ ] **Step 9: Full check and commit**

Run: `npm test && npm run typecheck && npm run lint` — expected `Tests  196 passed (196)`; both exit 0. Then `docker ps --filter label=org.testcontainers=true -q` prints nothing (the container was stopped).

```bash
git add src/shared drizzle.config.ts drizzle tsconfig.json vitest.config.ts package.json src/server/db src/server/test
git commit -m "feat(server): database schema, migrations and Testcontainers harness" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Ledger view

Spec §4.6: one row per budget-relevant line; split parents are replaced by their lines, which inherit the parent's account and date; soft-deleted rows are excluded. All P2b budget aggregates read this view.

**Files:**
- Generate + fill: `drizzle/0001_ledger_view.sql`
- Modify: `src/server/db/schema.ts` (add `ledgerLine`)
- Test: `src/server/db/ledger-view.test.ts`

**Interfaces:**
- Consumes: schema tables from Task 2.
- Produces: `ledgerLine` (Drizzle view over `v_ledger_line`) with columns `accountId, accountClass, date, month ('YYYY-MM-01'), categoryId, amount, amountBase, isTransfer, counterAccountClass, isStartingBalance, txnId, subtxnId`.

- [ ] **Step 1: Write the failing test** at `src/server/db/ledger-view.test.ts`:

```ts
import { asc, desc } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { account, category, categoryGroup, ledgerLine, subtransaction, transaction } from './schema';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.drop();
});

async function seed() {
  const [checking, visa, mortgage] = await t.db
    .insert(account)
    .values([
      { name: 'Checking', type: 'checking' },
      { name: 'Visa', type: 'credit_card' },
      { name: 'Mortgage', type: 'mortgage' },
    ])
    .returning();
  const [group] = await t.db.insert(categoryGroup).values({ name: 'Bills' }).returning();
  const [groceries, housing] = await t.db
    .insert(category)
    .values([
      { name: 'Groceries', groupId: group!.id },
      { name: 'Housing', groupId: group!.id },
    ])
    .returning();
  return { checking: checking!, visa: visa!, mortgage: mortgage!, groceries: groceries!, housing: housing! };
}

describe('v_ledger_line', () => {
  it('lists non-split lines and split lines with their parent account and date, skipping deleted rows', async () => {
    const s = await seed();
    const line = (values: Partial<typeof transaction.$inferInsert>) =>
      t.db
        .insert(transaction)
        .values({ accountId: s.checking.id, date: '2026-11-19', amount: 0, amountBase: 0, ...values })
        .returning()
        .then((rows) => rows[0]!);

    await line({ amount: 100_000, amountBase: 100_000, isStartingBalance: true, date: '2026-11-01' });
    await line({ amount: -5_000, amountBase: -5_000, categoryId: s.groceries.id });
    await line({ amount: -999, amountBase: -999, categoryId: s.groceries.id, deletedAt: new Date() });
    const payment = await line({ amount: -10_000, amountBase: -10_000, transferAccountId: s.visa.id, date: '2026-11-20' });
    await line({
      accountId: s.visa.id,
      amount: 10_000,
      amountBase: 10_000,
      transferAccountId: s.checking.id,
      transferTxnId: payment.id,
      date: '2026-11-20',
    });
    const split = await line({ amount: -8_000, amountBase: -8_000, isSplit: true, date: '2026-12-02' });
    await t.db.insert(subtransaction).values([
      { txnId: split.id, amount: -3_000, amountBase: -3_000, categoryId: s.groceries.id, sortOrder: 0 },
      {
        txnId: split.id,
        amount: -5_000,
        amountBase: -5_000,
        categoryId: s.housing.id,
        transferAccountId: s.mortgage.id,
        sortOrder: 1,
      },
      { txnId: split.id, amount: -1, amountBase: -1, categoryId: s.groceries.id, deletedAt: new Date(), sortOrder: 2 },
    ]);

    const rows = await t.db
      .select()
      .from(ledgerLine)
      .orderBy(asc(ledgerLine.date), desc(ledgerLine.amount));

    expect(
      rows.map((r) => ({
        account: r.accountId === s.visa.id ? 'visa' : 'checking',
        accountClass: r.accountClass,
        date: r.date,
        month: r.month,
        category: r.categoryId === s.groceries.id ? 'groceries' : r.categoryId === s.housing.id ? 'housing' : null,
        amountBase: r.amountBase,
        isTransfer: r.isTransfer,
        counterAccountClass: r.counterAccountClass,
        isStartingBalance: r.isStartingBalance,
        isSplitLine: r.subtxnId !== null,
        parent: r.txnId === split.id ? 'split' : 'own',
      })),
    ).toEqual([
      { account: 'checking', accountClass: 'cash', date: '2026-11-01', month: '2026-11-01', category: null, amountBase: 100_000, isTransfer: false, counterAccountClass: null, isStartingBalance: true, isSplitLine: false, parent: 'own' },
      { account: 'checking', accountClass: 'cash', date: '2026-11-19', month: '2026-11-01', category: 'groceries', amountBase: -5_000, isTransfer: false, counterAccountClass: null, isStartingBalance: false, isSplitLine: false, parent: 'own' },
      { account: 'visa', accountClass: 'credit', date: '2026-11-20', month: '2026-11-01', category: null, amountBase: 10_000, isTransfer: true, counterAccountClass: 'cash', isStartingBalance: false, isSplitLine: false, parent: 'own' },
      { account: 'checking', accountClass: 'cash', date: '2026-11-20', month: '2026-11-01', category: null, amountBase: -10_000, isTransfer: true, counterAccountClass: 'credit', isStartingBalance: false, isSplitLine: false, parent: 'own' },
      { account: 'checking', accountClass: 'cash', date: '2026-12-02', month: '2026-12-01', category: 'groceries', amountBase: -3_000, isTransfer: false, counterAccountClass: null, isStartingBalance: false, isSplitLine: true, parent: 'split' },
      { account: 'checking', accountClass: 'cash', date: '2026-12-02', month: '2026-12-01', category: 'housing', amountBase: -5_000, isTransfer: true, counterAccountClass: 'tracking', isStartingBalance: false, isSplitLine: true, parent: 'split' },
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project server src/server/db/ledger-view.test.ts`
Expected: FAIL — `ledgerLine` is not exported from `./schema` (TypeError / import error).

- [ ] **Step 3: Create the custom migration**

Run: `npx drizzle-kit generate --custom --name ledger_view`
Expected: `drizzle/0001_ledger_view.sql` with a placeholder comment. Replace its content with:

```sql
-- Spec §4.6: one row per budget-relevant line. Non-split transactions are lines themselves; split parents are
-- replaced by their subtransactions, which inherit the parent's account and date. Soft-deleted rows are excluded.
CREATE VIEW "v_ledger_line" AS
SELECT
  t."account_id",
  a."account_class",
  t."date",
  date_trunc('month', t."date")::date AS "month",
  t."category_id",
  t."amount",
  t."amount_base",
  t."transfer_account_id" IS NOT NULL AS "is_transfer",
  ca."account_class" AS "counter_account_class",
  t."is_starting_balance",
  t."id" AS "txn_id",
  NULL::uuid AS "subtxn_id"
FROM "transaction" t
JOIN "account" a ON a."id" = t."account_id"
LEFT JOIN "account" ca ON ca."id" = t."transfer_account_id"
WHERE t."deleted_at" IS NULL AND NOT t."is_split"
UNION ALL
SELECT
  t."account_id",
  a."account_class",
  t."date",
  date_trunc('month', t."date")::date,
  s."category_id",
  s."amount",
  s."amount_base",
  s."transfer_account_id" IS NOT NULL,
  ca."account_class",
  false,
  t."id",
  s."id"
FROM "subtransaction" s
JOIN "transaction" t ON t."id" = s."txn_id"
JOIN "account" a ON a."id" = t."account_id"
LEFT JOIN "account" ca ON ca."id" = s."transfer_account_id"
WHERE s."deleted_at" IS NULL AND t."deleted_at" IS NULL AND t."is_split";
```

- [ ] **Step 4: Declare the view in the schema.** In `src/server/db/schema.ts`, add `pgView,` to the `drizzle-orm/pg-core` import list (after `pgTable,`) and append at the end of the file:

```ts
// ---------------------------------------------------------------- ledger view (spec §4.6)

/** Read-only view created by migration 0001_ledger_view.sql; `.existing()` keeps drizzle-kit from managing it. */
export const ledgerLine = pgView('v_ledger_line', {
  accountId: uuid('account_id').notNull(),
  accountClass: text('account_class').notNull(),
  date: day('date').notNull(),
  month: day('month').notNull(),
  categoryId: uuid('category_id'),
  amount: money('amount').notNull(),
  amountBase: money('amount_base').notNull(),
  isTransfer: boolean('is_transfer').notNull(),
  counterAccountClass: text('counter_account_class'),
  isStartingBalance: boolean('is_starting_balance').notNull(),
  txnId: uuid('txn_id').notNull(),
  subtxnId: uuid('subtxn_id'),
}).existing();
```

- [ ] **Step 5: Run the tests**

Run: `npm run db:generate`
Expected: `No schema changes, nothing to migrate` (the view is `.existing()`).
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Tests  197 passed (197)`; both exit 0.

- [ ] **Step 6: Commit**

```bash
git add drizzle src/server/db
git commit -m "feat(server): ledger view of budget lines" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: HTTP application skeleton

**Files:**
- Create: `src/shared/http.ts`, `src/server/logger.ts`, `src/server/http/env.ts`, `src/server/http/errors.ts`, `src/server/http/validate.ts`, `src/server/http/middleware.ts`, `src/server/http/client-ip.ts`, `src/server/http/app.ts`
- Create (test helpers): `src/server/test/config.ts`, `src/server/test/http-client.ts`, `src/server/test/app.ts`
- Test: `src/server/http/app.test.ts`, `src/server/http/errors.test.ts`, `src/server/http/client-ip.test.ts`

**Interfaces:**
- Consumes: `Config`, `Clock`, `Db`.
- Produces:
  - `CSRF_HEADER = 'X-Requested-With'`, `CSRF_HEADER_VALUE = 'budget-track'`, `ApiErrorBody`
  - `createLogger(level): Logger`
  - `AppEnv` (context variables `requestId`, `logger`)
  - `AppError(status, code, message, extra?)`, `DomainError(code, message)` (422), `ValidationError(zodError)` (400), `errorHandler`
  - `validate(target, schema)` (zod validator middleware that throws `ValidationError`)
  - `csrfGuard()`, `requestLogger(logger)`, `clientIpResolver(trustProxy): ClientIpResolver`
  - `AppDeps { db; config; clock; logger; clientIp }`, `createApp(deps)`, `App`
  - test helpers: `testConfig(overrides)`, `TEST_SETUP_TOKEN`, `TestClient(app, ip?)` with `get/post/send/cookie`, `createTestApp(db, { config?, now? }): TestApp { app; client; clock; config }`

- [ ] **Step 1: Write the failing tests**

`src/server/http/app.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/client';
import { createTestApp } from '../test/app';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { TestClient } from '../test/http-client';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.drop();
});

describe('GET /healthz', () => {
  it('reports ok when the database answers', async () => {
    const { client } = createTestApp(t.db);
    const res = await client.get('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('reports 503 when the database is down', async () => {
    const brokenDb = { execute: () => Promise.reject(new Error('connection refused')) } as unknown as Db;
    const { client } = createTestApp(brokenDb);
    const res = await client.get('/healthz');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'unavailable' });
  });
});

describe('cross-cutting behaviour', () => {
  it('sets security headers and a request id on every response', async () => {
    const { client } = createTestApp(t.db);
    const res = await client.get('/healthz');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('answers unknown routes with a JSON 404', async () => {
    const { client } = createTestApp(t.db);
    const res = await client.get('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'not_found', message: 'Not found.' });
  });

  it('rejects mutating /api requests without the CSRF header', async () => {
    const { app } = createTestApp(t.db);
    const res = await app.request('/api/nope', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'csrf', message: 'Missing X-Requested-With header.' });
    const withHeader = await new TestClient(app).post('/api/nope');
    expect(withHeader.status).toBe(404);
  });
});
```

`src/server/http/errors.test.ts`:

```ts
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createLogger } from '../logger';
import type { AppEnv } from './env';
import { AppError, DomainError, errorHandler } from './errors';
import { validate } from './validate';

function appWith(routes: (app: Hono<AppEnv>) => void) {
  const logger = createLogger('silent');
  const errorSpy = vi.spyOn(logger, 'error');
  const app = new Hono<AppEnv>().use(requestId()).use(async (c, next) => {
    c.set('logger', logger);
    await next();
  });
  routes(app);
  app.onError(errorHandler);
  return { app, errorSpy };
}

describe('errorHandler', () => {
  it('maps AppError to its status and code', async () => {
    const { app } = appWith((a) => a.get('/x', () => Promise.reject(new AppError(409, 'conflict', 'Already there.'))));
    const res = await app.request('/x');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'conflict', message: 'Already there.' });
  });

  it('maps DomainError to 422', async () => {
    const { app } = appWith((a) => a.get('/x', () => Promise.reject(new DomainError('split_sum', 'Lines must add up.'))));
    const res = await app.request('/x');
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ code: 'split_sum', message: 'Lines must add up.' });
  });

  it('maps validation failures to 400 with field errors', async () => {
    const schema = z.object({ name: z.string().min(1), amount: z.number().int() });
    const { app } = appWith((a) => a.post('/x', validate('json', schema), (c) => c.json(c.req.valid('json'))));
    const res = await app.request('/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '', amount: 1.5 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; fieldErrors: Record<string, string[]> };
    expect(body.code).toBe('validation');
    expect(Object.keys(body.fieldErrors).sort()).toEqual(['amount', 'name']);
  });

  it('maps malformed JSON to 400', async () => {
    const { app } = appWith((a) => a.post('/x', validate('json', z.object({})), (c) => c.json({})));
    const res = await app.request('/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('bad_request');
  });

  it('hides unexpected errors behind a generic 500 and logs them', async () => {
    const { app, errorSpy } = appWith((a) => a.get('/x', () => Promise.reject(new Error('db password is hunter2'))));
    const res = await app.request('/x');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; message: string; requestId: string };
    expect(body).toEqual({ code: 'internal', message: 'Something went wrong.', requestId: res.headers.get('x-request-id') });
    expect(errorSpy).toHaveBeenCalledOnce();
  });
});
```

`src/server/http/client-ip.test.ts`:

```ts
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { clientIpResolver } from './client-ip';

async function ipOf(trustProxy: boolean, headers: Record<string, string>): Promise<string> {
  const app = new Hono().get('/', (c) => c.text(clientIpResolver(trustProxy)(c)));
  const res = await app.request('/', { headers });
  return res.text();
}

describe('clientIpResolver', () => {
  it('uses the first X-Forwarded-For entry behind a trusted proxy', async () => {
    expect(await ipOf(true, { 'x-forwarded-for': '198.51.100.4, 10.0.0.1' })).toBe('198.51.100.4');
  });

  it('ignores X-Forwarded-For unless the proxy is trusted', async () => {
    // No Node socket in app.request(), so the remote address is unknown.
    expect(await ipOf(false, { 'x-forwarded-for': '198.51.100.4' })).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project server src/server/http`
Expected: FAIL — modules `../test/app`, `./errors`, `./client-ip` etc. not found.

- [ ] **Step 3: Shared HTTP contract and logger.** `src/shared/http.ts`:

```ts
/** Every mutating /api request must send this header (CSRF defence on top of SameSite=Strict cookies). */
export const CSRF_HEADER = 'X-Requested-With';
export const CSRF_HEADER_VALUE = 'budget-track';

/** Body of every non-2xx JSON response from /api. */
export interface ApiErrorBody {
  code: string;
  message: string;
  /** Present for code "validation": messages per request field. */
  fieldErrors?: Record<string, string[]>;
  /** Present for code "validation": messages not tied to one field. */
  formErrors?: string[];
  /** Present for code "internal": quote it when reporting a bug. */
  requestId?: string;
}
```

`src/server/logger.ts`:

```ts
import { pino, type Logger } from 'pino';
import type { LogLevel } from './config';

export type { Logger };

/** JSON logs to stdout (spec §13). */
export function createLogger(level: LogLevel): Logger {
  return pino({ level, base: undefined, timestamp: pino.stdTimeFunctions.isoTime });
}
```

- [ ] **Step 4: Errors, validation and middleware.** `src/server/http/env.ts`:

```ts
import type { Logger } from '../logger';

/** Hono context variables shared by every route. */
export interface AppEnv {
  Variables: {
    requestId: string;
    logger: Logger;
  };
}
```

`src/server/http/errors.ts`:

```ts
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { ApiErrorBody } from '../../shared/http';
import type { AppEnv } from './env';

/** An error whose message is safe to show to the user; mapped to `status` with body `{ code, message, ... }`. */
export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly extra: Omit<ApiErrorBody, 'code' | 'message'> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** A violated business rule (spec §13): HTTP 422. */
export class DomainError extends AppError {
  constructor(code: string, message: string) {
    super(422, code, message);
    this.name = 'DomainError';
  }
}

/** Request validation failure (spec §13): HTTP 400 `{ code: "validation", fieldErrors, formErrors }`. */
export class ValidationError extends AppError {
  constructor(error: z.core.$ZodError) {
    const flat = z.flattenError(error);
    super(400, 'validation', 'Some fields are invalid.', {
      fieldErrors: flat.fieldErrors as Record<string, string[]>,
      formErrors: flat.formErrors,
    });
    this.name = 'ValidationError';
  }
}

export function errorHandler(err: Error, c: Context<AppEnv>): Response {
  if (err instanceof AppError) {
    return c.json<ApiErrorBody>({ code: err.code, message: err.message, ...err.extra }, err.status);
  }
  if (err instanceof HTTPException) {
    return c.json<ApiErrorBody>({ code: 'bad_request', message: err.message }, err.status);
  }
  c.var.logger.error({ err }, 'unhandled error');
  return c.json<ApiErrorBody>(
    { code: 'internal', message: 'Something went wrong.', requestId: c.var.requestId },
    500,
  );
}
```

`src/server/http/validate.ts`:

```ts
import { zValidator } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import type { z } from 'zod';
import { ValidationError } from './errors';

/** zod request validation that reports failures in the API's error format (HTTP 400, code "validation"). */
export function validate<Target extends keyof ValidationTargets, Schema extends z.ZodType>(
  target: Target,
  schema: Schema,
) {
  return zValidator(target, schema, (result) => {
    if (!result.success) throw new ValidationError(result.error);
  });
}
```

`src/server/http/middleware.ts`:

```ts
import type { MiddlewareHandler } from 'hono';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../shared/http';
import type { Logger } from '../logger';
import type { AppEnv } from './env';
import { AppError } from './errors';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Rejects state-changing requests without the custom header; browsers can't add it cross-site without CORS. */
export function csrfGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method) && c.req.header(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
      throw new AppError(403, 'csrf', `Missing ${CSRF_HEADER} header.`);
    }
    await next();
  };
}

/** Puts a request-scoped child logger on the context and logs one line per request. */
export function requestLogger(base: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const logger = base.child({ requestId: c.var.requestId });
    c.set('logger', logger);
    const started = performance.now();
    await next();
    logger.info(
      { method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - started) },
      'request',
    );
  };
}
```

`src/server/http/client-ip.ts`:

```ts
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

export type ClientIpResolver = (c: Context) => string;

/**
 * Client address used for login rate limiting. Behind a reverse proxy (TRUST_PROXY=true) it is the first
 * X-Forwarded-For entry; otherwise the socket's remote address.
 */
export function clientIpResolver(trustProxy: boolean): ClientIpResolver {
  return (c) => {
    if (trustProxy) {
      const first = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
      if (first) return first;
    }
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      return 'unknown';
    }
  };
}
```

- [ ] **Step 5: The app.** `src/server/http/app.ts`:

```ts
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import type { ApiErrorBody } from '../../shared/http';
import type { Clock } from '../clock';
import type { Config } from '../config';
import type { Db } from '../db/client';
import type { Logger } from '../logger';
import type { ClientIpResolver } from './client-ip';
import type { AppEnv } from './env';
import { errorHandler } from './errors';
import { csrfGuard, requestLogger } from './middleware';

export interface AppDeps {
  db: Db;
  config: Config;
  clock: Clock;
  logger: Logger;
  clientIp: ClientIpResolver;
}

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>()
    .use(requestId())
    .use(requestLogger(deps.logger))
    .use(
      secureHeaders({
        contentSecurityPolicy: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
        },
        referrerPolicy: 'no-referrer',
        xFrameOptions: 'DENY',
      }),
    )
    .use('/api/*', csrfGuard())
    .get('/healthz', async (c) => {
      try {
        await deps.db.execute(sql`select 1`);
        return c.json({ status: 'ok' as const });
      } catch (err) {
        c.var.logger.warn({ err }, 'health check failed');
        return c.json({ status: 'unavailable' as const }, 503);
      }
    });

  app.notFound((c) => c.json<ApiErrorBody>({ code: 'not_found', message: 'Not found.' }, 404));
  app.onError(errorHandler);
  return app;
}

export type App = ReturnType<typeof createApp>;
```

- [ ] **Step 6: Test helpers.** `src/server/test/config.ts`:

```ts
import type { Config } from '../config';

export const TEST_SETUP_TOKEN = 'test-setup-token-0123456789';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: 'postgres://unused/in-tests',
    encryptionKey: Buffer.alloc(32, 1),
    setupToken: TEST_SETUP_TOKEN,
    port: 0,
    timeZone: 'Europe/Warsaw',
    cookieSecure: true,
    // Tests identify clients by X-Forwarded-For.
    trustProxy: true,
    logLevel: 'silent',
    migrationsDir: 'drizzle',
    ...overrides,
  };
}
```

`src/server/test/http-client.ts`:

```ts
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../shared/http';

interface Fetcher {
  request(path: string, init?: RequestInit): Response | Promise<Response>;
}

/** Drives a Hono app like a browser: keeps cookies, sends the CSRF header, and identifies itself by IP. */
export class TestClient {
  private readonly cookies = new Map<string, string>();

  constructor(
    private readonly app: Fetcher,
    readonly ip = '203.0.113.7',
  ) {}

  get(path: string, headers: Record<string, string> = {}): Promise<Response> {
    return this.send('GET', path, undefined, headers);
  }

  post(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return this.send('POST', path, body, headers);
  }

  cookie(name: string): string | undefined {
    return this.cookies.get(name);
  }

  async send(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> {
    const headers = new Headers({ 'x-forwarded-for': this.ip });
    if (method !== 'GET' && method !== 'HEAD') headers.set(CSRF_HEADER, CSRF_HEADER_VALUE);
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (this.cookies.size > 0) {
      headers.set('cookie', [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    }
    for (const [name, value] of Object.entries(extra)) headers.set(name, value);
    const response = await this.app.request(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const header of response.headers.getSetCookie()) this.storeCookie(header);
    return response;
  }

  private storeCookie(header: string): void {
    const [pair = '', ...attributes] = header.split(';').map((part) => part.trim());
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    const expired = attributes.some((a) => /^max-age=0$/i.test(a)) || value === '';
    if (expired) this.cookies.delete(name);
    else this.cookies.set(name, value);
  }
}
```

`src/server/test/app.ts`:

```ts
import type { Config } from '../config';
import type { Db } from '../db/client';
import { createApp, type App } from '../http/app';
import { clientIpResolver } from '../http/client-ip';
import { createLogger } from '../logger';
import { testConfig } from './config';
import { FakeClock } from './fake-clock';
import { TestClient } from './http-client';

export interface TestApp {
  app: App;
  client: TestClient;
  clock: FakeClock;
  config: Config;
}

export function createTestApp(db: Db, options: { config?: Partial<Config>; now?: string } = {}): TestApp {
  const config = testConfig(options.config);
  const clock = new FakeClock(options.now ?? '2026-11-20T10:00:00Z');
  const app = createApp({
    db,
    config,
    clock,
    logger: createLogger(config.logLevel),
    clientIp: clientIpResolver(config.trustProxy),
  });
  return { app, client: new TestClient(app), clock, config };
}
```

- [ ] **Step 7: Run the tests**

Run: `npm test && npm run typecheck && npm run lint`
Expected: `Tests  209 passed (209)`; both exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/shared/http.ts src/server/logger.ts src/server/http src/server/test
git commit -m "feat(server): HTTP app with error mapping, security headers, CSRF guard and health check" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Authentication primitives

**Files:**
- Create: `src/server/auth/secret-box.ts`, `src/server/auth/passwords.ts`, `src/server/auth/totp.ts`, `src/server/auth/recovery-codes.ts`, `src/server/test/totp.ts`
- Test: `src/server/auth/secret-box.test.ts`, `src/server/auth/passwords.test.ts`, `src/server/auth/totp.test.ts`, `src/server/auth/recovery-codes.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `encryptSecret(plaintext, key): string` (`v1.<iv>.<tag>.<ciphertext>`), `decryptSecret(payload, key): string`
  - `hashPassword(password): Promise<string>` (argon2id), `verifyPassword(hash, password): Promise<boolean>` (never throws)
  - `newTotpSecret(): string` (32 base32 chars), `totpUri(secret): string`, `verifyTotp(secret, code, now): Promise<boolean>`, `TOTP_ISSUER`
  - `RECOVERY_CODE_COUNT = 10`, `generateRecoveryCodes(count?)`, `normalizeRecoveryCode(input)`, `hashRecoveryCodes(codes)`, `consumeRecoveryCode(hashes, input): Promise<string[] | null>`
  - test helper `totpCode(secret, at): Promise<string>`

- [ ] **Step 1: Write the failing tests**

`src/server/auth/secret-box.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from './secret-box';

const key = Buffer.alloc(32, 3);

describe('secret box', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const a = encryptSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', key);
    const b = encryptSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', key);
    expect(a).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, key)).toBe('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
  });

  it('fails with the wrong key or tampered data', () => {
    const payload = encryptSecret('secret', key);
    expect(() => decryptSecret(payload, Buffer.alloc(32, 4))).toThrow();
    const [v, iv, tag, data] = payload.split('.');
    const flipped = `${data!.slice(0, -1)}${data!.endsWith('A') ? 'B' : 'A'}`;
    expect(() => decryptSecret([v, iv, tag, flipped].join('.'), key)).toThrow();
  });

  it('rejects unknown formats and short keys', () => {
    expect(() => decryptSecret('v0.a.b.c', key)).toThrow('Unsupported encrypted secret format');
    expect(() => encryptSecret('x', Buffer.alloc(16))).toThrow('32 bytes');
  });
});
```

`src/server/auth/passwords.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './passwords';

describe('passwords', () => {
  it('hashes with argon2id and verifies', async () => {
    const hashed = await hashPassword('correct horse battery');
    expect(hashed).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hashed, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hashed, 'wrong horse battery')).toBe(false);
  });

  it('treats a malformed hash as a failed check', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });
});
```

`src/server/auth/totp.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { totpCode } from '../test/totp';
import { newTotpSecret, totpUri, verifyTotp } from './totp';

// 1_800_000_000 is a multiple of 30, so this instant starts a TOTP step.
const stepStart = new Date(1_800_000_000 * 1000);
const seconds = (n: number) => new Date(stepStart.getTime() + n * 1000);

describe('totp', () => {
  it('creates base32 secrets and an otpauth URI for authenticator apps', () => {
    const secret = newTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const uri = totpUri(secret);
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('issuer=Budget%20Track');
  });

  it('accepts the current code and one step of drift, but not two', async () => {
    const secret = newTotpSecret();
    const code = await totpCode(secret, stepStart);
    expect(await verifyTotp(secret, code, stepStart)).toBe(true);
    expect(await verifyTotp(secret, code, seconds(59))).toBe(true);
    expect(await verifyTotp(secret, code, seconds(-30))).toBe(true);
    expect(await verifyTotp(secret, code, seconds(60))).toBe(false);
    expect(await verifyTotp(secret, code, seconds(-31))).toBe(false);
  });

  it('rejects malformed codes and secrets without throwing', async () => {
    const secret = newTotpSecret();
    expect(await verifyTotp(secret, '12345', stepStart)).toBe(false);
    expect(await verifyTotp(secret, 'abcdef', stepStart)).toBe(false);
    expect(await verifyTotp('not base32!', '123456', stepStart)).toBe(false);
  });
});
```

`src/server/auth/recovery-codes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  consumeRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCodes,
  normalizeRecoveryCode,
} from './recovery-codes';

describe('recovery codes', () => {
  it('generates ten distinct, readable codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  });

  it('normalizes case, spaces and dashes', () => {
    expect(normalizeRecoveryCode(' 7kqm w3xp-9dhr ')).toBe('7KQMW3XP9DHR');
  });

  it('accepts each code once and leaves the others', async () => {
    const codes = generateRecoveryCodes(3);
    const hashes = await hashRecoveryCodes(codes);
    const remaining = await consumeRecoveryCode(hashes, codes[1]!.toLowerCase());
    expect(remaining).toHaveLength(2);
    expect(await consumeRecoveryCode(remaining!, codes[1]!)).toBeNull();
    expect(await consumeRecoveryCode(remaining!, codes[0]!)).toHaveLength(1);
  });

  it('rejects unknown and malformed codes', async () => {
    const hashes = await hashRecoveryCodes(generateRecoveryCodes(2));
    expect(await consumeRecoveryCode(hashes, 'AAAA-AAAA-AAAA')).toBeNull();
    expect(await consumeRecoveryCode(hashes, 'short')).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project server src/server/auth`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/server/auth/secret-box.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const FORMAT_VERSION = 'v1';

/** AES-256-GCM: `v1.<iv>.<tag>.<ciphertext>` (base64url parts); a fresh 96-bit IV every time. */
export function encryptSecret(plaintext: string, key: Buffer): string {
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [FORMAT_VERSION, iv, cipher.getAuthTag(), ciphertext].map((part) =>
    typeof part === 'string' ? part : part.toString('base64url'),
  ).join('.');
}

/** Reverses encryptSecret; throws if the payload was tampered with or the key is wrong. */
export function decryptSecret(payload: string, key: Buffer): string {
  const [version, iv, tag, ciphertext] = payload.split('.');
  if (version !== FORMAT_VERSION || !iv || !tag || ciphertext === undefined) {
    throw new Error('Unsupported encrypted secret format');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
```

`src/server/auth/passwords.ts`:

```ts
import { hash, verify } from '@node-rs/argon2';

/** argon2id with the library's OWASP-aligned defaults. */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

/** False for a wrong password or a malformed hash; never throws. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
```

`src/server/auth/totp.ts`:

```ts
import { generateSecret, generateURI, verify } from 'otplib';

export const TOTP_ISSUER = 'Budget Track';
const TOTP_LABEL = 'owner';

/** A new random base32 secret (160 bits) for an authenticator app. */
export function newTotpSecret(): string {
  return generateSecret();
}

/** otpauth:// URI the setup screen renders as a QR code. */
export function totpUri(secret: string): string {
  return generateURI({ issuer: TOTP_ISSUER, label: TOTP_LABEL, secret });
}

/** Spec §12: 30 s step, ±1 step of clock drift. False for malformed codes or secrets. */
export async function verifyTotp(secret: string, code: string, now: Date): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  try {
    const result = await verify({
      secret,
      token: code,
      epoch: Math.floor(now.getTime() / 1000),
      epochTolerance: 30,
    });
    return result.valid;
  } catch {
    return false;
  }
}
```

`src/server/test/totp.ts`:

```ts
import { generate } from 'otplib';

/** The 6-digit code an authenticator app would show for `secret` at `at`. */
export function totpCode(secret: string, at: Date): Promise<string> {
  return generate({ secret, epoch: Math.floor(at.getTime() / 1000) });
}
```

`src/server/auth/recovery-codes.ts`:

```ts
import { randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

export const RECOVERY_CODE_COUNT = 10;
// No 0/O, 1/I/L: codes are typed in by hand.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const GROUPS = 3;
const GROUP_LENGTH = 4;

/** Ten single-use codes like "7KQM-W3XP-9DHR" (about 59 bits each), shown to the user once. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () =>
    Array.from({ length: GROUPS }, () =>
      Array.from({ length: GROUP_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''),
    ).join('-'),
  );
}

/** Upper-cases and strips separators/spaces so "7kqm w3xp 9dhr" matches "7KQM-W3XP-9DHR". */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export function hashRecoveryCodes(codes: string[]): Promise<string[]> {
  return Promise.all(codes.map((code) => hash(normalizeRecoveryCode(code))));
}

/** If `input` matches one of `hashes`, returns the remaining hashes (the code is used up); otherwise null. */
export async function consumeRecoveryCode(hashes: string[], input: string): Promise<string[] | null> {
  const normalized = normalizeRecoveryCode(input);
  if (normalized.length !== GROUPS * GROUP_LENGTH) return null;
  for (const [index, candidate] of hashes.entries()) {
    if (await verify(candidate, normalized).catch(() => false)) {
      return hashes.filter((_, i) => i !== index);
    }
  }
  return null;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test && npm run typecheck && npm run lint`
Expected: `Tests  221 passed (221)`; both exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/server/auth src/server/test/totp.ts
git commit -m "feat(server): password, TOTP, recovery-code and secret-encryption primitives" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Sessions

**Files:**
- Create: `src/server/auth/sessions.ts`
- Test: `src/server/auth/sessions.test.ts`

**Interfaces:**
- Consumes: `Executor`, `session` table, `AppEnv`, `AppError`, `Clock`.
- Produces:
  - `SESSION_COOKIE = 'bt_session'`, `SESSION_TTL_MS` (30 days), `SessionInfo { id; expiresAt }`, `AuthedEnv`
  - `createSession(db, now, userAgent): Promise<{ token; session }>`, `findSession(db, token, now)` (slides expiry), `deleteSession(db, id)`, `deleteAllSessions(db, { exceptId? })`
  - `setSessionCookie(c, token, secure)`, `clearSessionCookie(c, secure)`, `currentSession(c, { db, clock })`
  - `requireSession({ db, clock, config })` middleware: 401 `unauthorized` / sets `c.var.session` and refreshes the cookie. Use it per route (never with `.use()` on a sub-app mounted at a shared prefix).

- [ ] **Step 1: Write the failing test** at `src/server/auth/sessions.test.ts`:

```ts
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../db/schema';
import type { AppEnv } from '../http/env';
import { errorHandler } from '../http/errors';
import { createLogger } from '../logger';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { FakeClock } from '../test/fake-clock';
import { TestClient } from '../test/http-client';
import {
  createSession,
  deleteAllSessions,
  deleteSession,
  findSession,
  requireSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  setSessionCookie,
} from './sessions';

const DAY = 24 * 60 * 60 * 1000;
let t: TestDatabase;
let clock: FakeClock;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  await t.db.delete(session);
  clock = new FakeClock('2026-11-20T10:00:00Z');
});

describe('session store', () => {
  it('stores only a hash of the random token', async () => {
    const { token, session: created } = await createSession(t.db, clock.now(), 'Safari');
    expect(token).toMatch(/^[\w-]{43}$/);
    const [row] = await t.db.select().from(session);
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.tokenHash).not.toContain(token);
    expect(created.expiresAt).toEqual(new Date(clock.now().getTime() + SESSION_TTL_MS));
  });

  it('slides the expiry forward on use and forgets expired sessions', async () => {
    const { token } = await createSession(t.db, clock.now(), undefined);
    clock.advance(10 * DAY);
    const found = await findSession(t.db, token, clock.now());
    expect(found?.expiresAt).toEqual(new Date(clock.now().getTime() + SESSION_TTL_MS));
    clock.advance(30 * DAY);
    expect(await findSession(t.db, token, clock.now())).toBeNull();
    expect(await findSession(t.db, 'unknown-token', clock.now())).toBeNull();
  });

  it('deletes one session, or all but one', async () => {
    const a = await createSession(t.db, clock.now(), undefined);
    const b = await createSession(t.db, clock.now(), undefined);
    const c = await createSession(t.db, clock.now(), undefined);
    await deleteSession(t.db, a.session.id);
    expect(await findSession(t.db, a.token, clock.now())).toBeNull();
    await deleteAllSessions(t.db, { exceptId: b.session.id });
    expect(await findSession(t.db, b.token, clock.now())).not.toBeNull();
    expect(await findSession(t.db, c.token, clock.now())).toBeNull();
    await deleteAllSessions(t.db);
    expect(await t.db.select().from(session)).toEqual([]);
  });
});

describe('requireSession', () => {
  function protectedApp() {
    const deps = { db: t.db, clock, config: { cookieSecure: true } };
    const app = new Hono<AppEnv>()
      .use(requestId())
      .use(async (c, next) => {
        c.set('logger', createLogger('silent'));
        await next();
      })
      .post('/login', async (c) => {
        const { token } = await createSession(t.db, clock.now(), undefined);
        setSessionCookie(c, token, true);
        return c.json({ ok: true });
      })
      .get('/private', requireSession(deps), (c) => c.json({ sessionId: c.var.session.id }));
    app.onError(errorHandler);
    return new TestClient(app);
  }

  it('rejects requests without a valid session', async () => {
    const client = protectedApp();
    const res = await client.get('/private');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'unauthorized', message: 'Please sign in.' });
  });

  it('admits a signed-in client and refreshes its cookie', async () => {
    const client = protectedApp();
    await client.post('/login');
    expect(client.cookie(SESSION_COOKIE)).toBeDefined();
    const res = await client.get('/private');
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain('Max-Age=2592000');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('turns a client away once its session has expired', async () => {
    const client = protectedApp();
    await client.post('/login');
    clock.advance(31 * DAY);
    expect((await client.get('/private')).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project server src/server/auth/sessions.test.ts`
Expected: FAIL — cannot find module `./sessions`.

- [ ] **Step 3: Implement `src/server/auth/sessions.ts`**

```ts
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, lte, ne } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Clock } from '../clock';
import type { Executor } from '../db/client';
import { session } from '../db/schema';
import type { AppEnv } from '../http/env';
import { AppError } from '../http/errors';

export const SESSION_COOKIE = 'bt_session';
/** Spec §12: 30-day sliding expiry. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionInfo {
  id: string;
  expiresAt: Date;
}

/** Context variables available behind requireSession. */
export interface AuthedEnv {
  Variables: AppEnv['Variables'] & { session: SessionInfo };
}

/** Only the SHA-256 of the cookie token is stored, so a database leak doesn't expose live sessions. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  db: Executor,
  now: Date,
  userAgent: string | undefined,
): Promise<{ token: string; session: SessionInfo }> {
  await db.delete(session).where(lte(session.expiresAt, now));
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const [row] = await db
    .insert(session)
    .values({ tokenHash: hashToken(token), expiresAt, lastSeenAt: now, userAgent: userAgent?.slice(0, 512) })
    .returning({ id: session.id, expiresAt: session.expiresAt });
  return { token, session: row! };
}

/** The live session for `token`, with its expiry pushed out to now + 30 days; null if unknown or expired. */
export async function findSession(db: Executor, token: string, now: Date): Promise<SessionInfo | null> {
  const [row] = await db
    .update(session)
    .set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
    .where(and(eq(session.tokenHash, hashToken(token)), gt(session.expiresAt, now)))
    .returning({ id: session.id, expiresAt: session.expiresAt });
  return row ?? null;
}

export async function deleteSession(db: Executor, id: string): Promise<void> {
  await db.delete(session).where(eq(session.id, id));
}

/** Logs out everywhere, optionally keeping one session (the one changing the password). */
export async function deleteAllSessions(db: Executor, options: { exceptId?: string } = {}): Promise<void> {
  await db.delete(session).where(options.exceptId ? ne(session.id, options.exceptId) : undefined);
}

export function setSessionCookie(c: Context, token: string, secure: boolean): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'Strict',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(c: Context, secure: boolean): void {
  deleteCookie(c, SESSION_COOKIE, { httpOnly: true, secure, sameSite: 'Strict', path: '/' });
}

/** The session behind the request's cookie, if any (sliding its expiry). */
export async function currentSession(c: Context, deps: { db: Executor; clock: Clock }): Promise<SessionInfo | null> {
  const token = getCookie(c, SESSION_COOKIE);
  return token ? findSession(deps.db, token, deps.clock.now()) : null;
}

/** 401 unless the request carries a live session; refreshes the cookie so its lifetime slides too. */
export function requireSession(deps: {
  db: Executor;
  clock: Clock;
  config: { cookieSecure: boolean };
}): MiddlewareHandler<AuthedEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const found = token ? await findSession(deps.db, token, deps.clock.now()) : null;
    if (!token || !found) throw new AppError(401, 'unauthorized', 'Please sign in.');
    setSessionCookie(c, token, deps.config.cookieSecure);
    c.set('session', found);
    await next();
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test && npm run typecheck && npm run lint`
Expected: `Tests  227 passed (227)`; both exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/server/auth/sessions.ts src/server/auth/sessions.test.ts
git commit -m "feat(server): hashed, sliding sessions and requireSession middleware" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: First-run setup and auth status

Spec §12: setup works only while no user exists and needs `SETUP_TOKEN`; it sets the password, confirms an authenticator code, stores the encrypted TOTP secret and 10 hashed recovery codes, seeds the budget's system rows (spec §3), signs the owner in, and returns the recovery codes once.

**Files:**
- Create: `src/shared/auth.ts`, `src/server/db/seed.ts`, `src/server/db/errors.ts`, `src/server/auth/setup-routes.ts`, `src/server/test/auth.ts`
- Modify: `src/server/http/app.ts` (mount routes)
- Test: `src/shared/auth.test.ts`, `src/server/auth/setup-routes.test.ts`

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces:
  - shared: `PASSWORD_MIN_LENGTH`, `newPasswordSchema`, `currentPasswordSchema`, `totpCodeSchema`, `totpSecretSchema`, `setupTotpRequestSchema`, `setupRequestSchema`, `loginRequestSchema`, `changePasswordRequestSchema`, `confirmTotpRequestSchema`, `reauthRequestSchema`, their inferred types, `AuthStatus`, `TotpSecretResponse`, `RecoveryCodesResponse`
  - `seedBudget(db)`, `isUniqueViolation(error)`, `isSetupComplete(db)`, `setupRoutes(deps)`
  - endpoints: `GET /api/auth/status` → `AuthStatus`; `POST /api/auth/setup/totp` `{ setupToken }` → `TotpSecretResponse` (403 `invalid_setup_token`, 409 `already_setup`); `POST /api/auth/setup` `{ setupToken, password, totpSecret, totpCode }` → 201 `RecoveryCodesResponse` + session cookie (422 `invalid_totp_code`)
  - test helpers: `TEST_PASSWORD`, `setUpBudget(testApp): Promise<SetupResult { totpSecret; recoveryCodes }>`

- [ ] **Step 1: Shared request schemas.** Create `src/shared/auth.ts`:

```ts
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

export const setupTotpRequestSchema = z.object({ setupToken: z.string().min(1, 'Enter the setup token.') });

export const setupRequestSchema = z.object({
  setupToken: z.string().min(1, 'Enter the setup token.'),
  password: newPasswordSchema,
  totpSecret: totpSecretSchema,
  totpCode: totpCodeSchema,
});

export const loginRequestSchema = z
  .object({
    password: currentPasswordSchema,
    totpCode: totpCodeSchema.optional(),
    recoveryCode: z.string().min(1).max(64).optional(),
  })
  .refine((body) => (body.totpCode === undefined) !== (body.recoveryCode === undefined), {
    message: 'Enter either a code from your authenticator app or a recovery code.',
  });

export const changePasswordRequestSchema = z.object({
  currentPassword: currentPasswordSchema,
  newPassword: newPasswordSchema,
  totpCode: totpCodeSchema,
});

export const confirmTotpRequestSchema = z.object({
  currentPassword: currentPasswordSchema,
  totpSecret: totpSecretSchema,
  totpCode: totpCodeSchema,
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
```

and `src/shared/auth.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loginRequestSchema, setupRequestSchema } from './auth';

describe('auth request schemas', () => {
  it('require a 12+ character password, a base32 secret and a 6-digit code at setup', () => {
    const ok = { setupToken: 't', password: 'twelve chars', totpSecret: 'A'.repeat(32), totpCode: '123456' };
    expect(setupRequestSchema.safeParse(ok).success).toBe(true);
    expect(setupRequestSchema.safeParse({ ...ok, password: 'eleven char' }).success).toBe(false);
    expect(setupRequestSchema.safeParse({ ...ok, totpSecret: 'a'.repeat(32) }).success).toBe(false);
    expect(setupRequestSchema.safeParse({ ...ok, totpCode: '12345' }).success).toBe(false);
  });

  it('require exactly one second factor at login', () => {
    expect(loginRequestSchema.safeParse({ password: 'p', totpCode: '123456' }).success).toBe(true);
    expect(loginRequestSchema.safeParse({ password: 'p', recoveryCode: 'AAAA-BBBB-CCCC' }).success).toBe(true);
    expect(loginRequestSchema.safeParse({ password: 'p' }).success).toBe(false);
    expect(
      loginRequestSchema.safeParse({ password: 'p', totpCode: '123456', recoveryCode: 'AAAA-BBBB-CCCC' }).success,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Write the failing route test** at `src/server/auth/setup-routes.test.ts`, with its helper `src/server/test/auth.ts`:

```ts
import { asc } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appUser, category, categoryGroup } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget, TEST_PASSWORD } from '../test/auth';
import { TEST_SETUP_TOKEN } from '../test/config';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { TestClient } from '../test/http-client';
import { totpCode } from '../test/totp';
import { verifyPassword } from './passwords';
import { decryptSecret } from './secret-box';
import { SESSION_COOKIE } from './sessions';

let t: TestDatabase;
let ctx: TestApp;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z' });
});
afterEach(async () => {
  await t.drop();
});

async function json(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('GET /api/auth/status', () => {
  it('asks for setup on a fresh install', async () => {
    expect(await json(await ctx.client.get('/api/auth/status'))).toEqual({
      status: 200,
      body: { setupRequired: true, authenticated: false },
    });
  });
});

describe('POST /api/auth/setup/totp', () => {
  it('requires the setup token from the environment', async () => {
    const res = await json(await ctx.client.post('/api/auth/setup/totp', { setupToken: 'guess' }));
    expect(res).toEqual({ status: 403, body: { code: 'invalid_setup_token', message: 'That setup token is not correct.' } });
  });

  it('returns a new authenticator secret and its otpauth URI', async () => {
    const res = await json(await ctx.client.post('/api/auth/setup/totp', { setupToken: TEST_SETUP_TOKEN }));
    expect(res.status).toBe(200);
    expect(res.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(res.body.uri).toContain(`secret=${String(res.body.secret)}`);
  });
});

describe('POST /api/auth/setup', () => {
  it('creates the user, seeds the budget, signs in and returns ten recovery codes', async () => {
    const { totpSecret, recoveryCodes } = await setUpBudget(ctx);
    expect(recoveryCodes).toHaveLength(10);
    expect(ctx.client.cookie(SESSION_COOKIE)).toBeDefined();
    expect(await json(await ctx.client.get('/api/auth/status'))).toEqual({
      status: 200,
      body: { setupRequired: false, authenticated: true },
    });

    const [user] = await t.db.select().from(appUser);
    expect(await verifyPassword(user!.passwordHash, TEST_PASSWORD)).toBe(true);
    expect(decryptSecret(user!.totpSecretEnc, ctx.config.encryptionKey)).toBe(totpSecret);
    expect(user!.recoveryCodeHashes).toHaveLength(10);
    expect(user!.budgetStartMonth).toBe('2026-11-01');

    const groups = await t.db.select().from(categoryGroup).orderBy(asc(categoryGroup.sortOrder));
    expect(groups.map((g) => [g.name, g.kind, g.hidden])).toEqual([
      ['Internal', 'internal', true],
      ['Credit Card Payments', 'cc_payments', false],
      ['Debt Payments', 'debt_payments', false],
    ]);
    const system = await t.db.select().from(category).orderBy(asc(category.sortOrder));
    expect(system.map((c) => [c.name, c.systemKind, c.groupId])).toEqual([
      ['Ready to Assign', 'rta', groups[0]!.id],
      ['Uncategorized', 'uncategorized', groups[0]!.id],
    ]);
  });

  it('uses the configured time zone for the budget start month', async () => {
    const lateNewYearsEve = createTestApp(t.db, { now: '2026-12-31T23:30:00Z' });
    await setUpBudget(lateNewYearsEve);
    const [user] = await t.db.select().from(appUser);
    expect(user!.budgetStartMonth).toBe('2027-01-01');
  });

  it('rejects a wrong authenticator code without creating anything', async () => {
    const { secret } = (await (
      await ctx.client.post('/api/auth/setup/totp', { setupToken: TEST_SETUP_TOKEN })
    ).json()) as { secret: string };
    const later = new Date(ctx.clock.now().getTime() + 5 * 60_000);
    const res = await json(
      await ctx.client.post('/api/auth/setup', {
        setupToken: TEST_SETUP_TOKEN,
        password: TEST_PASSWORD,
        totpSecret: secret,
        totpCode: await totpCode(secret, later),
      }),
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_totp_code');
    expect(await t.db.select().from(appUser)).toEqual([]);
  });

  it('validates the request body', async () => {
    const res = await json(
      await ctx.client.post('/api/auth/setup', {
        setupToken: TEST_SETUP_TOKEN,
        password: 'too short',
        totpSecret: 'A'.repeat(32),
        totpCode: '123456',
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors).toEqual({ password: ['Use at least 12 characters.'] });
  });

  it('can run only once', async () => {
    await setUpBudget(ctx);
    const stranger = new TestClient(ctx.app, '198.51.100.9');
    const again = await json(await stranger.post('/api/auth/setup/totp', { setupToken: TEST_SETUP_TOKEN }));
    expect(again).toEqual({
      status: 409,
      body: { code: 'already_setup', message: 'This budget is already set up. Sign in instead.' },
    });
    expect(await json(await stranger.get('/api/auth/status'))).toEqual({
      status: 200,
      body: { setupRequired: false, authenticated: false },
    });
  });
});
```

```ts
import { totpCode } from './totp';
import type { TestApp } from './app';
import { TEST_SETUP_TOKEN } from './config';

export const TEST_PASSWORD = 'correct horse battery staple';

export interface SetupResult {
  totpSecret: string;
  recoveryCodes: string[];
}

/** Runs first-run setup through the API (leaving `client` signed in) and returns the secrets it created. */
export async function setUpBudget({ client, clock }: TestApp): Promise<SetupResult> {
  const totpResponse = await client.post('/api/auth/setup/totp', { setupToken: TEST_SETUP_TOKEN });
  const { secret } = (await totpResponse.json()) as { secret: string };
  const response = await client.post('/api/auth/setup', {
    setupToken: TEST_SETUP_TOKEN,
    password: TEST_PASSWORD,
    totpSecret: secret,
    totpCode: await totpCode(secret, clock.now()),
  });
  if (response.status !== 201) throw new Error(`setup failed: ${response.status} ${await response.text()}`);
  const { recoveryCodes } = (await response.json()) as { recoveryCodes: string[] };
  return { totpSecret: secret, recoveryCodes };
}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run --project server src/server/auth/setup-routes.test.ts`
Expected: FAIL — setup returns 404 (routes not mounted / module missing).

- [ ] **Step 4: Implement.** `src/server/db/seed.ts`:

```ts
import type { Executor } from './client';
import { category, categoryGroup } from './schema';

/**
 * Creates the rows every budget needs (spec §3): the hidden internal group with the Ready to Assign and
 * Uncategorized system categories, plus the groups that will hold credit card payment and debt categories.
 */
export async function seedBudget(db: Executor): Promise<void> {
  const [internal] = await db
    .insert(categoryGroup)
    .values({ name: 'Internal', kind: 'internal', hidden: true, sortOrder: 0 })
    .returning({ id: categoryGroup.id });
  await db.insert(category).values([
    { groupId: internal!.id, name: 'Ready to Assign', systemKind: 'rta', hidden: true, sortOrder: 0 },
    { groupId: internal!.id, name: 'Uncategorized', systemKind: 'uncategorized', hidden: true, sortOrder: 1 },
  ]);
  await db.insert(categoryGroup).values([
    { name: 'Credit Card Payments', kind: 'cc_payments', sortOrder: 1 },
    { name: 'Debt Payments', kind: 'debt_payments', sortOrder: 2 },
  ]);
}
```

`src/server/db/errors.ts`:

```ts
/** True when `error` (or the driver error Drizzle wraps as `cause`) is a Postgres unique violation (23505). */
export function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error || (typeof e === 'object' && e !== null); ) {
    if ((e as { code?: unknown }).code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
```

`src/server/auth/setup-routes.ts`:

```ts
import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import {
  type AuthStatus,
  type RecoveryCodesResponse,
  setupRequestSchema,
  setupTotpRequestSchema,
  type TotpSecretResponse,
} from '../../shared/auth';
import { monthIn } from '../clock';
import type { Executor } from '../db/client';
import { isUniqueViolation } from '../db/errors';
import { seedBudget } from '../db/seed';
import { appUser } from '../db/schema';
import type { AppDeps } from '../http/app';
import type { AppEnv } from '../http/env';
import { AppError, DomainError } from '../http/errors';
import { validate } from '../http/validate';
import { hashPassword } from './passwords';
import { generateRecoveryCodes, hashRecoveryCodes } from './recovery-codes';
import { encryptSecret } from './secret-box';
import { createSession, currentSession, setSessionCookie } from './sessions';
import { newTotpSecret, totpUri, verifyTotp } from './totp';

export async function isSetupComplete(db: Executor): Promise<boolean> {
  const rows = await db.select({ id: appUser.id }).from(appUser).limit(1);
  return rows.length > 0;
}

/** Constant-time comparison (hashing first makes the lengths equal). */
function tokensMatch(given: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

const alreadySetUp = () => new AppError(409, 'already_setup', 'This budget is already set up. Sign in instead.');

/** Spec §12 first-run setup: only while no user exists, and only with SETUP_TOKEN from the environment. */
export function setupRoutes(deps: AppDeps) {
  async function assertSetupAllowed(setupToken: string): Promise<void> {
    if (await isSetupComplete(deps.db)) throw alreadySetUp();
    if (!tokensMatch(setupToken, deps.config.setupToken)) {
      throw new AppError(403, 'invalid_setup_token', 'That setup token is not correct.');
    }
  }

  return new Hono<AppEnv>()
    .get('/status', async (c) => {
      const setupRequired = !(await isSetupComplete(deps.db));
      const authenticated = !setupRequired && (await currentSession(c, deps)) !== null;
      return c.json<AuthStatus>({ setupRequired, authenticated });
    })
    .post('/setup/totp', validate('json', setupTotpRequestSchema), async (c) => {
      await assertSetupAllowed(c.req.valid('json').setupToken);
      const secret = newTotpSecret();
      return c.json<TotpSecretResponse>({ secret, uri: totpUri(secret) });
    })
    .post('/setup', validate('json', setupRequestSchema), async (c) => {
      const body = c.req.valid('json');
      await assertSetupAllowed(body.setupToken);
      const now = deps.clock.now();
      if (!(await verifyTotp(body.totpSecret, body.totpCode, now))) {
        throw new DomainError(
          'invalid_totp_code',
          "That code didn't match. Check that your phone's clock is correct and try again.",
        );
      }
      const recoveryCodes = generateRecoveryCodes();
      const [passwordHash, recoveryCodeHashes] = await Promise.all([
        hashPassword(body.password),
        hashRecoveryCodes(recoveryCodes),
      ]);
      try {
        await deps.db.transaction(async (tx) => {
          await tx.insert(appUser).values({
            passwordHash,
            totpSecretEnc: encryptSecret(body.totpSecret, deps.config.encryptionKey),
            recoveryCodeHashes,
            budgetStartMonth: `${monthIn(deps.config.timeZone, now)}-01`,
          });
          await seedBudget(tx);
        });
      } catch (error) {
        // Two setups racing: the singleton index lets only one win.
        if (isUniqueViolation(error)) throw alreadySetUp();
        throw error;
      }
      const { token } = await createSession(deps.db, now, c.req.header('user-agent'));
      setSessionCookie(c, token, deps.config.cookieSecure);
      return c.json<RecoveryCodesResponse>({ recoveryCodes }, 201);
    });
}
```

Replace `src/server/http/app.ts` with:

```ts
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import type { ApiErrorBody } from '../../shared/http';
import { setupRoutes } from '../auth/setup-routes';
import type { Clock } from '../clock';
import type { Config } from '../config';
import type { Db } from '../db/client';
import type { Logger } from '../logger';
import type { ClientIpResolver } from './client-ip';
import type { AppEnv } from './env';
import { errorHandler } from './errors';
import { csrfGuard, requestLogger } from './middleware';

export interface AppDeps {
  db: Db;
  config: Config;
  clock: Clock;
  logger: Logger;
  clientIp: ClientIpResolver;
}

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>()
    .use(requestId())
    .use(requestLogger(deps.logger))
    .use(
      secureHeaders({
        contentSecurityPolicy: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
        },
        referrerPolicy: 'no-referrer',
        xFrameOptions: 'DENY',
      }),
    )
    .use('/api/*', csrfGuard())
    .get('/healthz', async (c) => {
      try {
        await deps.db.execute(sql`select 1`);
        return c.json({ status: 'ok' as const });
      } catch (err) {
        c.var.logger.warn({ err }, 'health check failed');
        return c.json({ status: 'unavailable' as const }, 503);
      }
    })
    .route('/api/auth', setupRoutes(deps));

  app.notFound((c) => c.json<ApiErrorBody>({ code: 'not_found', message: 'Not found.' }, 404));
  app.onError(errorHandler);
  return app;
}

export type App = ReturnType<typeof createApp>;
```

- [ ] **Step 5: Run the tests**

Run: `npm test && npm run typecheck && npm run lint`
Expected: `Tests  237 passed (237)`; both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/shared/auth.ts src/shared/auth.test.ts src/server/db/seed.ts src/server/db/errors.ts src/server/auth/setup-routes.ts src/server/auth/setup-routes.test.ts src/server/test/auth.ts src/server/http/app.ts
git commit -m "feat(server): first-run setup with authenticator, recovery codes and budget seeding" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 8: Sign-in, sign-out, rate limiting and lockout

**Files:**
- Create: `src/server/auth/rate-limit.ts`, `src/server/auth/user.ts`, `src/server/auth/login-routes.ts`
- Modify: `src/server/http/app.ts`
- Test: `src/server/auth/login-routes.test.ts`

**Interfaces:**
- Consumes: Tasks 4–7.
- Produces:
  - `LOGIN_LIMITS`, `assertLoginAllowed(db, ip, now)` (429 `rate_limited` / `locked`), `recordLoginAttempt(db, ip, success, now)`
  - `AppUser`, `findUser(db): Promise<AppUser | null>`
  - `loginRoutes(deps)`: `POST /api/auth/login` `{ password, totpCode? | recoveryCode? }` → `LoginResponse { recoveryCodesRemaining }` + session cookie (401 `invalid_credentials`, 409 `setup_required`); `POST /api/auth/logout` (session) → `{ ok: true }`

- [ ] **Step 1: Write the failing test** at `src/server/auth/login-routes.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appUser, session } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { type SetupResult, setUpBudget, TEST_PASSWORD } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { TestClient } from '../test/http-client';
import { totpCode } from '../test/totp';
import { SESSION_COOKIE } from './sessions';

let t: TestDatabase;
let ctx: TestApp;
let setup: SetupResult;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db);
  setup = await setUpBudget(ctx);
});
afterEach(async () => {
  await t.drop();
});

const MINUTE = 60_000;

async function login(client: TestClient, body: Record<string, unknown>) {
  const res = await client.post('/api/auth/login', body);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function withCode(password = TEST_PASSWORD) {
  return { password, totpCode: await totpCode(setup.totpSecret, ctx.clock.now()) };
}

describe('POST /api/auth/login', () => {
  it('signs in with password and authenticator code', async () => {
    const client = new TestClient(ctx.app);
    expect(await login(client, await withCode())).toEqual({ status: 200, body: { recoveryCodesRemaining: 10 } });
    expect(client.cookie(SESSION_COOKIE)).toBeDefined();
    expect(await (await client.get('/api/auth/status')).json()).toEqual({ setupRequired: false, authenticated: true });
  });

  it('rejects a wrong password or code with the same message', async () => {
    const client = new TestClient(ctx.app);
    const wrongPassword = await login(client, await withCode('not my password'));
    const wrongCode = await login(client, { password: TEST_PASSWORD, totpCode: '000000' });
    for (const res of [wrongPassword, wrongCode]) {
      expect(res).toEqual({ status: 401, body: { code: 'invalid_credentials', message: 'Wrong password or code.' } });
    }
    expect(client.cookie(SESSION_COOKIE)).toBeUndefined();
  });

  it('accepts each recovery code once', async () => {
    const client = new TestClient(ctx.app);
    const code = setup.recoveryCodes[3]!;
    expect(await login(client, { password: TEST_PASSWORD, recoveryCode: code })).toEqual({
      status: 200,
      body: { recoveryCodesRemaining: 9 },
    });
    const [user] = await t.db.select().from(appUser);
    expect(user!.recoveryCodeHashes).toHaveLength(9);
    expect((await login(new TestClient(ctx.app), { password: TEST_PASSWORD, recoveryCode: code })).status).toBe(401);
  });

  it('does not burn a recovery code when the password is wrong', async () => {
    const code = setup.recoveryCodes[0]!;
    expect((await login(new TestClient(ctx.app), { password: 'wrong password', recoveryCode: code })).status).toBe(401);
    expect((await login(new TestClient(ctx.app), { password: TEST_PASSWORD, recoveryCode: code })).status).toBe(200);
  });

  it('limits each IP to 5 attempts per minute', async () => {
    const attacker = new TestClient(ctx.app, '198.51.100.66');
    for (let i = 0; i < 5; i++) expect((await login(attacker, { password: 'guess', totpCode: '000000' })).status).toBe(401);
    expect(await login(attacker, await withCode())).toEqual({
      status: 429,
      body: { code: 'rate_limited', message: 'Too many sign-in attempts. Wait a minute and try again.' },
    });
    expect((await login(new TestClient(ctx.app, '198.51.100.67'), await withCode())).status).toBe(200);
    ctx.clock.advance(MINUTE + 1);
    expect((await login(attacker, await withCode())).status).toBe(200);
  });

  it('locks sign-in for 15 minutes after 10 consecutive failures', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await login(new TestClient(ctx.app, `198.51.100.${i}`), { password: 'guess', totpCode: '000000' });
      expect(res.status).toBe(401);
    }
    const owner = new TestClient(ctx.app);
    expect(await login(owner, await withCode())).toEqual({
      status: 429,
      body: { code: 'locked', message: 'Too many failed sign-ins. Try again in 15 minutes.' },
    });
    ctx.clock.advance(15 * MINUTE);
    expect((await login(owner, await withCode())).status).toBe(200);
  });

  it('refuses sign-in before setup', async () => {
    const fresh = await createTestDatabase();
    try {
      const other = createTestApp(fresh.db);
      expect(await login(other.client, { password: TEST_PASSWORD, totpCode: '123456' })).toEqual({
        status: 409,
        body: { code: 'setup_required', message: 'Finish setting up the budget first.' },
      });
    } finally {
      await fresh.drop();
    }
  });
});

describe('POST /api/auth/logout', () => {
  it('ends the current session only', async () => {
    const phone = new TestClient(ctx.app);
    await login(phone, await withCode());
    expect(await t.db.select().from(session)).toHaveLength(2); // setup's session + phone

    const res = await phone.post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(phone.cookie(SESSION_COOKIE)).toBeUndefined();
    expect(await (await phone.get('/api/auth/status')).json()).toEqual({ setupRequired: false, authenticated: false });
    expect(await (await ctx.client.get('/api/auth/status')).json()).toEqual({ setupRequired: false, authenticated: true });
  });

  it('requires a session', async () => {
    expect((await new TestClient(ctx.app).post('/api/auth/logout')).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project server src/server/auth/login-routes.test.ts`
Expected: FAIL — `/api/auth/login` returns 404.

- [ ] **Step 3: Implement.** `src/server/auth/rate-limit.ts`:

```ts
import { and, count, desc, eq, gt, lt } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { loginAttempt } from '../db/schema';
import { AppError } from '../http/errors';

/** Spec §12: 5 login attempts per minute per IP; 10 consecutive failures lock login for 15 minutes. */
export const LOGIN_LIMITS = {
  attemptsPerMinute: 5,
  lockoutAfterFailures: 10,
  lockoutMs: 15 * 60 * 1000,
} as const;

const MINUTE_MS = 60 * 1000;
const RETENTION_MS = 24 * 60 * 60 * 1000;

/** Throws 429 when `ip` has used up its attempts this minute, or while login is locked out. */
export async function assertLoginAllowed(db: Executor, ip: string, now: Date): Promise<void> {
  const [recent] = await db
    .select({ n: count() })
    .from(loginAttempt)
    .where(and(eq(loginAttempt.ip, ip), gt(loginAttempt.at, new Date(now.getTime() - MINUTE_MS))));
  if ((recent?.n ?? 0) >= LOGIN_LIMITS.attemptsPerMinute) {
    throw new AppError(429, 'rate_limited', 'Too many sign-in attempts. Wait a minute and try again.');
  }

  const latest = await db
    .select({ at: loginAttempt.at, success: loginAttempt.success })
    .from(loginAttempt)
    .orderBy(desc(loginAttempt.at), desc(loginAttempt.id))
    .limit(LOGIN_LIMITS.lockoutAfterFailures);
  const lockedOut =
    latest.length === LOGIN_LIMITS.lockoutAfterFailures &&
    latest.every((attempt) => !attempt.success) &&
    now.getTime() - latest[0]!.at.getTime() < LOGIN_LIMITS.lockoutMs;
  if (lockedOut) {
    throw new AppError(429, 'locked', 'Too many failed sign-ins. Try again in 15 minutes.');
  }
}

export async function recordLoginAttempt(db: Executor, ip: string, success: boolean, now: Date): Promise<void> {
  await db.insert(loginAttempt).values({ ip, success, at: now });
  await db.delete(loginAttempt).where(lt(loginAttempt.at, new Date(now.getTime() - RETENTION_MS)));
}
```

`src/server/auth/user.ts`:

```ts
import type { Executor } from '../db/client';
import { appUser } from '../db/schema';

export type AppUser = typeof appUser.$inferSelect;

/** The single budget owner, or null before first-run setup. */
export async function findUser(db: Executor): Promise<AppUser | null> {
  const [user] = await db.select().from(appUser).limit(1);
  return user ?? null;
}
```

`src/server/auth/login-routes.ts`:

```ts
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { loginRequestSchema } from '../../shared/auth';
import { appUser } from '../db/schema';
import type { AppDeps } from '../http/app';
import type { AppEnv } from '../http/env';
import { AppError } from '../http/errors';
import { validate } from '../http/validate';
import { verifyPassword } from './passwords';
import { assertLoginAllowed, recordLoginAttempt } from './rate-limit';
import { consumeRecoveryCode } from './recovery-codes';
import { decryptSecret } from './secret-box';
import { clearSessionCookie, createSession, deleteSession, requireSession, setSessionCookie } from './sessions';
import { verifyTotp } from './totp';
import { findUser } from './user';

export interface LoginResponse {
  /** How many unused recovery codes are left (the UI warns when it gets low). */
  recoveryCodesRemaining: number;
}

export function loginRoutes(deps: AppDeps) {
  return new Hono<AppEnv>()
    .post('/login', validate('json', loginRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const ip = deps.clientIp(c);
      const now = deps.clock.now();
      await assertLoginAllowed(deps.db, ip, now);

      const user = await findUser(deps.db);
      if (!user) throw new AppError(409, 'setup_required', 'Finish setting up the budget first.');

      let ok = await verifyPassword(user.passwordHash, body.password);
      let recoveryCodeHashes = user.recoveryCodeHashes;
      if (ok && body.totpCode !== undefined) {
        ok = await verifyTotp(decryptSecret(user.totpSecretEnc, deps.config.encryptionKey), body.totpCode, now);
      } else if (ok && body.recoveryCode !== undefined) {
        const remaining = await consumeRecoveryCode(user.recoveryCodeHashes, body.recoveryCode);
        ok = remaining !== null;
        if (remaining) {
          recoveryCodeHashes = remaining;
          await deps.db.update(appUser).set({ recoveryCodeHashes: remaining }).where(eq(appUser.id, user.id));
        }
      }
      await recordLoginAttempt(deps.db, ip, ok, now);
      if (!ok) throw new AppError(401, 'invalid_credentials', 'Wrong password or code.');

      const { token } = await createSession(deps.db, now, c.req.header('user-agent'));
      setSessionCookie(c, token, deps.config.cookieSecure);
      return c.json<LoginResponse>({ recoveryCodesRemaining: recoveryCodeHashes.length });
    })
    .post('/logout', requireSession(deps), async (c) => {
      await deleteSession(deps.db, c.var.session.id);
      clearSessionCookie(c, deps.config.cookieSecure);
      return c.json({ ok: true as const });
    });
}
```

Replace `src/server/http/app.ts` with:

```ts
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import type { ApiErrorBody } from '../../shared/http';
import { loginRoutes } from '../auth/login-routes';
import { setupRoutes } from '../auth/setup-routes';
import type { Clock } from '../clock';
import type { Config } from '../config';
import type { Db } from '../db/client';
import type { Logger } from '../logger';
import type { ClientIpResolver } from './client-ip';
import type { AppEnv } from './env';
import { errorHandler } from './errors';
import { csrfGuard, requestLogger } from './middleware';

export interface AppDeps {
  db: Db;
  config: Config;
  clock: Clock;
  logger: Logger;
  clientIp: ClientIpResolver;
}

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>()
    .use(requestId())
    .use(requestLogger(deps.logger))
    .use(
      secureHeaders({
        contentSecurityPolicy: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
        },
        referrerPolicy: 'no-referrer',
        xFrameOptions: 'DENY',
      }),
    )
    .use('/api/*', csrfGuard())
    .get('/healthz', async (c) => {
      try {
        await deps.db.execute(sql`select 1`);
        return c.json({ status: 'ok' as const });
      } catch (err) {
        c.var.logger.warn({ err }, 'health check failed');
        return c.json({ status: 'unavailable' as const }, 503);
      }
    })
    .route('/api/auth', setupRoutes(deps))
    .route('/api/auth', loginRoutes(deps));

  app.notFound((c) => c.json<ApiErrorBody>({ code: 'not_found', message: 'Not found.' }, 404));
  app.onError(errorHandler);
  return app;
}

export type App = ReturnType<typeof createApp>;
```

- [ ] **Step 4: Run the tests**

Run: `npm test && npm run typecheck && npm run lint`
Expected: `Tests  246 passed (246)`; both exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/server/auth src/server/http/app.ts
git commit -m "feat(server): sign-in with TOTP or recovery code, sign-out, rate limiting and lockout" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 9: Security settings

Spec §11/§12 Settings: log out all sessions, change password (signs out every other session), rotate the authenticator secret, regenerate recovery codes. Each change re-checks the current password (and the current TOTP code where a new secret isn't being confirmed). None is undoable.

**Files:**
- Create: `src/server/auth/security-routes.ts`
- Modify: `src/server/http/app.ts`
- Test: `src/server/auth/security-routes.test.ts`

**Interfaces:**
- Consumes: Tasks 5–8.
- Produces `securityRoutes(deps)` (all require a session, applied per route):
  - `POST /api/auth/logout-all` → `{ ok: true }`
  - `POST /api/auth/password` `{ currentPassword, newPassword, totpCode }` → `{ ok: true }` (422 `invalid_credentials`)
  - `POST /api/auth/totp/secret` → `TotpSecretResponse`
  - `POST /api/auth/totp` `{ currentPassword, totpSecret, totpCode }` → `{ ok: true }` (422 `invalid_totp_code`)
  - `POST /api/auth/recovery-codes` `{ currentPassword, totpCode }` → `RecoveryCodesResponse`

- [ ] **Step 1: Write the failing test** at `src/server/auth/security-routes.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appUser, session } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { type SetupResult, setUpBudget, TEST_PASSWORD } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { TestClient } from '../test/http-client';
import { totpCode } from '../test/totp';
import { verifyPassword } from './passwords';
import { decryptSecret } from './secret-box';
import { SESSION_COOKIE } from './sessions';

let t: TestDatabase;
let ctx: TestApp;
let setup: SetupResult;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db);
  setup = await setUpBudget(ctx);
});
afterEach(async () => {
  await t.drop();
});

const NEW_PASSWORD = 'an even better passphrase';

async function call(client: TestClient, path: string, body?: unknown) {
  const res = await client.post(path, body);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function signIn(ip: string, password = TEST_PASSWORD, secret = setup.totpSecret) {
  const client = new TestClient(ctx.app, ip);
  const res = await client.post('/api/auth/login', { password, totpCode: await totpCode(secret, ctx.clock.now()) });
  return { client, status: res.status };
}

const code = () => totpCode(setup.totpSecret, ctx.clock.now());

describe('security settings', () => {
  it('require a session', async () => {
    for (const path of ['/api/auth/logout-all', '/api/auth/password', '/api/auth/totp/secret', '/api/auth/totp', '/api/auth/recovery-codes']) {
      expect((await new TestClient(ctx.app).post(path, {})).status).toBe(401);
    }
  });
});

describe('routing', () => {
  it('leaves other /api/auth paths alone', async () => {
    expect((await new TestClient(ctx.app).get('/api/auth/nope')).status).toBe(404);
  });
});

describe('POST /api/auth/logout-all', () => {
  it('ends every session, including the current one', async () => {
    const { client: laptop } = await signIn('198.51.100.1');
    expect((await call(ctx.client, '/api/auth/logout-all')).status).toBe(200);
    expect(ctx.client.cookie(SESSION_COOKIE)).toBeUndefined();
    expect(await t.db.select().from(session)).toEqual([]);
    expect((await laptop.get('/api/auth/status').then((r) => r.json()))).toEqual({ setupRequired: false, authenticated: false });
  });
});

describe('POST /api/auth/password', () => {
  it('changes the password and signs out every other session', async () => {
    const { client: laptop } = await signIn('198.51.100.1');
    const res = await call(ctx.client, '/api/auth/password', {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
      totpCode: await code(),
    });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    const [user] = await t.db.select().from(appUser);
    expect(await verifyPassword(user!.passwordHash, NEW_PASSWORD)).toBe(true);
    expect(await laptop.get('/api/auth/status').then((r) => r.json())).toMatchObject({ authenticated: false });
    expect(await ctx.client.get('/api/auth/status').then((r) => r.json())).toMatchObject({ authenticated: true });
    expect((await signIn('198.51.100.2', NEW_PASSWORD)).status).toBe(200);
  });

  it('refuses without the current password and code', async () => {
    const res = await call(ctx.client, '/api/auth/password', {
      currentPassword: 'not it',
      newPassword: NEW_PASSWORD,
      totpCode: await code(),
    });
    expect(res).toEqual({
      status: 422,
      body: { code: 'invalid_credentials', message: 'Your current password or code is wrong.' },
    });
    const wrongCode = await call(ctx.client, '/api/auth/password', {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
      totpCode: '000000',
    });
    expect(wrongCode.status).toBe(422);
  });
});

describe('authenticator rotation', () => {
  it('switches to a new secret once a code from it is confirmed', async () => {
    const { body } = await call(ctx.client, '/api/auth/totp/secret');
    const newSecret = body.secret as string;
    expect(newSecret).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.uri).toContain(newSecret);

    const res = await call(ctx.client, '/api/auth/totp', {
      currentPassword: TEST_PASSWORD,
      totpSecret: newSecret,
      totpCode: await totpCode(newSecret, ctx.clock.now()),
    });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    const [user] = await t.db.select().from(appUser);
    expect(decryptSecret(user!.totpSecretEnc, ctx.config.encryptionKey)).toBe(newSecret);
    expect((await signIn('198.51.100.3', TEST_PASSWORD, newSecret)).status).toBe(200);
    expect((await signIn('198.51.100.4', TEST_PASSWORD, setup.totpSecret)).status).toBe(401);
  });

  it('keeps the old secret if the confirmation code is wrong', async () => {
    const { body } = await call(ctx.client, '/api/auth/totp/secret');
    const res = await call(ctx.client, '/api/auth/totp', {
      currentPassword: TEST_PASSWORD,
      totpSecret: body.secret,
      totpCode: '000000',
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_totp_code');
    const [user] = await t.db.select().from(appUser);
    expect(decryptSecret(user!.totpSecretEnc, ctx.config.encryptionKey)).toBe(setup.totpSecret);
  });
});

describe('POST /api/auth/recovery-codes', () => {
  it('replaces all recovery codes', async () => {
    const res = await call(ctx.client, '/api/auth/recovery-codes', { currentPassword: TEST_PASSWORD, totpCode: await code() });
    expect(res.status).toBe(200);
    const fresh = res.body.recoveryCodes as string[];
    expect(fresh).toHaveLength(10);
    const oldCode = await new TestClient(ctx.app, '198.51.100.5').post('/api/auth/login', {
      password: TEST_PASSWORD,
      recoveryCode: setup.recoveryCodes[0],
    });
    expect(oldCode.status).toBe(401);
    const newCode = await new TestClient(ctx.app, '198.51.100.6').post('/api/auth/login', {
      password: TEST_PASSWORD,
      recoveryCode: fresh[0],
    });
    expect(newCode.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project server src/server/auth/security-routes.test.ts`
Expected: FAIL — the security endpoints return 404 (and the "require a session" test sees 404 instead of 401).

- [ ] **Step 3: Implement** `src/server/auth/security-routes.ts`:

```ts
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  changePasswordRequestSchema,
  confirmTotpRequestSchema,
  reauthRequestSchema,
  type RecoveryCodesResponse,
  type TotpSecretResponse,
} from '../../shared/auth';
import { appUser } from '../db/schema';
import type { AppDeps } from '../http/app';
import type { AppEnv } from '../http/env';
import { AppError, DomainError } from '../http/errors';
import { validate } from '../http/validate';
import { hashPassword, verifyPassword } from './passwords';
import { generateRecoveryCodes, hashRecoveryCodes } from './recovery-codes';
import { decryptSecret, encryptSecret } from './secret-box';
import { clearSessionCookie, deleteAllSessions, requireSession } from './sessions';
import { newTotpSecret, totpUri, verifyTotp } from './totp';
import { type AppUser, findUser } from './user';

const wrongCredentials = () => new DomainError('invalid_credentials', 'Your current password or code is wrong.');

/** Settings → Security (spec §11/§12). Every change re-checks the current password; none is undoable. */
export function securityRoutes(deps: AppDeps) {
  async function owner(): Promise<AppUser> {
    const user = await findUser(deps.db);
    if (!user) throw new AppError(409, 'setup_required', 'Finish setting up the budget first.');
    return user;
  }

  async function reauthenticate(currentPassword: string, totpCode?: string): Promise<AppUser> {
    const user = await owner();
    if (!(await verifyPassword(user.passwordHash, currentPassword))) throw wrongCredentials();
    if (totpCode !== undefined) {
      const secret = decryptSecret(user.totpSecretEnc, deps.config.encryptionKey);
      if (!(await verifyTotp(secret, totpCode, deps.clock.now()))) throw wrongCredentials();
    }
    return user;
  }

  // Per-route (not .use) so the guard can't leak onto other /api/auth routes mounted at the same prefix.
  const signedIn = requireSession(deps);

  return new Hono<AppEnv>()
    .post('/logout-all', signedIn, async (c) => {
      await deleteAllSessions(deps.db);
      clearSessionCookie(c, deps.config.cookieSecure);
      return c.json({ ok: true as const });
    })
    .post('/password', signedIn, validate('json', changePasswordRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const user = await reauthenticate(body.currentPassword, body.totpCode);
      const passwordHash = await hashPassword(body.newPassword);
      await deps.db.transaction(async (tx) => {
        await tx.update(appUser).set({ passwordHash }).where(eq(appUser.id, user.id));
        await deleteAllSessions(tx, { exceptId: c.var.session.id });
      });
      return c.json({ ok: true as const });
    })
    .post('/totp/secret', signedIn, async (c) => {
      const secret = newTotpSecret();
      return c.json<TotpSecretResponse>({ secret, uri: totpUri(secret) });
    })
    .post('/totp', signedIn, validate('json', confirmTotpRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const user = await reauthenticate(body.currentPassword);
      if (!(await verifyTotp(body.totpSecret, body.totpCode, deps.clock.now()))) {
        throw new DomainError('invalid_totp_code', "That code didn't match the new authenticator entry.");
      }
      await deps.db
        .update(appUser)
        .set({ totpSecretEnc: encryptSecret(body.totpSecret, deps.config.encryptionKey) })
        .where(eq(appUser.id, user.id));
      return c.json({ ok: true as const });
    })
    .post('/recovery-codes', signedIn, validate('json', reauthRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const user = await reauthenticate(body.currentPassword, body.totpCode);
      const recoveryCodes = generateRecoveryCodes();
      await deps.db
        .update(appUser)
        .set({ recoveryCodeHashes: await hashRecoveryCodes(recoveryCodes) })
        .where(eq(appUser.id, user.id));
      return c.json<RecoveryCodesResponse>({ recoveryCodes });
    });
}
```

Replace `src/server/http/app.ts` with:

```ts
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import type { ApiErrorBody } from '../../shared/http';
import { loginRoutes } from '../auth/login-routes';
import { securityRoutes } from '../auth/security-routes';
import { setupRoutes } from '../auth/setup-routes';
import type { Clock } from '../clock';
import type { Config } from '../config';
import type { Db } from '../db/client';
import type { Logger } from '../logger';
import type { ClientIpResolver } from './client-ip';
import type { AppEnv } from './env';
import { errorHandler } from './errors';
import { csrfGuard, requestLogger } from './middleware';

export interface AppDeps {
  db: Db;
  config: Config;
  clock: Clock;
  logger: Logger;
  clientIp: ClientIpResolver;
}

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>()
    .use(requestId())
    .use(requestLogger(deps.logger))
    .use(
      secureHeaders({
        contentSecurityPolicy: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
        },
        referrerPolicy: 'no-referrer',
        xFrameOptions: 'DENY',
      }),
    )
    .use('/api/*', csrfGuard())
    .get('/healthz', async (c) => {
      try {
        await deps.db.execute(sql`select 1`);
        return c.json({ status: 'ok' as const });
      } catch (err) {
        c.var.logger.warn({ err }, 'health check failed');
        return c.json({ status: 'unavailable' as const }, 503);
      }
    })
    .route('/api/auth', setupRoutes(deps))
    .route('/api/auth', loginRoutes(deps))
    .route('/api/auth', securityRoutes(deps));

  app.notFound((c) => c.json<ApiErrorBody>({ code: 'not_found', message: 'Not found.' }, 404));
  app.onError(errorHandler);
  return app;
}

export type App = ReturnType<typeof createApp>;
```

- [ ] **Step 4: Run the tests**

Run: `npm test && npm run typecheck && npm run lint`
Expected: `Tests  254 passed (254)`; both exit 0.

- [ ] **Step 5: Prove the per-route guard matters.** Temporarily add `.use(signedIn)` right after `return new Hono<AppEnv>()` in `security-routes.ts`, run `npx vitest run --project server src/server/auth/security-routes.test.ts -t "leaves other"` — expected FAIL (`expected 401 to be 404`). Revert the line and re-run: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/auth/security-routes.ts src/server/auth/security-routes.test.ts src/server/http/app.ts
git commit -m "feat(server): security settings (logout everywhere, password, authenticator, recovery codes)" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 10: Entrypoint, container image, compose and docs

**Files:**
- Create: `src/server/main.ts`, `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.env.example`, `README.md`
- Modify: `package.json` (scripts), `docs/superpowers/specs/2026-11-19-core-budgeting-design.md`, `docs/superpowers/notes/p2-carry-over.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `npm run dev` (tsx watch, reads `.env`), `npm run build` (esbuild bundle → `dist/server/main.js`), `npm start`; a Docker image that migrates on start and serves on port 3000 with a `/healthz` health check; `docker compose up` with Postgres 16.

- [ ] **Step 1: Entrypoint.** Create `src/server/main.ts`:

```ts
import { serve } from '@hono/node-server';
import { systemClock } from './clock';
import { loadConfig } from './config';
import { createDatabase } from './db/client';
import { runMigrations } from './db/migrate';
import { createApp } from './http/app';
import { clientIpResolver } from './http/client-ip';
import { createLogger } from './logger';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const database = createDatabase(config.databaseUrl);

  await runMigrations(database.db, config.migrationsDir);
  logger.info('database migrations applied');

  const app = createApp({
    db: database.db,
    config,
    clock: systemClock,
    logger,
    clientIp: clientIpResolver(config.trustProxy),
  });
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info({ port: info.port }, 'listening');
  });

  const shutdown = (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      database
        .close()
        .catch((err: unknown) => logger.error({ err }, 'error closing the database'))
        .finally(() => process.exit(0));
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  // The logger may not exist yet (e.g. invalid configuration), so print plainly.
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Scripts.** In `package.json` `"scripts"`, add:

```json
"dev": "tsx watch --env-file=.env src/server/main.ts",
"build": "esbuild src/server/main.ts --bundle --platform=node --format=esm --target=node22 --packages=external --sourcemap --outfile=dist/server/main.js",
"start": "node --enable-source-maps dist/server/main.js",
```

Run: `npm run build`
Expected: `dist/server/main.js` and `dist/server/main.js.map` are written (`⚡ Done`).

- [ ] **Step 3: Container files.** `Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    TZ=Europe/Warsaw \
    PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" > /dev/null || exit 1
CMD ["node", "--enable-source-maps", "dist/server/main.js"]
```

`.dockerignore`:

```text
node_modules
dist
coverage
.git
.superpowers
.env
docs
*.log
```

`docker-compose.yml`:

```yaml
# Local development and self-hosting: the app plus Postgres 16.
# Copy .env.example to .env and fill in the secrets first.
services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: budget
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: budget
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U budget -d budget']
      interval: 5s
      timeout: 3s
      retries: 20

  app:
    build: .
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://budget:${POSTGRES_PASSWORD}@db:5432/budget
      ENCRYPTION_KEY: ${ENCRYPTION_KEY:?set ENCRYPTION_KEY in .env}
      SETUP_TOKEN: ${SETUP_TOKEN:?set SETUP_TOKEN in .env}
      COOKIE_SECURE: ${COOKIE_SECURE:-true}
      TRUST_PROXY: ${TRUST_PROXY:-false}
      LOG_LEVEL: ${LOG_LEVEL:-info}
    ports:
      - '${APP_PORT:-3000}:3000'

volumes:
  pgdata:
```

`.env.example`:

```bash
# Copy to .env (never commit .env).

# Password for the bundled Postgres container (docker-compose only).
POSTGRES_PASSWORD=change-me

# 32 random bytes, base64: openssl rand -base64 32
ENCRYPTION_KEY=

# One-time token you type into the first-run setup page (16+ characters): openssl rand -hex 16
SETUP_TOKEN=

# Browsers only send Secure cookies over HTTPS (and http://localhost in most browsers).
# Set to false only for plain-http access on a trusted network.
COOKIE_SECURE=true

# true only when running behind a reverse proxy that sets X-Forwarded-For.
TRUST_PROXY=false

LOG_LEVEL=info
APP_PORT=3000

# Running the server outside Docker (npm run dev) also needs:
# DATABASE_URL=postgres://budget:change-me@localhost:5432/budget
```

- [ ] **Step 4: README.** Create `README.md`:

````markdown
# Budget Track

A personal, single-user budgeting app that follows YNAB's rules, with PLN as the budget currency. The design is in
[`docs/superpowers/specs/2026-11-19-core-budgeting-design.md`](docs/superpowers/specs/2026-11-19-core-budgeting-design.md).

Status: the budget engine (`src/engine`) and the server foundation are done: database schema, first-run setup, and
sign-in with password + authenticator app. The budgeting API and the phone UI are next.

## Requirements

- Node.js 22 and npm
- Docker. The server tests start Postgres 16 through Testcontainers, and `docker compose` runs the app.

## Run with Docker

```bash
cp .env.example .env   # fill in POSTGRES_PASSWORD, ENCRYPTION_KEY and SETUP_TOKEN
docker compose up -d --build
curl http://localhost:3000/healthz   # {"status":"ok"}
```

Set `APP_PORT` in `.env` if port 3000 is already taken. First-run setup (`/api/auth/setup`) needs the
`SETUP_TOKEN` from `.env`.

## Develop

```bash
npm install
npm test               # all tests (engine + server)
npm run test:engine    # pure engine tests only (no Docker needed)
npm run test:server    # server tests against a throwaway Postgres container
npm run typecheck
npm run lint
npm run dev            # server with reload; reads .env, which then also needs DATABASE_URL
npm run db:generate    # after editing src/server/db/schema.ts: writes a new SQL migration to drizzle/
```

Migrations in `drizzle/` run automatically when the server starts.

### Test containers

Docker Desktop's Enhanced Container Isolation blocks Testcontainers' Ryuk reaper, so it is disabled and the test run
stops its own container. If a run is killed part-way through, remove leftovers with:

```bash
docker rm -f $(docker ps -aq --filter label=org.testcontainers=true)
```

## Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | | Postgres connection URL |
| `ENCRYPTION_KEY` | yes | | 32 random bytes, base64 (`openssl rand -base64 32`); encrypts the authenticator secret |
| `SETUP_TOKEN` | yes | | One-time token for first-run setup (16+ characters) |
| `PORT` | no | `3000` | HTTP port |
| `TZ` | no | `Europe/Warsaw` | Time zone for "today" and month boundaries |
| `COOKIE_SECURE` | no | `true` | Secure flag on the session cookie |
| `TRUST_PROXY` | no | `false` | Take the client IP from `X-Forwarded-For` (behind a reverse proxy only) |
| `LOG_LEVEL` | no | `info` | pino log level |
| `MIGRATIONS_DIR` | no | `drizzle` | Folder with SQL migrations |
````

- [ ] **Step 5: Smoke-test the image** (use another port if 3080 is taken):

```bash
printf "POSTGRES_PASSWORD=smoke-%s\nENCRYPTION_KEY=%s\nSETUP_TOKEN=%s\nCOOKIE_SECURE=false\nAPP_PORT=3080\n" "$(openssl rand -hex 6)" "$(openssl rand -base64 32)" "$(openssl rand -hex 16)" > .env
docker compose -p bt-smoke up -d --build
sleep 10
curl -s http://127.0.0.1:3080/healthz
curl -s http://127.0.0.1:3080/api/auth/status
curl -s -X POST http://127.0.0.1:3080/api/auth/setup/totp -H 'content-type: application/json' -d '{"setupToken":"x"}'
docker compose -p bt-smoke stop app && docker compose -p bt-smoke logs app | grep -E "migrations|listening|shutting down"
docker compose -p bt-smoke down -v --rmi local && rm .env
```

Expected, in order: `{"status":"ok"}`; `{"setupRequired":true,"authenticated":false}`; `{"code":"csrf","message":"Missing X-Requested-With header."}`; log lines `database migrations applied`, `listening`, `shutting down` (SIGTERM). `docker compose ps` showed `app` as `(healthy)` before stopping.

- [ ] **Step 6: Sync the spec and carry-over notes**

In `docs/superpowers/specs/2026-11-19-core-budgeting-design.md`:
- Replace the two lines starting `**Config (env):**` with:

```markdown
**Config (env):** `DATABASE_URL`, `ENCRYPTION_KEY` (32-byte key, base64, AES-256-GCM for the TOTP secret), `SETUP_TOKEN`,
`TZ=Europe/Warsaw`, `PORT`, `COOKIE_SECURE` (default true), `TRUST_PROXY` (default false; take the client IP from
`X-Forwarded-For`), `LOG_LEVEL`, `MIGRATIONS_DIR`. Sessions are opaque random tokens stored hashed, so no
session-signing secret is needed.
```

- After the line `  \`last_reconciled_at\`, \`last_reconciled_balance\`.` (in §4.2) add: `  \`account_class\` is a generated column (cash / credit / tracking) derived from \`type\`.`
- Replace `- \`scheduled_transaction\`: same template fields as \`transaction\` (no cleared/approved), plus \`frequency\`,` with `- \`scheduled_transaction\`: same template fields as \`transaction\` except cleared/approved and \`amount_base\` (the PLN amount is computed when an occurrence is entered), plus \`frequency\`,`
- In §4.6, after `parent's account and date. All engine aggregates come from this view.` add: `The view also exposes the native \`amount\` and \`is_starting_balance\`.`
- Under `**Server** (Vitest + Testcontainers Postgres)` add a bullet: `- Testcontainers runs with Ryuk disabled (Docker Desktop's Enhanced Container Isolation blocks it); the global teardown stops the container.`

In `docs/superpowers/notes/p2-carry-over.md`, delete the `## Engine purity lint` section (both bullet lines) and add at the end:

```markdown
## Resolved in P2a
- Engine purity lint now also blocks dynamic `import()`, `globalThis.*`, `Date.now()`, `new Date()` and `Math.random()`.
```

- [ ] **Step 7: Final verification and commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  28 passed (28)`, `Tests  254 passed (254)`; both exit 0.

```bash
git add src/server/main.ts package.json Dockerfile .dockerignore docker-compose.yml .env.example README.md docs
git commit -m "feat(server): entrypoint, container image, compose setup and docs" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Spec coverage (P2a)

| Spec | Task |
|---|---|
| §2 config, runtime, conventions (money/date types) | 1, 2, 10 |
| §3 account classes, system categories | 2, 7 |
| §4.1–§4.5 tables | 2 |
| §4.6 ledger view | 3 |
| §12 setup, login, sessions, rate limiting, CSRF, headers, secrets, settings | 4–9 |
| §13 error handling | 4 |
| §14 server: auth tests, Testcontainers | 2, 5–9 |
| §15 Dockerfile, compose, migrations on start, `/healthz` | 4, 10 |
| P2 carry-over: engine purity lint | 1 |

Deferred to P2b/P2c: every budgeting command and read model, undo/redo, scheduled job, NBP client, JSON export, static web serving (P3).
