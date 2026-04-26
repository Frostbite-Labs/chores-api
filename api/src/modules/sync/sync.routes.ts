/**
 * Sync protocol. Spec §9.
 *
 * Pull: stream upserts (`row_version > since`) and tombstones
 *       (`deleted_row_version > since`) for each child entity, plus the
 *       household if the household row itself bumped past `since`. We keep
 *       under the 1MB byte budget and emit `hasMore` + `nextSince` if not.
 *
 * Push: each operation runs in its own transaction. Server-wins on
 *       updates (returns `current` on stale ifMatch); completions never
 *       conflict with each other (append-only) — the only failure modes
 *       are a missing task or lost permission.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseBody, parseParams, parseQuery } from '@/middleware/validate.js';
import { getDb } from '@/db/pool.js';
import { binToUuid, newUuid, uuidToBin } from '@/lib/ids.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors.js';
import { addInterval } from '@/lib/time.js';
import { SYNC_PAGE_BYTE_BUDGET } from '@/config/constants.js';
import { uuidSchema } from '@/schemas/common.js';
import { syncPullQuerySchema, syncPushBodySchema, type SyncPushOp } from '@/schemas/sync.js';
import { rowToHousehold, rowToMember, bumpHouseholdVersion } from '@/db/repositories/households.js';
import { rowToCompletion, rowToTask } from '@/db/repositories/tasks.js';
import type { HouseholdMember } from '@/types/member.js';
import type { SyncDelta, SyncPushResponse, SyncPushResult } from '@/types/sync.js';
import { audit } from '@/lib/audit.js';

const householdParamsSchema = z.object({ householdId: uuidSchema });

export async function registerSyncRoutes(app: FastifyInstance): Promise<void> {
  // GET /sync — 🔒 + member
  app.get(
    '/households/:householdId/sync',
    { config: { requiresAuth: true, requiresHouseholdPermission: 'member', rateLimitBucket: 'authedDefault' } },
    async (req) => buildPull(req),
  );

  // POST /sync — 🔒 + member
  app.post(
    '/households/:householdId/sync',
    { config: { requiresAuth: true, requiresHouseholdPermission: 'member', rateLimitBucket: 'writeHotPath' } },
    async (req) => applyPush(req),
  );
}

async function buildPull(req: FastifyRequest): Promise<SyncDelta> {
  const params = parseParams(householdParamsSchema, req);
  const query = parseQuery(syncPullQuerySchema, req);
  const since = query.since;
  const householdIdBin = uuidToBin(params.householdId);
  const db = getDb();

  const household = await db
    .selectFrom('households')
    .selectAll()
    .where('id', '=', householdIdBin)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!household) throw new NotFoundError({ code: 'household.not_found', detail: 'Household not found.' });

  const [memberRows, taskRows, completionRows, tombstones] = await Promise.all([
    db
      .selectFrom('household_members')
      .selectAll()
      .where('household_id', '=', householdIdBin)
      .where('row_version', '>', since)
      .where('removed_at', 'is', null)
      .orderBy('row_version', 'asc')
      .execute(),
    db
      .selectFrom('tasks')
      .selectAll()
      .where('household_id', '=', householdIdBin)
      .where('row_version', '>', since)
      .where('deleted_at', 'is', null)
      .orderBy('row_version', 'asc')
      .execute(),
    db
      .selectFrom('task_completions')
      .selectAll()
      .where('household_id', '=', householdIdBin)
      .where('row_version', '>', since)
      .orderBy('row_version', 'asc')
      .execute(),
    db
      .selectFrom('sync_tombstones')
      .selectAll()
      .where('household_id', '=', householdIdBin)
      .where('deleted_row_version', '>', since)
      .orderBy('deleted_row_version', 'asc')
      .execute(),
  ]);

  const members = memberRows.map(rowToMember);
  const tasks = taskRows.map(rowToTask);
  const completions = completionRows.map(rowToCompletion);

  const memberDeleted: string[] = [];
  const taskDeleted: string[] = [];
  const completionDeleted: string[] = [];
  for (const t of tombstones) {
    const id = binToUuid(t.entity_id);
    if (t.entity_type === 'member') memberDeleted.push(id);
    else if (t.entity_type === 'task') taskDeleted.push(id);
    else if (t.entity_type === 'completion') completionDeleted.push(id);
  }

  // Page by byte budget — once we exceed it, drop the trailing items in priority
  // order (completions first, since they're append-only and re-pull is cheap).
  const partial: SyncDelta = {
    rowVersion: Number(household.row_version),
    members: { upserted: members, deleted: memberDeleted },
    tasks: { upserted: tasks, deleted: taskDeleted },
    completions: { upserted: completions, deleted: completionDeleted },
    hasMore: false,
  };
  if (Number(household.row_version) > since) partial.household = rowToHousehold(household);

  let bytes = byteSize(partial);
  let hasMore = false;
  let cutoff: number | null = null;
  if (bytes > SYNC_PAGE_BYTE_BUDGET) {
    const allRowVersions = [
      ...members.map((m) => m.rowVersion),
      ...tasks.map((t) => t.rowVersion),
      ...completions.map((c) => c.rowVersion),
      ...tombstones.map((t) => Number(t.deleted_row_version)),
    ].sort((a, b) => a - b);
    let lo = 0;
    let hi = allRowVersions.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const v = allRowVersions[mid] ?? since;
      const candidate = sliceUpTo(partial, v);
      if (byteSize(candidate) <= SYNC_PAGE_BYTE_BUDGET) lo = mid + 1;
      else hi = mid;
    }
    cutoff = allRowVersions[Math.max(0, lo - 1)] ?? since;
    Object.assign(partial, sliceUpTo(partial, cutoff));
    hasMore = true;
    bytes = byteSize(partial);
  }
  partial.hasMore = hasMore;
  if (hasMore && cutoff !== null) partial.nextSince = cutoff;
  return partial;
}

function sliceUpTo(d: SyncDelta, version: number): SyncDelta {
  return {
    ...d,
    members: {
      upserted: d.members.upserted.filter((m) => m.rowVersion <= version),
      deleted: d.members.deleted, // keep — they're version-bounded by tombstone version, conservative is fine
    },
    tasks: {
      upserted: d.tasks.upserted.filter((t) => t.rowVersion <= version),
      deleted: d.tasks.deleted,
    },
    completions: {
      upserted: d.completions.upserted.filter((c) => c.rowVersion <= version),
      deleted: d.completions.deleted,
    },
  };
}

function byteSize(d: SyncDelta): number {
  return Buffer.byteLength(JSON.stringify(d), 'utf8');
}

async function applyPush(req: FastifyRequest): Promise<SyncPushResponse> {
  const params = parseParams(householdParamsSchema, req);
  const body = parseBody(syncPushBodySchema, req);
  const acting = req.appCtx.member as HouseholdMember;
  const userId = req.appCtx.user!.id;
  const results: SyncPushResult[] = [];

  for (const op of body.operations) {
    try {
      results.push(await applyOne(op, params.householdId, acting, userId));
    } catch (err) {
      // Translate to a per-operation rejected result rather than failing the
      // whole push — clients want partial progress.
      const r: SyncPushResult = { clientId: op.clientId, status: 'rejected' };
      if (err instanceof ConflictError) {
        r.status = 'conflict';
        r.code = err.code;
        const errors = err.errors as { current?: SyncPushResult['current'] } | undefined;
        if (errors?.current) r.current = errors.current;
      } else if (err instanceof ForbiddenError || err instanceof NotFoundError || err instanceof ValidationError) {
        r.code = err.code;
      } else {
        r.code = 'server.internal';
        req.log.error({ err, op }, 'sync push failed');
      }
      results.push(r);
    }
  }
  return { results };
}

async function applyOne(
  op: SyncPushOp,
  householdId: string,
  acting: HouseholdMember,
  userId: string,
): Promise<SyncPushResult> {
  const db = getDb();
  switch (op.kind) {
    case 'task.create': {
      requireAdmin(acting);
      const id = newUuid();
      const out = await db.transaction().execute(async (tx) => {
        await tx
          .insertInto('tasks')
          .values({
            id: uuidToBin(id),
            household_id: uuidToBin(householdId),
            title: op.payload.title,
            icon: op.payload.icon,
            notes: op.payload.notes ?? null,
            audience: op.payload.audience,
            points: op.payload.points,
            recurrence_preset: op.payload.recurrence.preset,
            recurrence_unit: op.payload.recurrence.unit,
            recurrence_interval: op.payload.recurrence.interval,
            next_due_at: op.payload.nextDueAt ? new Date(op.payload.nextDueAt) : new Date(),
            created_by_user_id: uuidToBin(userId),
          })
          .execute();
        await bumpHouseholdVersion(tx, householdId);
        return tx
          .selectFrom('tasks')
          .selectAll()
          .where('id', '=', uuidToBin(id))
          .executeTakeFirstOrThrow();
      });
      return { clientId: op.clientId, status: 'applied', serverId: id, rowVersion: Number(out.row_version) };
    }
    case 'task.update': {
      requireAdmin(acting);
      const out = await db.transaction().execute(async (tx) => {
        const current = await tx
          .selectFrom('tasks')
          .selectAll()
          .where('id', '=', uuidToBin(op.payload.id))
          .where('household_id', '=', uuidToBin(householdId))
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (!current) throw new NotFoundError({ code: 'task.not_found', detail: 'Task not found.' });
        if (op.ifMatchRowVersion !== undefined && op.ifMatchRowVersion !== Number(current.row_version)) {
          throw new ConflictError({
            code: 'concurrency.row_version_stale',
            detail: 'task.update — row_version stale',
            errors: { current: rowToTask(current) },
          });
        }
        const set: Record<string, unknown> = {};
        const p = op.payload.patch;
        if (p.title !== undefined) set['title'] = p.title;
        if (p.icon !== undefined) set['icon'] = p.icon;
        if (p.notes !== undefined) set['notes'] = p.notes;
        if (p.audience !== undefined) set['audience'] = p.audience;
        if (p.points !== undefined) set['points'] = p.points;
        if (p.recurrence) {
          set['recurrence_preset'] = p.recurrence.preset;
          set['recurrence_unit'] = p.recurrence.unit;
          set['recurrence_interval'] = p.recurrence.interval;
        }
        if (p.nextDueAt) set['next_due_at'] = new Date(p.nextDueAt);
        set['row_version'] = Number(current.row_version) + 1;
        await tx
          .updateTable('tasks')
          .set(set)
          .where('id', '=', uuidToBin(op.payload.id))
          .execute();
        await bumpHouseholdVersion(tx, householdId);
        return tx
          .selectFrom('tasks')
          .selectAll()
          .where('id', '=', uuidToBin(op.payload.id))
          .executeTakeFirstOrThrow();
      });
      return { clientId: op.clientId, status: 'applied', serverId: op.payload.id, rowVersion: Number(out.row_version) };
    }
    case 'task.delete': {
      requireAdmin(acting);
      await db.transaction().execute(async (tx) => {
        const updated = await tx
          .updateTable('tasks')
          .set({ deleted_at: new Date() })
          .where('id', '=', uuidToBin(op.payload.id))
          .where('household_id', '=', uuidToBin(householdId))
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (Number(updated?.numUpdatedRows ?? 0) === 0) {
          throw new NotFoundError({ code: 'task.not_found', detail: 'Task not found.' });
        }
        const v = await bumpHouseholdVersion(tx, householdId);
        await tx
          .insertInto('sync_tombstones')
          .values({
            household_id: uuidToBin(householdId),
            entity_type: 'task',
            entity_id: uuidToBin(op.payload.id),
            deleted_row_version: v,
          })
          .onDuplicateKeyUpdate({ deleted_row_version: v, deleted_at: new Date() })
          .execute();
      });
      return { clientId: op.clientId, status: 'applied', serverId: op.payload.id };
    }
    case 'completion.create': {
      // Append-only — never conflicts; only fails on missing task or lost permission.
      const id = newUuid();
      const out = await db.transaction().execute(async (tx) => {
        const task = await tx
          .selectFrom('tasks')
          .selectAll()
          .where('id', '=', uuidToBin(op.payload.taskId))
          .where('household_id', '=', uuidToBin(householdId))
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (!task) throw new NotFoundError({ code: 'task.not_found', detail: 'Task not found.' });
        if (op.ifMatchTaskRowVersion !== undefined && op.ifMatchTaskRowVersion !== Number(task.row_version)) {
          // Server-wins per spec — completions never conflict, but the client
          // wanted to bind to a specific task version; we still apply (it's
          // safe — completions are append-only) but report the new version.
        }
        const member = await tx
          .selectFrom('household_members')
          .selectAll()
          .where('id', '=', uuidToBin(op.payload.memberId))
          .where('household_id', '=', uuidToBin(householdId))
          .where('removed_at', 'is', null)
          .executeTakeFirst();
        if (!member) throw new NotFoundError({ code: 'member.not_found', detail: 'Member not found.' });
        if (member.id.equals(uuidToBin(acting.id)) === false && acting.permission === 'member') {
          throw new ForbiddenError({
            code: 'completion.behalf_requires_admin',
            detail: 'Only admins or owners can record completions on behalf of another member.',
          });
        }
        const completedAt = op.payload.completedAt ? new Date(op.payload.completedAt) : new Date();
        await tx
          .insertInto('task_completions')
          .values({
            id: uuidToBin(id),
            household_id: uuidToBin(householdId),
            task_id: task.id,
            member_id: member.id,
            completed_by_user_id: member.user_id ?? uuidToBin(userId),
            completed_at: completedAt,
            points_awarded: task.points,
            task_title_snapshot: task.title,
            task_icon_snapshot: task.icon,
          })
          .execute();
        const nextDue = addInterval(completedAt, {
          preset: task.recurrence_preset,
          unit: task.recurrence_unit,
          interval: task.recurrence_interval,
        });
        await tx
          .updateTable('tasks')
          .set((eb) => ({ next_due_at: nextDue, row_version: eb('row_version', '+', 1) }))
          .where('id', '=', task.id)
          .execute();
        await bumpHouseholdVersion(tx, householdId);
        return tx
          .selectFrom('task_completions')
          .selectAll()
          .where('id', '=', uuidToBin(id))
          .executeTakeFirstOrThrow();
      });
      return { clientId: op.clientId, status: 'applied', serverId: id, rowVersion: Number(out.row_version) };
    }
    case 'completion.delete': {
      requireAdmin(acting);
      await db.transaction().execute(async (tx) => {
        const completion = await tx
          .selectFrom('task_completions')
          .selectAll()
          .where('id', '=', uuidToBin(op.payload.id))
          .where('household_id', '=', uuidToBin(householdId))
          .executeTakeFirst();
        if (!completion) throw new NotFoundError({ code: 'completion.not_found', detail: 'Completion not found.' });
        await tx.deleteFrom('task_completions').where('id', '=', uuidToBin(op.payload.id)).execute();
        const v = await bumpHouseholdVersion(tx, householdId);
        await tx
          .insertInto('sync_tombstones')
          .values({
            household_id: uuidToBin(householdId),
            entity_type: 'completion',
            entity_id: uuidToBin(op.payload.id),
            deleted_row_version: v,
          })
          .onDuplicateKeyUpdate({ deleted_row_version: v, deleted_at: new Date() })
          .execute();
      });
      return { clientId: op.clientId, status: 'applied', serverId: op.payload.id };
    }
    case 'member.create': {
      requireAdmin(acting);
      const id = newUuid();
      const out = await db.transaction().execute(async (tx) => {
        await tx
          .insertInto('household_members')
          .values({
            id: uuidToBin(id),
            household_id: uuidToBin(householdId),
            user_id: null,
            role: op.payload.role,
            permission: 'member',
            display_name: op.payload.displayName,
            avatar: op.payload.avatar,
            color: op.payload.color ?? '#10B981',
          })
          .execute();
        await bumpHouseholdVersion(tx, householdId);
        return tx
          .selectFrom('household_members')
          .selectAll()
          .where('id', '=', uuidToBin(id))
          .executeTakeFirstOrThrow();
      });
      await audit(getDb(), { actorUserId: userId, householdId, action: 'member.create', targetType: 'member', targetId: id });
      return { clientId: op.clientId, status: 'applied', serverId: id, rowVersion: Number(out.row_version) };
    }
    case 'member.update': {
      requireAdmin(acting);
      const out = await db.transaction().execute(async (tx) => {
        const current = await tx
          .selectFrom('household_members')
          .selectAll()
          .where('id', '=', uuidToBin(op.payload.id))
          .where('household_id', '=', uuidToBin(householdId))
          .where('removed_at', 'is', null)
          .executeTakeFirst();
        if (!current) throw new NotFoundError({ code: 'member.not_found', detail: 'Member not found.' });
        if (op.ifMatchRowVersion !== undefined && op.ifMatchRowVersion !== Number(current.row_version)) {
          throw new ConflictError({
            code: 'concurrency.row_version_stale',
            detail: 'member.update — row_version stale',
            errors: { current: rowToMember(current) },
          });
        }
        const p = op.payload.patch;
        const set: Record<string, unknown> = {};
        if (p.displayName !== undefined) set['display_name'] = p.displayName;
        if (p.avatar !== undefined) set['avatar'] = p.avatar;
        if (p.role !== undefined) set['role'] = p.role;
        if (p.color !== undefined) set['color'] = p.color;
        if (p.permission !== undefined) {
          if (acting.permission !== 'owner') {
            throw new ForbiddenError({
              code: 'household.permission_denied',
              detail: 'Only the owner can change permission via sync.',
            });
          }
          set['permission'] = p.permission;
        }
        set['row_version'] = Number(current.row_version) + 1;
        await tx
          .updateTable('household_members')
          .set(set)
          .where('id', '=', uuidToBin(op.payload.id))
          .execute();
        await bumpHouseholdVersion(tx, householdId);
        return tx
          .selectFrom('household_members')
          .selectAll()
          .where('id', '=', uuidToBin(op.payload.id))
          .executeTakeFirstOrThrow();
      });
      return { clientId: op.clientId, status: 'applied', serverId: op.payload.id, rowVersion: Number(out.row_version) };
    }
    case 'member.delete': {
      requireAdmin(acting);
      await db.transaction().execute(async (tx) => {
        const current = await tx
          .selectFrom('household_members')
          .selectAll()
          .where('id', '=', uuidToBin(op.payload.id))
          .where('household_id', '=', uuidToBin(householdId))
          .where('removed_at', 'is', null)
          .executeTakeFirst();
        if (!current) throw new NotFoundError({ code: 'member.not_found', detail: 'Member not found.' });
        if (current.permission === 'owner') {
          throw new ConflictError({ code: 'member.cannot_remove_owner', detail: 'Transfer ownership first.' });
        }
        await tx
          .updateTable('household_members')
          .set({ removed_at: new Date() })
          .where('id', '=', uuidToBin(op.payload.id))
          .execute();
        const v = await bumpHouseholdVersion(tx, householdId);
        await tx
          .insertInto('sync_tombstones')
          .values({
            household_id: uuidToBin(householdId),
            entity_type: 'member',
            entity_id: uuidToBin(op.payload.id),
            deleted_row_version: v,
          })
          .onDuplicateKeyUpdate({ deleted_row_version: v, deleted_at: new Date() })
          .execute();
      });
      return { clientId: op.clientId, status: 'applied', serverId: op.payload.id };
    }
    default: {
      const _never: never = op;
      return _never;
    }
  }
}

function requireAdmin(acting: HouseholdMember): void {
  if (acting.permission === 'member') {
    throw new ForbiddenError({
      code: 'household.permission_denied',
      detail: 'This sync operation requires admin permission.',
    });
  }
}
