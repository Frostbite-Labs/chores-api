/**
 * Spec §5.3 — every household-scoped route must declare a
 * `requiresHouseholdPermission` decorator. Rather than booting the app, this
 * test scans the route source files and asserts that each
 * `app.<verb>('/households/:householdId/...'` registration carries the
 * decorator in its config object.
 *
 * The scan is intentionally simple: it pairs each route literal with the
 * adjacent `config: { ... }` block in the same call. If a registration
 * splits across many lines or doesn't have an inline config, this test
 * will flag it — that's the desired behaviour.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = path.resolve(__dirname, '../src/modules');

/** Routes that *intentionally* are not household-scoped even though they touch household state. */
const ALLOWLIST = new Set([
  '/invites/redeem', // POST — the redeemer doesn't know the household yet (spec §8.5).
]);

const VERB_REGEX = /app\.(get|post|patch|delete)\(\s*['"`]([^'"`]+)['"`]\s*,\s*({[\s\S]*?})\s*,/g;

describe('permission decorator coverage', () => {
  it('every household-scoped route declares requiresHouseholdPermission', async () => {
    const files = await collectFiles(MODULES_DIR);
    const issues: string[] = [];
    for (const file of files) {
      const src = await fs.readFile(file, 'utf8');
      let match: RegExpExecArray | null;
      while ((match = VERB_REGEX.exec(src)) !== null) {
        const [, verb, urlPath, optsBlock] = match;
        if (!verb || !urlPath || !optsBlock) continue;
        if (ALLOWLIST.has(urlPath)) continue;
        const isHouseholdScoped = urlPath.includes(':householdId');
        if (!isHouseholdScoped) continue;
        if (!/requiresHouseholdPermission\s*:/.test(optsBlock)) {
          issues.push(`${path.relative(MODULES_DIR, file)} — ${verb.toUpperCase()} ${urlPath} missing requiresHouseholdPermission`);
        }
        if (!/requiresAuth\s*:\s*true/.test(optsBlock)) {
          issues.push(`${path.relative(MODULES_DIR, file)} — ${verb.toUpperCase()} ${urlPath} missing requiresAuth:true`);
        }
      }
    }
    expect(issues, issues.join('\n')).toEqual([]);
  });
});

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectFiles(full)));
    else if (entry.name.endsWith('.routes.ts')) out.push(full);
  }
  return out;
}
