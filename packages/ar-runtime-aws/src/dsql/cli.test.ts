import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDsqlAssessmentSources, runDsqlCli } from './cli';

let temporary: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (temporary) await rm(temporary, { recursive: true, force: true });
  temporary = undefined;
});

describe('DSQL evaluation CLI', () => {
  it('reads only the fixed source inventory and returns blockers without SQL values', async () => {
    temporary = await mkdtemp(join(tmpdir(), 'authrim-dsql-cli-'));
    const files: Record<string, string> = {
      'migrations/core/postgresql/001_test.sql':
        'CREATE TRIGGER invariant BEFORE DELETE ON users EXECUTE FUNCTION protect();',
      'migrations/pii/postgresql/001_test.sql': "SELECT 'source-private-value';",
      'packages/ar-runtime-aws/src/storage/schema.sql': 'CREATE TABLE state (id TEXT PRIMARY KEY);',
      'packages/ar-runtime-aws/src/maintenance/database.ts': '',
      'packages/ar-runtime-aws/src/import/aws-schema-bootstrap.ts': '',
      'packages/ar-runtime-aws/src/import/postgres-restore.ts': '',
      'packages/ar-runtime-aws/src/import/state-restore.ts': '',
      'packages/ar-runtime-aws/src/storage/postgres-account-auth-state.ts': '',
      'packages/ar-runtime-aws/src/storage/postgres-authorization-code.ts': '',
      'private/credentials.sql': 'secret-must-not-be-read',
    };
    for (const [name, source] of Object.entries(files)) {
      await mkdir(dirname(join(temporary, name)), { recursive: true });
      await writeFile(join(temporary, name), source);
    }
    const inventory = await loadDsqlAssessmentSources(temporary);
    expect(inventory).toHaveLength(9);
    expect(inventory.some((source) => source.path.startsWith('private/'))).toBe(false);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await runDsqlCli(['assess', '--root', temporary])).toBe(2);
    const report = String(stdout.mock.calls[0][0]);
    expect(report).toContain('"fullRuntimeReady": false');
    expect(report).toContain('"code": "trigger"');
    expect(report).not.toMatch(/source-private-value|secret-must-not-be-read|protect\(\)/);
  });

  it('does not echo malformed configuration, tokens, or arbitrary arguments', async () => {
    temporary = await mkdtemp(join(tmpdir(), 'authrim-dsql-cli-'));
    const config = join(temporary, 'connection.json');
    await writeFile(config, JSON.stringify({ password: 'secret-token', hostname: 'private-host' }));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runDsqlCli(['probe', '--config', config])).toBe(1);
    expect(await runDsqlCli(['probe', '--config', config, '--unknown', 'secret-argument'])).toBe(1);
    expect(stderr.mock.calls.map(([message]) => String(message)).join('')).not.toMatch(
      /secret-token|private-host|secret-argument/
    );
  });

  it('requires explicit writes and a bounded integer count for the native identity probe', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    for (const args of [
      ['identity-probe', '--config', '/not-read/private.json'],
      ['identity-probe', '--config', '/not-read/private.json', '--write-probe', '--users', '0'],
      ['identity-probe', '--config', '/not-read/private.json', '--write-probe', '--users', '2001'],
      ['identity-probe', '--config', '/not-read/private.json', '--write-probe', '--users', '1e3'],
    ])
      expect(await runDsqlCli(args)).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr.mock.calls.map(([message]) => String(message)).join('')).not.toContain(
      '/not-read'
    );
  });

  it('rejects configuration writes without opt-in or a bounded SP count', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    for (const args of [
      ['configuration-probe', '--config', '/not-read/private.json'],
      ...['0', '2001', '1e3', '1.5'].map((count) => [
        'configuration-probe',
        '--config',
        '/not-read/private.json',
        '--write-probe',
        '--sps',
        count,
      ]),
      [
        'configuration-probe',
        '--config',
        '/not-read/private.json',
        '--write-probe',
        '--users',
        '2',
      ],
    ])
      expect(await runDsqlCli(args)).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr.mock.calls.map(([message]) => String(message)).join('')).not.toContain(
      '/not-read'
    );
  });
});
