import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig, type AuthrimConfig } from '../core/config.js';

const deployCommandMock = vi.hoisted(() => vi.fn());

vi.mock('../cli/commands/deploy.js', () => ({
  deployCommand: deployCommandMock,
}));

vi.mock('../core/cloudflare.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/cloudflare.js')>();
  return {
    ...actual,
    findMigrationsRoot: vi.fn(async () => ({ path: '/virtual/migrations', searchPaths: [] })),
  };
});

vi.mock('../core/version.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/version.js')>();
  return {
    ...actual,
    getRootProductVersion: vi.fn(async () => '0.4.0'),
  };
});

vi.mock('../core/release-migrations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/release-migrations.js')>();
  return {
    ...actual,
    loadInstalledReleaseMigrationManifest: vi.fn(() => ({
      path: '/virtual/migrations/releases/0.4.0.json',
      manifest: {
        formatVersion: 1,
        productVersion: '0.4.0',
        streams: [
          {
            id: 'external-postgres-core',
            dialect: 'postgres',
            logicalRoles: ['core'],
            files: [],
          },
          {
            id: 'external-postgres-pii',
            dialect: 'postgres',
            logicalRoles: ['pii'],
            files: [],
          },
        ],
      },
    })),
  };
});

import { externalDatabaseRegisterCommand } from '../cli/commands/external-db-register.js';

const originalCwd = process.cwd();
let tempDir: string | null = null;

function externalPostgresConfig(env: string, base?: AuthrimConfig): AuthrimConfig {
  const config = structuredClone(base ?? createDefaultConfig(env));
  config.profiles.defaults.storage = 'builtin:storage:external-postgres';
  config.profiles.references.hyperdrive = {
    'core-primary': { binding: 'HYPERDRIVE_CORE_PRIMARY', id: 'hd-core', driver: 'postgres' },
    'pii-primary': { binding: 'HYPERDRIVE_PII_PRIMARY', id: 'hd-pii', driver: 'postgres' },
  };
  return config;
}

async function writeEnvironment(env: string): Promise<{ candidatePath: string }> {
  const environmentDir = join(tempDir!, '.authrim', env);
  await mkdir(environmentDir, { recursive: true });
  const currentConfig = createDefaultConfig(env);
  await writeFile(
    join(environmentDir, 'config.json'),
    `${JSON.stringify(currentConfig, null, 2)}\n`
  );
  await writeFile(
    join(environmentDir, 'lock.json'),
    `${JSON.stringify(
      {
        version: '1.0.0',
        productVersion: '0.4.0',
        env,
        createdAt: '2026-07-21T00:00:00.000Z',
        updatedAt: '2026-07-21T00:00:00.000Z',
        d1: {},
        kv: {},
      },
      null,
      2
    )}\n`
  );
  const candidatePath = join(tempDir!, 'external-config.json');
  await writeFile(
    candidatePath,
    `${JSON.stringify(externalPostgresConfig(env, currentConfig), null, 2)}\n`
  );
  return { candidatePath };
}

describe('external-db-register command', () => {
  beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'authrim-external-db-register-')));
    process.chdir(tempDir);
    deployCommandMock.mockReset();
    deployCommandMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('requires explicit schema readiness without changing the environment', async () => {
    const { candidatePath } = await writeEnvironment('prod');
    const configPath = join(tempDir!, '.authrim/prod/config.json');
    const before = await readFile(configPath, 'utf-8');

    await expect(
      externalDatabaseRegisterCommand({ env: 'prod', config: candidatePath, yes: true })
    ).rejects.toThrow('external_database_schema_acknowledgement_required');

    expect(await readFile(configPath, 'utf-8')).toBe(before);
    expect(deployCommandMock).not.toHaveBeenCalled();
  });

  it('records current-release evidence and deploys the acknowledged external topology', async () => {
    const { candidatePath } = await writeEnvironment('prod');

    await externalDatabaseRegisterCommand({
      env: 'prod',
      config: candidatePath,
      externalSchemaReady: true,
      yes: true,
    });

    const config = JSON.parse(
      await readFile(join(tempDir!, '.authrim/prod/config.json'), 'utf-8')
    ) as AuthrimConfig;
    const lock = JSON.parse(await readFile(join(tempDir!, '.authrim/prod/lock.json'), 'utf-8')) as {
      schemaTargets: Record<string, { streamId: string; appliedBy: string }>;
    };
    expect(config.profiles.defaults.storage).toBe('builtin:storage:external-postgres');
    expect(lock.schemaTargets).toMatchObject({
      'external:postgres:core-primary:external-postgres-core': {
        streamId: 'external-postgres-core',
        appliedBy: 'operator',
      },
      'external:postgres:pii-primary:external-postgres-pii': {
        streamId: 'external-postgres-pii',
        appliedBy: 'operator',
      },
    });
    expect(deployCommandMock).toHaveBeenCalledWith({
      env: 'prod',
      config: join(tempDir!, '.authrim', 'prod', 'config.json'),
      source: tempDir,
      yes: true,
      operationKind: 'topology_change',
    });
  });

  it('rejects unrelated configuration changes in the candidate file', async () => {
    const { candidatePath } = await writeEnvironment('prod');
    const candidate = externalPostgresConfig('prod');
    candidate.oidc.accessTokenTtl += 1;
    await writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);

    await expect(
      externalDatabaseRegisterCommand({
        env: 'prod',
        config: candidatePath,
        externalSchemaReady: true,
        yes: true,
      })
    ).rejects.toThrow('external_database_command_accepts_only_profile_and_hyperdrive_changes');
    expect(deployCommandMock).not.toHaveBeenCalled();
  });

  it('resumes the exact registered topology after Worker deployment failure', async () => {
    const { candidatePath } = await writeEnvironment('prod');
    deployCommandMock.mockRejectedValueOnce(new Error('worker deploy failed'));

    await expect(
      externalDatabaseRegisterCommand({
        env: 'prod',
        config: candidatePath,
        externalSchemaReady: true,
        yes: true,
      })
    ).rejects.toThrow('worker deploy failed');
    const pendingLock = JSON.parse(
      await readFile(join(tempDir!, '.authrim/prod/lock.json'), 'utf-8')
    );
    expect(pendingLock.topologyUpdate).toMatchObject({
      kind: 'external_database',
      phase: 'pending_deploy',
    });

    deployCommandMock.mockResolvedValueOnce(undefined);
    await externalDatabaseRegisterCommand({
      env: 'prod',
      yes: true,
    });
    expect(deployCommandMock).toHaveBeenCalledTimes(2);
  });
});
