/**
 * Completions hot-path. Spec §8.7.
 *
 * `POST /tasks/:taskId/completions` is the most-called write in the app, so:
 *   - Idempotency-Key support (cached response on retry, transparent to client).
 *   - All work in one transaction: insert completion, advance task.next_due_at,
 *     bump task.row_version and household.row_version.
 *   - "On behalf of" requires admin permission.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody, parseParams, parseQuery } from '@/middleware/validate.js';
import { getDb } from '@/db/pool.js';
import { binToUuid, newUuid, uuidToBin } from '@/lib/ids.js';
import { ForbiddenError, NotFoundError } from '@/lib/errors.js';
import { audit } from '@/lib/audit.js';
import { addInterval } from '@/lib/time.js';
import { uuidSchema } from '@/schemas/common.js';
import { completionsQuerySchema, createCompletionSchema } from '@/schemas/tasks.js';
import { COMPLETION_PAGE_DEFAULT, COMPLETION_PAGE_MAX } from '@/config/constants.js';
import { rowToCompletion, rowToTask } from '@/db/repositories/tasks.js';
import { bumpHouseholdVersion } from '@/db/repositories/households.js';
import * as idempotency from '@/middleware/idempotency.js';
import type { HouseholdMember } from '@/types/member.js';

const householdParamsSchema = z.object({ householdId: uuidSchema });
const taskParamsSchema = z.object({ householdId: uuidSchema, taskId: uuidSchema });
const completionParamsSchema = z.object({ householdId: uuidSchema, completionId: uuidSchema });

export async function registerCompletionsRoutes(app: FastifyInstance): Promise<void> {
  // POST /tasks/:taskId/completions — 🔒 + member (admin if memberId !== self)
  app.post(
    '/households/:householdId/tasks/:taskId/completions',
    { config: { requiresAuth: true, requiresHouseholdPermission: 'member', rateLimitBucket: 'writeHotPath' } },
    async (req, reply) => {
      const cached = await idempotency.lookup(req);
      if (cached) {
        reply.code(cached.status);
        return cached.body;
      }

      const params = parseParams(taskParamsSchema, req);
      const body = parseBody(createCompletionSchema, req);
      const acting = req.appCtx.member as HouseholdMember;
      const userId = req.appCtx.user!.id;

      const isSelf = acting.id === body.memberId;
      if (!isSelf && acting.permission === 'member') {
        throw new ForbiddenError({
          code: 'completion.behalf_requires_admin',
          detail: 'Only admins or owners can record completions on behalf of another member.',
        });
      }

      const db = getDb();
      const completedAt = body.completedAt ? new Date(body.completedAt) : new Date();
      const completionId = newUuid();

      const result = await db.transaction().execute(async (tx) => {
        const task = await tx
          .selectFrom('tasks')
          .selectAll()
          .where('id', '=', uuidToBin(params.taskId))
          .where('household_id', '=', uuidToBin(params.householdId))
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (!task) throw new NotFoundError({ code: 'task.not_found', detail: 'Task not found.' });

        const member = await tx
          .selectFrom('household_members')
          .selectAll()
          .where('id', '=', uuidToBin(body.memberId))
          .where('household_id', '=', uuidToBin(params.householdId))
          .where('removed_at', 'is', null)
          .executeTakeFirst();
        if (!member) throw new NotFoundError({ code: 'member.not_found', detail: 'Member not found.' });

        // Standalone members: completed_by_user_id captures the actor; if the
        // member is account-backed and the actor is that user, both fields point
        // at the same user — that's intentional (audit trail).
        await tx
          .insertInto('task_completions')
          .values({
            id: uuidToBin(completionId),
            household_id: uuidToBin(params.householdId),
            task_id: uuidToBin(params.taskId),
            member_id: uuidToBin(body.memberId),
            completed_by_user_id: member.user_id ? member.user_id : uuidToBin(userId),
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
          .where('id', '=', uuidToBin(params.taskId))
          .execute();

        await bumpHouseholdVersion(tx, params.householdId);

        const completion = await tx
          .selectFrom('task_completions')
          .selectAll()
          .where('id', '=', uuidToBin(completionId))
          .executeTakeFirstOrThrow();
        const taskAfter = await tx
          .selectFrom('tasks')
          .selectAll()
          .where('id', '=', uuidToBin(params.taskId))
          .executeTakeFirstOrThrow();
        return { completion, task: taskAfter };
      });

      await audit(getDb(), {
        actorUserId: userId,
        householdId: params.householdId,
        action: 'completion.create',
        targetType: 'completion',
        targetId: completionId,
      });

      const responseBody = { completion: rowToCompletion(result.completion), task: rowToTask(result.task) };
      reply.code(201);
      await idempotency.record(req, reply, responseBody);
      return responseBody;
    },
  );

  // GET /completions — 🔒 + member, cursor pagination over (completed_at, id).
  app.get(
    '/households/:householdId/completions',
    { config: { requiresAuth: true, requiresHouseholdPermission: 'member', rateLimitBucket: 'authedDefault' } },
    async (req, reply) => {
      const params = parseParams(householdParamsSchema, req);
      const query = parseQuery(completionsQuerySchema, req);
      const limit = Math.min(query.limit ?? COMPLETION_PAGE_DEFAULT, COMPLETION_PAGE_MAX);
      const db = getDb();

      let q = db
        .selectFrom('task_completions')
        .selectAll()
        .where('household_id', '=', uuidToBin(params.householdId));
      if (query.from) q = q.where('completed_at', '>=', new Date(query.from));
      if (query.to) q = q.where('completed_at', '<', new Date(query.to));
      if (query.memberId) q = q.where('member_id', '=', uuidToBin(query.memberId));
      if (query.taskId) q = q.where('task_id', '=', uuidToBin(query.taskId));
      if (query.cursor) {
        const decoded = decodeCursor(query.cursor);
        if (decoded) {
          q = q.where((eb) =>
            eb.or([
              eb('completed_at', '<', decoded.completedAt),
              eb.and([
                eb('completed_at', '=', decoded.completedAt),
                eb('id', '<', uuidToBin(decoded.id)),
              ]),
            ]),
          );
        }
      }
      const rows = await q
        .orderBy('completed_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1)
        .execute();

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      if (hasMore) {
        const last = page[page.length - 1]!;
        const cursor = encodeCursor({ completedAt: last.completed_at, id: binToUuid(last.id) });
        reply.header(
          'Link',
          `</v1/households/${params.householdId}/completions?cursor=${cursor}>; rel="next"`,
        );
      }
      return page.map(rowToCompletion);
    },
  );

  // DELETE /completions/:completionId — 🔒 + admin (hard delete; recompute next_due_at).
  app.delete(
    '/households/:householdId/completions/:completionId',
    { config: { requiresAuth: true, requiresHouseholdPermission: 'admin', rateLimitBucket: 'writeHotPath' } },
    async (req, reply) => {
      const params = parseParams(completionParamsSchema, req);
      const db = getDb();
      await db.transaction().execute(async (tx) => {
        const completion = await tx
          .selectFrom('task_completions')
          .selectAll()
          .where('id', '=', uuidToBin(params.completionId))
          .where('household_id', '=', uuidToBin(params.householdId))
          .executeTakeFirst();
        if (!completion) throw new NotFoundError({ code: 'completion.not_found', detail: 'Completion not found.' });

        await tx
          .deleteFrom('task_completions')
          .where('id', '=', uuidToBin(params.completionId))
          .execute();

        // Recompute next_due_at based on the most recent surviving completion of this task, if any.
        const task = await tx
          .selectFrom('tasks')
          .selectAll()
          .where('id', '=', completion.task_id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (task) {
          const last = await tx
            .selectFrom('task_completions')
            .select('completed_at')
            .where('task_id', '=', completion.task_id)
            .orderBy('completed_at', 'desc')
            .limit(1)
            .executeTakeFirst();
          const baseline = last?.completed_at ?? task.created_at;
          const nextDue = addInterval(baseline, {
            preset: task.recurrence_preset,
            unit: task.recurrence_unit,
            interval: task.recurrence_interval,
          });
          await tx
            .updateTable('tasks')
            .set((eb) => ({ next_due_at: nextDue, row_version: eb('row_version', '+', 1) }))
            .where('id', '=', completion.task_id)
            .execute();
        }
        const newVersion = await bumpHouseholdVersion(tx, params.householdId);
        await tx
          .insertInto('sync_tombstones')
          .values({
            household_id: uuidToBin(params.householdId),
            entity_type: 'completion',
            entity_id: uuidToBin(params.completionId),
            deleted_row_version: newVersion,
          })
          .onDuplicateKeyUpdate({ deleted_row_version: newVersion, deleted_at: new Date() })
          .execute();
      });
      await audit(getDb(), {
        actorUserId: req.appCtx.user!.id,
        householdId: params.householdId,
        action: 'completion.delete',
        targetType: 'completion',
        targetId: params.completionId,
      });
      reply.code(204).send();
    },
  );
}

function encodeCursor(c: { completedAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ t: c.completedAt.toISOString(), i: c.id }), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): { completedAt: Date; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed?.t !== 'string' || typeof parsed?.i !== 'string') return null;
    return { completedAt: new Date(parsed.t), id: parsed.i };
  } catch {
    return null;
  }
}
