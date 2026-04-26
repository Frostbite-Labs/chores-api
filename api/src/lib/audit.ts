/**
 * Audit log writer (spec §6.6). Best-effort for CRUD, mandatory for auth and
 * permission changes - callers decide which by either awaiting the write
 * or fire-and-forgetting.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '@/types/db.js';
import { uuidToBin } from './ids.js';

export interface AuditEntry {
  actorUserId?: string | null;
  householdId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Append an audit row. Resolves on success; never throws - auditing must not
 * mask the underlying business action's outcome. Failures are logged via the
 * caller's pino logger when `logFailure` is supplied.
 */
export async function audit(
  db: Kysely<DB> | Transaction<DB>,
  entry: AuditEntry,
  logFailure?: (err: unknown) => void,
): Promise<void> {
  try {
    await db
      .insertInto('audit_log')
      .values({
        actor_user_id: entry.actorUserId ? uuidToBin(entry.actorUserId) : null,
        household_id: entry.householdId ? uuidToBin(entry.householdId) : null,
        action: entry.action,
        target_type: entry.targetType ?? null,
        target_id: entry.targetId ? uuidToBin(entry.targetId) : null,
        ip_address: entry.ipAddress ? ipToBuffer(entry.ipAddress) : null,
        user_agent: entry.userAgent ?? null,
        // mysql2 does not auto-stringify objects for JSON columns, so we do it
        // here. Storing as a string is interchangeable for the JSON type.
        metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
      })
      .execute();
  } catch (err) {
    logFailure?.(err);
  }
}

function ipToBuffer(ip: string): Buffer | null {
  // VARBINARY(16) accepts both v4 (4 bytes) and v6 (16 bytes); we store raw bytes.
  if (ip.includes(':')) {
    // v6 - strip zone id, expand to bytes via URL parser.
    const groups = ip.split(':').flatMap((g) => (g === '' ? [] : [g]));
    if (groups.length === 0) return null;
    // Best-effort parse; deliberately permissive - auditing should not reject.
    try {
      const expanded = expandV6(ip);
      return Buffer.from(expanded.replaceAll(':', ''), 'hex');
    } catch {
      return null;
    }
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return Buffer.from(parts);
}

function expandV6(ip: string): string {
  const dz = ip.split('::');
  const left = dz[0] ? dz[0].split(':') : [];
  const right = dz[1] ? dz[1].split(':') : [];
  const fill = Array<string>(8 - left.length - right.length).fill('0000');
  return [...left, ...fill, ...right].map((g) => g.padStart(4, '0')).join(':');
}
