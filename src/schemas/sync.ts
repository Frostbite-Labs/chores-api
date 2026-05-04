import { z } from 'zod';
import { isoTimestampSchema, recurrenceSchema, taskAudienceSchema, uuidSchema } from './common.js';

export const syncPullQuerySchema = z.object({
  since: z.coerce.number().int().min(0).default(0),
});

const taskCreatePayload = z.object({
  title: z.string().min(1).max(120),
  icon: z.string().min(1).max(16),
  notes: z.string().max(1000).nullable().optional(),
  audience: taskAudienceSchema,
  points: z.number().int().min(0).max(1_000_000),
  recurrence: recurrenceSchema,
  nextDueAt: isoTimestampSchema.optional(),
});

const taskUpdatePayload = z.object({
  id: uuidSchema,
  patch: z
    .object({
      title: z.string().min(1).max(120).optional(),
      icon: z.string().min(1).max(16).optional(),
      notes: z.string().max(1000).nullable().optional(),
      audience: taskAudienceSchema.optional(),
      points: z.number().int().min(0).max(1_000_000).optional(),
      recurrence: recurrenceSchema.optional(),
      nextDueAt: isoTimestampSchema.optional(),
    })
    .strict(),
});

const completionCreatePayload = z.object({
  taskId: uuidSchema,
  memberId: uuidSchema,
  completedAt: isoTimestampSchema.optional(),
});

const memberCreatePayload = z.object({
  displayName: z.string().min(1).max(80),
  avatar: z.string().min(1).max(16),
  role: z.enum(['adult', 'child']),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/)
    .optional(),
});

const memberUpdatePayload = z.object({
  id: uuidSchema,
  patch: z
    .object({
      displayName: z.string().min(1).max(80).optional(),
      avatar: z.string().min(1).max(16).optional(),
      role: z.enum(['adult', 'child']).optional(),
      permission: z.enum(['owner', 'admin', 'member']).optional(),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/)
        .optional(),
    })
    .strict(),
});

const idOnly = z.object({ id: uuidSchema });

const baseOp = {
  clientId: z.string().min(1).max(64),
  ifMatchRowVersion: z.number().int().nonnegative().optional(),
  ifMatchTaskRowVersion: z.number().int().nonnegative().optional(),
};

export const syncPushOpSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task.create'), payload: taskCreatePayload, ...baseOp }),
  z.object({ kind: z.literal('task.update'), payload: taskUpdatePayload, ...baseOp }),
  z.object({ kind: z.literal('task.delete'), payload: idOnly, ...baseOp }),
  z.object({ kind: z.literal('completion.create'), payload: completionCreatePayload, ...baseOp }),
  z.object({ kind: z.literal('completion.delete'), payload: idOnly, ...baseOp }),
  z.object({ kind: z.literal('member.create'), payload: memberCreatePayload, ...baseOp }),
  z.object({ kind: z.literal('member.update'), payload: memberUpdatePayload, ...baseOp }),
  z.object({ kind: z.literal('member.delete'), payload: idOnly, ...baseOp }),
]);

export const syncPushBodySchema = z.object({
  operations: z.array(syncPushOpSchema).min(1).max(500),
});

export type SyncPullQuery = z.infer<typeof syncPullQuerySchema>;
export type SyncPushBody = z.infer<typeof syncPushBodySchema>;
export type SyncPushOp = z.infer<typeof syncPushOpSchema>;
