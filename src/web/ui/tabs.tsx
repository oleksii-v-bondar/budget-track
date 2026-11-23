import { type KeyboardEvent, type ReactNode, useId, useRef } from 'react';
import { cx } from './cx';

export interface TabsProps<T extends string> {
  /** Accessible name of the tab list. */
  label: string;
  value: T;
  tabs: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  /** The selected tab's panel. */
  children: ReactNode;
}

/**
 * Tabs that scroll sideways on a phone (e.g. the category sheet's Assign · Move · Target · Activity). Arrow keys,
 * Home and End move between tabs and select them, as the WAI-ARIA tabs pattern describes.
 */
export function Tabs<T extends string>({ label, value, tabs, onChange, children }: TabsProps<T>) {
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const tabId = (tab: T) => `${id}-tab-${tab}`;

  const onKeyDown = (event: KeyboardEvent) => {
    const index = tabs.findIndex((tab) => tab.value === value);
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const target = (next + tabs.length) % tabs.length;
    onChange(tabs[target]!.value);
    list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[target]?.focus();
  };

  return (
    <div>
      <div
        ref={list}
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="-mx-4 flex gap-1 overflow-x-auto border-b border-gray-200 px-4"
      >
        {tabs.map((tab) => {
          const selected = tab.value === value;
          return (
            <button
              key={tab.value}
              id={tabId(tab.value)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${id}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab.value)}
              className={cx(
                '-mb-px min-h-11 shrink-0 border-b-2 px-3 text-sm font-semibold whitespace-nowrap',
                selected ? 'border-brand text-brand' : 'border-transparent text-gray-500',
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={tabId(value)} className="pt-4">
        {children}
      </div>
    </div>
  );
}
