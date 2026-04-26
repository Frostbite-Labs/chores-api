/**
 * Token lifecycle (spec §5.2):
 *
 *  - Access tokens: HS256 JWTs, 15-minute lifetime.
 *  - Refresh tokens: opaque random base64url, 30-day lifetime. We persist only
 *    `SHA-256(token)` so a leak of the row store still doesn't expose tokens.
 *
 * Rotation: every successful refresh issues a new token in the same family
 * and revokes the old one. If a *revoked* token is ever presented again,
 * we revoke the entire family (replay defence) and audit the event.
 */
import { createHash } from 'node:crypto';
import { SignJWT } from 'jose';
import { ACCESS_TOKEN_TTL_SEC, REFRESH_TOKEN_TTL_SEC } from '@/config/constants.js';
import { AuthError } from '@/lib/errors.js';
import { loadEnv } from '@/config/env.js';
import { getDb } from '@/db/pool.js';
import { binToUuid, newUuid, randomOpaqueToken, uuidToBin } from '@/lib/ids.js';
import { audit } from '@/lib/audit.js';

let secret: Uint8Array | null = null;
function getSecret(): Uint8Array {
  if (!secret) secret = new TextEncoder().encode(loadEnv().JWT_ACCESS_SECRET);
  return secret;
}

export interface IssueSessionInput {
  userId: string;
  deviceLabel?: string | undefined;
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
  /** Optional: continue an existing family (rotation). Otherwise a new family is started. */
  familyId?: string;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  familyId: string;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

async function signAccessToken(userId: string, familyId: string): Promise<{ token: string; expiresAt: string }> {
  const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SEC;
  const token = await new SignJWT({ sid: familyId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(getSecret());
  return { token, expiresAt: new Date(expiresAt * 1000).toISOString() };
}

/** Issue a fresh access+refresh pair, persisting the refresh row. */
export async function issueSession(input: IssueSessionInput): Promise<IssuedSession> {
  const familyId = input.familyId ?? newUuid();
  const refreshToken = randomOpaqueToken(32);
  const refreshHash = sha256Hex(refreshToken);
  const id = newUuid();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_SEC * 1000);

  await getDb()
    .insertInto('refresh_tokens')
    .values({
      id: uuidToBin(id),
      family_id: uuidToBin(familyId),
      user_id: uuidToBin(input.userId),
      token_hash: refreshHash,
      device_label: input.deviceLabel ?? null,
      user_agent: input.userAgent ?? null,
      ip_address: null,
      issued_at: now,
      expires_at: expiresAt,
      revoked_at: null,
      replaced_by_id: null,
      replay_seen_at: null,
    })
    .execute();

  const access = await signAccessToken(input.userId, familyId);
  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken,
    familyId,
  };
}

/**
 * Rotate: validate the presented refresh token, mint a new pair in the same
 * family, mark the old token as revoked + replaced_by_id. Replay → kill family.
 */
export async function rotateRefreshToken(presented: string, ctx: { ipAddress?: string; userAgent?: string }): Promise<IssuedSession> {
  const presentedHash = sha256Hex(presented);
  const db = getDb();
  return db.transaction().execute(async (tx) => {
    const row = await tx
      .selectFrom('refresh_tokens')
      .selectAll()
      .where('token_hash', '=', presentedHash)
      .forUpdate()
      .executeTakeFirst();

    if (!row) {
      throw new AuthError({ code: 'auth.refresh.unknown', detail: 'Refresh token is not recognised.' });
    }
    if (row.expires_at.getTime() < Date.now()) {
      throw new AuthError({ code: 'auth.refresh.expired', detail: 'Refresh token has expired.' });
    }
    if (row.revoked_at) {
      // Replay: kill the entire family and audit.
      await tx
        .updateTable('refresh_tokens')
        .set({ revoked_at: new Date(), replay_seen_at: new Date() })
        .where('family_id', '=', row.family_id)
        .where('revoked_at', 'is', null)
        .execute();
      await audit(tx, {
        actorUserId: binToUuid(row.user_id),
        action: 'auth.refresh.replay_detected',
        targetType: 'refresh_token_family',
        targetId: binToUuid(row.family_id),
      });
      throw new AuthError({
        code: 'auth.refresh.replay_detected',
        detail: 'Refresh token replay detected; the session family has been revoked.',
      });
    }

    // Mint replacement
    const newId = newUuid();
    const newToken = randomOpaqueToken(32);
    const newHash = sha256Hex(newToken);
    const newExpires = new Date(Date.now() + REFRESH_TOKEN_TTL_SEC * 1000);

    await tx
      .insertInto('refresh_tokens')
      .values({
        id: uuidToBin(newId),
        family_id: row.family_id,
        user_id: row.user_id,
        token_hash: newHash,
        device_label: row.device_label,
        user_agent: ctx.userAgent ?? row.user_agent,
        ip_address: null,
        issued_at: new Date(),
        expires_at: newExpires,
        revoked_at: null,
        replaced_by_id: null,
        replay_seen_at: null,
      })
      .execute();

    await tx
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date(), replaced_by_id: uuidToBin(newId) })
      .where('id', '=', row.id)
      .execute();

    const userId = binToUuid(row.user_id);
    const familyId = binToUuid(row.family_id);
    const access = await signAccessToken(userId, familyId);
    return { accessToken: access.token, accessTokenExpiresAt: access.expiresAt, refreshToken: newToken, familyId };
  });
}

/** Revoke every token in a family - used on logout. */
export async function revokeFamily(familyId: string): Promise<void> {
  await getDb()
    .updateTable('refresh_tokens')
    .set({ revoked_at: new Date() })
    .where('family_id', '=', uuidToBin(familyId))
    .where('revoked_at', 'is', null)
    .execute();
}

/** Revoke every family for a user - used on logout-all and account deletion. */
export async function revokeAllForUser(userId: string): Promise<void> {
  await getDb()
    .updateTable('refresh_tokens')
    .set({ revoked_at: new Date() })
    .where('user_id', '=', uuidToBin(userId))
    .where('revoked_at', 'is', null)
    .execute();
}
