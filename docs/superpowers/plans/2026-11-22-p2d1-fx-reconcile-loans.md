# P2d1 — FX, Reconcile and Loans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give foreign-currency accounts real NBP rates and give loans their interest. An NBP client with an `fx_rate` cache (`FxRates.quote`) and a rate lookup API; NBP default rates on every write that needs one (account creation, transactions, splits, transfers, date changes) with `fx_rate_manual` telling user rates from NBP's; "≈ X zł" on accounts and an undoable Revalue; the reconcile flow with its adjustment; loan balances with the synthetic interest and escrow of spec §8 everywhere a loan's balance shows, interest overrides, the loan schedule for the register, the loan panel of a paired category, and debt targets of foreign cards and loans in PLN.

**Architecture:** `src/server/fx/fx-rates.ts` implements the `FxRates` contract that P2d2 consumes: `quote(currency, date)` reads the `fx_rate` cache, else asks NBP (stepping back up to 7 days on 404, 5 s timeout for the whole quote), caches final rates, and returns null on any failure. `AppDeps.fx` carries it; tests get `stubFx`. **No NBP call ever runs inside a DB transaction or under the command lock:** routes quote first and pass the rates into the command or read. Transaction writes learn which rates they need from a dry run of P2c's planner (`default-rates.ts`): it plans the draft read-only with `PlanContext.unknownRates`, quotes what is missing, and the command plans again with `PlanContext.defaults`. A rate is now `Rate { rate, manual }`, so the plan stores `fx_rate_manual` from the rate's source, and `storedRates` drops NBP rates when the date changes. Account DTOs are built by `readAccounts`, which quotes each foreign currency's latest rate once per request. Revalue inserts its amount-0 row directly; the reconcile adjustment is a planned draft with a system payee. Loans get one source of truth, `loanBalances` + `loanCharges` (`src/server/loans/loan-balances.ts`): `computeLoanMonths` per loan from its transactions and overrides, with PLN values of the charges at the rate of the month's payments. `listAccounts` (so the accounts list, register header, reconcile, close and revalue) and `loadLinkedAccounts` (debt targets) add those charges. The loan panel joins the month view as `BudgetCategoryDto.loan`.

**Tech Stack:** Node 22, TypeScript 6, Hono 4 + @hono/zod-validator, zod 4, Drizzle ORM 0.45, postgres.js 4, Postgres 16, Vitest 5, @testcontainers/postgresql 11. No new dependencies (Node 22's `fetch` and `AbortSignal.timeout`, `node:http` in tests); no migration (every table exists).

**Spec:** `docs/superpowers/specs/2026-11-19-core-budgeting-design.md` (§2 config, §6 debt targets, §8 loans, §9 FX, §10 "Reconcile flow" and "Accounts", §11 Accounts, Register and the loan panel, §13, §14 golden scenarios 9 and 11 and "NBP client against a stubbed HTTP server"). P2d1 follows P2c (payees and transactions) and P2b2 (budget read model). P2d2 (scheduled transactions and the job, export, shutdown hardening) **consumes P2d1's `FxRates` (`deps.fx.quote`)**; P3 is the web app.

**Starting point and reconciling deltas:** every code block below was verified against a prototype base at `ee9007b`: `main` with P1, P2a and P2b1, plus the P2c prototype (its tasks 1–9) and the P2b2 branch merged. That suite is `Test Files  52 passed (52)`, `Tests  465 passed (465)`, and **every total below is stated against it**. **Branch `p2d1-…` from `main` after P2b2 and P2c have merged.** P2c's executed code may differ slightly from its prototype (review fixes, renamed helpers, extra tests): where a patch below doesn't apply, **reconcile the small delta by hand**, keeping what landed and applying this plan's intent, and add the test files and tests that landed beyond the prototype to every expected total. The files most likely to need that are `src/server/transactions/{rules,plan,aggregate,transaction-commands,transaction-routes}.ts`, `src/shared/api/{accounts,transactions}.ts`, `src/server/accounts/*`, the P2c tests patched here (`create-transaction.test.ts`, `account-routes.test.ts`), `app.test.ts`, the spec and both notes files. No migration is added, so nothing needs renumbering.

## Global Constraints

Inherited from P2a–P2c:
- Node `>=22`, npm, ESM. This machine has Node 22.14, so `@testcontainers/postgresql` must stay on `^11.14` (v12 pulls undici 8, which needs Node ≥ 22.19). Node 22's global `fetch` and `AbortSignal.timeout` are all the NBP client needs.
- TypeScript `strict` + `noUncheckedIndexedAccess`; `npm test`, `npm run typecheck` and `npm run lint` pass at the end of every task.
- Money is integer minor units: `bigint` columns in `mode: 'number'`; int8 values outside ±2^53 must throw, never lose precision. Native amounts of foreign accounts are minor units of their currency; FX rates are `numeric(14,6)` decimal strings.
- Calendar dates are `date` columns in `mode: 'string'` (`'YYYY-MM-DD'`); months are stored as the first day of the month (`'YYYY-MM-01'`); the API and the engine use `'YYYY-MM'`.
- `src/engine/**` stays pure; this plan doesn't change it.
- Error responses (spec §13): validation → 400 `{ code: "validation", message, fieldErrors, formErrors }` keyed by dotted paths; `DomainError` → 422 `{ code, message }` (plus `fieldErrors` when it names a field); undo conflicts → 409 `undo_conflict`; reconciled rows → 409 `confirm_reconciled`; unknown resource in the URL → 404 `not_found`.
- Every mutating `/api` request must carry `X-Requested-With: budget-track` (403 `csrf` otherwise).
- "Today" and month boundaries use the configured `TZ` (default `Europe/Warsaw`) via an injected `Clock`.
- Every commit message ends with the trailer `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.
- Every user command goes through `runCommand`: one transaction at READ COMMITTED under advisory lock 727274002, writing only through its `ChangeRecorder` and reading through `rec.tx`; it is one undo entry.
- No foreign key has an `ON DELETE` action. Every router outside `/api/auth` is mounted on its **own** prefix and starts with `.use('*', requireSession(deps))`; routers are built by chaining. New routes on an existing router (here `/api/accounts`) inherit its guard; `app.test.ts` lists every new route in its deny-by-default walk.
- Request schemas and DTO types live in `src/shared/api/`. SQL sums are cast in SQL (`sum(x)::bigint`).
- Every transaction write is planned (`Draft` → `planTransaction` → `insertPlan` / `syncPlan`); a `DomainError` about one field names it as a dotted path.
- Server tests use the harness: `createTestDatabase()` per test (`beforeEach`), `createTestApp(db, { now })`, `setUpBudget(ctx)`, the fixtures, and `snapshot(db)` for undo → redo round trips.
- Patches are shown as `git apply <<'PATCH' … PATCH` commands; run them from the repository root. (Making the same edits by hand is equivalent.)

New in P2d1:
- **NBP calls never run inside a DB transaction or under the command lock.** Quote with `deps.fx.quote` (or `latestRates`) first, then call `runCommand` or open the read transaction, and pass the rates in. Commands never see `deps.fx`.
- A rate the user sends is stored with `fx_rate_manual = true`, an NBP rate with `false`. Without either, a write that needs one answers 422 `fx_rate_required` with `fieldErrors.fxRate`.
- **A future-dated create (a one-time schedule, spec §5.6) never quotes NBP:** without `fxRate` it stores `fx_rate = null`, `fx_rate_manual = false` (P2d2's job resolves the NBP rate of the occurrence date); with `fxRate` it stores that rate as manual.
- Account DTOs in responses come from `readAccounts` / `readAccount`; inside commands, `listAccounts` / `getAccount` leave `latestRate` null.
- Every balance of a loan comes from `loanBalances` / `loanCharges`.
- Tests that need rates pass `createTestApp(db, { fx: stubFx({ EUR: '4.3' }) })` (or rates by date); the default stub quotes null for everything.

## File Structure

```
src/server/fx/fx-rates.ts                    FxQuote, FxRates (the P2d2 contract), nbpRates (cache + NBP client), latestRates,
                                             MAX_FALLBACK_DAYS, NBP_TIMEOUT_MS
src/server/fx/fx-routes.ts                   /api/fx: GET /rates/:currency/:date
src/server/test/fx.ts                        stubFx (StubFx with `calls`)
src/shared/api/fx.ts                         fxRateParamSchema, FxRateDto
src/server/transactions/default-rates.ts     createDefaultRates, editDefaultRates (dry-run planning, then NBP quotes)
src/server/accounts/revalue.ts               revalueAccount
src/server/accounts/reconcile.ts             reconcileStatus, reconcileAccount
src/server/loans/loan-balances.ts            LoanMonthRow, LoanBalances, loanBalances, loanCharges
src/server/loans/loan-commands.ts            getLoan, setInterestOverride, deleteInterestOverride
src/server/loans/loan-panel.ts               LoanInfo, loadLoanInfo, loanPanel
src/shared/api/loans.ts                      loanMonthParamSchema, interestOverrideRequestSchema, LoanMonthDto, LoanDto

Modified: src/server/config.ts (NBP_BASE_URL), src/server/http/app.ts (AppDeps.fx, /api/fx), src/server/main.ts,
src/server/test/{app,config}.ts, README.md, src/shared/api/{accounts,transactions,budget,targets}.ts, src/shared/http.ts,
src/server/accounts/{account-commands,account-queries,account-routes}.ts,
src/server/transactions/{rules,plan,aggregate,transaction-commands,transaction-queries,transaction-routes}.ts,
src/server/targets/target-model.ts, src/server/budget/{budget-month,budget-routes,auto-assign}.ts, the spec,
engineering-notes.md, p2-carry-over.md

Tests: src/server/fx/{fx-rates,fx-routes}.test.ts, src/server/transactions/fx-defaults.test.ts,
src/server/accounts/{revalue,reconcile}.test.ts, src/server/loans/{loan-balances,loan-routes,loan-panel}.test.ts; patched:
config.test.ts, app.test.ts, account-routes.test.ts, create-transaction.test.ts, target-model.test.ts,
budget-month.test.ts
```

## API added or changed in P2d1

All routes need a session. Amounts are signed minor units of the account's currency unless marked PLN.

| Method and path | Body / query | Response |
|---|---|---|
| `GET /api/fx/rates/:currency/:date` | – | 200 `{ rate, effectiveDate }`; 422 `fx_rate_unavailable` (also for a future date); 400 for PLN or a malformed code/date |
| `POST /api/accounts` | `fxRate` is now optional for foreign currencies | 201 `AccountDto`; 422 `fx_rate_required` when NBP has no rate for the starting date |
| `GET /api/accounts`, any `AccountDto` response | – | `AccountDto` gains `latestRate: { rate, effectiveDate } \| null` and `balanceAtLatestRate` (PLN) \| null; a loan's balances include its interest and escrow |
| `POST /api/accounts/:id/revalue` | optional `{ fxRate }` | 200 `{ account, transaction }`; 422 `revalue_pln` / `account_closed` / `fx_rate_required` / `revalue_no_difference` |
| `GET /api/accounts/:id/reconcile` | – | 200 `{ accountId, currency, clearedBalance, lastReconciledAt, lastReconciledBalance }` |
| `POST /api/accounts/:id/reconcile` | `{ statementBalance, createAdjustment? = false, fxRate? }` | 200 the status plus `{ adjustment: TransactionDto \| null, reconciledCount }`; 422 `reconcile_mismatch` `{ difference }` / `account_closed` / `fx_rate_required` |
| `GET /api/accounts/:id/loan` | – | 200 `LoanDto { accountId, currency, interestRate, minPayment, escrowAmount, months: LoanMonthDto[] }`; 422 `not_a_loan` |
| `PUT /api/accounts/:id/interest-overrides/:month` | `{ amount }` (≥ 0, loan currency) | 200 `LoanDto`; 422 `not_a_loan` / `month_out_of_range` |
| `DELETE /api/accounts/:id/interest-overrides/:month` | – | 200 `LoanDto`; 404 when the month has no override |
| `POST /api/transactions`, `PATCH /api/transactions/:id` | `fxRate` optional: NBP rate of the date otherwise | `TransactionDto` gains `fxRateManual`; 422 `fx_rate_required` when NBP has none; 422 `revaluation_fixed` for an FX revaluation's amounts |
| `GET /api/budget/:month` | – | `BudgetCategoryDto` gains `loan: LoanPanelDto \| null`; debt targets of foreign accounts in PLN |

`LoanMonthDto`: `{ month, startBalance, transactionsTotal, interest, interestBase, interestOverridden, escrow, escrowBase, endBalance, principalPaid, chargedOn, chargesCleared }`. `LoanPanelDto`: `{ accountId, accountName, currency, balance, balanceBase, interestRate, minPayment, escrowAmount, projectedPayoff ('YYYY-MM' | 'never'), recordPayment: { accountId, payeeId, categoryId, amount } }`.

---

### Task 1: NBP client and rate cache

Spec §9 "Default rate" and §14 "NBP client against a stubbed HTTP server". `src/server/fx/fx-rates.ts` defines the contract P2d2 consumes, exactly:

```ts
export interface FxQuote { rate: string; effectiveDate: IsoDate }
export interface FxRates { quote(currency: string, date: IsoDate): Promise<FxQuote | null> }
```

`nbpRates({ db, logger, clock, timeZone, baseUrl, timeoutMs? })` implements it:
- PLN, and anything that isn't three capital letters, is null without a request.
- The `fx_rate` row for (currency, date) answers first (source `nbp`, `effective_date` = the publication day used).
- Otherwise it GETs `{base}/api/exchangerates/rates/A/{code}/{date}/?format=json`. A 404 steps back one day, up to 7 days (8 requests at most); any other status, a malformed body (zod-checked: `rates[0].effectiveDate`, a positive `mid` below 10^8) or a network error ends the quote with null. One `AbortSignal.timeout(5 s)` covers the whole quote, fallback steps included.
- `mid` becomes a 6-digit string (`4.2315` → `"4.231500"`).
- Only **final** rates are cached: published that day, or for a past day or a weekend. Before NBP publishes today's table (around noon), today's quote falls back to yesterday and is fetched again on the next call.
- Failures are logged at warn (`'no NBP rate within 7 days'`, `'NBP rate unavailable'`); `quote` never throws.

`AppDeps` gains `fx: FxRates`; `main.ts` builds `nbpRates` from `NBP_BASE_URL` (default `https://api.nbp.pl`, trailing slashes dropped). `createTestApp(db, { fx })` takes a stub and defaults to `stubFx()`, which quotes null for everything; `stubFx({ EUR: '4.3' })` or `stubFx({ EUR: { '2026-11-19': '4.3' } })` answers with 6-digit rates dated the day asked and records `calls`.

The tests run the client against a `node:http` server on port 0: weekend fallback (and its cache row), a cache hit without a request, today's fallback not being cached, 8 days of 404 → null, a timeout (100 ms in the test) → null, malformed JSON / a bad `mid` / a 500 → null, and PLN, malformed codes and an unreachable server.

**Files:**
- Create: `src/server/fx/fx-rates.ts`, `src/server/test/fx.ts`
- Modify: `src/server/config.ts`, `src/server/test/config.ts`, `src/server/http/app.ts`, `src/server/main.ts`, `src/server/test/app.ts`, `README.md`
- Test: `src/server/fx/fx-rates.test.ts` (new), `src/server/config.test.ts`

**Interfaces:**
- Consumes: `addDays`, `weekday`, `IsoDate` (engine); `todayIn`, `Clock`; the `fx_rate` table; `Logger`; `BASE_CURRENCY`.
- Produces:
  - `FxQuote`, `FxRates`, `NbpRatesOptions`, `nbpRates(options): FxRates`, `MAX_FALLBACK_DAYS = 7`, `NBP_TIMEOUT_MS = 5000`.
  - `Config.nbpBaseUrl`; env `NBP_BASE_URL` (http or https URL).
  - `AppDeps.fx: FxRates`.
  - `StubFx extends FxRates { calls }`, `stubFx(rates?)`; `createTestApp(db, { config?, now?, fx? })`.

- [ ] **Step 1: Write the failing tests**

Create `src/server/fx/fx-rates.test.ts`:

```ts
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fxRate } from '../db/schema';
import { createLogger } from '../logger';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { FakeClock } from '../test/fake-clock';
import { type FxRates, nbpRates } from './fx-rates';

/** What the stub NBP server answers for a path: a status with a JSON body, or nothing at all (a hang). */
type Answer = { status: number; body?: unknown; raw?: string } | 'hang';

let t: TestDatabase;
let server: Server;
let requests: string[];
let answer: (path: string) => Answer;
let logs: { level: number; msg: string }[];
const hanging: ServerResponse[] = [];

beforeEach(async () => {
  t = await createTestDatabase();
  requests = [];
  logs = [];
  answer = () => ({ status: 404 });
  server = createServer((req, res) => {
    requests.push(req.url!);
    const reply = answer(req.url!);
    if (reply === 'hang') {
      hanging.push(res);
      return;
    }
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(reply.raw ?? (reply.body === undefined ? 'Not Found' : JSON.stringify(reply.body)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});
afterEach(async () => {
  for (const res of hanging.splice(0)) res.destroy();
  await new Promise((resolve) => server.close(resolve));
  await t.drop();
});

/** Friday 20 November 2026, 10:00 in Warsaw: today's table (published around noon) isn't out yet. */
function rates(options: { now?: string; timeoutMs?: number } = {}): FxRates {
  const { port } = server.address() as AddressInfo;
  return nbpRates({
    db: t.db,
    logger: createLogger('warn', { write: (line: string) => void logs.push(JSON.parse(line)) }),
    clock: new FakeClock(options.now ?? '2026-11-20T09:00:00Z'),
    timeZone: 'Europe/Warsaw',
    baseUrl: `http://127.0.0.1:${port}`,
    timeoutMs: options.timeoutMs,
  });
}

const path = (code: string, date: string) => `/api/exchangerates/rates/A/${code}/${date}/?format=json`;
const table = (code: string, effectiveDate: string, mid: number) => ({
  status: 200,
  body: { table: 'A', currency: 'euro', code, rates: [{ no: '225/A/NBP/2026', effectiveDate, mid }] },
});
const published = (days: Record<string, number>) => (url: string) => {
  const date = /\/(\d{4}-\d{2}-\d{2})\//.exec(url)![1]!;
  const mid = days[date];
  return mid === undefined ? { status: 404 } : table('EUR', date, mid);
};
const cache = () => t.db.select().from(fxRate);

describe('nbpRates', () => {
  it('steps back over a weekend to the last published day and caches the final rate', async () => {
    answer = published({ '2026-11-13': 4.2315 });
    const fx = rates();

    expect(await fx.quote('EUR', '2026-11-15')).toEqual({ rate: '4.231500', effectiveDate: '2026-11-13' });
    expect(requests).toEqual([path('EUR', '2026-11-15'), path('EUR', '2026-11-14'), path('EUR', '2026-11-13')]);
    expect(await cache()).toEqual([
      { currency: 'EUR', date: '2026-11-15', rate: '4.231500', source: 'nbp', effectiveDate: '2026-11-13' },
    ]);
  });

  it('answers from the cache without asking NBP', async () => {
    await t.db
      .insert(fxRate)
      .values({ currency: 'USD', date: '2026-11-18', rate: '3.912300', effectiveDate: '2026-11-18' });
    expect(await rates().quote('USD', '2026-11-18')).toEqual({ rate: '3.912300', effectiveDate: '2026-11-18' });
    expect(requests).toEqual([]);
  });

  it("doesn't cache today's fallback to yesterday, so today's table is fetched once it is out", async () => {
    answer = published({ '2026-11-19': 4.25 });
    const fx = rates();
    expect(await fx.quote('EUR', '2026-11-20')).toEqual({ rate: '4.250000', effectiveDate: '2026-11-19' });
    expect(await cache()).toEqual([]);

    answer = published({ '2026-11-19': 4.25, '2026-11-20': 4.26 });
    expect(await fx.quote('EUR', '2026-11-20')).toEqual({ rate: '4.260000', effectiveDate: '2026-11-20' });
    expect(await cache()).toMatchObject([{ date: '2026-11-20', rate: '4.260000', effectiveDate: '2026-11-20' }]);
    expect(requests).toHaveLength(3);
  });

  it('gives up after 7 days back (8 days of 404) and logs a warning', async () => {
    expect(await rates().quote('XAU', '2026-11-18')).toBeNull();
    expect(requests).toEqual(
      ['18', '17', '16', '15', '14', '13', '12', '11'].map((day) => path('XAU', `2026-11-${day}`)),
    );
    expect(logs).toMatchObject([{ level: 40, msg: 'no NBP rate within 7 days' }]);
    expect(await cache()).toEqual([]);
  });

  it('returns null when NBP times out', async () => {
    answer = () => 'hang';
    const started = Date.now();
    expect(await rates({ timeoutMs: 100 }).quote('EUR', '2026-11-18')).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(logs).toMatchObject([{ level: 40, msg: 'NBP rate unavailable' }]);
  });

  it('returns null for malformed answers and server errors', async () => {
    answer = () => ({ status: 200, raw: '{"rates": [' });
    expect(await rates().quote('EUR', '2026-11-18')).toBeNull();
    answer = () => ({ status: 200, body: { rates: [{ effectiveDate: '2026-11-18', mid: 'x' }] } });
    expect(await rates().quote('EUR', '2026-11-18')).toBeNull();
    answer = () => ({ status: 500, body: { error: 'boom' } });
    expect(await rates().quote('EUR', '2026-11-18')).toBeNull();
    // A server error is not a missing table: no stepping back.
    expect(requests).toHaveLength(3);
    expect(logs.map((l) => l.msg)).toEqual(Array(3).fill('NBP rate unavailable'));
    expect(await cache()).toEqual([]);
  });

  it('returns null without a request for PLN and malformed codes, and when NBP is unreachable', async () => {
    const fx = rates();
    expect(await fx.quote('PLN', '2026-11-18')).toBeNull();
    expect(await fx.quote('eur/../x', '2026-11-18')).toBeNull();
    expect(requests).toEqual([]);

    await new Promise((resolve) => server.close(resolve));
    expect(await fx.quote('EUR', '2026-11-18')).toBeNull();
    expect(logs).toMatchObject([{ level: 40, msg: 'NBP rate unavailable' }]);
  });
});
```

```bash
git apply <<'PATCH'
diff --git a/src/server/config.test.ts b/src/server/config.test.ts
index d1550cf..e67f7c1 100644
--- a/src/server/config.test.ts
+++ b/src/server/config.test.ts
@@ -21,6 +21,7 @@ describe('loadConfig', () => {
       trustProxy: false,
       logLevel: 'info',
       migrationsDir: 'drizzle',
+      nbpBaseUrl: 'https://api.nbp.pl',
     });
     expect(config.encryptionKey).toEqual(Buffer.alloc(32, 7));
   });
@@ -34,6 +35,7 @@ describe('loadConfig', () => {
       TRUST_PROXY: 'true',
       LOG_LEVEL: 'silent',
       MIGRATIONS_DIR: '/app/drizzle',
+      NBP_BASE_URL: 'http://localhost:8081/',
     });
     expect(config).toMatchObject({
       port: 8080,
@@ -42,6 +44,7 @@ describe('loadConfig', () => {
       trustProxy: true,
       logLevel: 'silent',
       migrationsDir: '/app/drizzle',
+      nbpBaseUrl: 'http://localhost:8081',
     });
   });
 
@@ -58,6 +61,7 @@ describe('loadConfig', () => {
     expect(() => loadConfig({ ...validEnv, TZ: 'Mars/Olympus' })).toThrow('TZ');
     expect(() => loadConfig({ ...validEnv, SETUP_TOKEN: 'short' })).toThrow('SETUP_TOKEN');
     expect(() => loadConfig({ ...validEnv, COOKIE_SECURE: 'yes' })).toThrow('COOKIE_SECURE');
+    expect(() => loadConfig({ ...validEnv, NBP_BASE_URL: 'ftp://api.nbp.pl' })).toThrow('NBP_BASE_URL');
   });
 
   it('rejects setup tokens longer than 256 characters', () => {
PATCH
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project server src/server/fx src/server/config.test.ts`
Expected: FAIL, `Test Files  2 failed (2)`, `Tests  3 failed | 3 passed (6)`: `fx-rates.test.ts` can't load (`Cannot find module './fx-rates'`), and the config tests miss `nbpBaseUrl` and don't reject `ftp://`.

- [ ] **Step 3: Add the configuration**

```bash
git apply <<'PATCH'
diff --git a/README.md b/README.md
index 9e06e58..5b696c8 100644
--- a/README.md
+++ b/README.md
@@ -66,3 +66,4 @@ docker rm -f $(docker ps -aq --filter label=org.testcontainers=true)
 | `TRUST_PROXY` | no | `false` | Take the client IP from `X-Forwarded-For` (behind a reverse proxy only) |
 | `LOG_LEVEL` | no | `info` | pino log level |
 | `MIGRATIONS_DIR` | no | `drizzle` | Folder with SQL migrations |
+| `NBP_BASE_URL` | no | `https://api.nbp.pl` | NBP exchange-rate API for foreign-currency accounts (outbound HTTPS) |
diff --git a/src/server/config.ts b/src/server/config.ts
index 2c7770f..adaca48 100644
--- a/src/server/config.ts
+++ b/src/server/config.ts
@@ -25,6 +25,10 @@ const EnvSchema = z.object({
   TRUST_PROXY: booleanString.default(false),
   LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
   MIGRATIONS_DIR: z.string().default('drizzle'),
+  NBP_BASE_URL: z
+    .url({ protocol: /^https?$/, error: 'must be an http(s) URL, e.g. https://api.nbp.pl' })
+    .default('https://api.nbp.pl')
+    .transform((url) => url.replace(/\/+$/, '')),
 });
 
 export type LogLevel = (typeof LOG_LEVELS)[number];
@@ -43,6 +47,8 @@ export interface Config {
   trustProxy: boolean;
   logLevel: LogLevel;
   migrationsDir: string;
+  /** Origin of the NBP exchange-rate API (spec §9), without a trailing slash. */
+  nbpBaseUrl: string;
 }
 
 /** Parses and validates the process environment; throws one error listing every invalid variable. */
@@ -60,5 +66,6 @@ export function loadConfig(env: Record<string, string | undefined> = process.env
     trustProxy: e.TRUST_PROXY,
     logLevel: e.LOG_LEVEL,
     migrationsDir: e.MIGRATIONS_DIR,
+    nbpBaseUrl: e.NBP_BASE_URL,
   };
 }
diff --git a/src/server/test/config.ts b/src/server/test/config.ts
index 06bb654..aaf656b 100644
--- a/src/server/test/config.ts
+++ b/src/server/test/config.ts
@@ -14,6 +14,8 @@ export function testConfig(overrides: Partial<Config> = {}): Config {
     trustProxy: true,
     logLevel: 'silent',
     migrationsDir: 'drizzle',
+    // Tests use stubFx (src/server/test/fx.ts) or a local NBP stub server; nothing listens here.
+    nbpBaseUrl: 'http://127.0.0.1:9',
     ...overrides,
   };
 }
PATCH
```

- [ ] **Step 4: Add the NBP client**

Create `src/server/fx/fx-rates.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { BASE_CURRENCY } from '../../shared/api/accounts';
import { addDays, type IsoDate, weekday } from '../../engine';
import { type Clock, todayIn } from '../clock';
import type { Db } from '../db/client';
import { fxRate } from '../db/schema';
import type { Logger } from '../logger';

export interface FxQuote {
  /** NBP table A mid, a decimal string with 6 fraction digits, e.g. "4.312300" (it fits numeric(14,6)). */
  rate: string;
  /** The NBP publication day actually used (≤ the requested date, at most 7 days earlier). */
  effectiveDate: IsoDate;
}

export interface FxRates {
  /**
   * The NBP table A mid rate for `currency` on `date`: read from the fx_rate cache, otherwise fetched from NBP
   * (stepping back one day per 404, at most 7 days) and cached.
   * Returns null when the currency is PLN or unsupported, or NBP is unreachable or times out (5 s).
   * It never throws and is never called inside a DB transaction.
   */
  quote(currency: string, date: IsoDate): Promise<FxQuote | null>;
}

/** Spec §9: on a 404 (no table that day), step back one day at a time, up to 7 days. */
export const MAX_FALLBACK_DAYS = 7;
/** Spec §13: NBP never blocks a save for long. The timeout covers a whole quote, fallback steps included. */
export const NBP_TIMEOUT_MS = 5_000;

const nbpResponseSchema = z.object({
  rates: z
    .array(z.object({ effectiveDate: z.iso.date(), mid: z.number().positive().lt(1e8) }))
    .min(1),
});

export interface NbpRatesOptions {
  db: Db;
  logger: Logger;
  clock: Clock;
  timeZone: string;
  /** e.g. https://api.nbp.pl (no trailing slash). */
  baseUrl: string;
  timeoutMs?: number;
}

/**
 * A rate is final once NBP can't publish a newer one for that day: it was published on the day itself, or the day is
 * in the past or on a weekend (NBP publishes table A on working days, around noon). Only final rates are cached, so
 * today's fallback to yesterday is fetched again until today's table is out.
 */
function isFinal(date: IsoDate, quote: FxQuote, today: IsoDate): boolean {
  const day = weekday(date);
  return quote.effectiveDate === date || date < today || day === 0 || day === 6;
}

/** The fx_rate cache in front of the NBP API (spec §9). */
export function nbpRates(options: NbpRatesOptions): FxRates {
  const { db, logger, clock, timeZone, baseUrl } = options;
  const timeoutMs = options.timeoutMs ?? NBP_TIMEOUT_MS;

  async function fetchQuote(currency: string, date: IsoDate): Promise<FxQuote | null> {
    const signal = AbortSignal.timeout(timeoutMs);
    for (let back = 0; back <= MAX_FALLBACK_DAYS; back++) {
      const day = addDays(date, -back);
      const res = await fetch(`${baseUrl}/api/exchangerates/rates/A/${currency}/${day}/?format=json`, {
        headers: { accept: 'application/json' },
        signal,
      });
      if (res.status === 404) {
        await res.body?.cancel();
        continue;
      }
      if (!res.ok) throw new Error(`NBP answered ${res.status}`);
      const [entry] = nbpResponseSchema.parse(await res.json()).rates;
      if (entry!.effectiveDate > date) throw new Error(`NBP sent a rate for ${entry!.effectiveDate}`);
      return { rate: entry!.mid.toFixed(6), effectiveDate: entry!.effectiveDate };
    }
    return null;
  }

  return {
    async quote(currency, date) {
      // Unknown codes never reach the URL; PLN is the budget currency.
      if (currency === BASE_CURRENCY || !/^[A-Z]{3}$/.test(currency)) return null;
      try {
        const [cached] = await db
          .select({ rate: fxRate.rate, effectiveDate: fxRate.effectiveDate })
          .from(fxRate)
          .where(and(eq(fxRate.currency, currency), eq(fxRate.date, date)));
        if (cached) return cached;
        const quote = await fetchQuote(currency, date);
        if (!quote) {
          logger.warn({ currency, date }, `no NBP rate within ${MAX_FALLBACK_DAYS} days`);
          return null;
        }
        if (isFinal(date, quote, todayIn(timeZone, clock.now()))) {
          await db
            .insert(fxRate)
            .values({ currency, date, rate: quote.rate, source: 'nbp', effectiveDate: quote.effectiveDate })
            .onConflictDoNothing();
        }
        return quote;
      } catch (err) {
        logger.warn({ err, currency, date }, 'NBP rate unavailable');
        return null;
      }
    },
  };
}
```

- [ ] **Step 5: Wire it into the app and the test harness**

Create `src/server/test/fx.ts`:

```ts
import type { IsoDate } from '../../engine';
import type { FxQuote, FxRates } from '../fx/fx-rates';

export interface StubFx extends FxRates {
  /** Every quote asked for, in order. */
  calls: { currency: string; date: IsoDate }[];
}

/**
 * NBP rates for tests: `rates` maps a currency to one rate for every date, or to rates by date. Anything else
 * (and PLN) quotes null, like an unsupported currency. Rates are returned with 6 fraction digits, dated the day asked.
 */
export function stubFx(rates: Record<string, string | Record<IsoDate, string>> = {}): StubFx {
  const calls: StubFx['calls'] = [];
  return {
    calls,
    quote(currency, date) {
      calls.push({ currency, date });
      const entry = rates[currency];
      const rate = typeof entry === 'string' ? entry : entry?.[date];
      const quote: FxQuote | null =
        currency === 'PLN' || rate === undefined ? null : { rate: Number(rate).toFixed(6), effectiveDate: date };
      return Promise.resolve(quote);
    },
  };
}
```

```bash
git apply <<'PATCH'
diff --git a/src/server/http/app.ts b/src/server/http/app.ts
index 4bdce99..082e993 100644
--- a/src/server/http/app.ts
+++ b/src/server/http/app.ts
@@ -15,6 +15,7 @@ import type { Clock } from '../clock';
 import { redoRoutes, undoRoutes } from '../commands/undo-routes';
 import type { Config } from '../config';
 import type { Db } from '../db/client';
+import type { FxRates } from '../fx/fx-rates';
 import type { Logger } from '../logger';
 import { payeeRoutes } from '../payees/payee-routes';
 import { transactionRoutes } from '../transactions/transaction-routes';
@@ -29,6 +30,8 @@ export interface AppDeps {
   clock: Clock;
   logger: Logger;
   clientIp: ClientIpResolver;
+  /** NBP rates (spec §9). Quote before a command or read transaction starts, never inside one. */
+  fx: FxRates;
 }
 
 export function createApp(deps: AppDeps) {
diff --git a/src/server/main.ts b/src/server/main.ts
index 0bbe6d7..fe8dc96 100644
--- a/src/server/main.ts
+++ b/src/server/main.ts
@@ -3,6 +3,7 @@ import { systemClock } from './clock';
 import { loadConfig } from './config';
 import { createDatabase } from './db/client';
 import { runMigrations } from './db/migrate';
+import { nbpRates } from './fx/fx-rates';
 import { createApp } from './http/app';
 import { clientIpResolver } from './http/client-ip';
 import { createLogger } from './logger';
@@ -21,6 +22,13 @@ async function main(): Promise<void> {
     clock: systemClock,
     logger,
     clientIp: clientIpResolver(config.trustProxy),
+    fx: nbpRates({
+      db: database.db,
+      logger,
+      clock: systemClock,
+      timeZone: config.timeZone,
+      baseUrl: config.nbpBaseUrl,
+    }),
   });
   const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
     logger.info({ port: info.port }, 'listening');
diff --git a/src/server/test/app.ts b/src/server/test/app.ts
index 3e9285d..b124db9 100644
--- a/src/server/test/app.ts
+++ b/src/server/test/app.ts
@@ -1,10 +1,12 @@
 import type { Config } from '../config';
 import type { Db } from '../db/client';
+import type { FxRates } from '../fx/fx-rates';
 import { createApp, type App } from '../http/app';
 import { clientIpResolver } from '../http/client-ip';
 import { createLogger } from '../logger';
 import { testConfig } from './config';
 import { FakeClock } from './fake-clock';
+import { stubFx } from './fx';
 import { TestClient } from './http-client';
 
 export interface TestApp {
@@ -14,7 +16,11 @@ export interface TestApp {
   config: Config;
 }
 
-export function createTestApp(db: Db, options: { config?: Partial<Config>; now?: string } = {}): TestApp {
+/** `fx` defaults to a stub without rates (every quote is null); pass `stubFx({ EUR: '4.3' })` to give it some. */
+export function createTestApp(
+  db: Db,
+  options: { config?: Partial<Config>; now?: string; fx?: FxRates } = {},
+): TestApp {
   const config = testConfig(options.config);
   const clock = new FakeClock(options.now ?? '2026-11-20T10:00:00Z');
   const app = createApp({
@@ -23,6 +29,7 @@ export function createTestApp(db: Db, options: { config?: Partial<Config>; now?:
     clock,
     logger: createLogger(config.logLevel),
     clientIp: clientIpResolver(config.trustProxy),
+    fx: options.fx ?? stubFx(),
   });
   return { app, client: new TestClient(app), clock, config };
 }
PATCH
```

- [ ] **Step 6: Run the tests and the final checks**

Run: `npx vitest run --project server src/server/fx src/server/config.test.ts`
Expected: `Tests  13 passed (13)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  53 passed (53)`, `Tests  472 passed (472)` (the baseline plus 1 file and 7 tests); both checks exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/server/fx src/server/test src/server/config.ts src/server/config.test.ts src/server/http/app.ts src/server/main.ts README.md
git commit -m "feat(server): NBP exchange-rate client with the fx_rate cache" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Rate lookup API; NBP rate for a foreign starting balance

Spec §9 and §11 "Transaction sheet": `GET /api/fx/rates/:currency/:date` gives the sheet its pre-filled rate. It is a new router on its own prefix (`/api/fx`) behind `requireSession`. The currency must be a known ISO code other than PLN and the date `YYYY-MM-DD` (400 otherwise). A future date is 422 `fx_rate_unavailable` without asking NBP (NBP publishes nothing ahead, and a future-dated transaction stores no NBP rate, see Task 3); so is a day NBP has no rate for.

The P2b1 carry-over item "`fxRate` is required to create a foreign-currency account; make it optional" is done here. The schema no longer requires `fxRate`. The route quotes NBP for the starting date before the command (only for a foreign currency without `fxRate` and a date not after today), and `createAccount` takes that quote:
- a sent rate is stored with `fx_rate_manual = true`, the NBP rate with `false`;
- with neither, the answer is 422 `fx_rate_required` (`fieldErrors.fxRate`) and nothing is written;
- a future starting date is still 422 `starting_date_in_future`, without a quote.

**Files:**
- Create: `src/shared/api/fx.ts`, `src/server/fx/fx-routes.ts`
- Modify: `src/server/http/app.ts`, `src/shared/api/accounts.ts`, `src/server/accounts/account-commands.ts`, `src/server/accounts/account-routes.ts`
- Test: `src/server/fx/fx-routes.test.ts` (new), `src/server/accounts/account-routes.test.ts` (the 400 for a missing rate goes), `src/server/http/app.test.ts`

**Interfaces:**
- Consumes: `FxQuote`, `AppDeps.fx`, `stubFx` (Task 1); `currencySchema`, `isoDateSchema`, `BASE_CURRENCY`.
- Produces:
  - `fxRateParamSchema`, `FxRateDto { rate, effectiveDate }` (`src/shared/api/fx.ts`).
  - `fxRoutes(deps)` at `/api/fx`: `GET /rates/:currency/:date`.
  - `createAccount(rec, input, today, nbp: FxQuote | null = null)`.

- [ ] **Step 1: Write the failing tests**

Create `src/server/fx/fx-routes.test.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDto } from '../../shared/api/accounts';
import { account, transaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { type StubFx, stubFx } from '../test/fx';
import { snapshot } from '../test/snapshot';

let t: TestDatabase;
let ctx: TestApp;
let fx: StubFx;
beforeEach(async () => {
  t = await createTestDatabase();
  fx = stubFx({ EUR: { '2026-11-13': '4.2315', '2026-11-20': '4.25' } });
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z', fx });
  await setUpBudget(ctx);
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

describe('GET /api/fx/rates/:currency/:date', () => {
  it('returns the NBP rate of the day', async () => {
    expect(await json(await ctx.client.get('/api/fx/rates/EUR/2026-11-13'))).toEqual({
      status: 200,
      body: { rate: '4.231500', effectiveDate: '2026-11-13' },
    });
    expect(fx.calls).toEqual([{ currency: 'EUR', date: '2026-11-13' }]);
  });

  it('answers 422 when NBP has no rate, and never asks for a future date', async () => {
    expect(await json(await ctx.client.get('/api/fx/rates/USD/2026-11-13'))).toEqual({
      status: 422,
      body: { code: 'fx_rate_unavailable', message: "There's no NBP rate for USD on 2026-11-13. Enter the rate." },
    });
    expect((await json(await ctx.client.get('/api/fx/rates/EUR/2026-11-21'))).body).toMatchObject({
      code: 'fx_rate_unavailable',
    });
    expect(fx.calls).toEqual([{ currency: 'USD', date: '2026-11-13' }]);
  });

  it('validates the currency and the date', async () => {
    const errors = async (path: string) => {
      const res = await json<{ fieldErrors: Record<string, string[]> }>(await ctx.client.get(path));
      expect(res.status).toBe(400);
      return res.body.fieldErrors;
    };
    expect(await errors('/api/fx/rates/PLN/2026-11-13')).toEqual({ currency: ['PLN is the budget currency.'] });
    expect(await errors('/api/fx/rates/eur/2026-11-13')).toEqual({
      currency: ['Use a 3-letter currency code, e.g. EUR.'],
    });
    expect(await errors('/api/fx/rates/EUR/2026-13-01')).toEqual({ date: ['Use the format YYYY-MM-DD.'] });
    expect(fx.calls).toEqual([]);
  });
});

describe('POST /api/accounts in a foreign currency', () => {
  const startingBalanceOf = async (accountId: string) => {
    const [txn] = await t.db
      .select()
      .from(transaction)
      .where(and(eq(transaction.accountId, accountId), eq(transaction.isStartingBalance, true)));
    return txn!;
  };
  const create = (body: object) =>
    ctx.client.post('/api/accounts', { name: 'Revolut EUR', type: 'savings', currency: 'EUR', ...body });

  it('books the starting balance at the NBP rate of its date when no rate is sent', async () => {
    const before = await snapshot(t.db);
    const res = await json<AccountDto>(await create({ startingBalance: 10_000, startingDate: '2026-11-13' }));
    expect(res).toMatchObject({ status: 201, body: { balanceBase: { cleared: 42_315 } } });
    expect(await startingBalanceOf(res.body.id)).toMatchObject({
      amount: 10_000,
      amountBase: 42_315,
      fxRate: '4.231500',
      fxRateManual: false,
    });
    // Quoted before the command ran.
    expect(fx.calls[0]).toEqual({ currency: 'EUR', date: '2026-11-13' });
    const after = await snapshot(t.db);

    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);
  });

  it('keeps a rate the user sends as manual, without asking NBP', async () => {
    const body = { startingBalance: 10_000, startingDate: '2026-11-13', fxRate: '4.1' };
    const res = await json<AccountDto>(await create(body));
    expect(await startingBalanceOf(res.body.id)).toMatchObject({
      amountBase: 41_000,
      fxRate: '4.100000',
      fxRateManual: true,
    });
    expect(fx.calls).not.toContainEqual({ currency: 'EUR', date: '2026-11-13' });
  });

  it('asks for the rate when NBP has none, and quotes nothing for a future starting date', async () => {
    expect(await json(await create({ currency: 'USD', startingBalance: 500 }))).toEqual({
      status: 422,
      body: {
        code: 'fx_rate_required',
        message: 'Enter the exchange rate of USD to PLN for the starting balance.',
        fieldErrors: { fxRate: ['Enter the exchange rate of USD to PLN for the starting balance.'] },
      },
    });
    expect((await json(await create({ startingBalance: 500, startingDate: '2026-11-21' }))).body).toMatchObject({
      code: 'starting_date_in_future',
    });
    expect(fx.calls).toEqual([{ currency: 'USD', date: '2026-11-20' }]);
    expect(await t.db.select().from(account)).toEqual([]);
  });
});
```

```bash
git apply <<'PATCH'
diff --git a/src/server/accounts/account-routes.test.ts b/src/server/accounts/account-routes.test.ts
index 70c2d21..a505539 100644
--- a/src/server/accounts/account-routes.test.ts
+++ b/src/server/accounts/account-routes.test.ts
@@ -207,9 +207,6 @@ describe('POST /api/accounts', () => {
     expect(await errors({ type: 'mortgage', createPairedCategory: true })).toEqual({
       minPayment: ["Enter the minimum payment: it becomes the paired category's target."],
     });
-    expect(await errors({ type: 'savings', currency: 'EUR' })).toEqual({
-      fxRate: ['Enter the exchange rate to PLN for the starting balance.'],
-    });
     expect(await errors({ type: 'savings', fxRate: '4.2' })).toEqual({
       fxRate: ["PLN accounts don't need an exchange rate."],
     });
diff --git a/src/server/http/app.test.ts b/src/server/http/app.test.ts
index 244f604..a64e3da 100644
--- a/src/server/http/app.test.ts
+++ b/src/server/http/app.test.ts
@@ -88,6 +88,7 @@ describe('route guard', () => {
         'DELETE /api/categories/:id/target',
         'POST /api/categories/:id/target/snooze',
         'DELETE /api/categories/:id/target/snooze',
+        'GET /api/fx/rates/:currency/:date',
       ]),
     );
 
PATCH
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project server src/server/fx/fx-routes.test.ts src/server/accounts/account-routes.test.ts src/server/http/app.test.ts`
Expected: FAIL, `Tests  6 failed | 28 passed (34)`: the rate routes answer 404, a foreign account without `fxRate` is a 400, and the route walk misses `GET /api/fx/rates/:currency/:date`.

- [ ] **Step 3: Add the rate lookup route**

Create `src/shared/api/fx.ts`:

```ts
import { z } from 'zod';
import { BASE_CURRENCY, currencySchema } from './accounts';
import { isoDateSchema } from './common';

/** GET /api/fx/rates/:currency/:date: the NBP rate the transaction sheet pre-fills (spec §9, §11). */
export const fxRateParamSchema = z.object({
  currency: currencySchema.refine((code) => code !== BASE_CURRENCY, `${BASE_CURRENCY} is the budget currency.`),
  date: isoDateSchema,
});

/** An NBP table A mid rate. */
export interface FxRateDto {
  /** PLN per unit, 6 fraction digits, e.g. "4.312300". */
  rate: string;
  /** The NBP publication day used: the requested day, or up to 7 days earlier (weekends, holidays). */
  effectiveDate: string;
}
```

Create `src/server/fx/fx-routes.ts`:

```ts
import { Hono } from 'hono';
import { type FxRateDto, fxRateParamSchema } from '../../shared/api/fx';
import { type AuthedEnv, requireSession } from '../auth/sessions';
import { todayIn } from '../clock';
import type { AppDeps } from '../http/app';
import { DomainError } from '../http/errors';
import { validate } from '../http/validate';

/** /api/fx (spec §9): NBP rates for the transaction sheet. */
export function fxRoutes(deps: AppDeps) {
  const today = () => todayIn(deps.config.timeZone, deps.clock.now());

  return new Hono<AuthedEnv>()
    .use('*', requireSession(deps))
    .get('/rates/:currency/:date', validate('param', fxRateParamSchema), async (c) => {
      const { currency, date } = c.req.valid('param');
      // NBP publishes nothing ahead; a future-dated transaction becomes a schedule and gets its rate when entered.
      const quote = date > today() ? null : await deps.fx.quote(currency, date);
      if (!quote) {
        throw new DomainError('fx_rate_unavailable', `There's no NBP rate for ${currency} on ${date}. Enter the rate.`);
      }
      return c.json<FxRateDto>(quote);
    });
}
```

```bash
git apply <<'PATCH'
diff --git a/src/server/http/app.ts b/src/server/http/app.ts
index 082e993..18ef789 100644
--- a/src/server/http/app.ts
+++ b/src/server/http/app.ts
@@ -16,6 +16,7 @@ import { redoRoutes, undoRoutes } from '../commands/undo-routes';
 import type { Config } from '../config';
 import type { Db } from '../db/client';
 import type { FxRates } from '../fx/fx-rates';
+import { fxRoutes } from '../fx/fx-routes';
 import type { Logger } from '../logger';
 import { payeeRoutes } from '../payees/payee-routes';
 import { transactionRoutes } from '../transactions/transaction-routes';
@@ -83,7 +84,8 @@ export function createApp(deps: AppDeps) {
     .route('/api/categories', categoryRoutes(deps))
     .route('/api/budget', budgetRoutes(deps))
     .route('/api/payees', payeeRoutes(deps))
-    .route('/api/transactions', transactionRoutes(deps));
+    .route('/api/transactions', transactionRoutes(deps))
+    .route('/api/fx', fxRoutes(deps));
 
   app.notFound((c) => c.json<ApiErrorBody>({ code: 'not_found', message: 'Not found.' }, 404));
   app.onError(errorHandler);
PATCH
```

- [ ] **Step 4: Default a foreign starting balance to the NBP rate**

```bash
git apply <<'PATCH'
diff --git a/src/server/accounts/account-commands.ts b/src/server/accounts/account-commands.ts
index b151408..bc548ec 100644
--- a/src/server/accounts/account-commands.ts
+++ b/src/server/accounts/account-commands.ts
@@ -25,6 +25,7 @@ import {
   transaction,
 } from '../db/schema';
 import { AppError, DomainError } from '../http/errors';
+import type { FxQuote } from '../fx/fx-rates';
 import { getAccount } from './account-queries';
 
 type AccountRow = typeof account.$inferSelect;
@@ -45,12 +46,14 @@ export async function assertAccountNameFree(db: Executor, name: string, exceptId
 /**
  * Spec §10 "Accounts" and "Starting balance": the account, its transfer payee, its cleared starting-balance
  * transaction, and for credit accounts the credit card payment category (spec §5.3); for loans that opt in, the
- * paired Debt Payments category with a minimum-payment target (spec §8).
+ * paired Debt Payments category with a minimum-payment target (spec §8). A foreign starting balance is booked at the
+ * rate sent (manual) or else at `nbp`, the NBP rate of its date that the caller quoted before the command.
  */
 export async function createAccount(
   rec: ChangeRecorder,
   input: CreateAccountRequest,
   today: IsoDate,
+  nbp: FxQuote | null = null,
 ): Promise<{ id: string }> {
   const startingDate = input.startingDate ?? today;
   if (startingDate > today) {
@@ -59,8 +62,14 @@ export async function createAccount(
   await assertAccountNameFree(rec.tx, input.name);
   const accountClass = accountClassOf(input.type);
   const foreign = input.currency !== BASE_CURRENCY;
-  // The schema requires fxRate exactly when the currency is foreign.
-  const rate = foreign ? input.fxRate! : null;
+  const rate = foreign ? (input.fxRate ?? nbp?.rate ?? null) : null;
+  if (foreign && rate === null) {
+    throw new DomainError(
+      'fx_rate_required',
+      `Enter the exchange rate of ${input.currency} to ${BASE_CURRENCY} for the starting balance.`,
+      'fxRate',
+    );
+  }
   const amountBase = rate === null ? input.startingBalance : convertToBase(input.startingBalance, rate);
   if (!Number.isSafeInteger(amountBase)) throw new DomainError('amount_too_large', 'That amount is too large.');
 
@@ -86,8 +95,7 @@ export async function createAccount(
     amount: input.startingBalance,
     amountBase,
     fxRate: rate,
-    // Entered by the user until the NBP lookup exists (P2d).
-    fxRateManual: foreign,
+    fxRateManual: input.fxRate !== undefined,
     cleared: 'cleared',
     isStartingBalance: true,
   });
diff --git a/src/server/accounts/account-routes.ts b/src/server/accounts/account-routes.ts
index 8959e8a..b4b1125 100644
--- a/src/server/accounts/account-routes.ts
+++ b/src/server/accounts/account-routes.ts
@@ -2,6 +2,7 @@ import { Hono } from 'hono';
 import {
   type AccountDto,
   type AccountListResponse,
+  BASE_CURRENCY,
   createAccountRequestSchema,
   updateAccountRequestSchema,
 } from '../../shared/api/accounts';
@@ -23,8 +24,13 @@ export function accountRoutes(deps: AppDeps) {
     .get('/', async (c) => c.json<AccountListResponse>({ accounts: await listAccounts(deps.db) }))
     .post('/', validate('json', createAccountRequestSchema), async (c) => {
       const body = c.req.valid('json');
+      const now = today();
+      const date = body.startingDate ?? now;
+      // Spec §9: the NBP rate is quoted before the command, outside its transaction.
+      const needsRate = body.currency !== BASE_CURRENCY && body.fxRate === undefined && date <= now;
+      const nbp = needsRate ? await deps.fx.quote(body.currency, date) : null;
       const { id } = await runCommand(deps, `Create account "${body.name}"`, (rec) =>
-        createAccount(rec, body, today()),
+        createAccount(rec, body, now, nbp),
       );
       return c.json<AccountDto>(await getAccount(deps.db, id), 201);
     })
diff --git a/src/shared/api/accounts.ts b/src/shared/api/accounts.ts
index 1593fd2..fc94c54 100644
--- a/src/shared/api/accounts.ts
+++ b/src/shared/api/accounts.ts
@@ -41,7 +41,10 @@ export const createAccountRequestSchema = z
     startingBalance: moneySchema,
     /** Defaults to today in the budget's time zone; may not be in the future. */
     startingDate: startingDateSchema.optional(),
-    /** Required for foreign currencies until the NBP lookup exists (P2d). */
+    /**
+     * Foreign currencies: the starting balance's rate to PLN. Without it the server uses the NBP rate of the starting
+     * date (spec §9) and answers 422 `fx_rate_required` when NBP has none.
+     */
     fxRate: fxRateSchema.optional(),
     note: noteSchema.optional(),
     interestRate: interestRateSchema.optional(),
@@ -68,9 +71,6 @@ export const createAccountRequestSchema = z
     if (body.currency === BASE_CURRENCY && body.fxRate !== undefined) {
       reject('fxRate', `${BASE_CURRENCY} accounts don't need an exchange rate.`);
     }
-    if (body.currency !== BASE_CURRENCY && body.fxRate === undefined) {
-      reject('fxRate', `Enter the exchange rate to ${BASE_CURRENCY} for the starting balance.`);
-    }
   });
 
 export type CreateAccountRequest = z.infer<typeof createAccountRequestSchema>;
PATCH
```

- [ ] **Step 5: Run the tests and the final checks**

Run: `npx vitest run --project server src/server/fx/fx-routes.test.ts src/server/accounts/account-routes.test.ts src/server/http/app.test.ts`
Expected: `Tests  34 passed (34)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  54 passed (54)`, `Tests  478 passed (478)`; both checks exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/shared/api src/server/fx src/server/http src/server/accounts
git commit -m "feat(server): NBP rate lookup; NBP rate for a foreign starting balance" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: NBP default rates on transaction writes

Spec §9 "Default rate", "Changing the date re-fetches the rate unless it's manual", "Split lines use the parent's rate" and "Cross-currency transfers". Until now (P2c) a foreign transaction needed `fxRate`, stored as manual. Now:
- **Create**, no `fxRate`: the amount is booked at the NBP rate of its date (`fx_rate_manual = false`); split lines take the split's rate (the last line absorbs the rounding), and a transfer between two foreign accounts is converted at the **sending** currency's rate, stored on the sending side (P2c's rule), wherever it was entered. PLN ↔ foreign transfers need no rate and quote nothing. With `fxRate`: that rate, manual.
- **Create, future date** (it becomes a one-time schedule, spec §5.6): **no NBP lookup and no 422.** Without `fxRate` the schedule stores `fx_rate = null` and `fx_rate_manual = false`, and P2d2's job resolves the NBP rate of the occurrence date when it enters it. With `fxRate` it stores that rate with `fx_rate_manual = true`. (Future transfers between currencies stay refused, P2c's `future_transfer_currency`.)
- **Edit**: the stored rate stays unless `fxRate` is sent (then it is manual). A **new date replaces an NBP rate** with the new day's NBP rate and rebooks the base amounts, the split lines and the other side of a transfer; a manual rate stays. A currency the transaction has no rate for yet (e.g. a new transfer between foreign accounts) gets the NBP rate of the date.
- NBP has no rate for the date → 422 `fx_rate_required`, `fieldErrors.fxRate` (P2c's error), and nothing is written.

How the rates are found without network calls inside the command: `createDefaultRates` / `editDefaultRates` (in `default-rates.ts`) build the draft read-only (a typed payee name is only looked up: a new payee is a user payee, never a transfer), run `planTransaction` outside any transaction with `PlanContext.unknownRates`, so that a currency without a rate is collected and booked at a placeholder instead of refused, and quote the collected currencies for the draft's date. The command then plans for real with `PlanContext.defaults`. A dry run that fails leaves the error to the command, which reports it; a future-dated create, an edit dated in the future and an edit of a split line's counterpart quote nothing. Bulk edits keep P2c's behaviour (stored rates only): they never change dates.

`Rates` becomes `{ input, stored: Map<currency, Rate>, defaults, unknown, used }` with `Rate { rate, manual }`; `rateFor` prefers the sent rate, then a stored one, then NBP's, then the placeholder (`UNKNOWN_RATE`, which plans store as no rate). `storedRates(db, agg, sameDate)` keeps manual rates always and NBP rates only while the date stays. `TransactionDto` gains `fxRateManual`.

**Files:**
- Create: `src/server/transactions/default-rates.ts`
- Modify: `src/server/transactions/rules.ts`, `src/server/transactions/plan.ts`, `src/server/transactions/aggregate.ts`, `src/server/transactions/transaction-commands.ts`, `src/server/transactions/transaction-queries.ts`, `src/server/transactions/transaction-routes.ts`, `src/shared/api/transactions.ts`
- Test: `src/server/transactions/fx-defaults.test.ts` (new), `src/server/transactions/create-transaction.test.ts` (`fxRateManual` in the full DTO)

**Interfaces:**
- Consumes: `FxRates`, `stubFx` (Task 1); `findUserPayeeByName`; P2c's planner, aggregate and commands.
- Produces:
  - `rules.ts`: `Rate { rate, manual }`, `UNKNOWN_RATE`, `Rates { input, stored, defaults, unknown, used }`, `rateFor(rates, currency): Rate`, `bookedBase(...) → { amountBase, rate: Rate | null }`.
  - `plan.ts`: `PlanContext` gains `defaults?: Map<currency, rate>` and `unknownRates?: Set<currency>`; `existing.rates: Map<string, Rate>`.
  - `aggregate.ts`: `storedRates(db, agg, sameDate): Promise<Map<string, Rate>>`.
  - `transaction-commands.ts`: `PayeeByName`, `createDraft(input, today, payeeByName)`, `editDraft(db, agg, patch, payeeByName) → { draft, context }`, `createTransaction(rec, input, today, defaults?)`, `EditContext.defaults?`.
  - `default-rates.ts`: `createDefaultRates(deps, input, today)`, `editDefaultRates(deps, id, patch, today)` → `Map<currency, rate>`.
  - `TransactionDto.fxRateManual: boolean`.

- [ ] **Step 1: Write the failing tests**

Create `src/server/transactions/fx-defaults.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDto } from '../../shared/api/accounts';
import type { TransactionDto } from '../../shared/api/transactions';
import { scheduledTransaction, transaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createTransaction } from '../test/fixtures';
import { type StubFx, stubFx } from '../test/fx';
import { snapshot } from '../test/snapshot';

let t: TestDatabase;
let ctx: TestApp;
let fx: StubFx;
let euro: AccountDto;
beforeEach(async () => {
  t = await createTestDatabase();
  fx = stubFx({
    EUR: { '2026-11-18': '4.2', '2026-11-19': '4.3', '2026-11-20': '4.25' },
    USD: { '2026-11-19': '3.9' },
  });
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z', fx });
  await setUpBudget(ctx);
  euro = await createAccount(ctx.client, { name: 'Revolut', type: 'savings', currency: 'EUR', fxRate: '4.25' });
  fx.calls.splice(0);
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

const get = async (id: string) => (await json<TransactionDto>(await ctx.client.get(`/api/transactions/${id}`))).body;
const patch = (id: string, body: object) => ctx.client.send('PATCH', `/api/transactions/${id}`, body);
const edit = async (id: string, body: object) => {
  const res = await json<TransactionDto>(await patch(id, body));
  if (res.status !== 200) throw new Error(`edit failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};
/** The quotes asked for since the last call. */
const quoted = () => fx.calls.splice(0);

describe('default NBP rates on new transactions', () => {
  it('books a foreign amount at the NBP rate of its date unless a rate is sent', async () => {
    const before = await snapshot(t.db);
    const nbp = await createTransaction(ctx.client, { accountId: euro.id, date: '2026-11-19', amount: -1_000 });
    expect(nbp).toMatchObject({ amountBase: -4_300, fxRate: '4.300000', fxRateManual: false });
    expect(quoted()).toEqual([{ currency: 'EUR', date: '2026-11-19' }]);
    const after = await snapshot(t.db);
    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);

    const manual = await createTransaction(ctx.client, { accountId: euro.id, amount: -1_000, fxRate: '4.1' });
    expect(manual).toMatchObject({ amountBase: -4_100, fxRate: '4.100000', fxRateManual: true });
    expect(quoted()).toEqual([]);
  });

  it('asks for the rate when NBP has none for the date', async () => {
    const before = await snapshot(t.db);
    const res = await ctx.client.post('/api/transactions', { accountId: euro.id, date: '2026-11-17', amount: -1 });
    expect(await json(res)).toEqual({
      status: 422,
      body: {
        code: 'fx_rate_required',
        message: 'Enter the exchange rate of EUR to PLN.',
        fieldErrors: { fxRate: ['Enter the exchange rate of EUR to PLN.'] },
      },
    });
    expect(quoted()).toEqual([{ currency: 'EUR', date: '2026-11-17' }]);
    expect(await snapshot(t.db)).toEqual(before);
  });

  it('stores no rate on a future-dated foreign transaction unless one is sent, and quotes nothing', async () => {
    const schedule = async (body: object) => {
      const res = await json<{ kind: string; scheduledId: string }>(
        await ctx.client.post('/api/transactions', { accountId: euro.id, date: '2026-11-25', amount: -1_000, ...body }),
      );
      expect(res).toMatchObject({ status: 201, body: { kind: 'scheduled' } });
      const [row] = await t.db
        .select()
        .from(scheduledTransaction)
        .where(eq(scheduledTransaction.id, res.body.scheduledId));
      return row!;
    };
    expect(await schedule({})).toMatchObject({ fxRate: null, fxRateManual: false });
    expect(await schedule({ lines: [{ amount: -400 }, { amount: -600 }] })).toMatchObject({
      isSplit: true,
      fxRate: null,
      fxRateManual: false,
    });
    expect(await schedule({ fxRate: '4.4' })).toMatchObject({ fxRate: '4.400000', fxRateManual: true });
    expect(quoted()).toEqual([]);
  });

  it("converts a split's lines at the NBP rate of its date", async () => {
    const split = await createTransaction(ctx.client, {
      accountId: euro.id,
      date: '2026-11-19',
      amount: -1_001,
      lines: [{ amount: -333 }, { amount: -668 }],
    });
    // −1 001 × 4.3 = −4 304.3 → −4 304; the last line takes the rounding remainder.
    expect(split).toMatchObject({ amountBase: -4_304, fxRate: '4.300000', fxRateManual: false });
    expect(split.lines.map((l) => l.amountBase)).toEqual([-1_432, -2_872]);
  });

  it('quotes the sending currency of a foreign ↔ foreign transfer, and nothing for PLN ↔ foreign', async () => {
    const dollar = await createAccount(ctx.client, { name: 'USD', type: 'savings', currency: 'USD', fxRate: '3.9' });
    const checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 100_000 });
    quoted();
    // Entered on the receiving (USD) side: the sending EUR side's rate converts both.
    const received = await createTransaction(ctx.client, {
      accountId: dollar.id,
      date: '2026-11-19',
      payeeId: euro.transferPayeeId,
      amount: 11_500,
      transferAmount: -10_000,
    });
    expect(quoted()).toEqual([{ currency: 'EUR', date: '2026-11-19' }]);
    expect(received).toMatchObject({ amountBase: 43_000, fxRate: null, fxRateManual: false });
    expect(await get(received.transfer!.transactionId)).toMatchObject({
      amountBase: -43_000,
      fxRate: '4.300000',
      fxRateManual: false,
    });

    await createTransaction(ctx.client, {
      accountId: checking.id,
      payeeId: euro.transferPayeeId,
      amount: -40_000,
      transferAmount: 9_300,
    });
    expect(quoted()).toEqual([]);
  });
});

describe('default NBP rates on edits', () => {
  it('re-fetches an NBP rate when the date changes and rebooks the base amounts', async () => {
    const txn = await createTransaction(ctx.client, { accountId: euro.id, date: '2026-11-19', amount: -1_000 });
    quoted();
    expect(await edit(txn.id, { amount: -2_000 })).toMatchObject({ amountBase: -8_600, fxRate: '4.300000' });
    expect(quoted()).toEqual([]);

    const before = await snapshot(t.db);
    expect(await edit(txn.id, { date: '2026-11-18' })).toMatchObject({
      amountBase: -8_400,
      fxRate: '4.200000',
      fxRateManual: false,
    });
    expect(quoted()).toEqual([{ currency: 'EUR', date: '2026-11-18' }]);
    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);

    expect(await edit(txn.id, { fxRate: '4.5' })).toMatchObject({ amountBase: -9_000, fxRateManual: true });
  });

  it('rebooks split lines and the other side of a transfer at the new date’s rate', async () => {
    const split = await createTransaction(ctx.client, {
      accountId: euro.id,
      date: '2026-11-19',
      amount: -1_000,
      lines: [{ amount: -300 }, { amount: -700 }],
    });
    const moved = await edit(split.id, { date: '2026-11-18' });
    expect([moved.amountBase, ...moved.lines.map((l) => l.amountBase)]).toEqual([-4_200, -1_260, -2_940]);

    const dollar = await createAccount(ctx.client, { name: 'USD', type: 'savings', currency: 'USD', fxRate: '3.9' });
    const sent = await createTransaction(ctx.client, {
      accountId: euro.id,
      date: '2026-11-19',
      payeeId: dollar.transferPayeeId,
      amount: -10_000,
      transferAmount: 11_500,
    });
    quoted();
    // Edited on the receiving side: the sending side's NBP rate follows the new date.
    const received = await edit(sent.transfer!.transactionId, { date: '2026-11-18' });
    expect(quoted()).toEqual([{ currency: 'EUR', date: '2026-11-18' }]);
    expect(received).toMatchObject({ date: '2026-11-18', amountBase: 42_000 });
    expect(await get(sent.id)).toMatchObject({ date: '2026-11-18', amountBase: -42_000, fxRate: '4.200000' });
  });

  it('keeps a manual rate when the date changes', async () => {
    const txn = await createTransaction(ctx.client, {
      accountId: euro.id,
      date: '2026-11-19',
      amount: -1_000,
      fxRate: '4.1',
    });
    expect(await edit(txn.id, { date: '2026-11-18' })).toMatchObject({
      amountBase: -4_100,
      fxRate: '4.100000',
      fxRateManual: true,
    });
    expect(quoted()).toEqual([]);
  });

  it('asks for a rate when the new date has no NBP rate', async () => {
    const txn = await createTransaction(ctx.client, { accountId: euro.id, date: '2026-11-19', amount: -1_000 });
    const before = await snapshot(t.db);
    expect((await json(await patch(txn.id, { date: '2026-11-17' }))).body).toMatchObject({
      code: 'fx_rate_required',
      fieldErrors: { fxRate: ['Enter the exchange rate of EUR to PLN.'] },
    });
    expect(await snapshot(t.db)).toEqual(before);
    const [row] = await t.db.select().from(transaction).where(eq(transaction.id, txn.id));
    expect(row).toMatchObject({ date: '2026-11-19', fxRate: '4.300000' });
  });
});
```

```bash
git apply <<'PATCH'
diff --git a/src/server/transactions/create-transaction.test.ts b/src/server/transactions/create-transaction.test.ts
index dc2a11b..8684153 100644
--- a/src/server/transactions/create-transaction.test.ts
+++ b/src/server/transactions/create-transaction.test.ts
@@ -73,6 +73,7 @@ describe('POST /api/transactions', () => {
         amount: -12_345,
         amountBase: -12_345,
         fxRate: null,
+        fxRateManual: false,
         effectiveRate: null,
         cleared: 'uncleared',
         approved: true,
PATCH
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project server src/server/transactions/fx-defaults.test.ts src/server/transactions/create-transaction.test.ts`
Expected: FAIL, `Tests  10 failed | 7 passed (17)`: transactions without `fxRate` are 422 `fx_rate_required` (`createTransaction failed: 422 …`), a future-dated one too, and the DTO has no `fxRateManual`.

- [ ] **Step 3: Rates know where they come from**

```bash
git apply <<'PATCH'
diff --git a/src/server/transactions/aggregate.ts b/src/server/transactions/aggregate.ts
index a77f39a..ed9f088 100644
--- a/src/server/transactions/aggregate.ts
+++ b/src/server/transactions/aggregate.ts
@@ -3,6 +3,7 @@ import type { Executor } from '../db/client';
 import { account, subtransaction, transaction } from '../db/schema';
 import { AppError } from '../http/errors';
 import type { Draft } from './plan';
+import type { Rate } from './rules';
 
 type TxnRow = typeof transaction.$inferSelect;
 type LineRow = typeof subtransaction.$inferSelect;
@@ -85,13 +86,16 @@ export function draftOf(agg: Aggregate): Draft {
   };
 }
 
-/** Rates already stored on the transaction's rows, by currency (spec §9: edits keep them unless a new one is sent). */
-export async function storedRates(db: Executor, agg: Aggregate): Promise<Map<string, string>> {
-  const rates = new Map<string, string>();
+/**
+ * Rates already stored on the transaction's rows, by currency (spec §9): edits keep them unless a new one is sent. A
+ * manual rate always stays; an NBP rate only while the date does, so a new date books that day's NBP rate.
+ */
+export async function storedRates(db: Executor, agg: Aggregate, sameDate: boolean): Promise<Map<string, Rate>> {
+  const rates = new Map<string, Rate>();
   for (const r of [agg.main, agg.counterpart]) {
-    if (!r?.fxRate) continue;
+    if (!r?.fxRate || (!r.fxRateManual && !sameDate)) continue;
     const [owner] = await db.select({ currency: account.currency }).from(account).where(eq(account.id, r.accountId));
-    rates.set(owner!.currency, r.fxRate);
+    rates.set(owner!.currency, { rate: r.fxRate, manual: r.fxRateManual });
   }
   return rates;
 }
diff --git a/src/server/transactions/plan.ts b/src/server/transactions/plan.ts
index 136828d..b6085c0 100644
--- a/src/server/transactions/plan.ts
+++ b/src/server/transactions/plan.ts
@@ -15,11 +15,13 @@ import {
   onBudget,
   type PayeeInfo,
   placeTransferCategory,
+  type Rate,
   rateFor,
   type Rates,
   requireAccount,
   requirePayee,
   TRACKING_NO_CATEGORY,
+  UNKNOWN_RATE,
 } from './rules';
 
 /** A transaction as the user describes it, before the rules of spec §5.5 and §9 turn it into rows. */
@@ -94,16 +96,24 @@ export interface Plan {
 export interface PlanContext {
   existing?: {
     payeeId: string | null;
-    /** Stored rates by currency, used when the request sends none. */
-    rates: Map<string, string>;
+    /** Stored rates by currency that still apply, used when the request sends none (see `storedRates`). */
+    rates: Map<string, Rate>;
     /** A plain transfer's other side: its amount stays unless `transferAmount` is sent. */
     counterpart: { accountId: string; amount: Money } | null;
     /** Accounts that already hold the transaction's rows (they may be closed). */
     accountIds: Set<string>;
   };
+  /** Spec §9: NBP rates for the draft's date by currency, quoted before the command (see `default-rates.ts`). */
+  defaults?: Map<string, string>;
+  /** Collects currencies that have no rate instead of refusing them (see `Rates.unknown`). */
+  unknownRates?: Set<string>;
 }
 
-const rateColumns = (rate: string | null) => ({ fxRate: rate, fxRateManual: rate !== null });
+/** PLN rows, rows whose base comes from the other side of a transfer, and rates nobody has yet store none. */
+const rateColumns = (rate: Rate | null) =>
+  rate === null || rate === UNKNOWN_RATE
+    ? { fxRate: null, fxRateManual: false }
+    : { fxRate: rate.rate, fxRateManual: rate.manual };
 
 /**
  * Spec §9: both sides of a transfer net to zero in PLN. Same-currency transfers mirror the amount; transfers between
@@ -146,7 +156,11 @@ function transferSides(main: AccountInfo, other: AccountInfo, draft: Draft, rate
   const from = mainSends ? here : there;
   const to = mainSends ? there : here;
   const rate = from.currency !== BASE_CURRENCY && to.currency !== BASE_CURRENCY ? rateFor(rates, from.currency) : null;
-  const { fromBase, toBase } = transferBases(BASE_CURRENCY, { ...from, rate }, { ...to, rate: null });
+  const { fromBase, toBase } = transferBases(
+    BASE_CURRENCY,
+    { ...from, rate: rate?.rate ?? null },
+    { ...to, rate: null },
+  );
   if (!Number.isSafeInteger(fromBase)) throw new DomainError('amount_too_large', 'That amount is too large.', 'amount');
   return mainSends
     ? { mainBase: fromBase, mainRate: rate, otherAmount, otherBase: toBase, otherRate: null }
@@ -160,14 +174,14 @@ async function planLines(
   draft: Draft & { lines: DraftLine[] },
   rates: Rates,
   open: (target: AccountInfo, field: string) => void,
-): Promise<{ amountBase: Money; fxRate: string | null; lines: LinePlan[] }> {
+): Promise<{ amountBase: Money; rate: Rate | null; lines: LinePlan[] }> {
   const total = draft.lines.reduce((sum, line) => sum + line.amount, 0);
   if (total !== draft.amount) {
     throw new DomainError('split_sum', 'The lines must add up to the transaction amount.', 'lines');
   }
-  const { amountBase, fxRate } = bookedBase(main.currency, draft.amount, rates);
+  const { amountBase, rate } = bookedBase(main.currency, draft.amount, rates);
   const amounts = draft.lines.map((line) => line.amount);
-  const bases = fxRate === null ? amounts : splitLineBases(amountBase, amounts, fxRate);
+  const bases = rate === null ? amounts : splitLineBases(amountBase, amounts, rate.rate);
 
   const lines: LinePlan[] = [];
   for (const [index, line] of draft.lines.entries()) {
@@ -218,7 +232,7 @@ async function planLines(
       },
     });
   }
-  return { amountBase, fxRate, lines };
+  return { amountBase, rate, lines };
 }
 
 /** Validates a draft against spec §5.5 and §9 and computes the rows to write. */
@@ -231,7 +245,13 @@ export async function planTransaction(db: Executor, draft: Draft, context: PlanC
   open(main, 'accountId');
   const payee = draft.payeeId === null ? null : await requirePayee(db, draft.payeeId, 'payeeId');
   if (payee && draft.payeeId !== existing?.payeeId) assertNotSystemPayee(payee, 'payeeId');
-  const rates: Rates = { input: draft.fxRate, stored: existing?.rates ?? new Map(), used: false };
+  const rates: Rates = {
+    input: draft.fxRate,
+    stored: existing?.rates ?? new Map(),
+    defaults: context.defaults ?? new Map(),
+    unknown: context.unknownRates ?? null,
+    used: false,
+  };
   const row = {
     accountId: draft.accountId,
     date: draft.date,
@@ -261,7 +281,7 @@ export async function planTransaction(db: Executor, draft: Draft, context: PlanC
         ...status,
         categoryId: null,
         amountBase: split.amountBase,
-        ...rateColumns(split.fxRate),
+        ...rateColumns(split.rate),
         transferAccountId: null,
         isSplit: true,
       },
@@ -317,7 +337,7 @@ export async function planTransaction(db: Executor, draft: Draft, context: PlanC
     if (!onBudget(main)) throw categoryNotAllowed(TRACKING_NO_CATEGORY, 'categoryId');
     await assertUsableCategory(db, draft.categoryId, 'categoryId');
   }
-  const { amountBase, fxRate } = bookedBase(main.currency, draft.amount, rates);
+  const { amountBase, rate } = bookedBase(main.currency, draft.amount, rates);
   assertRateUsed(rates);
   return {
     main: {
@@ -325,7 +345,7 @@ export async function planTransaction(db: Executor, draft: Draft, context: PlanC
       ...status,
       categoryId: draft.categoryId,
       amountBase,
-      ...rateColumns(fxRate),
+      ...rateColumns(rate),
       transferAccountId: null,
       isSplit: false,
     },
diff --git a/src/server/transactions/rules.ts b/src/server/transactions/rules.ts
index d56ed3c..677845b 100644
--- a/src/server/transactions/rules.ts
+++ b/src/server/transactions/rules.ts
@@ -138,23 +138,46 @@ export function assertNotSelf(here: AccountInfo, there: AccountInfo, field: stri
   if (here.id === there.id) throw new DomainError('transfer_to_self', 'A transfer needs two different accounts.', field);
 }
 
-/** Picks the rate a foreign amount is booked at: the one sent with the request, else the one already stored. */
+/** A rate to PLN, and whether the user entered it (spec §9: `fx_rate_manual`) or it is NBP's. */
+export interface Rate {
+  rate: string;
+  manual: boolean;
+}
+
+/** Stands in for a rate nobody has yet (see `Rates.unknown`); plans book it as no rate at all. */
+export const UNKNOWN_RATE: Rate = { rate: '1', manual: false };
+
+/** Picks the rate a foreign amount is booked at: the one sent, else one already stored, else NBP's default. */
 export interface Rates {
   /** The `fxRate` of the request. */
   input: string | null;
-  /** Rates of the saved transaction by currency (edits keep them). */
-  stored: Map<string, string>;
+  /** Rates of the saved transaction by currency that still apply (see `storedRates`). */
+  stored: Map<string, Rate>;
+  /** NBP rates for the draft's date by currency, quoted before the command ran (see `default-rates.ts`). */
+  defaults: Map<string, string>;
+  /**
+   * When set, a currency that has no rate is collected here and booked at `UNKNOWN_RATE` instead of refused: a dry
+   * run learns which rates to quote, and a schedule leaves its rate to the day it is entered (P2d2).
+   */
+  unknown: Set<string> | null;
   /** Set once `input` has been used, so an unneeded rate can be refused. */
   used: boolean;
 }
 
-export function rateFor(rates: Rates, currency: string): string {
-  const rate = rates.input ?? rates.stored.get(currency);
-  if (rate === undefined) {
-    throw new DomainError('fx_rate_required', `Enter the exchange rate of ${currency} to ${BASE_CURRENCY}.`, 'fxRate');
+export function rateFor(rates: Rates, currency: string): Rate {
+  if (rates.input !== null) {
+    rates.used = true;
+    return { rate: rates.input, manual: true };
+  }
+  const stored = rates.stored.get(currency);
+  if (stored) return stored;
+  const nbp = rates.defaults.get(currency);
+  if (nbp !== undefined) return { rate: nbp, manual: false };
+  if (rates.unknown) {
+    rates.unknown.add(currency);
+    return UNKNOWN_RATE;
   }
-  if (rates.input !== null) rates.used = true;
-  return rate;
+  throw new DomainError('fx_rate_required', `Enter the exchange rate of ${currency} to ${BASE_CURRENCY}.`, 'fxRate');
 }
 
 /** Throws when the request sent a rate that nothing used. */
@@ -171,12 +194,8 @@ export function toBase(amount: Money, rate: string): Money {
 }
 
 /** Native amount → PLN (spec §9): PLN amounts are their own base; foreign ones need a rate. */
-export function bookedBase(
-  currency: string,
-  amount: Money,
-  rates: Rates,
-): { amountBase: Money; fxRate: string | null } {
-  if (currency === BASE_CURRENCY) return { amountBase: amount, fxRate: null };
+export function bookedBase(currency: string, amount: Money, rates: Rates): { amountBase: Money; rate: Rate | null } {
+  if (currency === BASE_CURRENCY) return { amountBase: amount, rate: null };
   const rate = rateFor(rates, currency);
-  return { amountBase: toBase(amount, rate), fxRate: rate };
+  return { amountBase: toBase(amount, rate.rate), rate };
 }
PATCH
```

- [ ] **Step 4: Plan with default rates; split the draft from the command**

```bash
git apply <<'PATCH'
diff --git a/src/server/transactions/transaction-commands.ts b/src/server/transactions/transaction-commands.ts
index 6101f57..28bdc6c 100644
--- a/src/server/transactions/transaction-commands.ts
+++ b/src/server/transactions/transaction-commands.ts
@@ -2,11 +2,12 @@ import { eq } from 'drizzle-orm';
 import type { CreateTransactionRequest, UpdateTransactionRequest } from '../../shared/api/transactions';
 import type { IsoDate } from '../../engine';
 import type { ChangeRecorder } from '../commands/recorder';
+import type { Executor } from '../db/client';
 import { payee, subtransaction, transaction } from '../db/schema';
 import { AppError, DomainError } from '../http/errors';
 import { findOrCreatePayee } from '../payees/payee-commands';
 import { accountsOf, type Aggregate, draftOf, loadAggregate, storedRates } from './aggregate';
-import { type Draft, type DraftLine, type Plan, planTransaction, type RowPlan } from './plan';
+import { type Draft, type DraftLine, type Plan, type PlanContext, planTransaction, type RowPlan } from './plan';
 import { findAccount } from './rules';
 import { insertPlan, insertSchedule, rememberCategory, softDelete, syncPlan } from './write';
 
@@ -25,18 +26,17 @@ export function savedLabel(saved: SavedTransaction): string {
   return saved.payeeName === null ? verb : `${verb} "${saved.payeeName}"`;
 }
 
-/**
- * Spec §10 "Creating and editing": manual transactions are approved; a new payee name creates the payee; a date
- * after today becomes a one-time scheduled transaction (spec §5.6).
- */
-export async function createTransaction(
-  rec: ChangeRecorder,
+/** Resolves a payee name the user typed: the command finds or creates the payee, a dry run only looks it up. */
+export type PayeeByName = (name: string) => Promise<string | null>;
+
+/** The new transaction as a draft (manual transactions are approved). */
+export async function createDraft(
   input: CreateTransactionRequest,
   today: IsoDate,
-): Promise<SavedTransaction> {
-  const payeeId =
-    input.payeeName === undefined ? (input.payeeId ?? null) : await findOrCreatePayee(rec, input.payeeName);
-  const draft: Draft = {
+  payeeByName: PayeeByName,
+): Promise<Draft> {
+  const payeeId = input.payeeName === undefined ? (input.payeeId ?? null) : await payeeByName(input.payeeName);
+  return {
     accountId: input.accountId,
     date: input.date ?? today,
     payeeId,
@@ -50,9 +50,25 @@ export async function createTransaction(
     flag: input.flag,
     lines: input.lines?.map((line) => ({ ...line, memo: line.memo || null })) ?? null,
   };
-  const plan = await planTransaction(rec.tx, draft);
+}
+
+/**
+ * Spec §10 "Creating and editing": a new payee name creates the payee; a date after today becomes a one-time
+ * scheduled transaction (spec §5.6). A foreign amount without `fxRate` is booked at `defaults`, the NBP rates the
+ * caller quoted for its date (spec §9); a schedule stores the rate sent, or none (the NBP rate of the day it is
+ * entered applies then).
+ */
+export async function createTransaction(
+  rec: ChangeRecorder,
+  input: CreateTransactionRequest,
+  today: IsoDate,
+  defaults = new Map<string, string>(),
+): Promise<SavedTransaction> {
+  const draft = await createDraft(input, today, (name) => findOrCreatePayee(rec, name));
+  const future = draft.date > today;
+  const plan = await planTransaction(rec.tx, draft, future ? { unknownRates: new Set() } : { defaults });
   const payeeName = plan.payee?.name ?? null;
-  if (draft.date > today) {
+  if (future) {
     if (plan.transfer && plan.transfer.currency !== plan.account.currency) {
       // A schedule has no column for the other side's amount.
       throw new DomainError(
@@ -69,6 +85,8 @@ export async function createTransaction(
 export interface EditContext {
   today: IsoDate;
   now: Date;
+  /** Spec §9: NBP rates for the edited date by currency, quoted before the command (none for bulk edits). */
+  defaults?: Map<string, string>;
 }
 
 /** The payee's name for undo labels. */
@@ -163,7 +181,7 @@ const sameLines = (a: DraftLine[] | null, b: DraftLine[] | null) =>
     ));
 
 /** The saved draft with the request's changes applied. */
-async function applyPatch(rec: ChangeRecorder, agg: Aggregate, patch: UpdateTransactionRequest): Promise<Draft> {
+async function applyPatch(agg: Aggregate, patch: UpdateTransactionRequest, payeeByName: PayeeByName): Promise<Draft> {
   const current = draftOf(agg);
   const lines =
     patch.lines === undefined
@@ -171,7 +189,7 @@ async function applyPatch(rec: ChangeRecorder, agg: Aggregate, patch: UpdateTran
       : (patch.lines?.map((line) => ({ ...line, memo: line.memo || null })) ?? null);
   const payeeId =
     patch.payeeName !== undefined
-      ? await findOrCreatePayee(rec, patch.payeeName)
+      ? await payeeByName(patch.payeeName)
       : patch.payeeId !== undefined
         ? patch.payeeId
         : current.payeeId;
@@ -236,9 +254,27 @@ async function assertSameCurrency(rec: ChangeRecorder, agg: Aggregate, draft: Dr
   }
 }
 
+/** The edited transaction as a draft, with what the saved one already has for planning it. */
+export async function editDraft(
+  db: Executor,
+  agg: Aggregate,
+  patch: UpdateTransactionRequest,
+  payeeByName: PayeeByName,
+): Promise<{ draft: Draft; context: PlanContext }> {
+  const draft = await applyPatch(agg, patch, payeeByName);
+  const existing = {
+    payeeId: agg.main.payeeId,
+    rates: await storedRates(db, agg, draft.date === agg.main.date),
+    counterpart: agg.counterpart && { accountId: agg.counterpart.accountId, amount: agg.counterpart.amount },
+    accountIds: accountsOf(agg),
+  };
+  return { draft, context: { existing } };
+}
+
 /**
  * PATCH /api/transactions/:id (spec §10 "Creating and editing", "Transfers"): the edited transaction is planned again
- * with every rule of a new one, then its rows are brought in line.
+ * with every rule of a new one, then its rows are brought in line. Spec §9: a new date replaces an NBP rate with that
+ * day's (from `context.defaults`); a manual rate stays until a new one is sent.
  */
 export async function updateTransaction(
   rec: ChangeRecorder,
@@ -251,7 +287,8 @@ export async function updateTransaction(
     await updateLineCounterpart(rec, { ...agg, owner: agg.owner }, patch);
     return { payeeName: await payeeNameOf(rec, agg.main.payeeId) };
   }
-  const draft = await applyPatch(rec, agg, patch);
+  const prepared = await editDraft(rec.tx, agg, patch, (name) => findOrCreatePayee(rec, name));
+  const draft = prepared.draft;
   if (patch.date !== undefined && patch.date > context.today) {
     throw new DomainError(
       'date_in_future',
@@ -261,14 +298,7 @@ export async function updateTransaction(
   }
   assertStartingBalanceKept(agg, draft);
   await assertSameCurrency(rec, agg, draft);
-  const plan = await planTransaction(rec.tx, draft, {
-    existing: {
-      payeeId: agg.main.payeeId,
-      rates: await storedRates(rec.tx, agg),
-      counterpart: agg.counterpart && { accountId: agg.counterpart.accountId, amount: agg.counterpart.amount },
-      accountIds: accountsOf(agg),
-    },
-  });
+  const plan = await planTransaction(rec.tx, draft, { ...prepared.context, defaults: context.defaults });
   const replaceLines = !sameLines(draftOf(agg).lines, draft.lines);
   assertConfirmed(editTouchesReconciled(agg, plan, replaceLines), patch.confirmReconciled);
   await syncPlan(rec, agg, plan, context.now, replaceLines);
PATCH
```

- [ ] **Step 5: Quote the missing rates before the command**

Create `src/server/transactions/default-rates.ts`:

```ts
import type { CreateTransactionRequest, UpdateTransactionRequest } from '../../shared/api/transactions';
import type { IsoDate } from '../../engine';
import type { Db } from '../db/client';
import type { FxRates } from '../fx/fx-rates';
import { AppError } from '../http/errors';
import { findUserPayeeByName } from '../payees/payee-commands';
import { loadAggregate } from './aggregate';
import { type Draft, type PlanContext, planTransaction } from './plan';
import { createDraft, editDraft, type PayeeByName } from './transaction-commands';

interface Deps {
  db: Db;
  fx: FxRates;
}

/** A dry run only looks payees up: a name nobody has yet is a new user payee, never a transfer. */
const lookUpPayee =
  (db: Db): PayeeByName =>
  async (name) =>
    (await findUserPayeeByName(db, name))?.id ?? null;

/**
 * Spec §9 default rates, resolved before the command: plans the write without writing (outside any transaction and
 * the command lock) to learn which currencies still need a rate, i.e. none was sent or stored, and quotes them from
 * NBP for the draft's date. The command then plans again with these defaults; a currency NBP has no rate for stays
 * missing, so the command answers 422 `fx_rate_required`. Errors of the dry run are left to the command to report.
 */
async function quoteMissingRates(
  deps: Deps,
  prepare: () => Promise<{ draft: Draft; context: PlanContext } | null>,
): Promise<Map<string, string>> {
  const unknownRates = new Set<string>();
  let date: IsoDate | null = null;
  try {
    const prepared = await prepare();
    if (!prepared) return new Map();
    date = prepared.draft.date;
    await planTransaction(deps.db, prepared.draft, { ...prepared.context, unknownRates });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
  }
  const defaults = new Map<string, string>();
  for (const currency of unknownRates) {
    const quote = await deps.fx.quote(currency, date!);
    if (quote) defaults.set(currency, quote.rate);
  }
  return defaults;
}

/** NBP rates a new transaction needs. A future-dated one becomes a schedule, which takes no NBP rate. */
export function createDefaultRates(
  deps: Deps,
  input: CreateTransactionRequest,
  today: IsoDate,
): Promise<Map<string, string>> {
  return quoteMissingRates(deps, async () => {
    const draft = await createDraft(input, today, lookUpPayee(deps.db));
    return draft.date > today ? null : { draft, context: {} };
  });
}

/** NBP rates an edit needs: rates the transaction doesn't have, or NBP rates of a date that changed. */
export function editDefaultRates(
  deps: Deps,
  id: string,
  patch: UpdateTransactionRequest,
  today: IsoDate,
): Promise<Map<string, string>> {
  return quoteMissingRates(deps, async () => {
    const agg = await loadAggregate(deps.db, id);
    // A split line's counterpart takes no rate, and no edit moves a transaction past today.
    if (agg.owner || (patch.date !== undefined && patch.date > today)) return null;
    return editDraft(deps.db, agg, patch, lookUpPayee(deps.db));
  });
}
```

```bash
git apply <<'PATCH'
diff --git a/src/server/transactions/transaction-queries.ts b/src/server/transactions/transaction-queries.ts
index 1cdf275..f31f002 100644
--- a/src/server/transactions/transaction-queries.ts
+++ b/src/server/transactions/transaction-queries.ts
@@ -94,6 +94,7 @@ export async function loadTransactions(db: Executor, where?: SQL, limit?: number
       amount: txn.amount,
       amountBase: txn.amountBase,
       fxRate: txn.fxRate,
+      fxRateManual: txn.fxRateManual,
       effectiveRate: rateOf(currency, txn.amount, txn.amountBase),
       cleared: txn.cleared,
       approved: txn.approved,
diff --git a/src/server/transactions/transaction-routes.ts b/src/server/transactions/transaction-routes.ts
index 41a0dee..9b0c2f8 100644
--- a/src/server/transactions/transaction-routes.ts
+++ b/src/server/transactions/transaction-routes.ts
@@ -17,6 +17,7 @@ import { runCommand } from '../commands/run-command';
 import type { AppDeps } from '../http/app';
 import { validate } from '../http/validate';
 import { bulkLabel, bulkUpdate } from './bulk';
+import { createDefaultRates, editDefaultRates } from './default-rates';
 import {
   createTransaction,
   deleteLabel,
@@ -38,7 +39,10 @@ export function transactionRoutes(deps: AppDeps) {
     )
     .post('/', validate('json', createTransactionRequestSchema), async (c) => {
       const body = c.req.valid('json');
-      const saved = await runCommand(deps, savedLabel, (rec) => createTransaction(rec, body, today()));
+      const now = today();
+      // Spec §9: NBP rates are quoted before the command, outside its transaction.
+      const defaults = await createDefaultRates(deps, body, now);
+      const saved = await runCommand(deps, savedLabel, (rec) => createTransaction(rec, body, now, defaults));
       if (saved.kind === 'scheduled') {
         return c.json<CreateTransactionResponse>({ kind: 'scheduled', scheduledId: saved.id, date: saved.date }, 201);
       }
@@ -58,7 +62,8 @@ export function transactionRoutes(deps: AppDeps) {
       const { id } = c.req.valid('param');
       const body = c.req.valid('json');
       const context = { today: today(), now: deps.clock.now() };
-      await runCommand(deps, editLabel, (rec) => updateTransaction(rec, id, body, context));
+      const defaults = await editDefaultRates(deps, id, body, context.today);
+      await runCommand(deps, editLabel, (rec) => updateTransaction(rec, id, body, { ...context, defaults }));
       return c.json<TransactionDto>(await getTransaction(deps.db, id));
     })
     .delete('/:id', validate('param', idParamSchema), validate('json', deleteTransactionRequestSchema), async (c) => {
diff --git a/src/shared/api/transactions.ts b/src/shared/api/transactions.ts
index 929a23c..72ed6c6 100644
--- a/src/shared/api/transactions.ts
+++ b/src/shared/api/transactions.ts
@@ -61,8 +61,10 @@ export const createTransactionRequestSchema = z
     /** Transfers between currencies: the other account's native amount (opposite sign). */
     transferAmount: moneySchema.optional(),
     /**
-     * Rate to PLN; required for foreign-currency accounts until the NBP lookup exists (P2d). For a transfer between
-     * two foreign-currency accounts it is the rate of the sending account's currency (spec §9).
+     * Rate to PLN, stored as manual. Without it a foreign amount is booked at the NBP rate of `date` (spec §9), and
+     * the answer is 422 `fx_rate_required` when NBP has none; a future date stores no rate (the schedule's occurrence
+     * gets the NBP rate of its day). For a transfer between two foreign-currency accounts it is the rate of the sending
+     * account's currency.
      */
     fxRate: fxRateSchema.optional(),
     cleared: userClearedSchema.default('uncleared'),
@@ -103,6 +105,7 @@ export const updateTransactionRequestSchema = z
     memo: memoSchema.optional(),
     amount: moneySchema.optional(),
     transferAmount: moneySchema.optional(),
+    /** A new manual rate. Without it the stored rate stays; a new date replaces an NBP rate with that day's. */
     fxRate: fxRateSchema.optional(),
     cleared: userClearedSchema.optional(),
     approved: z.boolean().optional(),
@@ -269,8 +272,10 @@ export interface TransactionDto {
   amount: number;
   /** PLN (spec §9). */
   amountBase: number;
-  /** The rate the user entered; null for PLN accounts and for amounts derived from the other side of a transfer. */
+  /** The rate the base amount was booked at; null for PLN accounts and for bases derived from the other side. */
   fxRate: string | null;
+  /** True when the user entered `fxRate`, false for an NBP rate (and when there is none). */
+  fxRateManual: boolean;
   /** |amountBase| / |amount| for foreign-currency accounts (null for PLN accounts and zero amounts). */
   effectiveRate: string | null;
   cleared: ClearedStatus;
PATCH
```

- [ ] **Step 6: Run the tests and the final checks**

Run: `npx vitest run --project server src/server/transactions/fx-defaults.test.ts src/server/transactions/create-transaction.test.ts`
Expected: `Tests  17 passed (17)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  55 passed (55)`, `Tests  487 passed (487)`; both checks exit 0. (P2c's tests that send `fxRate` are unchanged: a sent rate still wins, and the default stub has no rates.)

- [ ] **Step 7: Commit**

```bash
git add src/server/transactions src/shared/api/transactions.ts
git commit -m "feat(server): NBP default rates for transactions, splits, transfers and date changes" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: "≈ X zł" on accounts and Revalue (golden scenario 11)

Spec §9 "Account display" and "Revalue", §11 Accounts and Register, §14 golden scenario 11.

**≈ X zł.** `AccountDto` gains `latestRate` (`{ rate, effectiveDate }`, today's NBP quote with its fallback) and `balanceAtLatestRate` (the working balance at that rate, in PLN), both null for PLN accounts and when NBP has no rate. Account reads must not block for long on NBP: `readAccounts(deps, today, where?)` reads the distinct currencies, quotes each foreign one **once per request, in parallel and before any query of the response** (`latestRates`), then builds the DTOs with `listAccounts`. The cache answers final rates without a request, and each quote is bounded by NBP's 5 s timeout. Every account route's response now goes through `readAccount(s)`; `listAccounts` / `getAccount` inside commands and the register header stay without rates.

**Revalue.** `POST /api/accounts/:id/revalue` (optional `{ fxRate }`): the route quotes today's NBP rate before the command (none for PLN or with a sent rate), and `revalueAccount`:
- refuses PLN accounts (422 `revalue_pln`), closed ones (422 `account_closed`) and a missing rate (422 `fx_rate_required`);
- computes `revaluationDiff(balance.working, rate, balanceBase.working)` (engine) and refuses 0 (422 `revalue_no_difference`);
- inserts the transaction: today, amount 0, `amount_base` = the difference, payee FX revaluation, cleared, Ready to Assign on budget accounts and no category on tracking ones, `fx_rate` the rate (manual when sent).

It is one undoable command (`Revalue "<name>"`) and answers `{ account, transaction }`. The row is inserted directly: planning derives base amounts from amounts, and this amount is 0. For the same reason an **FX revaluation keeps its amounts**: an edit may change only memo, flag, cleared and approved (422 `revaluation_fixed` naming the field otherwise, bulk edits included), and deleting it takes it back.

Golden scenario 11: a PLN → EUR transfer nets to 0 in Ready to Assign, and Revalue posts the difference (9 300 EUR cents × 4.40 − 40 000 = 920 grosze) to Ready to Assign.

**Files:**
- Create: `src/server/accounts/revalue.ts`
- Modify: `src/server/fx/fx-rates.ts` (`latestRates`), `src/server/accounts/account-queries.ts`, `src/server/accounts/account-routes.ts`, `src/shared/api/accounts.ts`, `src/server/transactions/transaction-commands.ts`
- Test: `src/server/accounts/revalue.test.ts` (new), `src/server/accounts/account-routes.test.ts` (the full DTO), `src/server/http/app.test.ts`

**Interfaces:**
- Consumes: Task 1–3; `revaluationDiff`, `convertToBase` (engine); `systemPayeeId`, `systemCategoryId`; `getTransaction`.
- Produces:
  - `latestRates(fx, currencies, today): Promise<Map<currency, FxQuote>>`.
  - `listAccounts(db, where?, rates?)`, `readAccounts(deps, today, where?)`, `readAccount(deps, today, id)`.
  - `AccountDto.latestRate: FxRateDto | null`, `AccountDto.balanceAtLatestRate: number | null`; `revalueRequestSchema`, `RevalueResponse { account, transaction }`.
  - `revalueAccount(rec, id, rate: Rate | null, today) → { name, transactionId }`; route `POST /:id/revalue`.

- [ ] **Step 1: Write the failing tests**

Create `src/server/accounts/revalue.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDto, AccountListResponse, RevalueResponse } from '../../shared/api/accounts';
import type { BudgetMonthDto } from '../../shared/api/budget';
import type { TransactionDto } from '../../shared/api/transactions';
import { systemCategoryId, systemPayeeId } from '../db/lookups';
import { ledgerLine } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createTransaction, ledgerLines } from '../test/fixtures';
import { type StubFx, stubFx } from '../test/fx';
import { snapshot } from '../test/snapshot';

let t: TestDatabase;
let ctx: TestApp;
let fx: StubFx;
let nbp: Record<string, Record<string, string>>;
beforeEach(async () => {
  t = await createTestDatabase();
  nbp = { EUR: { '2026-11-19': '4.3', '2026-11-20': '4.4' } };
  fx = stubFx(nbp);
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z', fx });
  await setUpBudget(ctx);
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

const accounts = async () => (await json<AccountListResponse>(await ctx.client.get('/api/accounts'))).body.accounts;
const readyToAssign = async () =>
  (await json<BudgetMonthDto>(await ctx.client.get('/api/budget/2026-11'))).body.rta.readyToAssign;
const revalue = (id: string, body?: object) => ctx.client.post(`/api/accounts/${id}/revalue`, body);
const foreign = (name: string, extra: object = {}) =>
  createAccount(ctx.client, { name, type: 'savings', currency: 'EUR', startingDate: '2026-11-19', ...extra });

describe('"≈ X zł" on accounts', () => {
  it('shows foreign balances at the latest NBP rate, quoting each currency once', async () => {
    await createAccount(ctx.client, { name: 'mBank', startingBalance: 100_000 });
    await foreign('Revolut', { startingBalance: 9_300 });
    await foreign('Wise', { startingBalance: -1_001 });
    await createAccount(ctx.client, { name: 'Dollars', type: 'savings', currency: 'USD', fxRate: '3.9' });
    fx.calls.splice(0);

    const list = await accounts();
    expect(list.map((a) => [a.name, a.balanceBase.working, a.latestRate, a.balanceAtLatestRate])).toEqual([
      ['mBank', 100_000, null, null],
      ['Revolut', 39_990, { rate: '4.400000', effectiveDate: '2026-11-20' }, 40_920],
      // −1 001 × 4.4 = −4 404.4 → −4 404
      ['Wise', -4_304, { rate: '4.400000', effectiveDate: '2026-11-20' }, -4_404],
      // NBP has no USD rate in this stub.
      ['Dollars', 0, null, null],
    ]);
    expect(fx.calls.sort((a, b) => a.currency.localeCompare(b.currency))).toEqual([
      { currency: 'EUR', date: '2026-11-20' },
      { currency: 'USD', date: '2026-11-20' },
    ]);
  });
});

describe('POST /api/accounts/:id/revalue', () => {
  it('nets a PLN → EUR transfer to 0 and revalues the difference into Ready to Assign (golden 11)', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 100_000 });
    const euro = await foreign('Revolut');
    await createTransaction(ctx.client, {
      accountId: checking.id,
      date: '2026-11-19',
      payeeId: euro.transferPayeeId,
      amount: -40_000,
      transferAmount: 9_300,
    });
    expect(await readyToAssign()).toBe(100_000);
    const before = await snapshot(t.db);

    const res = await json<RevalueResponse>(await revalue(euro.id));
    expect(res.status).toBe(200);
    // 9 300 × 4.4 = 40 920; 40 000 was booked.
    expect(res.body.transaction).toMatchObject<Partial<TransactionDto>>({
      accountId: euro.id,
      date: '2026-11-20',
      payeeId: await systemPayeeId(t.db, 'fx_revaluation'),
      payeeName: 'FX revaluation',
      categoryId: await systemCategoryId(t.db, 'rta'),
      amount: 0,
      amountBase: 920,
      fxRate: '4.400000',
      fxRateManual: false,
      cleared: 'cleared',
    });
    expect(res.body.account).toMatchObject<Partial<AccountDto>>({
      balance: { cleared: 0, uncleared: 9_300, working: 9_300 },
      balanceBase: { cleared: 920, uncleared: 40_000, working: 40_920 },
      balanceAtLatestRate: 40_920,
    });
    expect(await readyToAssign()).toBe(100_920);
    expect((await ledgerLines(t.db, eq(ledgerLine.txnId, res.body.transaction.id))).map((l) => l.amountBase)).toEqual([
      920,
    ]);
    const after = await snapshot(t.db);

    expect((await json(await ctx.client.post('/api/undo'))).body).toMatchObject({
      undone: { label: 'Revalue "Revolut"' },
    });
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);
    expect((await json(await revalue(euro.id))).body).toMatchObject({ code: 'revalue_no_difference' });
  });

  it('revalues a tracking account without a category, at a rate the user sends when NBP has none', async () => {
    delete nbp.EUR;
    const loan = await createAccount(ctx.client, {
      name: 'Car loan',
      type: 'auto_loan',
      currency: 'EUR',
      startingBalance: -10_000,
      fxRate: '4.3',
    });
    expect(await json(await revalue(loan.id))).toEqual({
      status: 422,
      body: {
        code: 'fx_rate_required',
        message: 'Enter the exchange rate of EUR to PLN.',
        fieldErrors: { fxRate: ['Enter the exchange rate of EUR to PLN.'] },
      },
    });
    const res = await json<RevalueResponse>(await revalue(loan.id, { fxRate: '4.35' }));
    expect(res.body.transaction).toMatchObject({
      categoryId: null,
      amount: 0,
      amountBase: -500,
      fxRate: '4.350000',
      fxRateManual: true,
    });
    expect(await readyToAssign()).toBe(0);
  });

  it('refuses PLN, closed and unknown accounts', async () => {
    const checking = await createAccount(ctx.client, { name: 'mBank' });
    expect(await json(await revalue(checking.id))).toEqual({
      status: 422,
      body: { code: 'revalue_pln', message: 'PLN accounts have nothing to revalue.' },
    });
    const euro = await foreign('Revolut');
    await ctx.client.post(`/api/accounts/${euro.id}/close`);
    expect((await json(await revalue(euro.id))).body).toMatchObject({ code: 'account_closed' });
    expect((await json(await revalue(crypto.randomUUID()))).status).toBe(404);
  });

  it('keeps an FX revaluation to its memo, flag and cleared status; deleting it takes it back', async () => {
    const euro = await foreign('Revolut', { startingBalance: 1_000 });
    const { body } = await json<RevalueResponse>(await revalue(euro.id));
    const path = `/api/transactions/${body.transaction.id}`;

    expect((await json(await ctx.client.send('PATCH', path, { memo: 'Nov', flag: 'blue' }))).body).toMatchObject({
      memo: 'Nov',
      flag: 'blue',
      amountBase: 100,
    });
    const fixed = 'An FX revaluation only takes a memo, flag or cleared status. Delete it to take it back.';
    expect(await json(await ctx.client.send('PATCH', path, { date: '2026-11-19' }))).toEqual({
      status: 422,
      body: { code: 'revaluation_fixed', message: fixed, fieldErrors: { date: [fixed] } },
    });
    expect((await ctx.client.send('DELETE', path)).status).toBe(200);
    expect((await accounts())[0]!.balanceBase.working).toBe(4_300);
  });
});
```

```bash
git apply <<'PATCH'
diff --git a/src/server/accounts/account-routes.test.ts b/src/server/accounts/account-routes.test.ts
index a505539..8342733 100644
--- a/src/server/accounts/account-routes.test.ts
+++ b/src/server/accounts/account-routes.test.ts
@@ -67,6 +67,8 @@ describe('POST /api/accounts', () => {
       pairedCategoryId: null,
       balance,
       balanceBase: balance,
+      latestRate: null,
+      balanceAtLatestRate: null,
     });
     const [transferPayee] = await t.db.select().from(payee).where(eq(payee.id, res.body.transferPayeeId));
     expect(transferPayee).toMatchObject({ name: 'Transfer : mBank', transferAccountId: res.body.id });
diff --git a/src/server/http/app.test.ts b/src/server/http/app.test.ts
index a64e3da..04eb67b 100644
--- a/src/server/http/app.test.ts
+++ b/src/server/http/app.test.ts
@@ -89,6 +89,7 @@ describe('route guard', () => {
         'POST /api/categories/:id/target/snooze',
         'DELETE /api/categories/:id/target/snooze',
         'GET /api/fx/rates/:currency/:date',
+        'POST /api/accounts/:id/revalue',
       ]),
     );
 
PATCH
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project server src/server/accounts/revalue.test.ts src/server/accounts/account-routes.test.ts src/server/http/app.test.ts`
Expected: FAIL, `Tests  7 failed | 26 passed (33)`: accounts have no `latestRate`, the revalue route answers 404, and the route walk misses it.

- [ ] **Step 3: Quote the latest rates for account responses**

```bash
git apply <<'PATCH'
diff --git a/src/server/accounts/account-queries.ts b/src/server/accounts/account-queries.ts
index 6fd2301..bbeac61 100644
--- a/src/server/accounts/account-queries.ts
+++ b/src/server/accounts/account-queries.ts
@@ -1,7 +1,9 @@
 import { and, asc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
-import type { AccountBalances, AccountDto } from '../../shared/api/accounts';
-import type { Executor } from '../db/client';
+import { type AccountBalances, type AccountDto, BASE_CURRENCY } from '../../shared/api/accounts';
+import { convertToBase, type IsoDate } from '../../engine';
+import type { Db, Executor } from '../db/client';
 import { account, category, payee, transaction } from '../db/schema';
+import { type FxQuote, type FxRates, latestRates } from '../fx/fx-rates';
 import { AppError } from '../http/errors';
 
 interface Sums {
@@ -38,8 +40,21 @@ async function sumsByAccount(db: Executor, accountIds: string[]): Promise<Map<st
   return new Map(rows.map(({ accountId, ...sums }) => [accountId, sums]));
 }
 
-/** Accounts in display order (spec §11 Accounts), with their balances. */
-export async function listAccounts(db: Executor, where?: SQL): Promise<AccountDto[]> {
+/** The working balance in PLN at the latest rate ("≈ X zł"); null when it can't be stored exactly. */
+function atRate(working: number, quote: FxQuote | null): number | null {
+  const base = quote && convertToBase(working, quote.rate);
+  return base !== null && Number.isSafeInteger(base) ? base : null;
+}
+
+/**
+ * Accounts in display order (spec §11 Accounts), with their balances. `rates` holds the latest NBP rate by currency
+ * for "≈ X zł" (see `readAccounts`); without one, a foreign account's `latestRate` is null.
+ */
+export async function listAccounts(
+  db: Executor,
+  where?: SQL,
+  rates = new Map<string, FxQuote>(),
+): Promise<AccountDto[]> {
   const rows = await db
     .select({ account, transferPayeeId: payee.id, linkedCategoryId: category.id })
     .from(account)
@@ -50,6 +65,7 @@ export async function listAccounts(db: Executor, where?: SQL): Promise<AccountDt
   const sums = await sumsByAccount(db, rows.map((r) => r.account.id));
   return rows.map(({ account: a, transferPayeeId, linkedCategoryId }) => {
     const s = sums.get(a.id) ?? ZERO;
+    const latestRate = a.currency === BASE_CURRENCY ? null : (rates.get(a.currency) ?? null);
     return {
       id: a.id,
       name: a.name,
@@ -69,6 +85,8 @@ export async function listAccounts(db: Executor, where?: SQL): Promise<AccountDt
       pairedCategoryId: a.pairedCategoryId,
       balance: balances(s.cleared, s.uncleared),
       balanceBase: balances(s.clearedBase, s.unclearedBase),
+      latestRate,
+      balanceAtLatestRate: atRate(s.cleared + s.uncleared, latestRate),
     };
   });
 }
@@ -78,3 +96,19 @@ export async function getAccount(db: Executor, id: string): Promise<AccountDto>
   if (!found) throw new AppError(404, 'not_found', 'Account not found.');
   return found;
 }
+
+/**
+ * Accounts for API responses, with "≈ X zł": the latest NBP rate of each foreign currency is quoted first, once per
+ * currency, outside any transaction (cache first; each quote is bounded by NBP's 5 s timeout).
+ */
+export async function readAccounts(deps: { db: Db; fx: FxRates }, today: IsoDate, where?: SQL): Promise<AccountDto[]> {
+  const currencies = await deps.db.selectDistinct({ currency: account.currency }).from(account).where(where);
+  const rates = await latestRates(deps.fx, currencies.map((row) => row.currency), today);
+  return listAccounts(deps.db, where, rates);
+}
+
+export async function readAccount(deps: { db: Db; fx: FxRates }, today: IsoDate, id: string): Promise<AccountDto> {
+  const [found] = await readAccounts(deps, today, eq(account.id, id));
+  if (!found) throw new AppError(404, 'not_found', 'Account not found.');
+  return found;
+}
diff --git a/src/server/fx/fx-rates.ts b/src/server/fx/fx-rates.ts
index 77deb4a..249bcc9 100644
--- a/src/server/fx/fx-rates.ts
+++ b/src/server/fx/fx-rates.ts
@@ -109,3 +109,18 @@ export function nbpRates(options: NbpRatesOptions): FxRates {
     },
   };
 }
+
+/**
+ * Spec §9 "the latest available NBP rate" of each currency: today's quote (NBP falls back to the last published day),
+ * asked once per currency and all at once. Run it before any transaction: final rates come from the cache, and each
+ * NBP quote is bounded by its 5 s timeout. Currencies without a rate are left out.
+ */
+export async function latestRates(
+  fx: FxRates,
+  currencies: Iterable<string>,
+  today: IsoDate,
+): Promise<Map<string, FxQuote>> {
+  const foreign = [...new Set(currencies)].filter((currency) => currency !== BASE_CURRENCY);
+  const quotes = await Promise.all(foreign.map((currency) => fx.quote(currency, today)));
+  return new Map(foreign.flatMap((currency, i) => (quotes[i] ? [[currency, quotes[i]] as const] : [])));
+}
PATCH
```

- [ ] **Step 4: Add Revalue**

Create `src/server/accounts/revalue.ts`:

```ts
import { BASE_CURRENCY } from '../../shared/api/accounts';
import { type IsoDate, revaluationDiff } from '../../engine';
import type { ChangeRecorder } from '../commands/recorder';
import { systemCategoryId, systemPayeeId } from '../db/lookups';
import { transaction } from '../db/schema';
import { DomainError } from '../http/errors';
import type { Rate } from '../transactions/rules';
import { getAccount } from './account-queries';

/**
 * Spec §9 Revalue: books a foreign account's unrealized FX difference, round(native balance × latest rate) −
 * Σ amount_base, as a cleared transaction dated today with amount 0, `amount_base` = the difference and the FX
 * revaluation payee; on budget accounts it is Ready to Assign income, tracking accounts take no category. The row is
 * written directly: planning derives base amounts from amounts, and this amount is 0. `rate` is the one sent, else
 * the latest NBP rate the caller quoted (null when NBP has none).
 */
export async function revalueAccount(
  rec: ChangeRecorder,
  id: string,
  rate: Rate | null,
  today: IsoDate,
): Promise<{ name: string; transactionId: string }> {
  const current = await getAccount(rec.tx, id);
  if (current.currency === BASE_CURRENCY) {
    throw new DomainError('revalue_pln', `${BASE_CURRENCY} accounts have nothing to revalue.`);
  }
  if (current.closed) {
    throw new DomainError('account_closed', `"${current.name}" is closed. Reopen it to revalue it.`);
  }
  if (!rate) {
    throw new DomainError('fx_rate_required', `Enter the exchange rate of ${current.currency} to PLN.`, 'fxRate');
  }
  const diff = revaluationDiff(current.balance.working, rate.rate, current.balanceBase.working);
  if (!Number.isSafeInteger(diff)) throw new DomainError('amount_too_large', 'That amount is too large.');
  if (diff === 0) {
    throw new DomainError('revalue_no_difference', 'The PLN balance already matches this rate.');
  }
  const [row] = await rec.insert(transaction, {
    accountId: id,
    date: today,
    payeeId: await systemPayeeId(rec.tx, 'fx_revaluation'),
    categoryId: current.accountClass === 'tracking' ? null : await systemCategoryId(rec.tx, 'rta'),
    amount: 0,
    amountBase: diff,
    fxRate: rate.rate,
    fxRateManual: rate.manual,
    cleared: 'cleared',
  });
  return { name: current.name, transactionId: row!.id };
}
```

```bash
git apply <<'PATCH'
diff --git a/src/server/accounts/account-routes.ts b/src/server/accounts/account-routes.ts
index b4b1125..43a5948 100644
--- a/src/server/accounts/account-routes.ts
+++ b/src/server/accounts/account-routes.ts
@@ -4,6 +4,8 @@ import {
   type AccountListResponse,
   BASE_CURRENCY,
   createAccountRequestSchema,
+  revalueRequestSchema,
+  type RevalueResponse,
   updateAccountRequestSchema,
 } from '../../shared/api/accounts';
 import { idParamSchema, type IdResponse, type ReorderResponse, reorderRequestSchema } from '../../shared/api/common';
@@ -12,16 +14,21 @@ import { todayIn } from '../clock';
 import { type Named, runCommand } from '../commands/run-command';
 import type { AppDeps } from '../http/app';
 import { validate } from '../http/validate';
+import { getTransaction } from '../transactions/transaction-queries';
 import { createAccount, deleteAccount, reorderAccounts, setAccountClosed, updateAccount } from './account-commands';
-import { getAccount, listAccounts } from './account-queries';
+import { getAccount, readAccount, readAccounts } from './account-queries';
+import { revalueAccount } from './revalue';
 
-/** /api/accounts (spec §10 "Accounts"): every change is one undoable command. */
+/**
+ * /api/accounts (spec §10 "Accounts", §9): every change is one undoable command. Account DTOs carry "≈ X zł" at
+ * the latest NBP rate, quoted after the command (see `readAccounts`).
+ */
 export function accountRoutes(deps: AppDeps) {
   const today = () => todayIn(deps.config.timeZone, deps.clock.now());
 
   return new Hono<AuthedEnv>()
     .use('*', requireSession(deps))
-    .get('/', async (c) => c.json<AccountListResponse>({ accounts: await listAccounts(deps.db) }))
+    .get('/', async (c) => c.json<AccountListResponse>({ accounts: await readAccounts(deps, today()) }))
     .post('/', validate('json', createAccountRequestSchema), async (c) => {
       const body = c.req.valid('json');
       const now = today();
@@ -32,7 +39,7 @@ export function accountRoutes(deps: AppDeps) {
       const { id } = await runCommand(deps, `Create account "${body.name}"`, (rec) =>
         createAccount(rec, body, now, nbp),
       );
-      return c.json<AccountDto>(await getAccount(deps.db, id), 201);
+      return c.json<AccountDto>(await readAccount(deps, now, id), 201);
     })
     .put('/order', validate('json', reorderRequestSchema), async (c) => {
       const { ids } = c.req.valid('json');
@@ -43,7 +50,7 @@ export function accountRoutes(deps: AppDeps) {
       const { id } = c.req.valid('param');
       const body = c.req.valid('json');
       await runCommand(deps, (r: Named) => `Edit account "${r.name}"`, (rec) => updateAccount(rec, id, body));
-      return c.json<AccountDto>(await getAccount(deps.db, id));
+      return c.json<AccountDto>(await readAccount(deps, today(), id));
     })
     .post('/:id/close', validate('param', idParamSchema), async (c) => {
       const { id } = c.req.valid('param');
@@ -52,7 +59,7 @@ export function accountRoutes(deps: AppDeps) {
         (r: Named) => `Close account "${r.name}"`,
         (rec) => setAccountClosed(rec, id, true, today()),
       );
-      return c.json<AccountDto>(await getAccount(deps.db, id));
+      return c.json<AccountDto>(await readAccount(deps, today(), id));
     })
     .post('/:id/reopen', validate('param', idParamSchema), async (c) => {
       const { id } = c.req.valid('param');
@@ -61,7 +68,25 @@ export function accountRoutes(deps: AppDeps) {
         (r: Named) => `Reopen account "${r.name}"`,
         (rec) => setAccountClosed(rec, id, false, today()),
       );
-      return c.json<AccountDto>(await getAccount(deps.db, id));
+      return c.json<AccountDto>(await readAccount(deps, today(), id));
+    })
+    .post('/:id/revalue', validate('param', idParamSchema), validate('json', revalueRequestSchema), async (c) => {
+      const { id } = c.req.valid('param');
+      const { fxRate } = c.req.valid('json');
+      const now = today();
+      // Spec §9: the latest NBP rate is quoted before the command, outside its transaction.
+      const { currency } = await getAccount(deps.db, id);
+      const nbp = fxRate === undefined && currency !== BASE_CURRENCY ? await deps.fx.quote(currency, now) : null;
+      const rate = fxRate === undefined ? nbp && { rate: nbp.rate, manual: false } : { rate: fxRate, manual: true };
+      const { transactionId } = await runCommand(
+        deps,
+        (r: Named) => `Revalue "${r.name}"`,
+        (rec) => revalueAccount(rec, id, rate, now),
+      );
+      return c.json<RevalueResponse>({
+        account: await readAccount(deps, now, id),
+        transaction: await getTransaction(deps.db, transactionId),
+      });
     })
     .delete('/:id', validate('param', idParamSchema), async (c) => {
       const { id } = c.req.valid('param');
diff --git a/src/shared/api/accounts.ts b/src/shared/api/accounts.ts
index fc94c54..712b83d 100644
--- a/src/shared/api/accounts.ts
+++ b/src/shared/api/accounts.ts
@@ -1,6 +1,8 @@
 import { z } from 'zod';
 import { ACCOUNT_TYPES, type AccountClass, type AccountType, accountClassOf, isLoanType } from '../accounts';
 import { isoDateSchema, moneySchema, nameSchema, nonNegativeMoneySchema, noteSchema } from './common';
+import type { FxRateDto } from './fx';
+import type { TransactionDto } from './transactions';
 
 /** Spec §1: the budget currency. */
 export const BASE_CURRENCY = 'PLN';
@@ -121,8 +123,27 @@ export interface AccountDto {
   balance: AccountBalances;
   /** In PLN: the sum of the booked base amounts. */
   balanceBase: AccountBalances;
+  /**
+   * Foreign-currency accounts: the latest NBP rate (today's, or the last published day's; spec §9). Null for PLN
+   * accounts, when NBP has none, and in responses built inside a command.
+   */
+  latestRate: FxRateDto | null;
+  /**
+   * "≈ X zł" (spec §9, §11): the working balance at `latestRate`, in PLN; null without a rate. Revalue books
+   * `balanceAtLatestRate − balanceBase.working`.
+   */
+  balanceAtLatestRate: number | null;
 }
 
 export interface AccountListResponse {
   accounts: AccountDto[];
 }
+
+/** POST /api/accounts/:id/revalue (spec §9). Without `fxRate` the latest NBP rate applies. */
+export const revalueRequestSchema = z.object({ fxRate: fxRateSchema.optional() });
+
+export interface RevalueResponse {
+  account: AccountDto;
+  /** The FX revaluation transaction: amount 0, `amountBase` = the difference. */
+  transaction: TransactionDto;
+}
PATCH
```

- [ ] **Step 5: Keep an FX revaluation's amounts**

```bash
git apply <<'PATCH'
diff --git a/src/server/transactions/transaction-commands.ts b/src/server/transactions/transaction-commands.ts
index 28bdc6c..6e338b3 100644
--- a/src/server/transactions/transaction-commands.ts
+++ b/src/server/transactions/transaction-commands.ts
@@ -3,6 +3,7 @@ import type { CreateTransactionRequest, UpdateTransactionRequest } from '../../s
 import type { IsoDate } from '../../engine';
 import type { ChangeRecorder } from '../commands/recorder';
 import type { Executor } from '../db/client';
+import { systemPayeeId } from '../db/lookups';
 import { payee, subtransaction, transaction } from '../db/schema';
 import { AppError, DomainError } from '../http/errors';
 import { findOrCreatePayee } from '../payees/payee-commands';
@@ -138,15 +139,19 @@ function editTouchesReconciled(agg: Aggregate, plan: Plan, replaceLines: boolean
 /** Fields that a split line's counterpart takes; everything else belongs to the split (spec §10 "Splits"). */
 const COUNTERPART_FIELDS = new Set(['memo', 'cleared', 'approved', 'flag', 'confirmReconciled']);
 
+/** The first field the patch changes beyond memo, cleared, approved and flag. */
+const amountsField = (patch: UpdateTransactionRequest) =>
+  Object.keys(patch).find(
+    (key) => patch[key as keyof UpdateTransactionRequest] !== undefined && !COUNTERPART_FIELDS.has(key),
+  );
+
 /** The counterpart of a split line: its memo mirrors the line's; cleared, approved and flag are its own. */
 async function updateLineCounterpart(
   rec: ChangeRecorder,
   agg: Aggregate & { owner: NonNullable<Aggregate['owner']> },
   patch: UpdateTransactionRequest,
 ): Promise<void> {
-  const field = Object.keys(patch).find(
-    (key) => patch[key as keyof UpdateTransactionRequest] !== undefined && !COUNTERPART_FIELDS.has(key),
-  );
+  const field = amountsField(patch);
   if (field !== undefined) {
     const split = await findAccount(rec.tx, agg.owner.parent.accountId);
     throw new DomainError(
@@ -167,6 +172,28 @@ async function updateLineCounterpart(
   await rec.update(subtransaction, eq(subtransaction.id, agg.owner.line.id), { memo });
 }
 
+/**
+ * Spec §9: an FX revaluation books a PLN difference on an amount of 0, which planning would turn back into 0. It takes
+ * what a split line's counterpart takes; deleting it takes the revaluation back.
+ */
+async function updateRevaluation(rec: ChangeRecorder, agg: Aggregate, patch: UpdateTransactionRequest): Promise<void> {
+  const field = amountsField(patch);
+  if (field !== undefined) {
+    throw new DomainError(
+      'revaluation_fixed',
+      'An FX revaluation only takes a memo, flag or cleared status. Delete it to take it back.',
+      field,
+    );
+  }
+  assertConfirmed(agg.main.cleared === 'reconciled' && patch.cleared !== undefined, patch.confirmReconciled);
+  await rec.update(transaction, eq(transaction.id, agg.main.id), {
+    memo: patch.memo === undefined ? undefined : patch.memo || null,
+    cleared: patch.cleared,
+    approved: patch.approved,
+    flag: patch.flag,
+  });
+}
+
 const sameLines = (a: DraftLine[] | null, b: DraftLine[] | null) =>
   a === b ||
   (a !== null &&
@@ -287,6 +314,10 @@ export async function updateTransaction(
     await updateLineCounterpart(rec, { ...agg, owner: agg.owner }, patch);
     return { payeeName: await payeeNameOf(rec, agg.main.payeeId) };
   }
+  if (agg.main.payeeId !== null && agg.main.payeeId === (await systemPayeeId(rec.tx, 'fx_revaluation'))) {
+    await updateRevaluation(rec, agg, patch);
+    return { payeeName: await payeeNameOf(rec, agg.main.payeeId) };
+  }
   const prepared = await editDraft(rec.tx, agg, patch, (name) => findOrCreatePayee(rec, name));
   const draft = prepared.draft;
   if (patch.date !== undefined && patch.date > context.today) {
PATCH
```

- [ ] **Step 6: Run the tests and the final checks**

Run: `npx vitest run --project server src/server/accounts/revalue.test.ts src/server/accounts/account-routes.test.ts src/server/http/app.test.ts`
Expected: `Tests  33 passed (33)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  56 passed (56)`, `Tests  492 passed (492)`; both checks exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/server/fx src/server/accounts src/server/transactions src/server/http/app.test.ts src/shared/api/accounts.ts
git commit -m "feat(server): balances at the latest NBP rate and FX revaluation" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Reconcile flow

Spec §10 "Reconcile flow" (native amounts), §9 "Reconciliation uses native amounts", §13.
- `GET /api/accounts/:id/reconcile` → `{ accountId, currency, clearedBalance, lastReconciledAt, lastReconciledBalance }`; `clearedBalance` is `balance.cleared` (cleared + reconciled, native).
- `POST /api/accounts/:id/reconcile { statementBalance, createAdjustment? = false, fxRate? }`, one undoable command (`Reconcile "<name>"`):
  - closed accounts: 422 `account_closed`;
  - statement = cleared balance: every live `cleared` transaction of the account becomes `reconciled`, and `last_reconciled_at` (now) and `last_reconciled_balance` (the statement) are set;
  - different, without `createAdjustment`: 422 `reconcile_mismatch` with `difference` = statement − cleared (a new optional field of `ApiErrorBody`), nothing written;
  - different, with `createAdjustment`: a planned draft dated today, payee Reconciliation Balance Adjustment (`PlanContext.systemPayee` lets the planner take the system payee), cleared, Ready to Assign on budget accounts and no category on tracking ones, amount = the difference. A foreign amount is booked at the sent `fxRate` (manual) or today's NBP rate, quoted by the route before the command and only when an adjustment will be needed (422 `fx_rate_required` without either). Then everything cleared, the adjustment included, is reconciled.
  - `fxRate` without `createAdjustment` is a 400.
- The response is the new status plus `{ adjustment: TransactionDto | null, reconciledCount }`.
- P2c's `confirm_reconciled` rules keep guarding the reconciled rows afterwards (tested).

**Files:**
- Create: `src/server/accounts/reconcile.ts`
- Modify: `src/shared/api/accounts.ts`, `src/shared/http.ts`, `src/server/transactions/plan.ts`, `src/server/accounts/account-routes.ts`
- Test: `src/server/accounts/reconcile.test.ts` (new), `src/server/http/app.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4; `planTransaction`, `insertPlan`; `getAccount`, `getTransaction`.
- Produces:
  - `reconcileRequestSchema` / `ReconcileRequest`, `ReconcileStatusDto`, `ReconcileResponse`; `ApiErrorBody.difference?`.
  - `PlanContext.systemPayee?: boolean`.
  - `reconcileStatus(db, id)`, `reconcileAccount(rec, id, input, { today, now, defaults }) → { name, adjustmentId, reconciledCount }`.
  - Routes `GET /:id/reconcile`, `POST /:id/reconcile`.

- [ ] **Step 1: Write the failing tests**

Create `src/server/accounts/reconcile.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDto, ReconcileResponse, ReconcileStatusDto } from '../../shared/api/accounts';
import type { BudgetMonthDto } from '../../shared/api/budget';
import { systemCategoryId } from '../db/lookups';
import { transaction } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createTransaction } from '../test/fixtures';
import { stubFx } from '../test/fx';
import { snapshot } from '../test/snapshot';

let t: TestDatabase;
let ctx: TestApp;
let checking: AccountDto;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z', fx: stubFx({ EUR: { '2026-11-20': '4.3' } }) });
  await setUpBudget(ctx);
  checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 100_000 });
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

const status = async (id: string) =>
  (await json<ReconcileStatusDto>(await ctx.client.get(`/api/accounts/${id}/reconcile`))).body;
const reconcile = (id: string, body: object) => ctx.client.post(`/api/accounts/${id}/reconcile`, body);
const clearedOf = async (accountId: string) =>
  (await t.db.select().from(transaction).where(eq(transaction.accountId, accountId)))
    .map((r) => [r.amount, r.cleared])
    .sort((a, b) => Number(a[0]) - Number(b[0]));
const readyToAssign = async () =>
  (await json<BudgetMonthDto>(await ctx.client.get('/api/budget/2026-11'))).body.rta.readyToAssign;

describe('reconcile', () => {
  it('shows the cleared balance, and reconciles every cleared transaction when the statement matches', async () => {
    await createTransaction(ctx.client, { accountId: checking.id, amount: -5_000, cleared: 'cleared' });
    const open = await createTransaction(ctx.client, { accountId: checking.id, amount: -20_000 });
    expect(await status(checking.id)).toEqual({
      accountId: checking.id,
      currency: 'PLN',
      clearedBalance: 95_000,
      lastReconciledAt: null,
      lastReconciledBalance: null,
    });
    const before = await snapshot(t.db);

    const res = await json<ReconcileResponse>(await reconcile(checking.id, { statementBalance: 95_000 }));
    expect(res).toEqual({
      status: 200,
      body: {
        accountId: checking.id,
        currency: 'PLN',
        clearedBalance: 95_000,
        lastReconciledAt: '2026-11-20T10:00:00.000Z',
        lastReconciledBalance: 95_000,
        adjustment: null,
        reconciledCount: 2,
      },
    });
    expect(await clearedOf(checking.id)).toEqual([
      [-20_000, 'uncleared'],
      [-5_000, 'reconciled'],
      [100_000, 'reconciled'],
    ]);
    const after = await snapshot(t.db);
    expect((await json(await ctx.client.post('/api/undo'))).body).toMatchObject({
      undone: { label: 'Reconcile "mBank"' },
    });
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);

    // P2c's rules still guard reconciled rows; the uncleared one is free.
    const [opening] = await t.db.select().from(transaction).where(eq(transaction.isStartingBalance, true));
    const path = `/api/transactions/${opening!.id}`;
    expect((await json(await ctx.client.send('PATCH', path, { amount: 1 }))).body).toMatchObject({
      code: 'confirm_reconciled',
    });
    expect((await ctx.client.send('PATCH', path, { amount: 1, confirmReconciled: true })).status).toBe(200);
    expect((await ctx.client.send('PATCH', `/api/transactions/${open.id}`, { amount: -1 })).status).toBe(200);
  });

  it('refuses a different statement balance unless asked to create an adjustment', async () => {
    const before = await snapshot(t.db);
    expect(await json(await reconcile(checking.id, { statementBalance: 99_000 }))).toEqual({
      status: 422,
      body: {
        code: 'reconcile_mismatch',
        message: "The cleared balance doesn't match the statement. Review the transactions, or create an adjustment.",
        difference: -1_000,
      },
    });
    expect(await snapshot(t.db)).toEqual(before);

    const res = await json<ReconcileResponse>(
      await reconcile(checking.id, { statementBalance: 99_000, createAdjustment: true }),
    );
    expect(res.body).toMatchObject({ clearedBalance: 99_000, lastReconciledBalance: 99_000, reconciledCount: 2 });
    expect(res.body.adjustment).toMatchObject({
      date: '2026-11-20',
      payeeName: 'Reconciliation Balance Adjustment',
      categoryId: await systemCategoryId(t.db, 'rta'),
      amount: -1_000,
      amountBase: -1_000,
      cleared: 'reconciled',
    });
    expect(await readyToAssign()).toBe(99_000);
    // One command: a single undo removes the adjustment and the reconciliation.
    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
  });

  it('books a foreign adjustment at today’s NBP rate or the one sent; tracking accounts take no category', async () => {
    const euro = await createAccount(ctx.client, {
      name: 'Revolut',
      type: 'savings',
      currency: 'EUR',
      startingBalance: 1_000,
      fxRate: '4.25',
    });
    const nbp = await json<ReconcileResponse>(
      await reconcile(euro.id, { statementBalance: 1_100, createAdjustment: true }),
    );
    expect(nbp.body.adjustment).toMatchObject({ amount: 100, amountBase: 430, fxRateManual: false });

    const loan = await createAccount(ctx.client, {
      name: 'Car loan',
      type: 'auto_loan',
      currency: 'USD',
      startingBalance: -5_000,
      fxRate: '3.9',
    });
    const statement = { statementBalance: -5_200, createAdjustment: true };
    expect((await json(await reconcile(loan.id, statement))).body).toMatchObject({ code: 'fx_rate_required' });
    const manual = await json<ReconcileResponse>(await reconcile(loan.id, { ...statement, fxRate: '4' }));
    expect(manual.body.adjustment).toMatchObject({
      categoryId: null,
      amount: -200,
      amountBase: -800,
      fxRate: '4.000000',
      fxRateManual: true,
    });
  });

  it('refuses closed and unknown accounts, and a rate without an adjustment', async () => {
    const old = await createAccount(ctx.client, { name: 'Old', type: 'savings' });
    await ctx.client.post(`/api/accounts/${old.id}/close`);
    expect((await json(await reconcile(old.id, { statementBalance: 0 }))).body).toMatchObject({
      code: 'account_closed',
    });
    expect((await reconcile(crypto.randomUUID(), { statementBalance: 0 })).status).toBe(404);
    expect((await ctx.client.get(`/api/accounts/${crypto.randomUUID()}/reconcile`)).status).toBe(404);
    expect((await json(await reconcile(checking.id, { statementBalance: 1, fxRate: '4' }))).body).toMatchObject({
      code: 'validation',
      fieldErrors: { fxRate: ['Only an adjustment takes an exchange rate.'] },
    });
  });
});
```

```bash
git apply <<'PATCH'
diff --git a/src/server/http/app.test.ts b/src/server/http/app.test.ts
index 04eb67b..f3e9dca 100644
--- a/src/server/http/app.test.ts
+++ b/src/server/http/app.test.ts
@@ -90,6 +90,8 @@ describe('route guard', () => {
         'DELETE /api/categories/:id/target/snooze',
         'GET /api/fx/rates/:currency/:date',
         'POST /api/accounts/:id/revalue',
+        'GET /api/accounts/:id/reconcile',
+        'POST /api/accounts/:id/reconcile',
       ]),
     );
 
PATCH
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project server src/server/accounts/reconcile.test.ts src/server/http/app.test.ts`
Expected: FAIL, `Tests  5 failed | 7 passed (12)`: the reconcile routes answer 404.

- [ ] **Step 3: Add the request, the status and the mismatch body**

```bash
git apply <<'PATCH'
diff --git a/src/server/transactions/plan.ts b/src/server/transactions/plan.ts
index b6085c0..f5b9ac5 100644
--- a/src/server/transactions/plan.ts
+++ b/src/server/transactions/plan.ts
@@ -107,6 +107,8 @@ export interface PlanContext {
   defaults?: Map<string, string>;
   /** Collects currencies that have no rate instead of refusing them (see `Rates.unknown`). */
   unknownRates?: Set<string>;
+  /** Rows the app books (reconciliation adjustments) may use a system payee; users can't choose one. */
+  systemPayee?: boolean;
 }
 
 /** PLN rows, rows whose base comes from the other side of a transfer, and rates nobody has yet store none. */
@@ -244,7 +246,7 @@ export async function planTransaction(db: Executor, draft: Draft, context: PlanC
   const main = await requireAccount(db, draft.accountId, 'accountId');
   open(main, 'accountId');
   const payee = draft.payeeId === null ? null : await requirePayee(db, draft.payeeId, 'payeeId');
-  if (payee && draft.payeeId !== existing?.payeeId) assertNotSystemPayee(payee, 'payeeId');
+  if (payee && !context.systemPayee && draft.payeeId !== existing?.payeeId) assertNotSystemPayee(payee, 'payeeId');
   const rates: Rates = {
     input: draft.fxRate,
     stored: existing?.rates ?? new Map(),
diff --git a/src/shared/api/accounts.ts b/src/shared/api/accounts.ts
index 712b83d..d66f64e 100644
--- a/src/shared/api/accounts.ts
+++ b/src/shared/api/accounts.ts
@@ -147,3 +147,37 @@ export interface RevalueResponse {
   /** The FX revaluation transaction: amount 0, `amountBase` = the difference. */
   transaction: TransactionDto;
 }
+
+/** POST /api/accounts/:id/reconcile (spec §10 "Reconcile flow"). Amounts are in the account's currency. */
+export const reconcileRequestSchema = z
+  .object({
+    /** The bank statement's balance. */
+    statementBalance: moneySchema,
+    /** When the statement differs: book the difference as a cleared adjustment, then reconcile. */
+    createAdjustment: z.boolean().default(false),
+    /** Foreign accounts: the adjustment's rate to PLN; without it, today's NBP rate. */
+    fxRate: fxRateSchema.optional(),
+  })
+  .refine((body) => body.fxRate === undefined || body.createAdjustment, {
+    path: ['fxRate'],
+    message: 'Only an adjustment takes an exchange rate.',
+  });
+
+export type ReconcileRequest = z.infer<typeof reconcileRequestSchema>;
+
+/** GET /api/accounts/:id/reconcile: "Is your cleared balance X?" */
+export interface ReconcileStatusDto {
+  accountId: string;
+  currency: string;
+  /** Cleared and reconciled transactions (for loans with their interest and escrow), in the account's currency. */
+  clearedBalance: number;
+  lastReconciledAt: string | null;
+  lastReconciledBalance: number | null;
+}
+
+export interface ReconcileResponse extends ReconcileStatusDto {
+  /** The "Reconciliation Balance Adjustment" booked for the difference, if there was one. */
+  adjustment: TransactionDto | null;
+  /** How many cleared transactions became reconciled (the adjustment included). */
+  reconciledCount: number;
+}
diff --git a/src/shared/http.ts b/src/shared/http.ts
index be411bb..3c48686 100644
--- a/src/shared/http.ts
+++ b/src/shared/http.ts
@@ -12,4 +12,6 @@ export interface ApiErrorBody {
   formErrors?: string[];
   /** Present for code "internal": quote it when reporting a bug. */
   requestId?: string;
+  /** Present for code "reconcile_mismatch": statement balance − cleared balance, in the account's minor units. */
+  difference?: number;
 }
PATCH
```

- [ ] **Step 4: Add the command and the routes**

Create `src/server/accounts/reconcile.ts`:

```ts
import { and, eq, isNull } from 'drizzle-orm';
import type { ReconcileRequest, ReconcileStatusDto } from '../../shared/api/accounts';
import type { IsoDate } from '../../engine';
import type { ChangeRecorder } from '../commands/recorder';
import type { Executor } from '../db/client';
import { systemCategoryId, systemPayeeId } from '../db/lookups';
import { account, transaction } from '../db/schema';
import { AppError, DomainError } from '../http/errors';
import { planTransaction } from '../transactions/plan';
import { insertPlan } from '../transactions/write';
import { getAccount } from './account-queries';

/** Spec §10 "Reconcile flow": the account's cleared balance in its own currency, and its last reconciliation. */
export async function reconcileStatus(db: Executor, id: string): Promise<ReconcileStatusDto> {
  const current = await getAccount(db, id);
  return {
    accountId: current.id,
    currency: current.currency,
    clearedBalance: current.balance.cleared,
    lastReconciledAt: current.lastReconciledAt,
    lastReconciledBalance: current.lastReconciledBalance,
  };
}

export interface ReconcileContext {
  today: IsoDate;
  now: Date;
  /** Spec §9: today's NBP rate for a foreign adjustment, quoted before the command. */
  defaults: Map<string, string>;
}

/**
 * Spec §10 "Reconcile flow", in the account's currency: when the statement matches the cleared balance, every cleared
 * transaction becomes reconciled and the account remembers when and at what balance. A difference is refused
 * (`reconcile_mismatch`, with the difference) unless `createAdjustment` is set: then a cleared "Reconciliation Balance
 * Adjustment" dated today books it first (Ready to Assign on budget accounts, no category on tracking ones; a
 * foreign amount at the rate sent or today's NBP rate). Later edits of reconciled rows need confirmation (P2c).
 */
export async function reconcileAccount(
  rec: ChangeRecorder,
  id: string,
  input: ReconcileRequest,
  context: ReconcileContext,
): Promise<{ name: string; adjustmentId: string | null; reconciledCount: number }> {
  const current = await getAccount(rec.tx, id);
  if (current.closed) {
    throw new DomainError('account_closed', `"${current.name}" is closed. Reopen it to reconcile it.`);
  }
  const difference = input.statementBalance - current.balance.cleared;
  let adjustmentId: string | null = null;
  if (difference !== 0) {
    if (!input.createAdjustment) {
      throw new AppError(
        422,
        'reconcile_mismatch',
        "The cleared balance doesn't match the statement. Review the transactions, or create an adjustment.",
        { difference },
      );
    }
    const draft = {
      accountId: id,
      date: context.today,
      payeeId: await systemPayeeId(rec.tx, 'reconciliation_adjustment'),
      categoryId: current.accountClass === 'tracking' ? null : await systemCategoryId(rec.tx, 'rta'),
      memo: null,
      amount: difference,
      transferAmount: null,
      fxRate: input.fxRate ?? null,
      cleared: 'cleared' as const,
      approved: true,
      flag: null,
      lines: null,
    };
    const plan = await planTransaction(rec.tx, draft, { defaults: context.defaults, systemPayee: true });
    adjustmentId = await insertPlan(rec, plan);
  }
  const reconciled = await rec.update(
    transaction,
    and(eq(transaction.accountId, id), eq(transaction.cleared, 'cleared'), isNull(transaction.deletedAt)),
    { cleared: 'reconciled' },
  );
  await rec.update(account, eq(account.id, id), {
    lastReconciledAt: context.now,
    lastReconciledBalance: input.statementBalance,
  });
  return { name: current.name, adjustmentId, reconciledCount: reconciled.length };
}
```

```bash
git apply <<'PATCH'
diff --git a/src/server/accounts/account-routes.ts b/src/server/accounts/account-routes.ts
index 43a5948..3c5f2fc 100644
--- a/src/server/accounts/account-routes.ts
+++ b/src/server/accounts/account-routes.ts
@@ -4,6 +4,9 @@ import {
   type AccountListResponse,
   BASE_CURRENCY,
   createAccountRequestSchema,
+  type ReconcileResponse,
+  type ReconcileStatusDto,
+  reconcileRequestSchema,
   revalueRequestSchema,
   type RevalueResponse,
   updateAccountRequestSchema,
@@ -17,6 +20,7 @@ import { validate } from '../http/validate';
 import { getTransaction } from '../transactions/transaction-queries';
 import { createAccount, deleteAccount, reorderAccounts, setAccountClosed, updateAccount } from './account-commands';
 import { getAccount, readAccount, readAccounts } from './account-queries';
+import { reconcileAccount, reconcileStatus } from './reconcile';
 import { revalueAccount } from './revalue';
 
 /**
@@ -88,6 +92,32 @@ export function accountRoutes(deps: AppDeps) {
         transaction: await getTransaction(deps.db, transactionId),
       });
     })
+    .get('/:id/reconcile', validate('param', idParamSchema), async (c) =>
+      c.json<ReconcileStatusDto>(await reconcileStatus(deps.db, c.req.valid('param').id)),
+    )
+    .post('/:id/reconcile', validate('param', idParamSchema), validate('json', reconcileRequestSchema), async (c) => {
+      const { id } = c.req.valid('param');
+      const body = c.req.valid('json');
+      const now = today();
+      // Spec §9: a foreign adjustment's NBP rate is quoted before the command, and only when one will be needed.
+      const current = await getAccount(deps.db, id);
+      const defaults = new Map<string, string>();
+      const adjusts = body.createAdjustment && current.balance.cleared !== body.statementBalance;
+      if (adjusts && body.fxRate === undefined && current.currency !== BASE_CURRENCY) {
+        const nbp = await deps.fx.quote(current.currency, now);
+        if (nbp) defaults.set(current.currency, nbp.rate);
+      }
+      const result = await runCommand(
+        deps,
+        (r: Named) => `Reconcile "${r.name}"`,
+        (rec) => reconcileAccount(rec, id, body, { today: now, now: deps.clock.now(), defaults }),
+      );
+      return c.json<ReconcileResponse>({
+        ...(await reconcileStatus(deps.db, id)),
+        adjustment: result.adjustmentId === null ? null : await getTransaction(deps.db, result.adjustmentId),
+        reconciledCount: result.reconciledCount,
+      });
+    })
     .delete('/:id', validate('param', idParamSchema), async (c) => {
       const { id } = c.req.valid('param');
       await runCommand(deps, (r: Named) => `Delete account "${r.name}"`, (rec) => deleteAccount(rec, id));
PATCH
```

- [ ] **Step 5: Run the tests and the final checks**

Run: `npx vitest run --project server src/server/accounts/reconcile.test.ts src/server/http/app.test.ts`
Expected: `Tests  12 passed (12)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  57 passed (57)`, `Tests  496 passed (496)`; both checks exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/server/accounts src/server/transactions/plan.ts src/server/http/app.test.ts src/shared
git commit -m "feat(server): reconcile flow with an adjustment" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Loan balances with interest and escrow

Spec §8 "Interest and escrow", §6 debt targets, and the P2b2 carry-over "a loan's `balanceAtMonthStart` … ignores the synthetic interest and escrow rows". One source of truth, `src/server/loans/loan-balances.ts`:
- `loanBalances(db, accountIds)` loads the loan-type accounts among `accountIds` (others are left out). Their live transactions are summed per month: Σ amounts, Σ inflows (the payments), Σ inflow base amounts and the first inflow's date. With the APR (none = 0 %), escrow (none = 0) and `loan_interest_override` rows, `computeLoanMonths` rolls each loan forward in its own currency.
- Each month also carries `chargedOn` (the first payment's date), `interestOverridden`, and the PLN values `interestBase` / `escrowBase`. For PLN loans these are the native amounts; a foreign loan's are converted at the rate its payments that month were booked at (`paymentsBase / payments`), so a payment's PLN value splits exactly like its native one.
- `loanCharges(loan, before?)` sums the interest and escrow of the months before `before` (all months without it) as negative native and PLN amounts.

Users of it:
- `listAccounts` adds a loan's charges to `balance.cleared` and `balanceBase.cleared` (synthetic rows count as cleared). That covers the accounts list, the register header, `GET …/reconcile`, closing (a loan only closes once its interest is paid too) and Revalue.
- `loadLinkedAccounts` (debt targets) adds the charges of the months before `month` to `balanceAtMonthStart` and through `month` to `balanceAtMonthEnd`.

P2b2's `target-model.test.ts` expected the mortgage's November end balance without the charges; it now includes them (the test's 600 zł payment is charged 500 zł interest and 200 zł escrow).

**Files:**
- Create: `src/server/loans/loan-balances.ts`
- Modify: `src/server/accounts/account-queries.ts`, `src/server/targets/target-model.ts`
- Test: `src/server/loans/loan-balances.test.ts` (new), `src/server/targets/target-model.test.ts`

**Interfaces:**
- Consumes: `computeLoanMonths`, `LoanMonth`, `roundDiv`, `monthOf`, `addMonths` (engine); `isLoanType`.
- Produces: `LoanMonthRow extends LoanMonth { chargedOn, interestOverridden, interestBase, escrowBase }`, `LoanBalances { accountId, months }`, `loanBalances(db, accountIds): Promise<Map<string, LoanBalances>>`, `loanCharges(loan | undefined, before?: Month): { amount, amountBase }`.

- [ ] **Step 1: Write the failing tests**

Create `src/server/loans/loan-balances.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDto, AccountListResponse } from '../../shared/api/accounts';
import type { RegisterResponse } from '../../shared/api/transactions';
import { loanInterestOverride } from '../db/schema';
import { loadLinkedAccounts } from '../targets/target-model';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createTransaction } from '../test/fixtures';
import { loanBalances, loanCharges } from './loan-balances';

let t: TestDatabase;
let ctx: TestApp;
let checking: AccountDto;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z' });
  await setUpBudget(ctx);
  checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 1_000_000 });
});
afterEach(async () => {
  await t.drop();
});

async function json<T>(res: Response) {
  return (await res.json()) as T;
}

/** 100 000 zł at 6 % APR from 1 October, with escrow 200 zł; paid 1 000 zł on 5 November. */
async function mortgage(extra: object = {}) {
  const loan = await createAccount(ctx.client, {
    name: 'Mortgage',
    type: 'mortgage',
    startingBalance: -10_000_000,
    startingDate: '2026-10-01',
    interestRate: '6',
    minPayment: 100_000,
    escrowAmount: 20_000,
    createPairedCategory: true,
    ...extra,
  });
  await createTransaction(ctx.client, {
    accountId: checking.id,
    date: '2026-11-05',
    payeeId: loan.transferPayeeId,
    categoryId: loan.pairedCategoryId,
    amount: -100_000,
  });
  return loan;
}

const accountNamed = async (name: string) =>
  (await json<AccountListResponse>(await ctx.client.get('/api/accounts'))).accounts.find((a) => a.name === name)!;

describe('loanBalances', () => {
  it('charges interest and escrow in months with a payment, in the balances and the register header', async () => {
    const loan = await mortgage();
    const { months } = (await loanBalances(t.db, [loan.id, checking.id])).get(loan.id)!;
    expect(months).toEqual([
      {
        month: '2026-10',
        startBalance: 0,
        transactionsTotal: -10_000_000,
        interest: 0,
        escrow: 0,
        endBalance: -10_000_000,
        principalPaid: 0,
        chargedOn: null,
        interestOverridden: false,
        interestBase: 0,
        escrowBase: 0,
      },
      {
        month: '2026-11',
        startBalance: -10_000_000,
        transactionsTotal: 100_000,
        interest: 50_000,
        escrow: 20_000,
        endBalance: -9_970_000,
        principalPaid: 30_000,
        chargedOn: '2026-11-05',
        interestOverridden: false,
        interestBase: 50_000,
        escrowBase: 20_000,
      },
    ]);

    // Interest and escrow count as cleared; the payment itself is still uncleared.
    const balance = { cleared: -10_070_000, uncleared: 100_000, working: -9_970_000 };
    expect(await accountNamed('Mortgage')).toMatchObject({ balance, balanceBase: balance });
    const register = await json<RegisterResponse>(await ctx.client.get(`/api/transactions?accountId=${loan.id}`));
    expect(register.balances).toEqual({ balance, balanceBase: balance });
    // Cash accounts are untouched.
    expect((await accountNamed('mBank')).balance.working).toBe(900_000);
  });

  it('feeds debt targets the balance with its charges', async () => {
    const loan = await mortgage();
    const linked = async (month: string) =>
      (await loadLinkedAccounts(t.db, month, '2026-11-20')).get(loan.pairedCategoryId!)!;
    expect(await linked('2026-11')).toMatchObject({
      balanceAtMonthEnd: -9_970_000,
      debt: { balanceAtMonthStart: -10_000_000 },
    });
    expect((await linked('2026-12')).debt.balanceAtMonthStart).toBe(-9_970_000);
  });

  it('uses an interest override for its month, and no interest without an APR', async () => {
    const loan = await mortgage({ interestRate: undefined, escrowAmount: undefined });
    expect((await loanBalances(t.db, [loan.id])).get(loan.id)!.months[1]).toMatchObject({ interest: 0, escrow: 0 });

    await t.db.insert(loanInterestOverride).values({ accountId: loan.id, month: '2026-11-01', amount: 40_000 });
    const loans = await loanBalances(t.db, [loan.id]);
    expect(loans.get(loan.id)!.months[1]).toMatchObject({
      interest: 40_000,
      interestOverridden: true,
      principalPaid: 60_000,
      endBalance: -9_940_000,
    });
    expect(loanCharges(loans.get(loan.id))).toEqual({ amount: -40_000, amountBase: -40_000 });
    expect(loanCharges(loans.get(loan.id), '2026-11')).toEqual({ amount: 0, amountBase: 0 });
  });

  it("books a foreign loan's charges in PLN at the rate of the month's payments", async () => {
    const loan = await createAccount(ctx.client, {
      name: 'Franc mortgage',
      type: 'mortgage',
      currency: 'CHF',
      startingBalance: -1_000_000,
      startingDate: '2026-10-01',
      fxRate: '4',
      interestRate: '12',
      minPayment: 100_000,
      createPairedCategory: true,
    });
    await createTransaction(ctx.client, {
      accountId: checking.id,
      date: '2026-11-05',
      payeeId: loan.transferPayeeId,
      categoryId: loan.pairedCategoryId,
      amount: -430_000,
      transferAmount: 100_000,
    });
    // Interest: 1 % of 10 000 CHF = 100 CHF, booked at the payment's 4.30.
    expect(await accountNamed('Franc mortgage')).toMatchObject({
      balance: { working: -910_000 },
      balanceBase: { working: -4_000_000 + 430_000 - 43_000 },
    });
  });

  it('keeps a loan open until its interest is paid too', async () => {
    const loan = await createAccount(ctx.client, {
      name: 'Car loan',
      type: 'auto_loan',
      startingBalance: -100_000,
      startingDate: '2026-10-01',
      interestRate: '12',
      minPayment: 100_000,
      createPairedCategory: true,
    });
    await createTransaction(ctx.client, {
      accountId: checking.id,
      date: '2026-11-05',
      payeeId: loan.transferPayeeId,
      categoryId: loan.pairedCategoryId,
      amount: -100_000,
    });
    expect(await json(await ctx.client.post(`/api/accounts/${loan.id}/close`))).toMatchObject({
      code: 'account_balance_not_zero',
    });
    expect((await accountNamed('Car loan')).balance.working).toBe(-1_000);
  });
});
```

```bash
git apply <<'PATCH'
diff --git a/src/server/targets/target-model.test.ts b/src/server/targets/target-model.test.ts
index edcb5f2..fcc373a 100644
--- a/src/server/targets/target-model.test.ts
+++ b/src/server/targets/target-model.test.ts
@@ -113,7 +113,8 @@ describe('loadLinkedAccounts', () => {
           mortgage.pairedCategoryId!,
           {
             accountId: mortgage.id,
-            balanceAtMonthEnd: -9_940_000,
+            // The November payment is charged interest (6 % / 12 of 100 000 zł = 500 zł) and escrow (200 zł).
+            balanceAtMonthEnd: -10_010_000,
             debt: { minPayment: 60_000, apr: '6.0000', balanceAtMonthStart: -10_000_000, escrow: 20_000 },
             missing: { minPayment: false, interestRate: false },
           },
PATCH
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project server src/server/loans src/server/targets/target-model.test.ts`
Expected: FAIL, `Test Files  2 failed (2)`, `Tests  1 failed | 3 passed (4)`: `loan-balances.test.ts` can't load (`Cannot find module './loan-balances'`), and the mortgage's end balance lacks its charges.

- [ ] **Step 3: Add the loan ledger**

Create `src/server/loans/loan-balances.ts`:

```ts
import { and, asc, inArray, isNull, sql } from 'drizzle-orm';
import { isLoanType } from '../../shared/accounts';
import {
  computeLoanMonths,
  type IsoDate,
  type LoanMonth,
  type Money,
  type Month,
  monthOf,
  roundDiv,
} from '../../engine';
import type { Executor } from '../db/client';
import { account, loanInterestOverride, transaction } from '../db/schema';

/** One month of a loan (spec §8): the engine's roll-forward, in the loan's currency, plus what the server knows. */
export interface LoanMonthRow extends LoanMonth {
  /** The day of the month's first payment, when interest and escrow are charged; null in a month without one. */
  chargedOn: IsoDate | null;
  /** The interest is a `loan_interest_override`, not APR / 12 of the start balance. */
  interestOverridden: boolean;
  /** PLN values at the rate the month's payments were booked at (the native amounts for PLN loans). */
  interestBase: Money;
  escrowBase: Money;
}

export interface LoanBalances {
  accountId: string;
  /** Months with transactions, in order; interest and escrow are charged only in months with a payment. */
  months: LoanMonthRow[];
}

/**
 * Spec §8: each loan account's months rolled forward by `computeLoanMonths` from its live transactions (per month:
 * Σ amounts and Σ inflows), its APR (none = 0 %), escrow and interest overrides. This is the one place that turns
 * loans into synthetic interest and escrow: account balances, the register header, debt targets and the loan panel
 * all take them from here. Accounts that aren't loans are left out.
 */
export async function loanBalances(db: Executor, accountIds: string[]): Promise<Map<string, LoanBalances>> {
  if (accountIds.length === 0) return new Map();
  const loans = (await db.select().from(account).where(inArray(account.id, accountIds))).filter((a) =>
    isLoanType(a.type),
  );
  if (loans.length === 0) return new Map();
  const ids = loans.map((loan) => loan.id);
  const month = sql<Month>`to_char(${transaction.date}, 'YYYY-MM')`;
  const inflow = sql`${transaction.amount} > 0`;
  const rows = await db
    .select({
      accountId: transaction.accountId,
      month,
      total: sql<number>`sum(${transaction.amount})::bigint`,
      payments: sql<number>`coalesce(sum(${transaction.amount}) filter (where ${inflow}), 0)::bigint`,
      paymentsBase: sql<number>`coalesce(sum(${transaction.amountBase}) filter (where ${inflow}), 0)::bigint`,
      firstPayment: sql<IsoDate | null>`to_char(min(${transaction.date}) filter (where ${inflow}), 'YYYY-MM-DD')`,
    })
    .from(transaction)
    .where(and(inArray(transaction.accountId, ids), isNull(transaction.deletedAt)))
    .groupBy(transaction.accountId, month)
    .orderBy(asc(month));
  const overrides = await db.select().from(loanInterestOverride).where(inArray(loanInterestOverride.accountId, ids));

  const result = new Map<string, LoanBalances>();
  for (const loan of loans) {
    const own = rows.filter((r) => r.accountId === loan.id);
    const interestOverrides = Object.fromEntries(
      overrides.filter((o) => o.accountId === loan.id).map((o) => [monthOf(o.month), o.amount]),
    );
    const months = computeLoanMonths(
      { apr: loan.interestRate ?? '0', escrow: loan.escrowAmount ?? 0, interestOverrides },
      own.map((r) => ({ month: r.month, transactionsTotal: r.total, paymentsTotal: r.payments })),
    );
    result.set(loan.id, {
      accountId: loan.id,
      months: months.map((m, i) => {
        const { payments, paymentsBase, firstPayment } = own[i]!;
        // Charged with the payments, so in PLN at their rate: paymentsBase / payments.
        const toBase = (native: Money) =>
          payments === 0 ? 0 : Number(roundDiv(BigInt(native) * BigInt(paymentsBase), BigInt(payments)));
        return {
          ...m,
          chargedOn: firstPayment,
          interestOverridden: m.month in interestOverrides,
          interestBase: toBase(m.interest),
          escrowBase: toBase(m.escrow),
        };
      }),
    });
  }
  return result;
}

/**
 * The interest and escrow a loan was charged in months before `before` (every month when omitted), as the negative
 * native and PLN amounts they add to its balance. Zero for accounts that aren't loans.
 */
export function loanCharges(loan: LoanBalances | undefined, before?: Month): { amount: Money; amountBase: Money } {
  let amount = 0;
  let amountBase = 0;
  for (const m of loan?.months ?? []) {
    if (before !== undefined && m.month >= before) break;
    amount -= m.interest + m.escrow;
    amountBase -= m.interestBase + m.escrowBase;
  }
  return { amount, amountBase };
}
```

- [ ] **Step 4: Add the charges to account balances and debt targets**

```bash
git apply <<'PATCH'
diff --git a/src/server/accounts/account-queries.ts b/src/server/accounts/account-queries.ts
index bbeac61..5a4f247 100644
--- a/src/server/accounts/account-queries.ts
+++ b/src/server/accounts/account-queries.ts
@@ -5,6 +5,7 @@ import type { Db, Executor } from '../db/client';
 import { account, category, payee, transaction } from '../db/schema';
 import { type FxQuote, type FxRates, latestRates } from '../fx/fx-rates';
 import { AppError } from '../http/errors';
+import { loanBalances, loanCharges } from '../loans/loan-balances';
 
 interface Sums {
   cleared: number;
@@ -47,8 +48,9 @@ function atRate(working: number, quote: FxQuote | null): number | null {
 }
 
 /**
- * Accounts in display order (spec §11 Accounts), with their balances. `rates` holds the latest NBP rate by currency
- * for "≈ X zł" (see `readAccounts`); without one, a foreign account's `latestRate` is null.
+ * Accounts in display order (spec §11 Accounts), with their balances; a loan's include the interest and escrow it was
+ * charged (spec §8), as cleared amounts. `rates` holds the latest NBP rate by currency for "≈ X zł" (see
+ * `readAccounts`); without one, a foreign account's `latestRate` is null.
  */
 export async function listAccounts(
   db: Executor,
@@ -62,9 +64,17 @@ export async function listAccounts(
     .leftJoin(category, and(eq(category.linkedAccountId, account.id), isNull(category.deletedAt)))
     .where(where)
     .orderBy(asc(account.sortOrder), asc(account.createdAt), asc(account.id));
-  const sums = await sumsByAccount(db, rows.map((r) => r.account.id));
+  const ids = rows.map((r) => r.account.id);
+  const sums = await sumsByAccount(db, ids);
+  const loans = await loanBalances(db, ids);
   return rows.map(({ account: a, transferPayeeId, linkedCategoryId }) => {
-    const s = sums.get(a.id) ?? ZERO;
+    const booked = sums.get(a.id) ?? ZERO;
+    const charges = loanCharges(loans.get(a.id));
+    const s = {
+      ...booked,
+      cleared: booked.cleared + charges.amount,
+      clearedBase: booked.clearedBase + charges.amountBase,
+    };
     const latestRate = a.currency === BASE_CURRENCY ? null : (rates.get(a.currency) ?? null);
     return {
       id: a.id,
diff --git a/src/server/targets/target-model.ts b/src/server/targets/target-model.ts
index 78da5de..7da80a8 100644
--- a/src/server/targets/target-model.ts
+++ b/src/server/targets/target-model.ts
@@ -1,5 +1,6 @@
 import { and, eq, isNull, lte, sql } from 'drizzle-orm';
 import {
+  addMonths,
   type BudgetResult,
   dateInMonth,
   evaluateTarget,
@@ -14,6 +15,7 @@ import type { TargetDto, TargetEvaluationDto } from '../../shared/api/targets';
 import { monthStart } from '../budget/assignments';
 import type { Executor } from '../db/client';
 import { account, category, type target, transaction } from '../db/schema';
+import { loanBalances, loanCharges } from '../loans/loan-balances';
 
 export type TargetRow = typeof target.$inferSelect;
 export type DebtContext = NonNullable<TargetContext['debt']>;
@@ -70,7 +72,8 @@ export interface LinkedAccount {
 
 /**
  * The linked account of every live credit card payment and paired loan category, keyed by category id. Balances are
- * PLN base sums of the account's live transactions dated `today` or earlier (a split parent carries its lines' sum).
+ * PLN base sums of the account's live transactions dated `today` or earlier (a split parent carries its lines' sum);
+ * a loan's also include the interest and escrow charged in the months before (start) or through (end) `month`.
  */
 export async function loadLinkedAccounts(
   db: Executor,
@@ -99,16 +102,17 @@ export async function loadLinkedAccounts(
     )
     .where(isNull(category.deletedAt))
     .groupBy(category.id, account.id);
+  const loans = await loanBalances(db, rows.map((row) => row.accountId));
   return new Map(
     rows.map((row) => [
       row.categoryId,
       {
         accountId: row.accountId,
-        balanceAtMonthEnd: row.throughMonth,
+        balanceAtMonthEnd: row.throughMonth + loanCharges(loans.get(row.accountId), addMonths(month, 1)).amountBase,
         debt: {
           minPayment: row.minPayment ?? 0,
           apr: row.interestRate ?? '0',
-          balanceAtMonthStart: row.beforeMonth,
+          balanceAtMonthStart: row.beforeMonth + loanCharges(loans.get(row.accountId), month).amountBase,
           // Spec §6: escrow is added for loans only.
           escrow: row.accountClass === 'tracking' ? (row.escrowAmount ?? 0) : 0,
         },
PATCH
```

- [ ] **Step 5: Run the tests and the final checks**

Run: `npx vitest run --project server src/server/loans src/server/targets/target-model.test.ts`
Expected: `Tests  9 passed (9)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  58 passed (58)`, `Tests  501 passed (501)`; both checks exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/server/loans src/server/accounts/account-queries.ts src/server/targets
git commit -m "feat(server): loan balances with interest and escrow" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: Loan schedule and interest overrides (golden scenario 9)

Spec §8 "The register shows synthetic read-only 'Interest charge' / 'Escrow' rows per month. Editing the interest row writes a `loan_interest_override`", §14 golden scenario 9.

**Synthetic register rows.** The register (P2c's `GET /api/transactions`, cursor-paged over transactions) stays as it is. A loan's schedule is a separate read, `GET /api/accounts/:id/loan` → `LoanDto { accountId, currency, interestRate, minPayment, escrowAmount, months }`. Its `months` are `loanBalances`' rows, and each month's `chargedOn` is the date the UI shows its "Interest charge" and "Escrow" rows on, interleaved with that day's transactions. A loan has a few hundred months at most, so one response holds them all, and the transaction paging stays correct because it never sees the synthetic rows. Non-loans are 422 `not_a_loan`.

**Interest overrides.** `PUT /api/accounts/:id/interest-overrides/:month { amount }` sets the month's interest (loan currency, 0 … 10^13) and `DELETE` removes it (404 when there is none). Both are undoable (`Set the interest of "<name>" for YYYY-MM`, `Reset the interest of "<name>" for YYYY-MM`), refuse non-loans (422 `not_a_loan`), and answer the new `LoanDto`. The month must be within the loan's range: from the month of its first live transaction to the current month (422 `month_out_of_range`, `fieldErrors.month`). An override applies when the month has a payment; later months' interest follows the new balance.

Golden scenario 9 through the API: 100 000 zł at 6 % APR paid 1 000 zł → interest 500 zł, principal 500 zł; with escrow 200 zł → principal 300 zł, and the loan's balance shows 99 700 zł owed.

**Files:**
- Create: `src/shared/api/loans.ts`, `src/server/loans/loan-commands.ts`
- Modify: `src/server/accounts/account-routes.ts`
- Test: `src/server/loans/loan-routes.test.ts` (new), `src/server/http/app.test.ts`

**Interfaces:**
- Consumes: Task 6; `monthStart`; `runCommand`, `Named`.
- Produces: `loanMonthParamSchema`, `interestOverrideRequestSchema`, `LoanMonthDto`, `LoanDto`; `getLoan(db, id)`, `setInterestOverride(rec, id, month, amount, today)`, `deleteInterestOverride(rec, id, month)`; routes `GET /:id/loan`, `PUT` and `DELETE /:id/interest-overrides/:month`.

- [ ] **Step 1: Write the failing tests**

Create `src/server/loans/loan-routes.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDto, AccountListResponse } from '../../shared/api/accounts';
import type { LoanDto } from '../../shared/api/loans';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createTransaction } from '../test/fixtures';
import { snapshot } from '../test/snapshot';

let t: TestDatabase;
let ctx: TestApp;
let checking: AccountDto;
let loan: AccountDto;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z' });
  await setUpBudget(ctx);
  checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 2_000_000 });
  // 100 000 zł at 6 % APR, paid 1 000 zł a month.
  loan = await createAccount(ctx.client, {
    name: 'Mortgage',
    type: 'mortgage',
    startingBalance: -10_000_000,
    startingDate: '2026-10-01',
    interestRate: '6',
    minPayment: 100_000,
    createPairedCategory: true,
  });
  await createTransaction(ctx.client, {
    accountId: checking.id,
    date: '2026-11-05',
    payeeId: loan.transferPayeeId,
    categoryId: loan.pairedCategoryId,
    amount: -100_000,
  });
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

const schedule = async (id = loan.id) => json<LoanDto>(await ctx.client.get(`/api/accounts/${id}/loan`));
const november = async () => (await schedule()).body.months.find((m) => m.month === '2026-11')!;
const override = (month: string, body: object, id = loan.id) =>
  ctx.client.send('PUT', `/api/accounts/${id}/interest-overrides/${month}`, body);
const reset = (month: string) => ctx.client.send('DELETE', `/api/accounts/${loan.id}/interest-overrides/${month}`);

describe('GET /api/accounts/:id/loan', () => {
  it('splits a payment into interest, escrow and principal (golden scenario 9)', async () => {
    expect(await schedule()).toEqual({
      status: 200,
      body: {
        accountId: loan.id,
        currency: 'PLN',
        interestRate: '6.0000',
        minPayment: 100_000,
        escrowAmount: null,
        months: [
          expect.objectContaining({ month: '2026-10', interest: 0, chargedOn: null, endBalance: -10_000_000 }),
          {
            month: '2026-11',
            startBalance: -10_000_000,
            transactionsTotal: 100_000,
            interest: 50_000,
            interestBase: 50_000,
            interestOverridden: false,
            escrow: 0,
            escrowBase: 0,
            endBalance: -9_950_000,
            principalPaid: 50_000,
            chargedOn: '2026-11-05',
          },
        ],
      },
    });

    // With escrow 200 zł, the same payment pays 300 zł of principal.
    await ctx.client.send('PATCH', `/api/accounts/${loan.id}`, { escrowAmount: 20_000 });
    expect(await november()).toMatchObject({ interest: 50_000, escrow: 20_000, principalPaid: 30_000 });
    const { accounts } = (await json<AccountListResponse>(await ctx.client.get('/api/accounts'))).body;
    expect(accounts.find((a) => a.id === loan.id)!.balance.working).toBe(-9_970_000);
  });

  it('is for loans only', async () => {
    expect(await schedule(checking.id)).toEqual({
      status: 422,
      body: { code: 'not_a_loan', message: 'Only loans have interest and escrow.' },
    });
    expect((await schedule(crypto.randomUUID())).status).toBe(404);
  });
});

describe('interest overrides', () => {
  it("replaces a month's computed interest until it is reset; each change is undoable", async () => {
    const before = await snapshot(t.db);
    const res = await json<LoanDto>(await override('2026-11', { amount: 40_000 }));
    expect(res.status).toBe(200);
    expect(res.body.months[1]).toMatchObject({ interest: 40_000, interestOverridden: true, principalPaid: 60_000 });
    const after = await snapshot(t.db);
    expect((await json(await ctx.client.post('/api/undo'))).body).toMatchObject({
      undone: { label: 'Set the interest of "Mortgage" for 2026-11' },
    });
    expect(await snapshot(t.db)).toEqual(before);
    await ctx.client.post('/api/redo');
    expect(await snapshot(t.db)).toEqual(after);

    await override('2026-11', { amount: 45_000 });
    expect(await november()).toMatchObject({ interest: 45_000, interestOverridden: true });
    const changed = await snapshot(t.db);
    expect((await json<LoanDto>(await reset('2026-11'))).body.months[1]).toMatchObject({
      interest: 50_000,
      interestOverridden: false,
    });
    expect((await json(await ctx.client.post('/api/undo'))).body).toMatchObject({
      undone: { label: 'Reset the interest of "Mortgage" for 2026-11' },
    });
    expect(await snapshot(t.db)).toEqual(changed);
    await ctx.client.post('/api/redo');
    expect(await json(await reset('2026-11'))).toMatchObject({ status: 404 });
  });

  it('takes months from the first transaction to the current one, on loans only', async () => {
    expect(await json(await override('2026-09', { amount: 1 }))).toEqual({
      status: 422,
      body: {
        code: 'month_out_of_range',
        message: 'Pick a month from 2026-10 to 2026-11.',
        fieldErrors: { month: ['Pick a month from 2026-10 to 2026-11.'] },
      },
    });
    expect((await json(await override('2026-12', { amount: 1 }))).body).toMatchObject({ code: 'month_out_of_range' });
    expect((await override('2026-10', { amount: 0 })).status).toBe(200);
    expect((await json(await override('2026-11', { amount: 1 }, checking.id))).body).toMatchObject({
      code: 'not_a_loan',
    });
    expect((await json(await override('2026-11', { amount: -1 }))).body).toMatchObject({
      code: 'validation',
      fieldErrors: { amount: ['Enter 0 or more.'] },
    });
    expect((await json(await override('2026-13', { amount: 1 }))).body).toMatchObject({
      fieldErrors: { month: ['Use the format YYYY-MM.'] },
    });
  });
});
```

```bash
git apply <<'PATCH'
diff --git a/src/server/http/app.test.ts b/src/server/http/app.test.ts
index f3e9dca..6b2e951 100644
--- a/src/server/http/app.test.ts
+++ b/src/server/http/app.test.ts
@@ -92,6 +92,9 @@ describe('route guard', () => {
         'POST /api/accounts/:id/revalue',
         'GET /api/accounts/:id/reconcile',
         'POST /api/accounts/:id/reconcile',
+        'GET /api/accounts/:id/loan',
+        'PUT /api/accounts/:id/interest-overrides/:month',
+        'DELETE /api/accounts/:id/interest-overrides/:month',
       ]),
     );
 
PATCH
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project server src/server/loans/loan-routes.test.ts src/server/http/app.test.ts`
Expected: FAIL, `Tests  5 failed | 7 passed (12)`: the loan routes answer 404.

- [ ] **Step 3: Add the schedule and the override commands**

Create `src/shared/api/loans.ts`:

```ts
import { z } from 'zod';
import { idSchema, monthSchema, nonNegativeMoneySchema } from './common';

export const loanMonthParamSchema = z.object({ id: idSchema, month: monthSchema });

/** PUT /api/accounts/:id/interest-overrides/:month: the month's interest, in the loan's currency (spec §8). */
export const interestOverrideRequestSchema = z.object({
  amount: nonNegativeMoneySchema.max(10 ** 13, 'That amount is too large.'),
});

/**
 * One month of a loan (spec §8), in the loan's currency; the `…Base` amounts are PLN, at the rate the month's
 * payments were booked at. Interest and escrow are charged only in months with a payment.
 */
export interface LoanMonthDto {
  /** 'YYYY-MM' */
  month: string;
  startBalance: number;
  /** Σ of the month's transactions (payments are positive). */
  transactionsTotal: number;
  /** The "Interest charge" row; editing it sets an interest override. */
  interest: number;
  interestBase: number;
  /** The interest is an override rather than APR / 12 of the start balance. */
  interestOverridden: boolean;
  /** The "Escrow" row. */
  escrow: number;
  escrowBase: number;
  endBalance: number;
  /** Payments − interest − escrow. */
  principalPaid: number;
  /**
   * The day of the month's first payment, null without one. The register shows the month's read-only "Interest
   * charge" and "Escrow" rows on this date, next to the transactions of that day.
   */
  chargedOn: string | null;
}

/**
 * GET /api/accounts/:id/loan: a loan's schedule from its first transaction to today. The register interleaves the
 * synthetic rows by `chargedOn`; its cursor paging over transactions is unchanged.
 */
export interface LoanDto {
  accountId: string;
  currency: string;
  /** APR in percent, e.g. "6.0000". */
  interestRate: string | null;
  minPayment: number | null;
  escrowAmount: number | null;
  /** Months with transactions, oldest first. */
  months: LoanMonthDto[];
}
```

Create `src/server/loans/loan-commands.ts`:

```ts
import { and, eq, isNull, sql } from 'drizzle-orm';
import { isLoanType } from '../../shared/accounts';
import type { LoanDto } from '../../shared/api/loans';
import { type IsoDate, type Money, type Month, monthOf } from '../../engine';
import { monthStart } from '../budget/assignments';
import type { ChangeRecorder } from '../commands/recorder';
import type { Executor } from '../db/client';
import { account, loanInterestOverride, transaction } from '../db/schema';
import { AppError, DomainError } from '../http/errors';
import { loanBalances } from './loan-balances';

type AccountRow = typeof account.$inferSelect;

/** 404 for an unknown account, 422 `not_a_loan` unless it has a loan type (spec §3). */
async function loanAccount(db: Executor, id: string): Promise<AccountRow> {
  const [row] = await db.select().from(account).where(eq(account.id, id));
  if (!row) throw new AppError(404, 'not_found', 'Account not found.');
  if (!isLoanType(row.type)) throw new DomainError('not_a_loan', 'Only loans have interest and escrow.');
  return row;
}

/** GET /api/accounts/:id/loan (spec §8). */
export async function getLoan(db: Executor, id: string): Promise<LoanDto> {
  const loan = await loanAccount(db, id);
  const balances = await loanBalances(db, [id]);
  return {
    accountId: id,
    currency: loan.currency,
    interestRate: loan.interestRate,
    minPayment: loan.minPayment,
    escrowAmount: loan.escrowAmount,
    months: balances.get(id)?.months ?? [],
  };
}

/** A loan's months run from its first live transaction to the current month. */
async function assertLoanMonth(db: Executor, id: string, month: Month, today: IsoDate): Promise<void> {
  const [first] = await db
    .select({ date: sql<IsoDate | null>`to_char(min(${transaction.date}), 'YYYY-MM-DD')` })
    .from(transaction)
    .where(and(eq(transaction.accountId, id), isNull(transaction.deletedAt)));
  const from = first?.date ? monthOf(first.date) : null;
  const to = monthOf(today);
  if (from === null || month < from || month > to) {
    throw new DomainError(
      'month_out_of_range',
      from === null || from > to ? 'This loan has no transactions yet.' : `Pick a month from ${from} to ${to}.`,
      'month',
    );
  }
}

const overrideWhere = (id: string, month: Month) =>
  and(eq(loanInterestOverride.accountId, id), eq(loanInterestOverride.month, monthStart(month)));

/**
 * Spec §8: editing a month's "Interest charge" row replaces the computed interest with `amount` (in the loan's
 * currency). It applies in months with a payment, and later months' interest follows the new balance.
 */
export async function setInterestOverride(
  rec: ChangeRecorder,
  id: string,
  month: Month,
  amount: Money,
  today: IsoDate,
): Promise<{ name: string }> {
  const loan = await loanAccount(rec.tx, id);
  await assertLoanMonth(rec.tx, id, month, today);
  const [existing] = await rec.tx.select().from(loanInterestOverride).where(overrideWhere(id, month));
  if (existing) await rec.update(loanInterestOverride, overrideWhere(id, month), { amount });
  else await rec.insert(loanInterestOverride, { accountId: id, month: monthStart(month), amount });
  return { name: loan.name };
}

/** Goes back to the computed interest for the month. */
export async function deleteInterestOverride(rec: ChangeRecorder, id: string, month: Month): Promise<{ name: string }> {
  const loan = await loanAccount(rec.tx, id);
  if ((await rec.delete(loanInterestOverride, overrideWhere(id, month))).length === 0) {
    throw new AppError(404, 'not_found', 'This month has no interest override.');
  }
  return { name: loan.name };
}
```

```bash
git apply <<'PATCH'
diff --git a/src/server/accounts/account-routes.ts b/src/server/accounts/account-routes.ts
index 3c5f2fc..fb66460 100644
--- a/src/server/accounts/account-routes.ts
+++ b/src/server/accounts/account-routes.ts
@@ -12,11 +12,13 @@ import {
   updateAccountRequestSchema,
 } from '../../shared/api/accounts';
 import { idParamSchema, type IdResponse, type ReorderResponse, reorderRequestSchema } from '../../shared/api/common';
+import { interestOverrideRequestSchema, type LoanDto, loanMonthParamSchema } from '../../shared/api/loans';
 import { type AuthedEnv, requireSession } from '../auth/sessions';
 import { todayIn } from '../clock';
 import { type Named, runCommand } from '../commands/run-command';
 import type { AppDeps } from '../http/app';
 import { validate } from '../http/validate';
+import { deleteInterestOverride, getLoan, setInterestOverride } from '../loans/loan-commands';
 import { getTransaction } from '../transactions/transaction-queries';
 import { createAccount, deleteAccount, reorderAccounts, setAccountClosed, updateAccount } from './account-commands';
 import { getAccount, readAccount, readAccounts } from './account-queries';
@@ -118,6 +120,33 @@ export function accountRoutes(deps: AppDeps) {
         reconciledCount: result.reconciledCount,
       });
     })
+    .get('/:id/loan', validate('param', idParamSchema), async (c) =>
+      c.json<LoanDto>(await getLoan(deps.db, c.req.valid('param').id)),
+    )
+    .put(
+      '/:id/interest-overrides/:month',
+      validate('param', loanMonthParamSchema),
+      validate('json', interestOverrideRequestSchema),
+      async (c) => {
+        const { id, month } = c.req.valid('param');
+        const { amount } = c.req.valid('json');
+        await runCommand(
+          deps,
+          (r: Named) => `Set the interest of "${r.name}" for ${month}`,
+          (rec) => setInterestOverride(rec, id, month, amount, today()),
+        );
+        return c.json<LoanDto>(await getLoan(deps.db, id));
+      },
+    )
+    .delete('/:id/interest-overrides/:month', validate('param', loanMonthParamSchema), async (c) => {
+      const { id, month } = c.req.valid('param');
+      await runCommand(
+        deps,
+        (r: Named) => `Reset the interest of "${r.name}" for ${month}`,
+        (rec) => deleteInterestOverride(rec, id, month),
+      );
+      return c.json<LoanDto>(await getLoan(deps.db, id));
+    })
     .delete('/:id', validate('param', idParamSchema), async (c) => {
       const { id } = c.req.valid('param');
       await runCommand(deps, (r: Named) => `Delete account "${r.name}"`, (rec) => deleteAccount(rec, id));
PATCH
```

- [ ] **Step 4: Run the tests and the final checks**

Run: `npx vitest run --project server src/server/loans/loan-routes.test.ts src/server/http/app.test.ts`
Expected: `Tests  12 passed (12)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  59 passed (59)`, `Tests  505 passed (505)`; both checks exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/shared/api/loans.ts src/server/loans src/server/accounts/account-routes.ts src/server/http/app.test.ts
git commit -m "feat(server): loan schedule and interest overrides" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 8: The loan panel; debt targets of foreign cards and loans

Spec §8 "Payoff and inspector", §11 "loan-paired categories show the loan panel", §6, and the P2b2 carry-over items "the loan panel of a paired category" and "foreign-currency cards and loans: debt targets use `min_payment` and `escrow_amount` as PLN amounts".

**Loan panel.** `BudgetCategoryDto` gains `loan: LoanPanelDto | null`, set on paired loan categories (`debt_payment`), so the category sheet has it without another request.
- It shows the loan's name, currency, today's balance with its charges (native and PLN), APR, minimum payment and escrow.
- `projectedPayoff` comes from `projectPayoff` (engine), from today's balance. It starts in the current month, or the next one when this month's payment is already in.
- The payment it assumes is a `fixed` or `payoff_by_date` debt target's need for the month (a foreign loan converts it back at the latest rate). It is the minimum payment for a `min_payment` target and without a target. The result is `'YYYY-MM'`, or `'never'` when the payment doesn't beat the interest (or takes over 1200 months).
- `recordPayment` pre-fills the transaction sheet. `accountId` is the open cash account of the latest transfer into the loan (the "last-used cash account"), else the first open cash account in display order, else null. `payeeId` is the loan's transfer payee, `categoryId` the paired category, and `amount` = −(the target's need for the month), in PLN, 0 without a target.

**Foreign cards and loans.** A debt target's `min_payment` and `escrow_amount` are in the account's currency, but spec §6 uses them as PLN. `loadLinkedAccounts(db, month, today, rates)` converts them at the latest NBP rate. Without a rate they count as 0, `missing.rate` is set, and a non-`fixed` debt target is `incomplete`. The month view's route and auto-assign quote the latest rates **before** their transaction: `latestRates` for `linkedForeignCurrencies(db)`, so nothing is asked when no card or loan is foreign. `loadBudgetMonth` and `autoAssignMonth` take the rates.

P2b2's `budget-month.test.ts` now sees the mortgage row's `loan` panel, and its `noTarget` rows have `loan: null`; `target-model.test.ts` gets `missing.rate`.

**Files:**
- Create: `src/server/loans/loan-panel.ts`
- Modify: `src/shared/api/budget.ts`, `src/shared/api/targets.ts`, `src/server/targets/target-model.ts`, `src/server/budget/budget-month.ts`, `src/server/budget/budget-routes.ts`, `src/server/budget/auto-assign.ts`
- Test: `src/server/loans/loan-panel.test.ts` (new), `src/server/budget/budget-month.test.ts`, `src/server/targets/target-model.test.ts`

**Interfaces:**
- Consumes: Tasks 4 and 6 (`latestRates`, `listAccounts`, `loanBalances`); `projectPayoff`, `parseDecimal`, `roundDiv`, `convertToBase` (engine).
- Produces:
  - `LoanPanelDto`, `BudgetCategoryDto.loan`.
  - `linkedForeignCurrencies(db)`, `loadLinkedAccounts(db, month, today, rates?)`, `LinkedAccount.missing.rate`.
  - `LoanInfo`, `loadLoanInfo(db, accountIds, today)`, `loanPanel(info, categoryId, target, need, today, rate?)`.
  - `loadBudgetMonth(db, month, today, rates?)`, `autoAssignMonth(rec, month, request, today, rates?)`.

- [ ] **Step 1: Write the failing tests**

Create `src/server/loans/loan-panel.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDto } from '../../shared/api/accounts';
import type { AutoAssignResponse, BudgetCategoryDto, BudgetMonthDto } from '../../shared/api/budget';
import { loadLinkedAccounts } from '../targets/target-model';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createAccount, createTransaction } from '../test/fixtures';
import { stubFx } from '../test/fx';

let t: TestDatabase;
let ctx: TestApp;
let nbp: Record<string, string>;
let checking: AccountDto;
let savings: AccountDto;
beforeEach(async () => {
  t = await createTestDatabase();
  nbp = { CHF: '4.5' };
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z', fx: stubFx(nbp) });
  await setUpBudget(ctx);
  checking = await createAccount(ctx.client, { name: 'mBank', startingBalance: 1_000_000 });
  savings = await createAccount(ctx.client, { name: 'Savings', type: 'savings', startingBalance: 1_000_000 });
});
afterEach(async () => {
  await t.drop();
});

async function json<T>(res: Response) {
  return (await res.json()) as T;
}

const categoryRow = async (id: string) => {
  const month = await json<BudgetMonthDto>(await ctx.client.get('/api/budget/2026-11'));
  return month.groups.flatMap((g) => g.categories).find((c) => c.id === id)!;
};
const setTarget = (categoryId: string, body: object) =>
  ctx.client.send('PUT', `/api/categories/${categoryId}/target`, { kind: 'debt', startMonth: '2026-11', ...body });

/** 100 000 zł at 6 % APR from 1 October, with a minimum payment of 1 000 zł. */
const mortgage = () =>
  createAccount(ctx.client, {
    name: 'Mortgage',
    type: 'mortgage',
    startingBalance: -10_000_000,
    startingDate: '2026-10-01',
    interestRate: '6',
    minPayment: 100_000,
    createPairedCategory: true,
  });

describe('the loan panel of a paired category', () => {
  it('shows balance, APR, payments, the projected payoff and a Record-payment prefill', async () => {
    const loan = await mortgage();
    // 139 payments of 1 000 zł from November 2026 pay off 100 000 zł at 0.5 % a month.
    expect((await categoryRow(loan.pairedCategoryId!)).loan).toEqual<BudgetCategoryDto['loan']>({
      accountId: loan.id,
      accountName: 'Mortgage',
      currency: 'PLN',
      balance: -10_000_000,
      balanceBase: -10_000_000,
      interestRate: '6.0000',
      minPayment: 100_000,
      escrowAmount: null,
      projectedPayoff: '2038-05',
      // No payment yet: the first open cash account pays the month's target need.
      recordPayment: {
        accountId: checking.id,
        payeeId: loan.transferPayeeId,
        categoryId: loan.pairedCategoryId!,
        amount: -100_000,
      },
    });

    await createTransaction(ctx.client, {
      accountId: savings.id,
      date: '2026-11-05',
      payeeId: loan.transferPayeeId,
      categoryId: loan.pairedCategoryId,
      amount: -100_000,
    });
    // Paid this month (with 500 zł interest): 138 more payments from December.
    expect((await categoryRow(loan.pairedCategoryId!)).loan).toMatchObject({
      balance: -9_950_000,
      projectedPayoff: '2038-05',
      recordPayment: { accountId: savings.id, amount: -100_000 },
    });
    // A closed account is no longer suggested.
    await createTransaction(ctx.client, { accountId: savings.id, amount: -900_000 });
    await ctx.client.post(`/api/accounts/${savings.id}/close`);
    expect((await categoryRow(loan.pairedCategoryId!)).loan!.recordPayment.accountId).toBe(checking.id);
  });

  it("projects with a fixed target's amount, and never pays off when it doesn't beat the interest", async () => {
    const loan = await mortgage();
    expect((await setTarget(loan.pairedCategoryId!, { debtMode: 'fixed', amount: 40_000 })).status).toBe(200);
    expect((await categoryRow(loan.pairedCategoryId!)).loan).toMatchObject({
      projectedPayoff: 'never',
      recordPayment: { amount: -40_000 },
    });
  });
});

describe('debt targets of foreign-currency loans', () => {
  it('convert the minimum payment and escrow at the latest NBP rate, or flag the target incomplete', async () => {
    const loan = await createAccount(ctx.client, {
      name: 'Franc mortgage',
      type: 'mortgage',
      currency: 'CHF',
      startingBalance: -1_000_000,
      startingDate: '2026-10-01',
      fxRate: '4',
      interestRate: '6',
      minPayment: 100_000,
      escrowAmount: 10_000,
      createPairedCategory: true,
    });
    // 1 000 CHF at 4.50.
    expect((await categoryRow(loan.pairedCategoryId!)).targetEvaluation).toMatchObject({
      need: 450_000,
      incomplete: false,
    });
    const rates = new Map([['CHF', { rate: '4.500000', effectiveDate: '2026-11-20' }]]);
    const linked = (await loadLinkedAccounts(t.db, '2026-11', '2026-11-20', rates)).get(loan.pairedCategoryId!);
    expect(linked).toMatchObject({ debt: { minPayment: 450_000, escrow: 45_000 }, missing: { rate: false } });
    const assigned = await json<AutoAssignResponse>(
      await ctx.client.post('/api/budget/2026-11/auto-assign', {
        strategy: 'underfunded',
        scope: { type: 'category', id: loan.pairedCategoryId },
      }),
    );
    expect(assigned.assignments).toEqual([{ month: '2026-11', categoryId: loan.pairedCategoryId, amount: 450_000 }]);

    delete nbp.CHF;
    expect((await categoryRow(loan.pairedCategoryId!)).targetEvaluation).toMatchObject({
      need: 0,
      incomplete: true,
    });
  });
});
```

```bash
git apply <<'PATCH'
diff --git a/src/server/budget/budget-month.test.ts b/src/server/budget/budget-month.test.ts
index a7d13f5..58aa714 100644
--- a/src/server/budget/budget-month.test.ts
+++ b/src/server/budget/budget-month.test.ts
@@ -42,7 +42,7 @@ const evaluation = (values: Partial<TargetEvaluationDto>): TargetEvaluationDto =
   incomplete: false,
   ...values,
 });
-const noTarget = { target: null, targetEvaluation: null, needToPayInFull: null };
+const noTarget = { target: null, targetEvaluation: null, needToPayInFull: null, loan: null };
 
 function row(c: CategoryDto, values: Partial<BudgetCategoryDto>): BudgetCategoryDto {
   return {
@@ -206,6 +206,7 @@ describe('GET /api/budget/:month', () => {
             pill: 'green',
             target: { ...debtTarget, categoryId: mortgage.pairedCategoryId!, startMonth: '2026-11' },
             targetEvaluation: evaluation({ need: 60_000, progress: 1 }),
+            loan: expect.objectContaining({ accountId: mortgage.id }),
           }),
         ]),
         group('normal', 'Everyday', [
diff --git a/src/server/targets/target-model.test.ts b/src/server/targets/target-model.test.ts
index fcc373a..33885e8 100644
--- a/src/server/targets/target-model.test.ts
+++ b/src/server/targets/target-model.test.ts
@@ -106,7 +106,7 @@ describe('loadLinkedAccounts', () => {
             accountId: visa.id,
             balanceAtMonthEnd: -125_000,
             debt: { minPayment: 5_000, apr: '24.0000', balanceAtMonthStart: -120_000, escrow: 0 },
-            missing: { minPayment: false, interestRate: false },
+            missing: { minPayment: false, interestRate: false, rate: false },
           },
         ],
         [
@@ -116,7 +116,7 @@ describe('loadLinkedAccounts', () => {
             // The November payment is charged interest (6 % / 12 of 100 000 zł = 500 zł) and escrow (200 zł).
             balanceAtMonthEnd: -10_010_000,
             debt: { minPayment: 60_000, apr: '6.0000', balanceAtMonthStart: -10_000_000, escrow: 20_000 },
-            missing: { minPayment: false, interestRate: false },
+            missing: { minPayment: false, interestRate: false, rate: false },
           },
         ],
       ]),
PATCH
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project server src/server/loans/loan-panel.test.ts src/server/budget/budget-month.test.ts src/server/targets/target-model.test.ts`
Expected: FAIL, `Tests  5 failed | 9 passed (14)`: there is no `loan` panel, and the CHF loan's target needs 1 000 instead of 4 500 zł.

- [ ] **Step 3: Convert foreign debt targets at the latest rate**

```bash
git apply <<'PATCH'
diff --git a/src/server/targets/target-model.ts b/src/server/targets/target-model.ts
index 7da80a8..934c7b0 100644
--- a/src/server/targets/target-model.ts
+++ b/src/server/targets/target-model.ts
@@ -1,7 +1,8 @@
-import { and, eq, isNull, lte, sql } from 'drizzle-orm';
+import { and, eq, isNull, lte, ne, sql } from 'drizzle-orm';
 import {
   addMonths,
   type BudgetResult,
+  convertToBase,
   dateInMonth,
   evaluateTarget,
   type IsoDate,
@@ -11,10 +12,12 @@ import {
   type TargetContext,
   type TargetDef,
 } from '../../engine';
+import { BASE_CURRENCY } from '../../shared/api/accounts';
 import type { TargetDto, TargetEvaluationDto } from '../../shared/api/targets';
 import { monthStart } from '../budget/assignments';
 import type { Executor } from '../db/client';
 import { account, category, type target, transaction } from '../db/schema';
+import type { FxQuote } from '../fx/fx-rates';
 import { loanBalances, loanCharges } from '../loans/loan-balances';
 
 export type TargetRow = typeof target.$inferSelect;
@@ -64,21 +67,36 @@ export interface LinkedAccount {
   accountId: string;
   /** PLN balance at the end of the month, or today if that is earlier (negative while money is owed). */
   balanceAtMonthEnd: Money;
-  /** Debt target inputs (spec §6, §8); a missing minimum payment or APR is 0 here. */
+  /**
+   * Debt target inputs (spec §6, §8) in PLN; a missing minimum payment or APR is 0 here. A foreign account's minimum
+   * payment and escrow are converted at the latest NBP rate, or count as 0 without one.
+   */
   debt: DebtContext;
-  /** Account fields that are not set (PATCH /api/accounts/:id can clear them). */
-  missing: { minPayment: boolean; interestRate: boolean };
+  /** Account fields that are not set (PATCH /api/accounts/:id can clear them), and a foreign account's missing rate. */
+  missing: { minPayment: boolean; interestRate: boolean; rate: boolean };
+}
+
+/** Currencies of the foreign accounts behind live credit card payment and paired loan categories. */
+export async function linkedForeignCurrencies(db: Executor): Promise<string[]> {
+  const rows = await db
+    .selectDistinct({ currency: account.currency })
+    .from(category)
+    .innerJoin(account, eq(account.id, category.linkedAccountId))
+    .where(and(isNull(category.deletedAt), ne(account.currency, BASE_CURRENCY)));
+  return rows.map((row) => row.currency);
 }
 
 /**
  * The linked account of every live credit card payment and paired loan category, keyed by category id. Balances are
  * PLN base sums of the account's live transactions dated `today` or earlier (a split parent carries its lines' sum);
  * a loan's also include the interest and escrow charged in the months before (start) or through (end) `month`.
+ * `rates` holds the latest NBP rate by currency (see `latestRates`), quoted before any transaction.
  */
 export async function loadLinkedAccounts(
   db: Executor,
   month: Month,
   today: IsoDate,
+  rates = new Map<string, FxQuote>(),
 ): Promise<Map<string, LinkedAccount>> {
   const monthEnd = dateInMonth(month, 31);
   const through = monthEnd < today ? monthEnd : today;
@@ -88,6 +106,7 @@ export async function loadLinkedAccounts(
       categoryId: category.id,
       accountId: account.id,
       accountClass: account.accountClass,
+      currency: account.currency,
       interestRate: account.interestRate,
       minPayment: account.minPayment,
       escrowAmount: account.escrowAmount,
@@ -104,27 +123,38 @@ export async function loadLinkedAccounts(
     .groupBy(category.id, account.id);
   const loans = await loanBalances(db, rows.map((row) => row.accountId));
   return new Map(
-    rows.map((row) => [
-      row.categoryId,
-      {
+    rows.map((row) => {
+      const foreign = row.currency !== BASE_CURRENCY;
+      const rate = rates.get(row.currency)?.rate ?? null;
+      // Spec §6 takes these as PLN; a foreign account's are in its own currency.
+      const toPln = (amount: Money) =>
+        !foreign ? amount : rate === null ? 0 : Math.min(convertToBase(amount, rate), Number.MAX_SAFE_INTEGER);
+      const loan = loans.get(row.accountId);
+      const linked: LinkedAccount = {
         accountId: row.accountId,
-        balanceAtMonthEnd: row.throughMonth + loanCharges(loans.get(row.accountId), addMonths(month, 1)).amountBase,
+        balanceAtMonthEnd: row.throughMonth + loanCharges(loan, addMonths(month, 1)).amountBase,
         debt: {
-          minPayment: row.minPayment ?? 0,
+          minPayment: toPln(row.minPayment ?? 0),
           apr: row.interestRate ?? '0',
-          balanceAtMonthStart: row.beforeMonth + loanCharges(loans.get(row.accountId), month).amountBase,
+          balanceAtMonthStart: row.beforeMonth + loanCharges(loan, month).amountBase,
           // Spec §6: escrow is added for loans only.
-          escrow: row.accountClass === 'tracking' ? (row.escrowAmount ?? 0) : 0,
+          escrow: row.accountClass === 'tracking' ? toPln(row.escrowAmount ?? 0) : 0,
+        },
+        missing: {
+          minPayment: row.minPayment === null,
+          interestRate: row.interestRate === null,
+          rate: foreign && rate === null,
         },
-        missing: { minPayment: row.minPayment === null, interestRate: row.interestRate === null },
-      },
-    ]),
+      };
+      return [row.categoryId, linked];
+    }),
   );
 }
 
 /**
  * Evaluates a category's target for `month` (spec §6); null before the target's start month. A debt target whose
- * account lacks its minimum payment or APR is evaluated with 0 for it and flagged `incomplete`.
+ * account lacks its minimum payment or APR, or a foreign account's latest NBP rate, is evaluated with 0 for it and
+ * flagged `incomplete`.
  */
 export function evaluateCategoryTarget(
   def: TargetDef,
@@ -138,6 +168,7 @@ export function evaluateCategoryTarget(
   const incomplete =
     def.kind === 'debt' &&
     ((def.debtMode === 'min_payment' && linked?.missing.minPayment === true) ||
-      (def.debtMode === 'payoff_by_date' && linked?.missing.interestRate === true));
+      (def.debtMode === 'payoff_by_date' && linked?.missing.interestRate === true) ||
+      (def.debtMode !== 'fixed' && linked?.missing.rate === true));
   return { ...evaluation, incomplete };
 }
diff --git a/src/shared/api/targets.ts b/src/shared/api/targets.ts
index 961f5ac..a64f52a 100644
--- a/src/shared/api/targets.ts
+++ b/src/shared/api/targets.ts
@@ -46,7 +46,8 @@ export interface TargetEvaluationDto {
   snoozed: boolean;
   /**
    * A debt target whose account lacks a field it needs: the minimum payment (`min_payment`) or the APR
-   * (`payoff_by_date`). The missing value counts as 0 until the user enters it on the account.
+   * (`payoff_by_date`). The missing value counts as 0 until the user enters it on the account. For a foreign
+   * account it is also set while there is no NBP rate to convert its minimum payment and escrow to PLN.
    */
   incomplete: boolean;
 }
PATCH
```

- [ ] **Step 4: Add the loan panel**

```bash
git apply <<'PATCH'
diff --git a/src/shared/api/budget.ts b/src/shared/api/budget.ts
index cda7665..b8a0849 100644
--- a/src/shared/api/budget.ts
+++ b/src/shared/api/budget.ts
@@ -110,6 +110,8 @@ export interface BudgetCategoryDto {
   targetEvaluation: TargetEvaluationDto | null;
   /** Credit card payment categories: "Need X to pay in full" (spec §5.3); null for every other category. */
   needToPayInFull: number | null;
+  /** Paired loan categories: the loan panel (spec §8); null for every other category. */
+  loan: LoanPanelDto | null;
 }
 
 export interface BudgetGroupDto {
@@ -142,3 +144,36 @@ export interface BudgetMonthDto {
   /** Spec §3: present only while Uncategorized has activity or money in this month. */
   uncategorized: BudgetCategoryDto | null;
 }
+
+/** The loan panel of a paired loan category's sheet (spec §8, §11). */
+export interface LoanPanelDto {
+  accountId: string;
+  accountName: string;
+  currency: string;
+  /** Today's balance with the interest and escrow charged (negative while owed), in the loan's currency. */
+  balance: number;
+  /** The same in PLN. */
+  balanceBase: number;
+  /** APR in percent, e.g. "6.0000". */
+  interestRate: string | null;
+  /** In the loan's currency. */
+  minPayment: number | null;
+  escrowAmount: number | null;
+  /**
+   * 'YYYY-MM' of the last payment at the debt target's monthly amount (the minimum payment without a fixed or
+   * pay-off-by-date target), from the first month without a payment yet; 'never' when it can't pay the loan off
+   * within 1200 months.
+   */
+  projectedPayoff: string;
+  /** "Record payment" pre-fills the transaction sheet with this transfer to the loan. */
+  recordPayment: {
+    /** The cash account of the latest payment, else the first open cash account; null without one. */
+    accountId: string | null;
+    /** The loan's transfer payee. */
+    payeeId: string;
+    /** This paired category. */
+    categoryId: string;
+    /** −(the target's need this month), in PLN minor units; 0 without a target. */
+    amount: number;
+  };
+}
PATCH
```

Create `src/server/loans/loan-panel.ts`:

```ts
import { and, asc, desc, eq, gt, gte, inArray, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { type AccountDto, BASE_CURRENCY } from '../../shared/api/accounts';
import type { LoanPanelDto } from '../../shared/api/budget';
import type { TargetDto } from '../../shared/api/targets';
import {
  addMonths,
  type IsoDate,
  type Money,
  monthOf,
  parseDecimal,
  projectPayoff,
  roundDiv,
} from '../../engine';
import { listAccounts } from '../accounts/account-queries';
import { monthStart } from '../budget/assignments';
import type { Executor } from '../db/client';
import { account, transaction } from '../db/schema';
import type { FxQuote } from '../fx/fx-rates';

/** What the loan panel needs beyond the month's target. */
export interface LoanInfo {
  account: AccountDto;
  /** A payment (inflow) arrived this month: the projection starts next month. */
  paidThisMonth: boolean;
  /** Spec §8 "Record payment": the cash account of the latest payment, else the first open cash account. */
  paymentAccountId: string | null;
}

const paymentAccount = alias(account, 'payment_account');

/** Loads the panel data of the given loan accounts (spec §8), keyed by account id. */
export async function loadLoanInfo(db: Executor, accountIds: string[], today: IsoDate): Promise<Map<string, LoanInfo>> {
  if (accountIds.length === 0) return new Map();
  const accounts = await listAccounts(db, inArray(account.id, accountIds));
  const openCash = and(eq(paymentAccount.accountClass, 'cash'), eq(paymentAccount.closed, false));
  const [firstCash] = await db
    .select({ id: paymentAccount.id })
    .from(paymentAccount)
    .where(openCash)
    .orderBy(asc(paymentAccount.sortOrder), asc(paymentAccount.createdAt), asc(paymentAccount.id))
    .limit(1);
  const result = new Map<string, LoanInfo>();
  for (const loan of accounts) {
    const inflows = and(eq(transaction.accountId, loan.id), isNull(transaction.deletedAt), gt(transaction.amount, 0));
    const [paid] = await db
      .select({ id: transaction.id })
      .from(transaction)
      .where(and(inflows, gte(transaction.date, monthStart(monthOf(today)))))
      .limit(1);
    const [latest] = await db
      .select({ id: paymentAccount.id })
      .from(transaction)
      .innerJoin(paymentAccount, eq(paymentAccount.id, transaction.transferAccountId))
      .where(and(inflows, openCash))
      .orderBy(desc(transaction.date), desc(transaction.id))
      .limit(1);
    result.set(loan.id, {
      account: loan,
      paidThisMonth: paid !== undefined,
      paymentAccountId: latest?.id ?? firstCash?.id ?? null,
    });
  }
  return result;
}

/** PLN → the loan's currency at `rate` (the inverse of convertToBase), rounded half away from zero. */
const fromBase = (amountBase: Money, rate: string): Money =>
  Number(roundDiv(BigInt(amountBase) * 1_000_000n, parseDecimal(rate, 6)));

/**
 * The monthly payment the payoff projection assumes, in the loan's currency (spec §8): a fixed or pay-off-by-date debt
 * target's need, else the minimum payment. A foreign loan converts the need back at the latest NBP rate.
 */
function projectedPayment(info: LoanInfo, target: TargetDto | null, need: Money | null, rate?: FxQuote): Money {
  const { currency, minPayment } = info.account;
  const byTarget = target?.kind === 'debt' && target.debtMode !== 'min_payment' && need !== null;
  if (!byTarget) return minPayment ?? 0;
  if (currency === BASE_CURRENCY) return need;
  return rate ? fromBase(need, rate.rate) : (minPayment ?? 0);
}

/** The loan panel of a paired category for the month whose target `need` is given (null without one). */
export function loanPanel(
  info: LoanInfo,
  categoryId: string,
  target: TargetDto | null,
  need: Money | null,
  today: IsoDate,
  rate?: FxQuote,
): LoanPanelDto {
  const loan = info.account;
  const currentMonth = monthOf(today);
  const payoff = projectPayoff({
    debt: Math.min(0, loan.balance.working),
    apr: loan.interestRate ?? '0',
    payment: projectedPayment(info, target, need, rate),
    escrow: loan.escrowAmount ?? 0,
    fromMonth: info.paidThisMonth ? addMonths(currentMonth, 1) : currentMonth,
  });
  return {
    accountId: loan.id,
    accountName: loan.name,
    currency: loan.currency,
    balance: loan.balance.working,
    balanceBase: loan.balanceBase.working,
    interestRate: loan.interestRate,
    minPayment: loan.minPayment,
    escrowAmount: loan.escrowAmount,
    projectedPayoff: payoff,
    recordPayment: {
      accountId: info.paymentAccountId,
      payeeId: loan.transferPayeeId,
      categoryId,
      amount: need ? -need : 0,
    },
  };
}
```

- [ ] **Step 5: Quote the rates before the month view and auto-assign**

```bash
git apply <<'PATCH'
diff --git a/src/server/budget/auto-assign.ts b/src/server/budget/auto-assign.ts
index 7cf9d47..99c6ed3 100644
--- a/src/server/budget/auto-assign.ts
+++ b/src/server/budget/auto-assign.ts
@@ -4,6 +4,7 @@ import type { AutoAssignRequest, BudgetCategoryDto, BudgetMonthDto } from '../..
 import type { ChangeRecorder } from '../commands/recorder';
 import type { Executor } from '../db/client';
 import { categoryGroup } from '../db/schema';
+import type { FxQuote } from '../fx/fx-rates';
 import { DomainError } from '../http/errors';
 import { assignableCategory, setAssigned } from './assignments';
 import { loadBudgetMonth } from './budget-month';
@@ -56,9 +57,10 @@ export async function autoAssignMonth(
   month: Month,
   request: AutoAssignRequest,
   today: IsoDate,
+  rates = new Map<string, FxQuote>(),
 ): Promise<AssignmentChange[]> {
   await assertScope(rec.tx, request.scope);
-  const { result, view } = await loadBudgetMonth(rec.tx, month, today);
+  const { result, view } = await loadBudgetMonth(rec.tx, month, today, rates);
   const categories = categoriesInScope(view, request.scope);
   const changes = autoAssign({
     strategy: request.strategy,
diff --git a/src/server/budget/budget-month.ts b/src/server/budget/budget-month.ts
index 4f34b27..6175535 100644
--- a/src/server/budget/budget-month.ts
+++ b/src/server/budget/budget-month.ts
@@ -14,6 +14,8 @@ import type { CategoryDto } from '../../shared/api/categories';
 import { listCategoryGroups } from '../categories/category-queries';
 import type { Executor } from '../db/client';
 import { monthNote, target } from '../db/schema';
+import type { FxQuote } from '../fx/fx-rates';
+import { loadLoanInfo, loanPanel } from '../loans/loan-panel';
 import { evaluateCategoryTarget, loadLinkedAccounts, toTargetDto } from '../targets/target-model';
 import { assertBudgetMonth, budgetStartMonth, MONTHS_AHEAD, monthStart } from './assignments';
 import { loadBudgetInput } from './budget-input';
@@ -27,15 +29,25 @@ export interface BudgetMonth {
 /**
  * The Budget screen for `month` (spec §11) from one `computeBudget` run. Throws 422 `month_out_of_range` outside the
  * first editable month .. current month + 24. Callers run it in one transaction, so every query reads one snapshot.
+ * `rates` holds the latest NBP rates of foreign linked accounts (`linkedForeignCurrencies`), quoted before it.
  */
-export async function loadBudgetMonth(db: Executor, month: Month, today: IsoDate): Promise<BudgetMonth> {
+export async function loadBudgetMonth(
+  db: Executor,
+  month: Month,
+  today: IsoDate,
+  rates = new Map<string, FxQuote>(),
+): Promise<BudgetMonth> {
   await assertBudgetMonth(db, month, today);
   const input = await loadBudgetInput(db, { throughMonth: month, today });
   const result = computeBudget(input);
   const cells = result.byMonth[month]!;
   const groups = await listCategoryGroups(db);
   const targets = new Map((await db.select().from(target)).map((row) => [row.categoryId, toTargetDto(row)]));
-  const linked = await loadLinkedAccounts(db, month, today);
+  const linked = await loadLinkedAccounts(db, month, today, rates);
+  const pairedLoans = groups.flatMap((g) =>
+    g.categories.flatMap((c) => (c.kind === 'debt_payment' && c.linkedAccountId ? [c.linkedAccountId] : [])),
+  );
+  const loans = await loadLoanInfo(db, pairedLoans, today);
   const [note] = await db
     .select({ note: monthNote.note })
     .from(monthNote)
@@ -46,6 +58,7 @@ export async function loadBudgetMonth(db: Executor, month: Month, today: IsoDate
     const def = targets.get(c.id) ?? null;
     const account = linked.get(c.id);
     const evaluation = def && evaluateCategoryTarget(def, result, month, c.id, account);
+    const loan = c.kind === 'debt_payment' && c.linkedAccountId ? loans.get(c.linkedAccountId) : undefined;
     return {
       id: c.id,
       name: c.name,
@@ -64,6 +77,7 @@ export async function loadBudgetMonth(db: Executor, month: Month, today: IsoDate
       targetEvaluation: evaluation,
       needToPayInFull:
         c.kind === 'cc_payment' && account ? cardPaymentShortfall(account.balanceAtMonthEnd, cell.available) : null,
+      loan: loan ? loanPanel(loan, c.id, def, evaluation?.need ?? null, today, rates.get(loan.account.currency)) : null,
     };
   };
 
diff --git a/src/server/budget/budget-routes.ts b/src/server/budget/budget-routes.ts
index 9d911ac..8160eda 100644
--- a/src/server/budget/budget-routes.ts
+++ b/src/server/budget/budget-routes.ts
@@ -16,7 +16,9 @@ import { type AuthedEnv, requireSession } from '../auth/sessions';
 import { todayIn } from '../clock';
 import { type Named, runCommand } from '../commands/run-command';
 import type { AppDeps } from '../http/app';
+import { latestRates } from '../fx/fx-rates';
 import { validate } from '../http/validate';
+import { linkedForeignCurrencies } from '../targets/target-model';
 import { assertBudgetMonth, assignableCategory, assignedIn, moveMoney, setAssigned, setMonthNote } from './assignments';
 import { autoAssignMonth, STRATEGY_LABELS } from './auto-assign';
 import { loadBudgetMonth } from './budget-month';
@@ -27,13 +29,17 @@ import { loadBudgetMonth } from './budget-month';
  */
 export function budgetRoutes(deps: AppDeps) {
   const today = () => todayIn(deps.config.timeZone, deps.clock.now());
+  // Spec §6, §9: debt targets of foreign cards and loans convert at the latest NBP rate, quoted before the
+  // transaction (cache first, at most once per currency, bounded by NBP's 5 s timeout).
+  const rates = async () => latestRates(deps.fx, await linkedForeignCurrencies(deps.db), today());
 
   return new Hono<AuthedEnv>()
     .use('*', requireSession(deps))
     .get('/:month', validate('param', monthParamSchema), async (c) => {
       const { month } = c.req.valid('param');
+      const latest = await rates();
       // One read-only snapshot for all the month view's queries.
-      const { view } = await deps.db.transaction((tx) => loadBudgetMonth(tx, month, today()), {
+      const { view } = await deps.db.transaction((tx) => loadBudgetMonth(tx, month, today(), latest), {
         isolationLevel: 'repeatable read',
         accessMode: 'read only',
       });
@@ -84,8 +90,9 @@ export function budgetRoutes(deps: AppDeps) {
       async (c) => {
         const { month } = c.req.valid('param');
         const body = c.req.valid('json');
+        const latest = await rates();
         const changes = await runCommand(deps, `Auto-assign: ${STRATEGY_LABELS[body.strategy]}`, (rec) =>
-          autoAssignMonth(rec, month, body, today()),
+          autoAssignMonth(rec, month, body, today(), latest),
         );
         return c.json<AutoAssignResponse>({
           assignments: changes.map((change) => ({ month, categoryId: change.categoryId, amount: change.to })),
PATCH
```

- [ ] **Step 6: Run the tests and the final checks**

Run: `npx vitest run --project server src/server/loans/loan-panel.test.ts src/server/budget/budget-month.test.ts src/server/targets/target-model.test.ts`
Expected: `Tests  14 passed (14)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  60 passed (60)`, `Tests  508 passed (508)`; both checks exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/shared/api src/server/loans src/server/targets src/server/budget
git commit -m "feat(server): loan panel; debt targets of foreign cards and loans in PLN" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 9: P2d1 docs

The spec records the decisions this phase made where it was open: §2 `NBP_BASE_URL`; §6 loan charges and foreign accounts in debt targets; §8 balances with charges, the schedule endpoint, `chargedOn`, the override range, the panel's projection and prefill; §9 the NBP client, default rates on writes (including future-dated creates), the latest rate, Revalue's refusals and fixed amounts; §10 the reconcile request and errors; §13 `reconcile_mismatch`. `p2-carry-over.md` gets "Resolved in P2d1" and "From P2d1" sections (appended), and `engineering-notes.md` gets the FX and loan conventions (and P2c's note on `fx_rate_manual` and on what goes through the planner is brought up to date).

**Files:**
- Modify: `docs/superpowers/specs/2026-11-19-core-budgeting-design.md`, `docs/superpowers/notes/engineering-notes.md`, `docs/superpowers/notes/p2-carry-over.md`

- [ ] **Step 1: Update the spec and the notes**

```bash
git apply <<'PATCH'
diff --git a/docs/superpowers/notes/engineering-notes.md b/docs/superpowers/notes/engineering-notes.md
index 87e8e5c..334f697 100644
--- a/docs/superpowers/notes/engineering-notes.md
+++ b/docs/superpowers/notes/engineering-notes.md
@@ -77,14 +77,34 @@ Keep each plan to about 8–10 tasks. A task is one reviewable unit with its own
 - Every transaction write is planned first: build a `Draft` (what the user describes) and call
   `planTransaction(db, draft, context)` in `src/server/transactions/plan.ts`. It applies spec §5.5 and §9 and returns
   the rows (`Plan`); `insertPlan` writes a new transaction and `syncPlan` brings a saved one in line. P2d's schedule
-  job, reconcile adjustments and FX revaluation should build drafts too, so they get the same rules.
+  job and reconcile adjustments build drafts too, so they get the same rules (an adjustment's system payee needs
+  `PlanContext.systemPayee`). An FX revaluation (amount 0, a PLN difference) can't be planned and is inserted
+  directly; edits keep its amounts.
 - `loadAggregate(db, id)` returns a transaction with its transfer side, live split lines with their counterparts, or,
   for a split line's counterpart, its owning split and line (`owner`).
 - Rows that point at each other (the two sides of a transfer, a line and its counterpart) are inserted first and then
   linked with `rec.update`, because foreign keys are checked immediately; undo replays the steps in reverse.
 - The category of a budget↔tracking transfer lives on the budget-side row; `draftOf` reads it from either side.
-- `fx_rate` holds the rate a base amount was computed with (always user-entered in P2c, so `fx_rate_manual`); sides
-  whose base is derived from the other side of a transfer store null. `effectiveRate` in the DTOs shows the rate.
+- `fx_rate` holds the rate a base amount was computed with; `fx_rate_manual` says whether the user entered it (NBP
+  rates from P2d1 on are not manual). Sides whose base is derived from the other side of a transfer store null.
+  `effectiveRate` in the DTOs shows the rate.
+
+### FX and loans (P2d1)
+- NBP quotes come from `deps.fx.quote(currency, date)` (`FxRates`, `src/server/fx/fx-rates.ts`). It never throws and
+  must never run inside a DB transaction or under the command lock: quote first, then call `runCommand` or open the
+  read transaction. `latestRates(fx, currencies, today)` quotes several currencies at once, once each.
+- Transaction writes learn which rates they need from a dry run (`src/server/transactions/default-rates.ts`): it plans
+  the draft read-only with `PlanContext.unknownRates`, quotes what is missing, and the command plans again with
+  `PlanContext.defaults`. A rate is a `Rate { rate, manual }`; `storedRates(db, agg, sameDate)` drops NBP rates when
+  the date changes.
+- Account DTOs for responses come from `readAccounts` / `readAccount` (they quote the latest rates for "≈ X zł");
+  `listAccounts` / `getAccount` inside commands leave `latestRate` null.
+- Tests: `createTestApp(db, { fx: stubFx({ EUR: '4.3' }) })` (or rates by date); `stub.calls` records the quotes, and
+  mutating the rates object changes later answers. The NBP client itself is tested against a `node:http` server on
+  port 0 with a short `timeoutMs`.
+- Loan balances: `loanBalances(db, accountIds)` runs `computeLoanMonths` for loan accounts and `loanCharges(loan,
+  before?)` sums the synthetic interest and escrow; every balance of a loan goes through them.
+
 ### Budget read model
 - `loadBudgetInput(db, { throughMonth, today })` (`src/server/budget/budget-input.ts`) is the only place that turns
   the ledger into `computeBudget` input; it starts at `firstEditableMonth()`, the lower bound `assertBudgetMonth()`
diff --git a/docs/superpowers/notes/p2-carry-over.md b/docs/superpowers/notes/p2-carry-over.md
index 234b706..ed402ad 100644
--- a/docs/superpowers/notes/p2-carry-over.md
+++ b/docs/superpowers/notes/p2-carry-over.md
@@ -162,3 +162,37 @@ These items were found in the P1 final review and deferred. Fold them into the P
 - Later: `GET /api/budget/:month` takes ≈ 80 ms for 10 years × 150 categories (26k transactions) and ≈ 175 ms in a
   dense worst case (36k activity rows) on an M3 Max. If it matters, read the activity aggregate with `db.execute`
   (Drizzle's row mapping costs ≈ 30 ms per 36k rows) and profile `computeBudget`.
+
+## Resolved in P2d1
+- NBP rates (spec §9): `src/server/fx/fx-rates.ts` implements `FxRates.quote` (fx_rate cache, 7-day fallback, 5 s
+  timeout, null on any failure) and `AppDeps.fx`; `NBP_BASE_URL` configures it. Tests use `stubFx` or a local
+  `node:http` stub server.
+- `fxRate` is optional when creating a foreign-currency account: the starting balance takes the NBP rate of its date.
+- Foreign transactions, splits and transfers without `fxRate` are booked at the NBP rate of their date
+  (`fx_rate_manual = false`); a sent rate is manual. A date change re-fetches a non-manual rate and rebooks the base
+  amounts, the split lines and the other side of a transfer. A future-dated transaction stores the rate sent or none.
+- The reconcile flow exists (`GET`/`POST /api/accounts/:id/reconcile`); it is still the only way to set `reconciled`.
+- A loan's balances include the synthetic interest and escrow everywhere (`loanBalances` / `loanCharges` in
+  `src/server/loans/loan-balances.ts`), so debt targets' `balanceAtMonthStart` counts them.
+- The loan panel of a paired category (`BudgetCategoryDto.loan`): balance, APR, minimum payment, escrow, projected
+  payoff and the Record-payment prefill.
+- Foreign-currency cards and loans: debt targets convert `min_payment` and `escrow_amount` to PLN at the latest NBP
+  rate (0 and `incomplete` without one).
+
+## From P2d1
+- P2d2: entering a schedule whose `fx_rate` is null quotes the NBP rate of the occurrence date before the job's
+  transaction and lock (`deps.fx.quote`), and books it with `fx_rate_manual = false`; a schedule's manual rate stays.
+  `planTransaction` takes it as `PlanContext.defaults`.
+- NBP has no negative cache: a currency outside table A costs 8 requests (within the 5 s timeout) on every quote, and
+  today's rate is fetched on every read until NBP publishes it (around noon on working days).
+- `GET /api/accounts`, `GET /api/budget/:month` and auto-assign can wait up to 5 s per foreign currency for NBP when
+  the cache can't answer; the quotes run in parallel.
+- Bulk edits don't fetch NBP rates; they never change dates, so stored rates cover them.
+- P3: the transaction sheet pre-fills the rate from `GET /api/fx/rates/:currency/:date`, shows `fxRateManual`, and
+  interleaves a loan's synthetic rows from `GET /api/accounts/:id/loan` by `chargedOn`. The Record-payment amount is
+  PLN; when the suggested cash account isn't PLN the sheet has to convert it.
+- A loan with interest overrides counts as in use, so it can't be deleted (close it instead), like an account with
+  transactions.
+- FX revaluations and the account's starting balance are the only transactions written outside `planTransaction`
+  (an amount of 0 with a PLN difference can't be planned); reconciliation adjustments go through it with
+  `PlanContext.systemPayee`.
diff --git a/docs/superpowers/specs/2026-11-19-core-budgeting-design.md b/docs/superpowers/specs/2026-11-19-core-budgeting-design.md
index 2291e40..aaf329a 100644
--- a/docs/superpowers/specs/2026-11-19-core-budgeting-design.md
+++ b/docs/superpowers/specs/2026-11-19-core-budgeting-design.md
@@ -70,7 +70,7 @@ on each request; at single-user scale (≈10 years × 150 categories) this is we
 
 **Config (env):** `DATABASE_URL`, `ENCRYPTION_KEY` (32-byte key, base64, AES-256-GCM for the TOTP secret), `SETUP_TOKEN`,
 `TZ=Europe/Warsaw`, `PORT`, `COOKIE_SECURE` (default true), `TRUST_PROXY` (default false; take the client IP from
-`X-Forwarded-For`), `LOG_LEVEL`, `MIGRATIONS_DIR`. Sessions are opaque random tokens stored hashed, so no
+`X-Forwarded-For`), `LOG_LEVEL`, `MIGRATIONS_DIR`, `NBP_BASE_URL` (default `https://api.nbp.pl`). Sessions are opaque random tokens stored hashed, so no
 session-signing secret is needed.
 
 ## 3. Domain concepts
@@ -296,7 +296,10 @@ Other target rules:
   for a credit card the amount is "in addition to funded spending".
 - The balance at the start of m is the account's PLN balance before m (counting transactions dated today or
   earlier). If the account has no minimum payment (`min_payment`) or no APR (`payoff_by_date`), the missing value
-  counts as 0 and the target is flagged **incomplete** until the user enters it.
+  counts as 0 and the target is f
+- A loan's balance includes the interest and escrow charged (§8). For a foreign-currency card or loan, the minimum
+  payment and escrow (in the account's currency) are converted to PLN at the latest NBP rate (§9); without a rate they
+  count as 0 and the target is flagged **incomplete**.lagged **incomplete** until the user enters it.
 - **Progress** = (need − underfunded) / need, or Available / A for balance targets.
 - **Snooze:** if `snoozed_month = m`, underfunded is 0 and the category matches the "Snoozed" filter. Progress for a
   snoozed target still reflects its real funding (it is computed from the unsnoozed underfunded amount).
@@ -337,6 +340,17 @@ All strategies except Underfunded may push RTA negative. Each auto-assign run is
 - APR must be ≥ 0; the engine rejects a negative APR.
 - The register shows synthetic read-only "Interest charge" / "Escrow" rows per month. Editing the interest row writes
   a `loan_interest_override`.
+- The loan's displayed balances (accounts list, register header, reconcile, close, debt targets, loan panel) include
+  the interest and escrow charged. A month's charges are cleared once every payment in that month is cleared, and
+  uncleared while any of them is uncleared. The loan engine runs in the loan's currency; a foreign loan's charges are
+  converted to PLN at the rate its payments that month were booked at.
+- `GET /api/accounts/:id/loan` returns the months with their interest, escrow and principal. A month's synthetic rows
+  are dated on its first payment (`chargedOn`); the register interleaves them by date, and its cursor paging over
+  transactions is unchanged.
+- An interest override is set for a month from the loan's first transaction to the current month, in the loan's
+  currency (≥ 0). It applies in months with a payment, and later months' interest follows the new balance.
+- A loan's first month has no interest, even with a payment in it, because its balance at the start of that month is
+  0. An interest override for that month adds it.
 
 **Payoff and inspector**
 - **Projected payoff date**: amortize from the current balance at APR/12 using the debt target amount (or
@@ -349,6 +363,10 @@ All strategies except Underfunded may push RTA negative. Each auto-assign run is
 - The paired category's inspector shows balance, APR, minimum payment, projected payoff date and a **Record payment**
   shortcut. The shortcut opens the transaction sheet prefilled: transfer from the last-used cash account to the loan,
   category = paired category, amount = target need.
+- The panel is part of the month view (`loan` on the paired category). The projection starts in the current month,
+  or the next one once this month's payment is in; it uses a `fixed` or `payoff_by_date` target's need, otherwise the
+  minimum payment (a foreign loan converts the need back at the latest rate). "Last-used cash account" is the open
+  cash account of the latest transfer into the loan, else the first open cash account; the amount is −need (PLN).
 
 ## 9. Multi-currency (FX)
 
@@ -358,6 +376,16 @@ All strategies except Underfunded may push RTA negative. Each auto-assign run is
   up to 7 days. Results are cached in `fx_rate`.
 - The user can override the rate (`fx_rate_manual = true`). Changing the date re-fetches the rate unless it's manual.
 - Unsupported currency or NBP unreachable → the rate field is required and the UI asks for it.
+- **NBP client**: one quote tries the date and up to 7 earlier days within a 5 s timeout; any other error, a malformed
+  answer or a timeout means "no rate". Only final rates are cached: published that day, or for a past day or a
+  weekend. Quotes run before a command or read transaction starts, never inside one; PLN is never quoted.
+- Writes resolve the default rate before the command: a sent rate is manual (`fx_rate_manual = true`), an NBP rate is
+  not. Without either, the answer is 422 `fx_rate_required`. A future-dated transaction (a schedule, §5.6) stores the
+  rate sent, or none: its occurrence gets the NBP rate of the day it is entered. An edit keeps the stored rate unless
+  a new one is sent, except that a new date replaces an NBP rate with that day's. Bulk edits never change dates and
+  use stored rates only. `GET /api/fx/rates/:currency/:date` gives the sheet the NBP rate (no future dates).
+- "Latest available NBP rate" is today's quote (falling back like any quote). Account reads quote it once per foreign
+  currency per request; so do the month view and auto-assign for foreign linked accounts (§6).
 - **Split lines** use the parent's rate. The rounding remainder goes to the last line so that
   Σ line base = parent base.
 - **Cross-currency transfers**: the user enters both actual amounts.
@@ -370,6 +398,9 @@ All strategies except Underfunded may push RTA negative. Each auto-assign run is
 - **Revalue**: unrealized difference = round(native balance × latest rate) − Σ `amount_base`. The action posts a
   transaction with `amount = 0`, `amount_base = diff`, payee "FX revaluation", cleared. On-budget accounts get
   category RTA; tracking accounts get no category.
+  It takes an optional manual rate (else the latest NBP rate) and is refused for PLN and closed accounts and when the
+  difference is 0. A revaluation keeps its amounts: only its memo, flag and cleared status change (`revaluation_fixed`
+  otherwise); deleting it takes it back.
 - Reconciliation uses native amounts.
 
 ## 10. Transactions and related workflows
@@ -414,6 +445,10 @@ All strategies except Underfunded may push RTA negative. Each auto-assign run is
 - **No** → the user enters the statement balance and sees the difference. They can keep reviewing, or "Create
   adjustment & finish". The adjustment is payee "Reconciliation Balance Adjustment", cleared, category RTA (on-budget)
   or none (tracking), after which everything cleared is marked reconciled.
+- `POST /api/accounts/:id/reconcile` takes `statementBalance`, `createAdjustment` and, for a foreign adjustment, an
+  optional `fxRate` (else today's NBP rate). A difference without `createAdjustment` is 422 `reconcile_mismatch` with
+  the `difference`. Closed accounts are refused. It is one undoable command; a loan's cleared balance includes the
+  interest and escrow of months whose payments are all cleared (§8).
 
 **Scheduled transactions**
 - A croner job runs daily at 00:05 Europe/Warsaw and also once at server start (catch-up). For each schedule with
@@ -549,6 +584,8 @@ signs out other sessions.
   since." (or "Can't redo: …"); an empty stack → 409 `nothing_to_undo` / `nothing_to_redo`.
 - **Unconfirmed changes to reconciled transactions** → HTTP 409 `confirm_reconciled`; the UI asks and resends with
   `confirmReconciled: true`.
+- **Reconcile mismatch** (statement ≠ cleared balance, no adjustment asked for) → HTTP 422 `reconcile_mismatch` with
+  `difference` = statement − cleared, in the account's minor units.
 - **Auth failures** → 401 (no session) or 429 (rate limited / locked).
 - **Unexpected errors** → 500 with a generic message. The server logs details with pino (JSON to stdout, including a
   request ID); the UI shows a toast with Retry.
PATCH
```

- [ ] **Step 2: Run the final checks**

Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  60 passed (60)`, `Tests  508 passed (508)` (the baseline plus 8 files and 43 tests); both checks exit 0.
Run: `npm run db:generate -- --name check && npm run build`
Expected: `No schema changes, nothing to migrate 😴`, then esbuild's `Done`.

- [ ] **Step 3: Commit**

```bash
git add docs
git commit -m "docs: P2d1 FX, reconcile and loans decisions" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Spec coverage (P2d1)

| Spec | Task |
|---|---|
| §2 config: `NBP_BASE_URL` | 1 |
| §4.5 `fx_rate` cache (`source`, `effective_date`) | 1 |
| §9 NBP table A mid, 7-day fallback, cache, 5 s timeout; §13 "never blocks a save" | 1, 3 |
| §9 default rate on writes, manual override, re-fetch on a date change, split lines, cross-currency transfers | 2, 3 |
| §9 unsupported currency or NBP down → the rate is required | 2, 3, 4, 5 |
| §9 "≈ X zł" at the latest rate; Revalue (amount 0, base = difference, RTA or none); §14 golden 11 | 4 |
| §10 "Reconcile flow"; §9 native amounts; reconciled rows keep needing confirmation | 5 |
| §8 interest and escrow in months with a payment, overrides, balances everywhere | 6, 7 |
| §8 synthetic register rows, editing the interest row; §14 golden 9 | 7 |
| §8 payoff projection ("Never", 1200 months) and the Record-payment shortcut; §11 loan panel | 8 |
| §6 debt targets: balance before m with charges, foreign minimum payment and escrow in PLN | 6, 8 |
| §11 Accounts (PLN totals, native balances, Revalue button data), Register header | 4, 6 |

## Decisions

Choices made where the spec is silent, ambiguous or in conflict with the brief:

1. **`FxRates` contract** exactly as agreed with P2d2. `quote` never throws; PLN and malformed codes are null without a request. One `AbortSignal.timeout(5 s)` covers a whole quote, all fallback steps included, so a quote never waits longer than 5 s.
2. **Fallback:** the date and up to 7 earlier days, i.e. 8 requests at most; only a 404 steps back. A 400/500, a malformed body or a network error ends the quote with null, logged at warn.
3. **Cache only final rates:** published on the day asked for, or a past day, or a weekend (NBP never publishes then). Today's fallback to yesterday before NBP's noon publication isn't cached, so later quotes pick up today's table. No negative cache (carried over).
4. **Where rates are quoted:** always before `runCommand` or the read transaction. Transactions use a dry run of the planner (Task 3) so the rules for which rate a write needs live in one place (P2c's planner); a race between the dry run and the command can only end in `fx_rate_required`, never in a wrong rate. Account creation, Revalue and the reconcile adjustment know their currency and date up front and quote directly.
5. **`fx_rate_manual`:** true exactly when the user sent the rate; NBP rates are false; rows without a rate are false.
6. **Future-dated creates** (one-time schedules) never quote NBP and never fail for a missing rate: without `fxRate` they store `fx_rate = null`, `fx_rate_manual = false`, and P2d2's job quotes the occurrence date's NBP rate when it enters them. A sent rate is stored as manual. `GET /api/fx/rates` refuses future dates for the same reason.
7. **Edits** keep the stored rate; a sent `fxRate` replaces it (manual); a new date replaces an NBP rate with that day's and rebooks splits and transfer sides, while a manual rate stays. Bulk edits never change dates and use stored rates only.
8. **Account creation** books a foreign starting balance at the NBP rate of its date when no rate is sent; 422 `fx_rate_required` when NBP has none (even for a 0 balance, for consistency with transactions).
9. **Latest rate** = today's quote with the normal fallback. Account responses quote each foreign currency once per request, in parallel, before reading; closed accounts are included. `latestRate`/`balanceAtLatestRate` are null when there is no rate, and in DTOs built inside commands (none are returned from there). The register header keeps only `balance`/`balanceBase`.
10. **Revalue** takes an optional manual `fxRate` (an unsupported currency could never be revalued otherwise) and uses the same latest rate the account shows, so it books exactly `balanceAtLatestRate − balanceBase.working`. Refused for PLN (`revalue_pln`), closed accounts (`account_closed`, as closed accounts take no new rows) and a zero difference (`revalue_no_difference`). The row is inserted directly, not planned (amount 0 with a base ≠ 0); its `fx_rate` is the rate used. Edits may change only memo, flag, cleared and approved (`revaluation_fixed`), since planning would recompute its base to 0; deleting takes it back.
11. **Reconcile** compares native cleared balances (`balance.cleared`, which for loans includes the charges of months whose payments are cleared, decision 13). `reconcile_mismatch` is a 422 carrying `difference` (statement − cleared); `ApiErrorBody` gains the optional field. The adjustment is planned like any transaction (with `PlanContext.systemPayee`), so its category and FX follow §5.5 and §9; its NBP rate is quoted only when an adjustment will be made. Reconciling with nothing to change still records the reconciliation time (one undo entry). Closed accounts are refused.
12. **Loan math runs in the loan's currency.** A foreign loan's interest and escrow are converted to PLN at the rate the month's payments were booked at (Σ payment base / Σ payment amount), so the payment's PLN value splits like its native one and no NBP call is needed.
13. **Synthetic charges follow their payments' cleared status.** A month's interest and escrow are cleared iff every payment in that month (an inflow without a system payee) is cleared or reconciled; while any of them is uncleared, so are the charges. `loanCharges` returns the cleared and uncleared parts, and the accounts list, register header and reconcile add each to its bucket, so entering an uncleared payment never moves the cleared balance and a statement without that payment still matches. (A second, uncleared payment in a month whose first is cleared moves the month's charges back to uncleared until it clears.) The working balance counts all charges, and so do close (a loan can't close while interest is owed), Revalue and debt targets (`balanceAtMonthStart` before m, `balanceAtMonthEnd` through m). Credit cards with an APR get no synthetic interest (spec §8 is about loans).
14. **Synthetic register rows** come from `GET /api/accounts/:id/loan`, dated `chargedOn` (the month's first payment). The register's cursor paging is untouched; the UI interleaves the rows by date. Each month's `chargesCleared` says whether its rows are cleared, by decision 13's rule (true in a month without a payment).
15. **Interest overrides** are in the loan's currency, 0 … 10^13, for months from the first live transaction to the current month. A month without a payment keeps its override unused. Deleting a missing override is 404, like deleting a missing target. A loan with overrides counts as in use for account deletion (P2b1's rule), so it is closed instead.
16. **Loan panel** is part of the month view (`BudgetCategoryDto.loan`) because it needs the month's target need. The projection's payment is a `fixed`/`payoff_by_date` target's need, else the minimum payment (min-payment targets project at the native minimum payment, so a foreign loan's projection needs no conversion then). It starts this month, or next month when this month's payment is in. "Last-used cash account" = the open cash account of the latest transfer into the loan, else the first open cash account; the amount is −need in PLN.
17. **Foreign cards and loans in debt targets:** `min_payment` and `escrow_amount` are converted at the latest NBP rate quoted before the month view or auto-assign (only for currencies of foreign linked accounts). Without a rate they count as 0 and non-`fixed` debt targets are `incomplete`. The card's "Need X to pay in full" already used PLN base balances.
18. **No migration and no engine change:** every table exists, and the engine's `revaluationDiff`, `computeLoanMonths` and `projectPayoff` are used as they are.
19. **No interest in a loan's first month**, even with a payment in it: spec §8 taken literally, as the balance at the start of that month is 0 (the starting balance is one of its transactions); escrow is still charged. The behaviour is kept; the user can add an interest override for that month. Task 9 documents it in spec §8.
