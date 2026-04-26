/**
 * `/v1/households/*` routes. Spec §8.3.
 *
 * On `POST /households` the caller becomes both `owner` permission and a
 * member with their stored display_name/avatar - atomic transaction.
 */
import type { FastifyInstance } from 'fastify';
import { parseBody, parseParams } from '@/middleware/validate.js';
import { z } from 'zod';
import { getDb } from '@/db/pool.js';
import { uuidToBin, newUuid, isUuid } from '@/lib/ids.js';
import { ConflictError, NotFoundError } from '@/lib/errors.js';
import { audit } from '@/lib/audit.js';
import {
  createHouseholdSchema,
  renameHouseholdSchema,
  transferOwnershipSchema,
} from '@/schemas/households.js';
import { uuidSchema } from '@/schemas/common.js';
import { parseIfMatch } from '@/schemas/common.js';
import { rowToHousehold, rowToMember, bumpHouseholdVersion } from '@/db/repositories/households.js';

const householdParamsSchema = z.object({ householdId: uuidSchema });

export async function registerHouseholdsRoutes(app: FastifyInstance): Promise<void> {
  // POST /households - 🔒
  app.post(
    '/households',
    { config: { requiresAuth: true, rateLimitBucket: 'authedDefault' } },
    async (req, reply) => {
      const body = parseBody(createHouseholdSchema, req);
      const userId = req.appCtx.user!.id;
      const householdId = newUuid();
      const memberId = newUuid();
      const db = getDb();

      const result = await db.transaction().execute(async (tx) => {
        const user = await tx
          .selectFrom('users')
          .select(['display_name', 'avatar'])
          .where('id', '=', uuidToBin(userId))
          .where('deleted_at', 'is', null)
          .executeTakeFirstOrThrow();

        await tx
          .insertInto('households')
          .values({
            id: uuidToBin(householdId),
            name: body.name,
            owner_user_id: uuidToBin(userId),
          })
          .execute();
        await tx
          .insertInto('household_members')
          .values({
            id: uuidToBin(memberId),
            household_id: uuidToBin(householdId),
            user_id: uuidToBin(userId),
            role: 'adult',
            permission: 'owner',
            display_name: user.display_name,
            avatar: user.avatar,
            color: '#3B82F6',
          })
          .execute();
        const household = await tx
          .selectFrom('households')
          .selectAll()
          .where('id', '=', uuidToBin(householdId))
          .executeTakeFirstOrThrow();
        const member = await tx
          .selectFrom('household_members')
          .selectAll()
          .where('id', '=', uuidToBin(memberId))
          .executeTakeFirstOrThrow();
        return { household, member };
      });

      await audit(getDb(), {
        actorUserId: userId,
        householdId,
        action: 'household.create',
        targetType: 'household',
        targetId: householdId,
      });
      reply.code(201);
      return { household: rowToHousehold(result.household), member: rowToMember(result.member) };
    },
  );

  // GET /households/:id - 🔒 + member
  app.get(
    '/households/:householdId',
    { config: { requiresAuth: true, requiresHouseholdPermission: 'member', rateLimitBucket: 'authedDefault' } },
    async (req, reply) => {
      const params = parseParams(householdParamsSchema, req);
      const row = await getDb()
        .selectFrom('households')
        .selectAll()
        .where('id', '=', uuidToBin(params.householdId))
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!row) throw new NotFoundError({ code: 'household.not_found', detail: 'Household not found.' });
      const household = rowToHousehold(row);
      reply.header('ETag', `"${household.rowVersion}"`);
      return household;
    },
  );

  // PATCH /households/:id - 🔒 + admin
  app.patch(
    '/households/:householdId',
    { config: { requiresAuth: true, requiresHouseholdPermission: 'admin', rateLimitBucket: 'writeHotPath' } },
    async (req, reply) => {
      const params = parseParams(householdParamsSchema, req);
      const body = parseBody(renameHouseholdSchema, req);
      const ifMatch = parseIfMatch(req.headers['if-match'] as string | undefined);

      const db = getDb();
      const updated = await db.transaction().execute(async (tx) => {
        const current = await tx
          .selectFrom('households')
          .selectAll()
          .where('id', '=', uuidToBin(params.householdId))
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (!current) throw new NotFoundError({ code: 'household.not_found', detail: 'Household not found.' });
        if (ifMatch !== null && ifMatch !== Number(current.row_version)) {
          throw new ConflictError({
            code: 'concurrency.row_version_stale',
            detail: 'If-Match did not match the current row_version.',
            errors: { current: rowToHousehold(current) },
          });
        }
        const set: Record<string, unknown> = {};
        if (body.name !== undefined) set['name'] = body.name;
        if (Object.keys(set).length > 0) {
          await tx
            .updateTable('households')
            .set(set)
            .where('id', '=', uuidToBin(params.householdId))
            .execute();
        }
        await bumpHouseholdVersion(tx, params.householdId);
        return tx
          .selectFrom('households')
          .selectAll()
          .where('id', '=', uuidToBin(params.householdId))
          .executeTakeFirstOrThrow();
      });

      await audit(getDb(), {
        actorUserId: req.appCtx.user!.id,
        householdId: params.householdId,
        action: 'household.update',
        targetType: 'household',
        targetId: params.householdId,
        metadata: { changes: body },
      });
      const out = rowToHousehold(updated);
      reply.header('ETag', `"${out.rowVersion}"`);
      return out;
    },
  );

  // POST /households/:id/transfer-ownership - 🔒 + owner
  app.post(
    '/households/:householdId/transfer-ownership',
    { config: { requiresAuth: true, requiresHouseholdPermission: 'owner', rateLimitBucket: 'authedDefault' } },
    async (req) => {
      const params = parseParams(householdParamsSchema, req);
      const body = parseBody(transferOwnershipSchema, req);
      if (!isUuid(body.toMemberId)) {
        throw new NotFoundError({ code: 'member.not_found', detail: 'Target member not found.' });
      }
      const db = getDb();
      const householdId = params.householdId;
      const userId = req.appCtx.user!.id;

      const result = await db.transaction().execute(async (tx) => {
        const target = await tx
          .selectFrom('household_members')
          .selectAll()
          .where('id', '=', uuidToBin(body.toMemberId))
          .where('household_id', '=', uuidToBin(householdId))
          .where('removed_at', 'is', null)
          .executeTakeFirst();
        if (!target || !target.user_id) {
          throw new NotFoundError({
            code: 'member.transfer_target_invalid',
            detail: 'Target must be an account-backed member of this household.',
          });
        }
        // Demote current owner-permission rows to admin, promote target.
        await tx
          .updateTable('household_members')
          .set({ permission: 'admin' })
          .where('household_id', '=', uuidToBin(householdId))
          .where('permission', '=', 'owner')
          .execute();
        await tx
          .updateTable('household_members')
          .set({ permission: 'owner', role: 'adult' })
          .where('id', '=', uuidToBin(body.toMemberId))
          .execute();
        await tx
          .updateTable('households')
          .set({ owner_user_id: target.user_id })
          .where('id', '=', uuidToBin(householdId))
          .execute();
        await bumpHouseholdVersion(tx, householdId);
        return tx
          .selectFrom('households')
          .selectAll()
          .where('id', '=', uuidToBin(householdId))
          .executeTakeFirstOrThrow();
      });

      await audit(getDb(), {
        actorUserId: userId,
        householdId,
        action: 'household.transfer_ownership',
        targetType: 'member',
        targetId: body.toMemberId,
      });
      return rowToHousehold(result);
    },
  );

  // DELETE /households/:id - 🔒 + owner
  app.delete(
    '/households/:householdId',
    { config: { requiresAuth: true, requiresHouseholdPermission: 'owner', rateLimitBucket: 'authedDefault' } },
    async (req, reply) => {
      const params = parseParams(householdParamsSchema, req);
      const db = getDb();
      await db.transaction().execute(async (tx) => {
        const now = new Date();
        await tx
          .updateTable('households')
          .set({ deleted_at: now })
          .where('id', '=', uuidToBin(params.householdId))
          .where('deleted_at', 'is', null)
          .execute();
        await tx
          .updateTable('tasks')
          .set({ deleted_at: now })
          .where('household_id', '=', uuidToBin(params.householdId))
          .where('deleted_at', 'is', null)
          .execute();
        await tx
          .updateTable('household_invites')
          .set({ revoked_at: now })
          .where('household_id', '=', uuidToBin(params.householdId))
          .where('revoked_at', 'is', null)
          .execute();
      });
      await audit(getDb(), {
        actorUserId: req.appCtx.user!.id,
        householdId: params.householdId,
        action: 'household.delete',
        targetType: 'household',
        targetId: params.householdId,
      });
      reply.code(204).send();
    },
  );
}
