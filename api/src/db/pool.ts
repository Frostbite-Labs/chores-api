/**
 * mysql2 pool + Kysely instance.
 *
 * Why both: mysql2 owns the connection pool and prepared-statement cache,
 * Kysely gives us type-safe SQL composition without ORM magic. We share one
 * pool - Kysely just adopts mysql2's connection.
 */
import mysql from 'mysql2/promise';
import { Kysely, MysqlDialect } from 'kysely';
import type { DB } from '@/types/db.js';
import { loadEnv } from '../config/env.js';

let _pool: mysql.Pool | null = null;
let _db: Kysely<DB> | null = null;

export function getPool(): mysql.Pool {
  if (_pool) return _pool;
  const env = loadEnv();
  _pool = mysql.createPool({
    uri: env.DB_URL,
    waitForConnections: true,
    connectionLimit: 10,
    namedPlaceholders: false,
    timezone: 'Z',
    dateStrings: false,
    supportBigNumbers: true,
    bigNumberStrings: false,
  });
  return _pool;
}

export function getDb(): Kysely<DB> {
  if (_db) return _db;
  _db = new Kysely<DB>({ dialect: new MysqlDialect({ pool: getPool() }) });
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_db) {
    await _db.destroy();
    _db = null;
  }
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
