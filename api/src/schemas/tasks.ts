import { z } from 'zod';
import {
  avatarSchema,
  isoTimestampSchema,
  notesSchema,
  recurrenceSchema,
  taskAudienceSchema,
  titleSchema,
  uuidSchema,
} from './common.js';

const baseTaskFields = {
  title: titleSchema,
  icon: avatarSchema,
  notes: notesSchema.nullable().optional(),
  audience: taskAudienceSchema,
  points: z.number().int().min(0).max(1_000_000),
  recurrence: recurrenceSchema,
  nextDueAt: isoTimestampSchema.optional(),
};

export const createTaskSchema = z.object(baseTaskFields);

export const patchTaskSchema = z
  .object({
    title: titleSchema.optional(),
    icon: avatarSchema.optional(),
    notes: notesSchema.nullable().optional(),
    audience: taskAudienceSchema.optional(),
    points: z.number().int().min(0).max(1_000_000).optional(),
    recurrence: recurrenceSchema.optional(),
    nextDueAt: isoTimestampSchema.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'no fields to update' });

export const tasksQuerySchema = z.object({
  dueBefore: isoTimestampSchema.optional(),
  audience: taskAudienceSchema.optional(),
});

export const createCompletionSchema = z.object({
  memberId: uuidSchema,
  completedAt: isoTimestampSchema.optional(),
});

export const completionsQuerySchema = z.object({
  from: isoTimestampSchema.optional(),
  to: isoTimestampSchema.optional(),
  memberId: uuidSchema.optional(),
  taskId: uuidSchema.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export type CreateTaskBody = z.infer<typeof createTaskSchema>;
export type PatchTaskBody = z.infer<typeof patchTaskSchema>;
export type TasksQuery = z.infer<typeof tasksQuerySchema>;
export type CreateCompletionBody = z.infer<typeof createCompletionSchema>;
export type CompletionsQuery = z.infer<typeof completionsQuerySchema>;
