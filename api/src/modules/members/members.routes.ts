/**
 * `/v1/households/:householdId/members` routes. Spec §8.4.
 *
 * Standalone members (`user_id IS NULL`) are created here. Account-backed
 * members are added by the invite-redemption flow, not by this endpoint.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody, parseParams } from '@/middleware/validate.js';
import { getDb } from '@/db/pool.js';
import { newUuid, uuidToBin } from '@/lib/ids.js';
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/errors.js';
import { audit } from '@/lib/audit.js';
import { uuidSchema } from '@/schemas/common.js';
import { createMemberSchema, patchMemberSchema } from '@/schemas/members.js';
import { rowToMember, bumpHouseholdVersion } from '@/db/repositories/households.js';
import type { HouseholdMember } from '@/types/member.js';

const memberParamsSchema = z.object({ householdId: uuidSchema, memberId: uuidSchema });
const householdParamsSchema = z.object({ householdId: uuidSchema });

export async function registerMembersRoutes(app: FastifyInstance): Promise<void> {
  // GET /households/:id/members - 🔒 + member
  app.get(
    '/households/:householdId/members',
    { config: { requiresAuth: true, requiresHouseholdPermission: 'member', rateLimitBucket: 'authedDefault' } },
    async (req) => {
      const params = parseParams(householdParamsSchema, req);
      const rows = await getDb()
        .selectFrom('household_members')
        .selectAll()
        .where('household_id', '=', uuidToBin(params.householdId))
        .where('removed_at', 'is', null)
        .execute();
      return rows.map(rowToMember);
    },
  );

  // POST /households/:id/members - 🔒 + admin (standalone members only)
  app.post(
    '/households/:householdId/members',
    { config: { requiresAuth: true, requiresHouseholdPermission: 'admin', rateLimitBucket: 'authedDefault' } },
    async (req, reply) => {
      const params = parseParams(householdParamsSchema, req);
      const body = parseBody(createMemberSchema, req);
      const memberId = newUuid();
      const db = getDb();
      const member = await db.transaction().execute(async (tx) => {
        await tx
          .insertInto('household_members')
          .values({
            id: uuidToBin(memberId),
            household_id: uuidToBin(params.householdId),
            user_id: null,
            role: body.role,
            permission: 'member',
            display_name: body.displayName,
            avatar: body.avatar,
            color: body.color ?? '#10B981',
          })
          .execute();
        await bumpHouseholdVersion(tx, params.householdId);
        return tx
          .selectFrom('household_members')
          .selectAll()
          .where('id', '=', uuidToBin(memberId))
          .executeTakeFirstOrThrow();
      });
      await audit(getDb(), {
        actorUserId: req.appCtx.user!.id,
        householdId: params.householdId,
        action: 'member.create',
        targetType: 'member',
        targetId: memberId,
      });
      reply.code(201);
      return rowToMember(member);
    },
  );

  // PATCH /households/:id/members/:memberId - 🔒 + admin (member can self-edit displayName/avatar/color)
  app.patch(
    '/households/:householdId/members/:memberId',
    { config: { requiresAuth: true, requiresHouseholdPermission: 'member', rateLimitBucket: 'authedDefault' } },
    async (req) => {
      const params = parseParams(memberParamsSchema, req);
      const body = parseBody(patchMemberSchema, req);
      const acting = req.appCtx.member as HouseholdMember;

      const isSelfEdit = acting.id === params.memberId;
      const wantsAdminFields =
        body.role !== undefined || body.permission !== undefined;
      const wantsPermissionChange = body.permission !== undefined;

      if (wantsAdminFields && acting.permission === 'member' && !isSelfEdit) {
        throw new ForbiddenError({
          code: 'household.permission_denied',
          detail: 'Only admins or owners can change role or permission.',
        });
      }
      if (wantsAdminFields && isSelfEdit) {
        throw new ForbiddenError({
          code: 'member.self_role_edit',
          detail: 'Members cannot change their own role or permission via this endpoint.',
        });
      }
      if (wantsPermissionChange && acting.permission !== 'owner') {
        throw new ForbiddenError({
          code: 'household.permission_denied',
          detail: 'Only the owner can change a member permission.',
        });
      }

      const db = getDb();
      const member = await db.transaction().execute(async (tx) => {
        const current = await tx
          .selectFrom('household_members')
          .selectAll()
          .where('id', '=', uuidToBin(params.memberId))
          .where('household_id', '=', uuidToBin(params.householdId))
          .where('removed_at', 'is', null)
          .executeTakeFirst();
        if (!current) throw new NotFoundError({ code: 'member.not_found', detail: 'Member not found.' });

        const set: Record<string, unknown> = {};
        if (body.displayName !== undefined) set['display_name'] = body.displayName;
        if (body.avatar !== undefined) set['avatar'] = body.avatar;
        if (body.color !== undefined) set['color'] = body.color;
        if (body.role !== undefined) set['role'] = body.role;
        if (body.permission !== undefined) {
          if (current.permission === 'owner') {
            throw new ConflictError({
              code: 'member.cannot_demote_owner',
              detail: 'Demote the owner via transfer-ownership instead.',
            });
          }
          set['permission'] = body.permission;
        }

        if (Object.keys(set).length > 0) {
          set['row_version'] = (current.row_version as unknown as number) + 1;
          await tx
            .updateTable('household_members')
            .set(set)
            .where('id', '=', uuidToBin(params.memberId))
            .execute();
        }
        await bumpHouseholdVersion(tx, params.householdId);
        return tx
          .selectFrom('household_members')
          .selectAll()
          .where('id', '=', uuidToBin(params.memberId))
          .executeTakeFirstOrThrow();
      });

      await audit(getDb(), {
        actorUserId: req.appCtx.user!.id,
        householdId: params.householdId,
        action: 'member.update',
        targetType: 'member',
        targetId: params.memberId,
        metadata: { changes: body },
      });
      return rowToMember(member);
    },
  );

  // DELETE /households/:id/members/:memberId - 🔒 + admin
  app.delete(
    '/households/:householdId/members/:memberId',
    { config: { requiresAuth: true, requiresHouseholdPermission: 'admin', rateLimitBucket: 'authedDefault' } },
    async (req, reply) => {
      const params = parseParams(memberParamsSchema, req);
      const db = getDb();
      await db.transaction().execute(async (tx) => {
        const current = await tx
          .selectFrom('household_members')
          .selectAll()
          .where('id', '=', uuidToBin(params.memberId))
          .where('household_id', '=', uuidToBin(params.householdId))
          .where('removed_at', 'is', null)
          .executeTakeFirst();
        if (!current) throw new NotFoundError({ code: 'member.not_found', detail: 'Member not found.' });
        if (current.permission === 'owner') {
          throw new ConflictError({
            code: 'member.cannot_remove_owner',
            detail: 'Transfer ownership before removing the owner.',
          });
        }
        await tx
          .updateTable('household_members')
          .set({ removed_at: new Date() })
          .where('id', '=', uuidToBin(params.memberId))
          .execute();
        const newVersion = await bumpHouseholdVersion(tx, params.householdId);
        await tx
          .insertInto('sync_tombstones')
          .values({
            household_id: uuidToBin(params.householdId),
            entity_type: 'member',
            entity_id: uuidToBin(params.memberId),
            deleted_row_version: newVersion,
          })
          .onDuplicateKeyUpdate({ deleted_row_version: newVersion, deleted_at: new Date() })
          .execute();
      });
      await audit(getDb(), {
        actorUserId: req.appCtx.user!.id,
        householdId: params.householdId,
        action: 'member.delete',
        targetType: 'member',
        targetId: params.memberId,
      });
      reply.code(204).send();
    },
  );
}
