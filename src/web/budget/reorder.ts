import type { DragEndEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';

/** The order after dropping `activeId` where `overId` was, or null when nothing moved. */
export function reorderedIds(ids: readonly string[], activeId: string, overId: string | null): string[] | null {
  if (overId === null || activeId === overId) return null;
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0) return null;
  return arrayMove([...ids], from, to);
}

/** A dnd-kit `onDragEnd` that sends the new order of `ids` (the full list the reorder API wants) if it changed. */
export function reorderOnDragEnd(ids: readonly string[], reorder: (ids: string[]) => void) {
  return ({ active, over }: Pick<DragEndEvent, 'active' | 'over'>) => {
    const next = reorderedIds(ids, String(active.id), over ? String(over.id) : null);
    if (next) reorder(next);
  };
}
