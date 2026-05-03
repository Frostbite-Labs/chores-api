/**
 * Routes for `/v1/auth/*`. All side-effecting routes opt into the `auth`
 * rate-limit bucket (10/5min per spec §6.4). `/auth/account` requires bearer.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parseBody } from '@/middleware/validate.js';
import { audit } from '@/lib/audit.js';
import { getDb } from '@/db/pool.js';
import { binToUuid, uuidToBin } from '@/lib/ids.js';
import { ConflictError } from '@/lib/errors.js';
import { bumpHouseholdVersion } from '@/db/repositories/households.js';
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
import * as idempotency from '@/middleware/idempotency.js';

function reqContext(req: FastifyRequest): { ipAddress?: string; userAgent?: string } {
  const ua = req.headers['user-agent'];
  const ctx: { ipAddress?: string; userAgent?: string } = { ipAddress: req.ip };
  if (typeof ua === 'string') ctx.userAgent = ua;
  return ctx;
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // POST /auth/apple/nonce - 🔓
  app.post(
    '/auth/apple/nonce',
    { config: { rateLimitBucket: 'auth' } },
    async () => issueAppleNonce(),
  );

  // POST /auth/google - 🔓
  // Honours `Idempotency-Key` so flaky-network retries don't burn rate limit
  // budget or duplicate refresh-token rows. Lookup runs *before* token
  // verification so a cached hit short-circuits without a JWKS round-trip.
  app.post(
    '/auth/google',
    { config: { rateLimitBucket: 'auth' } },
    async (req, reply) => {
      const cached = await idempotency.lookup(req);
      if (cached) {
        reply.code(cached.status);
        return cached.body;
      }
      const body = parseBody(googleSignInSchema, req);
      const identity = await verifyGoogleIdToken(body.idToken);
      const { user } = await authService.upsertIdentity(identity);
      const issuedOpts: tokens.IssueSessionInput = { userId: user.id };
      if (body.deviceLabel !== undefined) issuedOpts.deviceLabel = body.deviceLabel;
      if (req.headers['user-agent']) issuedOpts.userAgent = String(req.headers['user-agent']);
      issuedOpts.ipAddress = req.ip;
      const issued = await tokens.issueSession(issuedOpts);
      await audit(getDb(), { actorUserId: user.id, action: 'auth.login', metadata: { provider: 'google' }, ipAddress: req.ip, userAgent: String(req.headers['user-agent'] ?? '') });
      const responseBody = {
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        accessTokenExpiresAt: issued.accessTokenExpiresAt,
        user,
      };
      await idempotency.record(req, reply, responseBody);
      return responseBody;
    },
  );

  // POST /auth/apple - 🔓
  // Same idempotency treatment as /auth/google. Note: the nonce is consumed
  // on the first attempt; retries rely on the cached response, which is fine
  // because the apple nonce is bound to the Idempotency-Key via the request
  // hash (a different nonce produces a different request_hash → 409).
  app.post(
    '/auth/apple',
    { config: { rateLimitBucket: 'auth' } },
    async (req, reply) => {
      const cached = await idempotency.lookup(req);
      if (cached) {
        reply.code(cached.status);
        return cached.body;
      }
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
      const responseBody = {
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        accessTokenExpiresAt: issued.accessTokenExpiresAt,
        user,
      };
      await idempotency.record(req, reply, responseBody);
      return responseBody;
    },
  );

  // POST /auth/refresh - 🔓
  // Spec §6.6 lists `auth.refresh` as a mandatory audit event. Replay detection
  // already audits inside `rotateRefreshToken`; success is audited here so the
  // log carries both halves of the rotation lifecycle.
  app.post(
    '/auth/refresh',
    { config: { rateLimitBucket: 'auth' } },
    async (req) => {
      const body = parseBody(refreshSchema, req);
      const issued = await tokens.rotateRefreshToken(body.refreshToken, reqContext(req));
      await audit(getDb(), {
        actorUserId: issued.userId,
        action: 'auth.refresh',
        targetType: 'refresh_token_family',
        targetId: issued.familyId,
        ipAddress: req.ip,
        userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
      });
      return {
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        accessTokenExpiresAt: issued.accessTokenExpiresAt,
      };
    },
  );

  // POST /auth/logout - 🔒
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

  // POST /auth/logout-all - 🔒
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

  // DELETE /auth/account - 🔒. Begins deletion (spec §6.7).
  app.delete(
    '/auth/account',
    { config: { requiresAuth: true, rateLimitBucket: 'authedDefault' } },
    async (req, reply) => {
      const user = req.appCtx.user!;
      const db = getDb();

      // Owners with co-members must transfer first. We do this in two steps -
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
        const now = new Date();
        await tx
          .updateTable('users')
          .set({ deleted_at: now, display_name: 'Deleted user', email: null })
          .where('id', '=', uuidToBin(user.id))
          .execute();
        await tx.deleteFrom('user_identities').where('user_id', '=', uuidToBin(user.id)).execute();

        // Soft-remove non-owner memberships in *other* households and emit
        // tombstones so co-members' sync clients drop the row. Owner-permission
        // memberships only exist in households we delete entirely below — the
        // sole-owner-sole-member precondition was already enforced.
        const otherMemberships = await tx
          .selectFrom('household_members')
          .select(['id', 'household_id'])
          .where('user_id', '=', uuidToBin(user.id))
          .where('removed_at', 'is', null)
          .where('permission', '!=', 'owner')
          .execute();
        for (const m of otherMemberships) {
          await tx
            .updateTable('household_members')
            .set({ removed_at: now })
            .where('id', '=', m.id)
            .execute();
          const householdIdStr = binToUuid(m.household_id);
          const newVersion = await bumpHouseholdVersion(tx, householdIdStr);
          await tx
            .insertInto('sync_tombstones')
            .values({
              household_id: m.household_id,
              entity_type: 'member',
              entity_id: m.id,
              deleted_row_version: newVersion,
            })
            .onDuplicateKeyUpdate({ deleted_row_version: newVersion, deleted_at: now })
            .execute();
        }

        // Delete sole-owner-sole-member households (the prior count check
        // guarantees these are the only owned households at this point).
        await tx
          .updateTable('households')
          .set({ deleted_at: now })
          .where('owner_user_id', '=', uuidToBin(user.id))
          .where('deleted_at', 'is', null)
          .execute();
        await tx
          .updateTable('refresh_tokens')
          .set({ revoked_at: now })
          .where('user_id', '=', uuidToBin(user.id))
          .where('revoked_at', 'is', null)
          .execute();
      });

      await audit(getDb(), { actorUserId: user.id, action: 'auth.account.delete' });
      reply.code(204).send();
    },
  );
}
