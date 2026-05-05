/**
 * Zod-validated environment loader (spec §11). Refuses to start the server if
 * any required secret is missing or malformed, so misconfiguration is loud
 * at boot rather than silent at first use.
 */
import { z } from 'zod';

/**
 * Treat empty strings (e.g. `GOOGLE_CLIENT_ID=` in `.env`) as "unset" so optional
 * provider vars don't fail `min(1)` when the operator deliberately leaves them blank.
 */
const optionalSecret = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().min(1).optional(),
);

const APPLE_KEYS = ['APPLE_SERVICE_ID', 'APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY'] as const;

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    DB_URL: z.string().url(),
    REDIS_URL: z.string().url(),

    /** HS256 signing key. >= 32 bytes is required by jose; we enforce it explicitly. */
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),

    /**
     * OAuth providers are individually optional, but at least one must be fully
     * configured (enforced in `superRefine` below). Apple is all-or-nothing
     * across its four vars — a partial Apple config is always a misconfiguration.
     *
     * `GOOGLE_CLIENT_ID` is the canonical (web) client ID. `GOOGLE_IOS_CLIENT_ID`
     * and `GOOGLE_ANDROID_CLIENT_ID` are additional accepted audiences for native
     * clients that issue ID tokens audienced for their platform-specific OAuth
     * client (e.g. expo-auth-session/providers/google on iOS/Android).
     */
    GOOGLE_CLIENT_ID: optionalSecret,
    GOOGLE_IOS_CLIENT_ID: optionalSecret,
    GOOGLE_ANDROID_CLIENT_ID: optionalSecret,
    APPLE_SERVICE_ID: optionalSecret,
    APPLE_TEAM_ID: optionalSecret,
    APPLE_KEY_ID: optionalSecret,
    APPLE_PRIVATE_KEY: optionalSecret,
  })
  .superRefine((env, ctx) => {
    const googleConfigured = Boolean(
      env.GOOGLE_CLIENT_ID || env.GOOGLE_IOS_CLIENT_ID || env.GOOGLE_ANDROID_CLIENT_ID,
    );
    const appleSet = APPLE_KEYS.filter((k) => Boolean(env[k]));
    const appleAllSet = appleSet.length === APPLE_KEYS.length;
    const appleAnySet = appleSet.length > 0;

    if (appleAnySet && !appleAllSet) {
      const missing = APPLE_KEYS.filter((k) => !env[k]);
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Apple sign-in requires all of ${APPLE_KEYS.join(', ')} (missing: ${missing.join(', ')}).`,
        path: [missing[0]!],
      });
    }

    if (!googleConfigured && !appleAllSet) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'At least one sign-in provider must be configured: set GOOGLE_CLIENT_ID, or set all of ' +
          `${APPLE_KEYS.join(', ')}.`,
        path: ['GOOGLE_CLIENT_ID'],
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/**
 * Read and validate `process.env` once. Subsequent calls return the cached value.
 * @throws ZodError when validation fails - propagates to the entrypoint as a fatal exit.
 */
export function loadEnv(): Env {
  if (cached) return cached;
  cached = EnvSchema.parse(process.env);
  return cached;
}
