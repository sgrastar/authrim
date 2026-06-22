import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deployCommandMock = vi.hoisted(() => vi.fn());
const provisionR2BucketsMock = vi.hoisted(() => vi.fn());
const saveMasterWranglerConfigsMock = vi.hoisted(() => vi.fn());

vi.mock('../cli/commands/deploy.js', () => ({
  deployCommand: deployCommandMock,
}));

vi.mock('../core/cloudflare.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/cloudflare.js')>();
  return {
    ...actual,
    provisionR2Buckets: provisionR2BucketsMock,
  };
});

vi.mock('../core/wrangler-sync.js', () => ({
  saveMasterWranglerConfigs: saveMasterWranglerConfigsMock,
}));

import { r2ProvisionCommand } from '../cli/commands/r2-provision.js';

const originalCwd = process.cwd();
let tempDir: string | null = null;

async function writeEnvironment(env: string) {
  const envDir = join(tempDir!, '.authrim', env);
  await mkdir(envDir, { recursive: true });
  await writeFile(
    join(envDir, 'config.json'),
    `${JSON.stringify(
      {
        environment: { prefix: env },
        features: { r2: { enabled: false } },
      },
      null,
      2
    )}\n`,
    'utf-8'
  );
  await writeFile(
    join(envDir, 'lock.json'),
    `${JSON.stringify(
      {
        version: '1.0.0',
        env,
        createdAt: '2026-05-18T00:00:00.000Z',
        updatedAt: '2026-05-18T00:00:00.000Z',
        d1: {},
        kv: {},
      },
      null,
      2
    )}\n`,
    'utf-8'
  );
}

describe('r2-provision command', () => {
  beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'authrim-r2-provision-')));
    process.chdir(tempDir);
    deployCommandMock.mockReset();
    deployCommandMock.mockResolvedValue(undefined);
    provisionR2BucketsMock.mockReset();
    provisionR2BucketsMock.mockResolvedValue([
      { binding: 'AVATARS', name: 'prod-authrim-avatars' },
      { binding: 'DIAGNOSTIC_LOGS', name: 'prod-diagnostic-logs' },
      { binding: 'AUDIT_ARCHIVE', name: 'prod-audit-archive' },
      { binding: 'IMPORT_ARTIFACTS', name: 'prod-import-artifacts' },
      { binding: 'EXPORT_ARTIFACTS', name: 'prod-export-artifacts' },
      { binding: 'SENSITIVE_DETAILS', name: 'prod-sensitive-details' },
    ]);
    saveMasterWranglerConfigsMock.mockReset();
    saveMasterWranglerConfigsMock.mockResolvedValue({
      success: true,
      files: ['ar-management.toml'],
      errors: [],
    });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('creates missing R2 buckets, updates lock/config, and deploys bindings', async () => {
    await writeEnvironment('prod');

    await r2ProvisionCommand({ env: 'prod', yes: true });

    const config = JSON.parse(await readFile(join(tempDir!, '.authrim/prod/config.json'), 'utf-8'));
    const lock = JSON.parse(await readFile(join(tempDir!, '.authrim/prod/lock.json'), 'utf-8'));

    expect(config.features.r2.enabled).toBe(true);
    expect(lock.r2).toEqual({
      AVATARS: { name: 'prod-authrim-avatars' },
      DIAGNOSTIC_LOGS: { name: 'prod-diagnostic-logs' },
      AUDIT_ARCHIVE: { name: 'prod-audit-archive' },
      IMPORT_ARTIFACTS: { name: 'prod-import-artifacts' },
      EXPORT_ARTIFACTS: { name: 'prod-export-artifacts' },
      SENSITIVE_DETAILS: { name: 'prod-sensitive-details' },
    });
    expect(provisionR2BucketsMock).toHaveBeenCalledWith(
      'prod',
      expect.objectContaining({ existing: undefined })
    );
    expect(saveMasterWranglerConfigsMock).toHaveBeenCalledWith(
      expect.objectContaining({ features: expect.objectContaining({ r2: { enabled: true } }) }),
      expect.objectContaining({
        r2: expect.objectContaining({
          DIAGNOSTIC_LOGS: { name: 'prod-diagnostic-logs' },
          SENSITIVE_DETAILS: { name: 'prod-sensitive-details' },
        }),
      }),
      expect.objectContaining({ baseDir: tempDir, env: 'prod' })
    );
    expect(deployCommandMock).toHaveBeenCalledWith({
      env: 'prod',
      config: join(tempDir!, '.authrim', 'prod', 'config.json'),
      source: tempDir,
      yes: true,
    });
  });

  it('can update bucket bindings without deploying when requested', async () => {
    await writeEnvironment('prod');

    await r2ProvisionCommand({ env: 'prod', yes: true, skipDeploy: true });

    expect(deployCommandMock).not.toHaveBeenCalled();
    expect(saveMasterWranglerConfigsMock).toHaveBeenCalledOnce();
    const lock = JSON.parse(await readFile(join(tempDir!, '.authrim/prod/lock.json'), 'utf-8'));
    expect(Object.keys(lock.r2)).toHaveLength(6);
  });

  it('does not update local state or deploy when bucket provisioning fails', async () => {
    await writeEnvironment('prod');
    provisionR2BucketsMock.mockRejectedValueOnce(new Error('missing permission'));

    await expect(r2ProvisionCommand({ env: 'prod', yes: true })).rejects.toThrow(
      /missing permission/
    );

    const config = JSON.parse(await readFile(join(tempDir!, '.authrim/prod/config.json'), 'utf-8'));
    const lock = JSON.parse(await readFile(join(tempDir!, '.authrim/prod/lock.json'), 'utf-8'));

    expect(config.features.r2.enabled).toBe(false);
    expect(lock.r2).toBeUndefined();
    expect(deployCommandMock).not.toHaveBeenCalled();
  });
});
