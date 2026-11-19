# P1 — Budget Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the Budget Track repository and build `src/engine`, the pure TypeScript budget engine (YNAB rules) with full unit, golden-scenario and property-test coverage.

**Architecture:** A single-package TypeScript repo. `src/engine` is a dependency-free, I/O-free library of pure functions: money/date primitives; `computeBudget()`, which turns aggregated ledger rows into per-month category balances and Ready to Assign; credit-card payment flows; targets; auto-assign; loan math; scheduled-transaction dates; and FX helpers. The server (P2) and web app (P3) will consume this library through `src/engine/index.ts`. Nothing is persisted here.

**Tech Stack:** Node 22, TypeScript 6 (strict), Vitest 5, fast-check 4, ESLint 10 + typescript-eslint 8. npm is the package manager.

**Spec:** `docs/superpowers/specs/2026-11-19-core-budgeting-design.md` (§5–§9 and §14 are implemented here).

## Global Constraints

- Node `>=22` (`.nvmrc` = `22`), npm, ESM (`"type": "module"`).
- TypeScript `strict: true` and `noUncheckedIndexedAccess: true`; `npm run typecheck`, `npm run lint` and `npm test` must all pass at the end of every task.
- Money is an integer in minor units (grosze), typed `Money = number`. Never store fractional money. All rounding is **half away from zero** (`roundDiv`).
- FX rates are decimal strings at scale 6. APR is a decimal-string percentage (e.g. `"6.5"`) at scale 4.
- `Month` = `'YYYY-MM'`; `IsoDate` = `'YYYY-MM-DD'`; weekday numbers: `0 = Sunday … 6 = Saturday`.
- Sign convention: positive = inflow, negative = outflow (from the account's perspective).
- `src/engine/**` must stay pure: no `node:*`/I/O modules and no imports from `server/` or `web/` (enforced by ESLint).
- Tests live next to the code as `*.test.ts` (Vitest); property tests use fast-check.
- Every commit message ends with the trailer `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.

## Out of scope for P1 (handled in P2/P3)

DB schema, API, auth, undo log, server-side validation of transfer/category rules (§5.5), future-dated → scheduled conversion (§5.6), NBP HTTP client, scheduled-transaction job, and all UI.

## File Structure

```
package.json, package-lock.json   npm scripts: test, test:watch, typecheck, lint
tsconfig.json                     strict TS, Bundler resolution, no emit
vitest.config.ts                  test discovery (src/**/*.test.ts)
eslint.config.js                  TS lint + purity boundary for src/engine
.gitignore, .nvmrc
src/engine/
  types.ts                        Money, Month, IsoDate aliases
  index.ts                        public API of the engine (re-exports)
  money.ts                        roundDiv, parseDecimal, ceilDiv, allocate
  dates.ts                        month/day arithmetic, weekday helpers
  fx.ts                           convertToBase, splitLineBases, transferBases, effectiveRate, revaluationDiff
  loans.ts                        monthlyInterest, amortizedPayment, computeLoanMonths, projectPayoff
  targets.ts                      TargetDef, evaluateTarget, pillColor
  autoAssign.ts                   autoAssign strategies
  schedule.ts                     Frequency, nextOccurrence, dueOccurrences
  budget/
    types.ts                      BudgetInput / BudgetResult types
    overspending.ts               splitOverspending (cash vs credit)
    compute.ts                    computeBudget, cardPaymentShortfall
    test-helpers.ts               builders used only by tests
    *.test.ts                     unit, golden and property tests
```

---

### Task 1: Repository scaffold and tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.gitignore`, `.nvmrc`
- Create: `src/engine/types.ts`, `src/engine/index.ts`

**Interfaces:**
- Consumes: nothing (the repo already contains `docs/` and a git history).
- Produces: npm scripts `test`, `typecheck`, `lint`; types `Money`, `Month`, `IsoDate` exported from `src/engine/types.ts` and `src/engine/index.ts`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "budget-track",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint ."
  },
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@types/node": "^26.6.6",
    "eslint": "^10.15.0",
    "fast-check": "^4.10.3",
    "typescript": "^6.0.3",
    "typescript-eslint": "^8.73.0",
    "vitest": "^5.1.1"
  }
}
```

- [ ] **Step 2: Install dev dependencies**

Run: `npm install -D typescript vitest fast-check eslint @eslint/js typescript-eslint @types/node`
Expected: `added N packages`, `found 0 vulnerabilities`. `package.json` now has `devDependencies` (typescript ^6, vitest ^5, eslint ^10, typescript-eslint ^8, fast-check ^4).

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "vitest.config.ts", "eslint.config.js"]
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
  },
});
```

- [ ] **Step 5: Create `eslint.config.js` (includes the engine purity boundary)**

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
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
              group: ['**/server', '**/server/**', '**/web', '**/web/**'],
              message: 'src/engine must stay pure: no imports from server/ or web/.',
            },
            {
              group: ['node:*', 'fs', 'path', 'http', 'https', 'net', 'child_process', 'os', 'crypto'],
              message: 'src/engine must stay pure: no I/O modules.',
            },
          ],
        },
      ],
    },
  },
);
```

- [ ] **Step 6: Create `.gitignore` and `.nvmrc`**

`.gitignore`:

```text
node_modules/
dist/
coverage/
.env
*.log
.DS_Store
```

`.nvmrc`:

```text
22
```

- [ ] **Step 7: Create `src/engine/types.ts`**

```ts
/** Integer amount in minor units (grosze for PLN). Positive = inflow, negative = outflow. */
export type Money = number;

/** Calendar month formatted 'YYYY-MM'. */
export type Month = string;

/** Calendar date formatted 'YYYY-MM-DD'. */
export type IsoDate = string;
```

- [ ] **Step 8: Create `src/engine/index.ts`**

```ts
export type { IsoDate, Money, Month } from './types';
```

- [ ] **Step 9: Verify the toolchain**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all three exit 0. Vitest prints `No test files found, exiting with code 0`.

- [ ] **Step 10: Verify the purity boundary fails as intended**

Run:
```bash
printf "import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n" > src/engine/boundary-check.ts
npm run lint; rm src/engine/boundary-check.ts
```
Expected: lint FAILS with `'node:fs' import is restricted ... src/engine must stay pure: no I/O modules.` The file is deleted afterwards. Then `npm run lint` exits 0 again.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts eslint.config.js .gitignore .nvmrc src/engine
git commit -m "chore: scaffold TypeScript repo with Vitest and ESLint engine boundary" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Money primitives

**Files:**
- Create: `src/engine/money.ts`
- Test: `src/engine/money.test.ts`
- Modify: `src/engine/index.ts`

**Interfaces:**
- Consumes: `Money` from `./types`.
- Produces:
  - `roundDiv(n: bigint, d: bigint): bigint`: half away from zero
  - `parseDecimal(value: string, scale: number): bigint`
  - `ceilDiv(a: Money, b: number): Money`: requires a ≥ 0 and b > 0
  - `allocate(total: Money, weights: Money[]): Money[]`: largest remainder; ties go to the lower index

- [ ] **Step 1: Write the failing test** at `src/engine/money.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { allocate, ceilDiv, parseDecimal, roundDiv } from './money';

describe('roundDiv', () => {
  it('rounds half away from zero', () => {
    expect(roundDiv(5n, 2n)).toBe(3n);
    expect(roundDiv(-5n, 2n)).toBe(-3n);
    expect(roundDiv(7n, 3n)).toBe(2n);
    expect(roundDiv(8n, 3n)).toBe(3n);
    expect(roundDiv(4n, 2n)).toBe(2n);
    expect(roundDiv(5n, -2n)).toBe(-3n);
  });

  it('rejects division by zero', () => {
    expect(() => roundDiv(1n, 0n)).toThrow('Division by zero');
  });
});

describe('parseDecimal', () => {
  it('scales decimal strings to integers', () => {
    expect(parseDecimal('4.2512', 6)).toBe(4_251_200n);
    expect(parseDecimal('12', 4)).toBe(120_000n);
    expect(parseDecimal('-0.5', 1)).toBe(-5n);
  });

  it('rounds extra decimals half away from zero', () => {
    expect(parseDecimal('1.23455', 4)).toBe(12_346n);
    expect(parseDecimal('-1.23455', 4)).toBe(-12_346n);
  });

  it('rejects malformed input', () => {
    expect(() => parseDecimal('1,5', 2)).toThrow('Invalid decimal');
    expect(() => parseDecimal('', 2)).toThrow('Invalid decimal');
  });
});

describe('ceilDiv', () => {
  it('rounds up for non-negative numerators', () => {
    expect(ceilDiv(100, 3)).toBe(34);
    expect(ceilDiv(99, 3)).toBe(33);
    expect(ceilDiv(0, 7)).toBe(0);
  });

  it('rejects negative numerators and non-positive divisors', () => {
    expect(() => ceilDiv(-1, 3)).toThrow();
    expect(() => ceilDiv(1, 0)).toThrow();
  });
});

describe('allocate', () => {
  it('splits proportionally with largest-remainder rounding', () => {
    expect(allocate(20, [30, 10])).toEqual([15, 5]);
    expect(allocate(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(allocate(5, [2, 3])).toEqual([2, 3]);
  });

  it('breaks remainder ties in favour of the earlier index', () => {
    expect(allocate(1, [1, 1])).toEqual([1, 0]);
  });

  it('returns zeros when there is nothing to allocate', () => {
    expect(allocate(0, [3, 4])).toEqual([0, 0]);
    expect(allocate(5, [0, 0])).toEqual([0, 0]);
    expect(allocate(5, [])).toEqual([]);
  });

  it('always sums to the total', () => {
    const parts = allocate(1_000_003, [7, 13, 29, 51]);
    expect(parts.reduce((s, x) => s + x, 0)).toBe(1_000_003);
  });

  it('rejects a negative total', () => {
    expect(() => allocate(-1, [1])).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/engine/money.test.ts`
Expected: FAIL with `Failed to resolve import "./money"`.

- [ ] **Step 3: Implement `src/engine/money.ts`**

```ts
import type { Money } from './types';

/** n / d rounded half away from zero. */
export function roundDiv(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error('Division by zero');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const q = (abs * 2n + d) / (2n * d);
  return negative ? -q : q;
}

/** Parses a decimal string (e.g. "4.2512") into a bigint scaled by 10^scale, rounding half away from zero. */
export function parseDecimal(value: string, scale: number): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid decimal: "${value}"`);
  const sign = match[1] ?? '';
  const int = match[2] ?? '0';
  const frac = match[3] ?? '';
  const digits = BigInt(int + frac);
  const scaled = roundDiv(digits * 10n ** BigInt(scale), 10n ** BigInt(frac.length));
  return sign === '-' ? -scaled : scaled;
}

/** ceil(a / b) for a ≥ 0 and b > 0. */
export function ceilDiv(a: Money, b: number): Money {
  if (a < 0) throw new Error(`ceilDiv: numerator must be ≥ 0, got ${a}`);
  if (b <= 0) throw new Error(`ceilDiv: divisor must be > 0, got ${b}`);
  return Number((BigInt(a) + BigInt(b) - 1n) / BigInt(b));
}

/**
 * Splits `total` (≥ 0) proportionally to non-negative `weights` using largest-remainder rounding.
 * Remainder ties go to the lower index. The result always sums to `total` (unless all weights are 0).
 */
export function allocate(total: Money, weights: Money[]): Money[] {
  if (total < 0) throw new Error(`allocate: total must be ≥ 0, got ${total}`);
  const sum = weights.reduce((s, w) => s + w, 0);
  if (total === 0 || sum === 0) return weights.map(() => 0);
  const bigTotal = BigInt(total);
  const bigSum = BigInt(sum);
  const parts = weights.map((w, index) => {
    const numerator = bigTotal * BigInt(w);
    return { index, quotient: numerator / bigSum, remainder: numerator % bigSum };
  });
  const result = parts.map((p) => Number(p.quotient));
  let left = total - result.reduce((s, x) => s + x, 0);
  const byRemainder = [...parts].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const p of byRemainder) {
    if (left <= 0) break;
    result[p.index] = (result[p.index] ?? 0) + 1;
    left -= 1;
  }
  return result;
}
```

- [ ] **Step 4: Export from the engine index.** Append to `src/engine/index.ts`:

```ts
export * from './money';
```

- [ ] **Step 5: Run tests, typecheck and lint**

Run: `npx vitest run src/engine/money.test.ts && npm run typecheck && npm run lint`
Expected: `Tests  12 passed (12)`, and typecheck and lint exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/engine/money.ts src/engine/money.test.ts src/engine/index.ts
git commit -m "feat(engine): money primitives (rounding, decimals, allocation)" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Date and month arithmetic

**Files:**
- Create: `src/engine/dates.ts`
- Test: `src/engine/dates.test.ts`
- Modify: `src/engine/index.ts`

**Interfaces:**
- Consumes: `IsoDate`, `Month` from `./types`.
- Produces:
  - Month helpers: `monthOf(date): Month`, `addMonths(month, n): Month`, `monthDiff(from, to): number` (= to − from), `monthRange(from, to): Month[]` (inclusive; `[]` if to < from), `daysInMonth(month): number`, `dateInMonth(month, day): IsoDate` (clamped)
  - Day helpers: `addDays(date, n): IsoDate`, `diffDays(from, to): number`, `weekday(date): number` (0 = Sunday), `countWeekdayInMonth(month, wd): number`
  - Invalid input throws `Invalid date: "…"` or `Invalid month: "…"`.

- [ ] **Step 1: Write the failing test** at `src/engine/dates.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  countWeekdayInMonth,
  dateInMonth,
  daysInMonth,
  diffDays,
  monthDiff,
  monthOf,
  monthRange,
  weekday,
} from './dates';

describe('months', () => {
  it('extracts the month of a date', () => {
    expect(monthOf('2026-11-19')).toBe('2026-11');
  });

  it('adds months across year boundaries', () => {
    expect(addMonths('2026-11', 3)).toBe('2027-02');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-05', 0)).toBe('2026-05');
  });

  it('computes signed month differences', () => {
    expect(monthDiff('2026-01', '2026-12')).toBe(11);
    expect(monthDiff('2026-03', '2025-12')).toBe(-3);
  });

  it('builds inclusive month ranges', () => {
    expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(monthRange('2026-02', '2026-01')).toEqual([]);
  });

  it('knows month lengths including leap years', () => {
    expect(daysInMonth('2026-02')).toBe(28);
    expect(daysInMonth('2028-02')).toBe(29);
    expect(daysInMonth('2026-12')).toBe(31);
  });

  it('clamps days past month end', () => {
    expect(dateInMonth('2026-02', 31)).toBe('2026-02-28');
    expect(dateInMonth('2026-03', 5)).toBe('2026-03-05');
  });

  it('rejects malformed values', () => {
    expect(() => monthOf('2026-1-01')).toThrow('Invalid date');
    expect(() => addMonths('2026-13', 1)).toThrow('Invalid month');
  });
});

describe('days', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('computes signed day differences', () => {
    expect(diffDays('2026-01-01', '2026-03-01')).toBe(59);
    expect(diffDays('2026-01-10', '2026-01-03')).toBe(-7);
  });

  it('returns weekday with 0 = Sunday', () => {
    expect(weekday('2026-11-19')).toBe(4); // Thursday
    expect(weekday('2026-11-22')).toBe(0); // Sunday
  });

  it('counts weekdays in a month', () => {
    expect(countWeekdayInMonth('2026-06', 1)).toBe(5); // June 2026 starts on a Monday
    expect(countWeekdayInMonth('2026-06', 0)).toBe(4);
    expect(countWeekdayInMonth('2026-02', 3)).toBe(4);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/engine/dates.test.ts`
Expected: FAIL with `Failed to resolve import "./dates"`.

- [ ] **Step 3: Implement `src/engine/dates.ts`**

```ts
import type { IsoDate, Month } from './types';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const DAY_MS = 86_400_000;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function parseMonth(month: Month): { year: number; month: number } {
  const match = MONTH_RE.exec(month);
  const year = Number(match?.[1]);
  const m = Number(match?.[2]);
  if (!match || m < 1 || m > 12) throw new Error(`Invalid month: "${month}"`);
  return { year, month: m };
}

function parseDate(date: IsoDate): { year: number; month: number; day: number } {
  const match = DATE_RE.exec(date);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  if (!match || month < 1 || month > 12 || day < 1 || day > 31) throw new Error(`Invalid date: "${date}"`);
  return { year, month, day };
}

function toUtcMs(date: IsoDate): number {
  const { year, month, day } = parseDate(date);
  return Date.UTC(year, month - 1, day);
}

function fromUtcMs(ms: number): IsoDate {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function monthOf(date: IsoDate): Month {
  parseDate(date);
  return date.slice(0, 7);
}

export function addMonths(month: Month, n: number): Month {
  const { year, month: m } = parseMonth(month);
  const index = year * 12 + (m - 1) + n;
  return `${pad(Math.floor(index / 12), 4)}-${pad((index % 12) + 1)}`;
}

/** Number of months from `from` to `to` (negative when `to` is earlier). */
export function monthDiff(from: Month, to: Month): number {
  const a = parseMonth(from);
  const b = parseMonth(to);
  return (b.year - a.year) * 12 + (b.month - a.month);
}

/** Inclusive list of months from `from` to `to`; empty when `to` < `from`. */
export function monthRange(from: Month, to: Month): Month[] {
  const count = monthDiff(from, to) + 1;
  return Array.from({ length: Math.max(0, count) }, (_, i) => addMonths(from, i));
}

export function daysInMonth(month: Month): number {
  const { year, month: m } = parseMonth(month);
  return new Date(Date.UTC(year, m, 0)).getUTCDate();
}

/** The given day of `month`, clamped to the month's last day. */
export function dateInMonth(month: Month, day: number): IsoDate {
  return `${month}-${pad(Math.min(day, daysInMonth(month)))}`;
}

export function addDays(date: IsoDate, n: number): IsoDate {
  return fromUtcMs(toUtcMs(date) + n * DAY_MS);
}

/** Number of days from `from` to `to` (negative when `to` is earlier). */
export function diffDays(from: IsoDate, to: IsoDate): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);
}

/** Day of week, 0 = Sunday … 6 = Saturday. */
export function weekday(date: IsoDate): number {
  return new Date(toUtcMs(date)).getUTCDay();
}

/** How many times weekday `wd` (0 = Sunday) occurs in `month`. */
export function countWeekdayInMonth(month: Month, wd: number): number {
  const first = weekday(dateInMonth(month, 1));
  const days = daysInMonth(month);
  const offset = (wd - first + 7) % 7;
  return offset >= days ? 0 : Math.floor((days - 1 - offset) / 7) + 1;
}
```

- [ ] **Step 4: Export from the engine index.** Append to `src/engine/index.ts`:

```ts
export * from './dates';
```

- [ ] **Step 5: Run tests, typecheck and lint**

Run: `npx vitest run src/engine/dates.test.ts && npm run typecheck && npm run lint`
Expected: `Tests  11 passed (11)`, and typecheck and lint exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/engine/dates.ts src/engine/dates.test.ts src/engine/index.ts
git commit -m "feat(engine): month and date arithmetic" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Cash vs credit overspending split

YNAB rule (spec §5.2): available money covers **cash** spending first. Overspending is therefore attributed to card spending first, up to the card spending total: `creditOver = min(O, Σ creditSpend)`, `cashOver = O − creditOver`. When there are several cards, credit overspending is allocated across them proportionally (largest remainder).

**Files:**
- Create: `src/engine/budget/overspending.ts`
- Test: `src/engine/budget/overspending.test.ts`
- Modify: `src/engine/index.ts`

**Interfaces:**
- Consumes: `allocate` from `../money`.
- Produces: `splitOverspending(overspent: Money, creditSpend: Money[]): OverspendingSplit` where `OverspendingSplit = { cashOver: Money; creditOver: Money; creditOverByCard: Money[] }` (`creditOverByCard` is aligned with `creditSpend`).

- [ ] **Step 1: Write the failing test** at `src/engine/budget/overspending.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { splitOverspending } from './overspending';

describe('splitOverspending', () => {
  it('attributes overspending to credit first, so available money covers cash spending first', () => {
    // Available 10, cash spend 20, card spend 50 → overspent 60
    expect(splitOverspending(60, [50])).toEqual({ cashOver: 10, creditOver: 50, creditOverByCard: [50] });
  });

  it('is fully credit overspending when card spending exceeds the overspent amount', () => {
    // Available 100, cash 80, card 50 → overspent 30
    expect(splitOverspending(30, [50])).toEqual({ cashOver: 0, creditOver: 30, creditOverByCard: [30] });
  });

  it('is fully cash overspending without card spending', () => {
    expect(splitOverspending(25, [])).toEqual({ cashOver: 25, creditOver: 0, creditOverByCard: [] });
  });

  it('splits credit overspending across cards proportionally', () => {
    expect(splitOverspending(20, [30, 10])).toEqual({ cashOver: 0, creditOver: 20, creditOverByCard: [15, 5] });
  });

  it('ignores cards that only had refunds (weight 0)', () => {
    expect(splitOverspending(10, [0, 40])).toEqual({ cashOver: 0, creditOver: 10, creditOverByCard: [0, 10] });
  });

  it('returns zeros when nothing is overspent', () => {
    expect(splitOverspending(0, [50])).toEqual({ cashOver: 0, creditOver: 0, creditOverByCard: [0] });
  });

  it('rejects negative input', () => {
    expect(() => splitOverspending(-1, [])).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/engine/budget/overspending.test.ts`
Expected: FAIL with `Failed to resolve import "./overspending"`.

- [ ] **Step 3: Implement `src/engine/budget/overspending.ts`**

```ts
import { allocate } from '../money';
import type { Money } from '../types';

export interface OverspendingSplit {
  cashOver: Money;
  creditOver: Money;
  /** Credit overspending per card, aligned with the `creditSpend` input. */
  creditOverByCard: Money[];
}

/**
 * Splits an overspent amount (≥ 0) into credit and cash parts (YNAB rule: available money covers cash spending
 * first, so overspending is attributed to card spending first). `creditSpend[i]` is the net spending (≥ 0) on card i.
 */
export function splitOverspending(overspent: Money, creditSpend: Money[]): OverspendingSplit {
  if (overspent < 0) throw new Error(`splitOverspending: overspent must be ≥ 0, got ${overspent}`);
  const totalCredit = creditSpend.reduce((s, x) => s + x, 0);
  const creditOver = Math.min(overspent, totalCredit);
  return {
    cashOver: overspent - creditOver,
    creditOver,
    creditOverByCard: allocate(creditOver, creditSpend),
  };
}
```

- [ ] **Step 4: Export from the engine index.** Append to `src/engine/index.ts`:

```ts
export { splitOverspending, type OverspendingSplit } from './budget/overspending';
```

- [ ] **Step 5: Run tests, typecheck and lint**

Run: `npx vitest run src/engine/budget/overspending.test.ts && npm run typecheck && npm run lint`
Expected: `Tests  7 passed (7)`, and typecheck and lint exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/engine/budget/overspending.ts src/engine/budget/overspending.test.ts src/engine/index.ts
git commit -m "feat(engine): split overspending into cash and credit parts" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Budget computation: categories, carry, overspending, Ready to Assign

Implements spec §5.1, §5.2 (via `splitOverspending`) and §5.4 for regular categories. Credit card **payment** categories come in Task 6. The engine receives pre-aggregated rows (the server's SQL will produce them in P2) and recomputes every month from the start.

Rules implemented:
- Available = Carry + Assigned + Activity; Carry = max(0, previous Available).
- Leftover(m) = Leftover(m−1) + Income(m) − AssignedTotal(m) − CashOverspent(m−1).
- Shown RTA(m) = Leftover(m) − Σ assignments in later months.
- The month range widens automatically to cover all data.

**Files:**
- Create: `src/engine/budget/types.ts`, `src/engine/budget/compute.ts`, `src/engine/budget/test-helpers.ts`
- Test: `src/engine/budget/compute.test.ts`
- Modify: `src/engine/index.ts`

**Interfaces:**
- Consumes: `monthRange` from `../dates`; `splitOverspending` from `./overspending`.
- Produces:
  - `computeBudget(input: BudgetInput): BudgetResult`
  - types `BudgetCategory`, `ActivityRow`, `AssignmentRow`, `BudgetInput`, `CategoryMonth`, `RtaBreakdown`, `MonthBudget` (includes `cashOverspentTotal`), `BudgetResult` (`{ months: Month[]; byMonth: Record<Month, MonthBudget> }`)
  - test helpers `RTA`, `budgetInput()`, `category()`, `cashLine()`, `assign()`

- [ ] **Step 1: Create `src/engine/budget/types.ts`**

```ts
import type { Money, Month } from '../types';

export interface BudgetCategory {
  id: string;
  kind: 'normal' | 'uncategorized';
}

/** Σ amount_base of on-budget ledger lines, grouped by month, category and account. */
export interface ActivityRow {
  month: Month;
  /** Category id; the RTA category id marks income. */
  categoryId: string;
  accountId: string;
  accountClass: 'cash' | 'credit';
  amount: Money;
}

export interface AssignmentRow {
  month: Month;
  categoryId: string;
  amount: Money;
}

export interface BudgetInput {
  /** User-configured budget start; widened automatically to the earliest month with data. */
  startMonth: Month;
  /** Last month to compute; widened automatically to the latest month with data. */
  throughMonth: Month;
  /** Id of the system "Ready to Assign" category. Must not appear in `categories`. */
  rtaCategoryId: string;
  categories: BudgetCategory[];
  assignments: AssignmentRow[];
  activity: ActivityRow[];
}

export interface CategoryMonth {
  categoryId: string;
  carry: Money;
  assigned: Money;
  activity: Money;
  available: Money;
  cashOverspent: Money;
  creditOverspent: Money;
  /** Credit overspending per credit account id (only non-zero entries). */
  creditOverByCard: Record<string, Money>;
}

export interface RtaBreakdown {
  leftoverPrev: Money;
  income: Money;
  assignedThisMonth: Money;
  assignedFuture: Money;
  cashOverspentPrev: Money;
  leftover: Money;
  readyToAssign: Money;
}

export interface MonthBudget {
  month: Month;
  rta: RtaBreakdown;
  /** Σ cashOverspent over all categories this month (deducted from next month's RTA). */
  cashOverspentTotal: Money;
  categories: Record<string, CategoryMonth>;
}

export interface BudgetResult {
  months: Month[];
  byMonth: Record<Month, MonthBudget>;
}
```

- [ ] **Step 2: Create the test helpers `src/engine/budget/test-helpers.ts`**

```ts
import type { ActivityRow, AssignmentRow, BudgetCategory, BudgetInput } from './types';

export const RTA = 'rta';

export function budgetInput(partial: Partial<BudgetInput>): BudgetInput {
  return {
    startMonth: '2026-01',
    throughMonth: '2026-01',
    rtaCategoryId: RTA,
    categories: [],
    assignments: [],
    activity: [],
    ...partial,
  };
}

export function category(id: string, kind: BudgetCategory['kind'] = 'normal'): BudgetCategory {
  return { id, kind };
}

export function cashLine(month: string, categoryId: string, amount: number, accountId = 'checking'): ActivityRow {
  return { month, categoryId, accountId, accountClass: 'cash', amount };
}

export function assign(month: string, categoryId: string, amount: number): AssignmentRow {
  return { month, categoryId, amount };
}
```

- [ ] **Step 3: Write the failing test** at `src/engine/budget/compute.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { computeBudget } from './compute';
import { RTA, assign, budgetInput, cashLine, category } from './test-helpers';

const groceries = category('groceries');
const rent = category('rent');

describe('computeBudget: categories and Ready to Assign', () => {
  it('puts income into Ready to Assign', () => {
    const result = computeBudget(budgetInput({ activity: [cashLine('2026-01', RTA, 100_000)] }));
    expect(result.byMonth['2026-01']?.rta).toEqual({
      leftoverPrev: 0,
      income: 100_000,
      assignedThisMonth: 0,
      assignedFuture: 0,
      cashOverspentPrev: 0,
      leftover: 100_000,
      readyToAssign: 100_000,
    });
  });

  it('moves assigned money from RTA to the category and subtracts spending', () => {
    const result = computeBudget(
      budgetInput({
        categories: [groceries],
        activity: [cashLine('2026-01', RTA, 100_000), cashLine('2026-01', 'groceries', -10_000)],
        assignments: [assign('2026-01', 'groceries', 30_000)],
      }),
    );
    const jan = result.byMonth['2026-01']!;
    expect(jan.rta.readyToAssign).toBe(70_000);
    expect(jan.categories['groceries']).toMatchObject({ carry: 0, assigned: 30_000, activity: -10_000, available: 20_000 });
  });

  it('carries positive Available into the next month', () => {
    const result = computeBudget(
      budgetInput({
        throughMonth: '2026-02',
        categories: [groceries],
        activity: [cashLine('2026-01', RTA, 50_000), cashLine('2026-01', 'groceries', -10_000)],
        assignments: [assign('2026-01', 'groceries', 30_000)],
      }),
    );
    const feb = result.byMonth['2026-02']!;
    expect(feb.categories['groceries']).toMatchObject({ carry: 20_000, assigned: 0, activity: 0, available: 20_000 });
    expect(feb.rta.leftoverPrev).toBe(20_000);
    expect(feb.rta.readyToAssign).toBe(20_000);
  });

  it('golden 4: assigning in a future month reduces RTA now', () => {
    const result = computeBudget(
      budgetInput({
        categories: [rent],
        activity: [cashLine('2026-01', RTA, 20_000)],
        assignments: [assign('2026-02', 'rent', 20_000)],
      }),
    );
    expect(result.months).toEqual(['2026-01', '2026-02']);
    expect(result.byMonth['2026-01']?.rta).toMatchObject({ leftover: 20_000, assignedFuture: 20_000, readyToAssign: 0 });
    expect(result.byMonth['2026-02']?.rta).toMatchObject({ leftover: 0, assignedFuture: 0, readyToAssign: 0 });
    expect(result.byMonth['2026-02']?.categories['rent']?.available).toBe(20_000);
  });

  it('golden 5: cash overspending resets the category and is deducted from next month RTA', () => {
    const result = computeBudget(
      budgetInput({
        throughMonth: '2026-02',
        categories: [groceries],
        activity: [cashLine('2026-01', 'groceries', -5_000)],
      }),
    );
    const jan = result.byMonth['2026-01']!;
    expect(jan.categories['groceries']).toMatchObject({ available: -5_000, cashOverspent: 5_000, creditOverspent: 0 });
    expect(jan.cashOverspentTotal).toBe(5_000);
    expect(jan.rta.readyToAssign).toBe(0);
    const feb = result.byMonth['2026-02']!;
    expect(feb.categories['groceries']).toMatchObject({ carry: 0, available: 0 });
    expect(feb.rta).toMatchObject({ cashOverspentPrev: 5_000, leftover: -5_000, readyToAssign: -5_000 });
  });

  it('treats a negative assignment that drives Available below zero as cash overspending', () => {
    const result = computeBudget(
      budgetInput({ categories: [groceries], assignments: [assign('2026-01', 'groceries', -3_000)] }),
    );
    expect(result.byMonth['2026-01']?.categories['groceries']).toMatchObject({ available: -3_000, cashOverspent: 3_000 });
    expect(result.byMonth['2026-01']?.rta.readyToAssign).toBe(3_000);
  });

  it('applies normal rules to the Uncategorized category', () => {
    const result = computeBudget(
      budgetInput({ categories: [category('uncat', 'uncategorized')], activity: [cashLine('2026-01', 'uncat', -700)] }),
    );
    expect(result.byMonth['2026-01']?.categories['uncat']).toMatchObject({ available: -700, cashOverspent: 700 });
  });

  it('widens the month range to cover all data', () => {
    const result = computeBudget(
      budgetInput({
        startMonth: '2026-03',
        throughMonth: '2026-03',
        categories: [groceries],
        activity: [cashLine('2026-01', RTA, 1_000)],
        assignments: [assign('2026-05', 'groceries', 1_000)],
      }),
    );
    expect(result.months).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05']);
  });

  it('rejects activity and assignments for unknown categories', () => {
    expect(() => computeBudget(budgetInput({ activity: [cashLine('2026-01', 'nope', -1)] }))).toThrow('unknown category');
    expect(() => computeBudget(budgetInput({ assignments: [assign('2026-01', RTA, 1)] }))).toThrow('unknown category');
  });

  it('rejects listing the RTA category as a regular category', () => {
    expect(() => computeBudget(budgetInput({ categories: [category(RTA)] }))).toThrow('RTA');
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run src/engine/budget/compute.test.ts`
Expected: FAIL with `Failed to resolve import "./compute"`.

- [ ] **Step 5: Implement `src/engine/budget/compute.ts`**

```ts
import { monthRange } from '../dates';
import type { Money, Month } from '../types';
import { splitOverspending } from './overspending';
import type { BudgetInput, BudgetResult, CategoryMonth, MonthBudget } from './types';

const key = (month: Month, id: string) => `${month}|${id}`;

function addTo(map: Map<string, Money>, k: string, amount: Money): void {
  map.set(k, (map.get(k) ?? 0) + amount);
}

/** Computes every budget month from the (widened) start month through the (widened) end month. */
export function computeBudget(input: BudgetInput): BudgetResult {
  const { rtaCategoryId } = input;
  const known = new Map(input.categories.map((c) => [c.id, c]));
  if (known.has(rtaCategoryId)) throw new Error('The RTA category must not be listed in categories');

  let first = input.startMonth;
  let last = input.throughMonth;
  const widen = (m: Month) => {
    if (m < first) first = m;
    if (m > last) last = m;
  };

  const assigned = new Map<string, Money>();
  const assignedTotal = new Map<Month, Money>();
  for (const a of input.assignments) {
    if (!known.has(a.categoryId)) throw new Error(`Assignment to unknown category ${a.categoryId}`);
    widen(a.month);
    addTo(assigned, key(a.month, a.categoryId), a.amount);
    addTo(assignedTotal, a.month, a.amount);
  }

  const income = new Map<Month, Money>();
  const cashLines = new Map<string, Money>();
  const cardLines = new Map<string, Map<string, Money>>();
  for (const row of input.activity) {
    widen(row.month);
    if (row.categoryId === rtaCategoryId) {
      addTo(income, row.month, row.amount);
      continue;
    }
    if (!known.has(row.categoryId)) throw new Error(`Activity in unknown category ${row.categoryId}`);
    const k = key(row.month, row.categoryId);
    if (row.accountClass === 'cash') {
      addTo(cashLines, k, row.amount);
    } else {
      let byCard = cardLines.get(k);
      if (!byCard) cardLines.set(k, (byCard = new Map()));
      addTo(byCard, row.accountId, row.amount);
    }
  }

  const months = monthRange(first, last);
  const assignedAfter = new Map<Month, Money>();
  let running = 0;
  for (const m of [...months].reverse()) {
    assignedAfter.set(m, running);
    running += assignedTotal.get(m) ?? 0;
  }

  const byMonth: Record<Month, MonthBudget> = {};
  let prev: MonthBudget | undefined;
  for (const month of months) {
    const categories: Record<string, CategoryMonth> = {};
    let cashOverspentTotal = 0;

    for (const c of input.categories) {
      const k = key(month, c.id);
      const byCard = cardLines.get(k) ?? new Map<string, Money>();
      const cards = [...byCard.keys()];
      let activity = cashLines.get(k) ?? 0;
      for (const amount of byCard.values()) activity += amount;
      const carry = Math.max(0, prev?.categories[c.id]?.available ?? 0);
      const asg = assigned.get(k) ?? 0;
      const available = carry + asg + activity;
      const split = splitOverspending(
        Math.max(0, -available),
        cards.map((card) => Math.max(0, -(byCard.get(card) ?? 0))),
      );
      const creditOverByCard: Record<string, Money> = {};
      cards.forEach((card, i) => {
        const over = split.creditOverByCard[i] ?? 0;
        if (over > 0) creditOverByCard[card] = over;
      });
      cashOverspentTotal += split.cashOver;
      categories[c.id] = {
        categoryId: c.id,
        carry,
        assigned: asg,
        activity,
        available,
        cashOverspent: split.cashOver,
        creditOverspent: split.creditOver,
        creditOverByCard,
      };
    }

    const leftoverPrev = prev?.rta.leftover ?? 0;
    const cashOverspentPrev = prev?.cashOverspentTotal ?? 0;
    const monthIncome = income.get(month) ?? 0;
    const assignedThisMonth = assignedTotal.get(month) ?? 0;
    const assignedFuture = assignedAfter.get(month) ?? 0;
    const leftover = leftoverPrev + monthIncome - assignedThisMonth - cashOverspentPrev;
    const budget: MonthBudget = {
      month,
      cashOverspentTotal,
      categories,
      rta: {
        leftoverPrev,
        income: monthIncome,
        assignedThisMonth,
        assignedFuture,
        cashOverspentPrev,
        leftover,
        readyToAssign: leftover - assignedFuture,
      },
    };
    byMonth[month] = budget;
    prev = budget;
  }

  return { months, byMonth };
}
```

- [ ] **Step 6: Export from the engine index.** Append to `src/engine/index.ts`:

```ts
export * from './budget/types';
export { computeBudget } from './budget/compute';
```

- [ ] **Step 7: Run tests, typecheck and lint**

Run: `npx vitest run src/engine/budget && npm run typecheck && npm run lint`
Expected: `Tests  17 passed (17)` (10 compute + 7 overspending), and typecheck and lint exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/engine/budget src/engine/index.ts
git commit -m "feat(engine): compute budget months, carry-over and Ready to Assign" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Credit card payment categories

Implements spec §5.3. Each credit account `k` has a payment category `p_k` (`kind: 'cc_payment'`, `linkedAccountId: k`). For each regular category `c` and card `k` in a month, `p_k` receives `net − creditOver(c,k)`, where `net = −Σ c's lines on k`. A net refund is negative and moves money back to `c`. Transfers between `k` and on-budget accounts subtract the card-side amount from `p_k` (payments reduce it). Overspending in `p_k` is always cash overspending. Categorizing a transaction to `p_k` is rejected.

**Files:**
- Modify (full replacement): `src/engine/budget/types.ts`, `src/engine/budget/test-helpers.ts`, `src/engine/budget/compute.ts`
- Test: `src/engine/budget/cards.test.ts`
- Modify: `src/engine/index.ts`

**Interfaces:**
- Consumes: everything from Task 5.
- Produces:
  - `BudgetCategory.kind` gains `'cc_payment'`, plus optional `linkedAccountId?: string`
  - new `CardTransferRow { month; cardAccountId; amount }` and `BudgetInput.cardTransfers?: CardTransferRow[]`
  - `cardPaymentShortfall(cardBalance: Money, paymentAvailable: Money): Money` (= max(0, −balance − available))
  - test helpers `cardLine()`, `cardPayment()`, `cardTransfer()`

- [ ] **Step 1: Replace `src/engine/budget/types.ts`** with:

```ts
import type { Money, Month } from '../types';

export interface BudgetCategory {
  id: string;
  kind: 'normal' | 'uncategorized' | 'cc_payment';
  /** For `cc_payment` categories: the credit account this category pays. */
  linkedAccountId?: string;
}

/** Σ amount_base of on-budget ledger lines, grouped by month, category and account. */
export interface ActivityRow {
  month: Month;
  /** Category id; the RTA category id marks income. */
  categoryId: string;
  accountId: string;
  accountClass: 'cash' | 'credit';
  amount: Money;
}

/** Σ card-side amount_base of transfers between a credit account and any on-budget account, per month. */
export interface CardTransferRow {
  month: Month;
  cardAccountId: string;
  amount: Money;
}

export interface AssignmentRow {
  month: Month;
  categoryId: string;
  amount: Money;
}

export interface BudgetInput {
  /** User-configured budget start; widened automatically to the earliest month with data. */
  startMonth: Month;
  /** Last month to compute; widened automatically to the latest month with data. */
  throughMonth: Month;
  /** Id of the system "Ready to Assign" category. Must not appear in `categories`. */
  rtaCategoryId: string;
  categories: BudgetCategory[];
  assignments: AssignmentRow[];
  activity: ActivityRow[];
  cardTransfers?: CardTransferRow[];
}

export interface CategoryMonth {
  categoryId: string;
  carry: Money;
  assigned: Money;
  activity: Money;
  available: Money;
  cashOverspent: Money;
  creditOverspent: Money;
  /** Credit overspending per credit account id (only non-zero entries). */
  creditOverByCard: Record<string, Money>;
}

export interface RtaBreakdown {
  leftoverPrev: Money;
  income: Money;
  assignedThisMonth: Money;
  assignedFuture: Money;
  cashOverspentPrev: Money;
  leftover: Money;
  readyToAssign: Money;
}

export interface MonthBudget {
  month: Month;
  rta: RtaBreakdown;
  /** Σ cashOverspent over all categories this month (deducted from next month's RTA). */
  cashOverspentTotal: Money;
  categories: Record<string, CategoryMonth>;
}

export interface BudgetResult {
  months: Month[];
  byMonth: Record<Month, MonthBudget>;
}
```

- [ ] **Step 2: Replace `src/engine/budget/test-helpers.ts`** with:

```ts
import type { ActivityRow, AssignmentRow, BudgetCategory, BudgetInput, CardTransferRow } from './types';

export const RTA = 'rta';

export function budgetInput(partial: Partial<BudgetInput>): BudgetInput {
  return {
    startMonth: '2026-01',
    throughMonth: '2026-01',
    rtaCategoryId: RTA,
    categories: [],
    assignments: [],
    activity: [],
    cardTransfers: [],
    ...partial,
  };
}

export function category(id: string, kind: BudgetCategory['kind'] = 'normal'): BudgetCategory {
  return { id, kind };
}

export function cashLine(month: string, categoryId: string, amount: number, accountId = 'checking'): ActivityRow {
  return { month, categoryId, accountId, accountClass: 'cash', amount };
}

export function assign(month: string, categoryId: string, amount: number): AssignmentRow {
  return { month, categoryId, amount };
}

export function cardLine(month: string, categoryId: string, amount: number, accountId = 'visa'): ActivityRow {
  return { month, categoryId, accountId, accountClass: 'credit', amount };
}

export function cardPayment(cardAccountId: string): BudgetCategory {
  return { id: `pay-${cardAccountId}`, kind: 'cc_payment', linkedAccountId: cardAccountId };
}

export function cardTransfer(month: string, cardAccountId: string, amount: number): CardTransferRow {
  return { month, cardAccountId, amount };
}
```

- [ ] **Step 3: Write the failing test** at `src/engine/budget/cards.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { cardPaymentShortfall, computeBudget } from './compute';
import {
  RTA,
  assign,
  budgetInput,
  cardLine,
  cardPayment,
  cardTransfer,
  cashLine,
  category,
} from './test-helpers';

const groceries = category('groceries');
const visa = cardPayment('visa');
const amex = cardPayment('amex');

describe('computeBudget: credit card payment categories', () => {
  it('moves funded card spending into the payment category', () => {
    const result = computeBudget(
      budgetInput({
        categories: [groceries, visa],
        assignments: [assign('2026-01', 'groceries', 10_000)],
        activity: [cardLine('2026-01', 'groceries', -7_000)],
      }),
    );
    const jan = result.byMonth['2026-01']!;
    expect(jan.categories['groceries']).toMatchObject({ available: 3_000, creditOverspent: 0 });
    expect(jan.categories['pay-visa']).toMatchObject({ activity: 7_000, available: 7_000 });
  });

  it('golden 1: cash spending is funded first; the unfunded card part is yellow credit overspending', () => {
    const result = computeBudget(
      budgetInput({
        categories: [groceries, visa],
        assignments: [assign('2026-01', 'groceries', 10_000)],
        activity: [cashLine('2026-01', 'groceries', -8_000), cardLine('2026-01', 'groceries', -5_000)],
      }),
    );
    const jan = result.byMonth['2026-01']!;
    expect(jan.categories['groceries']).toMatchObject({
      available: -3_000,
      cashOverspent: 0,
      creditOverspent: 3_000,
      creditOverByCard: { visa: 3_000 },
    });
    expect(jan.categories['pay-visa']).toMatchObject({ activity: 2_000, available: 2_000 });
  });

  it('golden 2: mixed overspending is red until the cash part is covered, then yellow', () => {
    const base = {
      categories: [groceries, visa],
      activity: [cashLine('2026-01', 'groceries', -2_000), cardLine('2026-01', 'groceries', -5_000)],
    };
    const at = (assigned: number) =>
      computeBudget(budgetInput({ ...base, assignments: [assign('2026-01', 'groceries', assigned)] })).byMonth['2026-01']!;

    expect(at(1_000).categories['groceries']).toMatchObject({ available: -6_000, cashOverspent: 1_000, creditOverspent: 5_000 });
    expect(at(1_000).categories['pay-visa']?.activity).toBe(0);

    expect(at(2_000).categories['groceries']).toMatchObject({ available: -5_000, cashOverspent: 0, creditOverspent: 5_000 });
    expect(at(2_000).categories['pay-visa']?.activity).toBe(0);

    expect(at(7_000).categories['groceries']).toMatchObject({ available: 0, cashOverspent: 0, creditOverspent: 0 });
    expect(at(7_000).categories['pay-visa']?.activity).toBe(5_000);
  });

  it('golden 3: a card refund moves money from the payment category back to the category', () => {
    const result = computeBudget(
      budgetInput({
        throughMonth: '2026-02',
        categories: [groceries, visa],
        assignments: [assign('2026-01', 'groceries', 10_000)],
        activity: [cardLine('2026-01', 'groceries', -10_000), cardLine('2026-02', 'groceries', 3_000)],
      }),
    );
    const feb = result.byMonth['2026-02']!;
    expect(feb.categories['groceries']).toMatchObject({ carry: 0, activity: 3_000, available: 3_000 });
    expect(feb.categories['pay-visa']).toMatchObject({ carry: 10_000, activity: -3_000, available: 7_000 });
  });

  it('golden 6: credit overspending does not carry and does not touch next month RTA', () => {
    const result = computeBudget(
      budgetInput({
        throughMonth: '2026-02',
        categories: [groceries, visa],
        activity: [cardLine('2026-01', 'groceries', -5_000)],
      }),
    );
    const jan = result.byMonth['2026-01']!;
    expect(jan.categories['groceries']).toMatchObject({ available: -5_000, creditOverspent: 5_000, cashOverspent: 0 });
    expect(jan.categories['pay-visa']?.available).toBe(0);
    const feb = result.byMonth['2026-02']!;
    expect(feb.categories['groceries']?.available).toBe(0);
    expect(feb.rta.cashOverspentPrev).toBe(0);
    expect(feb.rta.readyToAssign).toBe(0);
    expect(cardPaymentShortfall(-5_000, feb.categories['pay-visa']!.available)).toBe(5_000);
  });

  it('golden 7: card starting balance is covered by assigning to the payment category', () => {
    const withoutAssign = computeBudget(budgetInput({ categories: [visa], activity: [cashLine('2026-01', RTA, 50_000)] }));
    expect(cardPaymentShortfall(-37_500, withoutAssign.byMonth['2026-01']!.categories['pay-visa']!.available)).toBe(37_500);

    const withAssign = computeBudget(
      budgetInput({
        categories: [visa],
        activity: [cashLine('2026-01', RTA, 50_000)],
        assignments: [assign('2026-01', 'pay-visa', 37_500)],
      }),
    );
    const jan = withAssign.byMonth['2026-01']!;
    expect(cardPaymentShortfall(-37_500, jan.categories['pay-visa']!.available)).toBe(0);
    expect(jan.rta.readyToAssign).toBe(12_500);
  });

  it('golden 8: paying more than the payment category holds is cash overspending', () => {
    const result = computeBudget(
      budgetInput({
        throughMonth: '2026-02',
        categories: [visa],
        assignments: [assign('2026-01', 'pay-visa', 10_000)],
        cardTransfers: [cardTransfer('2026-01', 'visa', 15_000)],
      }),
    );
    expect(result.byMonth['2026-01']?.categories['pay-visa']).toMatchObject({
      activity: -15_000,
      available: -5_000,
      cashOverspent: 5_000,
      creditOverspent: 0,
    });
    expect(result.byMonth['2026-02']?.rta.cashOverspentPrev).toBe(5_000);
  });

  it('moves debt between payment categories on a card-to-card balance transfer', () => {
    const result = computeBudget(
      budgetInput({
        categories: [visa, amex],
        assignments: [assign('2026-01', 'pay-visa', 10_000)],
        cardTransfers: [cardTransfer('2026-01', 'visa', 10_000), cardTransfer('2026-01', 'amex', -10_000)],
      }),
    );
    const jan = result.byMonth['2026-01']!;
    expect(jan.categories['pay-visa']?.available).toBe(0);
    expect(jan.categories['pay-amex']?.available).toBe(10_000);
  });

  it('splits credit overspending across cards proportionally and funds the rest', () => {
    const result = computeBudget(
      budgetInput({
        categories: [groceries, visa, amex],
        assignments: [assign('2026-01', 'groceries', 2_000)],
        activity: [cardLine('2026-01', 'groceries', -3_000, 'visa'), cardLine('2026-01', 'groceries', -1_000, 'amex')],
      }),
    );
    const jan = result.byMonth['2026-01']!;
    expect(jan.categories['groceries']?.creditOverByCard).toEqual({ visa: 1_500, amex: 500 });
    expect(jan.categories['pay-visa']?.activity).toBe(1_500);
    expect(jan.categories['pay-amex']?.activity).toBe(500);
  });

  it('counts RTA inflows on a card as income without touching the payment category', () => {
    const result = computeBudget(
      budgetInput({ categories: [visa], activity: [cardLine('2026-01', RTA, 1_200)] }),
    );
    const jan = result.byMonth['2026-01']!;
    expect(jan.rta.income).toBe(1_200);
    expect(jan.categories['pay-visa']?.activity).toBe(0);
  });

  it('flows Uncategorized card spending like any category (unfunded, so nothing moves)', () => {
    const result = computeBudget(
      budgetInput({ categories: [category('uncat', 'uncategorized'), visa], activity: [cardLine('2026-01', 'uncat', -900)] }),
    );
    const jan = result.byMonth['2026-01']!;
    expect(jan.categories['uncat']).toMatchObject({ available: -900, creditOverspent: 900 });
    expect(jan.categories['pay-visa']?.activity).toBe(0);
  });

  it('rejects transactions categorized to a payment category and cards without one', () => {
    expect(() =>
      computeBudget(budgetInput({ categories: [visa], activity: [cashLine('2026-01', 'pay-visa', -1)] })),
    ).toThrow('credit card payment category');
    expect(() =>
      computeBudget(budgetInput({ categories: [groceries], activity: [cardLine('2026-01', 'groceries', -1)] })),
    ).toThrow('no payment category');
    expect(() => computeBudget(budgetInput({ categories: [{ id: 'p', kind: 'cc_payment' }] }))).toThrow('linkedAccountId');
  });
});

describe('cardPaymentShortfall', () => {
  it('is the debt not yet covered by the payment category', () => {
    expect(cardPaymentShortfall(-57_000, 50_000)).toBe(7_000);
    expect(cardPaymentShortfall(-57_000, 60_000)).toBe(0);
    expect(cardPaymentShortfall(2_000, 0)).toBe(0);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run src/engine/budget/cards.test.ts`
Expected: FAIL. Most tests fail because payment categories are treated as plain categories and `cardPaymentShortfall` is not exported (`cardPaymentShortfall is not a function`).

- [ ] **Step 5: Replace `src/engine/budget/compute.ts`** with:

```ts
import { monthRange } from '../dates';
import type { Money, Month } from '../types';
import { splitOverspending } from './overspending';
import type { BudgetInput, BudgetResult, CategoryMonth, MonthBudget } from './types';

const key = (month: Month, id: string) => `${month}|${id}`;

function addTo(map: Map<string, Money>, k: string, amount: Money): void {
  map.set(k, (map.get(k) ?? 0) + amount);
}

/** "Need X to pay in full": card debt not covered by its payment category's Available. */
export function cardPaymentShortfall(cardBalance: Money, paymentAvailable: Money): Money {
  return Math.max(0, -cardBalance - paymentAvailable);
}

/** Computes every budget month from the (widened) start month through the (widened) end month. */
export function computeBudget(input: BudgetInput): BudgetResult {
  const { rtaCategoryId } = input;
  const known = new Map(input.categories.map((c) => [c.id, c]));
  if (known.has(rtaCategoryId)) throw new Error('The RTA category must not be listed in categories');
  const regular = input.categories.filter((c) => c.kind !== 'cc_payment');
  const payment = input.categories.filter((c) => c.kind === 'cc_payment');
  const cardIds = new Set<string>();
  for (const p of payment) {
    if (!p.linkedAccountId) throw new Error(`Credit card payment category ${p.id} has no linkedAccountId`);
    cardIds.add(p.linkedAccountId);
  }

  let first = input.startMonth;
  let last = input.throughMonth;
  const widen = (m: Month) => {
    if (m < first) first = m;
    if (m > last) last = m;
  };

  const assigned = new Map<string, Money>();
  const assignedTotal = new Map<Month, Money>();
  for (const a of input.assignments) {
    if (!known.has(a.categoryId)) throw new Error(`Assignment to unknown category ${a.categoryId}`);
    widen(a.month);
    addTo(assigned, key(a.month, a.categoryId), a.amount);
    addTo(assignedTotal, a.month, a.amount);
  }

  const income = new Map<Month, Money>();
  const cashLines = new Map<string, Money>();
  const cardLines = new Map<string, Map<string, Money>>();
  for (const row of input.activity) {
    widen(row.month);
    if (row.categoryId === rtaCategoryId) {
      addTo(income, row.month, row.amount);
      continue;
    }
    const cat = known.get(row.categoryId);
    if (!cat) throw new Error(`Activity in unknown category ${row.categoryId}`);
    if (cat.kind === 'cc_payment') {
      throw new Error(`Transactions cannot be categorized to credit card payment category ${row.categoryId}`);
    }
    const k = key(row.month, row.categoryId);
    if (row.accountClass === 'cash') {
      addTo(cashLines, k, row.amount);
    } else {
      if (!cardIds.has(row.accountId)) throw new Error(`Credit account ${row.accountId} has no payment category`);
      let byCard = cardLines.get(k);
      if (!byCard) cardLines.set(k, (byCard = new Map()));
      addTo(byCard, row.accountId, row.amount);
    }
  }

  const cardTransfers = new Map<string, Money>();
  for (const t of input.cardTransfers ?? []) {
    if (!cardIds.has(t.cardAccountId)) throw new Error(`Credit account ${t.cardAccountId} has no payment category`);
    widen(t.month);
    addTo(cardTransfers, key(t.month, t.cardAccountId), t.amount);
  }

  const months = monthRange(first, last);
  const assignedAfter = new Map<Month, Money>();
  let running = 0;
  for (const m of [...months].reverse()) {
    assignedAfter.set(m, running);
    running += assignedTotal.get(m) ?? 0;
  }

  const byMonth: Record<Month, MonthBudget> = {};
  let prev: MonthBudget | undefined;
  for (const month of months) {
    const categories: Record<string, CategoryMonth> = {};
    const fundedFlow = new Map<string, Money>();
    let cashOverspentTotal = 0;

    for (const c of regular) {
      const k = key(month, c.id);
      const byCard = cardLines.get(k) ?? new Map<string, Money>();
      const cards = [...byCard.keys()];
      let activity = cashLines.get(k) ?? 0;
      for (const amount of byCard.values()) activity += amount;
      const carry = Math.max(0, prev?.categories[c.id]?.available ?? 0);
      const asg = assigned.get(k) ?? 0;
      const available = carry + asg + activity;
      const split = splitOverspending(
        Math.max(0, -available),
        cards.map((card) => Math.max(0, -(byCard.get(card) ?? 0))),
      );
      const creditOverByCard: Record<string, Money> = {};
      cards.forEach((card, i) => {
        const over = split.creditOverByCard[i] ?? 0;
        if (over > 0) creditOverByCard[card] = over;
        // Funded spending (or a refund, when negative) moves into the card's payment category.
        addTo(fundedFlow, card, -(byCard.get(card) ?? 0) - over);
      });
      cashOverspentTotal += split.cashOver;
      categories[c.id] = {
        categoryId: c.id,
        carry,
        assigned: asg,
        activity,
        available,
        cashOverspent: split.cashOver,
        creditOverspent: split.creditOver,
        creditOverByCard,
      };
    }

    for (const p of payment) {
      const card = p.linkedAccountId as string;
      const k = key(month, p.id);
      const activity = (fundedFlow.get(card) ?? 0) - (cardTransfers.get(key(month, card)) ?? 0);
      const carry = Math.max(0, prev?.categories[p.id]?.available ?? 0);
      const asg = assigned.get(k) ?? 0;
      const available = carry + asg + activity;
      const cashOverspent = Math.max(0, -available);
      cashOverspentTotal += cashOverspent;
      categories[p.id] = {
        categoryId: p.id,
        carry,
        assigned: asg,
        activity,
        available,
        cashOverspent,
        creditOverspent: 0,
        creditOverByCard: {},
      };
    }

    const leftoverPrev = prev?.rta.leftover ?? 0;
    const cashOverspentPrev = prev?.cashOverspentTotal ?? 0;
    const monthIncome = income.get(month) ?? 0;
    const assignedThisMonth = assignedTotal.get(month) ?? 0;
    const assignedFuture = assignedAfter.get(month) ?? 0;
    const leftover = leftoverPrev + monthIncome - assignedThisMonth - cashOverspentPrev;
    const budget: MonthBudget = {
      month,
      cashOverspentTotal,
      categories,
      rta: {
        leftoverPrev,
        income: monthIncome,
        assignedThisMonth,
        assignedFuture,
        cashOverspentPrev,
        leftover,
        readyToAssign: leftover - assignedFuture,
      },
    };
    byMonth[month] = budget;
    prev = budget;
  }

  return { months, byMonth };
}
```

- [ ] **Step 6: Update the engine index.** In `src/engine/index.ts` replace the line `export { computeBudget } from './budget/compute';` with:

```ts
export { computeBudget, cardPaymentShortfall } from './budget/compute';
```

- [ ] **Step 7: Run tests, typecheck and lint**

Run: `npx vitest run src/engine/budget && npm run typecheck && npm run lint`
Expected: `Tests  30 passed (30)` (13 cards + 10 compute + 7 overspending), and typecheck and lint exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/engine/budget src/engine/index.ts
git commit -m "feat(engine): credit card payment categories and funded-spending flows" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: Budget invariant property tests

Implements spec §5.7 and the §14 property tests. Over random ledgers (two cash accounts, two cards, spending/RTA/Uncategorized lines, transfers between any accounts, assignments of any sign) the tests check that:

- Σ cash balances = Σ Available + Leftover + Σ creditOverspent − K, where K is the cumulative RTA income booked on cards
- carry is never negative
- Shown RTA = Leftover − assignments in later months
- cashOverspent + creditOverspent = max(0, −Available), and the per-card amounts add up to the total

**Files:**
- Test: `src/engine/budget/invariants.property.test.ts`

**Interfaces:**
- Consumes: `computeBudget`, the budget types, and `addMonths`/`monthRange`.
- Produces: no new code. This task verifies Tasks 5–6.

- [ ] **Step 1: Write the property test** at `src/engine/budget/invariants.property.test.ts`

```ts
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addMonths, monthRange } from '../dates';
import { computeBudget } from './compute';
import type { ActivityRow, AssignmentRow, BudgetInput, CardTransferRow } from './types';

const START = '2026-01';
const MONTHS = monthRange(START, addMonths(START, 5));
const CASH_ACCOUNTS = ['checking', 'savings'] as const;
const CARDS = ['visa', 'amex'] as const;
const ACCOUNTS = [...CASH_ACCOUNTS, ...CARDS];
const SPENDING = ['groceries', 'rent', 'uncat'] as const;
const isCard = (a: string) => (CARDS as readonly string[]).includes(a);

const lineArb = fc.record({
  month: fc.integer({ min: 0, max: 5 }),
  account: fc.constantFrom(...ACCOUNTS),
  category: fc.constantFrom('rta', ...SPENDING),
  amount: fc.integer({ min: -50_000, max: 50_000 }),
});
const transferArb = fc.record({
  month: fc.integer({ min: 0, max: 5 }),
  from: fc.constantFrom(...ACCOUNTS),
  to: fc.constantFrom(...ACCOUNTS),
  amount: fc.integer({ min: 1, max: 50_000 }),
});
const assignmentArb = fc.record({
  month: fc.integer({ min: 0, max: 5 }),
  category: fc.constantFrom('groceries', 'rent', 'pay-visa', 'pay-amex'),
  amount: fc.integer({ min: -30_000, max: 30_000 }),
});
const ledgerArb = fc.record({
  lines: fc.array(lineArb, { maxLength: 40 }),
  transfers: fc.array(transferArb, { maxLength: 15 }),
  assignments: fc.array(assignmentArb, { maxLength: 20 }),
});

type Ledger = typeof ledgerArb extends fc.Arbitrary<infer T> ? T : never;

function toInput(ledger: Ledger): BudgetInput {
  const activity: ActivityRow[] = ledger.lines.map((l) => ({
    month: MONTHS[l.month]!,
    categoryId: l.category,
    accountId: l.account,
    accountClass: isCard(l.account) ? 'credit' : 'cash',
    amount: l.amount,
  }));
  const cardTransfers: CardTransferRow[] = [];
  for (const t of ledger.transfers) {
    if (t.from === t.to) continue;
    if (isCard(t.from)) cardTransfers.push({ month: MONTHS[t.month]!, cardAccountId: t.from, amount: -t.amount });
    if (isCard(t.to)) cardTransfers.push({ month: MONTHS[t.month]!, cardAccountId: t.to, amount: t.amount });
  }
  const assignments: AssignmentRow[] = ledger.assignments.map((a) => ({
    month: MONTHS[a.month]!,
    categoryId: a.category,
    amount: a.amount,
  }));
  return {
    startMonth: START,
    throughMonth: MONTHS[5]!,
    rtaCategoryId: 'rta',
    categories: [
      { id: 'groceries', kind: 'normal' },
      { id: 'rent', kind: 'normal' },
      { id: 'uncat', kind: 'uncategorized' },
      { id: 'pay-visa', kind: 'cc_payment', linkedAccountId: 'visa' },
      { id: 'pay-amex', kind: 'cc_payment', linkedAccountId: 'amex' },
    ],
    assignments,
    activity,
    cardTransfers,
  };
}

/** Σ balances of cash-class accounts at the end of month index `mi`. */
function cashBalance(ledger: Ledger, mi: number): number {
  let total = 0;
  for (const l of ledger.lines) if (l.month <= mi && !isCard(l.account)) total += l.amount;
  for (const t of ledger.transfers) {
    if (t.month > mi || t.from === t.to) continue;
    if (!isCard(t.from)) total -= t.amount;
    if (!isCard(t.to)) total += t.amount;
  }
  return total;
}

/** Σ RTA-categorized amounts on credit accounts through month index `mi` (K in spec §5.7). */
function cardIncome(ledger: Ledger, mi: number): number {
  return ledger.lines
    .filter((l) => l.month <= mi && isCard(l.account) && l.category === 'rta')
    .reduce((s, l) => s + l.amount, 0);
}

describe('budget invariants (spec §5.7)', () => {
  it('cash balances = Σ Available + leftover + credit overspending − card income', () => {
    fc.assert(
      fc.property(ledgerArb, (ledger) => {
        const result = computeBudget(toInput(ledger));
        MONTHS.forEach((month, mi) => {
          const mb = result.byMonth[month]!;
          const cats = Object.values(mb.categories);
          const available = cats.reduce((s, c) => s + c.available, 0);
          const creditOver = cats.reduce((s, c) => s + c.creditOverspent, 0);
          expect(available + mb.rta.leftover + creditOver - cardIncome(ledger, mi)).toBe(cashBalance(ledger, mi));
        });
      }),
      { numRuns: 500 },
    );
  });

  it('never carries a negative balance', () => {
    fc.assert(
      fc.property(ledgerArb, (ledger) => {
        const result = computeBudget(toInput(ledger));
        for (const month of result.months) {
          for (const c of Object.values(result.byMonth[month]!.categories)) expect(c.carry).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  it('shows RTA as leftover minus everything assigned in later months', () => {
    fc.assert(
      fc.property(ledgerArb, (ledger) => {
        const result = computeBudget(toInput(ledger));
        MONTHS.forEach((month, mi) => {
          const later = ledger.assignments.filter((a) => a.month > mi).reduce((s, a) => s + a.amount, 0);
          const rta = result.byMonth[month]!.rta;
          expect(rta.readyToAssign).toBe(rta.leftover - later);
        });
      }),
    );
  });

  it('splits overspending exactly into cash and credit parts', () => {
    fc.assert(
      fc.property(ledgerArb, (ledger) => {
        const result = computeBudget(toInput(ledger));
        for (const month of result.months) {
          for (const c of Object.values(result.byMonth[month]!.categories)) {
            expect(c.cashOverspent + c.creditOverspent).toBe(Math.max(0, -c.available));
            const byCard = Object.values(c.creditOverByCard).reduce((s, x) => s + x, 0);
            expect(byCard).toBe(c.creditOverspent);
          }
        }
      }),
    );
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/engine/budget/invariants.property.test.ts`
Expected: PASS, `Tests  4 passed (4)`. If it fails, fast-check prints a shrunk counterexample. That means a bug in `compute.ts`: fix the engine, not the test.

- [ ] **Step 3: Prove the test has teeth (temporary mutation)**

In `src/engine/budget/compute.ts`, temporarily change
`addTo(fundedFlow, card, -(byCard.get(card) ?? 0) - over);` to `addTo(fundedFlow, card, -(byCard.get(card) ?? 0));`
Run: `npx vitest run src/engine/budget/invariants.property.test.ts`
Expected: FAIL in `cash balances = Σ Available + leftover + credit overspending − card income`.
Then **revert the change** and run `npx vitest run src/engine/budget`. Expected: `Tests  34 passed (34)`.

- [ ] **Step 4: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`. Expected: exit 0.

```bash
git add src/engine/budget/invariants.property.test.ts
git commit -m "test(engine): property tests for budget invariants" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 8: Loan math

Implements spec §8:
- Interest = |balance at month start| × APR / 12, charged only in months with a payment (an inflow). It can be overridden per month.
- Escrow is taken from the payment before principal.
- Also provides an amortized payment helper (for payoff-by-date targets) and payoff projection.

**Files:**
- Create: `src/engine/loans.ts`
- Test: `src/engine/loans.test.ts`
- Modify: `src/engine/index.ts`

**Interfaces:**
- Consumes: `addMonths` from `./dates`; `ceilDiv`, `parseDecimal`, `roundDiv` from `./money`.
- Produces:
  - `monthlyInterest(balance: Money, apr: string): Money`
  - `amortizedPayment(principal: Money, apr: string, months: number): Money`
  - `computeLoanMonths(params: LoanParams, months: LoanMonthInput[]): LoanMonth[]`, with `LoanParams { apr; escrow; interestOverrides? }`, `LoanMonthInput { month; transactionsTotal; hasPayment }` and `LoanMonth { month; startBalance; transactionsTotal; interest; escrow; endBalance; principalPaid }`
  - `projectPayoff(args: PayoffArgs): Month | 'never'`, with `PayoffArgs { debt; apr; payment; escrow; fromMonth }`

- [ ] **Step 1: Write the failing test** at `src/engine/loans.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { amortizedPayment, computeLoanMonths, monthlyInterest, projectPayoff } from './loans';

describe('monthlyInterest', () => {
  it('is |balance| × APR / 12, rounded half away from zero', () => {
    expect(monthlyInterest(-10_000_000, '6')).toBe(50_000);
    expect(monthlyInterest(10_000_000, '6.0000')).toBe(50_000);
    expect(monthlyInterest(-12_345, '7.5')).toBe(77);
    expect(monthlyInterest(-12_345, '0')).toBe(0);
  });
});

describe('computeLoanMonths', () => {
  const months = [
    { month: '2026-01', transactionsTotal: -10_000_000, hasPayment: false },
    { month: '2026-02', transactionsTotal: 100_000, hasPayment: true },
  ];

  it('golden 9: charges interest only in months with a payment', () => {
    const [jan, feb] = computeLoanMonths({ apr: '6', escrow: 0 }, months);
    expect(jan).toMatchObject({ startBalance: 0, interest: 0, escrow: 0, endBalance: -10_000_000, principalPaid: 0 });
    expect(feb).toMatchObject({ startBalance: -10_000_000, interest: 50_000, endBalance: -9_950_000, principalPaid: 50_000 });
  });

  it('golden 9: takes escrow out of the payment before principal', () => {
    const [, feb] = computeLoanMonths({ apr: '6', escrow: 20_000 }, months);
    expect(feb).toMatchObject({ interest: 50_000, escrow: 20_000, endBalance: -9_970_000, principalPaid: 30_000 });
  });

  it('uses a per-month interest override when present', () => {
    const [, feb] = computeLoanMonths({ apr: '6', escrow: 0, interestOverrides: { '2026-02': 45_000 } }, months);
    expect(feb).toMatchObject({ interest: 45_000, endBalance: -9_945_000 });
  });

  it('carries the balance across months that are omitted', () => {
    const result = computeLoanMonths({ apr: '12', escrow: 0 }, [
      { month: '2026-01', transactionsTotal: -1_000_000, hasPayment: false },
      { month: '2026-05', transactionsTotal: 50_000, hasPayment: true },
    ]);
    expect(result[1]).toMatchObject({ startBalance: -1_000_000, interest: 10_000, endBalance: -960_000 });
  });
});

describe('amortizedPayment', () => {
  it('spreads principal evenly at 0 % APR', () => {
    expect(amortizedPayment(1_200_000, '0', 12)).toBe(100_000);
  });

  it('uses the annuity formula and rounds up', () => {
    expect(amortizedPayment(1_200_000, '12', 12)).toBe(106_619);
  });

  it('is zero when nothing is owed and rejects fewer than one month', () => {
    expect(amortizedPayment(0, '5', 10)).toBe(0);
    expect(() => amortizedPayment(1_000, '5', 0)).toThrow();
  });
});

describe('projectPayoff', () => {
  it('returns the month of the final payment', () => {
    expect(projectPayoff({ debt: -1_200_000, apr: '0', payment: 100_000, escrow: 0, fromMonth: '2026-01' })).toBe('2026-12');
  });

  it('accounts for interest', () => {
    expect(projectPayoff({ debt: -1_200_000, apr: '12', payment: 106_619, escrow: 0, fromMonth: '2026-01' })).toBe('2026-12');
  });

  it('returns "never" when the payment does not cover interest and escrow', () => {
    expect(projectPayoff({ debt: -10_000_000, apr: '6', payment: 50_000, escrow: 0, fromMonth: '2026-01' })).toBe('never');
    expect(projectPayoff({ debt: -10_000_000, apr: '6', payment: 100_000, escrow: 60_000, fromMonth: '2026-01' })).toBe('never');
  });

  it('returns the start month when nothing is owed', () => {
    expect(projectPayoff({ debt: 0, apr: '6', payment: 1, escrow: 0, fromMonth: '2026-01' })).toBe('2026-01');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/engine/loans.test.ts`
Expected: FAIL with `Failed to resolve import "./loans"`.

- [ ] **Step 3: Implement `src/engine/loans.ts`**

```ts
import { addMonths } from './dates';
import { ceilDiv, parseDecimal, roundDiv } from './money';
import type { Money, Month } from './types';

const APR_SCALE = 4;
const MAX_PAYOFF_MONTHS = 1200;

/** Interest for one month: |balance| × APR / 12, rounded half away from zero. `apr` is a percentage, e.g. "6.5". */
export function monthlyInterest(balance: Money, apr: string): Money {
  const scaledApr = parseDecimal(apr, APR_SCALE);
  return Number(roundDiv(BigInt(Math.abs(balance)) * scaledApr, 12n * 100n * 10n ** BigInt(APR_SCALE)));
}

/** Level monthly payment repaying `principal` (≥ 0) over `months` (≥ 1) payments at `apr`, rounded up. */
export function amortizedPayment(principal: Money, apr: string, months: number): Money {
  if (months < 1) throw new Error(`amortizedPayment: months must be ≥ 1, got ${months}`);
  if (principal <= 0) return 0;
  const rate = Number(apr) / 100 / 12;
  if (rate === 0) return ceilDiv(principal, months);
  return Math.ceil((rate * principal) / (1 - (1 + rate) ** -months));
}

export interface LoanParams {
  apr: string;
  escrow: Money;
  interestOverrides?: Record<Month, Money>;
}

export interface LoanMonthInput {
  month: Month;
  /** Σ native amounts of the loan account's transactions in the month (debt is negative). */
  transactionsTotal: Money;
  /** True when the month contains at least one inflow (a payment). */
  hasPayment: boolean;
}

export interface LoanMonth {
  month: Month;
  startBalance: Money;
  transactionsTotal: Money;
  interest: Money;
  escrow: Money;
  endBalance: Money;
  principalPaid: Money;
}

/**
 * Rolls a loan account forward month by month (ascending; months without transactions may be omitted).
 * Interest and escrow are charged only in months with a payment.
 */
export function computeLoanMonths(params: LoanParams, months: LoanMonthInput[]): LoanMonth[] {
  let balance = 0;
  return months.map((m) => {
    const startBalance = balance;
    const interest = m.hasPayment
      ? (params.interestOverrides?.[m.month] ?? monthlyInterest(startBalance, params.apr))
      : 0;
    const escrow = m.hasPayment ? params.escrow : 0;
    const endBalance = startBalance + m.transactionsTotal - interest - escrow;
    balance = endBalance;
    return {
      month: m.month,
      startBalance,
      transactionsTotal: m.transactionsTotal,
      interest,
      escrow,
      endBalance,
      principalPaid: m.hasPayment ? m.transactionsTotal - interest - escrow : 0,
    };
  });
}

export interface PayoffArgs {
  /** Current balance (debt is negative; the sign is ignored). */
  debt: Money;
  apr: string;
  payment: Money;
  escrow: Money;
  /** Month of the first projected payment. */
  fromMonth: Month;
}

/** Month of the final payment when paying `payment` monthly, or "never" if the payment can't outpace interest. */
export function projectPayoff(args: PayoffArgs): Month | 'never' {
  let remaining = Math.abs(args.debt);
  if (remaining === 0) return args.fromMonth;
  for (let i = 0; i < MAX_PAYOFF_MONTHS; i++) {
    const principal = args.payment - args.escrow - monthlyInterest(remaining, args.apr);
    if (principal <= 0) return 'never';
    remaining -= principal;
    if (remaining <= 0) return addMonths(args.fromMonth, i);
  }
  return 'never';
}
```

- [ ] **Step 4: Export from the engine index.** Append to `src/engine/index.ts`:

```ts
export * from './loans';
```

- [ ] **Step 5: Run tests, typecheck and lint**

Run: `npx vitest run src/engine/loans.test.ts && npm run typecheck && npm run lint`
Expected: `Tests  12 passed (12)`, and typecheck and lint exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/engine/loans.ts src/engine/loans.test.ts src/engine/index.ts
git commit -m "feat(engine): loan interest, escrow, amortization and payoff projection" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 9: Targets and pill color

Implements spec §6: spending targets (weekly, monthly, yearly, custom; set_aside or refill), balance targets (with or without a date), debt targets (min_payment, fixed, payoff_by_date), snooze, overfunded flag, progress, and the Available pill color.

**Files:**
- Create: `src/engine/targets.ts`
- Test: `src/engine/targets.test.ts`
- Modify: `src/engine/index.ts`

**Interfaces:**
- Consumes: `addMonths`, `countWeekdayInMonth`, `monthDiff`, `monthOf`, `monthRange` from `./dates`; `amortizedPayment` from `./loans`; `ceilDiv` from `./money`.
- Produces:
  - `TargetDef`: mirrors the `target` table in spec §4.3
  - `TargetContext { month; carry; assigned; available; assignedIn(month); debt? }`
  - `TargetEval { need; underfunded; progress; overfunded; snoozed }`
  - `evaluateTarget(t: TargetDef, ctx: TargetContext): TargetEval | null`: null before `startMonth`
  - `pillColor(cm, target): PillColor`, with `PillColor = 'red' | 'yellow' | 'green' | 'grey'`

- [ ] **Step 1: Write the failing test** at `src/engine/targets.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { evaluateTarget, pillColor, type TargetContext, type TargetDef } from './targets';

function target(partial: Partial<TargetDef>): TargetDef {
  return {
    kind: 'spending',
    cadence: 'monthly',
    amount: 0,
    mode: 'set_aside',
    dueWeekday: null,
    dueDayOfMonth: null,
    dueDate: null,
    repeatUnit: null,
    repeatEvery: null,
    startMonth: '2026-01',
    debtMode: null,
    snoozedMonth: null,
    ...partial,
  };
}

function ctx(partial: Partial<TargetContext>): TargetContext {
  return { month: '2026-01', carry: 0, assigned: 0, available: 0, assignedIn: () => 0, ...partial };
}

describe('spending targets: weekly and monthly', () => {
  it('weekly: need is the amount times the number of matching weekdays', () => {
    const t = target({ cadence: 'weekly', amount: 10_000, dueWeekday: 1 });
    expect(evaluateTarget(t, ctx({ month: '2026-06', assigned: 20_000 }))).toMatchObject({
      need: 50_000,
      underfunded: 30_000,
    });
  });

  it('monthly set aside ignores what carried over', () => {
    const t = target({ amount: 50_000 });
    expect(evaluateTarget(t, ctx({ carry: 40_000, assigned: 20_000 }))).toMatchObject({ need: 50_000, underfunded: 30_000 });
  });

  it('monthly refill counts carried-over money', () => {
    const t = target({ amount: 50_000, mode: 'refill' });
    expect(evaluateTarget(t, ctx({ carry: 40_000, assigned: 0 }))).toMatchObject({ need: 50_000, underfunded: 10_000 });
    expect(evaluateTarget(t, ctx({ carry: 40_000, assigned: 10_000 }))?.underfunded).toBe(0);
  });
});

describe('spending targets: yearly and custom', () => {
  const yearly = target({ cadence: 'yearly', amount: 120_000, dueDate: '2026-12-15' });

  it('golden 10: spreads the amount over the months left until the due month', () => {
    expect(evaluateTarget(yearly, ctx({ month: '2026-01' }))?.need).toBe(10_000);
  });

  it('golden 10: set aside counts this cycle’s earlier assignments', () => {
    const assignedIn = (m: string) => (m === '2026-01' || m === '2026-02' ? 10_000 : 0);
    expect(evaluateTarget(yearly, ctx({ month: '2026-03', carry: 15_000, assignedIn }))?.need).toBe(10_000);
  });

  it('golden 10: refill counts what is available, so spending raises the need', () => {
    const refill = { ...yearly, mode: 'refill' as const };
    expect(evaluateTarget(refill, ctx({ month: '2026-03', carry: 15_000 }))?.need).toBe(10_500);
  });

  it('starts a new cycle after the due month when repeating', () => {
    const assignedIn = () => 10_000;
    expect(evaluateTarget(yearly, ctx({ month: '2027-01', assignedIn }))?.need).toBe(10_000);
  });

  it('custom: repeats every N months', () => {
    const quarterly = target({ cadence: 'custom', amount: 30_000, dueDate: '2026-03-10', repeatUnit: 'month', repeatEvery: 3 });
    expect(evaluateTarget(quarterly, ctx({ month: '2026-04' }))?.need).toBe(10_000);
  });

  it('custom without repeat: everything is due at once when overdue', () => {
    const once = target({ cadence: 'custom', amount: 50_000, dueDate: '2026-03-10', mode: 'refill' });
    expect(evaluateTarget(once, ctx({ month: '2026-05', carry: 30_000 }))?.need).toBe(20_000);
  });
});

describe('balance targets', () => {
  it('without a date: underfunded is the gap to the target balance', () => {
    const t = target({ kind: 'balance', cadence: 'none', amount: 100_000, mode: null });
    expect(evaluateTarget(t, ctx({ carry: 30_000, assigned: 10_000, available: 40_000 }))).toMatchObject({
      need: 70_000,
      underfunded: 60_000,
      progress: 0.4,
    });
  });

  it('by date: spreads the remaining amount over the months left', () => {
    const t = target({ kind: 'balance', cadence: 'none', amount: 120_000, mode: null, dueDate: '2026-12-31' });
    expect(evaluateTarget(t, ctx({ month: '2026-01' }))?.need).toBe(10_000);
  });
});

describe('debt targets', () => {
  const debt = { minPayment: 20_000, apr: '12', balanceAtMonthStart: -1_200_000 };

  it('minimum payment', () => {
    const t = target({ kind: 'debt', cadence: 'none', mode: null, debtMode: 'min_payment' });
    expect(evaluateTarget(t, ctx({ assigned: 5_000, debt }))).toMatchObject({ need: 20_000, underfunded: 15_000 });
  });

  it('fixed amount', () => {
    const t = target({ kind: 'debt', cadence: 'none', mode: null, debtMode: 'fixed', amount: 30_000 });
    expect(evaluateTarget(t, ctx({ debt }))?.need).toBe(30_000);
  });

  it('pay off by date uses an amortized payment', () => {
    const t = target({ kind: 'debt', cadence: 'none', mode: null, debtMode: 'payoff_by_date', dueDate: '2026-12-01' });
    expect(evaluateTarget(t, ctx({ debt }))?.need).toBe(106_619);
  });

  it('requires debt context', () => {
    const t = target({ kind: 'debt', cadence: 'none', mode: null, debtMode: 'min_payment' });
    expect(() => evaluateTarget(t, ctx({}))).toThrow('debt');
  });
});

describe('snooze, overfunding and inactive months', () => {
  it('snoozed targets are never underfunded', () => {
    const t = target({ amount: 50_000, snoozedMonth: '2026-01' });
    expect(evaluateTarget(t, ctx({}))).toMatchObject({ underfunded: 0, snoozed: true, progress: 0 });
  });

  it('flags assigning more than needed as overfunded', () => {
    expect(evaluateTarget(target({ amount: 50_000 }), ctx({ assigned: 60_000 }))?.overfunded).toBe(true);
  });

  it('returns null before the target start month', () => {
    expect(evaluateTarget(target({ startMonth: '2026-05' }), ctx({ month: '2026-04' }))).toBeNull();
  });
});

describe('pillColor', () => {
  const cm = { available: 0, cashOverspent: 0, creditOverspent: 0 };
  const met = { need: 100, underfunded: 0, progress: 1, overfunded: false, snoozed: false };

  it('is red for cash overspending, yellow for credit overspending or underfunded', () => {
    expect(pillColor({ ...cm, available: -5, cashOverspent: 3, creditOverspent: 2 }, null)).toBe('red');
    expect(pillColor({ ...cm, available: -5, creditOverspent: 5 }, null)).toBe('yellow');
    expect(pillColor({ ...cm, available: 50 }, { ...met, underfunded: 50 })).toBe('yellow');
  });

  it('is green with money available or a met target, grey otherwise', () => {
    expect(pillColor({ ...cm, available: 1 }, null)).toBe('green');
    expect(pillColor(cm, met)).toBe('green');
    expect(pillColor(cm, null)).toBe('grey');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/engine/targets.test.ts`
Expected: FAIL with `Failed to resolve import "./targets"`.

- [ ] **Step 3: Implement `src/engine/targets.ts`**

```ts
import { addMonths, countWeekdayInMonth, monthDiff, monthOf, monthRange } from './dates';
import { amortizedPayment } from './loans';
import { ceilDiv } from './money';
import type { IsoDate, Money, Month } from './types';

export interface TargetDef {
  kind: 'spending' | 'balance' | 'debt';
  cadence: 'weekly' | 'monthly' | 'yearly' | 'custom' | 'none';
  amount: Money;
  /** Spending targets: "set aside another X" or "refill up to X". */
  mode: 'set_aside' | 'refill' | null;
  /** 0 = Sunday … 6 = Saturday. */
  dueWeekday: number | null;
  /** Display only; null = last day of month. */
  dueDayOfMonth: number | null;
  dueDate: IsoDate | null;
  repeatUnit: 'month' | 'year' | null;
  repeatEvery: number | null;
  startMonth: Month;
  debtMode: 'min_payment' | 'fixed' | 'payoff_by_date' | null;
  snoozedMonth: Month | null;
}

export interface TargetContext {
  month: Month;
  carry: Money;
  assigned: Money;
  available: Money;
  /** Assigned amount of this category in another month (used for set-aside cycles). */
  assignedIn: (month: Month) => Money;
  /** Linked credit/loan account data; required for debt targets. */
  debt?: { minPayment: Money; apr: string; balanceAtMonthStart: Money };
}

export interface TargetEval {
  need: Money;
  underfunded: Money;
  /** 0..1 */
  progress: number;
  overfunded: boolean;
  snoozed: boolean;
}

export type PillColor = 'red' | 'yellow' | 'green' | 'grey';

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Months from `month` to `dueMonth` inclusive, at least 1 (overdue targets are due now). */
function monthsLeft(month: Month, dueMonth: Month): number {
  return Math.max(1, monthDiff(month, dueMonth) + 1);
}

function requireDueDate(t: TargetDef): IsoDate {
  if (!t.dueDate) throw new Error(`A ${t.kind}/${t.cadence} target needs a due date`);
  return t.dueDate;
}

/** The due month that applies to `month` and the first month of its funding cycle. */
function dueCycle(t: TargetDef, month: Month): { dueMonth: Month; cycleStart: Month } {
  const firstDue = monthOf(requireDueDate(t));
  const step =
    t.cadence === 'yearly' ? 12 : t.repeatUnit ? (t.repeatEvery ?? 1) * (t.repeatUnit === 'year' ? 12 : 1) : null;
  if (step === null) return { dueMonth: firstDue, cycleStart: t.startMonth };
  let dueMonth = firstDue;
  let previousDue: Month | null = null;
  while (dueMonth < month) {
    previousDue = dueMonth;
    dueMonth = addMonths(dueMonth, step);
  }
  const afterPrevious = previousDue ? addMonths(previousDue, 1) : t.startMonth;
  return { dueMonth, cycleStart: afterPrevious > t.startMonth ? afterPrevious : t.startMonth };
}

function computeNeed(t: TargetDef, ctx: TargetContext): Money {
  if (t.kind === 'spending') {
    if (t.cadence === 'weekly') return t.amount * countWeekdayInMonth(ctx.month, t.dueWeekday ?? 0);
    if (t.cadence === 'monthly') return t.amount;
    const { dueMonth, cycleStart } = dueCycle(t, ctx.month);
    const fundedBefore =
      t.mode === 'refill'
        ? ctx.carry
        : monthRange(cycleStart, addMonths(ctx.month, -1)).reduce((s, m) => s + ctx.assignedIn(m), 0);
    return ceilDiv(Math.max(0, t.amount - fundedBefore), monthsLeft(ctx.month, dueMonth));
  }
  if (t.kind === 'balance') {
    const remaining = Math.max(0, t.amount - ctx.carry);
    return t.dueDate ? ceilDiv(remaining, monthsLeft(ctx.month, monthOf(t.dueDate))) : remaining;
  }
  if (!ctx.debt) throw new Error('Debt targets need debt context (linked account data)');
  if (t.debtMode === 'min_payment') return ctx.debt.minPayment;
  if (t.debtMode === 'fixed') return t.amount;
  return amortizedPayment(
    Math.abs(ctx.debt.balanceAtMonthStart),
    ctx.debt.apr,
    monthsLeft(ctx.month, monthOf(requireDueDate(t))),
  );
}

/** Evaluates a category's target for `ctx.month`; null when the target hasn't started yet. */
export function evaluateTarget(t: TargetDef, ctx: TargetContext): TargetEval | null {
  if (ctx.month < t.startMonth) return null;
  const need = computeNeed(t, ctx);
  let underfunded: Money;
  if (t.kind === 'balance' && !t.dueDate) {
    underfunded = Math.max(0, t.amount - ctx.available);
  } else if (t.kind === 'spending' && t.mode === 'refill' && (t.cadence === 'weekly' || t.cadence === 'monthly')) {
    underfunded = Math.max(0, need - ctx.carry - ctx.assigned);
  } else {
    underfunded = Math.max(0, need - ctx.assigned);
  }
  const progress =
    t.kind === 'balance'
      ? t.amount === 0
        ? 1
        : clamp01(ctx.available / t.amount)
      : need === 0
        ? 1
        : clamp01((need - underfunded) / need);
  const snoozed = t.snoozedMonth === ctx.month;
  return {
    need,
    underfunded: snoozed ? 0 : underfunded,
    progress,
    overfunded: ctx.assigned > need,
    snoozed,
  };
}

/** Color of a category's Available pill (spec §6). */
export function pillColor(
  cm: { available: Money; cashOverspent: Money; creditOverspent: Money },
  target: TargetEval | null,
): PillColor {
  if (cm.cashOverspent > 0) return 'red';
  if (cm.creditOverspent > 0 || (target !== null && target.underfunded > 0)) return 'yellow';
  const targetMet = target !== null && !target.snoozed && target.need > 0 && target.underfunded === 0;
  if (cm.available > 0 || targetMet) return 'green';
  return 'grey';
}
```

- [ ] **Step 4: Export from the engine index.** Append to `src/engine/index.ts`:

```ts
export * from './targets';
```

- [ ] **Step 5: Run tests, typecheck and lint**

Run: `npx vitest run src/engine/targets.test.ts && npm run typecheck && npm run lint`
Expected: `Tests  20 passed (20)`, and typecheck and lint exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/engine/targets.ts src/engine/targets.test.ts src/engine/index.ts
git commit -m "feat(engine): category targets and pill color" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 10: Auto-assign

Implements spec §7: underfunded (fills in display order, capped by RTA), assigned last month, spent last month, average assigned, average spent (previous ≤ 12 months that exist), reset available, reset assigned. Returns only the categories that change. The server will apply them as one undoable command.

**Files:**
- Create: `src/engine/autoAssign.ts`
- Test: `src/engine/autoAssign.test.ts`
- Modify: `src/engine/index.ts`

**Interfaces:**
- Consumes: `BudgetResult`, `CategoryMonth` from `./budget/types`; `computeBudget` and the test helpers (tests only); `addMonths`; `roundDiv`.
- Produces:
  - `AutoAssignStrategy` (union of the 7 strategy names)
  - `AutoAssignArgs { strategy; month; categoryIds; budget; underfunded? }`
  - `AssignmentChange { categoryId; from; to }`
  - `autoAssign(args: AutoAssignArgs): AssignmentChange[]`

- [ ] **Step 1: Write the failing test** at `src/engine/autoAssign.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { autoAssign } from './autoAssign';
import { computeBudget } from './budget/compute';
import { RTA, assign, budgetInput, cashLine, category } from './budget/test-helpers';

// Jan: assigned groceries 30 000 / rent 100 000, spent groceries 25 000 / rent 100 000.
// Feb: assigned groceries 50 000 / rent 100 000, spent groceries 45 000 / rent 100 000.
// Mar: assigned groceries 10 000, spent groceries 4 000. Income 500 000 in Jan.
const budget = computeBudget(
  budgetInput({
    throughMonth: '2026-03',
    categories: [category('groceries'), category('rent'), category('fun')],
    activity: [
      cashLine('2026-01', RTA, 500_000),
      cashLine('2026-01', 'groceries', -25_000),
      cashLine('2026-01', 'rent', -100_000),
      cashLine('2026-02', 'groceries', -45_000),
      cashLine('2026-02', 'rent', -100_000),
      cashLine('2026-03', 'groceries', -4_000),
    ],
    assignments: [
      assign('2026-01', 'groceries', 30_000),
      assign('2026-01', 'rent', 100_000),
      assign('2026-02', 'groceries', 50_000),
      assign('2026-02', 'rent', 100_000),
      assign('2026-03', 'groceries', 10_000),
    ],
  }),
);
// RTA in March = 500 000 − 290 000 = 210 000
const all = ['groceries', 'rent', 'fun'];

describe('autoAssign', () => {
  it('underfunded: fills in display order and stops when RTA runs out', () => {
    const changes = autoAssign({
      strategy: 'underfunded',
      month: '2026-03',
      categoryIds: all,
      budget,
      underfunded: { groceries: 40_000, rent: 100_000, fun: 200_000 },
    });
    expect(changes).toEqual([
      { categoryId: 'groceries', from: 10_000, to: 50_000 },
      { categoryId: 'rent', from: 0, to: 100_000 },
      { categoryId: 'fun', from: 0, to: 70_000 },
    ]);
  });

  it('underfunded: does nothing when RTA is not positive', () => {
    const broke = computeBudget(budgetInput({ categories: [category('fun')] }));
    expect(
      autoAssign({ strategy: 'underfunded', month: '2026-01', categoryIds: ['fun'], budget: broke, underfunded: { fun: 5 } }),
    ).toEqual([]);
  });

  it('assigned last month', () => {
    expect(autoAssign({ strategy: 'assigned_last_month', month: '2026-03', categoryIds: all, budget })).toEqual([
      { categoryId: 'groceries', from: 10_000, to: 50_000 },
      { categoryId: 'rent', from: 0, to: 100_000 },
    ]);
  });

  it('spent last month', () => {
    expect(autoAssign({ strategy: 'spent_last_month', month: '2026-03', categoryIds: ['groceries'], budget })).toEqual([
      { categoryId: 'groceries', from: 10_000, to: 45_000 },
    ]);
  });

  it('average assigned and average spent use the previous months since budget start', () => {
    expect(autoAssign({ strategy: 'average_assigned', month: '2026-03', categoryIds: ['groceries'], budget })).toEqual([
      { categoryId: 'groceries', from: 10_000, to: 40_000 },
    ]);
    expect(autoAssign({ strategy: 'average_spent', month: '2026-03', categoryIds: ['groceries'], budget })).toEqual([
      { categoryId: 'groceries', from: 10_000, to: 35_000 },
    ]);
  });

  it('reset available brings Available to zero; reset assigned clears the assignment', () => {
    // groceries March: carry 10 000 + assigned 10 000 − spent 4 000 = 16 000 available
    expect(autoAssign({ strategy: 'reset_available', month: '2026-03', categoryIds: ['groceries'], budget })).toEqual([
      { categoryId: 'groceries', from: 10_000, to: -6_000 },
    ]);
    expect(autoAssign({ strategy: 'reset_assigned', month: '2026-03', categoryIds: ['groceries'], budget })).toEqual([
      { categoryId: 'groceries', from: 10_000, to: 0 },
    ]);
  });

  it('treats months before the budget start as empty', () => {
    expect(autoAssign({ strategy: 'assigned_last_month', month: '2026-01', categoryIds: ['groceries'], budget })).toEqual([
      { categoryId: 'groceries', from: 30_000, to: 0 },
    ]);
  });

  it('requires underfunded amounts for the underfunded strategy', () => {
    expect(() => autoAssign({ strategy: 'underfunded', month: '2026-03', categoryIds: all, budget })).toThrow('underfunded');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/engine/autoAssign.test.ts`
Expected: FAIL with `Failed to resolve import "./autoAssign"`.

- [ ] **Step 3: Implement `src/engine/autoAssign.ts`**

```ts
import type { BudgetResult, CategoryMonth } from './budget/types';
import { addMonths } from './dates';
import { roundDiv } from './money';
import type { Money, Month } from './types';

export type AutoAssignStrategy =
  | 'underfunded'
  | 'assigned_last_month'
  | 'spent_last_month'
  | 'average_assigned'
  | 'average_spent'
  | 'reset_available'
  | 'reset_assigned';

export interface AutoAssignArgs {
  strategy: AutoAssignStrategy;
  month: Month;
  /** Categories in scope, in display order. */
  categoryIds: string[];
  budget: BudgetResult;
  /** Underfunded amount per category for `month` (required for the "underfunded" strategy). */
  underfunded?: Record<string, Money>;
}

export interface AssignmentChange {
  categoryId: string;
  from: Money;
  to: Money;
}

const AVERAGE_WINDOW = 12;

function cell(budget: BudgetResult, month: Month, categoryId: string): Pick<CategoryMonth, 'assigned' | 'activity' | 'available'> {
  return budget.byMonth[month]?.categories[categoryId] ?? { assigned: 0, activity: 0, available: 0 };
}

/** Up to 12 months before `month` that exist in the computed budget. */
function previousMonths(budget: BudgetResult, month: Month): Month[] {
  const result: Month[] = [];
  for (let i = 1; i <= AVERAGE_WINDOW; i++) {
    const m = addMonths(month, -i);
    if (budget.byMonth[m]) result.push(m);
  }
  return result;
}

function average(values: Money[]): Money {
  if (values.length === 0) return 0;
  return Number(roundDiv(BigInt(values.reduce((s, v) => s + v, 0)), BigInt(values.length)));
}

/** Computes new assigned amounts for `month`; returns only categories whose amount changes. */
export function autoAssign(args: AutoAssignArgs): AssignmentChange[] {
  const { budget, month, strategy } = args;
  const last = addMonths(month, -1);
  const history = previousMonths(budget, month);
  let remaining = budget.byMonth[month]?.rta.readyToAssign ?? 0;
  if (strategy === 'underfunded' && !args.underfunded) throw new Error('The underfunded strategy needs underfunded amounts');

  const changes: AssignmentChange[] = [];
  for (const categoryId of args.categoryIds) {
    const current = cell(budget, month, categoryId);
    let to: Money;
    switch (strategy) {
      case 'underfunded': {
        const amount = Math.min(args.underfunded?.[categoryId] ?? 0, Math.max(0, remaining));
        remaining -= amount;
        to = current.assigned + amount;
        break;
      }
      case 'assigned_last_month':
        to = cell(budget, last, categoryId).assigned;
        break;
      case 'spent_last_month':
        to = Math.max(0, -cell(budget, last, categoryId).activity);
        break;
      case 'average_assigned':
        to = average(history.map((m) => cell(budget, m, categoryId).assigned));
        break;
      case 'average_spent':
        to = Math.max(0, -average(history.map((m) => cell(budget, m, categoryId).activity)));
        break;
      case 'reset_available':
        to = current.assigned - current.available;
        break;
      case 'reset_assigned':
        to = 0;
        break;
    }
    if (to !== current.assigned) changes.push({ categoryId, from: current.assigned, to });
  }
  return changes;
}
```

- [ ] **Step 4: Export from the engine index.** Append to `src/engine/index.ts`:

```ts
export * from './autoAssign';
```

- [ ] **Step 5: Run tests, typecheck and lint**

Run: `npx vitest run src/engine/autoAssign.test.ts && npm run typecheck && npm run lint`
Expected: `Tests  8 passed (8)`, and typecheck and lint exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/engine/autoAssign.ts src/engine/autoAssign.test.ts src/engine/index.ts
git commit -m "feat(engine): auto-assign strategies" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 11: Scheduled-transaction dates

Implements the date logic of spec §10 (scheduled transactions) for YNAB's 13 frequencies:
- Day-based frequencies step from the anchor.
- Month-based frequencies keep the anchor day and clamp it to the month end.
- `twice_a_month` uses the anchor day and the day 15 away from it.
- `dueOccurrences` drives the daily job's catch-up (P2).

**Files:**
- Create: `src/engine/schedule.ts`
- Test: `src/engine/schedule.test.ts`
- Modify: `src/engine/index.ts`

**Interfaces:**
- Consumes: `addDays`, `addMonths`, `dateInMonth`, `diffDays`, `monthDiff`, `monthOf` from `./dates`.
- Produces:
  - `Frequency` (union of the 13 names in spec §4.4)
  - `nextOccurrence(freq, anchor, after): IsoDate | null`
  - `dueOccurrences(freq, anchor, nextDate, today, limit = 1000): { dates: IsoDate[]; nextDate: IsoDate | null }`

- [ ] **Step 1: Write the failing test** at `src/engine/schedule.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { dueOccurrences, nextOccurrence } from './schedule';

describe('nextOccurrence: day-based frequencies', () => {
  it('steps by a fixed number of days from the anchor', () => {
    expect(nextOccurrence('daily', '2026-01-30', '2026-01-31')).toBe('2026-02-01');
    expect(nextOccurrence('weekly', '2026-01-05', '2026-01-05')).toBe('2026-01-12');
    expect(nextOccurrence('weekly', '2026-01-05', '2026-01-08')).toBe('2026-01-12');
    expect(nextOccurrence('every_other_week', '2026-01-05', '2026-01-05')).toBe('2026-01-19');
    expect(nextOccurrence('every_4_weeks', '2026-01-05', '2026-01-05')).toBe('2026-02-02');
  });

  it('returns the anchor while it is still ahead', () => {
    expect(nextOccurrence('weekly', '2026-03-01', '2026-01-01')).toBe('2026-03-01');
    expect(nextOccurrence('monthly', '2026-03-01', '2026-01-01')).toBe('2026-03-01');
  });
});

describe('nextOccurrence: month-based frequencies', () => {
  it('keeps the anchor day and clamps to month end', () => {
    expect(nextOccurrence('monthly', '2026-01-31', '2026-01-31')).toBe('2026-02-28');
    expect(nextOccurrence('monthly', '2026-01-31', '2026-02-28')).toBe('2026-03-31');
  });

  it('supports multi-month steps', () => {
    expect(nextOccurrence('every_other_month', '2026-01-15', '2026-01-15')).toBe('2026-03-15');
    expect(nextOccurrence('every_3_months', '2026-01-15', '2026-01-15')).toBe('2026-04-15');
    expect(nextOccurrence('every_4_months', '2026-01-15', '2026-02-01')).toBe('2026-05-15');
    expect(nextOccurrence('twice_a_year', '2026-01-15', '2026-01-15')).toBe('2026-07-15');
    expect(nextOccurrence('yearly', '2024-02-29', '2024-02-29')).toBe('2025-02-28');
    expect(nextOccurrence('yearly', '2024-02-29', '2027-03-01')).toBe('2028-02-29');
    expect(nextOccurrence('every_other_year', '2026-06-01', '2026-06-01')).toBe('2028-06-01');
  });

  it('twice a month: anchor day and 15 days later (or earlier when past the 15th)', () => {
    expect(nextOccurrence('twice_a_month', '2026-01-10', '2026-01-10')).toBe('2026-01-25');
    expect(nextOccurrence('twice_a_month', '2026-01-10', '2026-01-25')).toBe('2026-02-10');
    expect(nextOccurrence('twice_a_month', '2026-01-20', '2026-01-20')).toBe('2026-02-05');
    expect(nextOccurrence('twice_a_month', '2026-01-15', '2026-02-15')).toBe('2026-02-28');
  });

  it('once: only the anchor', () => {
    expect(nextOccurrence('once', '2026-01-10', '2026-01-09')).toBe('2026-01-10');
    expect(nextOccurrence('once', '2026-01-10', '2026-01-10')).toBeNull();
  });
});

describe('dueOccurrences', () => {
  it('collects every occurrence up to today and returns the next one', () => {
    expect(dueOccurrences('monthly', '2026-01-01', '2026-01-01', '2026-03-15')).toEqual({
      dates: ['2026-01-01', '2026-02-01', '2026-03-01'],
      nextDate: '2026-04-01',
    });
  });

  it('returns nothing when the next date is in the future', () => {
    expect(dueOccurrences('weekly', '2026-01-05', '2026-01-12', '2026-01-11')).toEqual({ dates: [], nextDate: '2026-01-12' });
  });

  it('ends a one-off schedule after it is entered', () => {
    expect(dueOccurrences('once', '2026-01-10', '2026-01-10', '2026-01-10')).toEqual({ dates: ['2026-01-10'], nextDate: null });
  });

  it('caps the number of occurrences', () => {
    expect(dueOccurrences('daily', '2020-01-01', '2020-01-01', '2026-01-01', 3).dates).toHaveLength(3);
  });

  it('is monotonic: every returned date is after the previous one', () => {
    const { dates } = dueOccurrences('twice_a_month', '2026-01-31', '2026-01-31', '2026-12-31');
    for (let i = 1; i < dates.length; i++) expect(dates[i]! > dates[i - 1]!).toBe(true);
    expect(dates).toContain('2026-02-28');
    expect(dates).toContain('2026-02-16');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/engine/schedule.test.ts`
Expected: FAIL with `Failed to resolve import "./schedule"`.

- [ ] **Step 3: Implement `src/engine/schedule.ts`**

```ts
import { addDays, addMonths, dateInMonth, diffDays, monthDiff, monthOf } from './dates';
import type { IsoDate } from './types';

export type Frequency =
  | 'once'
  | 'daily'
  | 'weekly'
  | 'every_other_week'
  | 'twice_a_month'
  | 'every_4_weeks'
  | 'monthly'
  | 'every_other_month'
  | 'every_3_months'
  | 'every_4_months'
  | 'twice_a_year'
  | 'yearly'
  | 'every_other_year';

const DAY_STEPS: Partial<Record<Frequency, number>> = {
  daily: 1,
  weekly: 7,
  every_other_week: 14,
  every_4_weeks: 28,
};

const MONTH_STEPS: Partial<Record<Frequency, number>> = {
  monthly: 1,
  every_other_month: 2,
  every_3_months: 3,
  every_4_months: 4,
  twice_a_year: 6,
  yearly: 12,
  every_other_year: 24,
};

const anchorDay = (anchor: IsoDate) => Number(anchor.slice(8, 10));

/** First occurrence strictly after `after` for a schedule anchored at `anchor`; null when there is none. */
export function nextOccurrence(freq: Frequency, anchor: IsoDate, after: IsoDate): IsoDate | null {
  if (after < anchor) return anchor;
  if (freq === 'once') return null;

  const dayStep = DAY_STEPS[freq];
  if (dayStep) return addDays(anchor, (Math.floor(diffDays(anchor, after) / dayStep) + 1) * dayStep);

  const day = anchorDay(anchor);
  const monthStep = MONTH_STEPS[freq];
  if (monthStep) {
    const anchorMonth = monthOf(anchor);
    let k = Math.max(0, Math.floor(monthDiff(anchorMonth, monthOf(after)) / monthStep));
    let candidate = dateInMonth(addMonths(anchorMonth, k * monthStep), day);
    while (candidate <= after) {
      k += 1;
      candidate = dateInMonth(addMonths(anchorMonth, k * monthStep), day);
    }
    return candidate;
  }

  // twice_a_month: the anchor day plus the day 15 days away within the month, both clamped to month end.
  const days = day <= 15 ? [day, day + 15] : [day - 15, day];
  for (let month = monthOf(after); ; month = addMonths(month, 1)) {
    for (const d of days) {
      const candidate = dateInMonth(month, d);
      if (candidate > after) return candidate;
    }
  }
}

/** All occurrences from `nextDate` up to and including `today`, plus the schedule's new next date. */
export function dueOccurrences(
  freq: Frequency,
  anchor: IsoDate,
  nextDate: IsoDate,
  today: IsoDate,
  limit = 1000,
): { dates: IsoDate[]; nextDate: IsoDate | null } {
  const dates: IsoDate[] = [];
  let next: IsoDate | null = nextDate;
  while (next !== null && next <= today && dates.length < limit) {
    dates.push(next);
    next = nextOccurrence(freq, anchor, next);
  }
  return { dates, nextDate: next };
}
```

- [ ] **Step 4: Export from the engine index.** Append to `src/engine/index.ts`:

```ts
export * from './schedule';
```

- [ ] **Step 5: Run tests, typecheck and lint**

Run: `npx vitest run src/engine/schedule.test.ts && npm run typecheck && npm run lint`
Expected: `Tests  11 passed (11)`, and typecheck and lint exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/engine/schedule.ts src/engine/schedule.test.ts src/engine/index.ts
git commit -m "feat(engine): scheduled transaction occurrence dates" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 12: FX helpers and final engine verification

Implements the pure parts of spec §9:
- native → PLN conversion
- split-line base amounts that always sum to the parent
- transfer base amounts that net to zero
- effective rate display
- revaluation difference

Fetching NBP rates is I/O and belongs to P2.

**Files:**
- Create: `src/engine/fx.ts`
- Test: `src/engine/fx.test.ts`
- Modify: `src/engine/index.ts`

**Interfaces:**
- Consumes: `parseDecimal`, `roundDiv` from `./money`.
- Produces:
  - `convertToBase(amount: Money, rate: string): Money`
  - `splitLineBases(parentBase: Money, lineAmounts: Money[], rate: string): Money[]`
  - `transferBases(baseCurrency: string, from: TransferSide, to: TransferSide): { fromBase; toBase }`, with `TransferSide { amount; currency; rate: string | null }`
  - `effectiveRate(nativeAmount: Money, baseAmount: Money): string | null`
  - `revaluationDiff(nativeBalance: Money, latestRate: string, bookedBase: Money): Money`

- [ ] **Step 1: Write the failing test** at `src/engine/fx.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { convertToBase, effectiveRate, revaluationDiff, splitLineBases, transferBases } from './fx';

describe('convertToBase', () => {
  it('multiplies by the rate and rounds half away from zero', () => {
    expect(convertToBase(10_000, '4.2512')).toBe(42_512);
    expect(convertToBase(-333, '4.3215')).toBe(-1_439);
    expect(convertToBase(1, '0.5')).toBe(1);
    expect(convertToBase(-1, '0.5')).toBe(-1);
  });
});

describe('splitLineBases', () => {
  it('gives the rounding remainder to the last line', () => {
    expect(splitLineBases(333, [500, 500], '0.333333')).toEqual([167, 166]);
  });

  it('always sums to the parent base amount', () => {
    const lines = splitLineBases(4_333, [333, 333, 334], '4.33333');
    expect(lines.reduce((s, x) => s + x, 0)).toBe(4_333);
  });

  it('handles no lines', () => {
    expect(splitLineBases(0, [], '4')).toEqual([]);
  });
});

describe('transferBases', () => {
  it('golden 11: PLN → EUR uses the PLN amount on both sides so the budget nets to zero', () => {
    expect(
      transferBases('PLN', { amount: -40_000, currency: 'PLN', rate: null }, { amount: 9_300, currency: 'EUR', rate: '4.25' }),
    ).toEqual({ fromBase: -40_000, toBase: 40_000 });
  });

  it('EUR → PLN uses the PLN side', () => {
    expect(
      transferBases('PLN', { amount: -9_300, currency: 'EUR', rate: '4.25' }, { amount: 40_000, currency: 'PLN', rate: null }),
    ).toEqual({ fromBase: -40_000, toBase: 40_000 });
  });

  it('foreign → foreign converts the source side', () => {
    expect(
      transferBases('PLN', { amount: -10_000, currency: 'EUR', rate: '4.3' }, { amount: 11_500, currency: 'USD', rate: '3.9' }),
    ).toEqual({ fromBase: -43_000, toBase: 43_000 });
  });

  it('requires a rate for a foreign source', () => {
    expect(() =>
      transferBases('PLN', { amount: -1, currency: 'EUR', rate: null }, { amount: 1, currency: 'USD', rate: null }),
    ).toThrow('rate');
  });
});

describe('effectiveRate and revaluationDiff', () => {
  it('formats the implied rate with 6 decimals', () => {
    expect(effectiveRate(9_300, -40_000)).toBe('4.301075');
    expect(effectiveRate(0, 100)).toBeNull();
  });

  it('golden 11: revaluation is today’s value minus the booked base amounts', () => {
    expect(revaluationDiff(100_000, '4.30', 425_000)).toBe(5_000);
    expect(revaluationDiff(100_000, '4.20', 425_000)).toBe(-5_000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/engine/fx.test.ts`
Expected: FAIL with `Failed to resolve import "./fx"`.

- [ ] **Step 3: Implement `src/engine/fx.ts`**

```ts
import { parseDecimal, roundDiv } from './money';
import type { Money } from './types';

const RATE_SCALE = 6;
const RATE_FACTOR = 10n ** BigInt(RATE_SCALE);

/** Native amount → base currency: round(amount × rate), half away from zero. */
export function convertToBase(amount: Money, rate: string): Money {
  return Number(roundDiv(BigInt(amount) * parseDecimal(rate, RATE_SCALE), RATE_FACTOR));
}

/** Base amounts for split lines using the parent's rate; the last line absorbs rounding so the sum is `parentBase`. */
export function splitLineBases(parentBase: Money, lineAmounts: Money[], rate: string): Money[] {
  if (lineAmounts.length === 0) return [];
  const bases = lineAmounts.map((a) => convertToBase(a, rate));
  const diff = parentBase - bases.reduce((s, x) => s + x, 0);
  bases[bases.length - 1] = (bases[bases.length - 1] ?? 0) + diff;
  return bases;
}

export interface TransferSide {
  /** Native amount (source side negative, destination side positive). */
  amount: Money;
  currency: string;
  /** Required when this side's currency is not the base currency and its base amount must be converted. */
  rate: string | null;
}

/** Base amounts for both sides of a transfer; they always net to zero (spec §9). */
export function transferBases(
  baseCurrency: string,
  from: TransferSide,
  to: TransferSide,
): { fromBase: Money; toBase: Money } {
  if (from.currency === baseCurrency) return { fromBase: from.amount, toBase: -from.amount };
  if (to.currency === baseCurrency) return { fromBase: -to.amount, toBase: to.amount };
  if (!from.rate) throw new Error(`A rate is required for the ${from.currency} side of the transfer`);
  const fromBase = convertToBase(from.amount, from.rate);
  return { fromBase, toBase: -fromBase };
}

/** |base| / |native| with 6 decimals, or null when the native amount is zero. */
export function effectiveRate(nativeAmount: Money, baseAmount: Money): string | null {
  if (nativeAmount === 0) return null;
  const scaled = roundDiv(BigInt(Math.abs(baseAmount)) * RATE_FACTOR, BigInt(Math.abs(nativeAmount)));
  const int = scaled / RATE_FACTOR;
  const frac = (scaled % RATE_FACTOR).toString().padStart(RATE_SCALE, '0');
  return `${int}.${frac}`;
}

/** Unrealized FX difference: native balance at today's rate minus the base amounts already booked. */
export function revaluationDiff(nativeBalance: Money, latestRate: string, bookedBase: Money): Money {
  return convertToBase(nativeBalance, latestRate) - bookedBase;
}
```

- [ ] **Step 4: Export from the engine index.** Append to `src/engine/index.ts`:

```ts
export * from './fx';
```

After this step `src/engine/index.ts` must read exactly:

```ts
export type { IsoDate, Money, Month } from './types';
export * from './money';
export * from './dates';
export { splitOverspending, type OverspendingSplit } from './budget/overspending';
export * from './budget/types';
export { computeBudget, cardPaymentShortfall } from './budget/compute';
export * from './loans';
export * from './targets';
export * from './autoAssign';
export * from './schedule';
export * from './fx';
```

- [ ] **Step 5: Run the full verification**

Run: `npm test && npm run typecheck && npm run lint`
Expected: `Test Files  11 passed (11)`, `Tests  118 passed (118)`, and typecheck and lint exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/engine/fx.ts src/engine/fx.test.ts src/engine/index.ts
git commit -m "feat(engine): FX conversion, split and transfer base amounts, revaluation" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Spec coverage (P1)

| Spec section | Task |
|---|---|
| §2 conventions (money, rounding, dates, sign) | 1, 2, 3 |
| §5.1 Activity / Available / Carry, range widening | 5 |
| §5.2 cash vs credit overspending | 4, 5, 6 |
| §5.3 credit card payment categories, "Need X to pay in full" | 6 |
| §5.4 Ready to Assign incl. future-month assignments | 5 |
| §5.7 invariant | 7 |
| §6 targets, snooze, overfunded, pill color | 9 |
| §7 auto-assign | 10 |
| §8 loan interest, escrow, amortization, payoff | 8 |
| §9 FX math (conversion, splits, transfers, revaluation) | 12 |
| §10 scheduled-transaction dates | 11 |
| §14 engine golden scenarios 1–11 + property tests | 5, 6, 7, 8, 9, 12 |
