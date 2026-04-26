/**
 * `/v1/me` endpoints. Spec §8.2.
 */
import type { FastifyInstance } from 'fastify';
import { parseBody } from '@/middleware/validate.js';
import { getDb } from '@/db/pool.js';
import { binToUuid, uuidToBin } from '@/lib/ids.js';
import { patchMeSchema } from '@/schemas/users.js';
import { getMe } from '../auth/auth.service.js';

export async function registerUsersRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me', { config: { requiresAuth: true, rateLimitBucket: 'authedDefault' } }, async (req) => {
    return getMe(req.appCtx.user!.id);
  });

  app.patch('/me', { config: { requiresAuth: true, rateLimitBucket: 'authedDefault' } }, async (req) => {
    const body = parseBody(patchMeSchema, req);
    const db = getDb();
    const updates: { display_name?: string; avatar?: string } = {};
    if (body.displayName !== undefined) updates.display_name = body.displayName;
    if (body.avatar !== undefined) updates.avatar = body.avatar;
    await db
      .updateTable('users')
      .set(updates)
      .where('id', '=', uuidToBin(req.appCtx.user!.id))
      .execute();
    return getMe(req.appCtx.user!.id);
  });

  app.get('/me/households', { config: { requiresAuth: true, rateLimitBucket: 'authedDefault' } }, async (req) => {
    const db = getDb();
    const rows = await db
      .selectFrom('household_members as hm')
      .innerJoin('households as h', 'h.id', 'hm.household_id')
      .select([
        'h.id as household_id',
        'h.name as household_name',
        'h.row_version as household_row_version',
        'h.owner_user_id',
        'hm.role',
        'hm.permission',
        'hm.id as member_id',
      ])
      .where('hm.user_id', '=', uuidToBin(req.appCtx.user!.id))
      .where('hm.removed_at', 'is', null)
      .where('h.deleted_at', 'is', null)
      .execute();
    return rows.map((r) => ({
      household: {
        id: binToUuid(r.household_id),
        name: r.household_name,
        ownerUserId: binToUuid(r.owner_user_id),
        rowVersion: Number(r.household_row_version),
      },
      memberId: binToUuid(r.member_id),
      role: r.role,
      permission: r.permission,
    }));
  });
}
