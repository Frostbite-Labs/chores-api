/**
 * Token TTLs and limits called out in the spec — referenced from one place so
 * adjustments are visible in code review.
 */

export const ACCESS_TOKEN_TTL_SEC = 15 * 60; // §5.2 — 15 min
export const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60; // §5.2 — 30 days
export const APPLE_NONCE_TTL_SEC = 5 * 60; // §8.1 — 5 min
export const IDEMPOTENCY_TTL_SEC = 24 * 60 * 60; // §6.5 — 24h

export const SYNC_PAGE_BYTE_BUDGET = 1_000_000; // §9.1 — 1MB

export const INVITE_CODE_LENGTH = 8; // §8.5
export const INVITE_DEFAULT_EXPIRES_HOURS = 72;
export const INVITE_DEFAULT_MAX_USES = 1;
/** Crockford-ish, no 0/O, 1/I/L. */
export const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const COMPLETION_PAGE_DEFAULT = 50; // §8.7
export const COMPLETION_PAGE_MAX = 200;

/** Server-side body length caps; client renders verbatim (§6.3). */
export const LIMITS = {
  title: 120,
  notes: 1000,
  displayName: 80,
  /** One grapheme cluster — the validator enforces this with Intl.Segmenter. */
  avatar: 16,
} as const;

/** Rate-limit table (§6.4). */
export const RATE_LIMITS = {
  authPost: { max: 10, windowMs: 5 * 60 * 1000 },
  inviteRedeem: { max: 10, windowMs: 60 * 60 * 1000 },
  writeHotPath: { max: 60, windowMs: 60 * 1000 },
  authedDefault: { max: 600, windowMs: 60 * 1000 },
  unauthDefault: { max: 60, windowMs: 60 * 1000 },
} as const;
