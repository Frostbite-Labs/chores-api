/**
 * AppError hierarchy. Every thrown error in handlers should be one of these so
 * the central error handler can map cleanly to RFC 7807. Spec §4, §6.
 */

export interface AppErrorOptions {
  code: string;
  detail: string;
  /** Optional structured payload (validation issue list, conflict snapshot, etc.). */
  errors?: unknown;
  cause?: unknown;
}

export class AppError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly detail: string;
  public readonly errors?: unknown;

  constructor(status: number, opts: AppErrorOptions) {
    super(opts.detail, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.status = status;
    this.code = opts.code;
    this.detail = opts.detail;
    if (opts.errors !== undefined) this.errors = opts.errors;
  }
}

export class ValidationError extends AppError {
  constructor(opts: AppErrorOptions) {
    super(400, opts);
  }
}

export class AuthError extends AppError {
  constructor(opts: AppErrorOptions) {
    super(401, opts);
  }
}

export class ForbiddenError extends AppError {
  constructor(opts: AppErrorOptions) {
    super(403, opts);
  }
}

export class NotFoundError extends AppError {
  constructor(opts: AppErrorOptions) {
    super(404, opts);
  }
}

export class ConflictError extends AppError {
  constructor(opts: AppErrorOptions) {
    super(409, opts);
  }
}

export class RateLimitError extends AppError {
  constructor(opts: AppErrorOptions) {
    super(429, opts);
  }
}
