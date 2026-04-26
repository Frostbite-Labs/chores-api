/**
 * Per-route rate limiting (spec §6.4). Registered globally with the
 * unauthenticated default; each route opts into a stricter bucket via
 * `config.rateLimit` — set by an `onRoute` hook that translates our
 * domain-level `rateLimitBucket` field into `@fastify/rate-limit`'s shape.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { getRedis } from '@/lib/redis.js';
import { RATE_LIMITS } from '@/config/constants.js';
import { RateLimitError } from '@/lib/errors.js';

type Bucket = keyof typeof RATE_LIMITS;

function userOrIpKey(req: FastifyRequest): string {
  return req.appCtx?.user?.id ?? req.ip;
}

export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, {
    redis: getRedis(),
    global: true,
    max: RATE_LIMITS.unauthDefault.max,
    timeWindow: RATE_LIMITS.unauthDefault.windowMs,
    keyGenerator: userOrIpKey,
    errorResponseBuilder: () => {
      throw new RateLimitError({
        code: 'rate_limit.exceeded',
        detail: 'Too many requests, please try again later.',
      });
    },
  });

  // Translate our `rateLimitBucket` into the plugin's per-route override.
  app.addHook('onRoute', (route) => {
    const bucket = (route.config as { rateLimitBucket?: Bucket } | undefined)?.rateLimitBucket;
    if (!bucket) return;
    const cfg = RATE_LIMITS[bucket];
    const existing = (route.config ?? {}) as Record<string, unknown>;
    const existingRl = (existing['rateLimit'] ?? {}) as Record<string, unknown>;
    route.config = {
      ...existing,
      rateLimit: {
        ...existingRl,
        max: cfg.max,
        timeWindow: cfg.windowMs,
        keyGenerator: userOrIpKey,
      },
    } as never;
  });
}
