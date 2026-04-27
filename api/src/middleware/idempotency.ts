/**
 * Idempotency-Key support for side-effecting POSTs (spec §6.5). On first
 * request we cache the response status + body keyed by `(user_id, key_value,
 * sha256(method+path+body))`. Replays return the cached response. Mismatched
 * request hash for the same key → 409 (deliberate; the client must use unique
 * keys per logical operation).
 *
 * Unauthenticated callers (`/auth/google`, `/auth/apple`) are supported via a
 * sentinel all-zeros `user_id`. UUIDv7 generation always sets the version
 * nibble to `7`, so the sentinel is unreachable as a real user id and never
 * collides with an authed row. UUIDv4 idempotency keys carry 122 bits of
 * entropy, so anonymous-key collisions in the 24h TTL window are not a real
 * concern.
 */
import { createHash, randomUUID as nodeRandomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ConflictError, ValidationError } from '@/lib/errors.js';
import { getDb } from '@/db/pool.js';
import { uuidToBin } from '@/lib/ids.js';
import { IDEMPOTENCY_TTL_SEC } from '@/config/constants.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ANON_USER_ID = Buffer.alloc(16); // 16 zero bytes — see file-level comment.

void nodeRandomUUID; // referenced so future callers can mint fresh keys server-side if needed

export interface IdempotencyHit {
  status: number;
  body: unknown;
}

function userIdFor(req: FastifyRequest): Buffer {
  return req.appCtx?.user ? uuidToBin(req.appCtx.user.id) : ANON_USER_ID;
}

/**
 * Returns the cached response if `Idempotency-Key` is set and we've seen
 * the exact same request before. Otherwise returns null and the caller
 * should run the side effect, then call `record()`.
 */
export async function lookup(req: FastifyRequest): Promise<IdempotencyHit | null> {
  const key = req.headers['idempotency-key'];
  if (!key || typeof key !== 'string') return null;
  if (!UUID_V4.test(key)) {
    throw new ValidationError({ code: 'idempotency.invalid_key', detail: 'Idempotency-Key must be a UUIDv4.' });
  }

  const requestHash = hashRequest(req);
  const db = getDb();
  const row = await db
    .selectFrom('idempotency_keys')
    .select(['request_hash', 'response_status', 'response_body', 'expires_at'])
    .where('user_id', '=', userIdFor(req))
    .where('key_value', '=', key)
    .executeTakeFirst();

  if (!row) return null;
  if (row.expires_at.getTime() < Date.now()) return null;
  if (row.request_hash !== requestHash) {
    throw new ConflictError({
      code: 'idempotency.key_reused',
      detail: 'Idempotency-Key was reused with a different request body.',
    });
  }
  return { status: row.response_status, body: JSON.parse(row.response_body.toString('utf8')) };
}

/** Persist a successful response so a retry returns the same answer. */
export async function record(req: FastifyRequest, reply: FastifyReply, body: unknown): Promise<void> {
  const key = req.headers['idempotency-key'];
  if (!key || typeof key !== 'string') return;

  const requestHash = hashRequest(req);
  const db = getDb();
  const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_SEC * 1000);
  await db
    .insertInto('idempotency_keys')
    .values({
      user_id: userIdFor(req),
      key_value: key,
      request_hash: requestHash,
      response_status: reply.statusCode,
      response_body: Buffer.from(JSON.stringify(body), 'utf8'),
      expires_at: expiresAt,
    })
    .onDuplicateKeyUpdate({
      response_status: reply.statusCode,
      response_body: Buffer.from(JSON.stringify(body), 'utf8'),
      expires_at: expiresAt,
    })
    .execute();
}

function hashRequest(req: FastifyRequest): string {
  const h = createHash('sha256');
  h.update(req.method);
  h.update('\n');
  h.update(req.url);
  h.update('\n');
  h.update(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? null));
  return h.digest('hex');
}
