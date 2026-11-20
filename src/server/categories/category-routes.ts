import { Hono } from 'hono';
import {
  type CategoryDto,
  type CategoryListResponse,
  createCategoryRequestSchema,
  deleteCategoryRequestSchema,
  reorderCategoriesRequestSchema,
  updateCategoryRequestSchema,
} from '../../shared/api/categories';
import { idParamSchema, type IdResponse, type ReorderResponse } from '../../shared/api/common';
import { setTargetRequestSchema, snoozeTargetRequestSchema, type TargetDto } from '../../shared/api/targets';
import { type AuthedEnv, requireSession } from '../auth/sessions';
import { todayIn } from '../clock';
import { type Named, runCommand } from '../commands/run-command';
import type { AppDeps } from '../http/app';
import { validate } from '../http/validate';
import { deleteTarget, getTarget, setTarget, snoozeTarget } from '../targets/target-commands';
import { createCategory, deleteCategory, reorderCategories, updateCategory } from './category-commands';
import { getCategory, listCategoryGroups } from './category-queries';

/** /api/categories (spec §10 "Categories", §6 targets): every change is one undoable command. */
export function categoryRoutes(deps: AppDeps) {
  const today = () => todayIn(deps.config.timeZone, deps.clock.now());

  return new Hono<AuthedEnv>()
    .use('*', requireSession(deps))
    .get('/', async (c) => c.json<CategoryListResponse>({ groups: await listCategoryGroups(deps.db) }))
    .post('/', validate('json', createCategoryRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const { id } = await runCommand(deps, `Create category "${body.name}"`, (rec) => createCategory(rec, body));
      return c.json<CategoryDto>(await getCategory(deps.db, id), 201);
    })
    .put('/order', validate('json', reorderCategoriesRequestSchema), async (c) => {
      const { groupId, ids } = c.req.valid('json');
      await runCommand(deps, 'Reorder categories', (rec) => reorderCategories(rec, groupId, ids));
      return c.json<ReorderResponse>({ ids });
    })
    .patch('/:id', validate('param', idParamSchema), validate('json', updateCategoryRequestSchema), async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      await runCommand(deps, (r: Named) => `Edit category "${r.name}"`, (rec) => updateCategory(rec, id, body));
      return c.json<CategoryDto>(await getCategory(deps.db, id));
    })
    .delete('/:id', validate('param', idParamSchema), validate('query', deleteCategoryRequestSchema), async (c) => {
      const { id } = c.req.valid('param');
      const { destinationCategoryId } = c.req.valid('query');
      await runCommand(
        deps,
        (r: Named) => `Delete category "${r.name}"`,
        (rec) => deleteCategory(rec, id, destinationCategoryId, deps.clock.now()),
      );
      return c.json<IdResponse>({ id });
    })
    .put('/:id/target', validate('param', idParamSchema), validate('json', setTargetRequestSchema), async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      await runCommand(
        deps,
        (r: Named) => `Set the target for "${r.name}"`,
        (rec) => setTarget(rec, id, body, today()),
      );
      return c.json<TargetDto>(await getTarget(deps.db, id));
    })
    .delete('/:id/target', validate('param', idParamSchema), async (c) => {
      const { id } = c.req.valid('param');
      await runCommand(deps, (r: Named) => `Delete the target for "${r.name}"`, (rec) => deleteTarget(rec, id));
      return c.json<IdResponse>({ id });
    })
    .post(
      '/:id/target/snooze',
      validate('param', idParamSchema),
      validate('json', snoozeTargetRequestSchema),
      async (c) => {
        const { id } = c.req.valid('param');
        const { month } = c.req.valid('json');
        await runCommand(
          deps,
          (r: Named) => `Snooze the target for "${r.name}"`,
          (rec) => snoozeTarget(rec, id, month, today()),
        );
        return c.json<TargetDto>(await getTarget(deps.db, id));
      },
    )
    .delete('/:id/target/snooze', validate('param', idParamSchema), async (c) => {
      const { id } = c.req.valid('param');
      await runCommand(
        deps,
        (r: Named) => `Unsnooze the target for "${r.name}"`,
        (rec) => snoozeTarget(rec, id, null, today()),
      );
      return c.json<TargetDto>(await getTarget(deps.db, id));
    });
}
