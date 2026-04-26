/**
 * Routes for `/v1/auth/*`. All side-effecting routes opt into the `auth`
 * rate-limit bucket (10/5min per spec §6.4). `/auth/account` requires bearer.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parseBody } from '@/middleware/validate.js';
import { audit } from '@/lib/audit.js';
import { getDb } from '@/db/pool.js';
import { uuidToBin } from '@/lib/ids.js';
import { ConflictError } from '@/lib/errors.js';
import {
  appleSignInSchema,
  googleSignInSchema,
  refreshSchema,
} from '@/schemas/auth.js';
import { verifyGoogleIdToken } from './google.verifier.js';
import { verifyAppleIdToken } from './apple.verifier.js';
import { consumeAppleNonce, issueAppleNonce } from './nonce.service.js';
import * as authService from './auth.service.js';
import * as tokens from './token.service.js';

function reqContext(req: FastifyRequest): { ipAddress?: string; userAgent?: string } {
  const ua = req.headers['user-agent'];
  const ctx: { ipAddress?: string; userAgent?: string } = { ipAddress: req.ip };
  if (typeof ua === 'string') ctx.userAgent = ua;
  return ctx;
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // POST /auth/apple/nonce — 🔓
  app.post(
    '/auth/apple/nonce',
    { config: { rateLimitBucket: 'auth' } },
    async () => issueAppleNonce(),
  );

  // POST /auth/google — 🔓
  app.post(
    '/auth/google',
    { config: { rateLimitBucket: 'auth' } },
    async (req) => {
      const body = parseBody(googleSignInSchema, req);
      const identity = await verifyGoogleIdToken(body.idToken);
      const { user } = await authService.upsertIdentity(identity);
      const issuedOpts: tokens.IssueSessionInput = { userId: user.id };
      if (body.deviceLabel !== undefined) issuedOpts.deviceLabel = body.deviceLabel;
      if (req.headers['user-agent']) issuedOpts.userAgent = String(req.headers['user-agent']);
      issuedOpts.ipAddress = req.ip;
      const issued = await tokens.issueSession(issuedOpts);
      await audit(getDb(), { actorUserId: user.id, action: 'auth.login', metadata: { provider: 'google' }, ipAddress: req.ip, userAgent: String(req.headers['user-agent'] ?? '') });
      return {
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        accessTokenExpiresAt: issued.accessTokenExpiresAt,
        user,
      };
    },
  );

  // POST /auth/apple — 🔓
  app.post(
    '/auth/apple',
    { config: { rateLimitBucket: 'auth' } },
    async (req) => {
      const body = parseBody(appleSignInSchema, req);
      await consumeAppleNonce(body.nonce);
      const identity = await verifyAppleIdToken(body.identityToken, body.nonce);
      const { user } = await authService.upsertIdentity(identity);
      const issuedOpts: tokens.IssueSessionInput = { userId: user.id };
      if (body.deviceLabel !== undefined) issuedOpts.deviceLabel = body.deviceLabel;
      if (req.headers['user-agent']) issuedOpts.userAgent = String(req.headers['user-agent']);
      issuedOpts.ipAddress = req.ip;
      const issued = await tokens.issueSession(issuedOpts);
      await audit(getDb(), { actorUserId: user.id, action: 'auth.login', metadata: { provider: 'apple' }, ipAddress: req.ip, userAgent: String(req.headers['user-agent'] ?? '') });
      return {
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        accessTokenExpiresAt: issued.accessTokenExpiresAt,
        user,
      };
    },
  );

  // POST /auth/refresh — 🔓
  app.post(
    '/auth/refresh',
    { config: { rateLimitBucket: 'auth' } },
    async (req) => {
      const body = parseBody(refreshSchema, req);
      const issued = await tokens.rotateRefreshToken(body.refreshToken, reqContext(req));
      return {
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        accessTokenExpiresAt: issued.accessTokenExpiresAt,
      };
    },
  );

  // POST /auth/logout — 🔒
  app.post(
    '/auth/logout',
    { config: { requiresAuth: true, rateLimitBucket: 'authedDefault' } },
    async (req, reply) => {
      const user = req.appCtx.user!;
      await tokens.revokeFamily(user.refreshFamilyId);
      await audit(getDb(), { actorUserId: user.id, action: 'auth.logout' });
      reply.code(204).send();
    },
  );

  // POST /auth/logout-all — 🔒
  app.post(
    '/auth/logout-all',
    { config: { requiresAuth: true, rateLimitBucket: 'authedDefault' } },
    async (req, reply) => {
      const user = req.appCtx.user!;
      await tokens.revokeAllForUser(user.id);
      await audit(getDb(), { actorUserId: user.id, action: 'auth.logout_all' });
      reply.code(204).send();
    },
  );

  // DELETE /auth/account — 🔒. Begins deletion (spec §6.7).
  app.delete(
    '/auth/account',
    { config: { requiresAuth: true, rateLimitBucket: 'authedDefault' } },
    async (req, reply) => {
      const user = req.appCtx.user!;
      const db = getDb();

      // Owners with co-members must transfer first. We do this in two steps —
      // the simpler shape is easier to read than a HAVING+GROUP BY chain.
      const ownedHouseholds = await db
        .selectFrom('households')
        .select('id')
        .where('owner_user_id', '=', uuidToBin(user.id))
        .where('deleted_at', 'is', null)
        .execute();
      for (const h of ownedHouseholds) {
        const others = await db
          .selectFrom('household_members')
          .select((eb) => eb.fn.countAll<number>().as('cnt'))
          .where('household_id', '=', h.id)
          .where('removed_at', 'is', null)
          .executeTakeFirst();
        if (Number(others?.cnt ?? 0) > 1) {
          throw new ConflictError({
            code: 'account.transfer_required',
            detail: 'Transfer ownership of every multi-member household before deleting your account.',
          });
        }
      }

      await db.transaction().execute(async (tx) => {
        await tx
          .updateTable('users')
          .set({ deleted_at: new Date(), display_name: 'Deleted user', email: null })
          .where('id', '=', uuidToBin(user.id))
          .execute();
        await tx.deleteFrom('user_identities').where('user_id', '=', uuidToBin(user.id)).execute();
        // Delete sole-owner-sole-member households.
        await tx
          .updateTable('households')
          .set({ deleted_at: new Date() })
          .where('owner_user_id', '=', uuidToBin(user.id))
          .where('deleted_at', 'is', null)
          .execute();
        await tx
          .updateTable('refresh_tokens')
          .set({ revoked_at: new Date() })
          .where('user_id', '=', uuidToBin(user.id))
          .where('revoked_at', 'is', null)
          .execute();
      });

      await audit(getDb(), { actorUserId: user.id, action: 'auth.account.delete' });
      reply.code(204).send();
    },
  );
}
