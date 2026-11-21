import { useQuery } from '@tanstack/react-query';
import { undoStateQuery, useUndoRedo } from '../lib/commands';
import { Button } from '../ui/button';
import { RedoIcon, UndoIcon } from '../ui/icons';

/** The header's Undo and Redo buttons, named after the command they would undo or redo. */
export function UndoRedoButtons() {
  const { data } = useQuery(undoStateQuery);
  const { undo, redo, busy } = useUndoRedo();
  const undoName = data?.undo ? `Undo ${data.undo.label}` : 'Undo';
  const redoName = data?.redo ? `Redo ${data.redo.label}` : 'Redo';
  return (
    <div className="-mr-2 flex">
      <Button variant="ghost" mutating aria-label={undoName} title={undoName} disabled={!data?.undo || busy} onClick={undo} className="px-2">
        <UndoIcon />
      </Button>
      <Button variant="ghost" mutating aria-label={redoName} title={redoName} disabled={!data?.redo || busy} onClick={redo} className="px-2">
        <RedoIcon />
      </Button>
    </div>
  );
}
