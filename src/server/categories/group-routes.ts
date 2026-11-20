import { Hono } from 'hono';
import {
  type CategoryGroupDto,
  createGroupRequestSchema,
  updateGroupRequestSchema,
} from '../../shared/api/categories';
import { idParamSchema, type IdResponse, type ReorderResponse, reorderRequestSchema } from '../../shared/api/common';
import { type AuthedEnv, requireSession } from '../auth/sessions';
import { type Named, runCommand } from '../commands/run-command';
import type { AppDeps } from '../http/app';
import { validate } from '../http/validate';
import { getCategoryGroup } from './category-queries';
import { createGroup, deleteGroup, reorderGroups, updateGroup } from './group-commands';

/** /api/category-groups (spec §10 "Categories"). The list itself is GET /api/categories. */
export function groupRoutes(deps: AppDeps) {
  return new Hono<AuthedEnv>()
    .use('*', requireSession(deps))
    .post('/', validate('json', createGroupRequestSchema), async (c) => {
      const { name } = c.req.valid('json');
      const { id } = await runCommand(deps, `Create group "${name}"`, (rec) => createGroup(rec, name));
      return c.json<CategoryGroupDto>(await getCategoryGroup(deps.db, id), 201);
    })
    .put('/order', validate('json', reorderRequestSchema), async (c) => {
      const { ids } = c.req.valid('json');
      await runCommand(deps, 'Reorder groups', (rec) => reorderGroups(rec, ids));
      return c.json<ReorderResponse>({ ids });
    })
    .patch('/:id', validate('param', idParamSchema), validate('json', updateGroupRequestSchema), async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      await runCommand(deps, (r: Named) => `Edit group "${r.name}"`, (rec) => updateGroup(rec, id, body));
      return c.json<CategoryGroupDto>(await getCategoryGroup(deps.db, id));
    })
    .delete('/:id', validate('param', idParamSchema), async (c) => {
      const { id } = c.req.valid('param');
      await runCommand(deps, (r: Named) => `Delete group "${r.name}"`, (rec) => deleteGroup(rec, id, deps.clock.now()));
      return c.json<IdResponse>({ id });
    });
}
