import type { BudgetCategoryDto, BudgetGroupDto } from '../../shared/api/budget';
import { formatMoney } from '../lib/format';
import { SelectField, type SelectFieldProps } from '../ui/field';

/** The picker's value for Ready to Assign (category ids are UUIDs, so they never clash with it). */
export const READY_TO_ASSIGN = 'rta';

export interface CategoryPickerProps extends Omit<SelectFieldProps, 'children' | 'value' | 'onChange'> {
  /** The groups to list, in display order (e.g. the month view's). */
  groups: readonly BudgetGroupDto[];
  /** '' until something is picked, READY_TO_ASSIGN, or a category id. */
  value: string;
  onChange: (value: string) => void;
  /** Which categories can be picked; all of `groups` by default. */
  include?: (category: BudgetCategoryDto) => boolean;
  /** Lists Ready to Assign first, with this label and amount. */
  readyToAssign?: { label: string; amount: number };
  /** The first, unpickable option. */
  placeholder?: string;
}

/**
 * Picks a category, showing each one's Available for the month (spec §11), grouped like the budget. A native select:
 * the phone's own picker is the quickest to use. Groups without a pickable category are left out.
 */
export function CategoryPicker({
  groups,
  value,
  onChange,
  include = () => true,
  readyToAssign,
  placeholder = 'Choose a category',
  ...props
}: CategoryPickerProps) {
  return (
    <SelectField value={value} onChange={(event) => onChange(event.target.value)} {...props}>
      <option value="" disabled>
        {placeholder}
      </option>
      {readyToAssign && (
        <option value={READY_TO_ASSIGN}>
          {readyToAssign.label} ({formatMoney(readyToAssign.amount)})
        </option>
      )}
      {groups.map((group) => {
        const categories = group.categories.filter(include);
        if (categories.length === 0) return null;
        return (
          <optgroup key={group.id} label={group.name}>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name} ({formatMoney(category.available)})
              </option>
            ))}
          </optgroup>
        );
      })}
    </SelectField>
  );
}
