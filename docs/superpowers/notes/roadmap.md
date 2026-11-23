# Budget Track: roadmap and runbook

Status as of 2026-11-21. Use this file to pick up the remaining work.

## Done (merged to `main`)
| Phase | What | Plan |
|---|---|---|
| P1 | Pure budget engine (`src/engine`) | `docs/superpowers/plans/2026-11-19-p1-budget-engine.md` |
| P2a | Server foundation: schema, auth (password + TOTP + recovery codes), sessions, CSRF, Docker | `2026-11-20-p2a-server-foundation.md` |
| P2b1 | Accounts, categories/groups, assignments, move money, undo/redo | `2026-11-21-p2b1-budget-structure.md` |
| P2b2 | Budget month view, targets, auto-assign | `2026-11-21-p2b2-budget-read-model.md` |
| P2c | Payees, transactions, transfers, splits, register, bulk ops | `2026-11-21-p2c-payees-transactions.md` |
| P2d1 | NBP FX rates, revalue, reconcile, loans (interest/escrow, overrides, loan panel data) | `2026-11-22-p2d1-fx-reconcile-loans.md` |
| P3a | Web app foundation: PWA shell, setup wizard, sign-in, Settings, Playwright smoke test | `2026-11-22-p3a-web-foundation.md` |

## Remaining, in order
Every plan is written and prototype-verified. Each sits on its own `*-plan` branch until it is executed. To read one:
`git show <branch>:docs/superpowers/plans/<file>`.

| # | Phase | Plan branch | Plan file | Tasks | What you get |
|---|---|---|---|---|---|
| 1 | **P2d2** scheduled transactions, JSON export, ops | `p2d2-plan` | `2026-11-22-p2d2-scheduled-export-ops.md` | 9 | Scheduled CRUD, Enter now/Skip, daily croner job, `/api/export`, shutdown hardening, target cap, undo test matrix, NUL-byte guard |
| 2 | **P3b** Budget screen | `p3b-plan` | `2026-11-23-p3b-budget-screen.md` | 10 | Month switcher, RTA banner and breakdown, category list with filters, category sheet (assign keypad, move money, targets, activity, note, hide), edit mode with drag-and-drop |
| 3 | **P3c** Accounts, register, transaction sheet | `p3c-plan` | `2026-11-23-p3c-accounts-register-transactions.md` | 11 | Accounts list, add-account wizard, register with filters and bulk actions, reconcile and revalue, transaction sheet with splits, FX and Repeat |
| 4 | **P3d** Scheduled, Payees, loan panel, final end-to-end tests, README | `p3d-plan` | `2026-11-24-p3d-scheduled-payees-delivery.md` | 8 | Scheduled and Payees screens, loan panel with Record payment, a 7-test end-to-end journey, deployment README |

Rough effort: 30–40 minutes per task with review, about 20 minutes in fast mode. In total about 38 tasks, or roughly
12–15 hours.

### How to run a phase
1. `git checkout main && git checkout -b <phase-branch> && git merge <phase>-plan`
2. Run `npm test` and note the baseline. Each plan states test totals against the prototype base it was verified on,
   so add the difference to every expected total.
3. Execute task by task with superpowers subagent-driven development:
   - one implementer per task, working from a task brief cut from the plan;
   - a reviewer for each risky server task;
   - a final whole-branch review, then a fix pass;
   - fast-forward merge to `main`.
4. Patches that no longer apply because the code drifted are applied by hand, keeping the plan's intent and what has
   landed since.

### Known adjustments per phase (because the execution order changed)
**Every later phase: the authenticator app is optional** (branch `auth-optional-totp`; the plans predate it).
- Setup no longer enrolls an authenticator: `POST /api/auth/setup` takes `{ setupToken, password }` and returns
  `{ ok: true }`, and `POST /api/auth/setup/totp` is gone. Any plan's e2e step or test helper that scans a QR code,
  types a code or saves recovery codes at setup must use password-only setup: setup token → password → "Finish
  setup".
- Sign-in, the password change and other re-authentication take the password only unless an authenticator is on;
  the sign-in form has no code field then. The server helper `setUpBudget(ctx)` returns nothing (no `totpSecret` or
  `recoveryCodes`); a test that needs codes calls `enableAuthenticator(ctx)` first.
- `AuthStatus` has `authenticatorEnabled`; web fixtures (`SIGNED_IN`) carry it, and `useEnterApp()` takes
  `{ href, authenticatorEnabled }`. Settings has an "Authenticator app" section (Turn on / Replace / New recovery
  codes / Turn off) instead of "Change authenticator app" and "New recovery codes" under Security.
- Setup, every sign-in and every re-authentication count toward 5 attempts per minute per IP. The smoke test already
  makes six and waits a minute before the last; extensions that add sign-ins must wait too.
- **P2d2**: the export test reads `totpSecret` and `recoveryCodes` from `setUpBudget`; take them from
  `enableAuthenticator(ctx)` instead, and skip the NULL `totpSecretEnc` in its "no secret in the file" loop.
- **P3d**: its recovery-code e2e step must first turn the authenticator on (Settings → Authenticator app → Turn on,
  code from otplib with the shown key, keep the ten codes), or drop that step.

**P2d2.** It was written before P2d1 and P3a were executed.
- Use P2d1's real `FxRates` (`deps.fx.quote`). The prototype's stand-in is not in the plan.
- `PlanContext.defaults` now takes `{ date, rates }`, so the schedule job passes the occurrence date. P2d1's way of
  booking a non-manual NBP rate replaces the plan's `withRateSource`.
- Add `'totpLastStep'` to the `app_user` omit list in `src/server/export/export.ts`. P3a added that column.
- Keep `serveWeb` after `/api/scheduled` and `/api/export` in `app.ts`, and merge `croner` into `package.json`.
- Schedule amounts use `boundedMoneySchema` (P2c amount caps).
- The undo/redo command matrix should also cover P2d1's revalue, reconcile and interest-override commands.
- Reference merge: session files `p3c-base` (P2d1 + P2d2 + P3a, verified), with notes in `p3c-base-notes.md`.

**P3b.**
- `MAX_AMOUNT` already exists in `src/shared/api/common.ts`; import it rather than declaring it again.
- The month-view DTO has P2d1's `loan` field; give it defaults in the test fixtures.
- The register's `categoryId=<Uncategorized>` filter works on `main`.
- The `LoanPanelSlot` contract is `src/web/budget/loan-panel-slot.tsx`; P3d replaces its body.

**P3c.**
- Its Repeat selector needs P2d2's scheduled API, so execute P2d2 first.
- It duplicates some of P3b: the amount cap, `SelectField` and `budgetMonthQuery`. Keep one copy of each.
- `router.tsx`, `icons.tsx` and `e2e/smoke.spec.ts` need small merges.
- Drop a duplicate "Groceries" e2e category if P3b already creates one.

**P3d.** Written last, against a merged base of P3a + P3b + P3c + P2d1 + P2d2 (111 files / 823 tests).
- It keeps P3b's `SelectField` (`ui/field.tsx`) and `budgetMonthQuery`, and drops P3c's copies.
- P3b's test fixtures need `loan: null` and `fxRateManual: false`.
- The final end-to-end journey expects no interest in a loan's first month (P2d1 rule).

**Reference material.** Verified prototypes and merge notes live outside the repo, in the Copilot session folder
`~/.copilot/session-state/bac648f5-7881-40fe-b4e5-c41bc7f38107/files/`:
- `p3c-base` and `p3c-base-notes.md`: P2d1 + P2d2 + P3a merged.
- `p3d-base-notes.md`: P3b + P3c merged.
- `p2d2-proto`, `p3b-proto`, `p3c-proto`, `p3d-proto`: one commit per task.

### Asking Copilot to continue
Something like: "Execute the next phase from `docs/superpowers/notes/roadmap.md` with subagent-driven development.
Branch from main, merge its plan branch, apply the listed adjustments, then review and merge." Add any adjustments you
want, such as UI changes or reordered priorities, before starting a phase. Plans are just markdown, so they can be
edited first.

## Running it locally
- `cp .env.example .env` and fill in the secrets. Use `APP_PORT=3080` if port 3000 is taken, and `COOKIE_SECURE=false`
  for plain http.
- `docker compose -p budget-track up -d --build`, then open `http://localhost:<APP_PORT>` and do first-run setup with
  `SETUP_TOKEN`.
- `npm test` runs the unit and server suites (needs Docker); `npm run test:e2e` runs Playwright (run
  `npx playwright install chromium` once first).

## Open follow-ups (not blocking)
`docs/superpowers/notes/p2-carry-over.md` lists every deferred item, by phase. The main ones:
- Loan balances are computed three times per month view (performance only).
- IDR rates lose precision at `numeric(14,6)`. Accepted, unless the scale is widened.
- A per-device lockout, to replace the global login lockout, before exposing the app to the internet.
- Queued sign-ins have no overall deadline (only matters with multiple replicas).

## Later sub-projects (from the spec roadmap)
- **#2 Bank sync** through Mastercard Open Banking: import transactions as `approved = false`, match them, approve.
- **#3 Reports**: spending by category or payee, net worth, income versus expense.
- **#4 Extras**: further YNAB-style niceties.
