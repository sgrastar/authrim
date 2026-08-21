import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deployCommandMock = vi.hoisted(() => vi.fn());
const provisionR2BucketsMock = vi.hoisted(() => vi.fn());
const queryD1RowsMock = vi.hoisted(() => vi.fn());
const saveMasterWranglerConfigsMock = vi.hoisted(() => vi.fn());

vi.mock('../cli/commands/deploy.js', () => ({
  deployCommand: deployCommandMock,
}));

vi.mock('../core/cloudflare.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/cloudflare.js')>();
  return {
    ...actual,
    provisionR2Buckets: provisionR2BucketsMock,
    queryD1Rows: queryD1RowsMock,
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
    join(tempDir!, 'package.json'),
    `${JSON.stringify({ name: 'authrim-test-installation', version: '0.4.0' }, null, 2)}\n`,
    'utf-8'
  );
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
        productVersion: '0.4.0',
        env,
        createdAt: '2026-05-18T00:00:00.000Z',
        updatedAt: '2026-05-18T00:00:00.000Z',
        d1: {
          CONTROL_DB: { id: 'control-id', name: `${env}-authrim-control-db` },
        },
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
      { binding: 'MIGRATION_RELEASES', name: 'prod-migration-releases' },
      { binding: 'PLUGIN_BUNDLES', name: 'prod-plugin-bundles' },
      { binding: 'PUBLIC_ASSETS', name: 'prod-public-assets' },
      { binding: 'DIAGNOSTIC_LOGS', name: 'prod-diagnostic-logs' },
      { binding: 'AUDIT_ARCHIVE', name: 'prod-audit-archive' },
      { binding: 'IMPORT_ARTIFACTS', name: 'prod-import-artifacts' },
      { binding: 'EXPORT_ARTIFACTS', name: 'prod-export-artifacts' },
      { binding: 'SENSITIVE_DETAILS', name: 'prod-sensitive-details' },
    ]);
    queryD1RowsMock
      .mockReset()
      .mockImplementation(async (_databaseName, sql: string) =>
        sql.includes("name = 'control_plugin_desired_resources'")
          ? [{ name: 'control_plugin_desired_resources' }]
          : []
      );
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
      MIGRATION_RELEASES: { name: 'prod-migration-releases' },
      PLUGIN_BUNDLES: { name: 'prod-plugin-bundles' },
      PUBLIC_ASSETS: { name: 'prod-public-assets' },
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
          MIGRATION_RELEASES: { name: 'prod-migration-releases' },
          PUBLIC_ASSETS: { name: 'prod-public-assets' },
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
      operationKind: 'topology_change',
    });
  });

  it('always deploys the new bucket topology after updating local bindings', async () => {
    await writeEnvironment('prod');

    await r2ProvisionCommand({ env: 'prod', yes: true });

    expect(deployCommandMock).toHaveBeenCalledOnce();
    expect(saveMasterWranglerConfigsMock).toHaveBeenCalledOnce();
    const lock = JSON.parse(await readFile(join(tempDir!, '.authrim/prod/lock.json'), 'utf-8'));
    expect(Object.keys(lock.r2)).toHaveLength(8);
  });

  it('fails closed for a retired avatar binding instead of silently stranding its objects', async () => {
    await writeEnvironment('prod');
    const lockPath = join(tempDir!, '.authrim/prod/lock.json');
    const legacyLock = JSON.parse(await readFile(lockPath, 'utf-8'));
    legacyLock.r2 = { AVATARS: { name: 'prod-authrim-avatars' } };
    await writeFile(lockPath, `${JSON.stringify(legacyLock, null, 2)}\n`, 'utf-8');

    await expect(r2ProvisionCommand({ env: 'prod', yes: true })).rejects.toThrow(
      /legacy_avatar_bucket_is_not_supported/
    );

    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(lock.r2).toEqual({ AVATARS: { name: 'prod-authrim-avatars' } });
    expect(deployCommandMock).not.toHaveBeenCalled();
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

  it('persists a deployment journal so a failed Worker deploy can be retried', async () => {
    await writeEnvironment('prod');
    deployCommandMock.mockRejectedValueOnce(new Error('worker deploy failed'));

    await expect(r2ProvisionCommand({ env: 'prod', yes: true })).rejects.toThrow(
      'worker deploy failed'
    );
    const pendingLock = JSON.parse(
      await readFile(join(tempDir!, '.authrim/prod/lock.json'), 'utf-8')
    );
    expect(pendingLock.topologyUpdate).toMatchObject({ kind: 'r2', phase: 'pending_deploy' });

    deployCommandMock.mockResolvedValueOnce(undefined);
    await r2ProvisionCommand({ env: 'prod', yes: true });
    expect(deployCommandMock).toHaveBeenCalledTimes(2);
  });
});
