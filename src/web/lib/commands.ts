import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../ui/toast';
import { api, ApiError, isTransient, isUnauthorized, UNEXPECTED_ERROR_MESSAGE, unwrap } from './api';
import { invalidateData, queryKeys } from './query';

/** GET /api/undo: what the header's Undo and Redo buttons would do. */
export const undoStateQuery = queryOptions({
  queryKey: queryKeys.undo,
  queryFn: () => unwrap(api.api.undo.$get()),
});

/** The message to show for a failed request outside a form. */
export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : UNEXPECTED_ERROR_MESSAGE;
}

/** The toast key of command results: a new one replaces the last, so only the newest command offers Undo. */
const COMMAND_TOAST = 'command';

/**
 * Undo and redo (spec §10), for the header buttons and the toasts' Undo. Afterwards every budget-data query is
 * refreshed; a 409 (`undo_conflict`, `nothing_to_undo`, …) is shown as an error toast with the server's message.
 */
export function useUndoRedo() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: async (direction: 'undo' | 'redo') =>
      direction === 'undo' ? unwrap(api.api.undo.$post()) : unwrap(api.api.redo.$post()),
    onSuccess: async (result) => {
      const message = 'undone' in result ? `Undone: ${result.undone.label}` : `Redone: ${result.redone.label}`;
      toast.show({ key: COMMAND_TOAST, message });
      queryClient.setQueryData(queryKeys.undo, { undo: result.undo, redo: result.redo });
      await invalidateData(queryClient);
    },
    onError: (error) => {
      if (!isUnauthorized(error)) toast.show({ key: COMMAND_TOAST, tone: 'error', message: errorMessage(error) });
    },
  });
  return {
    undo: () => mutation.mutate('undo'),
    redo: () => mutation.mutate('redo'),
    busy: mutation.isPending,
  };
}

/**
 * A user command (spec §2 write path), e.g. `useCommand((name: string) => unwrap(api.api.payees.$post({ json: { name } })))`.
 * It waits for the server (no optimistic update), then refreshes every budget-data query and shows a toast with the
 * command's undo label and an Undo button (spec §11). The error stays on the mutation for the form to show
 * (`formErrorsOf(mutation.error, fields)`); a network or server failure also gets a toast with Retry.
 */
export function useCommand<TVariables = void, TResult = unknown>(mutationFn: (variables: TVariables) => Promise<TResult>) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { undo } = useUndoRedo();
  const mutation = useMutation({
    mutationFn,
    onSuccess: async () => {
      await invalidateData(queryClient);
      const state = await queryClient.fetchQuery(undoStateQuery);
      if (state.undo) {
        toast.show({ key: COMMAND_TOAST, message: state.undo.label, action: { label: 'Undo', onClick: undo } });
      }
    },
    onError: (error, variables) => {
      if (!isTransient(error)) return;
      toast.show({
        tone: 'error',
        message: errorMessage(error),
        action: { label: 'Retry', onClick: () => mutation.mutate(variables) },
      });
    },
  });
  return mutation;
}
