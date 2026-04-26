/**
 * Bearer-token authentication. Verifies the HS256 access JWT, attaches a
 * minimal `AuthContextUser` to the request, and rejects with 401 on any
 * failure (expired, malformed, missing).
 *
 * Spec §5.2.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { jwtVerify } from 'jose';
import { AuthError } from '@/lib/errors.js';
import { loadEnv } from '@/config/env.js';
import type { AccessTokenClaims } from '@/types/auth.js';

let secretKey: Uint8Array | null = null;
function getSecret(): Uint8Array {
  if (!secretKey) {
    secretKey = new TextEncoder().encode(loadEnv().JWT_ACCESS_SECRET);
  }
  return secretKey;
}

/**
 * Run as a `preHandler` on routes that require auth (the `requiresAuth: true`
 * route config marks them). Throws AuthError; the central error handler
 * shapes the response.
 */
export async function requireAuth(req: FastifyRequest): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    throw new AuthError({ code: 'auth.missing_bearer', detail: 'Authorization header missing or malformed.' });
  }
  const token = header.slice(7).trim();
  if (!token) throw new AuthError({ code: 'auth.missing_bearer', detail: 'Bearer token is empty.' });

  let claims: AccessTokenClaims;
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'] });
    claims = payload as unknown as AccessTokenClaims;
  } catch (err) {
    throw new AuthError({ code: 'auth.invalid_token', detail: 'Access token failed verification.', cause: err });
  }

  if (!claims.sub || !claims.sid) {
    throw new AuthError({ code: 'auth.invalid_token', detail: 'Access token is missing required claims.' });
  }

  req.appCtx = req.appCtx ?? {};
  req.appCtx.user = { id: claims.sub, refreshFamilyId: claims.sid };
}

/**
 * Wires `requireAuth` to run on every route whose `config.requiresAuth === true`.
 * Routes opt in via `routes(app => app.register(..., { config: { requiresAuth: true } }))`.
 */
export function registerAuthHook(app: FastifyInstance): void {
  app.addHook('preHandler', async (req) => {
    const cfg = req.routeOptions.config as { requiresAuth?: boolean } | undefined;
    if (cfg?.requiresAuth) await requireAuth(req);
  });
}
