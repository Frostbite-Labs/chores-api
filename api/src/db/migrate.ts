/**
 * Forward-only SQL migrator (spec §11). Reads `migrations/NNNN_*.sql` in
 * lexicographic order and applies any whose name is not in `schema_migrations`.
 *
 * Each file is one statement (or a small batch of related statements). MySQL
 * implicit-commits DDL, so a true transactional rollback is not possible —
 * keeping migrations small and additive is the discipline that makes this safe.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { loadEnv } from '../config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface MigrationFile {
  name: string;
  sql: string;
}

async function loadMigrations(): Promise<MigrationFile[]> {
  const dir = path.join(__dirname, 'migrations');
  const entries = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(
    entries.map(async (name) => ({ name, sql: await fs.readFile(path.join(dir, name), 'utf8') })),
  );
}

async function ensureMigrationsTable(conn: mysql.Connection): Promise<void> {
  await conn.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name VARCHAR(255) NOT NULL,
       applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       PRIMARY KEY (name)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );
}

async function listApplied(conn: mysql.Connection): Promise<Set<string>> {
  const [rows] = await conn.query<mysql.RowDataPacket[]>('SELECT name FROM schema_migrations');
  return new Set(rows.map((r) => r['name'] as string));
}

async function up(): Promise<void> {
  const env = loadEnv();
  const conn = await mysql.createConnection({ uri: env.DB_URL, multipleStatements: true });
  try {
    await ensureMigrationsTable(conn);
    const applied = await listApplied(conn);
    const all = await loadMigrations();
    const pending = all.filter((m) => !applied.has(m.name));
    if (pending.length === 0) {
      // eslint-disable-next-line no-console
      console.log('No migrations to apply.');
      return;
    }
    for (const m of pending) {
      // eslint-disable-next-line no-console
      console.log(`Applying ${m.name}…`);
      await conn.query(m.sql);
      await conn.execute('INSERT INTO schema_migrations (name) VALUES (?)', [m.name]);
    }
    // eslint-disable-next-line no-console
    console.log(`Applied ${pending.length} migration(s).`);
  } finally {
    await conn.end();
  }
}

async function status(): Promise<void> {
  const env = loadEnv();
  const conn = await mysql.createConnection({ uri: env.DB_URL });
  try {
    await ensureMigrationsTable(conn);
    const applied = await listApplied(conn);
    const all = await loadMigrations();
    for (const m of all) {
      // eslint-disable-next-line no-console
      console.log(`${applied.has(m.name) ? '[x]' : '[ ]'} ${m.name}`);
    }
  } finally {
    await conn.end();
  }
}

const cmd = process.argv[2];
if (cmd === 'up') await up();
else if (cmd === 'status') await status();
else {
  // eslint-disable-next-line no-console
  console.error('Usage: tsx src/db/migrate.ts <up|status>');
  process.exit(1);
}
