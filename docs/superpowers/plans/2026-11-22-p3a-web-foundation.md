# P3a — Web App Foundation, Auth Screens and Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The phone web app's foundation: a Vite + React 19 PWA in `src/web` that the server serves (SPA fallback, cache headers, the unchanged strict CSP), with the app shell (bottom navigation, Undo/Redo, toasts with Undo, offline banner), a typed data layer over the Hono RPC client, the formatting utilities, the amount keypad and a small component kit, the first-run setup wizard, sign-in, and Settings. Plus the P3 auth items from the carry-over: each authenticator code works once, setup-token guesses are rate-limited, 429s say when to retry, sign-ins queue without holding database connections, `/status` refreshes the cookie and a stale cookie is cleared. A Playwright smoke test runs setup → sign-in → Settings → sign-out against the built app.

**Architecture:** The web app is a single-page app under `src/web` with its own tsconfig (DOM lib, JSX). It talks to the server only through `hc<App>` (the server's route types, imported with `import type`; ESLint keeps runtime imports out) and `unwrap()`, which turns any non-2xx response into an `ApiError` with the spec §13 fields. Server state lives in TanStack Query: after every command, undo or redo every budget-data query is invalidated (no optimistic updates), and any 401 sends the user to sign in. TanStack Router holds the route tree; guards read the cached `GET /api/auth/status`. The server serves `dist/web` from a catch-all GET outside the typed route chain, so the `App` type keeps only `/api` routes. vite-plugin-pwa writes the manifest and a Workbox service worker that precaches the build and never touches `/api`. The strict CSP stays as it is: the service worker is registered from the bundle, zod runs `jitless`, and the TOTP QR code is inline SVG.

**Tech Stack:** Node 22, TypeScript 6, Hono 4 (+ `hono/client`), zod 4, Drizzle ORM 0.45, Postgres 16, Vitest 5, @testcontainers/postgresql 11 (existing). New dev dependencies (the browser bundle and its tooling; the runtime image still installs only `dependencies`): Vite 8, @vitejs/plugin-react 6, React 19.3 + react-dom, Tailwind CSS 4.3 + @tailwindcss/vite, vite-plugin-pwa 2 (Workbox 7), @tanstack/react-query 5, @tanstack/react-router 1.170, qrcode 1.5 (+ @types/qrcode), eslint-plugin-react-hooks 7, jsdom 29, Testing Library (dom 10, react 16, jest-dom 8, user-event 14), @types/react 19, @playwright/test 1.65. All are MIT except Playwright (Apache-2.0), and every one supports Node 22.14 (the strictest need `^22.12` or `^22.13`). One migration (`totp_last_step`).

**Spec:** `docs/superpowers/specs/2026-11-19-core-budgeting-design.md` (§1, §2 web stack and config, §4.1 `app_user`, §11 bottom navigation, Settings and Offline, §12, §13, §14 Web, §15). P3a follows P2d2 (scheduled transactions, export, ops hardening) and precedes P3b (the Budget screen) and P3c (accounts, register, transactions, Scheduled, Payees), which build on the conventions it sets.

**Starting point and reconciling deltas:** Every code block below was verified against the P2d prototype base at ee9007b (`main` with P1, P2a and P2b1, plus the P2c tasks and the P2b2 branch), whose suite is `Test Files  52 passed (52)`, `Tests  465 passed (465)`. **Branch from `main` after P2b2, P2c, P2d1 and P2d2 have merged.** The server APIs grew in P2d, but the auth, settings and budget routes this plan touches are stable. Where a patch doesn't apply, **reconcile the small delta by hand**: keep what landed and apply this plan's intent. Add the test files and tests P2d1 and P2d2 (and their review fixes) added to every expected total below; the totals here are the p2d-base baseline (52 / 465) plus this plan's changes. Known touch points:
- **P2d2's JSON export (do this in Task 1):** add `'totpLastStep'` to the `app_user` entry's `omit` list in `src/server/export/export.ts` (it is sign-in state, like the secrets the export leaves out). P2d2's export test pins the exported `app_user` keys, so it fails until you do.
- Task 1's migration: P2d1 and P2d2 add none, so it should be `0004_totp_last_step.sql`; if `main` has another 0004 by then, drizzle-kit takes the next number. Nothing refers to the number.
- `src/server/config.ts`, `config.test.ts`, `src/server/test/config.ts` (Task 4 adds `webDir`): P2d1 adds `nbpBaseUrl` next to it.
- `src/server/http/app.ts` (Task 4): P2d1 and P2d2 mount `/api/fx`, `/api/scheduled` and `/api/export`; keep `app.get('*', serveWeb(…))` after the whole route chain and before `notFound`.
- `src/server/http/errors.ts`, `src/server/db/errors.ts` (Task 2): P2d2 adds the unstorable-text mapping; keep both changes.
- `src/server/main.ts` (P2d2's `runServer`) is not touched; the end-to-end setup starts `dist/server/main.js` as Docker does.
- `package.json` / `package-lock.json`: run the `npm install` commands as given. The lockfile then also holds what P2d added (croner), so it won't be byte-equal to this plan's prototype.
- README, the spec and both notes files (Task 10): append next to P2d1's and P2d2's sections; the README status line replaces P2d2's.
- Server tests that sign in or re-authenticate more than once with an authenticator code must take a fresh code for each attempt (Task 1's `freshTotpCode`). P2d1 and P2d2 tests only sign in through `setUpBudget`, so they are unaffected.

## Global Constraints

Inherited from P2a–P2d:
- Node `>=22`, npm, ESM. This machine has Node 22.14, so `@testcontainers/postgresql` must stay on `^11.14` (v12 pulls undici 8, which needs Node ≥ 22.19).
- TypeScript `strict` + `noUncheckedIndexedAccess`; `npm test`, `npm run typecheck` and `npm run lint` pass at the end of every task.
- Money is integer minor units (safe integers); calendar dates are `'YYYY-MM-DD'`; months are `'YYYY-MM'` in the engine and the web app.
- `src/engine/**` stays pure (no I/O, no Node modules, no `Date.now()`/`new Date()`/`Math.random()`).
- Error responses (spec §13): validation → 400 `{ code: "validation", message, fieldErrors, formErrors }` keyed by the dotted field path; `DomainError` → 422 `{ code, message }` (plus `fieldErrors` when it names a field); undo conflicts → 409; no session → 401 `unauthorized`; rate limited → 429; unexpected → 500 `{ code: "internal", … }`.
- Every mutating `/api` request must carry `X-Requested-With: budget-track` (403 `csrf` otherwise). GETs need no header.
- Every commit message ends with the trailer `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.
- Every router outside `/api/auth` is mounted on its own prefix and starts with `.use('*', requireSession(deps))`; this plan adds no `/api` route.
- Advisory-lock keys: 727274001 sign-in and re-authentication, 727274002 commands and undo/redo.
- Server tests: `createTestDatabase()`, `createTestApp(db, { now, config })`, `setUpBudget(ctx)`, `TestClient(app, ip)`.
- Patches are `git apply <<'PATCH' … PATCH` commands run from the repository root (making the same edits by hand is equivalent).

New in P3a (the web conventions; Task 10 writes them into `engineering-notes.md` under "Web app"):
- **Boundaries.** `src/web` imports only types from `src/server` (`import type`), and no Node modules or globals; `src/server` and `src/shared` never import `src/web`; `src/shared` never imports `src/server`. The root tsconfig covers everything except `src/web`; `src/web/tsconfig.json` adds the DOM lib and JSX; `npm run typecheck` runs both.
- **API calls** go through `api` (`hc<App>`) and `unwrap()` (`src/web/lib/api.ts`), never `fetch` directly; failures are `ApiError`. The JSON export is the one plain link (`<a href="/api/export" download>`).
- **Query cache.** Keys are `[area, ...params]`; the `auth` area holds only the auth status. No optimistic updates: undoable commands run through `useCommand`, which invalidates every non-auth query and toasts the undo label with Undo. A 401 `unauthorized` anywhere opens `/login?redirect=…`.
- **Forms** show `formErrorsOf(error, fields)`: field messages by dotted path under their fields, the rest in `<FormError>` above the submit button.
- **Offline.** Every control that sends a request is disabled while offline (`<Button mutating>` or `useOnline()`).
- **Display.** Amounts with `formatMoney`/`formatAmount` (`1 234,56 zł`, no-break spaces), dates with `formatDate`/`parseDate` (dd.MM.yyyy), months with `formatMonth`; amounts are entered with `AmountKeypad`.
- **CSP.** No inline scripts or `<style>` elements, no `eval` (zod `jitless`), no `data:` images (inline SVG), no other origins.
- **Web tests** run in the Vitest `web` project (jsdom) with Testing Library, a fake `fetch` (`fakeApi`) and `renderApp(path)`; the end-to-end test is `npm run test:e2e` (not part of `npm test`).

## File Structure

```
src/web/index.html, main.tsx, styles.css     Vite root and entry (zod jitless, service worker registration, <App/>), Tailwind theme
src/web/tsconfig.json                         the browser tsconfig (DOM lib, JSX)
src/web/app.tsx, router.tsx                   App (query client, toasts, router); route tree, guards, safeRedirect
src/web/zod-jitless.ts                        z.config({ jitless: true }) for the CSP
src/web/lib/format.ts                         formatAmount, formatMoney, formatDate, parseDate, formatMonth, formatMonthShort, NBSP
src/web/lib/api.ts                            api (hc<App>), ApiError, unwrap, OkBody, isUnauthorized, isTransient
src/web/lib/form-errors.ts                    FormErrors, formErrorsOf, zodFormErrors, NO_ERRORS
src/web/lib/online.ts                         useOnline
src/web/lib/query.ts                          queryKeys, authStatusQuery, createQueryClient, invalidateData, forgetSession
src/web/lib/commands.ts                       undoStateQuery, useUndoRedo, useCommand, errorMessage
src/web/lib/amount-expression.ts              evaluateAmount, amountToExpression, formatExpression, OPERATORS
src/web/ui/                                   button, field (TextField, Checkbox, SegmentedControl, FormError), pill, sheet, toast,
                                              amount-keypad, icons, cx
src/web/shell/                                app-shell (AppShell, AuthLayout), bottom-nav, undo-redo, offline-banner, screens
src/web/auth/                                 auth-api, setup-screen, login-screen, totp-qr, recovery-codes
src/web/settings/                             settings-screen, security-forms
src/web/test/                                 setup, fake-api (fakeApi, json), render (renderApp, renderWithProviders, SIGNED_IN)
src/web/public/                               icon.svg, icon-192.png, icon-512.png, apple-touch-icon.png (generated)
src/server/http/web.ts                        serveWeb: static files, SPA fallback, cache headers
src/server/test/web-fixture/                  a tiny "build" for the serving tests
scripts/generate-icons.ts                     writes the icons (npm run icons)
vite.config.ts, playwright.config.ts          Vite (React, Tailwind, PWA, dev proxy); Playwright (chromium, 390×844)
e2e/env.ts, global-setup.ts, smoke.spec.ts    the end-to-end smoke test (Testcontainers Postgres + built server)
drizzle/0004_totp_last_step.sql               app_user.totp_last_step

Modified: src/server/auth/{totp,second-factor,login-routes,security-routes,setup-routes,rate-limit,sessions}.ts,
src/server/db/{schema,errors}.ts, src/server/http/{app,errors}.ts, src/server/config.ts, src/server/test/{totp,config}.ts,
src/shared/auth.ts, eslint.config.js, tsconfig.json, vitest.config.ts, package.json, Dockerfile, .gitignore, .env.example,
README.md, the spec and both notes files

Tests: src/server/auth/{totp,second-factor,login-routes,security-routes,setup-routes,rate-limit,sessions}.test.ts,
src/shared/auth.test.ts, src/server/lint-boundaries.test.ts, src/server/http/web.test.ts, src/server/config.test.ts;
src/web/lib/{format,api,form-errors,online,query,amount-expression,commands}.test.*, src/web/ui/{amount-keypad,kit,sheet,toast}.test.tsx,
src/web/app.test.tsx, src/web/auth/{login-screen,setup-screen,totp-qr,recovery-codes}.test.tsx,
src/web/settings/settings-screen.test.tsx; e2e/smoke.spec.ts
```

## Screens and routes added in P3a

| Path | Screen | Guard |
|---|---|---|
| `/setup` | Setup wizard: token → password → authenticator (QR + key) → recovery codes | only while setup is required; otherwise to `/budget` or `/login` |
| `/login?redirect=…` | Sign-in: password + authenticator code or recovery code | not after setup is done and signed in (→ `/budget`) |
| `/` | – | → `/budget` |
| `/budget`, `/accounts`, `/transactions/new`, `/scheduled`, `/payees` | placeholders inside the shell (P3b, P3c) | signed in (→ `/login?redirect=…`; → `/setup` before setup) |
| `/more` | Scheduled · Payees · Settings | signed in |
| `/settings` | Change password, change authenticator app, new recovery codes, JSON export, sign out, sign out everywhere | signed in |

Server changes to existing routes: `POST /api/auth/login`, `/password`, `/totp`, `/recovery-codes` refuse an authenticator code from a step at or before the last accepted one (401 `invalid_credentials` / 422 `invalid_credentials`); `POST /api/auth/setup/totp` and `/setup` count a wrong token as a failed sign-in (429 after 5 per minute per IP); every 429 has `Retry-After`; a busy login lock is 503 `busy` with `Retry-After: 1`; `GET /api/auth/status` refreshes the session cookie and clears a stale one, as every 401 now does. Any other GET outside `/api` serves the web app.

---
### Task 1: Each authenticator code works once; rate-limit setup-token guesses

Carry-over "P3: TOTP replay protection" and "P3: rate-limit setup-token attempts"; spec §12. `verifyTotp` returns the RFC 6238 time step a code belongs to (or null), and `app_user.totp_last_step` stores the step of the newest accepted code: a code is accepted only from a later step, so a code seen over someone's shoulder can't be used again, not even inside the ±1 step window. Every passed check stores what it used up with `spentFactor(user, result)` (the recovery codes left and the newest step), in the same transaction as the sign-in or the settings change. The codes that confirm setup and a new authenticator are used up too, so they can't sign in afterwards.

`POST /api/auth/setup/totp` and `/setup` now check the setup token inside `withLoginLock`: a wrong token is recorded as a failed sign-in attempt, so the per-IP limit (5 per minute) and the lockout stop guessing as they stop password guessing. The server tests that sign in more than once take each code from the next step with `freshTotpCode(secret, clock)`, which moves the fake clock on 30 s.

**With P2d2 merged:** add `'totpLastStep'` to `app_user`'s `omit` list in `src/server/export/export.ts` now (see the header); P2d2's export test then passes unchanged.

**Files:**
- Create: `drizzle/0004_totp_last_step.sql` (generated)
- Modify: `src/server/db/schema.ts`, `src/server/auth/totp.ts`, `src/server/auth/second-factor.ts`, `src/server/auth/login-routes.ts`, `src/server/auth/security-routes.ts`, `src/server/auth/setup-routes.ts`, `src/server/test/totp.ts`
- Test: `src/server/auth/totp.test.ts`, `src/server/auth/second-factor.test.ts`, `src/server/auth/login-routes.test.ts`, `src/server/auth/security-routes.test.ts`, `src/server/auth/setup-routes.test.ts`

**Interfaces:**
- Consumes: `verify` (otplib), `withLoginLock`, `recordLoginAttempt` (`rate-limit.ts`), `appUser`.
- Produces:
  - `app_user.totp_last_step` (`appUser.totpLastStep: number | null`).
  - `verifyTotp(secret, code, now): Promise<number | null>` (the time step, or null).
  - `SecondFactorResult.totpStep?`; `verifySecondFactor` refuses a step `<= user.totpLastStep`; `spentFactor(user, result)` → `{ recoveryCodeHashes, totpLastStep }`.
  - Test helpers: `TOTP_STEP_MS`, `freshTotpCode(secret, clock)` (`src/server/test/totp.ts`).

- [ ] **Step 1: Write the failing tests**

```bash
git apply <<'PATCH'
diff --git a/src/server/auth/login-routes.test.ts b/src/server/auth/login-routes.test.ts
index f0e2cd3..db0d010 100644
--- a/src/server/auth/login-routes.test.ts
+++ b/src/server/auth/login-routes.test.ts
@@ -5,7 +5,7 @@ import { createTestApp, type TestApp } from '../test/app';
 import { type SetupResult, setUpBudget, TEST_PASSWORD } from '../test/auth';
 import { createTestDatabase, type TestDatabase } from '../test/db';
 import { TestClient } from '../test/http-client';
-import { totpCode } from '../test/totp';
+import { freshTotpCode, totpCode } from '../test/totp';
 import { RECOVERY_CODE_COUNT } from './recovery-codes';
 import { SESSION_COOKIE } from './sessions';
 
@@ -34,8 +34,9 @@ async function login(client: TestClient, body: Record<string, unknown>) {
   return { status: res.status, body: (await res.json()) as Record<string, unknown> };
 }
 
+/** The password with a code from the next TOTP step (the clock moves on 30 s, so each call gives an unused code). */
 async function withCode(password = TEST_PASSWORD) {
-  return { password, totpCode: await totpCode(setup.totpSecret, ctx.clock.now()) };
+  return { password, totpCode: await freshTotpCode(setup.totpSecret, ctx.clock) };
 }
 
 describe('POST /api/auth/login', () => {
@@ -56,6 +57,24 @@ describe('POST /api/auth/login', () => {
     expect(client.cookie(SESSION_COOKIE)).toBeUndefined();
   });
 
+  it('accepts each authenticator code once', async () => {
+    const body = await withCode();
+    expect((await login(new TestClient(ctx.app), body)).status).toBe(200);
+    expect(await login(new TestClient(ctx.app, '198.51.100.20'), body)).toEqual({
+      status: 401,
+      body: { code: 'invalid_credentials', message: 'Wrong password or code.' },
+    });
+    // A code from the step before the one just used is still inside the ±1 step window, but older.
+    const older = await totpCode(setup.totpSecret, new Date(ctx.clock.now().getTime() - 30_000));
+    expect((await login(new TestClient(ctx.app, '198.51.100.21'), { password: TEST_PASSWORD, totpCode: older })).status).toBe(401);
+    expect((await login(new TestClient(ctx.app, '198.51.100.22'), await withCode())).status).toBe(200);
+  });
+
+  it('refuses the authenticator code that confirmed setup', async () => {
+    const setupCode = await totpCode(setup.totpSecret, ctx.clock.now());
+    expect((await login(new TestClient(ctx.app), { password: TEST_PASSWORD, totpCode: setupCode })).status).toBe(401);
+  });
+
   it('accepts each recovery code once', async () => {
     const client = new TestClient(ctx.app);
     const code = setup.recoveryCodes[3]!;
diff --git a/src/server/auth/second-factor.test.ts b/src/server/auth/second-factor.test.ts
index 84f5d65..175cc08 100644
--- a/src/server/auth/second-factor.test.ts
+++ b/src/server/auth/second-factor.test.ts
@@ -1,12 +1,13 @@
 import { describe, expect, it } from 'vitest';
 import { totpCode } from '../test/totp';
-import { verifySecondFactor } from './second-factor';
+import { spentFactor, verifySecondFactor } from './second-factor';
 import { encryptSecret } from './secret-box';
+import { verifyTotp } from './totp';
 
 const key = Buffer.alloc(32, 5);
 const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
 const now = new Date('2026-11-20T10:00:00Z');
-const user = { totpSecretEnc: encryptSecret(secret, key), recoveryCodeHashes: [] };
+const user = { totpSecretEnc: encryptSecret(secret, key), recoveryCodeHashes: [], totpLastStep: null };
 
 describe('verifySecondFactor', () => {
   it('fails when no second factor is given', async () => {
@@ -14,4 +15,22 @@ describe('verifySecondFactor', () => {
     expect(await verifySecondFactor(user, { totpCode: code }, now, key)).toMatchObject({ ok: true });
     expect(await verifySecondFactor(user, {}, now, key)).toEqual({ ok: false, remainingRecoveryHashes: [] });
   });
+
+  it('accepts each authenticator code once: only codes from a step after the last one used', async () => {
+    const code = await totpCode(secret, now);
+    const step = (await verifyTotp(secret, code, now))!;
+    const fresh = await verifySecondFactor({ ...user, totpLastStep: step - 1 }, { totpCode: code }, now, key);
+    expect(fresh).toEqual({ ok: true, totpStep: step, remainingRecoveryHashes: [] });
+    for (const totpLastStep of [step, step + 1]) {
+      expect(await verifySecondFactor({ ...user, totpLastStep }, { totpCode: code }, now, key)).toEqual({
+        ok: false,
+        remainingRecoveryHashes: [],
+      });
+    }
+    expect(spentFactor({ totpLastStep: step - 1 }, fresh)).toEqual({ recoveryCodeHashes: [], totpLastStep: step });
+    expect(spentFactor({ totpLastStep: 7 }, { ok: true, remainingRecoveryHashes: ['x'] })).toEqual({
+      recoveryCodeHashes: ['x'],
+      totpLastStep: 7,
+    });
+  });
 });
diff --git a/src/server/auth/security-routes.test.ts b/src/server/auth/security-routes.test.ts
index e6ce784..2ee6ab3 100644
--- a/src/server/auth/security-routes.test.ts
+++ b/src/server/auth/security-routes.test.ts
@@ -5,7 +5,7 @@ import { createTestApp, type TestApp } from '../test/app';
 import { type SetupResult, setUpBudget, TEST_PASSWORD } from '../test/auth';
 import { createTestDatabase, type TestDatabase } from '../test/db';
 import { TestClient } from '../test/http-client';
-import { totpCode } from '../test/totp';
+import { freshTotpCode, totpCode } from '../test/totp';
 import { verifyPassword } from './passwords';
 import { decryptSecret } from './secret-box';
 import { SESSION_COOKIE } from './sessions';
@@ -31,11 +31,12 @@ async function call(client: TestClient, path: string, body?: unknown) {
 
 async function signIn(ip: string, password = TEST_PASSWORD, secret = setup.totpSecret) {
   const client = new TestClient(ctx.app, ip);
-  const res = await client.post('/api/auth/login', { password, totpCode: await totpCode(secret, ctx.clock.now()) });
+  const res = await client.post('/api/auth/login', { password, totpCode: await freshTotpCode(secret, ctx.clock) });
   return { client, status: res.status };
 }
 
-const code = () => totpCode(setup.totpSecret, ctx.clock.now());
+/** An unused code from the current authenticator (the clock moves on one 30 s step). */
+const code = () => freshTotpCode(setup.totpSecret, ctx.clock);
 
 async function storedUser() {
   const [user] = await t.db.select().from(appUser);
@@ -111,19 +112,36 @@ describe('POST /api/auth/password', () => {
     expect(await isSignedIn(ctx.client)).toBe(true);
   });
 
+  it('refuses an authenticator code that was already used', async () => {
+    const totpCode = await code();
+    expect((await call(ctx.client, '/api/auth/recovery-codes', { currentPassword: TEST_PASSWORD, totpCode })).status).toBe(200);
+    const res = await call(ctx.client, '/api/auth/password', {
+      currentPassword: TEST_PASSWORD,
+      newPassword: NEW_PASSWORD,
+      totpCode,
+    });
+    expect(res).toEqual({
+      status: 422,
+      body: { code: 'invalid_credentials', message: 'Your current password or code is wrong.' },
+    });
+    expect(await verifyPassword((await storedUser()).passwordHash, TEST_PASSWORD)).toBe(true);
+  });
+
   it('limits re-authentication to 5 attempts per minute per IP', async () => {
+    // One code for every attempt, so the clock stays inside the minute (a failed attempt doesn't use the code up).
+    const totpCode = await code();
     for (let i = 0; i < 5; i++) {
       const res = await call(ctx.client, '/api/auth/password', {
         currentPassword: 'guess',
         newPassword: NEW_PASSWORD,
-        totpCode: await code(),
+        totpCode,
       });
       expect(res.status).toBe(422);
     }
     const res = await call(ctx.client, '/api/auth/password', {
       currentPassword: TEST_PASSWORD,
       newPassword: NEW_PASSWORD,
-      totpCode: await code(),
+      totpCode,
     });
     expect(res).toEqual({
       status: 429,
@@ -158,6 +176,23 @@ describe('authenticator rotation', () => {
     expect((await signIn('198.51.100.4', TEST_PASSWORD, setup.totpSecret)).status).toBe(401);
   });
 
+  it("uses up the new authenticator's confirmation code", async () => {
+    const secret = await newSecret();
+    const confirmation = await totpCode(secret, ctx.clock.now());
+    const res = await call(ctx.client, '/api/auth/totp', {
+      currentPassword: TEST_PASSWORD,
+      recoveryCode: setup.recoveryCodes[4],
+      totpSecret: secret,
+      totpCode: confirmation,
+    });
+    expect(res.status).toBe(200);
+    const login = await new TestClient(ctx.app, '198.51.100.9').post('/api/auth/login', {
+      password: TEST_PASSWORD,
+      totpCode: confirmation,
+    });
+    expect(login.status).toBe(401);
+  });
+
   it('keeps the old secret if the confirmation code is wrong', async () => {
     const res = await call(ctx.client, '/api/auth/totp', {
       currentPassword: TEST_PASSWORD,
diff --git a/src/server/auth/setup-routes.test.ts b/src/server/auth/setup-routes.test.ts
index 59159be..18de4ff 100644
--- a/src/server/auth/setup-routes.test.ts
+++ b/src/server/auth/setup-routes.test.ts
@@ -61,6 +61,20 @@ describe('POST /api/auth/setup/totp', () => {
     expect(res).toEqual({ status: 403, body: { code: 'invalid_setup_token', message: 'That setup token is not correct.' } });
   });
 
+  it('limits setup-token guesses like sign-ins: 5 per minute per IP', async () => {
+    for (let i = 0; i < 5; i++) {
+      expect((await ctx.client.post('/api/auth/setup/totp', { setupToken: `guess ${i}` })).status).toBe(403);
+    }
+    const limited = await ctx.client.post('/api/auth/setup/totp', { setupToken: TEST_SETUP_TOKEN });
+    expect(await json(limited)).toEqual({
+      status: 429,
+      body: { code: 'rate_limited', message: 'Too many sign-in attempts. Wait a minute and try again.' },
+    });
+    expect((await new TestClient(ctx.app, '198.51.100.30').post('/api/auth/setup/totp', { setupToken: TEST_SETUP_TOKEN })).status).toBe(200);
+    ctx.clock.advance(60_001);
+    expect((await ctx.client.post('/api/auth/setup/totp', { setupToken: TEST_SETUP_TOKEN })).status).toBe(200);
+  });
+
   it('returns a new authenticator secret and its otpauth URI', async () => {
     const res = await json(await ctx.client.post('/api/auth/setup/totp', { setupToken: TEST_SETUP_TOKEN }));
     expect(res.status).toBe(200);
diff --git a/src/server/auth/totp.test.ts b/src/server/auth/totp.test.ts
index c8e9305..477923c 100644
--- a/src/server/auth/totp.test.ts
+++ b/src/server/auth/totp.test.ts
@@ -2,8 +2,9 @@ import { describe, expect, it } from 'vitest';
 import { totpCode } from '../test/totp';
 import { newTotpSecret, totpUri, verifyTotp } from './totp';
 
-// 1_800_000_000 is a multiple of 30, so this instant starts a TOTP step.
+// 1_800_000_000 is a multiple of 30, so this instant starts a TOTP step (step 60 000 000).
 const stepStart = new Date(1_800_000_000 * 1000);
+const STEP = 60_000_000;
 const seconds = (n: number) => new Date(stepStart.getTime() + n * 1000);
 
 describe('totp', () => {
@@ -16,20 +17,21 @@ describe('totp', () => {
     expect(uri).toContain('issuer=Budget%20Track');
   });
 
-  it('accepts the current code and one step of drift, but not two', async () => {
+  it("accepts the current code and one step of drift, but not two, and returns the code's time step", async () => {
     const secret = newTotpSecret();
     const code = await totpCode(secret, stepStart);
-    expect(await verifyTotp(secret, code, stepStart)).toBe(true);
-    expect(await verifyTotp(secret, code, seconds(59))).toBe(true);
-    expect(await verifyTotp(secret, code, seconds(-30))).toBe(true);
-    expect(await verifyTotp(secret, code, seconds(60))).toBe(false);
-    expect(await verifyTotp(secret, code, seconds(-31))).toBe(false);
+    expect(await verifyTotp(secret, code, stepStart)).toBe(STEP);
+    expect(await verifyTotp(secret, code, seconds(59))).toBe(STEP);
+    expect(await verifyTotp(secret, code, seconds(-30))).toBe(STEP);
+    expect(await verifyTotp(secret, code, seconds(60))).toBeNull();
+    expect(await verifyTotp(secret, code, seconds(-31))).toBeNull();
+    expect(await verifyTotp(secret, await totpCode(secret, seconds(30)), stepStart)).toBe(STEP + 1);
   });
 
   it('rejects malformed codes and secrets without throwing', async () => {
     const secret = newTotpSecret();
-    expect(await verifyTotp(secret, '12345', stepStart)).toBe(false);
-    expect(await verifyTotp(secret, 'abcdef', stepStart)).toBe(false);
-    expect(await verifyTotp('not base32!', '123456', stepStart)).toBe(false);
+    expect(await verifyTotp(secret, '12345', stepStart)).toBeNull();
+    expect(await verifyTotp(secret, 'abcdef', stepStart)).toBeNull();
+    expect(await verifyTotp('not base32!', '123456', stepStart)).toBeNull();
   });
 });
diff --git a/src/server/test/totp.ts b/src/server/test/totp.ts
index dc7b5d3..302f3cb 100644
--- a/src/server/test/totp.ts
+++ b/src/server/test/totp.ts
@@ -1,6 +1,18 @@
 import { generate } from 'otplib';
+import type { FakeClock } from './fake-clock';
+
+export const TOTP_STEP_MS = 30_000;
 
 /** The 6-digit code an authenticator app would show for `secret` at `at`. */
 export function totpCode(secret: string, at: Date): Promise<string> {
   return generate({ secret, epoch: Math.floor(at.getTime() / 1000) });
 }
+
+/**
+ * Moves `clock` on by one TOTP step and returns the code for the new time. Each accepted code must come from a newer
+ * step than the last one (replay protection), so tests that sign in more than once use this.
+ */
+export function freshTotpCode(secret: string, clock: FakeClock): Promise<string> {
+  clock.advance(TOTP_STEP_MS);
+  return totpCode(secret, clock.now());
+}
PATCH
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run src/server/auth/totp.test.ts src/server/auth/second-factor.test.ts src/server/auth/login-routes.test.ts src/server/auth/security-routes.test.ts src/server/auth/setup-routes.test.ts`
Expected: FAIL — `Tests  8 failed | 43 passed (51)`: the two `totp` tests (`expected true to be 60000000`, `expected false to be null`), the `second-factor` test (no `totpStep`), the four replay tests (a used code still answers 200), and the setup-token limit (`expected { status: 200, … } to deeply equal { status: 429, … }`).

- [ ] **Step 3: Store the last accepted step**

```bash
git apply <<'PATCH'
diff --git a/src/server/db/schema.ts b/src/server/db/schema.ts
index 47afb25..48926a3 100644
--- a/src/server/db/schema.ts
+++ b/src/server/db/schema.ts
@@ -76,6 +76,8 @@ export const appUser = pgTable(
     passwordHash: text('password_hash').notNull(),
     totpSecretEnc: text('totp_secret_enc').notNull(),
     recoveryCodeHashes: text('recovery_code_hashes').array().notNull().default(sql`'{}'::text[]`),
+    /** RFC 6238 time step of the newest authenticator code accepted; codes from it or earlier steps are replays. */
+    totpLastStep: bigint('totp_last_step', { mode: 'number' }),
     baseCurrency: text('base_currency').notNull().default('PLN'),
     budgetStartMonth: day('budget_start_month').notNull(),
     ...timestamps,
PATCH
```

Run: `npm run db:generate -- --name totp_last_step`
Expected: drizzle-kit writes `drizzle/0004_totp_last_step.sql` (and its snapshot in `drizzle/meta/`):

```sql
ALTER TABLE "app_user" ADD COLUMN "totp_last_step" bigint;
```

- [ ] **Step 4: Return the time step, refuse replays, store what was used**

```bash
git apply <<'PATCH'
diff --git a/src/server/auth/second-factor.ts b/src/server/auth/second-factor.ts
index 07cd7a1..a8bf6c8 100644
--- a/src/server/auth/second-factor.ts
+++ b/src/server/auth/second-factor.ts
@@ -13,6 +13,8 @@ export interface SecondFactorResult {
   ok: boolean;
   /** The user's recovery code hashes without the one just used. Store them only if the whole sign-in succeeds. */
   remainingRecoveryHashes: string[];
+  /** The time step of the authenticator code that matched. Store it only if the whole sign-in succeeds. */
+  totpStep?: number;
 }
 
 /**
@@ -20,15 +22,17 @@ export interface SecondFactorResult {
  * call it even after a wrong password: the response time then doesn't reveal the password.
  */
 export async function verifySecondFactor(
-  user: Pick<AppUser, 'totpSecretEnc' | 'recoveryCodeHashes'>,
+  user: Pick<AppUser, 'totpSecretEnc' | 'recoveryCodeHashes' | 'totpLastStep'>,
   factor: SecondFactor,
   now: Date,
   encryptionKey: Buffer,
 ): Promise<SecondFactorResult> {
   const unchanged = { remainingRecoveryHashes: user.recoveryCodeHashes };
   if (factor.totpCode !== undefined) {
-    const ok = await verifyTotp(decryptSecret(user.totpSecretEnc, encryptionKey), factor.totpCode, now);
-    return { ok, ...unchanged };
+    const step = await verifyTotp(decryptSecret(user.totpSecretEnc, encryptionKey), factor.totpCode, now);
+    // Each code works once (RFC 6238 §5.2): a code from the step of the last accepted one, or earlier, is a replay.
+    if (step === null || step <= (user.totpLastStep ?? -1)) return { ok: false, ...unchanged };
+    return { ok: true, totpStep: step, ...unchanged };
   }
   if (factor.recoveryCode !== undefined) {
     const remaining = await consumeRecoveryCode(user.recoveryCodeHashes, factor.recoveryCode);
@@ -36,3 +40,11 @@ export async function verifySecondFactor(
   }
   return { ok: false, ...unchanged };
 }
+
+/** The columns to store once a check with `result` has passed: the unused recovery codes and the newest code's step. */
+export function spentFactor(
+  user: Pick<AppUser, 'totpLastStep'>,
+  result: SecondFactorResult,
+): Pick<AppUser, 'recoveryCodeHashes' | 'totpLastStep'> {
+  return { recoveryCodeHashes: result.remainingRecoveryHashes, totpLastStep: result.totpStep ?? user.totpLastStep };
+}
diff --git a/src/server/auth/totp.ts b/src/server/auth/totp.ts
index ae0ffdc..60dde3e 100644
--- a/src/server/auth/totp.ts
+++ b/src/server/auth/totp.ts
@@ -13,9 +13,12 @@ export function totpUri(secret: string): string {
   return generateURI({ issuer: TOTP_ISSUER, label: TOTP_LABEL, secret });
 }
 
-/** Spec §12: 30 s step, ±1 step of clock drift. False for malformed codes or secrets. */
-export async function verifyTotp(secret: string, code: string, now: Date): Promise<boolean> {
-  if (!/^\d{6}$/.test(code)) return false;
+/**
+ * Spec §12: 30 s step, ±1 step of clock drift. Returns the RFC 6238 time step the code belongs to (callers store it
+ * to refuse replays), or null for a wrong code and for malformed codes or secrets.
+ */
+export async function verifyTotp(secret: string, code: string, now: Date): Promise<number | null> {
+  if (!/^\d{6}$/.test(code)) return null;
   try {
     const result = await verify({
       secret,
@@ -23,8 +26,9 @@ export async function verifyTotp(secret: string, code: string, now: Date): Promi
       epoch: Math.floor(now.getTime() / 1000),
       epochTolerance: 30,
     });
-    return result.valid;
+    // verify() also covers HOTP, whose results have no time step.
+    return result.valid && 'timeStep' in result ? result.timeStep : null;
   } catch {
-    return false;
+    return null;
   }
 }
PATCH
```

```bash
git apply <<'PATCH'
diff --git a/src/server/auth/login-routes.ts b/src/server/auth/login-routes.ts
index afed24d..9919dc1 100644
--- a/src/server/auth/login-routes.ts
+++ b/src/server/auth/login-routes.ts
@@ -8,7 +8,7 @@ import { AppError } from '../http/errors';
 import { validate } from '../http/validate';
 import { verifyPassword } from './passwords';
 import { recordLoginAttempt, withLoginLock } from './rate-limit';
-import { verifySecondFactor } from './second-factor';
+import { spentFactor, verifySecondFactor } from './second-factor';
 import { clearSessionCookie, createSession, deleteSession, requireSession, setSessionCookie } from './sessions';
 import { findUser } from './user';
 
@@ -30,12 +30,7 @@ export function loginRoutes(deps: AppDeps) {
         await recordLoginAttempt(tx, ip, ok, now);
         if (!ok) return { ok: false };
 
-        if (body.recoveryCode !== undefined) {
-          await tx
-            .update(appUser)
-            .set({ recoveryCodeHashes: factor.remainingRecoveryHashes })
-            .where(eq(appUser.id, user.id));
-        }
+        await tx.update(appUser).set(spentFactor(user, factor)).where(eq(appUser.id, user.id));
         const { token } = await createSession(tx, now, c.req.header('user-agent'));
         return { ok: true, token, remaining: factor.remainingRecoveryHashes.length };
       });
diff --git a/src/server/auth/security-routes.ts b/src/server/auth/security-routes.ts
index 43ed603..6f6d18d 100644
--- a/src/server/auth/security-routes.ts
+++ b/src/server/auth/security-routes.ts
@@ -16,7 +16,7 @@ import { validate } from '../http/validate';
 import { hashPassword, verifyPassword } from './passwords';
 import { recordLoginAttempt, withLoginLock } from './rate-limit';
 import { generateRecoveryCodes, hashRecoveryCodes } from './recovery-codes';
-import { type SecondFactor, verifySecondFactor } from './second-factor';
+import { type SecondFactor, spentFactor, verifySecondFactor } from './second-factor';
 import { encryptSecret } from './secret-box';
 import { clearSessionCookie, deleteAllSessions, requireSession } from './sessions';
 import { newTotpSecret, totpUri, verifyTotp } from './totp';
@@ -47,11 +47,9 @@ export function securityRoutes(deps: AppDeps) {
       await recordLoginAttempt(tx, ip, ok, now);
       if (!ok) return { ok: false };
 
-      const recoveryCodeHashes = factor.remainingRecoveryHashes;
-      if (credentials.recoveryCode !== undefined) {
-        await tx.update(appUser).set({ recoveryCodeHashes }).where(eq(appUser.id, user.id));
-      }
-      return { ok: true, value: await apply(tx, { ...user, recoveryCodeHashes }, now) };
+      const spent = spentFactor(user, factor);
+      await tx.update(appUser).set(spent).where(eq(appUser.id, user.id));
+      return { ok: true, value: await apply(tx, { ...user, ...spent }, now) };
     });
     // Thrown after commit so the failed attempt stays recorded.
     if (!outcome.ok) throw new DomainError('invalid_credentials', 'Your current password or code is wrong.');
@@ -84,7 +82,8 @@ export function securityRoutes(deps: AppDeps) {
       const body = c.req.valid('json');
       // Checked first, so a typo here can't use up the recovery code below. The client sent the secret, so this check
       // reveals nothing and isn't a sign-in attempt.
-      if (!(await verifyTotp(body.totpSecret, body.totpCode, deps.clock.now()))) {
+      const newStep = await verifyTotp(body.totpSecret, body.totpCode, deps.clock.now());
+      if (newStep === null) {
         throw new DomainError('invalid_totp_code', "That code didn't match the new authenticator entry.");
       }
       // The current factor proves who is asking (a recovery code covers a lost phone).
@@ -94,9 +93,11 @@ export function securityRoutes(deps: AppDeps) {
         recoveryCode: body.recoveryCode,
       };
       await reauthenticated(deps.clientIp(c), credentials, async (tx, user) => {
+        // The confirmation code is used up too, so it can't sign in afterwards.
+        const totpLastStep = Math.max(newStep, user.totpLastStep ?? newStep);
         await tx
           .update(appUser)
-          .set({ totpSecretEnc: encryptSecret(body.totpSecret, deps.config.encryptionKey) })
+          .set({ totpSecretEnc: encryptSecret(body.totpSecret, deps.config.encryptionKey), totpLastStep })
           .where(eq(appUser.id, user.id));
         await deleteAllSessions(tx, { exceptId: c.var.session.id });
       });
PATCH
```

- [ ] **Step 5: Count wrong setup tokens as failed sign-ins**

```bash
git apply <<'PATCH'
diff --git a/src/server/auth/setup-routes.ts b/src/server/auth/setup-routes.ts
index ca4f947..312da45 100644
--- a/src/server/auth/setup-routes.ts
+++ b/src/server/auth/setup-routes.ts
@@ -17,6 +17,7 @@ import type { AppEnv } from '../http/env';
 import { AppError, DomainError } from '../http/errors';
 import { validate } from '../http/validate';
 import { hashPassword } from './passwords';
+import { recordLoginAttempt, withLoginLock } from './rate-limit';
 import { generateRecoveryCodes, hashRecoveryCodes } from './recovery-codes';
 import { encryptSecret } from './secret-box';
 import { createSession, currentSession, setSessionCookie } from './sessions';
@@ -37,11 +38,15 @@ const alreadySetUp = () => new AppError(409, 'already_setup', 'This budget is al
 
 /** Spec §12 first-run setup: only while no user exists, and only with SETUP_TOKEN from the environment. */
 export function setupRoutes(deps: AppDeps) {
-  async function assertSetupAllowed(setupToken: string): Promise<void> {
+  async function assertSetupAllowed(ip: string, setupToken: string): Promise<void> {
     if (await isSetupComplete(deps.db)) throw alreadySetUp();
-    if (!tokensMatch(setupToken, deps.config.setupToken)) {
-      throw new AppError(403, 'invalid_setup_token', 'That setup token is not correct.');
-    }
+    // A wrong token counts as a failed sign-in, so the sign-in rate limit and lockout (spec §12) also stop guessing.
+    const matches = await withLoginLock(deps.db, deps.clock, ip, async (tx, now) => {
+      const ok = tokensMatch(setupToken, deps.config.setupToken);
+      if (!ok) await recordLoginAttempt(tx, ip, false, now);
+      return ok;
+    });
+    if (!matches) throw new AppError(403, 'invalid_setup_token', 'That setup token is not correct.');
   }
 
   return new Hono<AppEnv>()
@@ -51,15 +56,16 @@ export function setupRoutes(deps: AppDeps) {
       return c.json<AuthStatus>({ setupRequired, authenticated });
     })
     .post('/setup/totp', validate('json', setupTotpRequestSchema), async (c) => {
-      await assertSetupAllowed(c.req.valid('json').setupToken);
+      await assertSetupAllowed(deps.clientIp(c), c.req.valid('json').setupToken);
       const secret = newTotpSecret();
       return c.json<TotpSecretResponse>({ secret, uri: totpUri(secret) });
     })
     .post('/setup', validate('json', setupRequestSchema), async (c) => {
       const body = c.req.valid('json');
-      await assertSetupAllowed(body.setupToken);
+      await assertSetupAllowed(deps.clientIp(c), body.setupToken);
       const now = deps.clock.now();
-      if (!(await verifyTotp(body.totpSecret, body.totpCode, now))) {
+      const totpStep = await verifyTotp(body.totpSecret, body.totpCode, now);
+      if (totpStep === null) {
         throw new DomainError(
           'invalid_totp_code',
           "That code didn't match. Check that your phone's clock is correct and try again.",
@@ -78,6 +84,8 @@ export function setupRoutes(deps: AppDeps) {
             passwordHash,
             totpSecretEnc: encryptSecret(body.totpSecret, deps.config.encryptionKey),
             recoveryCodeHashes,
+            // The confirmation code can't be used again to sign in.
+            totpLastStep: totpStep,
             budgetStartMonth: `${monthIn(deps.config.timeZone, now)}-01`,
           });
           await seedBudget(tx);
PATCH
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/server/auth/totp.test.ts src/server/auth/second-factor.test.ts src/server/auth/login-routes.test.ts src/server/auth/security-routes.test.ts src/server/auth/setup-routes.test.ts`
Expected: `Tests  51 passed (51)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  52 passed (52)`, `Tests  471 passed (471)` (+0 test files, +6 tests); both checks exit 0.

- [ ] **Step 7: Commit**

```bash
git add drizzle src/server/db/schema.ts src/server/auth src/server/test/totp.ts
git commit -m "feat(server): accept each authenticator code once; rate-limit setup-token guesses" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---
### Task 2: Retry-After, a sign-in queue with a lock timeout, cookie refresh and friendly limits

Carry-over "P3: /status should refresh the cookie; clear stale cookie on 401; Retry-After on 429; friendly .max messages" and "P3: login-lock waiters hold pool connections"; spec §12, §13.
- **Retry-After.** `AppError` takes response headers. A 429 `rate_limited` says how long until the oldest attempt of the last minute is a minute old; a 429 `locked` how long until the lockout ends (whole seconds, at least 1).
- **The sign-in queue.** `withLoginLock` used to open a transaction and wait for the advisory lock inside it, so a burst of sign-ins held one pooled connection each while waiting, starving every other request. Calls now wait their turn in the process first (a promise chain per database), so only the one running holds a connection. The advisory lock still guards against a second process; waiting for it longer than `LOGIN_LOCK_TIMEOUT_MS` (5 s, via `lock_timeout`) answers 503 `busy` with `Retry-After: 1`.
- **Cookies.** `refreshSession(c, deps)` reads the cookie, slides the session and refreshes the cookie, and clears a cookie whose session is unknown or expired. `requireSession` and `GET /api/auth/status` both use it, so a client that only polls its status keeps its session, and a stale cookie goes away with the 401 or the status answer.
- **Friendly limits.** The auth schemas' `.max()` limits and the empty recovery code have messages of their own.

**Files:**
- Modify: `src/server/auth/rate-limit.ts`, `src/server/auth/sessions.ts`, `src/server/auth/setup-routes.ts`, `src/server/db/errors.ts`, `src/server/http/errors.ts`, `src/shared/auth.ts`
- Test: `src/server/auth/rate-limit.test.ts`, `src/server/auth/login-routes.test.ts`, `src/server/auth/sessions.test.ts`, `src/server/auth/setup-routes.test.ts`, `src/shared/auth.test.ts`

**Interfaces:**
- Consumes: Task 1; `createDatabase` (`db/client.ts`).
- Produces:
  - `AppError(status, code, message, extra?, headers?)`; the error handler sends `headers`.
  - `isLockTimeout(error)` (SQLSTATE 55P03, `src/server/db/errors.ts`).
  - `LOGIN_LOCK_TIMEOUT_MS = 5000`; `withLoginLock(db, clock, ip, fn, { lockTimeoutMs? })` (queued, 503 `busy`).
  - `refreshSession(c, deps)` (replaces `currentSession`); `requireSession` clears a stale cookie.

- [ ] **Step 1: Write the failing tests**

Create `src/server/auth/rate-limit.test.ts`:

```ts
import { setTimeout as sleep } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database, type Db } from '../db/client';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { FakeClock } from '../test/fake-clock';
import { LOGIN_LOCK_KEY, withLoginLock } from './rate-limit';

let t: TestDatabase;
const pools: Database[] = [];
beforeEach(async () => {
  t = await createTestDatabase();
});
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  await t.drop();
});

function connect(max: number): Db {
  const pool = createDatabase(t.url, { max });
  pools.push(pool);
  return pool.db;
}

/** Takes the login lock on another connection, as a second server process would; the result releases it. */
async function holdLoginLock(): Promise<() => Promise<void>> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held!: () => void;
  const isHeld = new Promise<void>((resolve) => (held = resolve));
  const done = connect(1).transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOGIN_LOCK_KEY}::bigint)`);
    held();
    await released;
  });
  await isHeld;
  return async () => {
    release();
    await done;
  };
}

const clock = new FakeClock('2026-11-20T10:00:00Z');

describe('withLoginLock', () => {
  it('queues sign-ins in memory, so the waiting ones hold no pooled connection', async () => {
    const db = connect(2);
    const release = await holdLoginLock();
    const signIns = [1, 2, 3].map((n) => withLoginLock(db, clock, `198.51.100.${n}`, async () => n));
    const otherRequest = db.execute(sql`select 1`).then(() => 'answered');
    expect(await Promise.race([otherRequest, sleep(1000, 'starved')])).toBe('answered');
    await release();
    expect(await Promise.all(signIns)).toEqual([1, 2, 3]);
  });

  it('gives up with 503 busy when another process holds the lock too long', async () => {
    const release = await holdLoginLock();
    try {
      const signIn = withLoginLock(t.db, clock, '198.51.100.1', async () => 'signed in', { lockTimeoutMs: 100 });
      await expect(signIn).rejects.toMatchObject({ status: 503, code: 'busy', headers: { 'Retry-After': '1' } });
    } finally {
      await release();
    }
    expect(await withLoginLock(t.db, clock, '198.51.100.1', async () => 'signed in')).toBe('signed in');
  });
});
```

```bash
git apply <<'PATCH'
diff --git a/src/server/auth/login-routes.test.ts b/src/server/auth/login-routes.test.ts
index db0d010..1268aab 100644
--- a/src/server/auth/login-routes.test.ts
+++ b/src/server/auth/login-routes.test.ts
@@ -124,10 +124,14 @@ describe('POST /api/auth/login', () => {
   it('limits each IP to 5 attempts per minute', async () => {
     const attacker = new TestClient(ctx.app, '198.51.100.66');
     for (let i = 0; i < 5; i++) expect((await login(attacker, { password: 'guess', totpCode: '000000' })).status).toBe(401);
-    expect(await login(attacker, await withCode())).toEqual({
-      status: 429,
-      body: { code: 'rate_limited', message: 'Too many sign-in attempts. Wait a minute and try again.' },
+    const limited = await attacker.post('/api/auth/login', await withCode());
+    expect(limited.status).toBe(429);
+    expect(await limited.json()).toEqual({
+      code: 'rate_limited',
+      message: 'Too many sign-in attempts. Wait a minute and try again.',
     });
+    // withCode() moved the clock 30 s on, so the oldest of the five attempts is a minute old in 30 s.
+    expect(limited.headers.get('retry-after')).toBe('30');
     expect((await login(new TestClient(ctx.app, '198.51.100.67'), await withCode())).status).toBe(200);
     ctx.clock.advance(MINUTE + 1);
     expect((await login(attacker, await withCode())).status).toBe(200);
@@ -149,10 +153,10 @@ describe('POST /api/auth/login', () => {
       expect(res.status).toBe(401);
     }
     const owner = new TestClient(ctx.app);
-    expect(await login(owner, await withCode())).toEqual({
-      status: 429,
-      body: { code: 'locked', message: 'Too many failed sign-ins. Try again in 15 minutes.' },
-    });
+    const locked = await owner.post('/api/auth/login', await withCode());
+    expect(locked.status).toBe(429);
+    expect(await locked.json()).toEqual({ code: 'locked', message: 'Too many failed sign-ins. Try again in 15 minutes.' });
+    expect(locked.headers.get('retry-after')).toBe(String(15 * 60 - 30));
     ctx.clock.advance(15 * MINUTE);
     expect((await login(owner, await withCode())).status).toBe(200);
   });
diff --git a/src/server/auth/sessions.test.ts b/src/server/auth/sessions.test.ts
index c6439bb..b464bcd 100644
--- a/src/server/auth/sessions.test.ts
+++ b/src/server/auth/sessions.test.ts
@@ -107,10 +107,13 @@ describe('requireSession', () => {
     expect(cookie).toContain('SameSite=Strict');
   });
 
-  it('turns a client away once its session has expired', async () => {
+  it('turns a client away once its session has expired, and clears its cookie', async () => {
     const client = protectedApp();
     await client.post('/login');
     clock.advance(31 * DAY);
-    expect((await client.get('/private')).status).toBe(401);
+    const res = await client.get('/private');
+    expect(res.status).toBe(401);
+    expect(res.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=; Max-Age=0`);
+    expect(client.cookie(SESSION_COOKIE)).toBeUndefined();
   });
 });
diff --git a/src/server/auth/setup-routes.test.ts b/src/server/auth/setup-routes.test.ts
index 18de4ff..5811545 100644
--- a/src/server/auth/setup-routes.test.ts
+++ b/src/server/auth/setup-routes.test.ts
@@ -53,6 +53,18 @@ describe('GET /api/auth/status', () => {
       body: { setupRequired: true, authenticated: false },
     });
   });
+
+  it("refreshes a signed-in client's cookie and clears a stale one", async () => {
+    await setUpBudget(ctx);
+    ctx.clock.advance(20 * 24 * 60 * 60 * 1000);
+    const live = await ctx.client.get('/api/auth/status');
+    expect(await live.json()).toEqual({ setupRequired: false, authenticated: true });
+    expect(live.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=[\\w-]{43}; Max-Age=2592000;`));
+
+    const stale = await ctx.client.get('/api/auth/status', { cookie: `${SESSION_COOKIE}=no-such-session` });
+    expect(await stale.json()).toEqual({ setupRequired: false, authenticated: false });
+    expect(stale.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=; Max-Age=0`);
+  });
 });
 
 describe('POST /api/auth/setup/totp', () => {
diff --git a/src/shared/auth.test.ts b/src/shared/auth.test.ts
index d9c1d5a..d1891a7 100644
--- a/src/shared/auth.test.ts
+++ b/src/shared/auth.test.ts
@@ -18,6 +18,18 @@ describe('auth request schemas', () => {
     expect(setupRequestSchema.safeParse({ ...ok, setupToken: 'x'.repeat(257) }).success).toBe(false);
   });
 
+  it('explain too long or empty inputs in words', () => {
+    const messages = (result: { error?: { issues: { message: string }[] } }) => result.error?.issues.map((i) => i.message);
+    expect(messages(setupTotpRequestSchema.safeParse({ setupToken: 'x'.repeat(257) }))).toEqual([
+      'That setup token is too long.',
+    ]);
+    expect(messages(loginRequestSchema.safeParse({ password: 'x'.repeat(257), recoveryCode: 'y'.repeat(65) }))).toEqual([
+      'Use at most 256 characters.',
+      'That recovery code is too long.',
+    ]);
+    expect(messages(loginRequestSchema.safeParse({ password: 'p', recoveryCode: '' }))).toEqual(['Enter a recovery code.']);
+  });
+
   it('require exactly one second factor at login', () => {
     expect(loginRequestSchema.safeParse({ password: 'p', totpCode: '123456' }).success).toBe(true);
     expect(loginRequestSchema.safeParse({ password: 'p', recoveryCode: 'AAAA-BBBB-CCCC' }).success).toBe(true);
PATCH
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run src/server/auth/rate-limit.test.ts src/server/auth/login-routes.test.ts src/server/auth/sessions.test.ts src/server/auth/setup-routes.test.ts src/shared/auth.test.ts`
Expected: FAIL — `Tests  7 failed | 33 passed (40)`: no `Retry-After` (`expected null to be '30'`, `'870'`), the queue test (`expected 'starved' to be 'answered'`), the busy test (it waits for the lock until the 30 s test timeout), no cleared cookie on the 401 or on `/status`, and the default `.max()` messages.

- [ ] **Step 3: Response headers on AppError; lock timeouts**

```bash
git apply <<'PATCH'
diff --git a/src/server/db/errors.ts b/src/server/db/errors.ts
index 1abd8af..6729531 100644
--- a/src/server/db/errors.ts
+++ b/src/server/db/errors.ts
@@ -16,3 +16,8 @@ export function isUniqueViolation(error: unknown): boolean {
 export function isIntegrityViolation(error: unknown): boolean {
   return hasSqlState(error, (code) => /^23[0-9A-Z]{3}$/.test(code));
 }
+
+/** True when a statement gave up waiting for a lock because `lock_timeout` passed (55P03). */
+export function isLockTimeout(error: unknown): boolean {
+  return hasSqlState(error, (code) => code === '55P03');
+}
diff --git a/src/server/http/errors.ts b/src/server/http/errors.ts
index cae11a5..00f1dfc 100644
--- a/src/server/http/errors.ts
+++ b/src/server/http/errors.ts
@@ -5,13 +5,17 @@ import { z } from 'zod';
 import type { ApiErrorBody } from '../../shared/http';
 import type { AppEnv } from './env';
 
-/** An error whose message is safe to show to the user; mapped to `status` with body `{ code, message, ... }`. */
+/**
+ * An error whose message is safe to show to the user; mapped to `status` with body `{ code, message, ... }` and the
+ * given response headers (e.g. `Retry-After`).
+ */
 export class AppError extends Error {
   constructor(
     readonly status: ContentfulStatusCode,
     readonly code: string,
     message: string,
     readonly extra: Omit<ApiErrorBody, 'code' | 'message'> = {},
+    readonly headers: Record<string, string> = {},
   ) {
     super(message);
     this.name = 'AppError';
@@ -49,7 +53,7 @@ export class ValidationError extends AppError {
 
 export function errorHandler(err: Error, c: Context<AppEnv>): Response {
   if (err instanceof AppError) {
-    return c.json<ApiErrorBody>({ code: err.code, message: err.message, ...err.extra }, err.status);
+    return c.json<ApiErrorBody>({ code: err.code, message: err.message, ...err.extra }, err.status, err.headers);
   }
   if (err instanceof HTTPException) {
     const code = err.status === 400 ? 'bad_request' : `http_${err.status}`;
PATCH
```

- [ ] **Step 4: Retry-After and the sign-in queue**

```bash
git apply <<'PATCH'
diff --git a/src/server/auth/rate-limit.ts b/src/server/auth/rate-limit.ts
index b59f0f3..7fdc5bf 100644
--- a/src/server/auth/rate-limit.ts
+++ b/src/server/auth/rate-limit.ts
@@ -1,6 +1,7 @@
-import { and, count, desc, eq, gt, lt, sql } from 'drizzle-orm';
+import { and, count, desc, eq, gt, lt, min, sql } from 'drizzle-orm';
 import type { Clock } from '../clock';
 import type { Db, Executor, Tx } from '../db/client';
+import { isLockTimeout } from '../db/errors';
 import { loginAttempt } from '../db/schema';
 import { AppError } from '../http/errors';
 
@@ -14,14 +15,22 @@ export const LOGIN_LIMITS = {
 const MINUTE_MS = 60 * 1000;
 const RETENTION_MS = 24 * 60 * 60 * 1000;
 
+/** A 429 that tells the client, in a `Retry-After` header, how many seconds until `until`. */
+function tooMany(code: string, message: string, until: number, now: Date): AppError {
+  const seconds = Math.max(1, Math.ceil((until - now.getTime()) / 1000));
+  return new AppError(429, code, message, {}, { 'Retry-After': String(seconds) });
+}
+
 /** Throws 429 when `ip` has used up its attempts this minute, or while login is locked out. */
 export async function assertLoginAllowed(db: Executor, ip: string, now: Date): Promise<void> {
   const [recent] = await db
-    .select({ n: count() })
+    .select({ n: count(), oldest: min(loginAttempt.at) })
     .from(loginAttempt)
     .where(and(eq(loginAttempt.ip, ip), gt(loginAttempt.at, new Date(now.getTime() - MINUTE_MS))));
-  if ((recent?.n ?? 0) >= LOGIN_LIMITS.attemptsPerMinute) {
-    throw new AppError(429, 'rate_limited', 'Too many sign-in attempts. Wait a minute and try again.');
+  if (recent?.oldest && recent.n >= LOGIN_LIMITS.attemptsPerMinute) {
+    // A slot frees up when the oldest attempt of the last minute is a minute old.
+    const message = 'Too many sign-in attempts. Wait a minute and try again.';
+    throw tooMany('rate_limited', message, recent.oldest.getTime() + MINUTE_MS, now);
   }
 
   const latest = await db
@@ -29,12 +38,13 @@ export async function assertLoginAllowed(db: Executor, ip: string, now: Date): P
     .from(loginAttempt)
     .orderBy(desc(loginAttempt.at), desc(loginAttempt.id))
     .limit(LOGIN_LIMITS.lockoutAfterFailures);
+  const lockedUntil = latest[0] ? latest[0].at.getTime() + LOGIN_LIMITS.lockoutMs : 0;
   const lockedOut =
     latest.length === LOGIN_LIMITS.lockoutAfterFailures &&
     latest.every((attempt) => !attempt.success) &&
-    now.getTime() - latest[0]!.at.getTime() < LOGIN_LIMITS.lockoutMs;
+    now.getTime() < lockedUntil;
   if (lockedOut) {
-    throw new AppError(429, 'locked', 'Too many failed sign-ins. Try again in 15 minutes.');
+    throw tooMany('locked', 'Too many failed sign-ins. Try again in 15 minutes.', lockedUntil, now);
   }
 }
 
@@ -50,20 +60,50 @@ export async function recordLoginAttempt(db: Executor, ip: string, success: bool
  */
 export const LOGIN_LOCK_KEY = 727274001;
 
+/** How long a sign-in waits for another process's login lock before answering 503 `busy`. */
+export const LOGIN_LOCK_TIMEOUT_MS = 5000;
+
+/** The tail of each database's queue of sign-ins in this process (see withLoginLock). */
+const loginQueues = new WeakMap<Db, Promise<unknown>>();
+
+/** Runs `fn` once every earlier call for the same database has settled. */
+function inTurn<T>(db: Db, fn: () => Promise<T>): Promise<T> {
+  const turn = (loginQueues.get(db) ?? Promise.resolve()).then(fn);
+  loginQueues.set(
+    db,
+    turn.catch(() => undefined),
+  );
+  return turn;
+}
+
 /**
  * Runs `fn` in a transaction that holds the login lock, once `ip` has passed the rate limit and lockout checks.
  * `fn` checks the credentials and records the attempt; a failure should be returned, not thrown, so it stays recorded.
+ *
+ * Sign-ins in this process wait their turn in memory first, so waiting ones don't hold pooled connections (a burst of
+ * sign-ins could otherwise starve every other request). The advisory lock still guards against other processes; a
+ * wait for it longer than `lockTimeoutMs` gives up with 503 `busy`.
  */
 export function withLoginLock<T>(
   db: Db,
   clock: Clock,
   ip: string,
   fn: (tx: Tx, now: Date) => Promise<T>,
+  options: { lockTimeoutMs?: number } = {},
 ): Promise<T> {
-  return db.transaction(async (tx) => {
-    await tx.execute(sql`select pg_advisory_xact_lock(${LOGIN_LOCK_KEY}::bigint)`);
-    const now = clock.now();
-    await assertLoginAllowed(tx, ip, now);
-    return fn(tx, now);
+  const lockTimeout = `${options.lockTimeoutMs ?? LOGIN_LOCK_TIMEOUT_MS}ms`;
+  return inTurn(db, async () => {
+    try {
+      return await db.transaction(async (tx) => {
+        await tx.execute(sql`select set_config('lock_timeout', ${lockTimeout}, true)`);
+        await tx.execute(sql`select pg_advisory_xact_lock(${LOGIN_LOCK_KEY}::bigint)`);
+        const now = clock.now();
+        await assertLoginAllowed(tx, ip, now);
+        return fn(tx, now);
+      });
+    } catch (error) {
+      if (!isLockTimeout(error)) throw error;
+      throw new AppError(503, 'busy', 'Signing in is busy. Try again in a moment.', {}, { 'Retry-After': '1' });
+    }
   });
 }
PATCH
```

- [ ] **Step 5: Refresh or clear the cookie; friendly limits**

```bash
git apply <<'PATCH'
diff --git a/src/server/auth/sessions.ts b/src/server/auth/sessions.ts
index 5400bfd..fd8289a 100644
--- a/src/server/auth/sessions.ts
+++ b/src/server/auth/sessions.ts
@@ -75,23 +75,30 @@ export function clearSessionCookie(c: Context, secure: boolean): void {
   deleteCookie(c, SESSION_COOKIE, { httpOnly: true, secure, sameSite: 'Strict', path: '/' });
 }
 
-/** The session behind the request's cookie, if any (sliding its expiry). */
-export async function currentSession(c: Context, deps: { db: Executor; clock: Clock }): Promise<SessionInfo | null> {
-  const token = getCookie(c, SESSION_COOKIE);
-  return token ? findSession(deps.db, token, deps.clock.now()) : null;
-}
-
-/** 401 unless the request carries a live session; refreshes the cookie so its lifetime slides too. */
-export function requireSession(deps: {
+interface SessionDeps {
   db: Executor;
   clock: Clock;
   config: { cookieSecure: boolean };
-}): MiddlewareHandler<AuthedEnv> {
+}
+
+/**
+ * The live session behind the request's cookie, or null. Slides the session's expiry and refreshes the cookie so its
+ * lifetime slides too; a cookie for an unknown or expired session is cleared.
+ */
+export async function refreshSession(c: Context, deps: SessionDeps): Promise<SessionInfo | null> {
+  const token = getCookie(c, SESSION_COOKIE);
+  if (!token) return null;
+  const found = await findSession(deps.db, token, deps.clock.now());
+  if (found) setSessionCookie(c, token, deps.config.cookieSecure);
+  else clearSessionCookie(c, deps.config.cookieSecure);
+  return found;
+}
+
+/** 401 unless the request carries a live session (see refreshSession). */
+export function requireSession(deps: SessionDeps): MiddlewareHandler<AuthedEnv> {
   return async (c, next) => {
-    const token = getCookie(c, SESSION_COOKIE);
-    const found = token ? await findSession(deps.db, token, deps.clock.now()) : null;
-    if (!token || !found) throw new AppError(401, 'unauthorized', 'Please sign in.');
-    setSessionCookie(c, token, deps.config.cookieSecure);
+    const found = await refreshSession(c, deps);
+    if (!found) throw new AppError(401, 'unauthorized', 'Please sign in.');
     c.set('session', found);
     await next();
   };
diff --git a/src/server/auth/setup-routes.ts b/src/server/auth/setup-routes.ts
index 312da45..dd34b50 100644
--- a/src/server/auth/setup-routes.ts
+++ b/src/server/auth/setup-routes.ts
@@ -20,7 +20,7 @@ import { hashPassword } from './passwords';
 import { recordLoginAttempt, withLoginLock } from './rate-limit';
 import { generateRecoveryCodes, hashRecoveryCodes } from './recovery-codes';
 import { encryptSecret } from './secret-box';
-import { createSession, currentSession, setSessionCookie } from './sessions';
+import { createSession, refreshSession, setSessionCookie } from './sessions';
 import { newTotpSecret, totpUri, verifyTotp } from './totp';
 
 export async function isSetupComplete(db: Executor): Promise<boolean> {
@@ -52,7 +52,8 @@ export function setupRoutes(deps: AppDeps) {
   return new Hono<AppEnv>()
     .get('/status', async (c) => {
       const setupRequired = !(await isSetupComplete(deps.db));
-      const authenticated = !setupRequired && (await currentSession(c, deps)) !== null;
+      // Also keeps the cookie's lifetime sliding while the app only polls its status, and clears a stale cookie.
+      const authenticated = (await refreshSession(c, deps)) !== null && !setupRequired;
       return c.json<AuthStatus>({ setupRequired, authenticated });
     })
     .post('/setup/totp', validate('json', setupTotpRequestSchema), async (c) => {
PATCH
```

```bash
git apply <<'PATCH'
diff --git a/src/shared/auth.ts b/src/shared/auth.ts
index d9774b6..35fa70e 100644
--- a/src/shared/auth.ts
+++ b/src/shared/auth.ts
@@ -8,20 +8,22 @@ export const newPasswordSchema = z
   .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
   .max(256, 'Use at most 256 characters.');
 /** An existing password being re-entered (no strength rules). */
-export const currentPasswordSchema = z.string().min(1, 'Enter your password.').max(256);
+export const currentPasswordSchema = z.string().min(1, 'Enter your password.').max(256, 'Use at most 256 characters.');
 export const totpCodeSchema = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app.');
 export const totpSecretSchema = z.string().regex(/^[A-Z2-7]{32}$/, 'Invalid authenticator secret.');
 
-export const setupTotpRequestSchema = z.object({ setupToken: z.string().min(1, 'Enter the setup token.').max(256) });
+const setupTokenSchema = z.string().min(1, 'Enter the setup token.').max(256, 'That setup token is too long.');
+
+export const setupTotpRequestSchema = z.object({ setupToken: setupTokenSchema });
 
 export const setupRequestSchema = z.object({
-  setupToken: z.string().min(1, 'Enter the setup token.').max(256),
+  setupToken: setupTokenSchema,
   password: newPasswordSchema,
   totpSecret: totpSecretSchema,
   totpCode: totpCodeSchema,
 });
 
-const recoveryCodeSchema = z.string().min(1).max(64);
+const recoveryCodeSchema = z.string().min(1, 'Enter a recovery code.').max(64, 'That recovery code is too long.');
 
 export const loginRequestSchema = z
   .object({
PATCH
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/server/auth/rate-limit.test.ts src/server/auth/login-routes.test.ts src/server/auth/sessions.test.ts src/server/auth/setup-routes.test.ts src/shared/auth.test.ts`
Expected: `Tests  40 passed (40)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  53 passed (53)`, `Tests  475 passed (475)` (+1 test file, +4 tests); both checks exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/server/auth src/server/db/errors.ts src/server/http/errors.ts src/shared/auth.ts src/shared/auth.test.ts
git commit -m "feat(server): Retry-After on 429, a queued sign-in lock with a timeout, cookie refresh on /status" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---
### Task 3: The web app's tooling, lint boundaries and Polish formatting

Spec §1 (UI language and formats), §2 (`src/web` stack). Vite 8 builds `src/web` (its root) into `dist/web` with React 19 and Tailwind CSS 4; `npm run build` builds the web app and then the server bundle, and `npm run dev:web` serves the app with hot reload, forwarding `/api` and `/healthz` to `npm run dev` on port 3080 (`API_PROXY_TARGET` overrides). Vitest gets a third project, `web` (jsdom, Testing Library), for `src/web/**/*.test.{ts,tsx}`.

Type checking: the root tsconfig keeps covering the server, `src/shared`, the engine and the config files, and leaves out `src/web`; `src/web/tsconfig.json` extends it with the DOM lib and JSX (carry-over "web tsconfig DOM lib"). It keeps Node's types because the RPC client's `App` type pulls in server modules; ESLint keeps their runtime out instead:
- `src/web` may import from `src/server` only with `import type`, and no Node modules or globals;
- `src/server` and `src/shared` never import `src/web`, and `src/shared` (used by the browser) never imports `src/server`;
- React hooks rules for `src/web` (`eslint-plugin-react-hooks`, `exhaustive-deps` as an error);
- commands write through the recorder: `rec.tx.insert/update/delete` is an error in `src/server` (carry-over, P2b1 final review).

`src/server/lint-boundaries.test.ts` lints small snippets with the real config, so a later edit can't silently drop a rule.

`src/web/lib/format.ts` formats amounts the Polish way (`1 234,56 zł`, no-break spaces, exact for every safe integer; foreign currencies by code), ISO dates as dd.MM.yyyy and back (refusing days that don't exist), and months in English (`November 2026`, `Nov 2026`). It is plain string work rather than `Intl`, so the output is exact and the same in every browser.

**Files:**
- Create: `vite.config.ts`, `src/web/tsconfig.json`, `src/web/index.html`, `src/web/main.tsx`, `src/web/styles.css`, `src/web/test/setup.ts`, `src/web/lib/format.ts`
- Modify: `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`
- Test: `src/server/lint-boundaries.test.ts`, `src/web/lib/format.test.ts`

**Interfaces:**
- Consumes: the existing ESLint flat config (engine purity rules), `vitest.config.ts` projects.
- Produces:
  - Scripts: `dev:web`, `build` (= `build:web` + `build:server`), `build:web`, `build:server`, `test:web`; `typecheck` runs both tsconfigs.
  - `format.ts`: `NBSP`, `formatAmount(minor)`, `formatMoney(minor, currency = 'PLN')`, `formatDate(iso)`, `parseDate(text): string | null`, `formatMonth(month)`, `formatMonthShort(month)`.
  - Theme tokens `brand`, `brand-dark`, `brand-light` (`styles.css`).

- [ ] **Step 1: Install the web toolchain**

Run: `npm install -D @tailwindcss/vite@^4.3.5 @testing-library/dom@^10.4.2 @testing-library/jest-dom@^8.0.0 @testing-library/react@^16.3.3 @testing-library/user-event@^14.6.13 @types/react@^19.3.0 @types/react-dom@^19.3.0 @vitejs/plugin-react@^6.3.0 eslint-plugin-react-hooks@^7.1.1 jsdom@^29.1.1 react@^19.3.1 react-dom@^19.3.1 tailwindcss@^4.3.5 vite@^8.3.8`
Expected: `package.json` lists each of them with that range under `devDependencies`.

- [ ] **Step 2: Wire up Vite, the web tsconfig and the Vitest project**

```bash
git apply <<'PATCH'
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -8,13 +8,17 @@
   },
   "scripts": {
     "dev": "tsx watch --env-file=.env src/server/main.ts",
-    "build": "esbuild src/server/main.ts --bundle --platform=node --format=esm --target=node22 --packages=external --sourcemap --outfile=dist/server/main.js",
+    "dev:web": "vite",
+    "build": "npm run build:web && npm run build:server",
+    "build:web": "vite build",
+    "build:server": "esbuild src/server/main.ts --bundle --platform=node --format=esm --target=node22 --packages=external --sourcemap --outfile=dist/server/main.js",
     "start": "node --enable-source-maps dist/server/main.js",
     "test": "vitest run",
     "test:engine": "vitest run --project engine",
     "test:server": "vitest run --project server",
+    "test:web": "vitest run --project web",
     "test:watch": "vitest",
-    "typecheck": "tsc --noEmit",
+    "typecheck": "tsc --noEmit && tsc --noEmit -p src/web/tsconfig.json",
     "lint": "eslint .",
     "db:generate": "drizzle-kit generate"
   },
PATCH
```

```bash
git apply <<'PATCH'
diff --git a/tsconfig.json b/tsconfig.json
index 0dfcb80..dce5cd1 100644
--- a/tsconfig.json
+++ b/tsconfig.json
@@ -19,6 +19,10 @@
   "include": [
     "src",
     "vitest.config.ts",
+    "vite.config.ts",
     "drizzle.config.ts"
+  ],
+  "exclude": [
+    "src/web"
   ]
 }
diff --git a/vitest.config.ts b/vitest.config.ts
index defc8a5..8c10707 100644
--- a/vitest.config.ts
+++ b/vitest.config.ts
@@ -1,3 +1,4 @@
+import react from '@vitejs/plugin-react';
 import { defineConfig } from 'vitest/config';
 
 export default defineConfig({
@@ -13,6 +14,15 @@ export default defineConfig({
           hookTimeout: 180_000,
         },
       },
+      {
+        plugins: [react()],
+        test: {
+          name: 'web',
+          include: ['src/web/**/*.test.{ts,tsx}'],
+          environment: 'jsdom',
+          setupFiles: ['src/web/test/setup.ts'],
+        },
+      },
     ],
   },
 });
PATCH
```

Create `vite.config.ts`:

```ts
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** `npm run dev:web` forwards these paths to the API server started by `npm run dev` (PORT=3080 in .env). */
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:3080';

export default defineConfig({
  root: fileURLToPath(new URL('src/web', import.meta.url)),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL('dist/web', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    proxy: { '/api': apiTarget, '/healthz': apiTarget },
  },
});
```

Create `src/web/tsconfig.json`:

```json
{
  // The web app runs in the browser (DOM lib, JSX). It also type-checks the server modules it imports types from
  // (the Hono `App` type for the RPC client), so Node's types stay available; ESLint keeps runtime imports out.
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["node", "vite/client"]
  },
  "include": ["."],
  "exclude": []
}
```

Create `src/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#15803d" />
    <title>Budget Track</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

Create `src/web/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <p className="p-4">Budget Track</p>
  </StrictMode>,
);
```

Create `src/web/styles.css`:

```css
@import 'tailwindcss';

/* Design tokens for the component kit in src/web/ui (YNAB-like: calm greys, green for money that's fine). */
@theme {
  --font-sans: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
  --color-brand: #15803d;
  --color-brand-dark: #166534;
  --color-brand-light: #dcfce7;
}

@layer base {
  html {
    -webkit-tap-highlight-color: transparent;
  }

  body {
    @apply bg-gray-100 text-gray-900 antialiased;
  }
}
```

Create `src/web/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest runs without globals, so Testing Library can't register its own cleanup.
afterEach(() => {
  cleanup();
});
```

- [ ] **Step 3: Write the failing tests**

Create `src/server/lint-boundaries.test.ts`:

```ts
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint();
const BOUNDARY_RULES = [
  'no-restricted-imports',
  '@typescript-eslint/no-restricted-imports',
  'no-restricted-globals',
  'no-restricted-syntax',
  'react-hooks/rules-of-hooks',
];

/** The messages of the boundary rules for `code`, linted as if it were the file at `filePath`. */
async function violations(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.filter((m) => BOUNDARY_RULES.includes(m.ruleId ?? '')).map((m) => m.message);
}

/** Exactly one violation, whose message contains `text`. */
const one = (text: string) => [expect.stringContaining(text)];

describe('layer boundaries (ESLint)', () => {
  it('let the web app import only types from the server', async () => {
    const value = "import { createApp } from '../../server/http/app';\nexport const make = createApp;\n";
    const typeOnly = "import type { App } from '../../server/http/app';\nexport type Api = App;\n";
    const shared = "import { CSRF_HEADER } from '../../shared/http';\nexport const h = CSRF_HEADER;\n";
    expect(await violations('src/web/lib/api.ts', value)).toEqual(one('src/web may import only types from src/server'));
    expect(await violations('src/web/lib/api.ts', typeOnly)).toEqual([]);
    expect(await violations('src/web/lib/api.ts', shared)).toEqual([]);
  });

  it('keep Node modules and globals out of the web app', async () => {
    const fs = "import { readFile } from 'node:fs';\nexport const r = readFile;\n";
    expect(await violations('src/web/lib/x.ts', fs)).toEqual(one('src/web runs in the browser: no Node modules.'));
    const env = 'export const env = process.env;\n';
    expect(await violations('src/web/lib/x.ts', env)).toEqual(one('src/web runs in the browser: no Node globals.'));
  });

  it('check the rules of hooks in the web app', async () => {
    const code =
      "import { useState } from 'react';\nexport function F({ on }: { on: boolean }) {\n  if (on) useState(0);\n  return null;\n}\n";
    expect(await violations('src/web/ui/f.tsx', code)).toEqual(one('React Hook "useState" is called conditionally'));
  });

  it('keep the server and src/shared independent of the web app, and src/shared of the server', async () => {
    const fromWeb = "import { formatMoney } from '../web/lib/format';\nexport const f = formatMoney;\n";
    expect(await violations('src/server/x.ts', fromWeb)).toEqual(one('must not import from src/web'));
    const fromServer = "import { loadConfig } from '../server/config';\nexport const f = loadConfig;\n";
    expect(await violations('src/shared/x.ts', fromServer)).toEqual(one('src/shared is used by the browser'));
  });

  it('keep the engine pure', async () => {
    const fs = "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n";
    expect(await violations('src/engine/x.ts', fs)).toEqual(one('src/engine must stay pure: no I/O modules.'));
  });

  it('make commands write through the ChangeRecorder', async () => {
    const code = 'export async function f(rec: { tx: { insert(t: unknown): unknown } }) {\n  await rec.tx.insert(1);\n}\n';
    expect(await violations('src/server/payees/payee-commands.ts', code)).toEqual(one('Write through the ChangeRecorder'));
  });
});
```

Create `src/web/lib/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatAmount, formatDate, formatMoney, formatMonth, formatMonthShort, NBSP, parseDate } from './format';

/** Writes expectations with plain spaces; the formatter uses no-break spaces. */
const nb = (text: string) => text.replaceAll(' ', NBSP);

describe('formatAmount and formatMoney', () => {
  it('group thousands with a space and use a decimal comma (spec §1)', () => {
    expect(formatMoney(123456)).toBe(nb('1 234,56 zł'));
    expect(formatMoney(0)).toBe(nb('0,00 zł'));
    expect(formatMoney(5)).toBe(nb('0,05 zł'));
    expect(formatMoney(99999)).toBe(nb('999,99 zł'));
    expect(formatMoney(100000000)).toBe(nb('1 000 000,00 zł'));
  });

  it('put a minus in front of negative amounts', () => {
    expect(formatMoney(-123456)).toBe(nb('-1 234,56 zł'));
    expect(formatAmount(-1)).toBe('-0,01');
    expect(formatAmount(-0)).toBe('0,00');
  });

  it('show foreign currencies by their code', () => {
    expect(formatMoney(250000, 'EUR')).toBe(nb('2 500,00 EUR'));
    expect(formatMoney(-75, 'USD')).toBe(nb('-0,75 USD'));
  });

  it('stay exact up to the largest safe integer and refuse anything else', () => {
    expect(formatAmount(Number.MAX_SAFE_INTEGER)).toBe(nb('90 071 992 547 409,91'));
    expect(formatAmount(-Number.MAX_SAFE_INTEGER)).toBe(nb('-90 071 992 547 409,91'));
    expect(() => formatAmount(1.5)).toThrow();
    expect(() => formatAmount(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
});

describe('dates', () => {
  it('show ISO dates as dd.MM.yyyy', () => {
    expect(formatDate('2026-11-20')).toBe('20.11.2026');
    expect(formatDate('2027-01-05')).toBe('05.01.2027');
    expect(() => formatDate('20.11.2026')).toThrow();
  });

  it('parse dd.MM.yyyy back, refusing dates that do not exist', () => {
    expect(parseDate('20.11.2026')).toBe('2026-11-20');
    expect(parseDate(' 5.1.2027 ')).toBe('2027-01-05');
    expect(parseDate('29.02.2028')).toBe('2028-02-29');
    expect(parseDate('29.02.2027')).toBeNull();
    expect(parseDate('31.04.2027')).toBeNull();
    expect(parseDate('01.13.2027')).toBeNull();
    expect(parseDate('00.01.2027')).toBeNull();
    expect(parseDate('2027-01-05')).toBeNull();
  });
});

describe('month labels', () => {
  it('name the month in English', () => {
    expect(formatMonth('2026-11')).toBe('November 2026');
    expect(formatMonth('2027-01')).toBe('January 2027');
    expect(formatMonthShort('2026-09')).toBe('Sep 2026');
    expect(() => formatMonth('2026-13')).toThrow();
    expect(() => formatMonth('2026-11-01')).toThrow();
  });
});
```

- [ ] **Step 4: Run the tests to see them fail**

Run: `npx vitest run src/server/lint-boundaries.test.ts src/web/lib/format.test.ts`
Expected: FAIL — `Test Files  2 failed (2)`, `Tests  5 failed | 1 passed (6)`: every boundary test but the engine's (`expected [] to deeply equal [ StringContaining{…} ]`), and `Failed to resolve import "./format"`.

- [ ] **Step 5: The boundary rules**

```bash
git apply <<'PATCH'
diff --git a/eslint.config.js b/eslint.config.js
index 09240ff..0473b9a 100644
--- a/eslint.config.js
+++ b/eslint.config.js
@@ -1,10 +1,14 @@
 import { builtinModules } from 'node:module';
 import js from '@eslint/js';
+import reactHooks from 'eslint-plugin-react-hooks';
 import { defineConfig } from 'eslint/config';
 import tseslint from 'typescript-eslint';
 
 const engineGlobalsMessage = 'src/engine must stay pure: no I/O or runtime globals.';
 const engineDeterminismMessage = 'src/engine must be deterministic: pass time and randomness in as arguments.';
+const nodeModules = `^(node:|(?:${builtinModules.join('|')})(?:/|$))`;
+/** Import paths that leave the current directory and enter one of `layers`, e.g. '../../server/http/app'. */
+const intoLayer = (...layers) => `^(?:\\.{1,2}/)*\\.\\./(?:[^/]+/)*(?:${layers.join('|')})(?:/|$)`;
 
 export default defineConfig(
   { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
@@ -20,11 +24,11 @@ export default defineConfig(
             {
               // Only paths that leave the current directory and enter server/ or web/;
               // same-directory engine modules such as './web' stay allowed.
-              regex: '^(?:\\.{1,2}/)*\\.\\./(?:[^/]+/)*(?:server|web)(?:/|$)',
+              regex: intoLayer('server', 'web'),
               message: 'src/engine must stay pure: no imports from server/ or web/.',
             },
             {
-              regex: `^(node:|(?:${builtinModules.join('|')})(?:/|$))`,
+              regex: nodeModules,
               message: 'src/engine must stay pure: no I/O modules.',
             },
           ],
@@ -54,4 +58,66 @@ export default defineConfig(
       ],
     },
   },
+  {
+    files: ['src/server/**/*.ts', 'src/shared/**/*.ts'],
+    rules: {
+      'no-restricted-imports': [
+        'error',
+        { patterns: [{ regex: intoLayer('web'), message: 'The server and src/shared must not import from src/web.' }] },
+      ],
+    },
+  },
+  {
+    files: ['src/shared/**/*.ts'],
+    rules: {
+      'no-restricted-imports': [
+        'error',
+        {
+          patterns: [
+            { regex: intoLayer('server', 'web'), message: 'src/shared is used by the browser: no imports from server/ or web/.' },
+          ],
+        },
+      ],
+    },
+  },
+  {
+    files: ['src/server/**/*.ts'],
+    rules: {
+      'no-restricted-syntax': [
+        'error',
+        {
+          selector:
+            "CallExpression[callee.property.name=/^(insert|update|delete)$/][callee.object.property.name='tx'][callee.object.object.name='rec']",
+          message: 'Write through the ChangeRecorder (rec.insert/update/delete), not rec.tx, so undo sees the change.',
+        },
+      ],
+    },
+  },
+  {
+    files: ['src/web/**/*.{ts,tsx}'],
+    extends: [reactHooks.configs.flat.recommended],
+    rules: {
+      'react-hooks/exhaustive-deps': 'error',
+      '@typescript-eslint/no-restricted-imports': [
+        'error',
+        {
+          patterns: [
+            {
+              regex: intoLayer('server'),
+              allowTypeImports: true,
+              message: 'src/web may import only types from src/server (use `import type`).',
+            },
+            { regex: nodeModules, message: 'src/web runs in the browser: no Node modules.' },
+          ],
+        },
+      ],
+      'no-restricted-globals': [
+        'error',
+        ...['process', 'Buffer', 'require', '__dirname', '__filename', 'global'].map((name) => ({
+          name,
+          message: 'src/web runs in the browser: no Node globals.',
+        })),
+      ],
+    },
+  },
 );
PATCH
```

- [ ] **Step 6: The formatting functions**

Create `src/web/lib/format.ts`:

```ts
/**
 * Display formats (spec §1): Polish number formatting (`1 234,56 zł`), dates as dd.MM.yyyy and English month names.
 * Amounts are integer minor units; every currency in use has two decimals (spec §2).
 */

/** No-break space: groups digits and keeps the currency on the same line as the amount. */
export const NBSP = '\u00a0';

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** "1 234,56" for 123456 minor units; negatives get a leading "-". Exact for every safe integer. */
export function formatAmount(minor: number): string {
  if (!Number.isSafeInteger(minor)) throw new Error(`Not an amount in minor units: ${minor}`);
  const abs = Math.abs(minor);
  const cents = abs % 100;
  const whole = String((abs - cents) / 100).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return `${minor < 0 ? '-' : ''}${whole},${String(cents).padStart(2, '0')}`;
}

/** "1 234,56 zł" for PLN, "1 234,56 EUR" for any other currency. */
export function formatMoney(minor: number, currency = 'PLN'): string {
  return `${formatAmount(minor)}${NBSP}${currency === 'PLN' ? 'zł' : currency}`;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "20.11.2026" for the ISO date "2026-11-20". */
export function formatDate(isoDate: string): string {
  const match = ISO_DATE.exec(isoDate);
  if (!match) throw new Error(`Not an ISO date: ${isoDate}`);
  return `${match[3]}.${match[2]}.${match[1]}`;
}

/** The ISO date for "20.11.2026" (one-digit day and month allowed), or null if it isn't a real calendar date. */
export function parseDate(text: string): string | null {
  const match = /^\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s*$/.exec(text);
  if (!match) return null;
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function monthParts(month: string): { year: string; name: (typeof MONTH_NAMES)[number] } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const name = match ? MONTH_NAMES[Number(match[2]) - 1] : undefined;
  if (!match || !name) throw new Error(`Not a month (YYYY-MM): ${month}`);
  return { year: match[1]!, name };
}

/** "November 2026" for "2026-11". */
export function formatMonth(month: string): string {
  const { year, name } = monthParts(month);
  return `${name} ${year}`;
}

/** "Nov 2026" for "2026-11". */
export function formatMonthShort(month: string): string {
  const { year, name } = monthParts(month);
  return `${name.slice(0, 3)} ${year}`;
}
```

- [ ] **Step 7: Run the tests and the build**

Run: `npx vitest run src/server/lint-boundaries.test.ts src/web/lib/format.test.ts`
Expected: `Tests  13 passed (13)`.
Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: `Test Files  55 passed (55)`, `Tests  488 passed (488)` (+2 test files, +13 tests); the checks exit 0; Vite prints `✓ built in …` with `dist/web/index.html` and one CSS and one JS file in `dist/web/assets/`, then esbuild's `Done`.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts vite.config.ts eslint.config.js src/web src/server/lint-boundaries.test.ts
git commit -m "build(web): Vite, React 19 and Tailwind 4 scaffold, web tsconfig and lint boundaries; Polish formatting" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---
### Task 4: The server serves the PWA; manifest, icons and service worker

Spec §2 (one process serves the PWA and `/api`), §11 Offline, §12 (strict CSP), §15; carry-over "SPA fallback for non-/api paths". `serveWeb(webDir, logger)` (`src/server/http/web.ts`) is mounted as `app.get('*', …)` after the typed route chain, so the RPC `App` type keeps only `/api` routes, and every API route matches first:
- GET and HEAD outside `/api`: a file in `webDir` if it exists; otherwise `index.html` for the app's routes (paths outside `/assets` whose last segment has no `.`); anything else falls through to the JSON 404, so a missing script never comes back as HTML.
- `Cache-Control`: hashed files in `/assets` are `public, max-age=31536000, immutable`; everything else (`index.html`, `sw.js`, the manifest, icons) is `no-cache`, so a new release reaches the browser. The `/api` middleware's `no-store` is untouched.
- The secure-headers middleware already sends the strict CSP on every response; the tests pin it on the app's pages.
- Without a build (`WEB_DIR`, default `dist/web`, has no `index.html`) the server logs a warning and serves only the API. Tests point `webDir` at a tiny fixture build.

vite-plugin-pwa writes `manifest.webmanifest` and a Workbox service worker (`generateSW`): it precaches the build and answers page loads with `index.html`, except `/api/*` and `/healthz`, and has no runtime caching, so `/api` is always network-only (spec §11). `main.tsx` registers it from the bundle (`injectRegister: false`), so no inline script needs a CSP exception; `registerType: 'autoUpdate'` swaps in a new release. The icons (a white bar chart on brand green, full-bleed so they also work as maskable icons) are drawn by `scripts/generate-icons.ts` with `node:zlib` only and committed. The Dockerfile copies `vite.config.ts` into the build stage; the runtime stage already copies all of `dist`.

**Files:**
- Create: `src/server/http/web.ts`, `src/server/test/web-fixture/{index.html,sw.js,manifest.webmanifest,assets/index-abc123.js}`, `scripts/generate-icons.ts`, `src/web/public/{icon.svg,icon-192.png,icon-512.png,apple-touch-icon.png}` (generated)
- Modify: `src/server/config.ts`, `src/server/http/app.ts`, `src/server/test/config.ts`, `package.json`, `package-lock.json`, `vite.config.ts`, `src/web/index.html`, `src/web/main.tsx`, `src/web/tsconfig.json`, `tsconfig.json`, `Dockerfile`
- Test: `src/server/http/web.test.ts`, `src/server/config.test.ts`

**Interfaces:**
- Consumes: `serveStatic` (`@hono/node-server/serve-static`), `createApp`, `testConfig`.
- Produces:
  - `Config.webDir` (env `WEB_DIR`, default `dist/web`); `testConfig` uses `src/server/test/web-fixture`.
  - `serveWeb(webDir, logger): MiddlewareHandler<AppEnv>`.
  - Script `icons`; `virtual:pwa-register` types in the web tsconfig.

- [ ] **Step 1: Write the failing tests**

```bash
git apply <<'PATCH'
diff --git a/src/server/config.test.ts b/src/server/config.test.ts
index d1550cf..b9a8239 100644
--- a/src/server/config.test.ts
+++ b/src/server/config.test.ts
@@ -21,6 +21,7 @@ describe('loadConfig', () => {
       trustProxy: false,
       logLevel: 'info',
       migrationsDir: 'drizzle',
+      webDir: 'dist/web',
     });
     expect(config.encryptionKey).toEqual(Buffer.alloc(32, 7));
   });
@@ -34,6 +35,7 @@ describe('loadConfig', () => {
       TRUST_PROXY: 'true',
       LOG_LEVEL: 'silent',
       MIGRATIONS_DIR: '/app/drizzle',
+      WEB_DIR: '/app/web',
     });
     expect(config).toMatchObject({
       port: 8080,
@@ -42,6 +44,7 @@ describe('loadConfig', () => {
       trustProxy: true,
       logLevel: 'silent',
       migrationsDir: '/app/drizzle',
+      webDir: '/app/web',
     });
   });
 
diff --git a/src/server/test/config.ts b/src/server/test/config.ts
index 06bb654..fea9efb 100644
--- a/src/server/test/config.ts
+++ b/src/server/test/config.ts
@@ -14,6 +14,7 @@ export function testConfig(overrides: Partial<Config> = {}): Config {
     trustProxy: true,
     logLevel: 'silent',
     migrationsDir: 'drizzle',
+    webDir: 'src/server/test/web-fixture',
     ...overrides,
   };
 }
PATCH
```

Create `src/server/http/web.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Db } from '../db/client';
import { createTestApp } from '../test/app';

// Serving files never touches the database.
const noDb = {} as Db;
const { client } = createTestApp(noDb);
const INDEX_TITLE = '<title>Budget Track (test build)</title>';

describe('the web app', () => {
  it('serves index.html at / and for the app routes, revalidated on every load', async () => {
    for (const path of ['/', '/index.html', '/budget', '/budget/2026-11', '/settings', '/accounts/4b0e6a51']) {
      const res = await client.get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toMatch(/^text\/html/);
      expect(res.headers.get('cache-control'), path).toBe('no-cache');
      expect(await res.text(), path).toContain(INDEX_TITLE);
    }
  });

  it('lets browsers keep hashed assets for a year', async () => {
    const res = await client.get('/assets/index-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await res.text()).toContain("'web app'");
  });

  it('revalidates the service worker and the manifest, so a new release is picked up', async () => {
    const sw = await client.get('/sw.js');
    expect(sw.status).toBe(200);
    expect(sw.headers.get('cache-control')).toBe('no-cache');
    const manifest = await client.get('/manifest.webmanifest');
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get('content-type')).toMatch(/^application\/manifest\+json/);
    expect(manifest.headers.get('cache-control')).toBe('no-cache');
  });

  it('sends the strict CSP and security headers with the app', async () => {
    const res = await client.get('/budget');
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('never answers /api or a missing file with the app', async () => {
    const notFound = { code: 'not_found', message: 'Not found.' };
    for (const path of ['/api', '/api/nope', '/api/budget.json', '/assets/missing.js', '/missing.png', '/assets/']) {
      const res = await client.get(path);
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual(notFound);
    }
    expect((await client.post('/budget')).status).toBe(404);
  });

  it('serves only the API when the web app is not built', async () => {
    const apiOnly = createTestApp(noDb, { config: { webDir: 'no/such/dir' } }).client;
    const res = await apiOnly.get('/budget');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'not_found', message: 'Not found.' });
  });
});
```

Create `src/server/test/web-fixture/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <title>Budget Track (test build)</title>
    <script type="module" crossorigin src="/assets/index-abc123.js"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
```

Create `src/server/test/web-fixture/assets/index-abc123.js`:

```js
export const fixture = 'web app';
```

Create `src/server/test/web-fixture/sw.js`:

```js
export const fixture = 'service worker';
```

Create `src/server/test/web-fixture/manifest.webmanifest`:

```json
{ "name": "Budget Track", "start_url": "/" }
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run src/server/http/web.test.ts src/server/config.test.ts`
Expected: FAIL — `Tests  5 failed | 7 passed (12)`: the three serving tests (`expected 404 to be 200`) and both config tests (no `webDir`). The CSP, the 404 for `/api` and missing files, and the API-only test pass already.

- [ ] **Step 3: Serve the build**

```bash
git apply <<'PATCH'
diff --git a/src/server/config.ts b/src/server/config.ts
index 2c7770f..a568b83 100644
--- a/src/server/config.ts
+++ b/src/server/config.ts
@@ -25,6 +25,7 @@ const EnvSchema = z.object({
   TRUST_PROXY: booleanString.default(false),
   LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
   MIGRATIONS_DIR: z.string().default('drizzle'),
+  WEB_DIR: z.string().default('dist/web'),
 });
 
 export type LogLevel = (typeof LOG_LEVELS)[number];
@@ -43,6 +44,8 @@ export interface Config {
   trustProxy: boolean;
   logLevel: LogLevel;
   migrationsDir: string;
+  /** The built web app (`npm run build:web`), served for every non-/api path. */
+  webDir: string;
 }
 
 /** Parses and validates the process environment; throws one error listing every invalid variable. */
@@ -60,5 +63,6 @@ export function loadConfig(env: Record<string, string | undefined> = process.env
     trustProxy: e.TRUST_PROXY,
     logLevel: e.LOG_LEVEL,
     migrationsDir: e.MIGRATIONS_DIR,
+    webDir: e.WEB_DIR,
   };
 }
PATCH
```

Create `src/server/http/web.ts`:

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { MiddlewareHandler } from 'hono';
import type { Logger } from '../logger';
import type { AppEnv } from './env';

/** Vite names the files in /assets after their content hash, so a URL there never changes its content. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

const isApi = (path: string) => path === '/api' || path.startsWith('/api/');

/** Paths the web app's router handles (/budget, /accounts/…): anything outside /assets that doesn't name a file. */
function isAppRoute(path: string): boolean {
  return !path.startsWith('/assets/') && !path.slice(path.lastIndexOf('/') + 1).includes('.');
}

/**
 * Serves the built PWA from `webDir` for GET and HEAD requests outside /api, with index.html for the app's own
 * routes (SPA fallback). Hashed assets are cached for a year; everything else (index.html, the service worker, the
 * manifest, icons) is revalidated on every load, so a new release reaches the browser. Without a build only the API
 * is served.
 */
export function serveWeb(webDir: string, logger: Logger): MiddlewareHandler<AppEnv> {
  if (!existsSync(join(webDir, 'index.html'))) {
    logger.warn({ webDir }, 'web app not built (npm run build:web); serving the API only');
    return (_c, next) => next();
  }
  const file = serveStatic({ root: webDir });
  const index = serveStatic({ root: webDir, path: 'index.html' });
  const notFound = async () => {};
  return async (c, next) => {
    const path = c.req.path;
    if (isApi(path)) return next();
    const res = (await file(c, notFound)) ?? (isAppRoute(path) ? await index(c, notFound) : undefined);
    if (!res) return next();
    res.headers.set('Cache-Control', path.startsWith('/assets/') ? IMMUTABLE : 'no-cache');
    return res;
  };
}
```

```bash
git apply <<'PATCH'
diff --git a/src/server/http/app.ts b/src/server/http/app.ts
index 4bdce99..a1bcb8b 100644
--- a/src/server/http/app.ts
+++ b/src/server/http/app.ts
@@ -22,6 +22,7 @@ import type { ClientIpResolver } from './client-ip';
 import type { AppEnv } from './env';
 import { AppError, errorHandler } from './errors';
 import { csrfGuard, noStore, requestLogger } from './middleware';
+import { serveWeb } from './web';
 
 export interface AppDeps {
   db: Db;
@@ -82,6 +83,8 @@ export function createApp(deps: AppDeps) {
     .route('/api/payees', payeeRoutes(deps))
     .route('/api/transactions', transactionRoutes(deps));
 
+  // Outside the chain above, so the RPC type (App) has only API routes; every API route matches first.
+  app.get('*', serveWeb(deps.config.webDir, deps.logger));
   app.notFound((c) => c.json<ApiErrorBody>({ code: 'not_found', message: 'Not found.' }, 404));
   app.onError(errorHandler);
   return app;
PATCH
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/server/http/web.test.ts src/server/config.test.ts`
Expected: `Tests  12 passed (12)`.

- [ ] **Step 5: Manifest, icons and the service worker**

Run: `npm install -D vite-plugin-pwa@^2.0.0`
Expected: `package.json` lists `"vite-plugin-pwa": "^2.0.0"` under `devDependencies`.

```bash
git apply <<'PATCH'
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -20,7 +20,8 @@
     "test:watch": "vitest",
     "typecheck": "tsc --noEmit && tsc --noEmit -p src/web/tsconfig.json",
     "lint": "eslint .",
-    "db:generate": "drizzle-kit generate"
+    "db:generate": "drizzle-kit generate",
+    "icons": "tsx scripts/generate-icons.ts"
   },
   "devDependencies": {
     "@eslint/js": "^10.0.1",
PATCH
```

Create `scripts/generate-icons.ts`:

```ts
/**
 * Writes the PWA icons to src/web/public: an SVG (also the favicon) and PNGs for the web app manifest and iOS.
 * The design is a white bar chart on brand green, drawn full-bleed so the PNGs also work as maskable icons (the bars
 * stay inside the central 80 % safe zone). Run with `npm run icons` after changing it; the output is committed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

const OUT = new URL('../src/web/public/', import.meta.url);
const BRAND: [number, number, number] = [0x15, 0x80, 0x3d];
const WHITE: [number, number, number] = [0xff, 0xff, 0xff];

/** Bars in units of the icon's size (0..1): left, top, width, height, corner radius. */
const BARS = [
  { x: 0.25, y: 0.5, w: 0.13, h: 0.24, r: 0.03 },
  { x: 0.435, y: 0.36, w: 0.13, h: 0.38, r: 0.03 },
  { x: 0.62, y: 0.24, w: 0.13, h: 0.5, r: 0.03 },
];

function svg(): string {
  const bars = BARS.map(
    (b) =>
      `<rect x="${b.x * 512}" y="${b.y * 512}" width="${b.w * 512}" height="${b.h * 512}" rx="${b.r * 512}" fill="#fff"/>`,
  ).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#15803d"/>${bars}</svg>\n`;
}

/** True when (px, py), in units of the icon's size, lies inside a bar (a rounded rectangle). */
function inBar(px: number, py: number): boolean {
  return BARS.some((b) => {
    const dx = Math.max(b.x + b.r - px, 0, px - (b.x + b.w - b.r));
    const dy = Math.max(b.y + b.r - py, 0, py - (b.y + b.h - b.r));
    return dx * dx + dy * dy <= b.r * b.r;
  });
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** An RGB PNG of the design at `size` × `size` pixels, anti-aliased with 4 × 4 samples per pixel. */
function png(size: number): Buffer {
  const SAMPLES = 4;
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3); // filter byte 0 (none), then RGB triples
    for (let x = 0; x < size; x++) {
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          if (inBar((x + (sx + 0.5) / SAMPLES) / size, (y + (sy + 0.5) / SAMPLES) / size)) covered++;
        }
      }
      const alpha = covered / (SAMPLES * SAMPLES);
      for (let c = 0; c < 3; c++) row[1 + x * 3 + c] = Math.round(BRAND[c]! + (WHITE[c]! - BRAND[c]!) * alpha);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit depth, truecolour, deflate, no filter, no interlace
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pixels = deflateSync(Buffer.concat(rows), { level: 9 });
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(new URL('icon.svg', OUT), svg());
for (const [name, size] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
] as const) {
  writeFileSync(new URL(name, OUT), png(size));
}
console.log('icons written to src/web/public');
```

Run: `npm run icons`
Expected: `icons written to src/web/public`, and exactly these files (`shasum -a 256 src/web/public/*`; the script is deterministic on Node 22's zlib):

| File | Bytes | SHA-256 |
|---|---|---|
| `src/web/public/icon.svg` | 361 | `59ec566602bf0cf711eec4f5261790ed6e33961f6787acda205e1ec46500e8ee` |
| `src/web/public/icon-192.png` | 852 | `36e57b52a000dd3407c16a100a70d694ef823f44d95af4cd616014856e56fb7a` |
| `src/web/public/icon-512.png` | 3300 | `f1d6a0feaa0f7982f2fe510b449c2f5b40ba58801ed4a4e5660e27df8c022ab4` |
| `src/web/public/apple-touch-icon.png` | 866 | `ad9b7b3d2c8f83d593de7f3c0326939ee29accb800afeec63ca575c81000891e` |

```bash
git apply <<'PATCH'
diff --git a/Dockerfile b/Dockerfile
index 4ca9d56..bca67f5 100644
--- a/Dockerfile
+++ b/Dockerfile
@@ -4,8 +4,9 @@ FROM node:22-alpine AS build
 WORKDIR /app
 COPY package.json package-lock.json ./
 RUN npm ci
-COPY tsconfig.json ./
+COPY tsconfig.json vite.config.ts ./
 COPY src ./src
+# The web app (dist/web, the PWA) and the server bundle (dist/server).
 RUN npm run build
 
 FROM node:22-alpine AS runtime
diff --git a/src/web/index.html b/src/web/index.html
index 1b7eb11..fc8d5e1 100644
--- a/src/web/index.html
+++ b/src/web/index.html
@@ -4,6 +4,8 @@
     <meta charset="UTF-8" />
     <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
     <meta name="theme-color" content="#15803d" />
+    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
+    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
     <title>Budget Track</title>
   </head>
   <body>
diff --git a/src/web/main.tsx b/src/web/main.tsx
index 59c81ed..89442ce 100644
--- a/src/web/main.tsx
+++ b/src/web/main.tsx
@@ -1,7 +1,10 @@
 import { StrictMode } from 'react';
 import { createRoot } from 'react-dom/client';
+import { registerSW } from 'virtual:pwa-register';
 import './styles.css';
 
+registerSW({ immediate: true });
+
 createRoot(document.getElementById('root')!).render(
   <StrictMode>
     <p className="p-4">Budget Track</p>
diff --git a/src/web/tsconfig.json b/src/web/tsconfig.json
index 6389e72..52ec7d8 100644
--- a/src/web/tsconfig.json
+++ b/src/web/tsconfig.json
@@ -5,7 +5,7 @@
   "compilerOptions": {
     "lib": ["ES2022", "DOM", "DOM.Iterable"],
     "jsx": "react-jsx",
-    "types": ["node", "vite/client"]
+    "types": ["node", "vite/client", "vite-plugin-pwa/client"]
   },
   "include": ["."],
   "exclude": []
diff --git a/tsconfig.json b/tsconfig.json
index dce5cd1..d1db8ba 100644
--- a/tsconfig.json
+++ b/tsconfig.json
@@ -18,6 +18,7 @@
   },
   "include": [
     "src",
+    "scripts",
     "vitest.config.ts",
     "vite.config.ts",
     "drizzle.config.ts"
diff --git a/vite.config.ts b/vite.config.ts
index 8ecf538..b6e499a 100644
--- a/vite.config.ts
+++ b/vite.config.ts
@@ -2,13 +2,47 @@ import { fileURLToPath } from 'node:url';
 import tailwindcss from '@tailwindcss/vite';
 import react from '@vitejs/plugin-react';
 import { defineConfig } from 'vite';
+import { VitePWA } from 'vite-plugin-pwa';
 
 /** `npm run dev:web` forwards these paths to the API server started by `npm run dev` (PORT=3080 in .env). */
 const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:3080';
 
 export default defineConfig({
   root: fileURLToPath(new URL('src/web', import.meta.url)),
-  plugins: [react(), tailwindcss()],
+  plugins: [
+    react(),
+    tailwindcss(),
+    VitePWA({
+      // main.tsx registers the service worker (virtual:pwa-register), so no inline script breaks the strict CSP.
+      injectRegister: false,
+      registerType: 'autoUpdate',
+      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
+      manifest: {
+        name: 'Budget Track',
+        short_name: 'Budget',
+        description: 'Personal zero-based budgeting',
+        lang: 'en',
+        start_url: '/',
+        scope: '/',
+        display: 'standalone',
+        orientation: 'portrait',
+        background_color: '#f3f4f6',
+        theme_color: '#15803d',
+        icons: [
+          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
+          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
+          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
+        ],
+      },
+      workbox: {
+        // Spec §11: the service worker caches only the app shell. It precaches the build and answers navigations
+        // with index.html; nothing else is routed through it, so /api requests always go to the network.
+        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
+        navigateFallback: '/index.html',
+        navigateFallbackDenylist: [/^\/api(\/|$)/, /^\/healthz$/],
+      },
+    }),
+  ],
   build: {
     outDir: fileURLToPath(new URL('dist/web', import.meta.url)),
     emptyOutDir: true,
PATCH
```

- [ ] **Step 6: Run the checks and the build**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: `Test Files  56 passed (56)`, `Tests  494 passed (494)` (+1 test file, +6 tests); the checks exit 0; Vite lists `dist/web/manifest.webmanifest` and a `workbox-window` chunk, then `PWA v2.0.0`, `mode      generateSW`, `precache  14 entries` and `dist/web/sw.js`; esbuild prints `Done`.
Optional check by hand: `docker build -t budget-track-check .` succeeds, and the container (with `DATABASE_URL`, `ENCRYPTION_KEY`, `SETUP_TOKEN`) answers `/budget` with `index.html` (`cache-control: no-cache`) and `/assets/index-*.js` with `public, max-age=31536000, immutable`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts Dockerfile scripts src/server src/web
git commit -m "feat(server): serve the PWA with SPA fallback and cache headers; manifest, icons and service worker" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---
### Task 5: The data layer: typed API client, errors, query cache and useOnline

Spec §2 (write path: typed Hono RPC call, then invalidate the matching queries; no optimistic updates), §11 Offline, §13. `api` is `hc<App>('/')` with the CSRF header on every request; its types come from the server's `App` (`import type`), and no server code is bundled. `unwrap(call)` returns the typed JSON body of a 2xx response and throws `ApiError` otherwise:
- `status`, `code`, `message`, `fieldErrors` (dotted paths), `formErrors`, `requestId`, and `retryAfter` from `Retry-After` (429 and 503);
- no response at all is status 0, code `network`; an error page that isn't the server's JSON (a proxy's 502) is `http_<status>` with a generic message;
- `isUnauthorized` (401 `unauthorized`, not a wrong password) and `isTransient` (no response or 5xx).

`formErrorsOf(error, shownFields)` splits a failure for a form: the first message of each field the form shows goes under it; messages for other fields, `formErrors` and every other error go above the submit button, with "You can try again in 30 seconds." when the server sent `Retry-After`. `zodFormErrors` does the same for a client-side check with a shared schema.

`createQueryClient(onUnauthorized)` sets the conventions: any 401 `unauthorized` from a query or mutation calls `onUnauthorized`; reads are fresh for 30 s and retry twice, only after network and server failures; mutations never retry by themselves. Query keys are `[area, ...params]`; `invalidateData` marks every query outside the `auth` area stale (after a command, undo or redo), and `forgetSession` drops them and records "signed out". `authStatusQuery` (`GET /api/auth/status`) never goes stale: setup, sign-in, sign-out and a 401 set it. `useOnline()` follows the browser's online state.

**Files:**
- Create: `src/web/lib/api.ts`, `src/web/lib/form-errors.ts`, `src/web/lib/query.ts`, `src/web/lib/online.ts`, `src/web/test/fake-api.ts`
- Modify: `package.json`, `package-lock.json`, `src/web/test/setup.ts`
- Test: `src/web/lib/api.test.ts`, `src/web/lib/form-errors.test.ts`, `src/web/lib/query.test.ts`, `src/web/lib/online.test.ts`

**Interfaces:**
- Consumes: `App` (`src/server/http/app.ts`, type only); `ApiErrorBody`, `CSRF_HEADER`, `CSRF_HEADER_VALUE` (`src/shared/http.ts`); `newPasswordSchema` (tests).
- Produces:
  - `api.ts`: `api`, `ApiError`, `NETWORK_ERROR_MESSAGE`, `UNEXPECTED_ERROR_MESSAGE`, `isUnauthorized`, `isTransient`, `OkBody<R>`, `unwrap(call)`.
  - `form-errors.ts`: `FormErrors { fields, form }`, `NO_ERRORS`, `formErrorsOf(error, shown)`, `zodFormErrors(error, shown)`.
  - `query.ts`: `queryKeys { authStatus, undo }`, `authStatusQuery`, `createQueryClient(onUnauthorized)`, `invalidateData(client)`, `forgetSession(client)`.
  - `online.ts`: `useOnline()`.
  - Test helpers: `fakeApi(routes)` → `{ fetch, requests }`, `json(body, status?, headers?)`, `FakeRequest`; `setup.ts` restores stubbed globals and mocks after each test.

- [ ] **Step 1: Add TanStack Query**

Run: `npm install -D @tanstack/react-query@^5.108.2`
Expected: `package.json` lists `"@tanstack/react-query": "^5.108.2"` under `devDependencies`.

- [ ] **Step 2: Write the failing tests**

Create `src/web/test/fake-api.ts`:

```ts
import { vi } from 'vitest';

export interface FakeRequest {
  method: string;
  /** Path and query, e.g. `/api/budget/2026-11`. */
  path: string;
  headers: Headers;
  /** The parsed JSON body, if any. */
  body: unknown;
}

type Reply = Response | { status?: number; body?: unknown; headers?: Record<string, string> };
type Handler = Reply | ((request: FakeRequest) => Reply | Promise<Reply>);

/** A JSON response, as the server sends it. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/**
 * Replaces `fetch` with a fake server for component tests. `routes` maps `"METHOD /path"` to a reply or a function
 * making one; unknown routes answer 404 like the server. Every request is recorded in `requests`.
 */
export function fakeApi(routes: Record<string, Handler>) {
  const requests: FakeRequest[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init.method ?? 'GET').toUpperCase();
    const text = typeof init.body === 'string' ? init.body : '';
    const request: FakeRequest = {
      method,
      path: url.pathname + url.search,
      headers: new Headers(init.headers),
      body: text ? JSON.parse(text) : undefined,
    };
    requests.push(request);
    const handler = routes[`${method} ${url.pathname}`];
    if (handler === undefined) return json({ code: 'not_found', message: 'Not found.' }, 404);
    const reply = typeof handler === 'function' ? await handler(request) : handler;
    return reply instanceof Response ? reply : json(reply.body ?? {}, reply.status ?? 200, reply.headers);
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, requests };
}
```

```bash
git apply <<'PATCH'
diff --git a/src/web/test/setup.ts b/src/web/test/setup.ts
index 7e98f1a..ef044bf 100644
--- a/src/web/test/setup.ts
+++ b/src/web/test/setup.ts
@@ -1,8 +1,10 @@
 import '@testing-library/jest-dom/vitest';
 import { cleanup } from '@testing-library/react';
-import { afterEach } from 'vitest';
+import { afterEach, vi } from 'vitest';
 
 // Vitest runs without globals, so Testing Library can't register its own cleanup.
 afterEach(() => {
   cleanup();
+  vi.unstubAllGlobals();
+  vi.restoreAllMocks();
 });
PATCH
```

Create `src/web/lib/api.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { fakeApi, json } from '../test/fake-api';
import { api, ApiError, isTransient, isUnauthorized, NETWORK_ERROR_MESSAGE, unwrap } from './api';

/** The error a call fails with. */
const failure = (call: Promise<unknown>) =>
  call.then(
    () => expect.unreachable('the call should have failed'),
    (error: unknown) => error,
  );

describe('api client', () => {
  it('returns the JSON body of a successful call', async () => {
    fakeApi({ 'GET /api/auth/status': { body: { setupRequired: false, authenticated: true } } });
    const status = await unwrap(api.api.auth.status.$get());
    expect(status).toEqual({ setupRequired: false, authenticated: true });
  });

  it('sends JSON bodies with the CSRF header', async () => {
    const { requests } = fakeApi({ 'POST /api/auth/login': { body: { recoveryCodesRemaining: 10 } } });
    await unwrap(api.api.auth.login.$post({ json: { password: 'correct horse', totpCode: '123456' } }));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get('X-Requested-With')).toBe('budget-track');
    expect(requests[0]!.headers.get('content-type')).toMatch(/^application\/json/);
    expect(requests[0]!.body).toEqual({ password: 'correct horse', totpCode: '123456' });
  });

  it('keeps the dotted field paths of validation errors', async () => {
    const body = {
      code: 'validation',
      message: 'Some fields are invalid.',
      fieldErrors: { 'lines.1.amount': ['Enter an amount.'] },
      formErrors: ['Enter either a code or a recovery code.'],
    };
    fakeApi({ 'POST /api/undo': { status: 400, body } });
    const error = (await failure(unwrap(api.api.undo.$post()))) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: 'validation', message: 'Some fields are invalid.' });
    expect(error.fieldErrors).toEqual({ 'lines.1.amount': ['Enter an amount.'] });
    expect(error.formErrors).toEqual(['Enter either a code or a recovery code.']);
  });

  it('reports domain errors, conflicts and server errors with their code and message', async () => {
    const cases = [
      { status: 422, body: { code: 'account_not_empty', message: 'The balance must be 0 first.' } },
      { status: 409, body: { code: 'undo_conflict', message: "Can't undo: data changed since." } },
      { status: 500, body: { code: 'internal', message: 'Something went wrong.', requestId: 'req-1' } },
    ];
    for (const reply of cases) {
      fakeApi({ 'POST /api/undo': reply });
      const error = (await failure(unwrap(api.api.undo.$post()))) as ApiError;
      expect(error).toMatchObject({ status: reply.status, ...reply.body, fieldErrors: {}, retryAfter: null });
    }
  });

  it('reads Retry-After from 429 and 503 responses', async () => {
    const limited = { code: 'rate_limited', message: 'Too many sign-in attempts. Wait a minute and try again.' };
    fakeApi({ 'POST /api/auth/login': json(limited, 429, { 'Retry-After': '30' }) });
    const error = await failure(unwrap(api.api.auth.login.$post({ json: { password: 'p', totpCode: '123456' } })));
    expect(error).toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 30 });
  });

  it('turns a failed connection into a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    const error = await failure(unwrap(api.api.auth.status.$get()));
    expect(error).toMatchObject({ status: 0, code: 'network', message: NETWORK_ERROR_MESSAGE });
    expect(isTransient(error)).toBe(true);
  });

  it('copes with error pages that are not JSON', async () => {
    fakeApi({ 'GET /api/auth/status': new Response('<html>Bad gateway</html>', { status: 502 }) });
    const error = await failure(unwrap(api.api.auth.status.$get()));
    expect(error).toMatchObject({ status: 502, code: 'http_502', message: 'Something went wrong. Try again.' });
    expect(isTransient(error)).toBe(true);
  });

  it('tells an expired session apart from wrong credentials', () => {
    expect(isUnauthorized(new ApiError(401, { code: 'unauthorized', message: 'Please sign in.' }))).toBe(true);
    expect(isUnauthorized(new ApiError(401, { code: 'invalid_credentials', message: 'Wrong password or code.' }))).toBe(false);
    expect(isUnauthorized(new Error('nope'))).toBe(false);
  });
});
```

Create `src/web/lib/form-errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { newPasswordSchema } from '../../shared/auth';
import { ApiError } from './api';
import { formErrorsOf, NO_ERRORS, zodFormErrors } from './form-errors';

const validation = (fieldErrors: Record<string, string[]>, formErrors: string[] = []) =>
  new ApiError(400, { code: 'validation', message: 'Some fields are invalid.', fieldErrors, formErrors });

describe('formErrorsOf', () => {
  it('shows nothing without an error', () => {
    expect(formErrorsOf(null, ['password'])).toEqual(NO_ERRORS);
  });

  it('puts field messages under the fields the form shows, by dotted path', () => {
    const error = validation({ password: ['Use at least 12 characters.', 'second'], 'lines.1.amount': ['Enter an amount.'] });
    expect(formErrorsOf(error, ['password', 'lines.1.amount'])).toEqual({
      fields: { password: 'Use at least 12 characters.', 'lines.1.amount': 'Enter an amount.' },
      form: null,
    });
  });

  it('moves messages for fields the form does not show, and form-level ones, above the button', () => {
    const error = validation({ totpSecret: ['Invalid authenticator secret.'] }, ['Enter either a code or a recovery code.']);
    expect(formErrorsOf(error, ['password'])).toEqual({
      fields: {},
      form: 'Enter either a code or a recovery code. Invalid authenticator secret.',
    });
  });

  it('shows a domain error about one field under it, and other errors above the button', () => {
    const onField = new ApiError(422, {
      code: 'invalid_totp_code',
      message: "That code didn't match.",
      fieldErrors: { totpCode: ["That code didn't match."] },
    });
    expect(formErrorsOf(onField, ['totpCode'])).toEqual({ fields: { totpCode: "That code didn't match." }, form: null });
    const conflict = new ApiError(409, { code: 'undo_conflict', message: "Can't undo: data changed since." });
    expect(formErrorsOf(conflict, [])).toEqual({ fields: {}, form: "Can't undo: data changed since." });
    expect(formErrorsOf(new TypeError('x'), [])).toEqual({ fields: {}, form: 'Something went wrong. Try again.' });
  });

  it('says when to try again after a rate limit', () => {
    const limited = (retryAfter: number) =>
      new ApiError(429, { code: 'rate_limited', message: 'Too many sign-in attempts.' }, retryAfter);
    expect(formErrorsOf(limited(30), []).form).toBe('Too many sign-in attempts. You can try again in 30 seconds.');
    expect(formErrorsOf(limited(870), []).form).toBe('Too many sign-in attempts. You can try again in 15 minutes.');
  });
});

describe('zodFormErrors', () => {
  it('reports a shared schema the way the server would', () => {
    const schema = z.object({ password: newPasswordSchema, lines: z.array(z.object({ amount: z.int() })) });
    const result = schema.safeParse({ password: 'short', lines: [{ amount: 1 }, { amount: 'x' }] });
    expect(zodFormErrors(result.error!, ['password', 'lines.1.amount'])).toEqual({
      fields: { password: 'Use at least 12 characters.', 'lines.1.amount': expect.any(String) },
      form: null,
    });
  });
});
```

Create `src/web/lib/query.test.ts`:

```ts
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { createQueryClient, forgetSession, invalidateData, queryKeys } from './query';

const unauthorized = new ApiError(401, { code: 'unauthorized', message: 'Please sign in.' });
const wrongPassword = new ApiError(401, { code: 'invalid_credentials', message: 'Wrong password or code.' });

describe('createQueryClient', () => {
  it('reports an expired session from any query or mutation, but not a failed sign-in', async () => {
    const onUnauthorized = vi.fn();
    const client = createQueryClient(onUnauthorized);
    await client.fetchQuery({ queryKey: ['budget', '2026-11'], queryFn: () => Promise.reject(unauthorized) }).catch(() => {});
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    const mutate = (error: ApiError) =>
      client.getMutationCache().build(client, { mutationFn: () => Promise.reject(error) }).execute(undefined).catch(() => {});
    await mutate(unauthorized);
    expect(onUnauthorized).toHaveBeenCalledTimes(2);
    await mutate(wrongPassword);
    expect(onUnauthorized).toHaveBeenCalledTimes(2);
  });

  it('retries reads only after network and server failures', () => {
    const retry = createQueryClient(() => {}).getDefaultOptions().queries!.retry as (n: number, e: unknown) => boolean;
    expect(retry(0, new ApiError(0, { code: 'network', message: '' }))).toBe(true);
    expect(retry(1, new ApiError(503, { code: 'busy', message: '' }))).toBe(true);
    expect(retry(2, new ApiError(503, { code: 'busy', message: '' }))).toBe(false);
    expect(retry(0, new ApiError(422, { code: 'x', message: '' }))).toBe(false);
    expect(retry(0, unauthorized)).toBe(false);
  });
});

describe('cache helpers', () => {
  function seeded() {
    const client = new QueryClient();
    client.setQueryData(queryKeys.authStatus, { setupRequired: false, authenticated: true });
    client.setQueryData(['budget', '2026-11'], { month: '2026-11' });
    client.setQueryData(queryKeys.undo, { undo: null, redo: null });
    return client;
  }

  it('invalidateData marks every budget-data query stale, but not the auth status', async () => {
    const client = seeded();
    await invalidateData(client);
    const stale = (key: readonly unknown[]) => client.getQueryState(key)!.isInvalidated;
    expect([stale(['budget', '2026-11']), stale(queryKeys.undo), stale(queryKeys.authStatus)]).toEqual([true, true, false]);
  });

  it('forgetSession drops the budget data and records that nobody is signed in', () => {
    const client = seeded();
    forgetSession(client);
    expect(client.getQueryData(['budget', '2026-11'])).toBeUndefined();
    expect(client.getQueryData(queryKeys.undo)).toBeUndefined();
    expect(client.getQueryData(queryKeys.authStatus)).toEqual({ setupRequired: false, authenticated: false });
  });
});
```

Create `src/web/lib/online.test.ts`:

```ts
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useOnline } from './online';

describe('useOnline', () => {
  it('follows the browser going offline and back online', () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const { result } = renderHook(() => useOnline());
    expect(result.current).toBe(true);
    act(() => {
      onLine.mockReturnValue(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(result.current).toBe(false);
    act(() => {
      onLine.mockReturnValue(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(result.current).toBe(true);
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run src/web/lib/api.test.ts src/web/lib/form-errors.test.ts src/web/lib/query.test.ts src/web/lib/online.test.ts`
Expected: FAIL — `Test Files  4 failed (4)`, `Tests  no tests`: `Failed to resolve import "./api"` (and `"./online"`).

- [ ] **Step 4: Implement the data layer**

Create `src/web/lib/api.ts`:

```ts
import { type ClientResponse, hc } from 'hono/client';
import type { SuccessStatusCode } from 'hono/utils/http-status';
import type { App } from '../../server/http/app';
import { type ApiErrorBody, CSRF_HEADER, CSRF_HEADER_VALUE } from '../../shared/http';

/**
 * The typed Hono RPC client for every /api route (`api.api.budget[':month'].$get({ param: { month } })`). Its types
 * come from the server's `App` type only; no server code is bundled. Every request carries the CSRF header the server
 * requires on mutations (spec §12).
 */
export const api = hc<App>('/', { headers: { [CSRF_HEADER]: CSRF_HEADER_VALUE } });

/** A failed API call (spec §13): any non-2xx response, or no response at all (status 0, code "network"). */
export class ApiError extends Error {
  readonly code: string;
  /** Messages per request field, keyed by dotted path (`lines.1.amount`): 400 validation and some 422s. */
  readonly fieldErrors: Record<string, string[]>;
  /** Validation messages not tied to one field. */
  readonly formErrors: string[];
  readonly requestId: string | undefined;

  constructor(
    readonly status: number,
    body: ApiErrorBody,
    /** Seconds the server asked to wait before trying again (`Retry-After` on 429 and 503). */
    readonly retryAfter: number | null = null,
  ) {
    super(body.message);
    this.name = 'ApiError';
    this.code = body.code;
    this.fieldErrors = body.fieldErrors ?? {};
    this.formErrors = body.formErrors ?? [];
    this.requestId = body.requestId;
  }
}

export const NETWORK_ERROR_MESSAGE = "Can't reach the server. Check your connection and try again.";
export const UNEXPECTED_ERROR_MESSAGE = 'Something went wrong. Try again.';

/** True for the 401 every private route answers without a live session (not a wrong password at sign-in). */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401 && error.code === 'unauthorized';
}

/** Worth retrying unchanged: no response, or a server-side failure. */
export function isTransient(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status >= 500);
}

function isErrorBody(body: unknown): body is ApiErrorBody {
  const b = body as Partial<ApiErrorBody> | null;
  return typeof b?.code === 'string' && typeof b.message === 'string';
}

async function errorOf(res: Response): Promise<ApiError> {
  const seconds = Number(res.headers.get('retry-after'));
  const retryAfter = Number.isInteger(seconds) && seconds > 0 ? seconds : null;
  const body: unknown = await res.json().catch(() => null);
  // Something in between (a proxy, a gateway timeout) may answer with a page of its own.
  const known = isErrorBody(body) ? body : { code: `http_${res.status}`, message: UNEXPECTED_ERROR_MESSAGE };
  return new ApiError(res.status, known, retryAfter);
}

/** The JSON body type of an RPC response's 2xx statuses. */
export type OkBody<R> =
  R extends ClientResponse<infer T, infer S, infer F> ? (S extends SuccessStatusCode ? (F extends 'json' ? T : never) : never) : never;

/** Awaits an RPC call and returns its JSON body; throws ApiError for anything but a 2xx response. */
export async function unwrap<R extends ClientResponse<unknown, number, string>>(call: Promise<R>): Promise<OkBody<R>> {
  let res: R;
  try {
    res = await call;
  } catch {
    throw new ApiError(0, { code: 'network', message: NETWORK_ERROR_MESSAGE });
  }
  if (!res.ok) throw await errorOf(res as unknown as Response);
  return (await res.json()) as OkBody<R>;
}
```

Create `src/web/lib/form-errors.ts`:

```ts
import type { z } from 'zod';
import { ApiError, UNEXPECTED_ERROR_MESSAGE } from './api';

/** What a form shows for a failed request: messages under its fields and one message above the submit button. */
export interface FormErrors {
  /** The first message per field, keyed by the dotted path the server uses (`password`, `lines.1.amount`). */
  fields: Record<string, string>;
  form: string | null;
}

export const NO_ERRORS: FormErrors = { fields: {}, form: null };

function waitText(seconds: number): string {
  return seconds < 60 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`;
}

/**
 * Splits a failed request into field and form messages (spec §13). Field messages (400 validation, a 422 about one
 * field) go under the fields in `shown`; messages for any other field, `formErrors` and every other error go to the
 * form. A 429/503 says when to try again (`Retry-After`).
 */
export function formErrorsOf(error: unknown, shown: readonly string[]): FormErrors {
  if (error === null || error === undefined) return NO_ERRORS;
  if (!(error instanceof ApiError)) return { fields: {}, form: UNEXPECTED_ERROR_MESSAGE };
  const fields: Record<string, string> = {};
  const elsewhere: string[] = [...error.formErrors];
  for (const [path, messages] of Object.entries(error.fieldErrors)) {
    if (!messages[0]) continue;
    if (shown.includes(path)) fields[path] ??= messages[0];
    else elsewhere.push(messages[0]);
  }
  let form = elsewhere.length > 0 ? elsewhere.join(' ') : null;
  if (form === null && Object.keys(fields).length === 0) form = error.message;
  if (form !== null && error.retryAfter !== null) form = `${form} You can try again in ${waitText(error.retryAfter)}.`;
  return { fields, form };
}

/** The same split for a client-side check with a shared zod schema (issues keyed by dotted path, like the server). */
export function zodFormErrors(error: z.core.$ZodError, shown: readonly string[]): FormErrors {
  const fieldErrors: Record<string, string[]> = {};
  const formErrors: string[] = [];
  for (const issue of error.issues) {
    if (issue.path.length === 0) formErrors.push(issue.message);
    else (fieldErrors[issue.path.map(String).join('.')] ??= []).push(issue.message);
  }
  return formErrorsOf(
    new ApiError(400, { code: 'validation', message: 'Some fields are invalid.', fieldErrors, formErrors }),
    shown,
  );
}
```

Create `src/web/lib/query.ts`:

```ts
import { MutationCache, QueryCache, QueryClient, queryOptions } from '@tanstack/react-query';
import { api, isTransient, isUnauthorized, unwrap } from './api';

/**
 * Query keys: `[area, ...params]`, e.g. `['budget', '2026-11']` or `['accounts']`. Every area except `auth` holds
 * budget data, which commands, undo and redo may change (see invalidateData).
 */
export const queryKeys = {
  authStatus: ['auth', 'status'],
  undo: ['undo'],
} as const;

/** GET /api/auth/status: whether setup is needed and whether this browser is signed in. Route guards read it. */
export const authStatusQuery = queryOptions({
  queryKey: queryKeys.authStatus,
  queryFn: () => unwrap(api.api.auth.status.$get()),
  // Changed only by setting the data after setup, sign-in and sign-out, or a 401 (see createQueryClient).
  staleTime: Infinity,
});

/**
 * The app's QueryClient. Spec §2: mutations wait for the server (no optimistic updates) and then refresh what they
 * changed. Any 401 `unauthorized` (an expired or revoked session) calls `onUnauthorized`, which sends the user to
 * sign in. Reads retry twice after network and server failures; mutations never retry on their own.
 */
export function createQueryClient(onUnauthorized: () => void): QueryClient {
  const signedOut = (error: unknown) => {
    if (isUnauthorized(error)) onUnauthorized();
  };
  return new QueryClient({
    queryCache: new QueryCache({ onError: signedOut }),
    mutationCache: new MutationCache({ onError: signedOut }),
    defaultOptions: {
      queries: { staleTime: 30_000, retry: (failures, error) => failures < 2 && isTransient(error) },
      mutations: { retry: false },
    },
  });
}

/** After a command, undo or redo: marks every budget-data query stale and refetches those on screen. */
export function invalidateData(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'auth' });
}

/** After signing out (or a 401): forgets every budget-data query and records that nobody is signed in. */
export function forgetSession(queryClient: QueryClient): void {
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'auth' });
  queryClient.setQueryData(queryKeys.authStatus, { setupRequired: false, authenticated: false });
}
```

Create `src/web/lib/online.ts`:

```ts
import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/**
 * Whether the browser is online (spec §11 "Offline"). Every control that sends a command is disabled while this is
 * false: `<Button mutating>` does it for buttons, `<OfflineBanner>` explains why.
 */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/web/lib/api.test.ts src/web/lib/form-errors.test.ts src/web/lib/query.test.ts src/web/lib/online.test.ts`
Expected: `Tests  19 passed (19)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  60 passed (60)`, `Tests  513 passed (513)` (+4 test files, +19 tests); both checks exit 0. `npm run typecheck` now checks the RPC types: `api.api.auth.login.$post({ json })` only accepts a `LoginRequest`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/web/lib src/web/test
git commit -m "feat(web): typed API client, error normalization, query cache conventions and useOnline" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---
### Task 6: The amount keypad and the component kit

Spec §11 ("calculator keypad that accepts `+ − × ÷` expressions"), §14 Web (component tests for the keypad's parser), §6 (pill colours). `evaluateAmount(expression)` reads złoty amounts with a decimal comma or point (at most two decimals each, spaces ignored), `+ − × ÷` (and `- * x /`) with × and ÷ binding tighter, and signs on numbers. It computes exactly with bigint fractions and rounds only the result to grosze, half away from zero (spec §2, via the engine's `roundDiv`); an empty expression is 0. Errors are messages for the user: "Finish the calculation.", "Can't divide by 0.", "Use at most 2 decimal places.", "That amount is too large." (beyond ±2^53).

`AmountKeypad` shows the expression (thousands grouped) and its result, starts from the current amount (a digit replaces it, an operator extends it, as on a calculator), works with a hardware keyboard, and keeps Done disabled while the expression doesn't evaluate. The kit is what P3b and P3c build screens from:
- `Button` (`primary`/`secondary`/`ghost`/`danger`; `type="button"` unless told otherwise; `busy` shows a spinner; `mutating` disables it offline with the title "You're offline");
- `TextField` (label, hint or error tied to the input with `aria-describedby`), `Checkbox`, `SegmentedControl` (a radio group), `FormError` (an alert);
- `Pill` (green/yellow/red/grey, spec §6);
- `Sheet`: a bottom-sheet modal dialog (focus moves in and back, Escape and a tap outside close it, the page behind doesn't scroll);
- toasts: `ToastProvider` / `useToast().show({ message, tone, action, key, duration })`, at most three, a toast with the same `key` replaces the old one, errors are alerts and stay 8 s instead of 5 s;
- stroke icons as inline SVG, and `cx` for class names.

**Files:**
- Create: `src/web/lib/amount-expression.ts`, `src/web/ui/{amount-keypad,button,field,pill,sheet,toast,icons}.tsx`, `src/web/ui/cx.ts`
- Test: `src/web/lib/amount-expression.test.ts`, `src/web/ui/amount-keypad.test.tsx`, `src/web/ui/kit.test.tsx`, `src/web/ui/sheet.test.tsx`, `src/web/ui/toast.test.tsx`

**Interfaces:**
- Consumes: `roundDiv` (`src/engine/money.ts`), `formatMoney`, `useOnline`.
- Produces:
  - `amount-expression.ts`: `AmountResult`, `OPERATORS`, `evaluateAmount(expression)`, `amountToExpression(minor)`, `formatExpression(expression)`.
  - `ui/`: `AmountKeypad { value, currency?, onDone, doneLabel?, mutating?, busy? }`, `Button`, `ButtonVariant`, `TextField`, `FormError`, `Checkbox`, `SegmentedControl`, `Pill`, `PillTone`, `Sheet { open, onClose, title }`, `ToastProvider`, `useToast`, `ToastApi`, `ToastOptions`, `cx`, and the icons `UndoIcon`, `RedoIcon`, `PlusIcon`, `BudgetIcon`, `AccountsIcon`, `MoreIcon`, `CloseIcon`, `BackspaceIcon`, `ChevronRightIcon`, `OfflineIcon`.

- [ ] **Step 1: Write the failing tests**

Create `src/web/lib/amount-expression.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { amountToExpression, evaluateAmount, formatExpression } from './amount-expression';

const value = (expression: string) => {
  const result = evaluateAmount(expression);
  return result.ok ? result.value : result.error;
};

describe('evaluateAmount', () => {
  it('reads złoty amounts with a decimal comma or point into grosze', () => {
    expect(value('12')).toBe(1200);
    expect(value('12,5')).toBe(1250);
    expect(value('12.05')).toBe(1205);
    expect(value(',5')).toBe(50);
    expect(value('7,')).toBe(700);
    expect(value('1 234,56')).toBe(123456);
    expect(value('')).toBe(0);
  });

  it('adds, subtracts, multiplies and divides, × and ÷ before + and −', () => {
    expect(value('100+20,5')).toBe(12050);
    expect(value('100−20,5')).toBe(7950);
    expect(value('12,50×3')).toBe(3750);
    expect(value('90÷4')).toBe(2250);
    expect(value('10+2×3')).toBe(1600);
    expect(value('10−6÷3')).toBe(800);
    expect(value('2×3+4×5')).toBe(2600);
    expect(value('100−20−30')).toBe(5000);
    expect(value('100÷2÷5')).toBe(1000);
  });

  it('takes the ASCII operators too', () => {
    expect(value('10-2*3+8/4')).toBe(600);
    expect(value('3x4')).toBe(1200);
  });

  it('allows signs on numbers', () => {
    expect(value('−50')).toBe(-5000);
    expect(value('-50+20')).toBe(-3000);
    expect(value('100×−1')).toBe(-10000);
    expect(value('−−5')).toBe(500);
    expect(value('+5')).toBe(500);
  });

  it('computes exactly and rounds only the result, half away from zero', () => {
    expect(value('100÷3')).toBe(3333);
    expect(value('200÷3')).toBe(6667);
    expect(value('100÷3×3')).toBe(10000);
    expect(value('0,01÷2')).toBe(1);
    expect(value('−0,01÷2')).toBe(-1);
    expect(value('0,1+0,2')).toBe(30);
    expect(value('1,15×100')).toBe(11500);
  });

  it('explains what is wrong with an expression it cannot evaluate', () => {
    expect(value('12+')).toBe('Finish the calculation.');
    expect(value('×3')).toBe('Finish the calculation.');
    expect(value('5÷0')).toBe("Can't divide by 0.");
    expect(value('5÷(2)')).toBe('"(" can\'t be used in an amount.');
    expect(value('1,234')).toBe('Use at most 2 decimal places.');
    expect(value('1,2,3')).toBe('Check the amount.');
    expect(value(',')).toBe('Check the amount.');
    expect(value('99999999999999')).toBe('That amount is too large.');
    expect(value('90071992547409,91')).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('keypad helpers', () => {
  it('start the keypad from an amount', () => {
    expect(amountToExpression(123456)).toBe('1234,56');
    expect(amountToExpression(100000)).toBe('1000');
    expect(amountToExpression(5)).toBe('0,05');
    expect(amountToExpression(-2550)).toBe('−25,50');
    expect(amountToExpression(0)).toBe('0');
    for (const amount of [123456, 100000, 5, -2550, 0, Number.MAX_SAFE_INTEGER]) {
      expect(value(amountToExpression(amount))).toBe(amount);
    }
  });

  it('display an expression with grouped thousands and spaced operators', () => {
    expect(formatExpression('1234,5+20000')).toBe('1\u00a0234,5 + 20\u00a0000');
    expect(formatExpression('−1234,5678×3')).toBe('−1\u00a0234,5678 × 3');
    expect(formatExpression('12÷')).toBe('12 ÷ ');
    expect(formatExpression('100×−1')).toBe('100 × −1');
  });
});
```

Create `src/web/ui/amount-keypad.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AmountKeypad } from './amount-keypad';

// toHaveTextContent collapses whitespace, so the no-break spaces of formatted amounts compare equal to spaces.

function setup(value = 0) {
  const onDone = vi.fn();
  render(<AmountKeypad value={value} onDone={onDone} />);
  const tap = async (...names: string[]) => {
    for (const name of names) await userEvent.click(screen.getByRole('button', { name }));
  };
  return { onDone, tap };
}

describe('AmountKeypad', () => {
  it('starts from the amount, which the first digit replaces', async () => {
    const { onDone, tap } = setup(123456);
    expect(screen.getByTestId('keypad-expression')).toHaveTextContent('1 234,56');
    await tap('4', '2', 'Decimal comma', '5');
    expect(screen.getByTestId('keypad-expression')).toHaveTextContent('42,5');
    expect(screen.getByTestId('keypad-result')).toHaveTextContent('= 42,50 zł');
    await tap('Done');
    expect(onDone).toHaveBeenCalledWith(4250);
  });

  it('calculates with + − × ÷ on top of the starting amount', async () => {
    const { onDone, tap } = setup(10000);
    await tap('Plus', '2', '0', 'Multiply', '3');
    expect(screen.getByTestId('keypad-expression')).toHaveTextContent('100 + 20 × 3');
    expect(screen.getByTestId('keypad-result')).toHaveTextContent('= 160,00 zł');
    await tap('Minus', '1', '0', 'Divide', '4', 'Done');
    expect(onDone).toHaveBeenCalledWith(15750);
  });

  it('deletes the last character, or the whole starting amount', async () => {
    const { tap } = setup(5000);
    await tap('Delete');
    expect(screen.getByTestId('keypad-expression')).toHaveTextContent('0');
    await tap('7', '5', 'Delete');
    expect(screen.getByTestId('keypad-expression')).toHaveTextContent('7');
  });

  it('explains an unfinished calculation and keeps Done disabled', async () => {
    const { onDone, tap } = setup(0);
    await tap('5', 'Divide');
    expect(screen.getByTestId('keypad-result')).toHaveTextContent('Finish the calculation.');
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    await tap('0');
    expect(screen.getByTestId('keypad-result')).toHaveTextContent("Can't divide by 0.");
    expect(onDone).not.toHaveBeenCalled();
  });

  it('works with a hardware keyboard', async () => {
    const { onDone } = setup(0);
    await userEvent.click(screen.getByRole('button', { name: '1' }));
    await userEvent.keyboard('2*3.5-1{Backspace}2{Enter}');
    expect(screen.getByTestId('keypad-expression')).toHaveTextContent('12 × 3,5 − 2');
    expect(onDone).toHaveBeenCalledWith(4000);
  });

  it('shows foreign currencies by their code', () => {
    render(<AmountKeypad value={250} currency="EUR" onDone={() => {}} />);
    expect(screen.getByTestId('keypad-result')).toHaveTextContent('= 2,50 EUR');
  });
});
```

Create `src/web/ui/kit.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './button';
import { Checkbox, FormError, SegmentedControl, TextField } from './field';
import { Pill } from './pill';

describe('Button', () => {
  it('is a plain button unless it submits, and is disabled while busy', async () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('type', 'button');
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <Button busy onClick={onClick}>
        Save
      </Button>,
    );
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });

  it('disables a mutating button while offline (spec §11)', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(
      <>
        <Button mutating>Assign</Button>
        <Button>Cancel</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Assign' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Assign' })).toHaveAttribute('title', "You're offline");
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });
});

describe('form controls', () => {
  it('label inputs and tie their error to them', () => {
    render(<TextField label="Password" error="Use at least 12 characters." hint="12 or more characters" />);
    const input = screen.getByLabelText('Password');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Use at least 12 characters.');
  });

  it('show a hint when there is no error, and a form error only when there is one', () => {
    const { rerender } = render(
      <>
        <TextField label="Code" hint="6 digits" />
        <FormError message={null} />
      </>,
    );
    expect(screen.getByLabelText('Code')).toHaveAccessibleDescription('6 digits');
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(<FormError message="Wrong password or code." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Wrong password or code.');
  });

  it('switch between options and tick boxes', async () => {
    const onChange = vi.fn();
    const options = [
      { value: 'outflow', label: 'Outflow' },
      { value: 'inflow', label: 'Inflow' },
    ] as const;
    render(
      <>
        <SegmentedControl label="Direction" value="outflow" options={options} onChange={onChange} />
        <Checkbox label="I saved my recovery codes" />
      </>,
    );
    expect(screen.getByRole('radio', { name: 'Outflow' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(screen.getByRole('radio', { name: 'Inflow' }));
    expect(onChange).toHaveBeenCalledWith('inflow');
    await userEvent.click(screen.getByLabelText('I saved my recovery codes'));
    expect(screen.getByRole('checkbox')).toBeChecked();
  });
});

describe('Pill', () => {
  it('colours an amount by its tone', () => {
    render(<Pill tone="red">-30,00 zł</Pill>);
    expect(screen.getByText('-30,00 zł')).toHaveAttribute('data-tone', 'red');
  });
});
```

Create `src/web/ui/sheet.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Sheet } from './sheet';

function Harness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Rename
      </button>
      <Sheet
        open={open}
        title="Rename payee"
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
      >
        <label>
          Name <input />
        </label>
      </Sheet>
    </>
  );
}

describe('Sheet', () => {
  it('opens as a modal dialog with focus inside, and gives focus back when it closes', async () => {
    render(<Harness />);
    expect(screen.queryByRole('dialog')).toBeNull();
    const opener = screen.getByRole('button', { name: 'Rename' });
    await userEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Rename payee' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
  });

  it('closes on Escape and on a tap outside', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await userEvent.click(screen.getByTestId('sheet-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
```

Create `src/web/ui/toast.test.tsx`:

```tsx
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { type ToastApi, ToastProvider, useToast } from './toast';

function renderToasts() {
  let api!: ToastApi;
  function Grab() {
    api = useToast();
    return null;
  }
  render(
    <ToastProvider>
      <Grab />
    </ToastProvider>,
  );
  return () => api;
}

describe('toasts', () => {
  it('show a message with an action that runs and dismisses it', async () => {
    const toasts = renderToasts();
    const undo = vi.fn();
    act(() => {
      toasts().show({ message: 'Rename payee "Lidl"', action: { label: 'Undo', onClick: undo } });
    });
    expect(screen.getByRole('status')).toHaveTextContent('Rename payee "Lidl"');
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('replace a toast with the same key and announce errors as alerts', () => {
    const toasts = renderToasts();
    act(() => {
      toasts().show({ message: 'First command', key: 'command' });
      toasts().show({ message: 'Second command', key: 'command' });
      toasts().show({ message: "Can't undo: data changed since.", tone: 'error' });
    });
    expect(screen.getAllByRole('status').map((el) => el.textContent)).toEqual(['Second command']);
    expect(screen.getByRole('alert')).toHaveTextContent("Can't undo: data changed since.");
  });

  it('go away by themselves', () => {
    vi.useFakeTimers();
    try {
      const toasts = renderToasts();
      act(() => {
        toasts().show({ message: 'Saved' });
        toasts().show({ message: 'Failed', tone: 'error' });
      });
      act(() => vi.advanceTimersByTime(5000));
      expect(screen.queryByText('Saved')).toBeNull();
      expect(screen.getByText('Failed')).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(3000));
      expect(screen.queryByText('Failed')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run src/web/lib/amount-expression.test.ts src/web/ui`
Expected: FAIL — `Test Files  5 failed (5)`, `Tests  no tests`: `Failed to resolve import "./amount-expression"` (and `"./amount-keypad"`, `"./button"`, `"./sheet"`, `"./toast"`).

- [ ] **Step 3: The keypad's calculator**

Create `src/web/lib/amount-expression.ts`:

```ts
import { roundDiv } from '../../engine/money';

/**
 * The amount keypad's calculator (spec §11 "Assign: calculator keypad that accepts + − × ÷ expressions"). Numbers are
 * in major units (złoty) with a decimal comma or point and at most two decimals; × and ÷ bind tighter than + and −,
 * and a number may carry a sign. The arithmetic is exact (fractions of bigints); only the result is rounded to minor
 * units, half away from zero, like every other amount (spec §2). Spaces are ignored, so "1 234,56" works too.
 */
export type AmountResult = { ok: true; value: number } | { ok: false; error: string };

export const OPERATORS = { add: '+', subtract: '−', multiply: '×', divide: '÷' } as const;

const ALIASES: Record<string, string> = { '-': '−', '*': '×', x: '×', '/': '÷', '.': ',' };

interface Fraction {
  n: bigint;
  d: bigint;
}

type Token = { kind: 'number'; text: string } | { kind: 'op'; op: string };

class ExpressionError extends Error {}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  for (const raw of expression.replace(/[\s\u00a0\u202f]/g, '')) {
    const char = ALIASES[raw] ?? raw;
    const last = tokens.at(-1);
    if (/[0-9,]/.test(char)) {
      if (last?.kind === 'number') last.text += char;
      else tokens.push({ kind: 'number', text: char });
    } else if ('+−×÷'.includes(char)) {
      tokens.push({ kind: 'op', op: char });
    } else {
      throw new ExpressionError(`"${raw}" can't be used in an amount.`);
    }
  }
  return tokens;
}

function parseNumber(text: string): Fraction {
  const match = /^(\d*)(?:,(\d*))?$/.exec(text);
  if (!match || (match[1] === '' && (match[2] ?? '') === '')) throw new ExpressionError('Check the amount.');
  const decimals = match[2] ?? '';
  if (decimals.length > 2) throw new ExpressionError('Use at most 2 decimal places.');
  return { n: BigInt((match[1] || '0') + decimals), d: 10n ** BigInt(decimals.length) };
}

/** Recursive descent over the tokens: sum := product (± product)*, product := signed (×÷ signed)*. */
function evaluate(tokens: Token[]): Fraction {
  let i = 0;
  const peekOp = () => {
    const token = tokens[i];
    return token?.kind === 'op' ? token.op : null;
  };
  const signed = (): Fraction => {
    const op = peekOp();
    if (op === '+' || op === '−') {
      i++;
      const value = signed();
      return op === '−' ? { n: -value.n, d: value.d } : value;
    }
    const token = tokens[i++];
    if (token?.kind !== 'number') throw new ExpressionError('Finish the calculation.');
    return parseNumber(token.text);
  };
  const product = (): Fraction => {
    let value = signed();
    for (let op = peekOp(); op === '×' || op === '÷'; op = peekOp()) {
      i++;
      const right = signed();
      if (op === '÷' && right.n === 0n) throw new ExpressionError("Can't divide by 0.");
      value =
        op === '×'
          ? { n: value.n * right.n, d: value.d * right.d }
          : { n: value.n * right.d * (right.n < 0n ? -1n : 1n), d: value.d * (right.n < 0n ? -right.n : right.n) };
    }
    return value;
  };
  let value = product();
  for (let op = peekOp(); op === '+' || op === '−'; op = peekOp()) {
    i++;
    const right = product();
    const n = value.n * right.d + (op === '+' ? right.n : -right.n) * value.d;
    value = { n, d: value.d * right.d };
  }
  if (i < tokens.length) throw new ExpressionError('Finish the calculation.');
  return value;
}

/** Evaluates a keypad expression to minor units; an empty expression is 0. */
export function evaluateAmount(expression: string): AmountResult {
  try {
    const tokens = tokenize(expression);
    if (tokens.length === 0) return { ok: true, value: 0 };
    const { n, d } = evaluate(tokens);
    const minor = roundDiv(n * 100n, d);
    if (minor > BigInt(Number.MAX_SAFE_INTEGER) || minor < -BigInt(Number.MAX_SAFE_INTEGER)) {
      return { ok: false, error: 'That amount is too large.' };
    }
    return { ok: true, value: Number(minor) };
  } catch (error) {
    if (error instanceof ExpressionError) return { ok: false, error: error.message };
    throw error;
  }
}

/** The expression the keypad starts from for an amount: 123456 → "1234,56", 100000 → "1000", -5 → "-0,05". */
export function amountToExpression(minor: number): string {
  const abs = Math.abs(minor);
  const cents = abs % 100;
  const whole = (abs - cents) / 100;
  return `${minor < 0 ? '−' : ''}${whole}${cents === 0 ? '' : `,${String(cents).padStart(2, '0')}`}`;
}

/** The expression as the keypad displays it: thousands grouped, spaces around operators but not signs ("1 234,5 + −20"). */
export function formatExpression(expression: string): string {
  return expression
    .replace(/\d+/g, (digits, offset: number, all: string) =>
      all[offset - 1] === ',' ? digits : digits.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0'),
    )
    .replace(/(?<=[\d,])([+−×÷])/g, ' $1 ');
}
```

- [ ] **Step 4: The component kit**

Create `src/web/ui/cx.ts`:

```ts
/** Joins class names, skipping falsy ones: `cx('p-2', active && 'bg-gray-100')`. */
export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}
```

Create `src/web/ui/icons.tsx`:

```tsx
import type { SVGProps } from 'react';

/** 24 × 24 stroke icons. They are decorative: give the button around them an accessible name. */
function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

type IconProps = SVGProps<SVGSVGElement>;

export const UndoIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Icon>
);

export const RedoIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
  </Icon>
);

export const PlusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const BudgetIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 10h18M9 10v10" />
  </Icon>
);

export const AccountsIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 10 12 4l9 6" />
    <path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18" />
  </Icon>
);

export const MoreIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </Icon>
);

export const CloseIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const BackspaceIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M21 5H8l-6 7 6 7h13a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1Z" />
    <path d="m16 9-6 6M10 9l6 6" />
  </Icon>
);

export const ChevronRightIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m9 6 6 6-6 6" />
  </Icon>
);

export const OfflineIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2 8.8a15 15 0 0 1 4.2-2.7M22 8.8A15 15 0 0 0 10.7 5M5 12.9a10 10 0 0 1 5-2.6M19 12.9a10 10 0 0 0-1.8-1.3M8.5 16.4a5 5 0 0 1 7 0M12 20h.01M2 2l20 20" />
  </Icon>
);
```

Create `src/web/ui/button.tsx`:

```tsx
import type { ButtonHTMLAttributes } from 'react';
import { useOnline } from '../lib/online';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** It sends a request that changes data: disabled while offline (spec §11 "Offline"). */
  mutating?: boolean;
  /** A request is running: disabled, with a spinner. */
  busy?: boolean;
  /** Full width. */
  block?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-dark disabled:bg-gray-300',
  secondary: 'bg-white text-gray-900 ring-1 ring-gray-300 hover:bg-gray-50 disabled:text-gray-400',
  ghost: 'text-brand hover:bg-brand-light disabled:text-gray-400 disabled:hover:bg-transparent',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-gray-300',
};

/** The kit's button. It is `type="button"` unless told otherwise, so only an explicit submit button submits a form. */
export function Button({
  variant = 'primary',
  mutating = false,
  busy = false,
  block = false,
  disabled,
  className,
  type = 'button',
  title,
  children,
  ...props
}: ButtonProps) {
  const online = useOnline();
  const offline = mutating && !online;
  return (
    <button
      type={type}
      disabled={disabled || busy || offline}
      aria-busy={busy || undefined}
      title={offline ? "You're offline" : title}
      className={cx(
        'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-base font-semibold transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed',
        VARIANTS[variant],
        block && 'w-full',
        className,
      )}
      {...props}
    >
      {busy && (
        <span
          className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden="true"
        />
      )}
      {children}
    </button>
  );
}
```

Create `src/web/ui/field.tsx`:

```tsx
import { type InputHTMLAttributes, type ReactNode, useId } from 'react';
import { cx } from './cx';

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  /** Shown under the input in red, and announced with it. */
  error?: string | null;
  hint?: ReactNode;
}

/** A labelled input with its hint or error underneath. */
export function TextField({ label, error, hint, className, id, ...props }: TextFieldProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const noteId = `${inputId}-note`;
  const note = error ?? hint;
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={inputId} className="text-sm font-medium text-gray-700">
        {label}
      </label>
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={note ? noteId : undefined}
        className={cx(
          'min-h-11 rounded-xl border bg-white px-3 text-base text-gray-900 outline-none',
          'focus:border-brand focus:ring-2 focus:ring-brand/30 disabled:bg-gray-100',
          error ? 'border-red-500' : 'border-gray-300',
        )}
        {...props}
      />
      {note && (
        <p id={noteId} className={cx('text-sm', error ? 'text-red-600' : 'text-gray-500')}>
          {note}
        </p>
      )}
    </div>
  );
}

/** The form-level message of a failed request (see formErrorsOf). */
export function FormError({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
      {message}
    </p>
  );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
}

export function Checkbox({ label, className, ...props }: CheckboxProps) {
  return (
    <label className={cx('flex min-h-11 items-center gap-3 text-base', className)}>
      <input type="checkbox" className="size-5 accent-brand" {...props} />
      <span>{label}</span>
    </label>
  );
}

export interface SegmentedControlProps<T extends string> {
  /** Accessible name of the group. */
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}

/** Two or three mutually exclusive choices side by side (e.g. Outflow / Inflow). */
export function SegmentedControl<T extends string>({ label, value, options, onChange }: SegmentedControlProps<T>) {
  return (
    <div role="radiogroup" aria-label={label} className="grid auto-cols-fr grid-flow-col gap-1 rounded-xl bg-gray-200 p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={cx(
            'min-h-9 rounded-lg px-3 text-sm font-semibold',
            option.value === value ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
```

Create `src/web/ui/pill.tsx`:

```tsx
import type { ReactNode } from 'react';
import { cx } from './cx';

/** Spec §6 colours: green = funded, yellow = underfunded or covered by credit, red = overspent, grey = zero. */
export type PillTone = 'green' | 'yellow' | 'red' | 'grey';

const TONES: Record<PillTone, string> = {
  green: 'bg-green-200 text-green-900',
  yellow: 'bg-yellow-200 text-yellow-900',
  red: 'bg-red-200 text-red-900',
  grey: 'bg-gray-200 text-gray-700',
};

/** A rounded amount badge, like the Available pills of the budget. */
export function Pill({ tone, children, className }: { tone: PillTone; children: ReactNode; className?: string }) {
  return (
    <span
      data-tone={tone}
      className={cx('inline-flex rounded-full px-2.5 py-0.5 text-sm font-semibold tabular-nums whitespace-nowrap', TONES[tone], className)}
    >
      {children}
    </span>
  );
}
```

Create `src/web/ui/sheet.tsx`:

```tsx
import { type ReactNode, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from './icons';

export interface SheetProps {
  open: boolean;
  /** Called for the close button, a tap on the backdrop and Escape. */
  onClose: () => void;
  title: string;
  children: ReactNode;
}

/**
 * A bottom sheet (modal dialog) for forms and pickers. While it is open the page behind doesn't scroll; focus moves
 * into the sheet and returns to where it was when the sheet closes.
 */
export function Sheet({ open, onClose, title, children }: SheetProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const autofocus = panel.current?.querySelector<HTMLElement>('[autofocus], input, select, textarea');
    (autofocus ?? panel.current)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = overflow;
      returnFocus?.focus();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-40 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/40" data-testid="sheet-backdrop" onClick={() => close.current()} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative mx-auto flex max-h-[90dvh] w-full max-w-[480px] flex-col rounded-t-2xl bg-white shadow-xl outline-none"
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={() => close.current()}
            className="-mr-2 rounded-full p-2 text-gray-500 hover:bg-gray-100"
          >
            <CloseIcon />
          </button>
        </div>
        <div className="overflow-y-auto px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
```

Create `src/web/ui/toast.tsx`:

```tsx
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { cx } from './cx';

export interface ToastOptions {
  message: string;
  tone?: 'info' | 'error';
  /** One button, e.g. Undo or Retry; tapping it also dismisses the toast. */
  action?: { label: string; onClick: () => void };
  /** A new toast with the same key replaces the old one (only the latest command offers Undo). */
  key?: string;
  /** Milliseconds before it goes away; default 5 s, errors 8 s. */
  duration?: number;
}

interface Toast extends ToastOptions {
  id: number;
}

export interface ToastApi {
  show: (toast: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Shows toasts from anywhere below it (see useToast). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const show = useCallback((toast: ToastOptions) => {
    const id = nextId.current++;
    setToasts((list) => [...list.filter((t) => toast.key === undefined || t.key !== toast.key), { ...toast, id }].slice(-3));
    return id;
  }, []);
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  return (
    <ToastContext value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 mx-auto flex max-w-[480px] flex-col gap-2 px-3">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const { id, tone = 'info', duration = tone === 'error' ? 8000 : 5000 } = toast;
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(id), duration);
    return () => clearTimeout(timer);
  }, [id, duration, onDismiss]);
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cx(
        'pointer-events-auto flex items-center gap-3 rounded-xl px-4 py-3 text-sm text-white shadow-lg',
        tone === 'error' ? 'bg-red-700' : 'bg-gray-900',
      )}
    >
      <span className="flex-1">{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className="font-semibold text-green-300 uppercase"
          onClick={() => {
            onDismiss(id);
            toast.action!.onClick();
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast needs a <ToastProvider> above it');
  return api;
}
```

Create `src/web/ui/amount-keypad.tsx`:

```tsx
import { type KeyboardEvent, useState } from 'react';
import { amountToExpression, evaluateAmount, formatExpression, OPERATORS } from '../lib/amount-expression';
import { formatMoney } from '../lib/format';
import { Button } from './button';
import { cx } from './cx';
import { BackspaceIcon } from './icons';

export interface AmountKeypadProps {
  /** The amount (minor units) the keypad starts from; typing a digit first replaces it, an operator extends it. */
  value: number;
  currency?: string;
  /** Called with the result (minor units) when the user taps Done or presses Enter. */
  onDone: (value: number) => void;
  doneLabel?: string;
  /** Done sends a command: disabled while offline. */
  mutating?: boolean;
  busy?: boolean;
}

/** The keypad's buttons in reading order; `name` is the accessible name. */
const KEYS: { key: string; name: string }[] = [
  { key: '7', name: '7' },
  { key: '8', name: '8' },
  { key: '9', name: '9' },
  { key: OPERATORS.divide, name: 'Divide' },
  { key: '4', name: '4' },
  { key: '5', name: '5' },
  { key: '6', name: '6' },
  { key: OPERATORS.multiply, name: 'Multiply' },
  { key: '1', name: '1' },
  { key: '2', name: '2' },
  { key: '3', name: '3' },
  { key: OPERATORS.subtract, name: 'Minus' },
  { key: ',', name: 'Decimal comma' },
  { key: '0', name: '0' },
  { key: 'Backspace', name: 'Delete' },
  { key: OPERATORS.add, name: 'Plus' },
];

const KEYBOARD: Record<string, string> = { '.': ',', '-': OPERATORS.subtract, '*': OPERATORS.multiply, '/': OPERATORS.divide };

/**
 * A calculator keypad for amounts (spec §11): digits, a decimal comma and + − × ÷. It shows the expression and its
 * result, and also works with a hardware keyboard.
 */
export function AmountKeypad({ value, currency = 'PLN', onDone, doneLabel = 'Done', mutating, busy }: AmountKeypadProps) {
  const [expression, setExpression] = useState(() => amountToExpression(value));
  // The starting amount is replaced by the first digit typed, as in a calculator.
  const [fresh, setFresh] = useState(true);
  const result = evaluateAmount(expression);

  const press = (key: string) => {
    setFresh(false);
    if (key === 'Backspace') setExpression((e) => (fresh ? '' : e.slice(0, -1)));
    else if (/^[0-9,]$/.test(key) && fresh) setExpression(key);
    else setExpression((e) => e + key);
  };
  const done = () => {
    if (result.ok) onDone(result.value);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const key = KEYBOARD[event.key] ?? event.key;
    if (key === 'Enter') done();
    else if (key === 'Backspace' || /^[0-9,+−×÷]$/.test(key)) press(key);
    else return;
    event.preventDefault();
  };

  return (
    <div className="flex flex-col gap-3" onKeyDown={onKeyDown}>
      <div className="rounded-xl bg-gray-100 px-4 py-3 text-right" aria-live="polite">
        <div className="min-h-8 text-2xl font-semibold tabular-nums break-all" data-testid="keypad-expression">
          {formatExpression(expression) || '0'}
        </div>
        <div className={cx('text-sm tabular-nums', result.ok ? 'text-gray-600' : 'text-red-600')} data-testid="keypad-result">
          {result.ok ? `= ${formatMoney(result.value, currency)}` : result.error}
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {KEYS.map(({ key, name }) => (
          <button
            key={key}
            type="button"
            aria-label={name}
            onClick={() => press(key)}
            className={cx(
              'flex min-h-12 items-center justify-center rounded-xl text-xl font-semibold active:bg-gray-300',
              /[+−×÷]/.test(key) ? 'bg-gray-200 text-brand' : 'bg-gray-100 text-gray-900',
            )}
          >
            {key === 'Backspace' ? <BackspaceIcon /> : key}
          </button>
        ))}
      </div>
      <Button block mutating={mutating} busy={busy} disabled={!result.ok} onClick={done}>
        {doneLabel}
      </Button>
    </div>
  );
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/web/lib/amount-expression.test.ts src/web/ui`
Expected: `Tests  25 passed (25)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  65 passed (65)`, `Tests  538 passed (538)` (+5 test files, +25 tests); both checks exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/web/lib/amount-expression.ts src/web/lib/amount-expression.test.ts src/web/ui
git commit -m "feat(web): amount keypad calculator and the component kit" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---
### Task 7: The app shell: routes, guards, bottom navigation, Undo/Redo, toasts and the offline banner

Spec §11 (bottom navigation, header Undo/Redo, the toast with "Undo", Offline), §10 Undo/redo, §13. TanStack Router holds a code-based route tree (no file-based route generation):
- an `auth` layout (`/setup`, `/login`) and an `app` layout (the shell) for everything else; their `beforeLoad` guards read `authStatusQuery` from the cache: before setup everything goes to `/setup`; signed out, the app's pages go to `/login?redirect=<where you were going>`; signed in, `/`, `/login` and `/setup` go to `/budget`;
- `safeRedirect` accepts only paths of this app (no `//host`, `/\host`, URLs, or the sign-in pages), so `redirect` can't send anyone elsewhere;
- the shell: a header with the screen's title (the deepest route's `staticData.title`) and the Undo/Redo buttons, the screen, and the bottom navigation Budget · Accounts · ＋ · More, where More (Scheduled, Payees, Settings) stays active on its sub-screens. Budget, Accounts, New transaction, Scheduled, Payees and (until Task 9) Settings are placeholders for P3b and P3c. The layout is at most 480 px wide, centred on a desktop;
- the offline banner sits above every page.

`useCommand(fn)` is how every undoable command runs: it waits for the server, invalidates every budget-data query, reads `GET /api/undo` and shows a toast with the command's undo label and Undo (the server's label is the one source of truth, so the web app needs no labels of its own). The toast replaces the previous command's (key `command`), so only the newest offers Undo. A network or server failure shows an error toast with Retry; validation and domain errors stay on the mutation for the form. `useUndoRedo()` runs undo and redo for the header and the toasts: "Undone: …"/"Redone: …", or the server's message (`undo_conflict`, `nothing_to_undo`) as an error toast. The buttons are named after what they would undo or redo (`Undo Create payee "Lidl"`) and are disabled while offline.

`App` creates the query client and the router once. A 401 `unauthorized` from any request forgets the cached data and navigates to `/login?redirect=…`. jsdom has no scrolling, so the test setup stubs `window.scrollTo` (the router resets the scroll position on every navigation).

**Files:**
- Create: `src/web/app.tsx`, `src/web/router.tsx`, `src/web/lib/commands.ts`, `src/web/shell/{app-shell,bottom-nav,undo-redo,offline-banner,screens}.tsx`, `src/web/test/render.tsx`
- Modify: `package.json`, `package-lock.json`, `src/web/main.tsx`, `src/web/test/setup.ts`
- Test: `src/web/app.test.tsx`, `src/web/lib/commands.test.tsx`

**Interfaces:**
- Consumes: Tasks 5–6; `GET/POST /api/undo`, `POST /api/redo` (P2b1: `{ undo, redo }` labels, `undone`/`redone`).
- Produces:
  - `router.tsx`: `RouterContext`, `safeRedirect(value)`, `createAppRouter(queryClient, history?)`; route ids `/auth/setup`, `/auth/login` (search `{ redirect? }`), `/app/…`; `staticData.title`.
  - `app.tsx`: `App({ history? })`.
  - `commands.ts`: `undoStateQuery`, `errorMessage(error)`, `useUndoRedo()` → `{ undo, redo, busy }`, `useCommand(mutationFn)`.
  - `shell/`: `AppShell`, `AuthLayout`, `BottomNav`, `MORE_PATHS`, `UndoRedoButtons`, `OfflineBanner`, `PlaceholderScreen`, `MoreScreen`, `NotFoundScreen`.
  - Test helpers: `renderApp(path)` → `{ history, … }`, `renderWithProviders(ui)`, `SIGNED_IN`.

- [ ] **Step 1: Add TanStack Router**

Run: `npm install -D @tanstack/react-router@^1.170.46`
Expected: `package.json` lists `"@tanstack/react-router": "^1.170.46"` under `devDependencies`.

- [ ] **Step 2: Write the failing tests**

```bash
git apply <<'PATCH'
diff --git a/src/web/test/setup.ts b/src/web/test/setup.ts
index ef044bf..a497baa 100644
--- a/src/web/test/setup.ts
+++ b/src/web/test/setup.ts
@@ -2,6 +2,9 @@ import '@testing-library/jest-dom/vitest';
 import { cleanup } from '@testing-library/react';
 import { afterEach, vi } from 'vitest';
 
+// jsdom doesn't scroll; the router resets the scroll position after every navigation.
+window.scrollTo = () => {};
+
 // Vitest runs without globals, so Testing Library can't register its own cleanup.
 afterEach(() => {
   cleanup();
PATCH
```

Create `src/web/test/render.tsx`:

```tsx
import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { App } from '../app';
import { createQueryClient } from '../lib/query';
import { ToastProvider } from '../ui/toast';

/** Renders the whole app at `path` (on a memory history). Fake the API with fakeApi() first. */
export function renderApp(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  return { history, ...render(<App history={history} />) };
}

/** Renders a component with the app's query client and toasts, but no router. */
export function renderWithProviders(ui: ReactElement) {
  const queryClient = createQueryClient(() => {});
  const result = render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
  return { queryClient, ...result };
}

/** The API's answers for a signed-in owner with an empty history (merge more routes into it). */
export const SIGNED_IN = {
  'GET /api/auth/status': { body: { setupRequired: false, authenticated: true } },
  'GET /api/undo': { body: { undo: null, redo: null } },
};
```

Create `src/web/app.test.tsx`:

```tsx
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { fakeApi, json } from './test/fake-api';
import { renderApp, SIGNED_IN } from './test/render';
import { safeRedirect } from './router';

const status = (setupRequired: boolean, authenticated: boolean) => ({
  'GET /api/auth/status': { body: { setupRequired, authenticated } },
});

describe('route guards', () => {
  it('send a fresh install to setup', async () => {
    fakeApi(status(true, false));
    const { history } = renderApp('/budget');
    await waitFor(() => expect(history.location.pathname).toBe('/setup'));
  });

  it('send a signed-out visitor to sign in, remembering where they were going', async () => {
    fakeApi(status(false, false));
    const { history } = renderApp('/payees');
    await waitFor(() => expect(history.location.pathname).toBe('/login'));
    expect(history.location.search).toBe('?redirect=%2Fpayees');
  });

  it('send a signed-in owner from the sign-in pages and / to the budget', async () => {
    fakeApi(SIGNED_IN);
    for (const path of ['/', '/login', '/setup']) {
      const { history, unmount } = renderApp(path);
      await waitFor(() => expect(history.location.pathname).toBe('/budget'));
      unmount();
    }
  });

  it('send the owner to sign in when the session ends', async () => {
    fakeApi({
      ...SIGNED_IN,
      'GET /api/undo': json({ code: 'unauthorized', message: 'Please sign in.' }, 401),
    });
    const { history } = renderApp('/accounts');
    await waitFor(() => expect(history.location.pathname).toBe('/login'));
    expect(history.location.search).toBe('?redirect=%2Faccounts');
  });

  it('only redirect to paths of this app after signing in', () => {
    expect(safeRedirect('/budget/2026-11?x=1')).toBe('/budget/2026-11?x=1');
    for (const unsafe of ['//evil.example', '/\\evil.example', 'https://evil.example', '/login', '/setup?x', 42]) {
      expect(safeRedirect(unsafe)).toBeUndefined();
    }
  });
});

describe('app shell', () => {
  it('shows the screen title, Undo/Redo and the bottom navigation', async () => {
    fakeApi(SIGNED_IN);
    renderApp('/budget');
    expect(await screen.findByRole('heading', { name: 'Budget' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getAllByRole('link').map((link) => link.textContent || link.getAttribute('aria-label'))).toEqual([
      'Budget',
      'Accounts',
      'New transaction',
      'More',
    ]);
    expect(within(nav).getByRole('link', { name: 'Budget' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
  });

  it('reaches Scheduled, Payees and Settings through More', async () => {
    fakeApi(SIGNED_IN);
    renderApp('/budget');
    await userEvent.click(await screen.findByRole('link', { name: 'More' }));
    expect(await screen.findByRole('heading', { name: 'More' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Payees' }));
    expect(await screen.findByRole('heading', { name: 'Payees' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'More' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Budget' })).not.toHaveAttribute('aria-current');
  });

  it('undoes and redoes from the header, naming the command', async () => {
    const { requests } = fakeApi({
      ...SIGNED_IN,
      'GET /api/undo': { body: { undo: { label: 'Create payee "Lidl"' }, redo: null } },
      'POST /api/undo': { body: { undo: null, redo: { label: 'Create payee "Lidl"' }, undone: { label: 'Create payee "Lidl"' } } },
    });
    renderApp('/budget');
    await userEvent.click(await screen.findByRole('button', { name: 'Undo Create payee "Lidl"' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Undone: Create payee "Lidl"');
    expect(requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual(['/api/undo']);
    expect(requests.find((r) => r.method === 'POST')!.headers.get('X-Requested-With')).toBe('budget-track');
  });

  it("shows the server's message when undo is refused", async () => {
    fakeApi({
      ...SIGNED_IN,
      'GET /api/undo': { body: { undo: { label: 'Move money' }, redo: null } },
      'POST /api/undo': json({ code: 'undo_conflict', message: "Can't undo: data changed since." }, 409),
    });
    renderApp('/budget');
    await userEvent.click(await screen.findByRole('button', { name: 'Undo Move money' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't undo: data changed since.");
  });

  it('shows the offline banner and disables Undo while offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    fakeApi({ ...SIGNED_IN, 'GET /api/undo': { body: { undo: { label: 'Move money' }, redo: null } } });
    renderApp('/budget');
    expect(await screen.findByText(/You're offline/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo Move money' })).toBeDisabled());
  });
});
```

Create `src/web/lib/commands.test.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Button } from '../ui/button';
import { fakeApi, json } from '../test/fake-api';
import { renderWithProviders } from '../test/render';
import { api, unwrap } from './api';
import { useCommand } from './commands';
import { formErrorsOf } from './form-errors';

/** A tiny screen: a list read through the cache, and a command that adds to it. */
function Payees() {
  const list = useQuery({ queryKey: ['payees'], queryFn: () => unwrap(api.api.payees.$get()) });
  const create = useCommand((name: string) => unwrap(api.api.payees.$post({ json: { name } })));
  const errors = formErrorsOf(create.error, ['name']);
  return (
    <>
      <p data-testid="count">{list.data?.payees.length ?? '…'}</p>
      <Button mutating busy={create.isPending} onClick={() => create.mutate('Lidl')}>
        Add Lidl
      </Button>
      {errors.fields.name && <p>{errors.fields.name}</p>}
    </>
  );
}

const payee = { id: 'p1', name: 'Lidl', kind: 'user', transferAccountId: null, lastCategoryId: null, usageCount: 0 };

describe('useCommand', () => {
  it('refreshes the data after the command and offers to undo it', async () => {
    let payees: (typeof payee)[] = [];
    let undo = null as { label: string } | null;
    const { requests } = fakeApi({
      'GET /api/payees': () => ({ body: { payees } }),
      'POST /api/payees': () => {
        payees = [payee];
        undo = { label: 'Create payee "Lidl"' };
        return { status: 201, body: payee };
      },
      'GET /api/undo': () => ({ body: { undo, redo: null } }),
      'POST /api/undo': () => {
        payees = [];
        return { body: { undo: null, redo: undo, undone: undo } };
      },
    });
    renderWithProviders(<Payees />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));
    await userEvent.click(screen.getByRole('button', { name: 'Add Lidl' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Create payee "Lidl"');
    expect(screen.getByTestId('count')).toHaveTextContent('1');

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Undone: Create payee "Lidl"');
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));
    expect(requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual(['/api/payees', '/api/undo']);
  });

  it('leaves validation errors to the form, and offers Retry after a server failure', async () => {
    let calls = 0;
    fakeApi({
      'GET /api/payees': { body: { payees: [] } },
      'GET /api/undo': { body: { undo: null, redo: null } },
      'POST /api/payees': () => {
        calls++;
        return calls === 1
          ? json({ code: 'validation', message: 'Some fields are invalid.', fieldErrors: { name: ['Enter a name.'] } }, 400)
          : json({ code: 'internal', message: 'Something went wrong.', requestId: 'r1' }, 500);
      },
    });
    renderWithProviders(<Payees />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add Lidl' }));
    expect(await screen.findByText('Enter a name.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Add Lidl' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls).toBe(3));
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run src/web/app.test.tsx src/web/lib/commands.test.tsx`
Expected: FAIL — `Test Files  2 failed (2)`, `Tests  no tests`: `Failed to resolve import "./router"` and `"./commands"`.

- [ ] **Step 4: Commands, undo and redo**

Create `src/web/lib/commands.ts`:

```ts
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../ui/toast';
import { api, ApiError, isTransient, isUnauthorized, UNEXPECTED_ERROR_MESSAGE, unwrap } from './api';
import { invalidateData, queryKeys } from './query';

/** GET /api/undo: what the header's Undo and Redo buttons would do. */
export const undoStateQuery = queryOptions({
  queryKey: queryKeys.undo,
  queryFn: () => unwrap(api.api.undo.$get()),
});

/** The message to show for a failed request outside a form. */
export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : UNEXPECTED_ERROR_MESSAGE;
}

/** The toast key of command results: a new one replaces the last, so only the newest command offers Undo. */
const COMMAND_TOAST = 'command';

/**
 * Undo and redo (spec §10), for the header buttons and the toasts' Undo. Afterwards every budget-data query is
 * refreshed; a 409 (`undo_conflict`, `nothing_to_undo`, …) is shown as an error toast with the server's message.
 */
export function useUndoRedo() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: async (direction: 'undo' | 'redo') =>
      direction === 'undo' ? unwrap(api.api.undo.$post()) : unwrap(api.api.redo.$post()),
    onSuccess: async (result) => {
      const message = 'undone' in result ? `Undone: ${result.undone.label}` : `Redone: ${result.redone.label}`;
      toast.show({ key: COMMAND_TOAST, message });
      queryClient.setQueryData(queryKeys.undo, { undo: result.undo, redo: result.redo });
      await invalidateData(queryClient);
    },
    onError: (error) => {
      if (!isUnauthorized(error)) toast.show({ key: COMMAND_TOAST, tone: 'error', message: errorMessage(error) });
    },
  });
  return {
    undo: () => mutation.mutate('undo'),
    redo: () => mutation.mutate('redo'),
    busy: mutation.isPending,
  };
}

/**
 * A user command (spec §2 write path), e.g. `useCommand((name: string) => unwrap(api.api.payees.$post({ json: { name } })))`.
 * It waits for the server (no optimistic update), then refreshes every budget-data query and shows a toast with the
 * command's undo label and an Undo button (spec §11). The error stays on the mutation for the form to show
 * (`formErrorsOf(mutation.error, fields)`); a network or server failure also gets a toast with Retry.
 */
export function useCommand<TVariables = void, TResult = unknown>(mutationFn: (variables: TVariables) => Promise<TResult>) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { undo } = useUndoRedo();
  const mutation = useMutation({
    mutationFn,
    onSuccess: async () => {
      await invalidateData(queryClient);
      const state = await queryClient.fetchQuery(undoStateQuery);
      if (state.undo) {
        toast.show({ key: COMMAND_TOAST, message: state.undo.label, action: { label: 'Undo', onClick: undo } });
      }
    },
    onError: (error, variables) => {
      if (!isTransient(error)) return;
      toast.show({
        tone: 'error',
        message: errorMessage(error),
        action: { label: 'Retry', onClick: () => mutation.mutate(variables) },
      });
    },
  });
  return mutation;
}
```

- [ ] **Step 5: The shell**

Create `src/web/shell/app-shell.tsx`:

```tsx
import { Outlet, useMatches } from '@tanstack/react-router';
import { BottomNav } from './bottom-nav';
import { UndoRedoButtons } from './undo-redo';

/** The signed-in phone layout (spec §11): header with the screen's title and Undo/Redo, the screen, bottom nav. */
export function AppShell() {
  // The deepest route with a title names the screen.
  const title = useMatches({
    select: (matches) => matches.reduce<string | undefined>((found, match) => match.staticData.title ?? found, undefined),
  });
  return (
    <div className="mx-auto flex min-h-dvh max-w-[480px] flex-col bg-white shadow-sm">
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-gray-200 bg-white px-4 pt-[env(safe-area-inset-top)]">
        <h1 className="py-3 text-lg font-semibold">{title}</h1>
        <UndoRedoButtons />
      </header>
      <main className="flex-1 pb-24">
        <Outlet />
      </main>
      <BottomNav />
    </div>
  );
}

/** Setup and sign-in: one centred column without navigation. */
export function AuthLayout() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-[480px] flex-col justify-center gap-6 px-4 py-8">
      <p className="text-center text-2xl font-bold text-brand">Budget Track</p>
      <Outlet />
    </main>
  );
}
```

Create `src/web/shell/bottom-nav.tsx`:

```tsx
import { Link, useRouterState } from '@tanstack/react-router';
import { AccountsIcon, BudgetIcon, MoreIcon, PlusIcon } from '../ui/icons';
import { cx } from '../ui/cx';

/** Screens reached through More; its tab is active on them too. */
export const MORE_PATHS = ['/more', '/scheduled', '/payees', '/settings'];

const tab = 'flex flex-1 flex-col items-center gap-0.5 py-2 text-xs font-medium';
// Exactly one colour class at a time: two text colours on one element would leave the winner to CSS order.
const active = { className: 'text-brand', 'aria-current': 'page' } as const;
const inactive = { className: 'text-gray-500' } as const;

/** Spec §11: Budget · Accounts · ＋ (new transaction) · More. */
export function BottomNav() {
  const inMore = useRouterState({ select: (s) => MORE_PATHS.some((p) => s.location.pathname.startsWith(p)) });
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-30 mx-auto flex max-w-[480px] items-center border-t border-gray-200 bg-white pb-[env(safe-area-inset-bottom)]"
    >
      <Link to="/budget" className={tab} activeProps={active} inactiveProps={inactive}>
        <BudgetIcon />
        Budget
      </Link>
      <Link to="/accounts" className={tab} activeProps={active} inactiveProps={inactive}>
        <AccountsIcon />
        Accounts
      </Link>
      <div className="flex flex-1 justify-center">
        <Link
          to="/transactions/new"
          aria-label="New transaction"
          className="-mt-5 flex size-14 items-center justify-center rounded-full bg-brand text-white shadow-lg"
        >
          <PlusIcon className="size-7" />
        </Link>
      </div>
      <Link to="/more" className={cx(tab, inMore ? 'text-brand' : 'text-gray-500')} aria-current={inMore ? 'page' : undefined}>
        <MoreIcon />
        More
      </Link>
    </nav>
  );
}
```

Create `src/web/shell/undo-redo.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { undoStateQuery, useUndoRedo } from '../lib/commands';
import { Button } from '../ui/button';
import { RedoIcon, UndoIcon } from '../ui/icons';

/** The header's Undo and Redo buttons, named after the command they would undo or redo. */
export function UndoRedoButtons() {
  const { data } = useQuery(undoStateQuery);
  const { undo, redo, busy } = useUndoRedo();
  const undoName = data?.undo ? `Undo ${data.undo.label}` : 'Undo';
  const redoName = data?.redo ? `Redo ${data.redo.label}` : 'Redo';
  return (
    <div className="-mr-2 flex">
      <Button variant="ghost" mutating aria-label={undoName} title={undoName} disabled={!data?.undo || busy} onClick={undo} className="px-2">
        <UndoIcon />
      </Button>
      <Button variant="ghost" mutating aria-label={redoName} title={redoName} disabled={!data?.redo || busy} onClick={redo} className="px-2">
        <RedoIcon />
      </Button>
    </div>
  );
}
```

Create `src/web/shell/offline-banner.tsx`:

```tsx
import { useOnline } from '../lib/online';
import { OfflineIcon } from '../ui/icons';

/** Spec §11 "Offline": explains why every control that changes data is disabled. */
export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div
      role="status"
      className="sticky top-0 z-40 flex items-center justify-center gap-2 bg-yellow-100 px-4 py-2 text-sm font-medium text-yellow-900"
    >
      <OfflineIcon className="size-4" />
      You're offline. Changes are paused until you're back online.
    </div>
  );
}
```

Create `src/web/shell/screens.tsx`:

```tsx
import { Link } from '@tanstack/react-router';
import { ChevronRightIcon } from '../ui/icons';

/** Stands in for a screen a later phase builds (P3b: Budget; P3c: Accounts, transactions, Scheduled, Payees). */
export function PlaceholderScreen({ name }: { name: string }) {
  return (
    <div className="px-4 py-12 text-center text-gray-500">
      <p className="font-medium text-gray-700">{name}</p>
      <p>This screen isn't built yet.</p>
    </div>
  );
}

/** Spec §11: More holds Scheduled, Payees and Settings. */
export function MoreScreen() {
  const items = [
    { to: '/scheduled', label: 'Scheduled' },
    { to: '/payees', label: 'Payees' },
    { to: '/settings', label: 'Settings' },
  ] as const;
  return (
    <ul className="divide-y divide-gray-200">
      {items.map((item) => (
        <li key={item.to}>
          <Link to={item.to} className="flex min-h-14 items-center justify-between px-4 text-base hover:bg-gray-50">
            {item.label}
            <ChevronRightIcon className="text-gray-400" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function NotFoundScreen() {
  return (
    <div className="mx-auto max-w-[480px] px-4 py-12 text-center">
      <p className="text-lg font-semibold">Page not found</p>
      <Link to="/budget" className="text-brand underline">
        Go to the budget
      </Link>
    </div>
  );
}
```

- [ ] **Step 6: Routes, guards and the app**

Create `src/web/router.tsx`:

```tsx
import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { authStatusQuery } from './lib/query';
import { AppShell, AuthLayout } from './shell/app-shell';
import { OfflineBanner } from './shell/offline-banner';
import { MoreScreen, NotFoundScreen, PlaceholderScreen } from './shell/screens';

export interface RouterContext {
  queryClient: QueryClient;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
  interface StaticDataRouteOption {
    /** Shown in the app shell's header. */
    title?: string;
  }
}

/** A path to return to after signing in: only paths of this app, and never the sign-in pages themselves. */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\/(?![/\\])/.test(value)) return undefined;
  return /^\/(login|setup)(?=[/?#]|$)/.test(value) ? undefined : value;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <>
      <OfflineBanner />
      <Outlet />
    </>
  ),
  notFoundComponent: NotFoundScreen,
});

// Setup and sign-in. The guards read the cached auth status, which setup, sign-in, sign-out and any 401 keep current.
const authLayout = createRoute({ getParentRoute: () => rootRoute, id: 'auth', component: AuthLayout });

const setupRoute = createRoute({
  getParentRoute: () => authLayout,
  path: 'setup',
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(authStatusQuery);
    if (!status.setupRequired) throw redirect({ to: status.authenticated ? '/budget' : '/login' });
  },
  component: () => <PlaceholderScreen name="Set up" />,
});

const loginRoute = createRoute({
  getParentRoute: () => authLayout,
  path: 'login',
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const target = safeRedirect(search.redirect);
    return target === undefined ? {} : { redirect: target };
  },
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(authStatusQuery);
    if (status.setupRequired) throw redirect({ to: '/setup' });
    if (status.authenticated) throw redirect({ to: '/budget' });
  },
  component: () => <PlaceholderScreen name="Sign in" />,
});

// Everything else needs a session and lives in the app shell. A later phase adds its screens here.
const appLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ context, location }) => {
    const status = await context.queryClient.ensureQueryData(authStatusQuery);
    if (status.setupRequired) throw redirect({ to: '/setup' });
    if (!status.authenticated) throw redirect({ to: '/login', search: { redirect: safeRedirect(location.href) } });
  },
  component: AppShell,
});

const appRoutes = [
  createRoute({
    getParentRoute: () => appLayout,
    path: '/',
    beforeLoad: () => {
      throw redirect({ to: '/budget' });
    },
  }),
  createRoute({
    getParentRoute: () => appLayout,
    path: 'budget',
    staticData: { title: 'Budget' },
    component: () => <PlaceholderScreen name="Budget" />,
  }),
  createRoute({
    getParentRoute: () => appLayout,
    path: 'accounts',
    staticData: { title: 'Accounts' },
    component: () => <PlaceholderScreen name="Accounts" />,
  }),
  createRoute({
    getParentRoute: () => appLayout,
    path: 'transactions/new',
    staticData: { title: 'New transaction' },
    component: () => <PlaceholderScreen name="New transaction" />,
  }),
  createRoute({ getParentRoute: () => appLayout, path: 'more', staticData: { title: 'More' }, component: MoreScreen }),
  createRoute({
    getParentRoute: () => appLayout,
    path: 'scheduled',
    staticData: { title: 'Scheduled' },
    component: () => <PlaceholderScreen name="Scheduled" />,
  }),
  createRoute({
    getParentRoute: () => appLayout,
    path: 'payees',
    staticData: { title: 'Payees' },
    component: () => <PlaceholderScreen name="Payees" />,
  }),
  createRoute({
    getParentRoute: () => appLayout,
    path: 'settings',
    staticData: { title: 'Settings' },
    component: () => <PlaceholderScreen name="Settings" />,
  }),
] as const;

const routeTree = rootRoute.addChildren([
  authLayout.addChildren([setupRoute, loginRoute]),
  appLayout.addChildren(appRoutes),
]);

/** The app's router; tests pass a memory history. */
export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({ routeTree, context: { queryClient }, history });
}
```

Create `src/web/app.tsx`:

```tsx
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, type RouterHistory } from '@tanstack/react-router';
import { useState } from 'react';
import { createQueryClient, forgetSession } from './lib/query';
import { createAppRouter } from './router';
import { ToastProvider } from './ui/toast';

/** The whole web app: data cache, toasts and routes. `history` is for tests (a memory history). */
export function App({ history }: { history?: RouterHistory }) {
  const [{ queryClient, router }] = useState(() => {
    // A 401 from any request means the session ended (expired, or signed out elsewhere): go and sign in again.
    const client = createQueryClient(() => {
      forgetSession(client);
      const { pathname, href } = appRouter.state.location;
      if (pathname !== '/login') void appRouter.navigate({ to: '/login', search: { redirect: href } });
    });
    const appRouter = createAppRouter(client, history);
    return { queryClient: client, router: appRouter };
  });
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  );
}
```

```bash
git apply <<'PATCH'
diff --git a/src/web/main.tsx b/src/web/main.tsx
index 89442ce..e303da9 100644
--- a/src/web/main.tsx
+++ b/src/web/main.tsx
@@ -1,12 +1,13 @@
 import { StrictMode } from 'react';
 import { createRoot } from 'react-dom/client';
 import { registerSW } from 'virtual:pwa-register';
+import { App } from './app';
 import './styles.css';
 
 registerSW({ immediate: true });
 
 createRoot(document.getElementById('root')!).render(
   <StrictMode>
-    <p className="p-4">Budget Track</p>
+    <App />
   </StrictMode>,
 );
PATCH
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/web/app.test.tsx src/web/lib/commands.test.tsx`
Expected: `Tests  12 passed (12)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  67 passed (67)`, `Tests  550 passed (550)` (+2 test files, +12 tests); both checks exit 0.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/web
git commit -m "feat(web): app shell with routes, guards, bottom navigation, Undo/Redo, toasts and the offline banner" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---
### Task 8: The setup wizard and sign-in

Spec §12 (first-run setup, login), carry-over "CSP img-src blocks data: QR → render SVG". The setup wizard has four steps on one page:
1. **Setup token**: `POST /api/auth/setup/totp` checks it and returns the new authenticator secret and its `otpauth://` URI (a wrong token is a form error; a budget that is already set up links to sign-in).
2. **Password** (twice): checked in the browser with the shared `setupRequestSchema` (at least 12 characters), sent with the last step.
3. **Authenticator**: the URI as a QR code, drawn as one inline SVG path from `qrcode`'s module matrix (level M, a 4-module quiet zone): the strict CSP blocks `data:` images, and nothing leaves the page to render it. Below it the secret in groups of four for typing in. `POST /api/auth/setup` with a code from the app creates the budget and signs the owner in.
4. **Recovery codes**: the ten codes, shown once, with Copy (clipboard; a message when that isn't allowed) and Download (a `budget-track-recovery-codes.txt` from a `data:` link, a download rather than an image, so the CSP doesn't apply). "Continue to the budget" stays disabled until "I've saved my recovery codes" is ticked.

Sign-in takes the password and an authenticator code (digits only, at most 6) or, after switching, a recovery code. Success records the session in the cache and opens the page the user was going to (`redirect`), or the budget; with 3 or fewer recovery codes left a toast says to make new ones in Settings. Wrong credentials, the rate limit and the lockout are form errors with "You can try again in …" from `Retry-After`. The auth calls are plain mutations (not undoable commands).

**Files:**
- Create: `src/web/auth/{auth-api.ts,setup-screen.tsx,login-screen.tsx,totp-qr.tsx,recovery-codes.tsx}`
- Modify: `package.json`, `package-lock.json`, `src/web/router.tsx`
- Test: `src/web/auth/{setup-screen,login-screen,totp-qr,recovery-codes}.test.tsx`

**Interfaces:**
- Consumes: Tasks 5–7; `setupRequestSchema`, `PASSWORD_MIN_LENGTH`, `SetupRequest`, `LoginRequest` (`src/shared/auth.ts`); `POST /api/auth/setup/totp`, `/setup`, `/login`, `/logout`.
- Produces:
  - `auth-api.ts`: `authApi { setupSecret, setup, login, logout }`, `useEnterApp()` (records the session, opens `href`), `useLeaveApp()` (forgets it, opens `/login`).
  - `SetupScreen`, `LoginScreen` (routes `/setup`, `/login`), `TotpQrCode { uri }`, `TotpSecret { secret }`, `RecoveryCodes { codes }`.

- [ ] **Step 1: Add the QR code library**

Run: `npm install -D @types/qrcode@^1.5.6 qrcode@^1.5.4`
Expected: `package.json` lists `"@types/qrcode": "^1.5.6"` and `"qrcode": "^1.5.4"` under `devDependencies`.

- [ ] **Step 2: Write the failing tests**

Create `src/web/auth/totp-qr.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TotpQrCode, TotpSecret } from './totp-qr';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
// As the server's totpUri() makes it.
const URI = `otpauth://totp/Budget%20Track:owner?secret=${SECRET}&issuer=Budget%20Track`;

describe('TotpQrCode', () => {
  it('draws the QR code as inline SVG, not an image the CSP would block', () => {
    const { container } = render(<TotpQrCode uri={URI} />);
    const svg = screen.getByRole('img', { name: 'QR code for your authenticator app' });
    expect(svg.tagName).toBe('svg');
    expect(container.querySelector('img')).toBeNull();
    // 97 characters need a version 6 code at level M: 41 × 41 modules, plus a 4-module quiet zone on each side.
    expect(svg).toHaveAttribute('viewBox', '0 0 49 49');
    const d = svg.querySelector('path')!.getAttribute('d')!;
    expect(d).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/);
    // The three finder patterns start with a run of 7 dark modules in the first row.
    expect(d.startsWith('M0 0h7v1h-7z')).toBe(true);
  });

  it('draws a different code for a different secret', () => {
    const { container, rerender } = render(<TotpQrCode uri={URI} />);
    const before = container.querySelector('path')!.getAttribute('d');
    rerender(<TotpQrCode uri={URI.replaceAll(SECRET, 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU')} />);
    expect(container.querySelector('path')!.getAttribute('d')).not.toBe(before);
  });
});

describe('TotpSecret', () => {
  it('shows the key in groups of four for typing it in', () => {
    render(<TotpSecret secret={SECRET} />);
    expect(screen.getByTestId('totp-secret')).toHaveTextContent('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
  });
});
```

Create `src/web/auth/recovery-codes.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RecoveryCodes } from './recovery-codes';

const CODES = ['7KQM-W3XP-9DHR', 'AB2C-DE3F-GH4J'];

describe('RecoveryCodes', () => {
  it('lists the codes and copies them', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(<RecoveryCodes codes={CODES} />);
    const list = screen.getByRole('list', { name: 'Recovery codes' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(CODES);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('7KQM-W3XP-9DHR\nAB2C-DE3F-GH4J\n'));
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('offers them as a text file', () => {
    render(<RecoveryCodes codes={CODES} />);
    const link = screen.getByRole('link', { name: 'Download' });
    expect(link).toHaveAttribute('download', 'budget-track-recovery-codes.txt');
    const href = link.getAttribute('href')!;
    expect(href.startsWith('data:text/plain;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(href.slice(href.indexOf(',') + 1))).toContain('7KQM-W3XP-9DHR\nAB2C-DE3F-GH4J\n');
  });

  it('says so when copying is not allowed', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    render(<RecoveryCodes codes={CODES} />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByText(/Couldn't copy/)).toBeInTheDocument();
  });
});
```

Create `src/web/auth/setup-screen.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fakeApi, json } from '../test/fake-api';
import { renderApp } from '../test/render';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const CODES = Array.from({ length: 10 }, (_, i) => `AAAA-BBBB-CC${String(i).padStart(2, '0')}`);
const PASSWORD = 'correct horse battery staple';

function setupServer() {
  return fakeApi({
    'GET /api/auth/status': { body: { setupRequired: true, authenticated: false } },
    'GET /api/undo': { body: { undo: null, redo: null } },
    'POST /api/auth/setup/totp': ({ body }) =>
      (body as { setupToken: string }).setupToken === 'the-token'
        ? { body: { secret: SECRET, uri: `otpauth://totp/Budget%20Track:owner?secret=${SECRET}` } }
        : json({ code: 'invalid_setup_token', message: 'That setup token is not correct.' }, 403),
    'POST /api/auth/setup': ({ body }) =>
      (body as { totpCode: string }).totpCode === '123456'
        ? { status: 201, body: { recoveryCodes: CODES } }
        : json({ code: 'invalid_totp_code', message: "That code didn't match." }, 422),
  });
}

describe('setup wizard', () => {
  it('walks through token, password, authenticator and recovery codes into the app', async () => {
    const user = userEvent.setup();
    const { requests } = setupServer();
    const { history } = renderApp('/setup');

    await user.type(await screen.findByLabelText('Setup token'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That setup token is not correct.');
    await user.clear(screen.getByLabelText('Setup token'));
    await user.type(screen.getByLabelText('Setup token'), 'the-token');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Choose a password' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Password'), 'too short');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription('Use at least 12 characters.');
    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.type(screen.getByLabelText('Repeat the password'), `${PASSWORD}!`);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByLabelText('Repeat the password')).toHaveAccessibleDescription("The passwords don't match.");
    await user.type(screen.getByLabelText('Repeat the password'), '{Backspace}');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Add an authenticator' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'QR code for your authenticator app' })).toBeInTheDocument();
    expect(screen.getByTestId('totp-secret')).toHaveTextContent('JBSW Y3DP');
    await user.type(screen.getByLabelText('Code from the app'), '000000');
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("That code didn't match.");
    await user.clear(screen.getByLabelText('Code from the app'));
    await user.type(screen.getByLabelText('Code from the app'), '123456');
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));

    expect(await screen.findByRole('heading', { name: 'Save your recovery codes' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    const enter = screen.getByRole('button', { name: 'Continue to the budget' });
    expect(enter).toBeDisabled();
    await user.click(screen.getByLabelText("I've saved my recovery codes"));
    await user.click(enter);
    await waitFor(() => expect(history.location.pathname).toBe('/budget'));

    const posts = requests.filter((r) => r.method === 'POST');
    expect(posts.at(-1)).toMatchObject({
      path: '/api/auth/setup',
      body: { setupToken: 'the-token', password: PASSWORD, totpSecret: SECRET, totpCode: '123456' },
    });
  });

  it('points to sign-in when the budget is already set up', async () => {
    const user = userEvent.setup();
    fakeApi({
      'GET /api/auth/status': { body: { setupRequired: true, authenticated: false } },
      'POST /api/auth/setup/totp': json({ code: 'already_setup', message: 'This budget is already set up. Sign in instead.' }, 409),
    });
    renderApp('/setup');
    await user.type(await screen.findByLabelText('Setup token'), 'the-token');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This budget is already set up.');
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', '/login');
  });
});
```

Create `src/web/auth/login-screen.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fakeApi, json } from '../test/fake-api';
import { renderApp } from '../test/render';

const SIGNED_OUT = {
  'GET /api/auth/status': { body: { setupRequired: false, authenticated: false } },
  'GET /api/undo': { body: { undo: null, redo: null } },
};

describe('sign-in', () => {
  it('signs in with the password and an authenticator code, then opens the page asked for', async () => {
    const user = userEvent.setup();
    const { requests } = fakeApi({ ...SIGNED_OUT, 'POST /api/auth/login': { body: { recoveryCodesRemaining: 10 } } });
    const { history } = renderApp('/login?redirect=%2Fpayees');
    await user.type(await screen.findByLabelText('Password'), 'correct horse battery staple');
    await user.type(screen.getByLabelText('Authenticator code'), '12a3456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(history.location.pathname).toBe('/payees'));
    expect(requests.find((r) => r.method === 'POST')!.body).toEqual({
      password: 'correct horse battery staple',
      totpCode: '123456',
    });
  });

  it('signs in with a recovery code instead, and warns when few are left', async () => {
    const user = userEvent.setup();
    const { requests } = fakeApi({ ...SIGNED_OUT, 'POST /api/auth/login': { body: { recoveryCodesRemaining: 2 } } });
    const { history } = renderApp('/login');
    await user.type(await screen.findByLabelText('Password'), 'correct horse battery staple');
    await user.click(screen.getByRole('radio', { name: 'Recovery code' }));
    await user.type(screen.getByLabelText('Recovery code'), '7kqm-w3xp-9dhr');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(history.location.pathname).toBe('/budget'));
    expect(requests.find((r) => r.method === 'POST')!.body).toEqual({
      password: 'correct horse battery staple',
      recoveryCode: '7kqm-w3xp-9dhr',
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Only 2 recovery codes left.');
  });

  it('explains a wrong password or code, and when to try again after too many attempts', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    fakeApi({
      ...SIGNED_OUT,
      'POST /api/auth/login': () =>
        ++attempts === 1
          ? json({ code: 'invalid_credentials', message: 'Wrong password or code.' }, 401)
          : json({ code: 'rate_limited', message: 'Too many sign-in attempts. Wait a minute and try again.' }, 429, {
              'Retry-After': '42',
            }),
    });
    const { history } = renderApp('/login');
    await user.type(await screen.findByLabelText('Password'), 'guess');
    await user.type(screen.getByLabelText('Authenticator code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong password or code.');
    expect(history.location.pathname).toBe('/login');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('You can try again in 42 seconds.'));
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run src/web/auth`
Expected: FAIL — `Test Files  4 failed (4)`, `Tests  5 failed (5)`: `Failed to resolve import "./totp-qr"` and `"./recovery-codes"`, and the screen tests can't find `Setup token` or `Password` (the routes still show placeholders).

- [ ] **Step 4: The auth calls and the pieces**

Create `src/web/auth/auth-api.ts`:

```ts
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { LoginRequest, SetupRequest } from '../../shared/auth';
import { api, unwrap } from '../lib/api';
import { forgetSession, queryKeys } from '../lib/query';

/** The auth endpoints (spec §12). None of them is an undoable command. */
export const authApi = {
  setupSecret: (setupToken: string) => unwrap(api.api.auth.setup.totp.$post({ json: { setupToken } })),
  setup: (body: SetupRequest) => unwrap(api.api.auth.setup.$post({ json: body })),
  login: (body: LoginRequest) => unwrap(api.api.auth.login.$post({ json: body })),
  logout: () => unwrap(api.api.auth.logout.$post()),
};

/** Records a new session (after setup or sign-in) and opens `href` (default: the budget). */
export function useEnterApp() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return (href = '/budget') => {
    queryClient.setQueryData(queryKeys.authStatus, { setupRequired: false, authenticated: true });
    return navigate({ href });
  };
}

/** Forgets the session's data and shows the sign-in page (after signing out). */
export function useLeaveApp() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return () => {
    forgetSession(queryClient);
    return navigate({ to: '/login' });
  };
}
```

Create `src/web/auth/totp-qr.tsx`:

```tsx
import QRCode from 'qrcode';
import { useMemo } from 'react';

/** One SVG path with a 1 × 1 square per dark module, merging runs of modules in a row. */
function qrPath(text: string): { d: string; size: number } {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  let d = '';
  for (let row = 0; row < modules.size; row++) {
    for (let col = 0; col < modules.size; col++) {
      if (!modules.get(row, col)) continue;
      let run = 1;
      while (col + run < modules.size && modules.get(row, col + run)) run++;
      d += `M${col} ${row}h${run}v1h-${run}z`;
      col += run - 1;
    }
  }
  return { d, size: modules.size };
}

const QUIET_ZONE = 4;

/**
 * The authenticator's otpauth:// URI as a QR code, drawn as inline SVG: the strict CSP (img-src 'self') blocks data:
 * images, and nothing is sent anywhere to render it.
 */
export function TotpQrCode({ uri }: { uri: string }) {
  const { d, size } = useMemo(() => qrPath(uri), [uri]);
  const box = size + 2 * QUIET_ZONE;
  return (
    <svg
      role="img"
      aria-label="QR code for your authenticator app"
      viewBox={`0 0 ${box} ${box}`}
      shapeRendering="crispEdges"
      className="mx-auto size-56 rounded-lg bg-white"
    >
      <path d={d} fill="#000" transform={`translate(${QUIET_ZONE} ${QUIET_ZONE})`} />
    </svg>
  );
}

/** The secret in groups of four, for typing it into an authenticator app by hand. */
export function TotpSecret({ secret }: { secret: string }) {
  return (
    <p className="text-center text-sm text-gray-600">
      Can't scan it? Enter this key instead:
      <span data-testid="totp-secret" className="mt-1 block font-mono text-base tracking-wider text-gray-900 select-all">
        {secret.match(/.{1,4}/g)?.join(' ')}
      </span>
    </p>
  );
}
```

Create `src/web/auth/recovery-codes.tsx`:

```tsx
import { useState } from 'react';
import { Button } from '../ui/button';

/** The recovery codes, shown once (spec §12), with Copy and Download so the owner can keep them somewhere safe. */
export function RecoveryCodes({ codes }: { codes: string[] }) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const text = `Budget Track recovery codes (each works once)\n\n${codes.join('\n')}\n`;
  const onCopy = () =>
    navigator.clipboard.writeText(text).then(
      () => setCopy('copied'),
      () => setCopy('failed'),
    );
  return (
    <div className="flex flex-col gap-3">
      <ol aria-label="Recovery codes" className="grid grid-cols-2 gap-2 rounded-xl bg-gray-100 p-4 font-mono text-sm">
        {codes.map((code) => (
          <li key={code} className="text-center whitespace-nowrap">
            {code}
          </li>
        ))}
      </ol>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" onClick={onCopy}>
          {copy === 'copied' ? 'Copied' : 'Copy'}
        </Button>
        <a
          href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`}
          download="budget-track-recovery-codes.txt"
          className="inline-flex min-h-11 items-center justify-center rounded-xl bg-white font-semibold ring-1 ring-gray-300 hover:bg-gray-50"
        >
          Download
        </a>
      </div>
      {copy === 'failed' && <p className="text-sm text-red-600">Couldn't copy. Select the codes and copy them instead.</p>}
    </div>
  );
}
```

- [ ] **Step 5: The screens**

Create `src/web/auth/setup-screen.tsx`:

```tsx
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { PASSWORD_MIN_LENGTH, setupRequestSchema } from '../../shared/auth';
import { ApiError } from '../lib/api';
import { type FormErrors, formErrorsOf, NO_ERRORS, zodFormErrors } from '../lib/form-errors';
import { Button } from '../ui/button';
import { Checkbox, FormError, TextField } from '../ui/field';
import { authApi, useEnterApp } from './auth-api';
import { RecoveryCodes } from './recovery-codes';
import { TotpQrCode, TotpSecret } from './totp-qr';

type Step = 'token' | 'password' | 'authenticator' | 'codes';

const STEP_TITLES: Record<Step, string> = {
  token: 'Set up your budget',
  password: 'Choose a password',
  authenticator: 'Add an authenticator',
  codes: 'Save your recovery codes',
};

/**
 * First-run setup (spec §12): the setup token, a password, an authenticator app (QR code and a code from it), then the
 * ten recovery codes, shown once. Setup signs the owner in, so the last step continues into the app.
 */
export function SetupScreen() {
  const [step, setStep] = useState<Step>('token');
  const [setupToken, setSetupToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [passwordErrors, setPasswordErrors] = useState<FormErrors>(NO_ERRORS);
  const [totpCode, setTotpCode] = useState('');
  const [saved, setSaved] = useState(false);
  const enterApp = useEnterApp();

  const secret = useMutation({ mutationFn: authApi.setupSecret, onSuccess: () => setStep('password') });
  const setup = useMutation({ mutationFn: authApi.setup, onSuccess: () => setStep('codes') });
  const tokenErrors = formErrorsOf(secret.error, ['setupToken']);
  const setupErrors = formErrorsOf(setup.error, ['totpCode']);
  const alreadySetUp = [secret.error, setup.error].some((e) => e instanceof ApiError && e.code === 'already_setup');

  const submitToken = (event: FormEvent) => {
    event.preventDefault();
    secret.mutate(setupToken);
  };
  const submitPassword = (event: FormEvent) => {
    event.preventDefault();
    // The server checks the password only at the end; the shared schema finds a weak one now.
    const checked = setupRequestSchema.pick({ password: true }).safeParse({ password });
    if (!checked.success) setPasswordErrors(zodFormErrors(checked.error, ['password']));
    else if (confirm !== password) setPasswordErrors({ fields: { confirm: "The passwords don't match." }, form: null });
    else {
      setPasswordErrors(NO_ERRORS);
      setStep('authenticator');
    }
  };
  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    if (secret.data) setup.mutate({ setupToken, password, totpSecret: secret.data.secret, totpCode });
  };

  return (
    <section className="flex flex-col gap-4 rounded-2xl bg-white p-5 shadow-sm">
      <h1 className="text-xl font-semibold">{STEP_TITLES[step]}</h1>

      {step === 'token' && (
        <form onSubmit={submitToken} className="flex flex-col gap-4" noValidate>
          <p className="text-gray-600">Enter the setup token from the server's configuration (SETUP_TOKEN).</p>
          <TextField
            label="Setup token"
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            error={tokenErrors.fields.setupToken}
          />
          <FormError message={tokenErrors.form} />
          {alreadySetUp && (
            <Link to="/login" className="text-brand underline">
              Go to sign in
            </Link>
          )}
          <Button type="submit" mutating busy={secret.isPending} block>
            Continue
          </Button>
        </form>
      )}

      {step === 'password' && (
        <form onSubmit={submitPassword} className="flex flex-col gap-4" noValidate>
          <TextField
            label="Password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint={`At least ${PASSWORD_MIN_LENGTH} characters. A few random words work well.`}
            error={passwordErrors.fields.password}
          />
          <TextField
            label="Repeat the password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            error={passwordErrors.fields.confirm}
          />
          <FormError message={passwordErrors.form} />
          <Button type="submit" block>
            Continue
          </Button>
        </form>
      )}

      {step === 'authenticator' && secret.data && (
        <form onSubmit={submitCode} className="flex flex-col gap-4" noValidate>
          <p className="text-gray-600">
            Scan this code with an authenticator app (such as Google Authenticator or 1Password), then enter the 6-digit
            code it shows.
          </p>
          <TotpQrCode uri={secret.data.uri} />
          <TotpSecret secret={secret.data.secret} />
          <TextField
            label="Code from the app"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
            error={setupErrors.fields.totpCode}
          />
          <FormError message={setupErrors.form} />
          <Button type="submit" mutating busy={setup.isPending} block>
            Finish setup
          </Button>
          <Button variant="ghost" onClick={() => setStep('password')}>
            Back
          </Button>
        </form>
      )}

      {step === 'codes' && setup.data && (
        <div className="flex flex-col gap-4">
          <p className="text-gray-600">
            If you lose your phone, sign in with one of these codes instead of an authenticator code. Each works once,
            and they won't be shown again.
          </p>
          <RecoveryCodes codes={setup.data.recoveryCodes} />
          <Checkbox label="I've saved my recovery codes" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          <Button block disabled={!saved} onClick={() => enterApp()}>
            Continue to the budget
          </Button>
        </div>
      )}
    </section>
  );
}
```

Create `src/web/auth/login-screen.tsx`:

```tsx
import { useMutation } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { formErrorsOf } from '../lib/form-errors';
import { Button } from '../ui/button';
import { FormError, SegmentedControl, TextField } from '../ui/field';
import { useToast } from '../ui/toast';
import { authApi, useEnterApp } from './auth-api';

type Factor = 'totp' | 'recovery';

const FACTORS = [
  { value: 'totp', label: 'Authenticator code' },
  { value: 'recovery', label: 'Recovery code' },
] as const;

/** Warn when this few recovery codes are left. */
const LOW_RECOVERY_CODES = 3;

/** Sign-in (spec §12): the password plus an authenticator code, or plus a recovery code. */
export function LoginScreen() {
  const { redirect } = useSearch({ from: '/auth/login' });
  const [factor, setFactor] = useState<Factor>('totp');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const enterApp = useEnterApp();
  const toast = useToast();
  const login = useMutation({
    mutationFn: authApi.login,
    onSuccess: ({ recoveryCodesRemaining }) => {
      if (recoveryCodesRemaining <= LOW_RECOVERY_CODES) {
        toast.show({
          message: `Only ${recoveryCodesRemaining} recovery codes left. Make new ones in Settings.`,
          duration: 10_000,
        });
      }
      return enterApp(redirect);
    },
  });
  const errors = formErrorsOf(login.error, ['password', 'totpCode', 'recoveryCode']);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate(factor === 'totp' ? { password, totpCode: code } : { password, recoveryCode: code });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-2xl bg-white p-5 shadow-sm" noValidate>
      <h1 className="text-xl font-semibold">Sign in</h1>
      <TextField
        label="Password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={errors.fields.password}
      />
      <SegmentedControl
        label="Second factor"
        value={factor}
        options={FACTORS}
        onChange={(value) => {
          setFactor(value);
          setCode('');
        }}
      />
      {factor === 'totp' ? (
        <TextField
          key="totp"
          label="Authenticator code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          error={errors.fields.totpCode}
        />
      ) : (
        <TextField
          key="recovery"
          label="Recovery code"
          autoComplete="off"
          spellCheck={false}
          placeholder="XXXX-XXXX-XXXX"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          error={errors.fields.recoveryCode}
        />
      )}
      <FormError message={errors.form} />
      <Button type="submit" mutating busy={login.isPending} block>
        Sign in
      </Button>
    </form>
  );
}
```

```bash
git apply <<'PATCH'
diff --git a/src/web/router.tsx b/src/web/router.tsx
index 6563480..a4922c7 100644
--- a/src/web/router.tsx
+++ b/src/web/router.tsx
@@ -7,6 +7,8 @@ import {
   redirect,
   type RouterHistory,
 } from '@tanstack/react-router';
+import { LoginScreen } from './auth/login-screen';
+import { SetupScreen } from './auth/setup-screen';
 import { authStatusQuery } from './lib/query';
 import { AppShell, AuthLayout } from './shell/app-shell';
 import { OfflineBanner } from './shell/offline-banner';
@@ -52,7 +54,7 @@ const setupRoute = createRoute({
     const status = await context.queryClient.ensureQueryData(authStatusQuery);
     if (!status.setupRequired) throw redirect({ to: status.authenticated ? '/budget' : '/login' });
   },
-  component: () => <PlaceholderScreen name="Set up" />,
+  component: SetupScreen,
 });
 
 const loginRoute = createRoute({
@@ -67,7 +69,7 @@ const loginRoute = createRoute({
     if (status.setupRequired) throw redirect({ to: '/setup' });
     if (status.authenticated) throw redirect({ to: '/budget' });
   },
-  component: () => <PlaceholderScreen name="Sign in" />,
+  component: LoginScreen,
 });
 
 // Everything else needs a session and lives in the app shell. A later phase adds its screens here.
PATCH
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/web/auth`
Expected: `Tests  11 passed (11)`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  71 passed (71)`, `Tests  561 passed (561)` (+4 test files, +11 tests); both checks exit 0.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/web
git commit -m "feat(web): setup wizard with an inline-SVG QR code, and sign-in" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---
### Task 9: Settings, and the Playwright smoke test

Spec §11 Settings, §12 Settings actions, §14 Web. Settings lists:
- **Security**: Change password (current password, the new one twice, an authenticator code), Change authenticator app (shows a new QR code first; then a code from the new app, the password, and a code from the current app or a recovery code), New recovery codes (password and a code; the new codes are shown once). Each opens in a `Sheet`, which unmounts the form when it closes, so it starts empty every time; success closes it with a toast.
- **Data**: Download JSON export, a plain `<a href="/api/export" download>` (P2d2's endpoint; the service worker never answers `/api`, so the download reaches the server).
- **Sessions**: Sign out (disabled offline) and Sign out everywhere (after a confirmation sheet); both forget the cached data and open sign-in.

The end-to-end test runs the built app as the Docker image does (`npm run test:e2e` builds first). `e2e/global-setup.ts` starts Postgres 16 with Testcontainers (Ryuk disabled, as for the server tests; the teardown stops it) and `dist/server/main.js` on a free port with a random `ENCRYPTION_KEY` and `COOKIE_SECURE=false`. Playwright drives Chromium only, emulating a 390×844 phone. The test sets up the budget, signs out, signs in with an authenticator code, opens `/settings` with a full page load (the service worker answers it), signs out everywhere, and signs in with a recovery code. It also checks that the service worker is `/sw.js`, that a page load of `/api/auth/status` reaches the server, and that no page load reported a CSP violation. Codes come from otplib: each sign-in after the first takes the code of the next 30 s step, which the server's ±1 window accepts and which is newer than the last one used.

That check found that zod 4 compiles its parsers with `new Function()` (and probing for it already counts as a violation): without `src/web/zod-jitless.ts` the test fails with `script-src (eval)` violations on `/` and `/settings`. `main.tsx` imports it first, so `z.config({ jitless: true })` runs before any schema is built.

**Files:**
- Create: `src/web/settings/{settings-screen,security-forms}.tsx`, `src/web/zod-jitless.ts`, `playwright.config.ts`, `e2e/{env,global-setup,smoke.spec}.ts`
- Modify: `src/web/auth/auth-api.ts`, `src/web/router.tsx`, `src/web/main.tsx`, `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.js`, `.gitignore`
- Test: `src/web/settings/settings-screen.test.tsx`, `e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: Tasks 5–8; `POST /api/auth/password`, `/totp/secret`, `/totp`, `/recovery-codes`, `/logout`, `/logout-all`; `ChangePasswordRequest`, `ConfirmTotpRequest`, `ReauthRequest`; `GET /api/export` (P2d2).
- Produces:
  - `authApi.{ logoutAll, changePassword, newTotpSecret, confirmTotp, newRecoveryCodes }`.
  - `SettingsScreen` (route `/settings`); `ChangePasswordForm`, `ChangeAuthenticatorForm`, `NewRecoveryCodesForm` (`{ onDone }`).
  - Script `test:e2e`; `E2E_SETUP_TOKEN`, `baseURL()` (`e2e/env.ts`).

- [ ] **Step 1: Write the failing test**

Create `src/web/settings/settings-screen.test.tsx`:

```tsx
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { fakeApi, json } from '../test/fake-api';
import { renderApp, SIGNED_IN } from '../test/render';

const SECRET = 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU';
const WRONG = { code: 'invalid_credentials', message: 'Your current password or code is wrong.' };

async function openSettings(routes: Parameters<typeof fakeApi>[0] = {}) {
  const server = fakeApi({ ...SIGNED_IN, ...routes });
  const app = renderApp('/settings');
  await screen.findByRole('heading', { name: 'Settings' });
  return { ...server, ...app, user: userEvent.setup() };
}

const posts = (requests: { method: string; path: string; body: unknown }[]) =>
  requests.filter((r) => r.method === 'POST').map(({ path, body }) => ({ path, body }));

describe('settings', () => {
  it('changes the password with the current one and an authenticator code', async () => {
    let calls = 0;
    const { user, requests } = await openSettings({
      'POST /api/auth/password': () => (++calls === 1 ? json(WRONG, 422) : { body: { ok: true } }),
    });
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    const sheet = screen.getByRole('dialog', { name: 'Change password' });
    await user.type(within(sheet).getByLabelText('Current password'), 'old password!');
    await user.type(within(sheet).getByLabelText('New password'), 'a brand new passphrase');
    await user.type(within(sheet).getByLabelText('Repeat the new password'), 'a brand new passphrase?');
    await user.type(within(sheet).getByLabelText('Authenticator code'), '123456');
    await user.click(within(sheet).getByRole('button', { name: 'Change password' }));
    expect(within(sheet).getByLabelText('Repeat the new password')).toHaveAccessibleDescription("The passwords don't match.");
    expect(posts(requests)).toEqual([]);

    await user.type(within(sheet).getByLabelText('Repeat the new password'), '{Backspace}');
    await user.click(within(sheet).getByRole('button', { name: 'Change password' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('Your current password or code is wrong.');
    await user.click(within(sheet).getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Password changed. Other devices were signed out.');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posts(requests).at(-1)).toEqual({
      path: '/api/auth/password',
      body: { currentPassword: 'old password!', newPassword: 'a brand new passphrase', totpCode: '123456' },
    });
  });

  it('switches the authenticator app, confirming with a recovery code', async () => {
    const { user, requests } = await openSettings({
      'POST /api/auth/totp/secret': { body: { secret: SECRET, uri: `otpauth://totp/Budget%20Track:owner?secret=${SECRET}` } },
      'POST /api/auth/totp': { body: { ok: true } },
    });
    await user.click(screen.getByRole('button', { name: 'Change authenticator app' }));
    const sheet = screen.getByRole('dialog', { name: 'Change authenticator app' });
    await user.click(within(sheet).getByRole('button', { name: 'Show the new QR code' }));
    expect(await within(sheet).findByRole('img', { name: 'QR code for your authenticator app' })).toBeInTheDocument();
    expect(within(sheet).getByTestId('totp-secret')).toHaveTextContent('KRSX G5CT');
    await user.type(within(sheet).getByLabelText('Code from the new app'), '654321');
    await user.type(within(sheet).getByLabelText('Current password'), 'my password!');
    await user.click(within(sheet).getByRole('radio', { name: 'Recovery code' }));
    await user.type(within(sheet).getByLabelText('Recovery code'), 'AAAA-BBBB-CCCC');
    await user.click(within(sheet).getByRole('button', { name: 'Switch authenticator' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Authenticator changed.');
    expect(posts(requests).at(-1)).toEqual({
      path: '/api/auth/totp',
      body: { currentPassword: 'my password!', recoveryCode: 'AAAA-BBBB-CCCC', totpSecret: SECRET, totpCode: '654321' },
    });
  });

  it('makes new recovery codes and shows them once', async () => {
    const codes = Array.from({ length: 10 }, (_, i) => `NEWC-ODES-00${String(i).padStart(2, '0')}`);
    const { user } = await openSettings({ 'POST /api/auth/recovery-codes': { body: { recoveryCodes: codes } } });
    await user.click(screen.getByRole('button', { name: 'New recovery codes' }));
    const sheet = screen.getByRole('dialog', { name: 'New recovery codes' });
    await user.type(within(sheet).getByLabelText('Current password'), 'my password!');
    await user.type(within(sheet).getByLabelText('Authenticator code'), '123456');
    await user.click(within(sheet).getByRole('button', { name: 'Make new codes' }));
    const list = await within(sheet).findByRole('list', { name: 'Recovery codes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    await user.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('links to the JSON export', async () => {
    await openSettings();
    const link = screen.getByRole('link', { name: 'Download JSON export' });
    expect(link).toHaveAttribute('href', '/api/export');
    expect(link).toHaveAttribute('download');
  });

  it('signs out this device', async () => {
    const { user, history, requests } = await openSettings({ 'POST /api/auth/logout': { body: { ok: true } } });
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(history.location.pathname).toBe('/login'));
    expect(posts(requests)).toEqual([{ path: '/api/auth/logout', body: undefined }]);
  });

  it('cannot sign out while offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await openSettings();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDisabled();
  });

  it('signs out everywhere after asking', async () => {
    const { user, history, requests } = await openSettings({ 'POST /api/auth/logout-all': { body: { ok: true } } });
    await user.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    const sheet = screen.getByRole('dialog', { name: 'Sign out everywhere' });
    expect(posts(requests)).toEqual([]);
    await user.click(within(sheet).getByRole('button', { name: 'Sign out everywhere' }));
    await waitFor(() => expect(history.location.pathname).toBe('/login'));
    expect(posts(requests)).toEqual([{ path: '/api/auth/logout-all', body: undefined }]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/web/settings`
Expected: FAIL — `Tests  7 failed (7)`: `Unable to find an accessible element with the role "button" and name "Change password"` (and the other rows): `/settings` is still a placeholder.

- [ ] **Step 3: The Settings screen**

```bash
git apply <<'PATCH'
diff --git a/src/web/auth/auth-api.ts b/src/web/auth/auth-api.ts
index 4831ac2..0bbf7d8 100644
--- a/src/web/auth/auth-api.ts
+++ b/src/web/auth/auth-api.ts
@@ -1,6 +1,12 @@
 import { useQueryClient } from '@tanstack/react-query';
 import { useNavigate } from '@tanstack/react-router';
-import type { LoginRequest, SetupRequest } from '../../shared/auth';
+import type {
+  ChangePasswordRequest,
+  ConfirmTotpRequest,
+  LoginRequest,
+  ReauthRequest,
+  SetupRequest,
+} from '../../shared/auth';
 import { api, unwrap } from '../lib/api';
 import { forgetSession, queryKeys } from '../lib/query';
 
@@ -10,6 +16,11 @@ export const authApi = {
   setup: (body: SetupRequest) => unwrap(api.api.auth.setup.$post({ json: body })),
   login: (body: LoginRequest) => unwrap(api.api.auth.login.$post({ json: body })),
   logout: () => unwrap(api.api.auth.logout.$post()),
+  logoutAll: () => unwrap(api.api.auth['logout-all'].$post()),
+  changePassword: (body: ChangePasswordRequest) => unwrap(api.api.auth.password.$post({ json: body })),
+  newTotpSecret: () => unwrap(api.api.auth.totp.secret.$post()),
+  confirmTotp: (body: ConfirmTotpRequest) => unwrap(api.api.auth.totp.$post({ json: body })),
+  newRecoveryCodes: (body: ReauthRequest) => unwrap(api.api.auth['recovery-codes'].$post({ json: body })),
 };
 
 /** Records a new session (after setup or sign-in) and opens `href` (default: the budget). */
PATCH
```

Create `src/web/settings/security-forms.tsx`:

```tsx
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { PASSWORD_MIN_LENGTH } from '../../shared/auth';
import { authApi } from '../auth/auth-api';
import { RecoveryCodes } from '../auth/recovery-codes';
import { TotpQrCode, TotpSecret } from '../auth/totp-qr';
import { formErrorsOf } from '../lib/form-errors';
import { Button } from '../ui/button';
import { FormError, SegmentedControl, TextField } from '../ui/field';
import { useToast } from '../ui/toast';

/** Each form below runs inside a Sheet, which unmounts it on close, so every opening starts empty. */
interface FormProps {
  onDone: () => void;
}

const sixDigits = (value: string) => value.replace(/\D/g, '').slice(0, 6);

function CodeField(props: { label: string; value: string; onChange: (value: string) => void; error?: string }) {
  return (
    <TextField
      label={props.label}
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={6}
      value={props.value}
      onChange={(e) => props.onChange(sixDigits(e.target.value))}
      error={props.error}
    />
  );
}

function CurrentPasswordField(props: { value: string; onChange: (value: string) => void; error?: string }) {
  return (
    <TextField
      label="Current password"
      type="password"
      autoComplete="current-password"
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      error={props.error}
    />
  );
}

/** Spec §12: a new password needs the current one and an authenticator code; other devices are signed out. */
export function ChangePasswordForm({ onDone }: FormProps) {
  const toast = useToast();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const change = useMutation({
    mutationFn: authApi.changePassword,
    onSuccess: () => {
      toast.show({ message: 'Password changed. Other devices were signed out.' });
      onDone();
    },
  });
  const errors = formErrorsOf(change.error, ['currentPassword', 'newPassword', 'totpCode']);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setMismatch(confirm !== newPassword);
    if (confirm === newPassword) change.mutate({ currentPassword, newPassword, totpCode });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <CurrentPasswordField value={currentPassword} onChange={setCurrentPassword} error={errors.fields.currentPassword} />
      <TextField
        label="New password"
        type="password"
        autoComplete="new-password"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
        error={errors.fields.newPassword}
      />
      <TextField
        label="Repeat the new password"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        error={mismatch ? "The passwords don't match." : undefined}
      />
      <CodeField label="Authenticator code" value={totpCode} onChange={setTotpCode} error={errors.fields.totpCode} />
      <FormError message={errors.form} />
      <Button type="submit" mutating busy={change.isPending} block>
        Change password
      </Button>
    </form>
  );
}

type Factor = 'totp' | 'recovery';

/**
 * Spec §12: switching authenticators needs the password plus the current authenticator code or a recovery code (for
 * a lost phone), and a code from the new authenticator. Other devices are signed out.
 */
export function ChangeAuthenticatorForm({ onDone }: FormProps) {
  const toast = useToast();
  const [currentPassword, setCurrentPassword] = useState('');
  const [factor, setFactor] = useState<Factor>('totp');
  const [currentCode, setCurrentCode] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const secret = useMutation({ mutationFn: authApi.newTotpSecret });
  const confirm = useMutation({
    mutationFn: authApi.confirmTotp,
    onSuccess: () => {
      toast.show({ message: 'Authenticator changed. Other devices were signed out.' });
      onDone();
    },
  });
  const errors = formErrorsOf(confirm.error ?? secret.error, ['currentPassword', 'currentTotpCode', 'recoveryCode', 'totpCode']);

  if (!secret.data) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-gray-600">
          You'll scan a new QR code with your authenticator app. The old entry stops working, and other devices are
          signed out.
        </p>
        <FormError message={errors.form} />
        <Button mutating busy={secret.isPending} block onClick={() => secret.mutate()}>
          Show the new QR code
        </Button>
      </div>
    );
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const current = factor === 'totp' ? { currentTotpCode: currentCode } : { recoveryCode: currentCode };
    confirm.mutate({ currentPassword, ...current, totpSecret: secret.data.secret, totpCode });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <TotpQrCode uri={secret.data.uri} />
      <TotpSecret secret={secret.data.secret} />
      <CodeField label="Code from the new app" value={totpCode} onChange={setTotpCode} error={errors.fields.totpCode} />
      <CurrentPasswordField value={currentPassword} onChange={setCurrentPassword} error={errors.fields.currentPassword} />
      <SegmentedControl
        label="Confirm with"
        value={factor}
        options={[
          { value: 'totp', label: 'Current app' },
          { value: 'recovery', label: 'Recovery code' },
        ]}
        onChange={(value) => {
          setFactor(value);
          setCurrentCode('');
        }}
      />
      {factor === 'totp' ? (
        <CodeField
          label="Code from the current app"
          value={currentCode}
          onChange={setCurrentCode}
          error={errors.fields.currentTotpCode}
        />
      ) : (
        <TextField
          label="Recovery code"
          autoComplete="off"
          spellCheck={false}
          value={currentCode}
          onChange={(e) => setCurrentCode(e.target.value)}
          error={errors.fields.recoveryCode}
        />
      )}
      <FormError message={errors.form} />
      <Button type="submit" mutating busy={confirm.isPending} block>
        Switch authenticator
      </Button>
    </form>
  );
}

/** Spec §12: a new set of ten recovery codes replaces the old ones; they are shown once. */
export function NewRecoveryCodesForm({ onDone }: FormProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const create = useMutation({ mutationFn: authApi.newRecoveryCodes });
  const errors = formErrorsOf(create.error, ['currentPassword', 'totpCode']);
  if (create.data) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-gray-600">Your old recovery codes no longer work. Save these; they won't be shown again.</p>
        <RecoveryCodes codes={create.data.recoveryCodes} />
        <Button block onClick={onDone}>
          Done
        </Button>
      </div>
    );
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({ currentPassword, totpCode });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <p className="text-gray-600">The new codes replace all the old ones, used or not.</p>
      <CurrentPasswordField value={currentPassword} onChange={setCurrentPassword} error={errors.fields.currentPassword} />
      <CodeField label="Authenticator code" value={totpCode} onChange={setTotpCode} error={errors.fields.totpCode} />
      <FormError message={errors.form} />
      <Button type="submit" mutating busy={create.isPending} block>
        Make new codes
      </Button>
    </form>
  );
}
```

Create `src/web/settings/settings-screen.tsx`:

```tsx
import { useMutation } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { authApi, useLeaveApp } from '../auth/auth-api';
import { errorMessage } from '../lib/commands';
import { useOnline } from '../lib/online';
import { Button } from '../ui/button';
import { cx } from '../ui/cx';
import { ChevronRightIcon } from '../ui/icons';
import { Sheet } from '../ui/sheet';
import { useToast } from '../ui/toast';
import { ChangeAuthenticatorForm, ChangePasswordForm, NewRecoveryCodesForm } from './security-forms';

type Open = 'password' | 'authenticator' | 'recovery-codes' | 'sign-out-everywhere' | null;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="px-4 pb-1 text-xs font-semibold tracking-wide text-gray-500 uppercase">{title}</h2>
      <div className="divide-y divide-gray-200 border-y border-gray-200">{children}</div>
    </section>
  );
}

const rowClass =
  'flex min-h-14 w-full items-center justify-between px-4 text-left text-base hover:bg-gray-50 disabled:text-gray-400';

interface RowProps {
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
  /** The row itself sends a request: disabled while offline. */
  mutating?: boolean;
}

function Row({ children, onClick, danger, mutating }: RowProps) {
  const online = useOnline();
  return (
    <button
      type="button"
      className={cx(rowClass, danger && 'text-red-600')}
      disabled={mutating && !online}
      onClick={onClick}
    >
      {children}
      <ChevronRightIcon className="text-gray-400" />
    </button>
  );
}

/** Spec §11 Settings: password, authenticator, recovery codes, signing out, and the JSON export. */
export function SettingsScreen() {
  const [open, setOpen] = useState<Open>(null);
  const close = () => setOpen(null);
  const toast = useToast();
  const leaveApp = useLeaveApp();
  const onSignOutFailed = (error: unknown) => toast.show({ tone: 'error', message: errorMessage(error) });
  const signOut = useMutation({ mutationFn: authApi.logout, onSuccess: () => leaveApp(), onError: onSignOutFailed });
  const signOutEverywhere = useMutation({
    mutationFn: authApi.logoutAll,
    onSuccess: () => leaveApp(),
    onError: onSignOutFailed,
  });

  return (
    <div className="pb-6">
      <Section title="Security">
        <Row onClick={() => setOpen('password')}>Change password</Row>
        <Row onClick={() => setOpen('authenticator')}>Change authenticator app</Row>
        <Row onClick={() => setOpen('recovery-codes')}>New recovery codes</Row>
      </Section>

      <Section title="Data">
        {/* A plain download: the service worker never answers /api, so this reaches the server. */}
        <a href="/api/export" download className={rowClass}>
          Download JSON export
          <ChevronRightIcon className="text-gray-400" />
        </a>
      </Section>

      <Section title="Sessions">
        <Row mutating onClick={() => signOut.mutate()}>
          Sign out
        </Row>
        <Row danger onClick={() => setOpen('sign-out-everywhere')}>
          Sign out everywhere
        </Row>
      </Section>

      <Sheet open={open === 'password'} onClose={close} title="Change password">
        <ChangePasswordForm onDone={close} />
      </Sheet>
      <Sheet open={open === 'authenticator'} onClose={close} title="Change authenticator app">
        <ChangeAuthenticatorForm onDone={close} />
      </Sheet>
      <Sheet open={open === 'recovery-codes'} onClose={close} title="New recovery codes">
        <NewRecoveryCodesForm onDone={close} />
      </Sheet>
      <Sheet open={open === 'sign-out-everywhere'} onClose={close} title="Sign out everywhere">
        <div className="flex flex-col gap-4">
          <p className="text-gray-600">Every device signed in to this budget, this one included, will be signed out.</p>
          <Button variant="danger" mutating busy={signOutEverywhere.isPending} block onClick={() => signOutEverywhere.mutate()}>
            Sign out everywhere
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
```

```bash
git apply <<'PATCH'
diff --git a/src/web/router.tsx b/src/web/router.tsx
index a4922c7..bd02eac 100644
--- a/src/web/router.tsx
+++ b/src/web/router.tsx
@@ -10,6 +10,7 @@ import {
 import { LoginScreen } from './auth/login-screen';
 import { SetupScreen } from './auth/setup-screen';
 import { authStatusQuery } from './lib/query';
+import { SettingsScreen } from './settings/settings-screen';
 import { AppShell, AuthLayout } from './shell/app-shell';
 import { OfflineBanner } from './shell/offline-banner';
 import { MoreScreen, NotFoundScreen, PlaceholderScreen } from './shell/screens';
@@ -127,7 +128,7 @@ const appRoutes = [
     getParentRoute: () => appLayout,
     path: 'settings',
     staticData: { title: 'Settings' },
-    component: () => <PlaceholderScreen name="Settings" />,
+    component: SettingsScreen,
   }),
 ] as const;
 
PATCH
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/web/settings`
Expected: `Tests  7 passed (7)`.

- [ ] **Step 5: The end-to-end smoke test**

Run: `npm install -D @playwright/test@^1.65.1`
Expected: `package.json` lists `"@playwright/test": "^1.65.1"` under `devDependencies`.
Run: `npx playwright install chromium`
Expected: Chromium and its headless shell are downloaded (once per machine, into Playwright's cache).

```bash
git apply <<'PATCH'
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -17,6 +17,7 @@
     "test:engine": "vitest run --project engine",
     "test:server": "vitest run --project server",
     "test:web": "vitest run --project web",
+    "test:e2e": "npm run build && playwright test",
     "test:watch": "vitest",
     "typecheck": "tsc --noEmit && tsc --noEmit -p src/web/tsconfig.json",
     "lint": "eslint .",
PATCH
```

```bash
git apply <<'PATCH'
diff --git a/.gitignore b/.gitignore
index dd6ef19..9565f34 100644
--- a/.gitignore
+++ b/.gitignore
@@ -4,3 +4,5 @@ coverage/
 .env
 *.log
 .DS_Store
+test-results/
+playwright-report/
diff --git a/eslint.config.js b/eslint.config.js
index 0473b9a..a7b6018 100644
--- a/eslint.config.js
+++ b/eslint.config.js
@@ -11,7 +11,7 @@ const nodeModules = `^(node:|(?:${builtinModules.join('|')})(?:/|$))`;
 const intoLayer = (...layers) => `^(?:\\.{1,2}/)*\\.\\./(?:[^/]+/)*(?:${layers.join('|')})(?:/|$)`;
 
 export default defineConfig(
-  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
+  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'test-results/**', 'playwright-report/**'] },
   js.configs.recommended,
   ...tseslint.configs.recommended,
   {
diff --git a/tsconfig.json b/tsconfig.json
index d1db8ba..fa5264a 100644
--- a/tsconfig.json
+++ b/tsconfig.json
@@ -19,8 +19,10 @@
   "include": [
     "src",
     "scripts",
+    "e2e",
     "vitest.config.ts",
     "vite.config.ts",
+    "playwright.config.ts",
     "drizzle.config.ts"
   ],
   "exclude": [
PATCH
```

Create `playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests against the built app (`npm run test:e2e` builds first) and a throwaway Postgres; see
 * e2e/global-setup.ts. Phone-sized, as the app is (spec §14: 390 × 844).
 */
export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  use: {
    browserName: 'chromium',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    trace: 'retain-on-failure',
  },
});
```

Create `e2e/env.ts`:

```ts
/** The SETUP_TOKEN the end-to-end server runs with. */
export const E2E_SETUP_TOKEN = 'e2e-setup-token-0123456789';

/** Where global-setup started the server (set there, read by the tests). */
export const baseURL = () => {
  const url = process.env.E2E_BASE_URL;
  if (!url) throw new Error('E2E_BASE_URL is not set: run the tests with `npm run test:e2e`');
  return url;
};
```

Create `e2e/global-setup.ts`:

```ts
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { E2E_SETUP_TOKEN } from './env';

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  server.close();
  await once(server, 'close');
  return port;
}

async function waitUntilHealthy(url: string, server: ChildProcess): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (server.exitCode !== null) throw new Error(`the server exited with code ${server.exitCode}`);
    const ok = await fetch(url).then(
      (res) => res.ok,
      () => false,
    );
    if (ok) return;
    await sleep(200);
  }
  throw new Error(`the server did not become healthy at ${url}`);
}

/**
 * Starts Postgres 16 (Testcontainers) and the built server (dist/) on a free port, like the Docker image runs it.
 * Docker Desktop's Enhanced Container Isolation blocks Ryuk, so the reaper is off and the teardown stops everything.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync('dist/server/main.js') || !existsSync('dist/web/index.html')) {
    throw new Error('Build the app first: `npm run test:e2e` runs `npm run build` before the tests.');
  }
  process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const database = await new PostgreSqlContainer('postgres:16-alpine').start();
  let server: ChildProcess | undefined;
  try {
    const port = await freePort();
    server = spawn(process.execPath, ['--enable-source-maps', 'dist/server/main.js'], {
      env: {
        ...process.env,
        DATABASE_URL: database.getConnectionUri(),
        ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        SETUP_TOKEN: E2E_SETUP_TOKEN,
        PORT: String(port),
        // Plain http on 127.0.0.1.
        COOKIE_SECURE: 'false',
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    process.env.E2E_BASE_URL = `http://127.0.0.1:${port}`;
    await waitUntilHealthy(`${process.env.E2E_BASE_URL}/healthz`, server);
  } catch (error) {
    server?.kill();
    await database.stop();
    throw error;
  }
  const running = server;
  return async () => {
    if (running.exitCode === null) {
      running.kill('SIGTERM');
      await once(running, 'exit');
    }
    await database.stop();
  };
}
```

Create `e2e/smoke.spec.ts`:

```ts
// The callbacks passed to page.evaluate and addInitScript run in the browser.
/// <reference lib="dom" />
import { expect, type Page, test } from '@playwright/test';
import { generate } from 'otplib';
import { baseURL, E2E_SETUP_TOKEN } from './env';

test.use({ baseURL: baseURL() });

const PASSWORD = 'correct horse battery staple';

/**
 * A code from the next 30 s step: the server's ±1 step window accepts it, and it is newer than the code used just
 * before (each code works once).
 */
const nextCode = (secret: string) => generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 });

/** Collects Content-Security-Policy violations on every page load, to check that the built app needs no exceptions. */
async function watchCsp(page: Page): Promise<string[]> {
  const violations: string[] = [];
  await page.exposeFunction('reportCspViolation', (violation: string) => violations.push(violation));
  await page.addInitScript(() => {
    const report = (window as unknown as { reportCspViolation: (v: string) => void }).reportCspViolation;
    document.addEventListener('securitypolicyviolation', (e) =>
      report(`${e.violatedDirective} (${e.blockedURI}) at ${e.sourceFile}:${e.lineNumber} on ${location.pathname}`),
    );
  });
  return violations;
}

async function signIn(page: Page, factor: { totpCode: string } | { recoveryCode: string }) {
  await page.getByLabel('Password').fill(PASSWORD);
  if ('totpCode' in factor) {
    await page.getByLabel('Authenticator code').fill(factor.totpCode);
  } else {
    await page.getByRole('radio', { name: 'Recovery code' }).click();
    await page.getByLabel('Recovery code').fill(factor.recoveryCode);
  }
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Budget' })).toBeVisible();
}

test('setup, sign-in with either factor, settings and sign-out', async ({ page }) => {
  const cspViolations = await watchCsp(page);

  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel('Setup token').fill(E2E_SETUP_TOKEN);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Repeat the password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  const secret = (await page.getByTestId('totp-secret').textContent())!.replace(/\s/g, '');
  await page.getByLabel('Code from the app').fill(await generate({ secret }));
  await page.getByRole('button', { name: 'Finish setup' }).click();
  const codes = page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem');
  await expect(codes).toHaveCount(10);
  const recoveryCodes = await codes.allTextContents();
  await page.getByLabel("I've saved my recovery codes").check();
  await page.getByRole('button', { name: 'Continue to the budget' }).click();
  await expect(page.getByRole('heading', { name: 'Budget' })).toBeVisible();

  await page.getByRole('link', { name: 'More' }).click();
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page, { totpCode: await nextCode(secret) });

  // A full page load of a deep link: the service worker answers it with the app shell.
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Sign out everywhere' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out everywhere' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page, { recoveryCode: recoveryCodes[0]! });

  const worker = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL);
  expect(worker).toBe(`${baseURL()}/sw.js`);
  // /api never comes from the service worker, not even as a page load.
  const status = await page.goto('/api/auth/status');
  expect(await status!.json()).toEqual({ setupRequired: false, authenticated: true });
  expect(cspViolations).toEqual([]);
});
```

Run: `npm run test:e2e`
Expected: FAIL — `1 failed`: `expect(cspViolations).toEqual([])` received `script-src (eval) at http://127.0.0.1:…/assets/index-….js:… on /` (and `on /settings`).

- [ ] **Step 6: Keep zod off eval**

Create `src/web/zod-jitless.ts`:

```ts
import { z } from 'zod';

// The CSP (script-src 'self') forbids eval. zod 4 compiles object parsers with new Function() unless told not to, and
// its check for whether that is allowed already counts as a CSP violation. main.tsx imports this module first, so the
// setting is in place before any schema is created.
z.config({ jitless: true });
```

```bash
git apply <<'PATCH'
diff --git a/src/web/main.tsx b/src/web/main.tsx
index e303da9..590207e 100644
--- a/src/web/main.tsx
+++ b/src/web/main.tsx
@@ -1,3 +1,4 @@
+import './zod-jitless';
 import { StrictMode } from 'react';
 import { createRoot } from 'react-dom/client';
 import { registerSW } from 'virtual:pwa-register';
PATCH
```

- [ ] **Step 7: Run everything**

Run: `npm run test:e2e`
Expected: `✓  1 e2e/smoke.spec.ts:42:1 › setup, sign-in with either factor, settings and sign-out`, `1 passed`.
Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  72 passed (72)`, `Tests  568 passed (568)` (+1 test file, +7 tests); both checks exit 0 (`npm test` doesn't run the end-to-end test).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json eslint.config.js .gitignore playwright.config.ts e2e src/web
git commit -m "feat(web): Settings; Playwright smoke test of setup, sign-in and sign-out" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---
### Task 10: P3a docs

The spec records what P3a decided where it was open: §2 `WEB_DIR`; §4.1 `totp_last_step`; §11 the shell's toasts, errors and 401 handling, Settings' sheets and the export link, the service worker and the manifest; §12 the setup page, single-use codes, cookie refresh, `Retry-After`, the sign-in queue, the global lockout as an accepted risk until internet exposure, the single trusted proxy, and the exact CSP; §14 the P3a part of the smoke test and the web unit tests; §15 static serving and cache headers. `p2-carry-over.md` gets "Resolved in P3a" and "From P3a" (appended); `engineering-notes.md` the auth changes and a new "Web app (P3a)" section with the conventions P3b and P3c build on; the README the status, the web scripts, `dev:web` with `PORT=3080`, the end-to-end test and `WEB_DIR`; `.env.example` the dev port.

**Files:**
- Modify: `docs/superpowers/specs/2026-11-19-core-budgeting-design.md`, `docs/superpowers/notes/p2-carry-over.md`, `docs/superpowers/notes/engineering-notes.md`, `README.md`, `.env.example`

- [ ] **Step 1: The spec**

```bash
git apply <<'PATCH'
diff --git a/docs/superpowers/specs/2026-11-19-core-budgeting-design.md b/docs/superpowers/specs/2026-11-19-core-budgeting-design.md
index 2291e40..de848b7 100644
--- a/docs/superpowers/specs/2026-11-19-core-budgeting-design.md
+++ b/docs/superpowers/specs/2026-11-19-core-budgeting-design.md
@@ -70,7 +70,7 @@ on each request; at single-user scale (≈10 years × 150 categories) this is we
 
 **Config (env):** `DATABASE_URL`, `ENCRYPTION_KEY` (32-byte key, base64, AES-256-GCM for the TOTP secret), `SETUP_TOKEN`,
 `TZ=Europe/Warsaw`, `PORT`, `COOKIE_SECURE` (default true), `TRUST_PROXY` (default false; take the client IP from
-`X-Forwarded-For`), `LOG_LEVEL`, `MIGRATIONS_DIR`. Sessions are opaque random tokens stored hashed, so no
+`X-Forwarded-For`), `LOG_LEVEL`, `MIGRATIONS_DIR`, `WEB_DIR` (the built web app, default `dist/web`). Sessions are opaque random tokens stored hashed, so no
 session-signing secret is needed.
 
 ## 3. Domain concepts
@@ -104,6 +104,7 @@ change.
 
 ### 4.1 Settings and auth
 - `app_user` (at most one row): `password_hash` (argon2id), `totp_secret_enc`, `recovery_code_hashes text[]`,
+  `totp_last_step` (the RFC 6238 time step of the newest authenticator code accepted, for replay protection),
   `base_currency` (`PLN`), `budget_start_month`.
 - `session`: `token_hash` (SHA-256 of a 256-bit random token), `expires_at`, `last_seen_at`, `user_agent`.
 - `login_attempt`: `at`, `success`, `ip` (for rate limiting and lockout).
@@ -466,6 +467,14 @@ All strategies except Underfunded may push RTA negative. Each auto-assign run is
 
 **Bottom navigation:** Budget · Accounts · **＋** (new transaction) · More (Scheduled, Payees, Settings).
 The header has Undo/Redo, and every successful command shows a toast with "Undo".
+- The header shows the screen's title; the Undo and Redo buttons are named after the command they would undo or redo
+  (`GET /api/undo`). The command toast shows the command's undo label; a newer command's toast replaces it, so only
+  the latest offers Undo. Undo/Redo show "Undone: …"/"Redone: …", or the server's message for a 409.
+- A network or server failure (5xx) of a command shows an error toast with Retry. Validation and domain errors are
+  shown on the form: field messages under their fields (by dotted path), anything else above the submit button.
+- A 401 `unauthorized` from any request (an expired or revoked session) forgets the cached data and opens sign-in,
+  which returns to the page afterwards (`/login?redirect=…`, same-app paths only).
+- On a desktop browser the phone layout is centred, at most 480 px wide.
 
 **Budget screen**
 - Month switcher (back to budget start; forward up to 24 months).
@@ -507,9 +516,17 @@ The header has Undo/Redo, and every successful command shows a toast with "Undo"
 **Payees:** list with search; rename, merge, delete.
 
 **Settings:** change password, regenerate TOTP secret and recovery codes, log out all sessions, download JSON export.
+Each security action opens a sheet that asks for the password and the current authenticator code (a recovery code
+also works for a new authenticator); "Sign out everywhere" asks for confirmation. The export is a plain download link
+to `GET /api/export`.
 
 **Offline:** when offline, a banner appears and every mutating control is disabled. The service worker caches only
 the app shell; `/api` is always network-only.
+- The service worker (vite-plugin-pwa, Workbox `generateSW`) precaches the build (scripts, styles, `index.html`,
+  icons, manifest) and answers page loads with `index.html`, except `/api/*` and `/healthz`; it has no runtime
+  caching, so every `/api` request goes to the network. It updates itself when a new build is deployed.
+- The app is installable: a web app manifest (standalone, portrait, brand green `#15803d`) with 192/512 px icons (the
+  512 px one also maskable) and an Apple touch icon, all generated by `scripts/generate-icons.ts`.
 
 ## 12. Security
 
@@ -517,19 +534,46 @@ the app shell; `/api` is always network-only.
 - `/setup` is enabled only while `app_user` is empty and requires `SETUP_TOKEN` (from env), entered on the page.
 - Steps: set password (min 12 chars) → scan TOTP QR (otplib, 30 s step, ±1 window) and confirm a code → 10 recovery
   codes shown once (stored as argon2 hashes, single-use).
+- The setup page asks for the token first (`POST /api/auth/setup/totp` checks it and returns the new secret), then
+  the password (checked in the browser with the shared schema, sent with the final step), then the QR code with the
+  secret as text in groups of four, then the recovery codes with Copy and Download (a text file). The QR code is
+  drawn as inline SVG, so the CSP needs no `data:` images and the secret never leaves the page.
+- Setup-token attempts are rate-limited like sign-ins: a wrong token is recorded as a failed sign-in attempt, so the
+  per-IP limit and the lockout below also stop guessing.
 
 **Login and sessions**
 - Login is password + TOTP code, or password + recovery code.
+- Each authenticator code works once (RFC 6238 §5.2): a code is accepted only if its time step is after
+  `app_user.totp_last_step`, which every accepted code (sign-in, re-authentication, the code confirming setup or a
+  new authenticator) moves forward. A code from an earlier step is refused even inside the ±1 window.
 - Session cookie: httpOnly, Secure, SameSite=Strict, opaque random token; the DB stores its SHA-256. 30-day sliding
   expiry.
+- `GET /api/auth/status` slides a live session and refreshes its cookie like any authenticated request. A cookie for
+  an unknown or expired session is cleared (`Max-Age=0`) by `/status` and by the 401 of any private route.
 
 **Rate limiting:** 5 login attempts per minute per IP. After 10 consecutive failures, login is locked for 15 minutes.
+- A 429 (`rate_limited` or `locked`) carries `Retry-After` in seconds: until the oldest attempt of the last minute is
+  a minute old, or until the lockout ends. The web app says when to try again.
+- Sign-ins, re-authentication and setup-token checks queue in the server process before taking the login lock
+  (advisory key 727274001), so waiting requests hold no database connection. A wait for another process's lock longer
+  than 5 s answers 503 `busy` with `Retry-After: 1`.
+- The lockout is global (it doesn't depend on the IP), so anyone who can reach the sign-in page can keep the owner
+  locked out with 10 wrong attempts every 15 minutes. That is accepted while the app is reached through a private
+  network or a reverse proxy that limits access; before exposing it to the internet, count failures per device
+  (a long-lived device cookie set at sign-in) and since the last success or lockout, and lock only unknown devices.
+- The client IP is the socket address, or with `TRUST_PROXY=true` the rightmost `X-Forwarded-For` entry. That trusts
+  exactly one reverse proxy, the one that appends the entry; chains of proxies aren't supported (the rightmost entry
+  would be the inner proxy's address).
 
 **Requests**
 - All `/api` routes except auth require a session.
 - Mutating requests must carry the header `X-Requested-With: budget-track` (CSRF defense on top of SameSite).
 - Security headers on all responses: strict CSP (self only), `X-Content-Type-Options`, `Referrer-Policy`,
   `frame-ancestors 'none'`.
+- The CSP is `default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`,
+  on the web app's files too. The built app needs no exception: no inline scripts or styles in `index.html`, the
+  service worker is registered from the bundle, zod runs `jitless` (no `new Function`), and images are files or inline
+  SVG. The end-to-end test fails on any CSP violation.
 
 **Secrets:** the TOTP secret is encrypted with AES-256-GCM using `ENCRYPTION_KEY`. HTTPS is terminated by the hosting
 platform or reverse proxy.
@@ -593,11 +637,20 @@ signs out other sessions.
 - Component tests (Vitest + Testing Library) for the amount keypad expression parser, split editor and category picker.
 - Playwright smoke test at a 390×844 viewport: setup → login → add checking account → add category →
   assign → add transaction → reconcile → undo.
+  P3a's part (`e2e/smoke.spec.ts`, `npm run test:e2e`): setup → sign out → sign in with a code → sign out everywhere
+  → sign in with a recovery code, with no CSP violation and `/api` never served by the service worker. Chromium only,
+  against the built app and a Testcontainers Postgres; codes come from otplib. Later phases extend it.
+- Unit and component tests for the money/date formatting, the API client's error handling, the query cache rules,
+  the component kit and each screen (Vitest `web` project, jsdom, Testing Library, a fake `fetch`).
 
 ## 15. Deployment
 
 - Multi-stage `Dockerfile` (build web + server → slim Node 22 runtime, non-root user). Migrations run on startup
   before listening. `GET /healthz` returns DB connectivity status.
+- The server serves the built web app (`WEB_DIR`) for GET/HEAD outside `/api`: a file that exists, otherwise
+  `index.html` for paths without a file extension outside `/assets` (the app's routes); anything else is the JSON
+  404. Hashed files in `/assets` are cached for a year (`immutable`); `index.html`, the service worker, the manifest
+  and the icons are `no-cache`. Without a build the server serves only the API.
 - `docker-compose.yml`: `app` + `postgres:16` with a named volume, for local development and VPS self-hosting.
 - Works on any container host with Postgres 16; the hosting choice is deferred.
 - Backups: rely on the managed Postgres backups of the chosen host, plus the full JSON export in Settings.
PATCH
```

- [ ] **Step 2: The carry-over and the engineering notes**

```bash
git apply <<'PATCH'
diff --git a/docs/superpowers/notes/engineering-notes.md b/docs/superpowers/notes/engineering-notes.md
index 87e8e5c..ede5955 100644
--- a/docs/superpowers/notes/engineering-notes.md
+++ b/docs/superpowers/notes/engineering-notes.md
@@ -68,10 +68,19 @@ Keep each plan to about 8–10 tasks. A task is one reviewable unit with its own
   `logger.error({ err }, 'msg')`.
 
 ### Auth
-- `withLoginLock(db, fn)` in `src/server/auth/rate-limit.ts` serialises sign-in and re-auth with
-  `pg_advisory_xact_lock(727274001)`. Any new advisory lock needs a different key; list keys in this file:
+- `withLoginLock(db, clock, ip, fn)` in `src/server/auth/rate-limit.ts` serialises sign-in, re-auth and setup-token
+  checks: calls queue in the process first (so waiting ones hold no pooled connection), then take
+  `pg_advisory_xact_lock(727274001)` with a 5 s `lock_timeout` (503 `busy` after that; `isLockTimeout(err)` matches
+  SQLSTATE 55P03). Any new advisory lock needs a different key; list keys in this file:
   - `727274001`: login and re-authentication.
   - `727274002`: user commands and undo/redo (`COMMAND_LOCK_KEY` in `src/server/commands/run-command.ts`).
+- Each authenticator code works once: `verifyTotp` returns the code's time step (or null), `verifySecondFactor`
+  refuses a step at or before `app_user.totp_last_step`, and a passed check stores `spentFactor(user, result)` (the
+  recovery codes left and the newest step). Server tests that sign in or re-authenticate more than once take each code
+  with `freshTotpCode(secret, clock)` (`src/server/test/totp.ts`), which moves the fake clock on one 30 s step.
+- `AppError(status, code, message, extra, headers)` sends response headers too (`Retry-After` on 429 and 503).
+- `refreshSession(c, deps)` (`src/server/auth/sessions.ts`) is the one way to read the session cookie: it slides the
+  session, refreshes the cookie and clears a stale one; `requireSession` builds on it.
 
 ### Transactions (P2c)
 - Every transaction write is planned first: build a `Draft` (what the user describes) and call
@@ -100,6 +109,61 @@ Keep each plan to about 8–10 tasks. A task is one reviewable unit with its own
 - zod 4 discriminated unions nest (`kind` → `cadence` / `debtMode`), and refined objects can be options.
   `z.flattenError` reports an unknown discriminator under its key, e.g. `fieldErrors.cadence`.
 
+### Web app (P3a)
+P3b and P3c build their screens on these conventions.
+- **Layout.** `src/web/`: `main.tsx` (entry), `app.tsx` (query client, toasts, router), `router.tsx` (route tree and
+  guards), `shell/` (app shell, bottom nav, Undo/Redo, offline banner, placeholder screens), `lib/` (API client,
+  query cache, commands, form errors, `useOnline`, formatting, the keypad's calculator), `ui/` (the component kit),
+  `auth/`, `settings/`, `test/` (test helpers). `index.html` and `public/` (generated icons) are Vite's root.
+- **Boundaries** (ESLint; `src/server/lint-boundaries.test.ts` pins them): `src/web` imports only types from
+  `src/server` (`import type`), and no Node modules or globals; `src/server` and `src/shared` never import `src/web`;
+  `src/shared` never imports `src/server`. The web app may use the pure engine (`roundDiv`). The root tsconfig covers
+  everything but `src/web`, which has its own (`src/web/tsconfig.json`: DOM lib, JSX); `npm run typecheck` runs both.
+- **API.** Call the server only through `api` (`hc<App>`, `src/web/lib/api.ts`), wrapped in `unwrap(...)`: it returns
+  the typed 2xx body and throws `ApiError` (`status`, `code`, `message`, `fieldErrors` by dotted path, `formErrors`,
+  `retryAfter`; status 0 / `network` without a response, `http_<status>` for a non-JSON error page). `api` sends the
+  CSRF header on every request. The server's `App` type has only the chained `/api` routes: keep chaining routers,
+  and keep `app.get('*', serveWeb(…))` outside the chain.
+- **Query cache** (`src/web/lib/query.ts`). Keys are `[area, ...params]` (`['budget', '2026-11']`, `['accounts']`);
+  the `auth` area holds only the auth status, which the route guards read (`authStatusQuery`, never stale; setup,
+  sign-in and sign-out set it). Reads are fresh for 30 s and retry twice after network and 5xx errors.
+- **Commands.** No optimistic updates: run every undoable command through `useCommand(fn)`
+  (`src/web/lib/commands.ts`). It waits for the server, invalidates every non-auth query (`invalidateData`), reads
+  `GET /api/undo` and shows a toast with the command's undo label and Undo; a network or 5xx failure gets a Retry
+  toast, other errors stay on the mutation for the form. `useUndoRedo()` backs the header and the toasts. Auth and
+  settings calls are plain `useMutation`s (not undoable). A 401 `unauthorized` from any query or mutation forgets the
+  cached data and opens `/login?redirect=…` (`app.tsx`).
+- **Forms.** `formErrorsOf(mutation.error, ['name', 'lines.0.amount'])` gives `{ fields, form }`: pass
+  `fields[path]` to the field's `error` and `form` to `<FormError>` above the submit button (it adds "You can try
+  again in …" from `Retry-After`). Check input early with the shared zod schema and `zodFormErrors`. Forms are
+  `noValidate`; `Button` is `type="button"` unless it is the submit button.
+- **Offline.** Every control that sends a request is disabled while offline: `<Button mutating>`, or `useOnline()`.
+- **Display and input.** Amounts: `formatMoney(minor, currency?)` / `formatAmount` (no-break space groups, decimal
+  comma, `zł` for PLN, the code otherwise); dates `formatDate` / `parseDate` (dd.MM.yyyy ↔ ISO); months
+  `formatMonth` / `formatMonthShort` (`'2026-11'`). Amount entry: `AmountKeypad` (`evaluateAmount`: + − × ÷ exactly,
+  result rounded half away from zero).
+- **Kit** (`src/web/ui`): `Button` (`variant`, `mutating`, `busy`, `block`), `TextField`, `Checkbox`,
+  `SegmentedControl`, `FormError`, `Pill` (spec §6 tones), `Sheet` (bottom sheet; its children unmount on close, so
+  forms in it start empty), `ToastProvider` / `useToast`, icons and `cx`. Tailwind v4; theme tokens (`brand`,
+  `brand-dark`, `brand-light`) in `styles.css`.
+- **CSP.** No inline scripts or `<style>` elements, no `eval` (zod runs `jitless`: `zod-jitless.ts` is imported
+  first), no `data:`/`blob:` images (draw inline SVG, like the QR code), no other origins. React's `style` prop is
+  fine. `npm run test:e2e` fails on any violation.
+- **Screens.** Add a route under `appLayout` in `router.tsx` with `staticData: { title }` (the header shows it),
+  replacing a `PlaceholderScreen`. Screens reached through More are listed in `MORE_PATHS` (`shell/bottom-nav.tsx`).
+- **Tests.** The Vitest `web` project (jsdom) runs `src/web/**/*.test.{ts,tsx}`. Fake the server with
+  `fakeApi({ 'GET /api/x': { body }, 'POST /api/y': (req) => json(body, 422) })` (it records `requests`), then
+  render the whole app with `renderApp(path)` (memory history; spread `SIGNED_IN` into the routes) or a component
+  with `renderWithProviders(ui)`; drive it with `userEvent.setup()`. Fake offline with
+  `vi.spyOn(navigator, 'onLine', 'get')`. `src/web/test/setup.ts` restores mocks and stubbed globals after each test.
+- **End to end.** `npm run test:e2e` builds, then `e2e/global-setup.ts` starts Postgres (Testcontainers, Ryuk off)
+  and `dist/server/main.js` on a free port, and Playwright runs chromium at 390×844 (install it once with
+  `npx playwright install chromium`). Each sign-in after the first needs a code from a later 30 s step.
+- **Serving and assets.** `serveWeb(webDir)` (`src/server/http/web.ts`) serves the build; `testConfig` points
+  `webDir` at `src/server/test/web-fixture`. The icons are generated by `npm run icons` (`scripts/generate-icons.ts`)
+  and committed. `npm run dev:web` runs Vite on port 5173 and proxies `/api` and `/healthz` to `npm run dev` on port
+  3080 (`PORT=3080` in `.env`; `API_PROXY_TARGET` overrides).
+
 ### Engine
 - `src/engine` is pure: no I/O, no Node modules, no `Date.now()` / `new Date()` / `Math.random()`. ESLint enforces this.
 - `computeBudget` throws on unknown or duplicate categories, assignments to RTA or Uncategorized, lines categorised to a
diff --git a/docs/superpowers/notes/p2-carry-over.md b/docs/superpowers/notes/p2-carry-over.md
index 234b706..8f88e8c 100644
--- a/docs/superpowers/notes/p2-carry-over.md
+++ b/docs/superpowers/notes/p2-carry-over.md
@@ -162,3 +162,37 @@ These items were found in the P1 final review and deferred. Fold them into the P
 - Later: `GET /api/budget/:month` takes ≈ 80 ms for 10 years × 150 categories (26k transactions) and ≈ 175 ms in a
   dense worst case (36k activity rows) on an M3 Max. If it matters, read the activity aggregate with `db.execute`
   (Drizzle's row mapping costs ≈ 30 ms per 36k rows) and profile `computeBudget`.
+
+## Resolved in P3a
+- TOTP replay protection: `app_user.totp_last_step` (migration 0004) stores the time step of the newest accepted
+  code, and only codes from a later step are accepted. The codes that confirm setup and a new authenticator are used
+  up too (spec §12).
+- `GET /api/auth/status` slides the session and refreshes its cookie; a cookie for an unknown or expired session is
+  cleared by `/status` and by every 401. A 429 carries `Retry-After`. The auth schemas' `.max()` limits have friendly
+  messages.
+- Login-lock waiters no longer hold pool connections: sign-ins queue in the process (`withLoginLock`) before taking
+  the advisory lock, which waits at most 5 s (`lock_timeout`, then 503 `busy` with `Retry-After: 1`).
+- Setup-token attempts are rate-limited: a wrong token is recorded as a failed sign-in attempt.
+- Global lockout DoS: documented in spec §12 as accepted while the app isn't exposed to the internet, with the fix to
+  make before that (carried over below).
+- The TOTP QR code is inline SVG (the CSP blocks `data:` images); the web app has its own tsconfig with the DOM lib;
+  the server serves the built app with an SPA fallback for non-/api paths; spec §12 documents that `TRUST_PROXY`
+  trusts exactly one reverse proxy.
+- From the P2b1 final review: ESLint forbids `rec.tx.insert/update/delete` in `src/server` (write through the
+  recorder). Undo/redo don't need to return table names: the web app invalidates every budget-data query after any
+  command, undo or redo (one user, a few queries on screen).
+
+## From P3a
+- Before internet exposure: replace the global lockout with per-device counting (a long-lived device cookie set at
+  sign-in; count failures since the last success or lockout; lock only unknown devices), spec §12.
+- Later: a successful setup isn't recorded as a successful sign-in, so wrong setup tokens in the 15 minutes before it
+  still count toward the lockout of the first sign-ins.
+- P3b/P3c: the web app refetches after every command and reads no mutation response yet; build mutation responses
+  inside the command (`rec.tx`, P2b1 final review) when a screen starts using one.
+- P3c: the P2c items for the transaction sheet and register stay open (a payee change to a transfer payee needs
+  `categoryId: null`; rows of one date are ordered by id; unknown ids are 422 with a field, and 404 vs 422 for the
+  older endpoints), as does "a zod abort skips `superRefine`" for client-side form checks.
+- P3b/P3c: spec §14's component tests for the category picker (P3b) and the split editor (P3c), and the rest of the
+  Playwright smoke flow (account, category, assign, transaction, reconcile, undo).
+- Later: the web bundle is one 471 kB script (148 kB gzipped); split it by route (lazy routes) if start-up time
+  matters on slow phones.
PATCH
```

- [ ] **Step 3: The README and .env.example**

````bash
git apply <<'PATCH'
diff --git a/.env.example b/.env.example
index 1c5ce78..af599a2 100644
--- a/.env.example
+++ b/.env.example
@@ -24,3 +24,4 @@ APP_PORT=3000
 # `npm run dev` needs your own Postgres 16, e.g.
 # `docker run -d -p 127.0.0.1:5432:5432 -e POSTGRES_PASSWORD=dev postgres:16-alpine`
 # and `DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres`
+# With `npm run dev:web` (http://localhost:5173), run the API on the port it forwards /api to: `PORT=3080`
diff --git a/README.md b/README.md
index 9e06e58..3fa2dd2 100644
--- a/README.md
+++ b/README.md
@@ -3,13 +3,15 @@
 A personal, single-user budgeting app that follows YNAB's rules, with PLN as the budget currency. The design is in
 [`docs/superpowers/specs/2026-11-19-core-budgeting-design.md`](docs/superpowers/specs/2026-11-19-core-budgeting-design.md).
 
-Status: the budget engine (`src/engine`) and the server foundation are done: database schema, first-run setup, and
-sign-in with password + authenticator app. The budgeting API and the phone UI are next.
+Status: the budget engine (`src/engine`), the server and the web app's foundation are done: an installable phone
+web app with first-run setup, sign-in with password + authenticator app, and Settings. The budget, accounts and
+transaction screens are next.
 
 ## Requirements
 
 - Node.js 22 and npm
 - Docker. The server tests start Postgres 16 through Testcontainers, and `docker compose` runs the app.
+- For the end-to-end test only: Playwright's Chromium (`npx playwright install chromium`).
 
 ## Run with Docker
 
@@ -19,8 +21,8 @@ docker compose up -d --build
 curl http://localhost:3000/healthz   # {"status":"ok"}
 ```
 
-Set `APP_PORT` in `.env` if port 3000 is already taken. First-run setup (`/api/auth/setup`) needs the
-`SETUP_TOKEN` from `.env`.
+Then open http://localhost:3000 and set up the budget with the `SETUP_TOKEN` from `.env`, a password and an
+authenticator app. Set `APP_PORT` in `.env` if port 3000 is already taken.
 
 The port is bound to 127.0.0.1 only. For remote access, put an HTTPS reverse proxy (e.g. Caddy) in front, and only
 then set `TRUST_PROXY=true`.
@@ -29,15 +31,24 @@ then set `TRUST_PROXY=true`.
 
 ```bash
 npm install
-npm test               # all tests (engine + server)
+npm test               # all tests (engine + server + web)
 npm run test:engine    # pure engine tests only (no Docker needed)
 npm run test:server    # server tests against a throwaway Postgres container
-npm run typecheck
+npm run test:web       # web app component tests (jsdom, no Docker needed)
+npm run test:e2e       # builds, then runs the Playwright smoke test against the built app and a throwaway Postgres
+npm run typecheck      # server and web
 npm run lint
+npm run build          # dist/web (the PWA) and dist/server
 npm run dev            # server with reload; reads .env, which then also needs DATABASE_URL
+npm run dev:web        # the web app with hot reload on http://localhost:5173; /api goes to `npm run dev`
 npm run db:generate    # after editing src/server/db/schema.ts: writes a new SQL migration to drizzle/
+npm run icons          # after editing scripts/generate-icons.ts: writes the app icons to src/web/public
 ```
 
+For the web app, run `npm run dev` with `PORT=3080` in `.env` (the port `npm run dev:web` forwards `/api` to; set
+`API_PROXY_TARGET` for another one) and open http://localhost:5173. A built server (`npm run build && npm start`)
+serves the web app itself from `dist/web`.
+
 `npm run dev` needs your own Postgres 16, e.g.
 `docker run -d -p 127.0.0.1:5432:5432 -e POSTGRES_PASSWORD=dev postgres:16-alpine` and
 `DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres`.
@@ -66,3 +77,4 @@ docker rm -f $(docker ps -aq --filter label=org.testcontainers=true)
 | `TRUST_PROXY` | no | `false` | Take the client IP from `X-Forwarded-For` (behind a reverse proxy only) |
 | `LOG_LEVEL` | no | `info` | pino log level |
 | `MIGRATIONS_DIR` | no | `drizzle` | Folder with SQL migrations |
+| `WEB_DIR` | no | `dist/web` | Folder with the built web app (`npm run build:web`); without it only the API is served |
PATCH
````

- [ ] **Step 4: Final checks**

Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  72 passed (72)`, `Tests  568 passed (568)`; both checks exit 0.
Run: `npm run db:generate -- --name check && npm run test:e2e`
Expected: `No schema changes, nothing to migrate 😴`, then the build and `1 passed`.

- [ ] **Step 5: Commit**

```bash
git add docs README.md .env.example
git commit -m "docs: P3a web foundation, auth hardening and web conventions" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---
## Spec coverage (P3a)

| Spec / scope item | Task |
|---|---|
| §1 Polish number and currency formatting, dd.MM.yyyy dates, English month labels | 3 |
| §2 `src/web`: Vite React PWA, TanStack Router + Query, the Hono RPC client, Tailwind, vite-plugin-pwa; one process serves the PWA and `/api`; mutations wait for the server and invalidate (no optimistic updates) | 3–5, 7 |
| §4.1 `app_user.totp_last_step` | 1 |
| §11 bottom navigation (Budget · Accounts · ＋ · More), header Undo/Redo, toasts with Undo, phone layout ≤ 480 px | 7 |
| §11 Assign keypad with `+ − × ÷`; bottom sheets; Available pills | 6 |
| §11 Settings: change password, new authenticator and recovery codes, log out all sessions, JSON export | 9 |
| §11 Offline: banner, mutating controls disabled, service worker caches only the app shell, `/api` network-only | 4, 5, 7 |
| §12 first-run setup (token, password ≥ 12, TOTP QR, confirm, 10 recovery codes once), login with a code or a recovery code, sessions and guards | 8 |
| §12 TOTP replay protection, setup-token rate limit, `Retry-After`, sign-in queue, cookie refresh / stale cookie, global lockout (documented), single trusted proxy (documented) | 1, 2, 10 |
| §12 strict CSP kept for the web app (inline-SVG QR, no inline scripts, zod jitless), checked end to end | 4, 8, 9 |
| §13 errors in the UI: dotted field errors inline, 422/409 messages, 401 → sign-in, 429 with when to retry, 5xx toast with Retry | 5, 7 |
| §14 Web: component tests (keypad parser and the rest), Playwright at 390×844 (P3a's part of the smoke flow) | 3, 5–9 |
| §15 Dockerfile builds web + server; static serving with cache headers | 4 |
| Carry-over P3: TOTP replay; /status cookie, stale cookie, Retry-After, `.max` messages; login-lock pool; setup-token rate limit; QR as SVG; web tsconfig; SPA fallback; trusted proxy; global lockout; `rec.tx` lint rule; undo/redo invalidation | 1–4, 7, 8, 10 |

Deferred (listed in `p2-carry-over.md` under "From P3a"):
- Before internet exposure: per-device lockout instead of the global one.
- P3b/P3c: the screens themselves; mutation responses built inside the command once a screen reads them; the P2c transaction-sheet and register items; the category picker and split editor tests; the rest of the smoke flow.
- Later: setup-token failures right before setup count toward the first sign-ins' lockout; splitting the 471 kB bundle by route.

## Decisions

Choices made where the spec is silent, ambiguous or in conflict with the brief:

1. **Replay protection stores one number.** `totp_last_step` is the step of the newest accepted code, and a code must come from a later step. That refuses replays and older codes in the ±1 window, needs no table, and costs a legitimate user nothing (a new code every 30 s). The codes confirming setup and a new authenticator count as used (`max` of the new code's step and the stored one on rotation).
2. **Setup-token guesses are sign-in attempts.** Rather than a second limiter, a wrong token is recorded in `login_attempt` under the login lock, so the per-IP limit and the lockout apply. A right token isn't recorded (carried over: a few typos right before setup count toward the first sign-ins' lockout).
3. **Retry-After** is computed, not fixed: until the oldest attempt of the last minute is a minute old, or until the lockout ends, rounded up to whole seconds (at least 1).
4. **The sign-in queue is in-process.** A promise chain per database (no mutex library) keeps waiting sign-ins off the pool; the advisory lock stays for a second process, with a 5 s `lock_timeout` and 503 `busy`, rather than an unbounded wait.
5. **Global lockout: documented, not changed.** The brief allowed a documented decision. It is accepted while the app is reached through a private network or an access-limiting proxy; the per-device design is written into spec §12 and carried over for before internet exposure.
6. **Web dependencies are dev dependencies.** Vite bundles them into `dist/web`; the runtime image keeps `npm ci --omit=dev` and its size.
7. **Two tsconfigs, one lint boundary.** The web tsconfig keeps Node's types because `hc<App>` type-checks the server's route modules; ESLint, not the compiler, keeps server runtime code (and Node modules/globals) out of `src/web`, and a test pins the rules.
8. **Static serving is a catch-all outside the typed chain**, so `App` stays API-only. The SPA fallback serves `index.html` only for paths without a file extension outside `/assets`; a missing file is the JSON 404, never HTML. `/assets` files are immutable for a year; everything else is `no-cache`. Without a build the server serves only the API (the server tests and `npm run dev` need no web build).
9. **The CSP is not relaxed.** The service worker is registered from the bundle, zod runs `jitless`, the QR code is inline SVG and the recovery-code download is a link. The end-to-end test reports every violation, which is how the zod issue was found.
10. **Service worker:** Workbox `generateSW` precaching the build with a navigation fallback (not `/api`, not `/healthz`), no runtime caching, `autoUpdate`. That is exactly spec §11's "app shell only".
11. **Icons are generated**, by a dependency-free script (a tiny PNG encoder over `node:zlib`), and the output is committed: no binary in the plan, no image tooling in the build.
12. **Formatting is hand-written** rather than `Intl.NumberFormat('pl-PL')`, which differs between browsers and ICU builds (grouping of 4-digit numbers, space characters) and isn't exact beyond 2^53 / 100.
13. **The keypad computes exactly**: bigint fractions, × ÷ before + −, signed numbers, at most 2 decimals per number, both `,` and `.`; only the result is rounded (half away from zero, as everywhere). An empty expression is 0.
14. **Invalidate everything after a command.** With one user and a few queries on screen, invalidating every non-auth query after each command, undo and redo is simpler and always right; undo/redo don't need to report touched tables (carry-over item resolved).
15. **The toast's label comes from `GET /api/undo`** after the command, so the server's undo label is the only label, and the toast always matches what Undo will do.
16. **Code-based routes** (TanStack Router without its file-based route generator): no extra Vite plugin or generated file; guards in `beforeLoad` read the cached status, and `redirect` is checked against open redirects.
17. **Auth and settings calls are plain mutations**, not commands: they aren't undoable (spec §10) and get no Undo toast.
18. **Playwright runs Chromium only** with phone emulation (390×844, touch, DPR 3), against the built server and a Testcontainers Postgres, as the brief asks; it isn't part of `npm test` (it needs a build and a browser download).
19. **`npm run dev:web`** runs Vite on 5173 and proxies `/api` and `/healthz` to port 3080 (`PORT=3080` for `npm run dev`), so it doesn't collide with `docker compose` on 3000.
