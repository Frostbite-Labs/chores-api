/**
 * User-facing user and identity shapes (spec §8.2, §10.1, §10.2).
 */
import type { IsoTimestamp, Uuid } from './api.js';
import type { OAuthProvider } from './auth.js';

export interface User {
  id: Uuid;
  email: string | null;
  emailVerified: boolean;
  displayName: string;
  avatar: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface UserIdentity {
  id: Uuid;
  provider: OAuthProvider;
  /** Surfaced to the client as a redacted "linked providers" hint, never the raw subject. */
  emailAtLink: string | null;
  createdAt: IsoTimestamp;
}

export interface MeResponse extends User {
  linkedProviders: OAuthProvider[];
}
