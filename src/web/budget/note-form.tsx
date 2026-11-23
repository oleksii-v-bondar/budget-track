import { type FormEvent, useState } from 'react';
import { monthNoteRequestSchema } from '../../shared/api/budget';
import { useCommand } from '../lib/commands';
import { type FormErrors, formErrorsOf, zodFormErrors } from '../lib/form-errors';
import { Button } from '../ui/button';
import { FormError, TextAreaField } from '../ui/field';

interface NoteFormProps {
  label: string;
  initial: string | null;
  /** Sends the note ('' removes it). */
  send: (note: string) => Promise<unknown>;
  onDone: () => void;
}

/** A month's or a category's note (spec §11): free text up to 2000 characters; saving an empty note removes it. */
export function NoteForm({ label, initial, send, onDone }: NoteFormProps) {
  const [note, setNote] = useState(initial ?? '');
  const [invalid, setInvalid] = useState<FormErrors | null>(null);
  const save = useCommand(send);
  const errors = invalid ?? formErrorsOf(save.error, ['note']);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = monthNoteRequestSchema.safeParse({ note });
    setInvalid(parsed.success ? null : zodFormErrors(parsed.error, ['note']));
    if (parsed.success) save.mutate(parsed.data.note, { onSuccess: onDone });
  };
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <TextAreaField
        label={label}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        error={errors.fields.note}
        hint="Leave it empty to remove the note."
      />
      <FormError message={errors.form} />
      <Button type="submit" mutating busy={save.isPending} block>
        Save note
      </Button>
    </form>
  );
}
