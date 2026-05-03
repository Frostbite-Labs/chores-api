/**
 * Spec §8.5 - GET /v1/invites/preview returns a read-only confirmation payload
 * (`householdName`, `inviterDisplayName`, `role`, `permission`, `expiresAt`)
 * before redeem, and collapses every unusable state (unknown / expired /
 * revoked / exhausted / household soft-deleted) to a single
 * `404 invite.not_found` so callers cannot probe which codes were ever live.
 *
 * Hits the route via `app.inject()` with a Kysely stub so we cover the route
 * + handler logic without standing up a real MySQL.
 */
import { SignJWT } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const requiredEnv = {
  NODE_ENV: 'test',
  PORT: '3000',
  LOG_LEVEL: 'error',
  DB_URL: 'mysql://x:y@localhost:3306/z',
  REDIS_URL: 'redis://localhost:6379/0',
  JWT_ACCESS_SECRET: 'a'.repeat(64),
  GOOGLE_CLIENT_ID: 'g',
  APPLE_SERVICE_ID: 'a',
  APPLE_TEAM_ID: 't',
  APPLE_KEY_ID: 'k',
  APPLE_PRIVATE_KEY: 'p',
};
for (const [k, v] of Object.entries(requiredEnv)) process.env[k] = v;

interface InviteRow {
  household_name: string;
  household_deleted_at: Date | null;
  inviter_display_name: string;
  invited_role: 'adult' | 'child';
  invited_permission: 'admin' | 'member';
  expires_at: Date;
  revoked_at: Date | null;
  used_count: number;
  max_uses: number;
}

// Mutable holder the tests poke before each inject().
const stub: { selectResult: InviteRow | undefined; insertCalls: unknown[] } = {
  selectResult: undefined,
  insertCalls: [],
};

function makeSelectBuilder() {
  const b: Record<string, unknown> = {};
  // Every chain method except the terminal returns the builder itself.
  for (const m of ['innerJoin', 'leftJoin', 'select', 'selectAll', 'where', 'forUpdate']) {
    b[m] = () => b;
  }
  b['executeTakeFirst'] = async () => stub.selectResult;
  b['execute'] = async () => (stub.selectResult ? [stub.selectResult] : []);
  return b;
}

function makeInsertBuilder() {
  return {
    values(v: unknown) {
      stub.insertCalls.push(v);
      return this;
    },
    async execute() {
      return [];
    },
  };
}

vi.mock('@/db/pool.js', () => ({
  getPool: () => ({ query: async () => [] }),
  getDb: () => ({
    selectFrom: () => makeSelectBuilder(),
    insertInto: () => makeInsertBuilder(),
  }),
  closeDb: async () => {},
}));
vi.mock('@/lib/redis.js', () => ({ getRedis: () => ({ ping: async () => 'PONG' }), closeRedis: async () => {} }));
// @fastify/rate-limit hits Redis at registration; bypass it in unit tests.
vi.mock('@/middleware/rateLimit.js', () => ({ registerRateLimit: async () => {} }));

async function makeAccessToken(userId: string): Promise<string> {
  const secret = new TextEncoder().encode(requiredEnv.JWT_ACCESS_SECRET);
  return new SignJWT({ sid: '0190d3b0-0000-7000-8000-000000000000' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(secret);
}

const VALID_CODE = 'ABCDEFGH'; // 8 chars from the alphabet.
const NOW = Date.now();

function liveInvite(): InviteRow {
  return {
    household_name: 'Sunbeam House',
    household_deleted_at: null,
    inviter_display_name: 'Daniel',
    invited_role: 'child',
    invited_permission: 'member',
    expires_at: new Date(NOW + 60 * 60 * 1000),
    revoked_at: null,
    used_count: 0,
    max_uses: 1,
  };
}

describe('GET /v1/invites/preview', () => {
  let bearer: string;

  beforeAll(async () => {
    bearer = `Bearer ${await makeAccessToken('0190d3b0-0000-7000-8000-000000000001')}`;
  });

  it('rejects missing bearer with 401', async () => {
    stub.selectResult = liveInvite();
    stub.insertCalls = [];
    const { buildApp } = await import('@/app.js');
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: `/v1/invites/preview?code=${VALID_CODE}` });
      expect(res.statusCode).toBe(401);
      const body = res.json() as { code?: string };
      expect(body.code).toBe('auth.missing_bearer');
      // No DB lookup should have happened — the audit also shouldn't fire.
      expect(stub.insertCalls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('rejects malformed code with 400 validation.query', async () => {
    stub.selectResult = liveInvite();
    stub.insertCalls = [];
    const { buildApp } = await import('@/app.js');
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/invites/preview?code=lower123', // wrong case + has 0/1
        headers: { authorization: bearer },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { code?: string };
      expect(body.code).toBe('validation.query');
      expect(stub.insertCalls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('returns the preview payload on a live invite (no householdId leaked)', async () => {
    stub.selectResult = liveInvite();
    stub.insertCalls = [];
    const { buildApp } = await import('@/app.js');
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/invites/preview?code=${VALID_CODE}`,
        headers: { authorization: bearer },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body).toEqual({
        householdName: 'Sunbeam House',
        inviterDisplayName: 'Daniel',
        role: 'child',
        permission: 'member',
        expiresAt: new Date(NOW + 60 * 60 * 1000).toISOString(),
      });
      // Deliberately not exposing householdId or inviteId.
      expect(body).not.toHaveProperty('householdId');
      expect(body).not.toHaveProperty('inviteId');
      // Success audit row should have been written.
      const audit = stub.insertCalls.find((c) => (c as { action?: string }).action === 'invite.preview');
      expect(audit, 'invite.preview audit row missing').toBeDefined();
    } finally {
      await app.close();
    }
  });

  it.each<[string, Partial<InviteRow>]>([
    ['unknown code', {}], // overridden below to undefined
    ['expired', { expires_at: new Date(NOW - 1000) }],
    ['revoked', { revoked_at: new Date(NOW - 1000) }],
    ['exhausted', { used_count: 1, max_uses: 1 }],
    ['household soft-deleted', { household_deleted_at: new Date(NOW - 1000) }],
  ])('collapses %s to 404 invite.not_found and audits the failure', async (label, override) => {
    if (label === 'unknown code') {
      stub.selectResult = undefined;
    } else {
      stub.selectResult = { ...liveInvite(), ...override };
    }
    stub.insertCalls = [];

    const { buildApp } = await import('@/app.js');
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/invites/preview?code=${VALID_CODE}`,
        headers: { authorization: bearer },
      });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('application/problem+json');
      const body = res.json() as { code?: string };
      expect(body.code).toBe('invite.not_found');
      const audit = stub.insertCalls.find(
        (c) => (c as { action?: string }).action === 'invite.preview.lookup_failed',
      );
      expect(audit, 'invite.preview.lookup_failed audit row missing').toBeDefined();
    } finally {
      await app.close();
    }
  });
});
