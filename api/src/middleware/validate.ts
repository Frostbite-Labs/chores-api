/**
 * Tiny zod → ValidationError adapter. We don't use Fastify's built-in JSON-schema
 * validation because we want zod everywhere (single source of truth) and strict
 * field stripping.
 */
import type { FastifyRequest } from 'fastify';
import type { ZodTypeAny, z } from 'zod';
import { ValidationError } from '@/lib/errors.js';

export function parseBody<T extends ZodTypeAny>(schema: T, req: FastifyRequest): z.infer<T> {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    throw new ValidationError({
      code: 'validation.body',
      detail: result.error.issues[0]?.message ?? 'invalid body',
      errors: result.error.issues,
    });
  }
  return result.data;
}

export function parseQuery<T extends ZodTypeAny>(schema: T, req: FastifyRequest): z.infer<T> {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    throw new ValidationError({
      code: 'validation.query',
      detail: result.error.issues[0]?.message ?? 'invalid query',
      errors: result.error.issues,
    });
  }
  return result.data;
}

export function parseParams<T extends ZodTypeAny>(schema: T, req: FastifyRequest): z.infer<T> {
  const result = schema.safeParse(req.params);
  if (!result.success) {
    throw new ValidationError({
      code: 'validation.params',
      detail: result.error.issues[0]?.message ?? 'invalid path',
      errors: result.error.issues,
    });
  }
  return result.data;
}
