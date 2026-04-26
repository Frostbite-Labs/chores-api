/**
 * Auth service — bridges OAuth verifiers to our user/identity tables.
 *
 *  - Upserts (provider, sub) → user. Apple's first-sign-in email is captured;
 *    subsequent absences are ignored (spec §5.1).
 *  - Surfaces a coherent `MeResponse` after sign-in so the client can render
 *    instantly.
 */
import { getDb } from '@/db/pool.js';
import { binToUuid, newUuid, uuidToBin } from '@/lib/ids.js';
import type { VerifiedIdentity } from '@/types/auth.js';
import type { MeResponse, User } from '@/types/user.js';

export interface UpsertUserResult {
  user: User;
  /** True iff this sign-in created the user. */
  created: boolean;
}

/**
 * Upsert (provider, providerSubject) → user; when the provider is new for an
 * existing email-matched user we link the identity onto the same account.
 * Spec §5.1.
 */
export async function upsertIdentity(identity: VerifiedIdentity): Promise<UpsertUserResult> {
  const db = getDb();
  return db.transaction().execute(async (tx) => {
    const existing = await tx
      .selectFrom('user_identities')
      .innerJoin('users', 'users.id', 'user_identities.user_id')
      .selectAll('users')
      .where('user_identities.provider', '=', identity.provider)
      .where('user_identities.provider_subject', '=', identity.providerSubject)
      .where('users.deleted_at', 'is', null)
      .executeTakeFirst();

    if (existing) {
      return { user: rowToUser(existing), created: false };
    }

    // No identity yet. If the provider gave us a verified email and a user with
    // that email already exists, link this identity to that user instead of
    // creating a duplicate account.
    let userId: string | null = null;
    if (identity.email && identity.emailVerified) {
      const byEmail = await tx
        .selectFrom('users')
        .selectAll()
        .where('email', '=', identity.email)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (byEmail) userId = binToUuid(byEmail.id);
    }

    let createdNow = false;
    if (!userId) {
      userId = newUuid();
      await tx
        .insertInto('users')
        .values({
          id: uuidToBin(userId),
          email: identity.email,
          email_verified: identity.emailVerified ? 1 : 0,
          display_name: defaultDisplayNameFromEmail(identity.email),
          avatar: '⭐',
        })
        .execute();
      createdNow = true;
    }

    await tx
      .insertInto('user_identities')
      .values({
        id: uuidToBin(newUuid()),
        user_id: uuidToBin(userId),
        provider: identity.provider,
        provider_subject: identity.providerSubject,
        email_at_link: identity.email,
      })
      .execute();

    const fresh = await tx
      .selectFrom('users')
      .selectAll()
      .where('id', '=', uuidToBin(userId))
      .executeTakeFirstOrThrow();
    return { user: rowToUser(fresh), created: createdNow };
  });
}

export async function getMe(userId: string): Promise<MeResponse> {
  const db = getDb();
  const user = await db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', uuidToBin(userId))
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow();
  const identities = await db
    .selectFrom('user_identities')
    .select(['provider'])
    .where('user_id', '=', uuidToBin(userId))
    .execute();
  return { ...rowToUser(user), linkedProviders: identities.map((i) => i.provider) };
}

export function rowToUser(row: {
  id: Buffer;
  email: string | null;
  email_verified: number;
  display_name: string;
  avatar: string;
  created_at: Date;
  updated_at: Date;
}): User {
  return {
    id: binToUuid(row.id),
    email: row.email,
    emailVerified: row.email_verified === 1,
    displayName: row.display_name,
    avatar: row.avatar,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function defaultDisplayNameFromEmail(email: string | null): string {
  if (!email) return 'New User';
  const local = email.split('@')[0] ?? 'New User';
  return local.slice(0, 80);
}
