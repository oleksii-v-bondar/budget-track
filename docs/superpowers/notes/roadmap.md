# Budget Track: roadmap

Status as of 2026-11-23. The project was simplified: one user signs in with a username and password from the
environment (`APP_USERNAME`, `APP_PASSWORD`); one backend and one frontend, no setup wizard, authenticator app,
recovery codes or sign-in lockout.

Done: the budget engine (`src/engine`), the server API, and the web app's shell with sign-in and Settings (sign out).

Remaining work is the YNAB screens:
- Budget
- Accounts and the register
- Transactions
- Targets
- Credit cards
- FX

The old phase plans (`docs/superpowers/plans/`, the `*-plan` branches) and `p2-carry-over.md` are superseded: read
them for ideas only, and leave out anything about setup, the authenticator app, recovery codes or rate limiting.
