import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deployCommandMock = vi.hoisted(() => vi.fn());
const provisionR2BucketsMock = vi.hoisted(() => vi.fn());
const adoptR2BucketOwnershipMock = vi.hoisted(() => vi.fn());
const getAccountIdMock = vi.hoisted(() => vi.fn());
const listR2BucketsMock = vi.hoisted(() => vi.fn());
const queryD1RowsMock = vi.hoisted(() => vi.fn());
const saveMasterWranglerConfigsMock = vi.hoisted(() => vi.fn());

vi.mock('../cli/commands/deploy.js', () => ({
  deployCommand: deployCommandMock,
}));

vi.mock('../core/cloudflare.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/cloudflare.js')>();
  return {
    ...actual,
    adoptR2BucketOwnership: adoptR2BucketOwnershipMock,
    getAccountId: getAccountIdMock,
    listR2Buckets: listR2BucketsMock,
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

const requiredR2Buckets = [
  ['MIGRATION_RELEASES', 'prod-migration-releases'],
  ['PLUGIN_BUNDLES', 'prod-plugin-bundles'],
  ['PUBLIC_ASSETS', 'prod-public-assets'],
  ['DIAGNOSTIC_LOGS', 'prod-diagnostic-logs'],
  ['AUDIT_ARCHIVE', 'prod-audit-archive'],
  ['IMPORT_ARTIFACTS', 'prod-import-artifacts'],
  ['EXPORT_ARTIFACTS', 'prod-export-artifacts'],
  ['SENSITIVE_DETAILS', 'prod-sensitive-details'],
] as const;

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

async function writeInterruptedInitialDeployWithLegacyR2(): Promise<void> {
  await writeEnvironment('prod');
  const configPath = join(tempDir!, '.authrim/prod/config.json');
  const config = JSON.parse(await readFile(configPath, 'utf-8'));
  config.cloudflare = { accountId: '0123456789abcdef0123456789abcdef' };
  config.features.r2.enabled = true;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');

  const lockPath = join(tempDir!, '.authrim/prod/lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
  delete lock.productVersion;
  lock.releaseUpdate = {
    targetVersion: '0.4.0',
    phase: 'schema_applied',
    manifestChecksum: 'a'.repeat(64),
    startedAt: '2026-05-18T00:00:00.000Z',
    updatedAt: '2026-05-18T00:00:00.000Z',
    appliedTargets: [],
    manualTargets: [],
  };
  lock.r2 = Object.fromEntries(requiredR2Buckets.map(([binding, name]) => [binding, { name }]));
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf-8');
}

describe('r2-provision command', () => {
  beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'authrim-r2-provision-')));
    process.chdir(tempDir);
    deployCommandMock.mockReset();
    deployCommandMock.mockResolvedValue(undefined);
    adoptR2BucketOwnershipMock.mockReset();
    adoptR2BucketOwnershipMock.mockImplementation(async (input) => {
      const ownershipId = input.prepared?.ownershipId ?? '99999999-9999-4999-8999-999999999999';
      const identity = {
        name: input.name,
        creationDate: input.prepared?.creationDate ?? '2026-05-18T00:00:00.000Z',
        ownershipMarkerKey:
          input.prepared?.ownershipMarkerKey ??
          `__authrim_setup__/ownership-v1-${ownershipId}.json`,
        ownershipId,
        environment: input.environment,
        binding: input.binding,
      };
      await input.onPrepared(identity);
      return identity;
    });
    provisionR2BucketsMock.mockReset();
    provisionR2BucketsMock.mockResolvedValue(
      [
        ['MIGRATION_RELEASES', 'prod-migration-releases'],
        ['PLUGIN_BUNDLES', 'prod-plugin-bundles'],
        ['PUBLIC_ASSETS', 'prod-public-assets'],
        ['DIAGNOSTIC_LOGS', 'prod-diagnostic-logs'],
        ['AUDIT_ARCHIVE', 'prod-audit-archive'],
        ['IMPORT_ARTIFACTS', 'prod-import-artifacts'],
        ['EXPORT_ARTIFACTS', 'prod-export-artifacts'],
        ['SENSITIVE_DETAILS', 'prod-sensitive-details'],
      ].map(([binding, name], index) => {
        const ownershipId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
        return {
          binding,
          name,
          creationDate: '2026-05-18T00:00:00.000Z',
          ownershipMarkerKey: `__authrim_setup__/ownership-v1-${ownershipId}.json`,
          ownershipId,
        };
      })
    );
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
    getAccountIdMock.mockReset();
    getAccountIdMock.mockResolvedValue('0123456789abcdef0123456789abcdef');
    listR2BucketsMock.mockReset();
    listR2BucketsMock.mockResolvedValue(
      requiredR2Buckets.map(([, name]) => ({
        name,
        creationDate: '2026-05-18T00:00:00.000Z',
      }))
    );
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
    expect(lock.r2.MIGRATION_RELEASES).toEqual({
      name: 'prod-migration-releases',
      creationDate: '2026-05-18T00:00:00.000Z',
      ownershipMarkerKey:
        '__authrim_setup__/ownership-v1-00000000-0000-4000-8000-000000000001.json',
      ownershipId: '00000000-0000-4000-8000-000000000001',
    });
    expect(Object.keys(lock.r2)).toHaveLength(8);
    expect(provisionR2BucketsMock).toHaveBeenCalledWith(
      'prod',
      expect.objectContaining({ existing: undefined })
    );
    expect(saveMasterWranglerConfigsMock).toHaveBeenCalledWith(
      expect.objectContaining({ features: expect.objectContaining({ r2: { enabled: true } }) }),
      expect.objectContaining({
        r2: expect.objectContaining({
          MIGRATION_RELEASES: expect.objectContaining({ name: 'prod-migration-releases' }),
          PUBLIC_ASSETS: expect.objectContaining({ name: 'prod-public-assets' }),
          DIAGNOSTIC_LOGS: expect.objectContaining({ name: 'prod-diagnostic-logs' }),
          SENSITIVE_DETAILS: expect.objectContaining({ name: 'prod-sensitive-details' }),
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

  it('rejects a canonical config that belongs to another environment before R2 mutation', async () => {
    await writeEnvironment('prod');
    const configPath = join(tempDir!, '.authrim/prod/config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    config.environment.prefix = 'another-environment';
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');

    await expect(r2ProvisionCommand({ env: 'prod', yes: true })).rejects.toThrow(
      'r2_provision_config_environment_mismatch'
    );
    expect(provisionR2BucketsMock).not.toHaveBeenCalled();
    expect(deployCommandMock).not.toHaveBeenCalled();
  });

  it('always deploys the new bucket topology after updating local bindings', async () => {
    await writeEnvironment('prod');

    await r2ProvisionCommand({ env: 'prod', yes: true });

    expect(deployCommandMock).toHaveBeenCalledOnce();
    expect(saveMasterWranglerConfigsMock).toHaveBeenCalledOnce();
    const lock = JSON.parse(await readFile(join(tempDir!, '.authrim/prod/lock.json'), 'utf-8'));
    expect(Object.keys(lock.r2)).toHaveLength(8);
  });

  it('explicitly adopts every legacy bucket during an interrupted initial deploy only', async () => {
    await writeInterruptedInitialDeployWithLegacyR2();
    const lockPath = join(tempDir!, '.authrim/prod/lock.json');

    await r2ProvisionCommand({ env: 'prod', adoptLegacyR2Ownership: true, yes: true });

    expect(adoptR2BucketOwnershipMock).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: 'prod',
        binding: 'MIGRATION_RELEASES',
        name: 'prod-migration-releases',
        prepared: { name: 'prod-migration-releases' },
      })
    );
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(lock.r2.MIGRATION_RELEASES).toMatchObject({
      name: 'prod-migration-releases',
      creationDate: '2026-05-18T00:00:00.000Z',
      ownershipMarkerKey:
        '__authrim_setup__/ownership-v1-99999999-9999-4999-8999-999999999999.json',
      ownershipId: '99999999-9999-4999-8999-999999999999',
    });
    expect(Object.keys(lock.r2)).toHaveLength(8);
    expect(listR2BucketsMock).toHaveBeenCalledWith({
      throwOnError: true,
      requireIdentity: true,
    });
    expect(provisionR2BucketsMock).not.toHaveBeenCalled();
    expect(saveMasterWranglerConfigsMock).not.toHaveBeenCalled();
    expect(deployCommandMock).not.toHaveBeenCalled();
    expect(existsSync(`${lockPath}.operation-lock`)).toBe(false);
  });

  it('blocks legacy ownership adoption from the normal topology command', async () => {
    await writeEnvironment('prod');
    const lockPath = join(tempDir!, '.authrim/prod/lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    lock.r2 = { MIGRATION_RELEASES: { name: 'prod-migration-releases' } };
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf-8');

    await expect(r2ProvisionCommand({ env: 'prod', yes: true })).rejects.toThrow(
      '--adopt-legacy-r2-ownership'
    );
    expect(adoptR2BucketOwnershipMock).not.toHaveBeenCalled();
    expect(provisionR2BucketsMock).not.toHaveBeenCalled();
  });

  it('preflights every provider bucket before writing the first ownership marker', async () => {
    await writeInterruptedInitialDeployWithLegacyR2();
    listR2BucketsMock.mockResolvedValueOnce(
      requiredR2Buckets.slice(0, -1).map(([, name]) => ({
        name,
        creationDate: '2026-05-18T00:00:00.000Z',
      }))
    );

    await expect(
      r2ProvisionCommand({ env: 'prod', adoptLegacyR2Ownership: true, yes: true })
    ).rejects.toThrow('r2_legacy_ownership_adoption_provider_bucket_missing');
    expect(adoptR2BucketOwnershipMock).not.toHaveBeenCalled();
    const lock = JSON.parse(await readFile(join(tempDir!, '.authrim/prod/lock.json'), 'utf-8'));
    expect(lock.r2).toEqual(
      Object.fromEntries(requiredR2Buckets.map(([binding, name]) => [binding, { name }]))
    );
  });

  it('rejects ownership adoption when the authenticated Cloudflare account differs', async () => {
    await writeInterruptedInitialDeployWithLegacyR2();
    getAccountIdMock.mockResolvedValueOnce('ffffffffffffffffffffffffffffffff');

    await expect(
      r2ProvisionCommand({ env: 'prod', adoptLegacyR2Ownership: true, yes: true })
    ).rejects.toThrow('r2_legacy_ownership_adoption_account_id_mismatch');
    expect(listR2BucketsMock).not.toHaveBeenCalled();
    expect(adoptR2BucketOwnershipMock).not.toHaveBeenCalled();
  });

  it('resumes the same prepared ownership claim after marker write failure', async () => {
    await writeInterruptedInitialDeployWithLegacyR2();
    const defaultAdopt = adoptR2BucketOwnershipMock.getMockImplementation();
    adoptR2BucketOwnershipMock.mockImplementationOnce(async (input) => {
      const ownershipId = '88888888-8888-4888-8888-888888888888';
      await input.onPrepared({
        name: input.name,
        creationDate: '2026-05-18T00:00:00.000Z',
        ownershipMarkerKey: `__authrim_setup__/ownership-v1-${ownershipId}.json`,
        ownershipId,
        environment: input.environment,
        binding: input.binding,
      });
      throw new Error('marker write response lost');
    });

    await expect(
      r2ProvisionCommand({ env: 'prod', adoptLegacyR2Ownership: true, yes: true })
    ).rejects.toThrow('marker write response lost');
    expect(existsSync(join(tempDir!, '.authrim/prod/lock.json.operation-lock'))).toBe(false);

    adoptR2BucketOwnershipMock.mockImplementation(defaultAdopt!);
    await expect(
      r2ProvisionCommand({ env: 'prod', adoptLegacyR2Ownership: true, yes: true })
    ).resolves.toBeUndefined();
    expect(adoptR2BucketOwnershipMock.mock.calls[1]?.[0].prepared).toMatchObject({
      ownershipId: '88888888-8888-4888-8888-888888888888',
      ownershipMarkerKey:
        '__authrim_setup__/ownership-v1-88888888-8888-4888-8888-888888888888.json',
    });
    expect(provisionR2BucketsMock).not.toHaveBeenCalled();
    expect(deployCommandMock).not.toHaveBeenCalled();
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

  it('releases the environment operation lock when wrangler config refresh fails', async () => {
    await writeEnvironment('prod');
    saveMasterWranglerConfigsMock.mockResolvedValueOnce({
      success: false,
      files: [],
      errors: ['write failed'],
    });

    await expect(r2ProvisionCommand({ env: 'prod', yes: true })).rejects.toThrow('write failed');

    expect(existsSync(join(tempDir!, '.authrim/prod/lock.json.operation-lock'))).toBe(false);
    saveMasterWranglerConfigsMock.mockResolvedValueOnce({
      success: true,
      files: ['ar-management.toml'],
      errors: [],
    });
    await expect(r2ProvisionCommand({ env: 'prod', yes: true })).resolves.toBeUndefined();
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
