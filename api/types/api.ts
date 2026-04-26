/**
 * Cross-cutting transport types: error envelope, pagination headers,
 * idempotency, and request-scoped context the auth middleware attaches.
 *
 * Spec §4 (RFC 7807), §7.2 (envelope), §7.4 (ETag).
 */

export type IsoTimestamp = string;
export type Uuid = string;

/** RFC 7807 problem+json body. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  /** Stable machine-readable code, e.g. `household.not_a_member`. */
  code: string;
  /** Optional structured payload (validation paths, conflict snapshots, etc.). */
  errors?: unknown;
}

/** Cursor-based list payload - wire shape lives in headers, body is the array. */
export interface PaginationHeaders {
  'X-Total-Count'?: string;
  Link?: string;
}

export type IdempotencyKey = string;
