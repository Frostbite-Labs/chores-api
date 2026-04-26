/**
 * Apple sign-in nonce store. Spec §5.1, §8.1.
 *
 * Nonces are single-use, 5-minute TTL. Redis `SET … EX … NX` gives us atomic
 * creation, and `GETDEL` lets the verifier consume the nonce in one round trip.
 */
import { randomBytes } from 'node:crypto';
import { getRedis } from '@/lib/redis.js';
import { APPLE_NONCE_TTL_SEC } from '@/config/constants.js';
import { AuthError } from '@/lib/errors.js';

const PREFIX = 'apple:nonce:';

/** Mint, store, and return a fresh nonce. */
export async function issueAppleNonce(): Promise<{ nonce: string; expiresAt: string }> {
  const nonce = randomBytes(32).toString('base64url');
  const redis = getRedis();
  await redis.set(`${PREFIX}${nonce}`, '1', 'EX', APPLE_NONCE_TTL_SEC, 'NX');
  return {
    nonce,
    expiresAt: new Date(Date.now() + APPLE_NONCE_TTL_SEC * 1000).toISOString(),
  };
}

/** Consume the nonce; throws if missing/expired (i.e. replay attempt). */
export async function consumeAppleNonce(nonce: string): Promise<void> {
  const redis = getRedis();
  // GETDEL is single-shot atomic — the read+delete cannot race.
  const existing = await redis.getdel(`${PREFIX}${nonce}`);
  if (!existing) {
    throw new AuthError({ code: 'auth.apple.nonce_invalid', detail: 'Apple nonce is missing, expired, or already used.' });
  }
}
