/**
 * Per-request access log. Emits one structured `info`-level line per response
 * with the fields ops/observability typically wants: method, route template
 * (low cardinality for metrics), status, response time, the request id, and
 * the resolved user id once auth has run. Fastify's built-in
 * `incoming request` / `request completed` pair is disabled in `app.ts` since
 * this hook replaces it.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export function registerAccessLog(app: FastifyInstance): void {
  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    const responseTimeMs = Math.round(reply.elapsedTime * 1000) / 1000;
    const contentLength = reply.getHeader('content-length');
    req.log.info(
      {
        method: req.method,
        url: req.url,
        // `routeOptions.url` is the template (e.g. `/v1/households/:id`); falls
        // back to the raw url for unmatched routes (404s).
        route: req.routeOptions?.url ?? req.url,
        statusCode: reply.statusCode,
        responseTimeMs,
        userId: req.appCtx?.user?.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        contentLength: typeof contentLength === 'string' ? Number(contentLength) : contentLength,
      },
      'access',
    );
  });
}
