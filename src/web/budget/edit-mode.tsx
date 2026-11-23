import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { type ReactNode, useState } from 'react';
import type { BudgetCategoryDto, BudgetGroupDto, BudgetMonthDto } from '../../shared/api/budget';
import { api, unwrap } from '../lib/api';
import { useCommand } from '../lib/commands';
import { formErrorsOf } from '../lib/form-errors';
import { useOnline } from '../lib/online';
import { Button } from '../ui/button';
import { cx } from '../ui/cx';
import { FormError } from '../ui/field';
import { GripIcon, PlusIcon } from '../ui/icons';
import { Sheet } from '../ui/sheet';
import { AddCategoryForm, AddGroupForm, EditCategoryForm, EditGroupForm } from './edit-sheets';
import { reorderOnDragEnd } from './reorder';

/** Touch, mouse and keyboard (Space, arrows, Space). A drag starts only from a handle, so taps still open sheets. */
function useReorderSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

/**
 * The order shown while a reorder is on its way: the dropped order until the server has answered and the month view
 * is fresh (no optimistic cache update; on failure the old order comes back).
 */
function useReorder(send: (ids: string[]) => Promise<unknown>) {
  const [pending, setPending] = useState<string[] | null>(null);
  const reorder = useCommand(send);
  const errors = formErrorsOf(reorder.error, []);
  const run = (ids: string[]) => {
    setPending(ids);
    reorder.mutate(ids, { onSettled: () => setPending(null) });
  };
  const ordered = <T extends { id: string }>(items: T[]) =>
    pending ? pending.flatMap((id) => items.filter((item) => item.id === id)) : items;
  return { run, ordered, busy: reorder.isPending, error: errors.form };
}

function Sortable({ id, label, children }: { id: string; label: string; children: (handle: ReactNode) => ReactNode }) {
  const online = useOnline();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !online,
  });
  const handle = (
    <button
      ref={setActivatorNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      aria-label={`Reorder ${label}`}
      disabled={!online}
      className="flex min-h-11 w-10 shrink-0 cursor-grab touch-none items-center justify-center text-gray-400 disabled:cursor-not-allowed"
    >
      <GripIcon className="size-5" />
    </button>
  );
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cx('relative bg-white', isDragging && 'z-10 shadow-lg')}
    >
      {children(handle)}
    </li>
  );
}

type Editing =
  | { type: 'add-group' }
  | { type: 'group'; group: BudgetGroupDto }
  | { type: 'add-category'; group: BudgetGroupDto }
  | { type: 'category'; category: BudgetCategoryDto; group: BudgetGroupDto }
  | null;

interface GroupBlockProps {
  group: BudgetGroupDto;
  handle: ReactNode;
  onEdit: (editing: Editing) => void;
}

function Badge({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-600">{children}</span>;
}

/** A group in edit mode: its handle, name and Add category, then its categories (hidden ones too), sortable. */
function GroupBlock({ group, handle, onEdit }: GroupBlockProps) {
  const sensors = useReorderSensors();
  const reorder = useReorder((ids) => unwrap(api.api.categories.order.$put({ json: { groupId: group.id, ids } })));
  const categories = reorder.ordered(group.categories);
  const onDragEnd = reorderOnDragEnd(
    group.categories.map((c) => c.id),
    reorder.run,
  );
  return (
    <section aria-label={group.name} className="border-b border-gray-200">
      <div className="flex items-center bg-gray-50 pr-2">
        {handle}
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={() => onEdit({ type: 'group', group })}
          className="flex min-h-11 flex-1 items-center gap-2 text-left text-sm font-semibold text-gray-700"
        >
          <span className="truncate">{group.name}</span>
          {group.hidden && <Badge>Hidden</Badge>}
        </button>
        {group.kind === 'normal' && (
          <Button
            variant="ghost"
            aria-label={`Add a category to ${group.name}`}
            onClick={() => onEdit({ type: 'add-category', group })}
            className="px-2"
          >
            <PlusIcon className="size-5" />
          </Button>
        )}
      </div>
      <FormError message={reorder.error} />
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={categories.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          <ul aria-label={`Categories in ${group.name}`} aria-busy={reorder.busy || undefined} className="divide-y divide-gray-100">
            {categories.map((category) => (
              <Sortable key={category.id} id={category.id} label={category.name}>
                {(categoryHandle) => (
                  <div className="flex items-center pr-4">
                    {categoryHandle}
                    <button
                      type="button"
                      aria-haspopup="dialog"
                      onClick={() => onEdit({ type: 'category', category, group })}
                      className="flex min-h-11 flex-1 items-center gap-2 text-left"
                    >
                      <span className="truncate">{category.name}</span>
                      {category.hidden && <Badge>Hidden</Badge>}
                    </button>
                  </div>
                )}
              </Sortable>
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </section>
  );
}

/**
 * Spec §11 edit mode: every group and category (hidden ones too, so the order sent is complete), dragged by their
 * handles (dnd-kit), and sheets to add, rename, move, hide and delete them.
 */
export function BudgetEditor({ view }: { view: BudgetMonthDto }) {
  const [editing, setEditing] = useState<Editing>(null);
  const close = () => setEditing(null);
  const sensors = useReorderSensors();
  const reorder = useReorder((ids) => unwrap(api.api['category-groups'].order.$put({ json: { ids } })));
  const groups = reorder.ordered(view.groups);
  const onDragEnd = reorderOnDragEnd(
    view.groups.map((g) => g.id),
    reorder.run,
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="px-4 text-sm text-gray-500">Drag the handles to reorder. Tap a group or category to change it.</p>
      <FormError message={reorder.error} />
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={groups.map((g) => g.id)} strategy={verticalListSortingStrategy}>
          <ul aria-label="Groups" aria-busy={reorder.busy || undefined} className="border-t border-gray-200">
            {groups.map((group) => (
              <Sortable key={group.id} id={group.id} label={group.name}>
                {(handle) => <GroupBlock group={group} handle={handle} onEdit={setEditing} />}
              </Sortable>
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      <div className="px-4">
        <Button variant="secondary" block onClick={() => setEditing({ type: 'add-group' })}>
          <PlusIcon className="size-5" />
          Add group
        </Button>
      </div>

      <Sheet open={editing?.type === 'add-group'} onClose={close} title="New group">
        <AddGroupForm onDone={close} />
      </Sheet>
      <Sheet open={editing?.type === 'add-category'} onClose={close} title={editing?.type === 'add-category' ? `New category in ${editing.group.name}` : ''}>
        {editing?.type === 'add-category' && <AddCategoryForm group={editing.group} onDone={close} />}
      </Sheet>
      <Sheet open={editing?.type === 'group'} onClose={close} title={editing?.type === 'group' ? editing.group.name : ''}>
        {editing?.type === 'group' && <EditGroupForm group={editing.group} onDone={close} />}
      </Sheet>
      <Sheet open={editing?.type === 'category'} onClose={close} title={editing?.type === 'category' ? editing.category.name : ''}>
        {editing?.type === 'category' && (
          <EditCategoryForm view={view} category={editing.category} group={editing.group} onDone={close} />
        )}
      </Sheet>
    </div>
  );
}
