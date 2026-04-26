/**
 * UUIDv7 generation + lossless conversion between the canonical string form
 * and `BINARY(16)` storage. Spec §4 - "all identifiers in URLs are UUIDv7".
 *
 * Why v7: time-ordered, so InnoDB primary-key inserts stay monotonic and pages
 * don't fragment the way v4 inserts do. We implement v7 inline because the
 * `uuid` package (v9) doesn't export it; this matches RFC 9562 §5.7.
 */
import { randomBytes, randomFillSync } from 'node:crypto';

const CANONICAL_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const RANDOM_BUF = Buffer.alloc(10);

/**
 * Generate a UUIDv7 string. The first 48 bits are the current Unix time in ms,
 * the remaining 80 bits are random with the version (7) and variant (10xx)
 * bits set per the spec.
 */
export function newUuid(): string {
  const ms = Date.now();
  randomFillSync(RANDOM_BUF);
  const bytes = Buffer.alloc(16);
  // Bitwise AND in JS returns a signed 32-bit value, which `writeUIntBE`
  // rejects when the high bit is set. Use `% 2^32` to keep things unsigned.
  bytes.writeUIntBE(Math.floor(ms / 0x100000000), 0, 2);
  bytes.writeUIntBE(ms % 0x100000000, 2, 4);
  RANDOM_BUF.copy(bytes, 6);
  // version = 7 (high nibble of byte 6).
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  // variant = 10xx (top two bits of byte 8).
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** True iff the string is a syntactically valid UUID (any version 1-7). */
export function isUuid(value: string): boolean {
  return CANONICAL_RE.test(value);
}

/**
 * Convert canonical UUID string → 16-byte Buffer for `BINARY(16)` columns.
 * @throws TypeError on malformed input.
 */
export function uuidToBin(uuid: string): Buffer {
  if (!isUuid(uuid)) throw new TypeError(`invalid uuid: ${uuid}`);
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

/**
 * Convert a 16-byte Buffer back to canonical UUID string form.
 * @throws TypeError if the buffer is not exactly 16 bytes.
 */
export function binToUuid(buf: Buffer): string {
  if (buf.length !== 16) throw new TypeError(`expected 16 bytes, got ${buf.length}`);
  const hex = buf.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Cryptographically random opaque token, URL-safe base64. */
export function randomOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
