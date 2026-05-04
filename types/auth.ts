/**
 * Identity, sessions, and OAuth provider claims (spec §5).
 */
import type { IsoTimestamp, Uuid } from './api.js';

export type OAuthProvider = 'google' | 'apple';

/** HS256 access-token claims. Lifetime: 15 min. */
export interface AccessTokenClaims {
  /** User id (UUIDv7). */
  sub: Uuid;
  /** Refresh-token family id; lets us revoke a whole family on replay. */
  sid: Uuid;
  iat: number;
  exp: number;
  /** Reserved for future fine-grained scopes; present so we can introduce without a breaking change. */
  scope?: string;
}

/** Server-side persisted shape of a refresh token (token itself is opaque). */
export interface RefreshTokenRecord {
  id: Uuid;
  familyId: Uuid;
  userId: Uuid;
  /** SHA-256 hex of the actual token; the plaintext never lives at rest. */
  tokenHash: string;
  deviceLabel: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  issuedAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  revokedAt: IsoTimestamp | null;
  replacedById: Uuid | null;
  replaySeenAt: IsoTimestamp | null;
}

/** Apple sign-in nonce (single-use, 5-min TTL). Stored in Redis. */
export interface AppleNonceRecord {
  nonce: string;
  expiresAt: IsoTimestamp;
}

/** Verified provider identity returned by the verifiers. */
export interface VerifiedIdentity {
  provider: OAuthProvider;
  /** Provider's durable subject (`sub`). */
  providerSubject: string;
  email: string | null;
  emailVerified: boolean;
}

/** What the auth middleware attaches to req.context.user. */
export interface AuthContextUser {
  id: Uuid;
  refreshFamilyId: Uuid;
}
