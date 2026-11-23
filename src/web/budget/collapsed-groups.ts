import { useState } from 'react';

const STORAGE_KEY = 'budget-track.collapsed-groups';

function readCollapsed(): Set<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * Which category groups the user collapsed on the Budget screen (spec §11). Remembered in this browser's
 * localStorage, not on the server: it is a view preference of one device.
 */
export function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = (groupId: string) => {
    const next = new Set(collapsed);
    if (!next.delete(groupId)) next.add(groupId);
    setCollapsed(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      // Storage may be full or blocked (private browsing); the groups stay collapsed until the page reloads.
    }
  };
  return { isCollapsed: (groupId: string) => collapsed.has(groupId), toggle };
}
