/**
 * Fastify request augmentation. Auth middleware fills `req.appCtx.user`;
 * authorize fills `req.appCtx.member` once a household-scoped route runs.
 *
 * We use `appCtx` rather than the more natural `context` because Fastify
 * already exposes `request.context` for route configuration.
 */
import 'fastify';
import type { HouseholdMember } from '@/types/member.js';
import type { AuthContextUser } from '@/types/auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    appCtx: {
      user?: AuthContextUser;
      member?: HouseholdMember;
    };
  }
  interface FastifyContextConfig {
    requiresAuth?: boolean;
    requiresHouseholdPermission?: 'member' | 'admin' | 'owner';
    rateLimitBucket?: 'auth' | 'inviteRedeem' | 'writeHotPath' | 'authedDefault' | 'unauthDefault';
  }
}
