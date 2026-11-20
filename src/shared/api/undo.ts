/** A command in the undo history, as the header's Undo/Redo buttons show it. */
export interface UndoItem {
  label: string;
}

/** GET /api/undo: what Undo would revert and what Redo would reapply (null = nothing). */
export interface UndoState {
  undo: UndoItem | null;
  redo: UndoItem | null;
}

/** POST /api/undo */
export interface UndoResponse extends UndoState {
  undone: UndoItem;
}

/** POST /api/redo */
export interface RedoResponse extends UndoState {
  redone: UndoItem;
}
