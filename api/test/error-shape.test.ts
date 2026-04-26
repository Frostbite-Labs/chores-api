/**
 * Spec §4 - every error response is RFC 7807 application/problem+json with the
 * required fields. Hits the not-found handler to keep the test free of DB deps.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db/pool.js', () => ({ getPool: () => ({ query: async () => [] }), getDb: () => ({}), closeDb: async () => {} }));
vi.mock('@/lib/redis.js', () => ({ getRedis: () => ({ ping: async () => 'PONG' }), closeRedis: async () => {} }));
// @fastify/rate-limit hits Redis at registration; bypass it in unit tests.
vi.mock('@/middleware/rateLimit.js', () => ({ registerRateLimit: async () => {} }));

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

describe('error shape', () => {
  it('not-found returns RFC 7807 problem+json with required fields', async () => {
    const { buildApp } = await import('@/app.js');
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/this/does/not/exist' });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('application/problem+json');
      const body = res.json() as Record<string, unknown>;
      for (const k of ['type', 'title', 'status', 'detail', 'instance', 'code']) {
        expect(body[k], `missing ${k}`).toBeTruthy();
      }
      expect(body['status']).toBe(404);
      expect(body['code']).toBe('route.not_found');
    } finally {
      await app.close();
    }
  });
});
