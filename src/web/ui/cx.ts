/** Joins class names, skipping falsy ones: `cx('p-2', active && 'bg-gray-100')`. */
export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}
