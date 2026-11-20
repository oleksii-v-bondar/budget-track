# Engineering notes (for plan authors and implementers)

Lessons from P1–P2a, so later plans start from what works on this machine and stack.

## Process conventions

Plans live in `docs/superpowers/plans/`, follow the superpowers *writing-plans* format, and use
`docs/superpowers/plans/2026-11-20-p2a-server-foundation.md` as the reference layout:
- a header with Goal/Architecture/Tech Stack, then Global Constraints and File Structure;
- tasks, each with Files / Interfaces (Consumes/Produces) and TDD steps;
- complete code in every step, exact commands with the expected output (including the running test total), and a commit
  step whose message ends with `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.

Verify every code block before it goes into a plan:
- Prototype the whole plan in a scratch copy of the repo, outside the repo:
  `git archive HEAD | tar -x -C <scratch>` and `cp -R node_modules`.
- Run each task's tests, `npm run typecheck` and `npm run lint` there.
- Generate the plan from a template plus a small script that inlines the verified files, so code is never hand-copied.
- When a file changes across tasks, snapshot each task's version (`stages/taskN/...`) and inline the right one.

Keep each plan to about 8–10 tasks. A task is one reviewable unit with its own tests.

## Stack facts

### Node and Testcontainers
- Node is 22.14 locally. Keep `@testcontainers/postgresql` on `^11.14`: v12 pulls undici 8, which needs Node ≥ 22.19.
- Docker Desktop's Enhanced Container Isolation blocks Ryuk. `src/server/test/global-setup.ts` sets
  `TESTCONTAINERS_RYUK_DISABLED` and stops the container itself, including when setup fails.
- Server tests: `createTestDatabase()` clones a migrated template DB for each call; `createTestApp(db, { now })` returns
  `{ app, client, clock, config }`; `setUpBudget(testApp)` performs first-run setup and leaves `client` signed in;
  `TestClient(app, ip)` keeps cookies and sends the CSRF header.

### Drizzle / postgres.js
- Driver errors are wrapped: the message is `Failed query: …`, and the original error is in `cause`. Use
  `isUniqueViolation(err)` from `src/server/db/errors.ts`, which walks the `cause` chain. In tests, assert on the cause
  or on the constraint name.
- int8 is parsed to a safe JS integer, and a value outside the safe range throws. `sum()` returns `numeric`, which arrives
  as a string, so always cast in SQL: `sum(x)::bigint`. Never use `.mapWith(Number)`.
- `date` columns use `mode: 'string'` (`'YYYY-MM-DD'`). Months are stored as `'YYYY-MM-01'`; the engine uses `'YYYY-MM'`,
  so convert at the boundary.
- `numeric` arrives as a string (e.g. `'4.250000'`).
- The `v_ledger_line` view is declared `.existing()`. drizzle-kit never manages it, so any migration that alters a column
  it uses must drop and recreate the view in custom SQL (`npx drizzle-kit generate --custom --name …`).
- `npm run db:generate -- --name <name>` writes a migration. Nothing is deployed yet, but never rewrite committed
  migrations from now on: add new ones.
- Transactions: `db.transaction(async (tx) => …)`. Helpers should accept `Executor` (`Db | Tx`).

### Hono / zod
- Build routers by chaining (`new Hono<AppEnv>().get(...).post(...)`) so the `App` type carries every route for the P3
  `hc` RPC client.
- Guard routes with a session either per route (`.post('/x', requireSession(deps), …)`) or with
  `.use('*', requireSession(deps))` on a router mounted under its **own** prefix. Never `.use` on a router that shares
  its prefix with other routers: the middleware leaks onto later routes there.
- `validate(target, schema)` in `src/server/http/validate.ts` gives 400 `validation` with `fieldErrors`/`formErrors`.
  zod 4 hooks pass `z.core.$ZodError`. Note that `z.flattenError` only reports top-level paths; for nested bodies
  (split lines) also return the issue paths.
- Error classes: `AppError(status, code, message)` and `DomainError(code, message)` (422) in
  `src/server/http/errors.ts`.
- Request bodies are limited to 64 KiB on `/api/*`. Every `/api` response has `Cache-Control: no-store`.
- The logger's `err` serializer strips Drizzle query params. Always log with a message string:
  `logger.error({ err }, 'msg')`.

### Auth
- `withLoginLock(db, fn)` in `src/server/auth/rate-limit.ts` serialises sign-in and re-auth with
  `pg_advisory_xact_lock(727274001)`. Any new advisory lock needs a different key; list keys in this file:
  - `727274001`: login and re-authentication.
  - `727274002`: user commands and undo/redo (`COMMAND_LOCK_KEY` in `src/server/commands/run-command.ts`).

### Engine
- `src/engine` is pure: no I/O, no Node modules, no `Date.now()` / `new Date()` / `Math.random()`. ESLint enforces this.
- `computeBudget` throws on unknown or duplicate categories, assignments to RTA or Uncategorized, lines categorised to a
  card payment category, and credit lines without a payment category. Build its input exactly as
  `src/engine/budget/types.ts` documents.
- Deferred items for the server phases are listed in `docs/superpowers/notes/p2-carry-over.md`.
