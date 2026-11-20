import { z } from 'zod';
import { idSchema, moneySchema, monthSchema, noteSchema, positiveMoneySchema } from './common';

export const monthParamSchema = z.object({ month: monthSchema });
export const assignmentParamSchema = z.object({ month: monthSchema, categoryId: idSchema });

/** PUT /api/budget/:month/assignments/:categoryId — the category's new Assigned amount (0 clears it). */
export const setAssignmentRequestSchema = z.object({ amount: moneySchema });

/** POST /api/budget/:month/move — null stands for Ready to Assign (spec §3). */
export const moveMoneyRequestSchema = z
  .object({ from: idSchema.nullable(), to: idSchema.nullable(), amount: positiveMoneySchema })
  .refine((body) => body.from !== body.to, {
    path: ['to'],
    message: 'Choose two different places to move money between.',
  });

/** PUT /api/budget/:month/note — an empty note deletes it. */
export const monthNoteRequestSchema = z.object({ note: noteSchema });

export type MoveMoneyRequest = z.infer<typeof moveMoneyRequestSchema>;

export interface AssignmentDto {
  /** 'YYYY-MM' */
  month: string;
  categoryId: string;
  /** Assigned in minor units (0 = no assignment). */
  amount: number;
}

export interface MoveMoneyResponse {
  /** The categories whose Assigned changed (one or two). */
  assignments: AssignmentDto[];
}

export interface MonthNoteDto {
  month: string;
  note: string | null;
}
