import { z } from 'zod';
import {
  avatarSchema,
  colorSchema,
  displayNameSchema,
  householdPermissionSchema,
  householdRoleSchema,
} from './common.js';

export const createMemberSchema = z.object({
  displayName: displayNameSchema,
  avatar: avatarSchema,
  role: householdRoleSchema,
  color: colorSchema.optional(),
});

export const patchMemberSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    avatar: avatarSchema.optional(),
    role: householdRoleSchema.optional(),
    permission: householdPermissionSchema.optional(),
    color: colorSchema.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'no fields to update' });

export type CreateMemberBody = z.infer<typeof createMemberSchema>;
export type PatchMemberBody = z.infer<typeof patchMemberSchema>;
