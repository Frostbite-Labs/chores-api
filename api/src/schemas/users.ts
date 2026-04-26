import { z } from 'zod';
import { avatarSchema, displayNameSchema } from './common.js';

export const patchMeSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    avatar: avatarSchema.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'no fields to update' });

export type PatchMeBody = z.infer<typeof patchMeSchema>;
