# Budget Track: status

As of 2026-11-24, Budget Track is a single-user YNAB-style budget app: one backend (Hono + Postgres) and one frontend
(React PWA). The owner signs in with a username and password from the environment (`APP_USERNAME`, `APP_PASSWORD`).

Done:
- **Budget:** month switcher, Ready to Assign with a breakdown and auto-assign, filters, groups and categories with
  Available pills.
- **Category sheet:** assign keypad, move money, targets, activity, note and hide. Also edit mode and the month note.
- **Credit cards:** payment categories with "Need X to pay in full".
- **Accounts:** add, edit, close/reopen and delete accounts; foreign-currency accounts with NBP rates and revalue.
- **Register:** search, filters, bulk actions, reconcile.
- **Transaction sheet:** payee autocomplete, category picker, transfers, splits, FX rate, flag, cleared and delete.
  Future dates become one-time scheduled entries.
- **Undo/redo** for every change.
- **Bank connections** (optional) through Enable Banking (free restricted production mode; PKO BP and Revolut):
  connect per bank, link accounts, Sync now and a 6-hourly auto-sync, imports to approve.

Possible next steps, only if wanted:
- Repeating scheduled transactions.
- Reports.

The old phase plans (`docs/superpowers/plans/`, the `*-plan` branches) and `p2-carry-over.md` are superseded. Use them
for ideas only.
