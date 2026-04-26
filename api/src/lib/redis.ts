/**
 * Singleton Redis client used by rate-limit and Apple-nonce subsystems.
 */
import Redis from 'ioredis';
import { loadEnv } from '../config/env.js';

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (_redis) return _redis;
  const env = loadEnv();
  _redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
  return _redis;
}

export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}
