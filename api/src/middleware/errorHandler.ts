/**
 * Fastify error handler — every response leaving this server is either a
 * success body or RFC 7807 `application/problem+json`. Anything that isn't
 * already an `AppError` is re-shaped as a 500 so we never leak stack frames.
 *
 * Spec §4.
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '@/lib/errors.js';
import type { ProblemDetails } from '@/types/api.js';

const ERROR_BASE = 'https://api.choreclub.app/errors';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => sendProblem(err, req, reply));
  app.setNotFoundHandler((req, reply) => {
    sendProblem(
      new AppError(404, { code: 'route.not_found', detail: `${req.method} ${req.url} is not a known route.` }),
      req,
      reply,
    );
  });
}

function sendProblem(err: FastifyError | Error | unknown, req: FastifyRequest, reply: FastifyReply): void {
  const requestId = (req.id ?? 'unknown').toString();

  if (err instanceof ZodError) {
    const body: ProblemDetails = {
      type: `${ERROR_BASE}/validation`,
      title: 'Validation failed',
      status: 400,
      detail: err.issues[0]?.message ?? 'Request did not match the expected shape.',
      instance: requestId,
      code: 'validation.failed',
      errors: err.issues.map((i) => ({ path: i.path, message: i.message, code: i.code })),
    };
    reply.code(400).type('application/problem+json').send(body);
    return;
  }

  if (err instanceof AppError) {
    const body: ProblemDetails = {
      type: `${ERROR_BASE}/${err.code.replace(/\./g, '/')}`,
      title: titleForStatus(err.status),
      status: err.status,
      detail: err.detail,
      instance: requestId,
      code: err.code,
      ...(err.errors !== undefined ? { errors: err.errors } : {}),
    };
    reply.code(err.status).type('application/problem+json').send(body);
    return;
  }

  const fastifyErr = err as FastifyError;
  if (fastifyErr?.statusCode && fastifyErr.statusCode < 500) {
    const body: ProblemDetails = {
      type: `${ERROR_BASE}/${fastifyErr.code ?? 'bad_request'}`,
      title: titleForStatus(fastifyErr.statusCode),
      status: fastifyErr.statusCode,
      detail: fastifyErr.message,
      instance: requestId,
      code: fastifyErr.code ?? 'request.error',
    };
    reply.code(fastifyErr.statusCode).type('application/problem+json').send(body);
    return;
  }

  req.log.error({ err }, 'unhandled error');
  const body: ProblemDetails = {
    type: `${ERROR_BASE}/internal`,
    title: 'Internal Server Error',
    status: 500,
    detail: 'An unexpected error occurred.',
    instance: requestId,
    code: 'server.internal',
  };
  reply.code(500).type('application/problem+json').send(body);
}

function titleForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'Bad Request';
    case 401:
      return 'Unauthorized';
    case 403:
      return 'Forbidden';
    case 404:
      return 'Not Found';
    case 409:
      return 'Conflict';
    case 412:
      return 'Precondition Failed';
    case 422:
      return 'Unprocessable Entity';
    case 429:
      return 'Too Many Requests';
    default:
      return status >= 500 ? 'Internal Server Error' : 'Error';
  }
}
