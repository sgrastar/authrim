import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deployCommandMock = vi.hoisted(() => vi.fn());

vi.mock('../cli/commands/deploy.js', () => ({
  deployCommand: deployCommandMock,
}));

import { tenantDatabasePoolExpandCommand } from '../cli/commands/tenant-db-pool-expand.js';

const originalCwd = process.cwd();
let tempDir: string | null = null;

async function writeTenantD1Config(env: string, preallocatedSlots: number) {
  const envDir = join(tempDir!, '.authrim', env);
  await mkdir(envDir, { recursive: true });
  await writeFile(
    join(envDir, 'config.json'),
    `${JSON.stringify(
      {
        environment: { prefix: env },
        profiles: { defaults: { storage: 'builtin:storage:tenant-d1' } },
        tenantD1: { preallocatedSlots },
      },
      null,
      2
    )}\n`,
    'utf-8'
  );
}

async function readConfig(env: string) {
  return JSON.parse(await readFile(join(tempDir!, '.authrim', env, 'config.json'), 'utf-8')) as {
    tenantD1?: { preallocatedSlots?: number };
  };
}

describe('tenant-db pool expand command', () => {
  beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'authrim-pool-expand-')));
    process.chdir(tempDir);
    deployCommandMock.mockReset();
    deployCommandMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('updates preallocated slot count and deploys the existing environment', async () => {
    await writeTenantD1Config('prod', 3);

    await tenantDatabasePoolExpandCommand({ env: 'prod', addSlots: '2', yes: true });

    await expect(readConfig('prod')).resolves.toMatchObject({
      tenantD1: { preallocatedSlots: 5 },
    });
    expect(deployCommandMock).toHaveBeenCalledWith({
      env: 'prod',
      config: join(tempDir!, '.authrim', 'prod', 'config.json'),
      source: tempDir,
      yes: true,
    });
  });

  it('keeps the expanded config when deployment fails so rerun can recover', async () => {
    await writeTenantD1Config('prod', 3);
    deployCommandMock.mockRejectedValueOnce(new Error('worker deploy failed'));

    await expect(
      tenantDatabasePoolExpandCommand({ env: 'prod', addSlots: '2', yes: true })
    ).rejects.toThrow('worker deploy failed');

    await expect(readConfig('prod')).resolves.toMatchObject({
      tenantD1: { preallocatedSlots: 5 },
    });
  });
});
