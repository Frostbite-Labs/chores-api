/**
 * Google ID-token verifier. Spec §5.1.
 *
 * We rely on `jose`'s remote JWKS helper, which caches keys per the JWKS
 * endpoint's `Cache-Control` and rotates automatically. Validating against
 * Google's expected `iss` and `aud` is non-negotiable - without `aud` you can
 * accept tokens issued for other services.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AppError, AuthError } from '@/lib/errors.js';
import { loadEnv } from '@/config/env.js';
import type { VerifiedIdentity } from '@/types/auth.js';

const GOOGLE_JWKS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs');
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!jwks) jwks = createRemoteJWKSet(GOOGLE_JWKS_URL);
  return jwks;
}

interface GoogleClaims {
  sub: string;
  iss: string;
  aud: string | string[];
  email?: string;
  email_verified?: boolean;
}

export async function verifyGoogleIdToken(idToken: string): Promise<VerifiedIdentity> {
  const env = loadEnv();
  if (!env.GOOGLE_CLIENT_ID) {
    throw new AppError(501, {
      code: 'auth.google.not_configured',
      detail: 'Google sign-in is not configured on this server.',
    });
  }
  let payload: GoogleClaims;
  try {
    const result = await jwtVerify(idToken, getJwks(), {
      audience: env.GOOGLE_CLIENT_ID,
      // jose validates `iss` against this set - `||` accepted form just in case Google rotates.
      issuer: [...GOOGLE_ISSUERS],
    });
    payload = result.payload as unknown as GoogleClaims;
  } catch (err) {
    throw new AuthError({ code: 'auth.google.invalid_token', detail: 'Google ID token failed verification.', cause: err });
  }

  if (!payload.sub) {
    throw new AuthError({ code: 'auth.google.invalid_token', detail: 'Google ID token has no sub.' });
  }
  if (!GOOGLE_ISSUERS.has(payload.iss)) {
    throw new AuthError({ code: 'auth.google.invalid_token', detail: `Unexpected issuer: ${payload.iss}` });
  }

  return {
    provider: 'google',
    providerSubject: payload.sub,
    email: payload.email ?? null,
    emailVerified: payload.email_verified === true,
  };
}
