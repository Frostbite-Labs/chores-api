/**
 * Invite codes (spec §8.5). The plaintext code is returned exactly once at
 * creation; subsequent listings expose only metadata. Redemption is the only
 * top-level (non-household-scoped) auth route here, because the redeemer
 * doesn't know the household until the code resolves.
 */
import type { FastifyInstance } from 'fastify';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { parseBody, parseParams } from '@/middleware/validate.js';
import { getDb } from '@/db/pool.js';
import { newUuid, uuidToBin, binToUuid } from '@/lib/ids.js';
import { ConflictError, NotFoundError } from '@/lib/errors.js';
import { audit } from '@/lib/audit.js';
import { uuidSchema } from '@/schemas/common.js';
import { createInviteSchema, redeemInviteSchema } from '@/schemas/invites.js';
import {
  INVITE_ALPHABET,
  INVITE_CODE_LENGTH,
  INVITE_DEFAULT_EXPIRES_HOURS,
  INVITE_DEFAULT_MAX_USES,
} from '@/config/constants.js';
import { rowToHousehold, bumpHouseholdVersion } from '@/db/repositories/households.js';

const householdParamsSchema = z.object({ householdId: uuidSchema });
const inviteParamsSchema = z.object({ householdId: uuidSchema, inviteId: uuidSchema });

function generateCode(): string {
  let s = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    s += INVITE_ALPHABET[randomInt(0, INVITE_ALPHABET.length)];
  }
  return s;
}

export async function registerInvitesRoutes(app: FastifyInstance): Promise<void> {
  // POST /households/:id/invites - 🔒 + admin
  app.post(
    '/households/:householdId/invites',
    { config: { requiresAuth: true, requiresHouseholdPermission: 'admin', rateLimitBucket: 'authedDefault' } },
    async (req, reply) => {
      const params = parseParams(householdParamsSchema, req);
      const body = parseBody(createInviteSchema, req);
      const inviteId = newUuid();
      const expiresInHours = body.expiresInHours ?? INVITE_DEFAULT_EXPIRES_HOURS;
      const maxUses = body.maxUses ?? INVITE_DEFAULT_MAX_USES;
      const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
      const db = getDb();

      // Retry on the (extremely rare) code collision; surface as 500 only after several attempts.
      let code = generateCode();
      for (let attempts = 0; attempts < 5; attempts++) {
        try {
          await db
            .insertInto('household_invites')
            .values({
              id: uuidToBin(inviteId),
              household_id: uuidToBin(params.householdId),
              code,
              invited_email: body.invitedEmail ?? null,
              invited_role: body.role,
              invited_permission: body.permission,
              created_by_user_id: uuidToBin(req.appCtx.user!.id),
              max_uses: maxUses,
              expires_at: expiresAt,
            })
            .execute();
          break;
        } catch (err) {
          const e = err as { code?: string };
          if (e.code === 'ER_DUP_ENTRY' && attempts < 4) {
            code = generateCode();
            continue;
          }
          throw err;
        }
      }

      await audit(getDb(), {
        actorUserId: req.appCtx.user!.id,
        householdId: params.householdId,
        action: 'invite.create',
        targetType: 'invite',
        targetId: inviteId,
      });
      reply.code(201);
      return {
        invite: {
          id: inviteId,
          householdId: params.householdId,
          invitedEmail: body.invitedEmail ?? null,
          invitedRole: body.role,
          invitedPermission: body.permission,
          createdByUserId: req.appCtx.user!.id,
          maxUses,
          usedCount: 0,
          expiresAt: expiresAt.toISOString(),
          revokedAt: null,
          createdAt: new Date().toISOString(),
        },
        code,
      };
    },
  );

  // GET /households/:id/invites - 🔒 + admin
  app.get(
    '/households/:householdId/invites',
    { config: { requiresAuth: true, requiresHouseholdPermission: 'admin', rateLimitBucket: 'authedDefault' } },
    async (req) => {
      const params = parseParams(householdParamsSchema, req);
      const rows = await getDb()
        .selectFrom('household_invites')
        .selectAll()
        .where('household_id', '=', uuidToBin(params.householdId))
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', new Date())
        .where((eb) => eb('used_count', '<', eb.ref('max_uses')))
        .execute();
      return rows.map((r) => ({
        id: binToUuid(r.id),
        householdId: binToUuid(r.household_id),
        invitedEmail: r.invited_email,
        invitedRole: r.invited_role,
        invitedPermission: r.invited_permission,
        createdByUserId: binToUuid(r.created_by_user_id),
        maxUses: r.max_uses,
        usedCount: r.used_count,
        expiresAt: r.expires_at.toISOString(),
        revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
        createdAt: r.created_at.toISOString(),
      }));
    },
  );

  // DELETE /households/:id/invites/:inviteId - 🔒 + admin
  app.delete(
    '/households/:householdId/invites/:inviteId',
    { config: { requiresAuth: true, requiresHouseholdPermission: 'admin', rateLimitBucket: 'authedDefault' } },
    async (req, reply) => {
      const params = parseParams(inviteParamsSchema, req);
      await getDb()
        .updateTable('household_invites')
        .set({ revoked_at: new Date() })
        .where('id', '=', uuidToBin(params.inviteId))
        .where('household_id', '=', uuidToBin(params.householdId))
        .where('revoked_at', 'is', null)
        .execute();
      reply.code(204).send();
    },
  );

  // POST /invites/redeem - 🔒 (NOT under :householdId; the redeemer doesn't know it).
  app.post(
    '/invites/redeem',
    { config: { requiresAuth: true, rateLimitBucket: 'inviteRedeem' } },
    async (req) => {
      const body = parseBody(redeemInviteSchema, req);
      const userId = req.appCtx.user!.id;
      const db = getDb();

      const result = await db.transaction().execute(async (tx) => {
        const invite = await tx
          .selectFrom('household_invites')
          .selectAll()
          .where('code', '=', body.code)
          .forUpdate()
          .executeTakeFirst();
        if (!invite) throw new NotFoundError({ code: 'invite.not_found', detail: 'Unknown invite code.' });
        if (invite.revoked_at) {
          throw new ConflictError({ code: 'invite.revoked', detail: 'Invite has been revoked.' });
        }
        if (invite.expires_at.getTime() < Date.now()) {
          throw new ConflictError({ code: 'invite.expired', detail: 'Invite has expired.' });
        }
        if (invite.used_count >= invite.max_uses) {
          throw new ConflictError({ code: 'invite.exhausted', detail: 'Invite has been fully used.' });
        }

        const householdId = binToUuid(invite.household_id);

        // If user is already a (non-removed) member, fast-path: bump used_count and return household.
        const existing = await tx
          .selectFrom('household_members')
          .selectAll()
          .where('household_id', '=', invite.household_id)
          .where('user_id', '=', uuidToBin(userId))
          .where('removed_at', 'is', null)
          .executeTakeFirst();

        let memberRow = existing;
        if (!memberRow) {
          const user = await tx
            .selectFrom('users')
            .select(['display_name', 'avatar'])
            .where('id', '=', uuidToBin(userId))
            .executeTakeFirstOrThrow();
          const memberId = newUuid();
          await tx
            .insertInto('household_members')
            .values({
              id: uuidToBin(memberId),
              household_id: invite.household_id,
              user_id: uuidToBin(userId),
              role: invite.invited_role,
              permission: invite.invited_permission,
              display_name: user.display_name,
              avatar: user.avatar,
              color: '#F59E0B',
            })
            .execute();
          memberRow = await tx
            .selectFrom('household_members')
            .selectAll()
            .where('id', '=', uuidToBin(memberId))
            .executeTakeFirstOrThrow();
        }

        await tx
          .updateTable('household_invites')
          .set((eb) => ({ used_count: eb('used_count', '+', 1) }))
          .where('id', '=', invite.id)
          .execute();

        await bumpHouseholdVersion(tx, householdId);

        const household = await tx
          .selectFrom('households')
          .selectAll()
          .where('id', '=', invite.household_id)
          .executeTakeFirstOrThrow();
        return { household, member: memberRow };
      });

      await audit(getDb(), {
        actorUserId: userId,
        householdId: binToUuid(result.household.id),
        action: 'invite.redeem',
        targetType: 'invite',
        metadata: { code: body.code },
      });
      return {
        household: rowToHousehold(result.household),
        member: {
          id: binToUuid(result.member.id),
          householdId: binToUuid(result.member.household_id),
          userId: result.member.user_id ? binToUuid(result.member.user_id) : null,
          role: result.member.role,
          permission: result.member.permission,
          displayName: result.member.display_name,
          avatar: result.member.avatar,
          color: result.member.color,
          joinedAt: result.member.joined_at.toISOString(),
          removedAt: result.member.removed_at ? result.member.removed_at.toISOString() : null,
          rowVersion: Number(result.member.row_version),
        },
      };
    },
  );
}
