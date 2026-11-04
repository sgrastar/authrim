import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: execaMock }));

import { buildRuntimeProfileSeedSql, seedRuntimeProfiles } from '../core/cloudflare.js';
import { createDefaultConfig } from '../core/config.js';

const ok = { exitCode: 0, stdout: '', stderr: '', timedOut: false };

function configWith(backend: 'kv' | 'database') {
  const config = createDefaultConfig('dev');
  config.profiles.registry.backend = backend;
  config.profiles.seed.audit = [
    {
      id: 'custom:audit:http-export',
      label: 'HTTP Export',
      primary: null,
      archive: null,
      sinks: [{ type: 'http', url: 'https://example.com/audit' }],
    },
  ];
  return config;
}

/** The wrangler arguments of each call, after `npx wrangler`. */
function calls(): string[][] {
  return execaMock.mock.calls.map((call) => (call[1] as string[]).slice(1));
}

describe('seedRuntimeProfiles writes D1 first, for every backend', () => {
  beforeEach(() => {
    execaMock.mockReset();
    execaMock.mockResolvedValue(ok);
  });

  it('with the KV backend: the D1 row first (the source of truth), then the KV projection', async () => {
    const result = await seedRuntimeProfiles('dev', configWith('kv'), undefined, {
      databaseIdentifier: 'core-db',
    });
    expect(result).toMatchObject({ success: true, backend: 'kv', seededCount: 1 });
    const [first, ...rest] = calls();
    expect(first.slice(0, 3)).toEqual(['d1', 'execute', 'core-db']);
    expect(first.join(' ')).toContain('profile_registry');
    expect(rest.length).toBeGreaterThan(0);
    for (const args of rest) expect(args.slice(0, 3)).toEqual(['kv', 'key', 'put']);
    // The same payload goes to both.
    const sql = first[first.indexOf('--command') + 1];
    expect(rest[0][3]).toBe('profile-registry:audit:custom:audit:http-export');
    expect(sql).toContain(rest[0][4].replace(/'/g, "''"));
  });

  it('with the KV backend: nothing is written to KV when the D1 seed fails', async () => {
    execaMock.mockResolvedValueOnce({ ...ok, exitCode: 1, stderr: 'no such table' });
    const result = await seedRuntimeProfiles('dev', configWith('kv'), undefined, {
      databaseIdentifier: 'core-db',
    });
    expect(result.success).toBe(false);
    expect(calls().every((args) => args[0] === 'd1')).toBe(true);
  });

  it('with the database backend: D1 only', async () => {
    const result = await seedRuntimeProfiles('dev', configWith('database'), undefined, {
      databaseIdentifier: 'core-db',
    });
    expect(result).toMatchObject({ success: true, backend: 'database' });
    expect(calls().map((args) => args[0])).toEqual(['d1']);
  });
});

describe('the seed SQL replaces a tombstone', () => {
  it('overwrites a deleted-profile row (an explicit seed is the operator intent)', () => {
    let sqlite3: string | null = null;
    try {
      sqlite3 = execFileSync('which', ['sqlite3'], { encoding: 'utf-8' }).trim() || null;
    } catch {
      sqlite3 = null;
    }
    if (!sqlite3) return;
    const dbPath = join(mkdtempSync(join(tmpdir(), 'authrim-profile-seed-')), 'test.db');
    const run = (sql: string) =>
      execFileSync(sqlite3 as string, [dbPath], { input: sql, encoding: 'utf-8' });
    run(`CREATE TABLE profile_registry (
      id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      PRIMARY KEY (kind, id));
      INSERT INTO profile_registry (id, kind, payload_json)
        VALUES ('custom:audit:http-export', 'audit', '{"__authrim_profile_deleted":true}');`);
    run(buildRuntimeProfileSeedSql(configWith('kv')) as string);
    const stored = execFileSync(
      sqlite3,
      [dbPath, "SELECT payload_json FROM profile_registry WHERE id = 'custom:audit:http-export'"],
      { encoding: 'utf-8' }
    );
    expect(stored).toContain('"type":"http"');
    expect(stored).not.toContain('__authrim_profile_deleted');
  });
});
