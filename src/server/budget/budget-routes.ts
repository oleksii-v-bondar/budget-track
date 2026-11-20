import { Hono } from 'hono';
import {
  type AssignmentDto,
  assignmentParamSchema,
  type AutoAssignResponse,
  autoAssignRequestSchema,
  type BudgetMonthDto,
  type MonthNoteDto,
  monthNoteRequestSchema,
  monthParamSchema,
  type MoveMoneyResponse,
  moveMoneyRequestSchema,
  setAssignmentRequestSchema,
} from '../../shared/api/budget';
import { type AuthedEnv, requireSession } from '../auth/sessions';
import { todayIn } from '../clock';
import { type Named, runCommand } from '../commands/run-command';
import type { AppDeps } from '../http/app';
import { validate } from '../http/validate';
import { assertBudgetMonth, assignableCategory, assignedIn, moveMoney, setAssigned, setMonthNote } from './assignments';
import { autoAssignMonth, STRATEGY_LABELS } from './auto-assign';
import { loadBudgetMonth } from './budget-month';

/**
 * /api/budget/:month (spec §3, §5.4, §7, §11): the month view, assigning, moving money, auto-assign and the month
 * note; months are 'YYYY-MM'.
 */
export function budgetRoutes(deps: AppDeps) {
  const today = () => todayIn(deps.config.timeZone, deps.clock.now());

  return new Hono<AuthedEnv>()
    .use('*', requireSession(deps))
    .get('/:month', validate('param', monthParamSchema), async (c) => {
      const { month } = c.req.valid('param');
      // One read-only snapshot for all the month view's queries.
      const { view } = await deps.db.transaction((tx) => loadBudgetMonth(tx, month, today()), {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      });
      return c.json<BudgetMonthDto>(view);
    })
    .put(
      '/:month/assignments/:categoryId',
      validate('param', assignmentParamSchema),
      validate('json', setAssignmentRequestSchema),
      async (c) => {
        const { month, categoryId } = c.req.valid('param');
        const { amount } = c.req.valid('json');
        await runCommand(
          deps,
          (r: Named) => `Assign money to "${r.name}"`,
          async (rec) => {
            // A missing or unassignable category is reported before an out-of-range month.
            const target = await assignableCategory(rec.tx, categoryId);
            await assertBudgetMonth(rec.tx, month, today());
            await setAssigned(rec, categoryId, month, amount);
            return target;
          },
        );
        return c.json<AssignmentDto>({ month, categoryId, amount });
      },
    )
    .post('/:month/move', validate('param', monthParamSchema), validate('json', moveMoneyRequestSchema), async (c) => {
      const { month } = c.req.valid('param');
      const body = c.req.valid('json');
      const touched = await runCommand(deps, 'Move money', async (rec) => {
        for (const id of [body.from, body.to]) if (id !== null) await assignableCategory(rec.tx, id);
        await assertBudgetMonth(rec.tx, month, today());
        return moveMoney(rec, month, body);
      });
      const assignments = await Promise.all(
        touched.map(async (categoryId) => ({
          month,
          categoryId,
          amount: await assignedIn(deps.db, categoryId, month),
        })),
      );
      return c.json<MoveMoneyResponse>({ assignments });
    })
    .post(
      '/:month/auto-assign',
      validate('param', monthParamSchema),
      validate('json', autoAssignRequestSchema),
      async (c) => {
        const { month } = c.req.valid('param');
        const body = c.req.valid('json');
        const changes = await runCommand(deps, `Auto-assign: ${STRATEGY_LABELS[body.strategy]}`, (rec) =>
          autoAssignMonth(rec, month, body, today()),
        );
        return c.json<AutoAssignResponse>({
          assignments: changes.map((change) => ({ month, categoryId: change.categoryId, amount: change.to })),
        });
      },
    )
    .put('/:month/note', validate('param', monthParamSchema), validate('json', monthNoteRequestSchema), async (c) => {
      const { month } = c.req.valid('param');
      const { note } = c.req.valid('json');
      await runCommand(deps, `Edit the note for ${month}`, async (rec) => {
        await assertBudgetMonth(rec.tx, month, today());
        await setMonthNote(rec, month, note);
      });
      return c.json<MonthNoteDto>({ month, note: note || null });
    });
}
