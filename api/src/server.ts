/**
 * Server entrypoint — boot the Fastify instance, listen, and wire SIGTERM to
 * a graceful close so in-flight requests drain.
 */
import { buildApp } from './app.js';
import { closeDb } from './db/pool.js';
import { closeRedis } from './lib/redis.js';
import { loadEnv } from './config/env.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await closeDb();
    await closeRedis();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', err);
  process.exit(1);
});
