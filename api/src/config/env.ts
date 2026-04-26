/**
 * Zod-validated environment loader (spec §11). Refuses to start the server if
 * any required secret is missing or malformed, so misconfiguration is loud
 * at boot rather than silent at first use.
 */
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DB_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  /** HS256 signing key. >= 32 bytes is required by jose; we enforce it explicitly. */
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),

  GOOGLE_CLIENT_ID: z.string().min(1),

  APPLE_SERVICE_ID: z.string().min(1),
  APPLE_TEAM_ID: z.string().min(1),
  APPLE_KEY_ID: z.string().min(1),
  APPLE_PRIVATE_KEY: z.string().min(1),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/**
 * Read and validate `process.env` once. Subsequent calls return the cached value.
 * @throws ZodError when validation fails — propagates to the entrypoint as a fatal exit.
 */
export function loadEnv(): Env {
  if (cached) return cached;
  cached = EnvSchema.parse(process.env);
  return cached;
}
