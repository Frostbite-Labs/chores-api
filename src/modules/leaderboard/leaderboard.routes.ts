/**
 * Leaderboard. Spec §8.8.
 *
 * The "previous winner" endpoint runs a separate query so it can return null
 * cleanly when there was no scoring activity, mirroring `getPreviousMonthWinner`
 * referenced in the spec.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseParams, parseQuery } from '@/middleware/validate.js';
import { getDb } from '@/db/pool.js';
import { binToUuid, uuidToBin } from '@/lib/ids.js';
import { uuidSchema } from '@/schemas/common.js';
import { leaderboardQuerySchema } from '@/schemas/leaderboard.js';
import { currentYearMonth, monthRange, previousYearMonth } from '@/lib/time.js';
import type { LeaderboardEntry } from '@/types/completion.js';

const householdParamsSchema = z.object({ householdId: uuidSchema });

interface AggRow {
  member_id: Buffer;
  display_name: string;
  avatar: string;
  points: number | bigint;
  completions: number | bigint;
}

async function aggregate(
  householdId: string,
  yearMonth: string,
  tz?: string,
): Promise<LeaderboardEntry[]> {
  const range = monthRange(yearMonth, tz);
  const db = getDb();
  const rows = (await db
    .selectFrom('task_completions as c')
    .innerJoin('household_members as m', 'm.id', 'c.member_id')
    .select((eb) => [
      'c.member_id',
      'm.display_name',
      'm.avatar',
      eb.fn.sum<number>('c.points_awarded').as('points'),
      eb.fn.count<number>('c.id').as('completions'),
    ])
    .where('c.household_id', '=', uuidToBin(householdId))
    .where('c.completed_at', '>=', range.start)
    .where('c.completed_at', '<', range.end)
    .groupBy(['c.member_id', 'm.display_name', 'm.avatar'])
    .execute()) as unknown as AggRow[];

  const ranked = rows
    .map((r) => ({
      memberId: binToUuid(r.member_id),
      displayName: r.display_name,
      avatar: r.avatar,
      points: Number(r.points),
      completions: Number(r.completions),
    }))
    .sort((a, b) => b.points - a.points || b.completions - a.completions)
    .map((r, i) => ({ ...r, rank: i + 1 }));
  return ranked;
}

export async function registerLeaderboardRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/households/:householdId/leaderboard',
    { config: { requiresAuth: true, requiresHouseholdPermission: 'member', rateLimitBucket: 'authedDefault' } },
    async (req) => {
      const params = parseParams(householdParamsSchema, req);
      const query = parseQuery(leaderboardQuerySchema, req);
      const month = query.month ?? currentYearMonth();
      return aggregate(params.householdId, month, query.tz);
    },
  );

  app.get(
    '/households/:householdId/leaderboard/previous-winner',
    { config: { requiresAuth: true, requiresHouseholdPermission: 'member', rateLimitBucket: 'authedDefault' } },
    async (req) => {
      const params = parseParams(householdParamsSchema, req);
      const query = parseQuery(leaderboardQuerySchema, req);
      const month = previousYearMonth();
      const ranked = await aggregate(params.householdId, month, query.tz);
      return ranked[0] ?? null;
    },
  );
}
