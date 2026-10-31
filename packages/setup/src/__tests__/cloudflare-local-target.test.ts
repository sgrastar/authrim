import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: execaMock }));

import {
  executeD1Command,
  executeD1Migration,
  getKVKeyByNamespaceId,
  getOptionalKVKeyByNamespaceId,
  putKVKeyByNamespaceId,
  queryD1Rows,
  type LocalWranglerTarget,
} from '../core/cloudflare.js';

const target: LocalWranglerTarget = {
  configPath: '/repo/.authrim-local/local/seed/wrangler.toml',
  persistTo: '/repo/.authrim-local/local/state',
  cwd: '/repo',
};

function argsOfLastCall(): string[] {
  const [, args] = execaMock.mock.calls.at(-1)!;
  return args as string[];
}

describe('D1 and KV helpers with a local target', () => {
  beforeEach(() => {
    execaMock.mockReset();
    execaMock.mockResolvedValue({ exitCode: 0, stdout: '[]', stderr: '' });
  });

  it('runs D1 commands against the local state, never --remote', async () => {
    await executeD1Command('local-authrim-core-db', 'SELECT 1', { target });
    const args = argsOfLastCall();
    expect(args).toEqual(
      expect.arrayContaining([
        'd1',
        'execute',
        'local-authrim-core-db',
        '--local',
        '--persist-to',
        target.persistTo,
        '-c',
        target.configPath,
      ])
    );
    expect(args).not.toContain('--remote');
    expect(execaMock.mock.calls.at(-1)![2]).toMatchObject({ cwd: '/repo' });
  });

  it('still targets the remote database when no target is given', async () => {
    await executeD1Command('prod-authrim-core-db', 'SELECT 1');
    expect(argsOfLastCall()).toContain('--remote');
    expect(argsOfLastCall()).not.toContain('--local');
  });

  it('queries local rows without the Cloudflare API fallback', async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify([{ results: [{ n: 1 }], success: true }]),
      stderr: '',
    });
    await expect(queryD1Rows('db', 'SELECT 1 AS n', { target })).resolves.toEqual([{ n: 1 }]);
    expect(execaMock).toHaveBeenCalledTimes(1);
  });

  it('writes, reads and lists KV in the local state', async () => {
    await putKVKeyByNamespaceId('LOCAL-SETTINGS', 'key', 'value', { target, expirationTtl: 60 });
    expect(argsOfLastCall()).toEqual(
      expect.arrayContaining([
        'kv',
        'key',
        'put',
        'key',
        '--namespace-id',
        'LOCAL-SETTINGS',
        '--local',
        '--persist-to',
        target.persistTo,
        '--ttl',
        '60',
      ])
    );
    expect(argsOfLastCall()).not.toContain('--remote');

    execaMock.mockResolvedValue({ exitCode: 0, stdout: 'value', stderr: '' });
    await getKVKeyByNamespaceId('LOCAL-SETTINGS', 'key', target);
    expect(argsOfLastCall()).toContain('--local');
    expect(argsOfLastCall()).not.toContain('--remote');

    execaMock.mockResolvedValue({ exitCode: 0, stdout: '[]', stderr: '' });
    await expect(
      getOptionalKVKeyByNamespaceId('LOCAL-SETTINGS', 'key', target)
    ).resolves.toBeNull();
    expect(argsOfLastCall()).toEqual(expect.arrayContaining(['kv', 'key', 'list', '--local']));
  });

  it('keeps the remote KV default when no target is given', async () => {
    await putKVKeyByNamespaceId('namespace-id', 'key', 'value');
    expect(argsOfLastCall()).toContain('--remote');
  });

  it('executes a migration file against the local database', async () => {
    const directory = await mkdtemp(join(process.cwd(), '.tmp-local-target-'));
    try {
      await mkdir(directory, { recursive: true });
      const file = join(directory, '001.sql');
      await writeFile(file, 'CREATE TABLE t (id INTEGER);');
      const result = await executeD1Migration('local-authrim-core-db', file, undefined, { target });
      expect(result).toEqual({ success: true });
      expect(argsOfLastCall()).toEqual(
        expect.arrayContaining(['d1', 'execute', '--local', '--file'])
      );
      expect(argsOfLastCall()).not.toContain('--remote');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
