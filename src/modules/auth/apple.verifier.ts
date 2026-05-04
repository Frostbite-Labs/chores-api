/**
 * Apple ID-token verifier. Spec §5.1.
 *
 * Apple's wrinkle: a server-issued nonce must be present in `nonce` so the
 * client cannot replay an ID token captured elsewhere. The nonce is consumed
 * (single-use) by the surrounding service before this verifier runs.
 */
import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AppError, AuthError } from '@/lib/errors.js';
import { loadEnv } from '@/config/env.js';
import type { VerifiedIdentity } from '@/types/auth.js';

const APPLE_JWKS_URL = new URL('https://appleid.apple.com/auth/keys');
const APPLE_ISSUER = 'https://appleid.apple.com';

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!jwks) jwks = createRemoteJWKSet(APPLE_JWKS_URL);
  return jwks;
}

interface AppleClaims {
  sub: string;
  iss: string;
  aud: string | string[];
  email?: string;
  email_verified?: boolean | 'true' | 'false';
  is_private_email?: boolean | 'true' | 'false';
  /** Apple includes the SHA-256 of the supplied nonce (hex). */
  nonce?: string;
  nonce_supported?: boolean;
}

export async function verifyAppleIdToken(idToken: string, expectedNonce: string): Promise<VerifiedIdentity> {
  const env = loadEnv();
  if (!env.APPLE_SERVICE_ID) {
    throw new AppError(501, {
      code: 'auth.apple.not_configured',
      detail: 'Apple sign-in is not configured on this server.',
    });
  }
  let payload: AppleClaims;
  try {
    const result = await jwtVerify(idToken, getJwks(), {
      audience: env.APPLE_SERVICE_ID,
      issuer: APPLE_ISSUER,
    });
    payload = result.payload as unknown as AppleClaims;
  } catch (err) {
    throw new AuthError({ code: 'auth.apple.invalid_token', detail: 'Apple ID token failed verification.', cause: err });
  }

  if (!payload.sub) {
    throw new AuthError({ code: 'auth.apple.invalid_token', detail: 'Apple ID token has no sub.' });
  }

  // Apple hashes the nonce we provided; compare hex-encoded sha256.
  const expectedHash = createHash('sha256').update(expectedNonce).digest('hex');
  if (!payload.nonce || payload.nonce !== expectedHash) {
    throw new AuthError({ code: 'auth.apple.nonce_mismatch', detail: 'Apple nonce mismatch.' });
  }

  return {
    provider: 'apple',
    providerSubject: payload.sub,
    email: payload.email ?? null,
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
  };
}
