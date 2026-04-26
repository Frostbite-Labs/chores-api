/**
 * `/v1/households/:householdId/tasks` routes. Spec §8.6.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody, parseParams, parseQuery } from '@/middleware/validate.js';
import { getDb } from '@/db/pool.js';
import { newUuid, uuidToBin } from '@/lib/ids.js';
import { ConflictError, NotFoundError } from '@/lib/errors.js';
import { audit } from '@/lib/audit.js';
import { uuidSchema, parseIfMatch } from '@/schemas/common.js';
import { createTaskSchema, patchTaskSchema, tasksQuerySchema } from '@/schemas/tasks.js';
import { rowToTask } from '@/db/repositories/tasks.js';
import { bumpHouseholdVersion } from '@/db/repositories/households.js';

const householdParamsSchema = z.object({ householdId: uuidSchema });
const taskParamsSchema = z.object({ householdId: uuidSchema, taskId: uuidSchema });

export async function registerTasksRoutes(app: FastifyInstance): Promise<void> {
  // GET /tasks - 🔒 + member
  app.get(
    '/households/:householdId/tasks',
    { config: { requiresAuth: true, requiresHouseholdPermission: 'member', rateLimitBucket: 'authedDefault' } },
    async (req) => {
      const params = parseParams(householdParamsSchema, req);
      const query = parseQuery(tasksQuerySchema, req);
      let q = getDb()
        .selectFrom('tasks')
        .selectAll()
        .where('household_id', '=', uuidToBin(params.householdId))
        .where('deleted_at', 'is', null);
      if (query.dueBefore) q = q.where('next_due_at', '<', new Date(query.dueBefore));
      if (query.audience) q = q.where('audience', '=', query.audience);
      const rows = await q.orderBy('next_due_at', 'asc').execute();
      return rows.map(rowToTask);
    },
  );

  // POST /tasks - 🔒 + admin
  app.post(
    '/households/:householdId/tasks',
    { config: { requiresAuth: true, requiresHouseholdPermission: 'admin', rateLimitBucket: 'writeHotPath' } },
    async (req, reply) => {
      const params = parseParams(householdParamsSchema, req);
      const body = parseBody(createTaskSchema, req);
      const taskId = newUuid();
      const db = getDb();
      const inserted = await db.transaction().execute(async (tx) => {
        await tx
          .insertInto('tasks')
          .values({
            id: uuidToBin(taskId),
            household_id: uuidToBin(params.householdId),
            title: body.title,
            icon: body.icon,
            notes: body.notes ?? null,
            audience: body.audience,
            points: body.points,
            recurrence_preset: body.recurrence.preset,
            recurrence_unit: body.recurrence.unit,
            recurrence_interval: body.recurrence.interval,
            next_due_at: body.nextDueAt ? new Date(body.nextDueAt) : new Date(),
            created_by_user_id: uuidToBin(req.appCtx.user!.id),
          })
          .execute();
        await bumpHouseholdVersion(tx, params.householdId);
        return tx
          .selectFrom('tasks')
          .selectAll()
          .where('id', '=', uuidToBin(taskId))
          .executeTakeFirstOrThrow();
      });
      await audit(getDb(), {
        actorUserId: req.appCtx.user!.id,
        householdId: params.householdId,
        action: 'task.create',
        targetType: 'task',
        targetId: taskId,
      });
      reply.code(201).header('ETag', `"${Number(inserted.row_version)}"`);
      return rowToTask(inserted);
    },
  );

  // GET /tasks/:taskId - 🔒 + member
  app.get(
    '/households/:householdId/tasks/:taskId',
    { config: { requiresAuth: true, requiresHouseholdPermission: 'member', rateLimitBucket: 'authedDefault' } },
    async (req, reply) => {
      const params = parseParams(taskParamsSchema, req);
      const row = await getDb()
        .selectFrom('tasks')
        .selectAll()
        .where('id', '=', uuidToBin(params.taskId))
        .where('household_id', '=', uuidToBin(params.householdId))
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!row) throw new NotFoundError({ code: 'task.not_found', detail: 'Task not found.' });
      const task = rowToTask(row);
      reply.header('ETag', `"${task.rowVersion}"`);
      return task;
    },
  );

  // PATCH /tasks/:taskId - 🔒 + admin (If-Match required)
  app.patch(
    '/households/:householdId/tasks/:taskId',
    { config: { requiresAuth: true, requiresHouseholdPermission: 'admin', rateLimitBucket: 'writeHotPath' } },
    async (req, reply) => {
      const params = parseParams(taskParamsSchema, req);
      const body = parseBody(patchTaskSchema, req);
      const ifMatch = parseIfMatch(req.headers['if-match'] as string | undefined);
      const db = getDb();
      const updated = await db.transaction().execute(async (tx) => {
        const current = await tx
          .selectFrom('tasks')
          .selectAll()
          .where('id', '=', uuidToBin(params.taskId))
          .where('household_id', '=', uuidToBin(params.householdId))
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (!current) throw new NotFoundError({ code: 'task.not_found', detail: 'Task not found.' });
        if (ifMatch !== null && ifMatch !== Number(current.row_version)) {
          throw new ConflictError({
            code: 'concurrency.row_version_stale',
            detail: 'If-Match did not match the current row_version.',
            errors: { current: rowToTask(current) },
          });
        }
        const set: Record<string, unknown> = {};
        if (body.title !== undefined) set['title'] = body.title;
        if (body.icon !== undefined) set['icon'] = body.icon;
        if (body.notes !== undefined) set['notes'] = body.notes;
        if (body.audience !== undefined) set['audience'] = body.audience;
        if (body.points !== undefined) set['points'] = body.points;
        if (body.recurrence !== undefined) {
          set['recurrence_preset'] = body.recurrence.preset;
          set['recurrence_unit'] = body.recurrence.unit;
          set['recurrence_interval'] = body.recurrence.interval;
        }
        if (body.nextDueAt !== undefined) set['next_due_at'] = new Date(body.nextDueAt);
        set['row_version'] = Number(current.row_version) + 1;
        await tx
          .updateTable('tasks')
          .set(set)
          .where('id', '=', uuidToBin(params.taskId))
          .execute();
        await bumpHouseholdVersion(tx, params.householdId);
        return tx
          .selectFrom('tasks')
          .selectAll()
          .where('id', '=', uuidToBin(params.taskId))
          .executeTakeFirstOrThrow();
      });
      await audit(getDb(), {
        actorUserId: req.appCtx.user!.id,
        householdId: params.householdId,
        action: 'task.update',
        targetType: 'task',
        targetId: params.taskId,
        metadata: { changes: body },
      });
      const out = rowToTask(updated);
      reply.header('ETag', `"${out.rowVersion}"`);
      return out;
    },
  );

  // DELETE /tasks/:taskId - 🔒 + admin
  app.delete(
    '/households/:householdId/tasks/:taskId',
    { config: { requiresAuth: true, requiresHouseholdPermission: 'admin', rateLimitBucket: 'writeHotPath' } },
    async (req, reply) => {
      const params = parseParams(taskParamsSchema, req);
      const db = getDb();
      await db.transaction().execute(async (tx) => {
        const updated = await tx
          .updateTable('tasks')
          .set({ deleted_at: new Date() })
          .where('id', '=', uuidToBin(params.taskId))
          .where('household_id', '=', uuidToBin(params.householdId))
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        const affected = Number(updated?.numUpdatedRows ?? 0);
        if (affected === 0) {
          throw new NotFoundError({ code: 'task.not_found', detail: 'Task not found.' });
        }
        const newVersion = await bumpHouseholdVersion(tx, params.householdId);
        await tx
          .insertInto('sync_tombstones')
          .values({
            household_id: uuidToBin(params.householdId),
            entity_type: 'task',
            entity_id: uuidToBin(params.taskId),
            deleted_row_version: newVersion,
          })
          .onDuplicateKeyUpdate({ deleted_row_version: newVersion, deleted_at: new Date() })
          .execute();
      });
      await audit(getDb(), {
        actorUserId: req.appCtx.user!.id,
        householdId: params.householdId,
        action: 'task.delete',
        targetType: 'task',
        targetId: params.taskId,
      });
      reply.code(204).send();
    },
  );
}
