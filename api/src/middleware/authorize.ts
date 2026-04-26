/**
 * Household-permission gate. After auth, this hook runs on routes whose
 * `config.requiresHouseholdPermission` is set, loads `household_members` for
 * `(user.id, params.householdId)`, and rejects with 403 if either:
 *
 *  - the user is not a member, or
 *  - the user's permission is below the required level.
 *
 * It also attaches the resolved member to `req.appCtx.member` so handlers
 * don't need to re-query.
 *
 * Spec §5.3 - and the "missing decorators fail closed in CI" rule is enforced
 * by `test/permission-coverage.test.ts`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ForbiddenError, NotFoundError } from '@/lib/errors.js';
import { getDb } from '@/db/pool.js';
import { binToUuid, uuidToBin, isUuid } from '@/lib/ids.js';
import type { HouseholdPermission } from '@/types/household.js';
import type { HouseholdMember } from '@/types/member.js';

const RANK: Record<HouseholdPermission, number> = { member: 1, admin: 2, owner: 3 };

export async function loadAndAssertMembership(
  req: FastifyRequest,
  required: HouseholdPermission,
): Promise<HouseholdMember> {
  if (!req.appCtx?.user) {
    throw new ForbiddenError({ code: 'auth.required', detail: 'Authentication is required for this route.' });
  }
  const params = req.params as { householdId?: string };
  const householdId = params?.householdId;
  if (!householdId || !isUuid(householdId)) {
    throw new NotFoundError({ code: 'household.not_found', detail: 'Household id missing or invalid.' });
  }

  const db = getDb();
  const row = await db
    .selectFrom('household_members')
    .selectAll()
    .where('household_id', '=', uuidToBin(householdId))
    .where('user_id', '=', uuidToBin(req.appCtx.user.id))
    .where('removed_at', 'is', null)
    .executeTakeFirst();

  if (!row) {
    throw new ForbiddenError({ code: 'household.not_a_member', detail: 'You are not a member of this household.' });
  }

  if (RANK[row.permission] < RANK[required]) {
    throw new ForbiddenError({
      code: 'household.permission_denied',
      detail: `This action requires ${required} permission.`,
    });
  }

  const member: HouseholdMember = rowToMember(row);
  req.appCtx.member = member;
  return member;
}

export function registerAuthorizeHook(app: FastifyInstance): void {
  app.addHook('preHandler', async (req) => {
    const cfg = req.routeOptions.config as { requiresHouseholdPermission?: HouseholdPermission } | undefined;
    if (cfg?.requiresHouseholdPermission) {
      await loadAndAssertMembership(req, cfg.requiresHouseholdPermission);
    }
  });
}

export function rowToMember(row: {
  id: Buffer;
  household_id: Buffer;
  user_id: Buffer | null;
  role: 'adult' | 'child';
  permission: HouseholdPermission;
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
