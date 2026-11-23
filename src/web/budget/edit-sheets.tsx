import { type FormEvent, useState } from 'react';
import type { BudgetCategoryDto, BudgetGroupDto, BudgetMonthDto } from '../../shared/api/budget';
import { createGroupRequestSchema, type UpdateCategoryRequest } from '../../shared/api/categories';
import { api, unwrap } from '../lib/api';
import { useCommand } from '../lib/commands';
import { type FormErrors, formErrorsOf, zodFormErrors } from '../lib/form-errors';
import { Button } from '../ui/button';
import { FormError, SelectField, TextField } from '../ui/field';
import { CategoryPicker } from './category-picker';

interface NameFormProps {
  initial?: string;
  submitLabel: string;
  send: (name: string) => Promise<unknown>;
  onDone: () => void;
}

/** A name for a new group or category (trimmed, 1–100 characters, as the API checks). */
function NameForm({ initial = '', submitLabel, send, onDone }: NameFormProps) {
  const [name, setName] = useState(initial);
  const [invalid, setInvalid] = useState<FormErrors | null>(null);
  const save = useCommand(send);
  const errors = invalid ?? formErrorsOf(save.error, ['name']);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = createGroupRequestSchema.safeParse({ name });
    setInvalid(parsed.success ? null : zodFormErrors(parsed.error, ['name']));
    if (parsed.success) save.mutate(parsed.data.name, { onSuccess: onDone });
  };
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <TextField label="Name" value={name} onChange={(event) => setName(event.target.value)} error={errors.fields.name} />
      <FormError message={errors.form} />
      <Button type="submit" mutating busy={save.isPending} block>
        {submitLabel}
      </Button>
    </form>
  );
}

export function AddGroupForm({ onDone }: { onDone: () => void }) {
  return (
    <NameForm submitLabel="Add group" send={(name) => unwrap(api.api['category-groups'].$post({ json: { name } }))} onDone={onDone} />
  );
}

export function AddCategoryForm({ group, onDone }: { group: BudgetGroupDto; onDone: () => void }) {
  return (
    <NameForm
      submitLabel="Add category"
      send={(name) => unwrap(api.api.categories.$post({ json: { groupId: group.id, name } }))}
      onDone={onDone}
    />
  );
}

function HideToggle({ hidden, send, noun, onDone }: { hidden: boolean; send: (hidden: boolean) => Promise<unknown>; noun: string; onDone: () => void }) {
  const toggle = useCommand(send);
  const errors = formErrorsOf(toggle.error, []);
  return (
    <>
      <FormError message={errors.form} />
      <Button variant="secondary" block mutating busy={toggle.isPending} onClick={() => toggle.mutate(!hidden, { onSuccess: onDone })}>
        {hidden ? `Unhide ${noun}` : `Hide ${noun}`}
      </Button>
    </>
  );
}

/**
 * Spec §10/§11 edit mode for a group: rename (your own groups), hide, and delete once it has no categories. The
 * Credit Card and Debt Payments groups belong to the app: they can only be hidden.
 */
export function EditGroupForm({ group, onDone }: { group: BudgetGroupDto; onDone: () => void }) {
  const id = { param: { id: group.id } };
  const remove = useCommand(() => unwrap(api.api['category-groups'][':id'].$delete(id)));
  const removeErrors = formErrorsOf(remove.error, []);
  const own = group.kind === 'normal';
  return (
    <div className="flex flex-col gap-4">
      {own ? (
        <NameForm
          initial={group.name}
          submitLabel="Save"
          send={(name) => unwrap(api.api['category-groups'][':id'].$patch({ ...id, json: { name } }))}
          onDone={onDone}
        />
      ) : (
        <p className="text-sm text-gray-600">The app keeps this group's name and categories in step with your accounts.</p>
      )}
      <HideToggle
        hidden={group.hidden}
        noun="group"
        send={(hidden) => unwrap(api.api['category-groups'][':id'].$patch({ ...id, json: { hidden } }))}
        onDone={onDone}
      />
      {own && (
        <div className="flex flex-col gap-2 border-t border-gray-200 pt-4">
          <FormError message={removeErrors.form} />
          <Button
            variant="danger"
            block
            mutating
            busy={remove.isPending}
            disabled={group.categories.length > 0}
            onClick={() => remove.mutate(undefined, { onSuccess: onDone })}
          >
            Delete group
          </Button>
          {group.categories.length > 0 && (
            <p className="text-sm text-gray-500">Move or delete its categories first.</p>
          )}
        </div>
      )}
    </div>
  );
}

interface EditCategoryFormProps {
  view: BudgetMonthDto;
  category: BudgetCategoryDto;
  group: BudgetGroupDto;
  onDone: () => void;
}

/** Rename and move (between your own groups) in one save. */
function RenameMoveForm({ view, category, group, onDone }: EditCategoryFormProps) {
  const [name, setName] = useState(category.name);
  const [groupId, setGroupId] = useState(group.id);
  const [invalid, setInvalid] = useState<FormErrors | null>(null);
  const save = useCommand((json: UpdateCategoryRequest) =>
    unwrap(api.api.categories[':id'].$patch({ param: { id: category.id }, json })),
  );
  const errors = invalid ?? formErrorsOf(save.error, ['name', 'groupId']);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = createGroupRequestSchema.safeParse({ name });
    setInvalid(parsed.success ? null : zodFormErrors(parsed.error, ['name']));
    if (!parsed.success) return;
    const changes: UpdateCategoryRequest = {
      ...(parsed.data.name !== category.name && { name: parsed.data.name }),
      ...(groupId !== group.id && { groupId }),
    };
    if (Object.keys(changes).length === 0) onDone();
    else save.mutate(changes, { onSuccess: onDone });
  };
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <TextField label="Name" value={name} onChange={(event) => setName(event.target.value)} error={errors.fields.name} />
      <SelectField label="Group" value={groupId} onChange={(event) => setGroupId(event.target.value)} error={errors.fields.groupId}>
        {view.groups
          .filter((g) => g.kind === 'normal')
          .map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
      </SelectField>
      <FormError message={errors.form} />
      <Button type="submit" mutating busy={save.isPending} block>
        Save
      </Button>
    </form>
  );
}

/** Spec §10: deleting moves the category's transactions, schedules and assignments to another regular category. */
function DeleteCategory({ view, category, onDone }: Omit<EditCategoryFormProps, 'group'>) {
  const [destination, setDestination] = useState('');
  const [missing, setMissing] = useState(false);
  const remove = useCommand((destinationCategoryId: string) =>
    unwrap(api.api.categories[':id'].$delete({ param: { id: category.id }, query: { destinationCategoryId } })),
  );
  const errors = formErrorsOf(remove.error, ['destinationCategoryId']);
  const submit = () => {
    setMissing(destination === '');
    if (destination !== '') remove.mutate(destination, { onSuccess: onDone });
  };
  return (
    <div className="flex flex-col gap-3 border-t border-gray-200 pt-4">
      <CategoryPicker
        label="Move its money and transactions to"
        groups={view.groups}
        include={(c) => c.kind === 'normal' && c.id !== category.id}
        value={destination}
        onChange={(value) => {
          setDestination(value);
          setMissing(false);
        }}
        error={missing ? 'Choose the category that takes them over.' : errors.fields.destinationCategoryId}
      />
      <FormError message={errors.form} />
      <Button variant="danger" block mutating busy={remove.isPending} onClick={submit}>
        Delete category
      </Button>
    </div>
  );
}

/**
 * Spec §10/§11 edit mode for a category: rename, move to another of your groups, hide, delete into another
 * category. Credit card payment and loan categories follow their account: they can only be hidden (the server
 * refuses the rest, so the controls aren't shown).
 */
export function EditCategoryForm(props: EditCategoryFormProps) {
  const { category, onDone } = props;
  const own = category.kind === 'normal';
  return (
    <div className="flex flex-col gap-4">
      {own ? (
        <RenameMoveForm {...props} />
      ) : (
        <p className="text-sm text-gray-600">This category follows its account: rename or delete the account instead.</p>
      )}
      <HideToggle
        hidden={category.hidden}
        noun="category"
        send={(hidden) => unwrap(api.api.categories[':id'].$patch({ param: { id: category.id }, json: { hidden } }))}
        onDone={onDone}
      />
      {own && <DeleteCategory {...props} />}
    </div>
  );
}
