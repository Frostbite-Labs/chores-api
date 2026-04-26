/**
 * Household + member row mappers and the household row-version bumper used by
 * mutations. Spec §4 — "row_version is bumped by application code inside the
 * same transaction as the write".
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '@/types/db.js';
import { binToUuid, uuidToBin } from '@/lib/ids.js';
import type { Household } from '@/types/household.js';
import type { HouseholdMember } from '@/types/member.js';

export function rowToHousehold(row: {
  id: Buffer;
  name: string;
  owner_user_id: Buffer;
  row_version: number | bigint;
  created_at: Date;
  updated_at: Date;
}): Household {
  return {
    id: binToUuid(row.id),
    name: row.name,
    ownerUserId: binToUuid(row.owner_user_id),
    rowVersion: Number(row.row_version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function rowToMember(row: {
  id: Buffer;
  household_id: Buffer;
  user_id: Buffer | null;
  role: 'adult' | 'child';
  permission: 'owner' | 'admin' | 'member';
  display_name: string;
  avatar: string;
  color: string;
  joined_at: Date;
  removed_at: Date | null;
  row_version: number | bigint;
}): HouseholdMember {
  return {
    id: binToUuid(row.id),
    householdId: binToUuid(row.household_id),
    userId: row.user_id ? binToUuid(row.user_id) : null,
    role: row.role,
    permission: row.permission,
    displayName: row.display_name,
    avatar: row.avatar,
    color: row.color,
    joinedAt: row.joined_at.toISOString(),
    removedAt: row.removed_at ? row.removed_at.toISOString() : null,
    rowVersion: Number(row.row_version),
  };
}

/**
 * Bump the household's row_version inside the supplied transaction. We use
 * `row_version + 1` rather than a sequence so single-statement atomicity is
 * preserved per row.
 */
export async function bumpHouseholdVersion(
  tx: Transaction<DB> | Kysely<DB>,
  householdId: string,
): Promise<number> {
  await tx
    .updateTable('households')
    .set((eb) => ({ row_version: eb('row_version', '+', 1) }))
    .where('id', '=', uuidToBin(householdId))
    .execute();
  const after = await tx
    .selectFrom('households')
    .select('row_version')
    .where('id', '=', uuidToBin(householdId))
    .executeTakeFirstOrThrow();
  return Number(after.row_version);
}
