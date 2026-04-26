/**
 * Builds the Fastify instance: plugins, hooks, routes. Pure factory - no
 * `listen()` here, so tests can supply their own port (or none, with `inject`).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import './middleware/types.js'; // side-effect import - loads FastifyRequest augmentation
import { loadEnv } from './config/env.js';
import { getPool } from './db/pool.js';
import { getRedis } from './lib/redis.js';
import { registerErrorHandler } from './middleware/errorHandler.js';
import { registerAuthHook } from './middleware/auth.js';
import { registerAuthorizeHook } from './middleware/authorize.js';
import { registerRateLimit } from './middleware/rateLimit.js';
import { registerAuthRoutes } from './modules/auth/auth.routes.js';
import { registerUsersRoutes } from './modules/users/users.routes.js';
import { registerHouseholdsRoutes } from './modules/households/households.routes.js';
import { registerMembersRoutes } from './modules/members/members.routes.js';
import { registerInvitesRoutes } from './modules/invites/invites.routes.js';
import { registerTasksRoutes } from './modules/tasks/tasks.routes.js';
import { registerCompletionsRoutes } from './modules/completions/completions.routes.js';
import { registerLeaderboardRoutes } from './modules/leaderboard/leaderboard.routes.js';
import { registerSyncRoutes } from './modules/sync/sync.routes.js';

export async function buildApp(): Promise<FastifyInstance> {
  const env = loadEnv();
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    genReqId: () => `req-${cryptoId()}`,
    bodyLimit: 1_500_000,
  });

  registerErrorHandler(app);

  // Initialize the per-request appCtx slot. Auth + authorize hooks fill it in.
  app.addHook('onRequest', async (req) => {
    req.appCtx = {};
  });

  await app.register(sensible);
  await app.register(helmet, {
    contentSecurityPolicy: false,
    hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  // Reject any non-JSON body content-type (spec §6.1).
  app.addHook('preValidation', async (req) => {
    const ct = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') return;
    if (!ct) return;
    if (ct !== 'application/json') {
      const { ValidationError } = await import('./lib/errors.js');
      throw new ValidationError({ code: 'request.content_type', detail: 'Only application/json is accepted.' });
    }
  });

  registerAuthHook(app);
  registerAuthorizeHook(app);
  await registerRateLimit(app);

  // Health endpoint - outside /v1.
  app.get('/healthz', async (_req, reply) => {
    const start = Date.now();
    try {
      await Promise.all([getPool().query('SELECT 1'), getRedis().ping()]);
      const elapsed = Date.now() - start;
      if (elapsed > 250) {
        reply.code(503);
        return { status: 'slow', elapsedMs: elapsed };
      }
      return { status: 'ok', elapsedMs: elapsed };
    } catch (err) {
      reply.code(503);
      return { status: 'down', error: (err as Error).message };
    }
  });

  await app.register(
    async (v1) => {
      await registerAuthRoutes(v1);
      await registerUsersRoutes(v1);
      await registerHouseholdsRoutes(v1);
      await registerMembersRoutes(v1);
      await registerInvitesRoutes(v1);
      await registerTasksRoutes(v1);
      await registerCompletionsRoutes(v1);
      await registerLeaderboardRoutes(v1);
      await registerSyncRoutes(v1);
    },
    { prefix: '/v1' },
  );

  return app;
}

function cryptoId(): string {
  // 12-byte base32-ish identifier; collision-resistant enough for a request id.
  return Math.random().toString(36).slice(2, 14);
}
