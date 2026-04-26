import { z } from 'zod';
import { displayNameSchema, uuidSchema } from './common.js';

export const createHouseholdSchema = z.object({
  name: displayNameSchema,
});

export const renameHouseholdSchema = z
  .object({
    name: displayNameSchema.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'no fields to update' });

export const transferOwnershipSchema = z.object({
  toMemberId: uuidSchema,
});

export type CreateHouseholdBody = z.infer<typeof createHouseholdSchema>;
export type RenameHouseholdBody = z.infer<typeof renameHouseholdSchema>;
export type TransferOwnershipBody = z.infer<typeof transferOwnershipSchema>;
