/**
 * Reusable zod primitives. Each is a single source of truth referenced by the
 * route schemas, so any tightening (e.g. raising the title cap) propagates.
 */
import { z } from 'zod';
import { isSingleGrapheme } from '@/lib/avatar.js';
import { isUuid } from '@/lib/ids.js';
import { LIMITS } from '@/config/constants.js';

export const uuidSchema = z.string().refine(isUuid, { message: 'must be a UUID' });

export const isoTimestampSchema = z
  .string()
  .datetime({ offset: true, precision: 3, message: 'must be ISO-8601 ms-precision UTC' });

export const titleSchema = z.string().min(1).max(LIMITS.title);
export const notesSchema = z.string().max(LIMITS.notes);
export const displayNameSchema = z.string().min(1).max(LIMITS.displayName);
export const avatarSchema = z
  .string()
  .max(LIMITS.avatar)
  .refine(isSingleGrapheme, { message: 'avatar must be exactly one grapheme cluster' });
export const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, {
  message: '#RRGGBB or #RRGGBBAA',
});

export const householdRoleSchema = z.enum(['adult', 'child']);
export const householdPermissionSchema = z.enum(['owner', 'admin', 'member']);
export const invitablePermissionSchema = z.enum(['admin', 'member']);
export const taskAudienceSchema = z.enum(['adults', 'children', 'everyone']);

export const recurrenceSchema = z.object({
  preset: z.enum(['hourly', 'daily', 'weekly', 'monthly', 'custom']),
  unit: z.enum(['hours', 'days', 'weeks', 'months']),
  interval: z.number().int().positive().max(10_000),
});

/** Optional `If-Match: <rowVersion>` (header is bare digits or quoted ETag form). */
export function parseIfMatch(header: string | undefined): number | null {
  if (!header) return null;
  const stripped = header.replace(/^"|"$/g, '');
  const n = Number(stripped);
  return Number.isFinite(n) && n > 0 ? n : null;
}
