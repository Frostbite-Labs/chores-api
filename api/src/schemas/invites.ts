import { z } from 'zod';
import { householdRoleSchema, invitablePermissionSchema } from './common.js';
import { INVITE_ALPHABET, INVITE_CODE_LENGTH } from '@/config/constants.js';

export const createInviteSchema = z.object({
  role: householdRoleSchema,
  permission: invitablePermissionSchema,
  maxUses: z.number().int().positive().max(100).optional(),
  expiresInHours: z.number().int().positive().max(24 * 30).optional(),
  invitedEmail: z.string().email().max(254).optional(),
});

const codeRegex = new RegExp(`^[${INVITE_ALPHABET}]{${INVITE_CODE_LENGTH}}$`);

export const redeemInviteSchema = z.object({
  code: z
    .string()
    .length(INVITE_CODE_LENGTH)
    .regex(codeRegex, { message: 'invalid invite code' }),
});

export type CreateInviteBody = z.infer<typeof createInviteSchema>;
export type RedeemInviteBody = z.infer<typeof redeemInviteSchema>;
