import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createReplicationPlan,
  parseReplicationConfiguration,
  parseReplicationPlan,
  replicationPlanDigest,
  type ReplicationConfiguration,
} from './plan';
import { canonicalRestoreJson } from '../import/restore-evidence';
import { runReplicationCli, replicationAuthorityDatabaseUrl } from './cli';

const folders: string[] = [];
const executor = 'a'.repeat(64);
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = 0;
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'authrim-replication-plan-'));
  folders.push(directory);
  const schemaPath = join(directory, 'schema.sql');
  const sql = 'CREATE TABLE example (id text PRIMARY KEY);';
  await writeFile(schemaPath, sql, { mode: 0o600 });
  const pin = { path: schemaPath, sha256: createHash('sha256').update(sql).digest('hex') };
  const config: ReplicationConfiguration = {
    formatVersion: 1,
    pair: {
      pairId: 'pair-a',
      tenantId: 'tenant-a',
      deployments: [
        { deploymentId: 'cf-a', provider: 'cloudflare' },
        { deploymentId: 'aws-a', provider: 'aws' },
      ],
      initialOwnerDeploymentId: 'cf-a',
      initialGenerationId: 'initial-a',
    },
    sourceDeploymentId: 'cf-a',
    destinationDeploymentId: 'aws-a',
    expectedEpoch: 1,
    maxSnapshotAgeMs: 3_600_000,
    authority: {
      endpoint: 'https://authority.example.test/replication/v1/rpc',
      credentialId: 'controller-a',
      secretEnv: 'AUTHORITY_SECRET',
      databaseUrlEnv: 'AUTHORITY_DB',
    },
    source: {
      kind: 'cloudflare',
      managementOrigin: 'https://source.example.test',
      grantId: 'grant-a',
      credentialEnv: 'EXPORT_TOKEN',
      passphraseEnv: 'BACKUP_PASSPHRASE',
      identity: {
        tenantId: 'tenant-a',
        issuer: 'https://issuer.example.test',
        productVersion: '0.4.2',
      },
    },
    destination: {
      kind: 'aws',
      sql: 'postgresql',
      environmentName: 'aws-a',
      masterUrlEnv: 'TARGET_MASTER_DB',
      credentialSeedEnv: 'GENERATION_SEED',
      databasePrefix: 'replica',
      coreBindingRefs: ['core-a'],
      piiBindingRefs: ['pii-a'],
      spEntityIds: ['https://sp.example.test/entity'],
      allocationScope: 'tenant_exclusive',
      flowHmacSecretEnv: 'FLOW_SECRET',
      lookupReadKeys: [{ generation: 1, secretEnv: 'LOOKUP_SECRET' }],
      ui: {
        components: { loginUi: false, adminUi: false },
        ui: { login: { mode: 'disabled' }, admin: { mode: 'disabled' } },
      },
      authState: { backend: 'postgresql' },
      writerCredentialId: 'aws-writer',
      writerSecretEnv: 'AWS_WRITER_SECRET',
      artifacts: {
        region: 'ap-northeast-1',
        bucket: 'replication-example',
        bucketOwner: '123456789012',
        keyPrefix: 'generations',
        kmsKeyArn:
          'arn:aws:kms:ap-northeast-1:123456789012:key/11111111-1111-4111-8111-111111111111',
        secretNamePrefix: 'authrim-replication',
      },
      schemas: { core: [pin], pii: [pin], state: [pin] },
    },
  };
  return { directory, schemaPath, config };
}

describe('replication reviewed plans', () => {
  it('pins executable and schema contents locally without contacting either provider', async () => {
    const { config } = await fixture();
    const network = vi.fn(() => {
      throw new Error('unexpected network');
    });
    vi.stubGlobal('fetch', network);
    const plan = await createReplicationPlan(config, executor, 1000);
    expect(parseReplicationPlan(canonicalRestoreJson(plan), executor)).toEqual(plan);
    expect(replicationPlanDigest(plan)).toMatch(/^[a-f0-9]{64}$/u);
    expect(network).not.toHaveBeenCalled();
    expect(plan.configuration.destination.ui.ui.login.mode).toBe('disabled');
    expect(canonicalRestoreJson(plan)).not.toContain('postgresql://');
  });
  it.each([
    'epoch',
    'tenant',
    'same-deployment',
    'dsql',
    'inline-secret',
    'unsafe-origin',
    'wrong-key-account',
    'unknown-field',
  ])('rejects %s before resources or files are created', async (variant) => {
    const { config } = await fixture();
    if (variant === 'epoch') config.expectedEpoch = 0;
    if (variant === 'tenant') config.source.identity.tenantId = 'different';
    if (variant === 'same-deployment') config.destinationDeploymentId = config.sourceDeploymentId;
    if (variant === 'dsql') Object.assign(config.destination, { sql: 'dsql' });
    if (variant === 'inline-secret') config.authority.secretEnv = 'private-inline-value';
    if (variant === 'unsafe-origin')
      config.source.managementOrigin = 'https://secret@source.example.test';
    if (variant === 'wrong-key-account')
      config.destination.artifacts.kmsKeyArn = config.destination.artifacts.kmsKeyArn.replace(
        '123456789012',
        '999999999999'
      );
    if (variant === 'unknown-field') Object.assign(config, { force: true });
    expect(() => parseReplicationConfiguration(config)).toThrow('replication_plan_invalid');
  });
  it('pins optional bootstrap owner and separate least-privilege service and journal roles', async () => {
    const { config } = await fixture();
    config.authority.bootstrap = {
      databaseUrlEnv: 'AUTHORITY_BOOTSTRAP_DB',
      serviceRole: 'authrim_service',
      journalRole: 'authrim_journal',
    };
    const plan = await createReplicationPlan(config, executor);
    expect(
      parseReplicationPlan(canonicalRestoreJson(plan), executor).configuration.authority.bootstrap
    ).toEqual(config.authority.bootstrap);
    expect(canonicalRestoreJson(plan)).not.toContain('postgresql://');
  });
  it.each([
    { serviceRole: 'pg_reserved' },
    { serviceRole: 'UPPERCASE' },
    { journalRole: 'authrim_service' },
    { databaseUrlEnv: 'AUTHORITY_DB' },
    { databaseUrlEnv: 'inline-password' },
    { password: 'forbidden' },
  ])('rejects malformed or privilege-ambiguous bootstrap configuration', async (change) => {
    const { config } = await fixture();
    config.authority.bootstrap = {
      databaseUrlEnv: 'AUTHORITY_BOOTSTRAP_DB',
      serviceRole: 'authrim_service',
      journalRole: 'authrim_journal',
      ...change,
    };
    expect(() => parseReplicationConfiguration(config)).toThrow('replication_plan_invalid');
  });
  it('reads an owner credential only for explicit initialize and requires the same TLS database', async () => {
    const { config } = await fixture();
    config.authority.bootstrap = {
      databaseUrlEnv: 'AUTHORITY_BOOTSTRAP_DB',
      serviceRole: 'authrim_service',
      journalRole: 'authrim_journal',
    };
    const journal =
      'postgresql://authrim_journal:synthetic@db.example.test:5432/authority?sslmode=verify-full';
    const owner =
      'postgresql://bootstrap_owner:synthetic@db.example.test:5432/authority?sslmode=verify-full';
    const read = vi.fn((name: string) => (name === 'AUTHORITY_DB' ? journal : owner));
    for (const mode of ['sync', 'switch', 'failover']) {
      expect(replicationAuthorityDatabaseUrl(config.authority, mode, read)).toBe(journal);
      expect(read).toHaveBeenCalledExactlyOnceWith('AUTHORITY_DB');
      read.mockClear();
    }
    expect(replicationAuthorityDatabaseUrl(config.authority, 'initialize', read)).toBe(owner);
    expect(read.mock.calls).toEqual([['AUTHORITY_DB'], ['AUTHORITY_BOOTSTRAP_DB']]);
    for (const wrong of [
      owner.replace('db.example.test', 'other.example.test'),
      owner.replace('/authority', '/other'),
      owner.replace('5432', '5433'),
      owner.replace('bootstrap_owner', 'authrim_service'),
    ])
      expect(() =>
        replicationAuthorityDatabaseUrl(config.authority, 'initialize', (name) =>
          name === 'AUTHORITY_DB' ? journal : wrong
        )
      ).toThrow();
    expect(() => replicationAuthorityDatabaseUrl(config.authority, 'sync', () => owner)).toThrow();
  });
  it('preserves independent PostgreSQL and DynamoDB auth-state choices, never enables DSQL serving', async () => {
    const { config } = await fixture();
    config.destination.authState = {
      backend: 'dynamodb',
      region: 'ap-northeast-1',
      tableArn: 'arn:aws:dynamodb:ap-northeast-1:123456789012:table/replication-state',
    };
    expect(parseReplicationConfiguration(config).destination.authState).toEqual(
      config.destination.authState
    );
  });
  it.each(['keyPrefix', 'secretNamePrefix'] as const)(
    'requires a canonical scoped %s accepted by the serving template',
    async (field) => {
      const { config } = await fixture();
      for (const value of [
        '/generations',
        'generations/',
        'a//b',
        '../a',
        'a/*',
        'a'.repeat(129),
      ]) {
        config.destination.artifacts[field] = value;
        expect(() => parseReplicationConfiguration(config)).toThrow('replication_plan_invalid');
      }
      for (const value of ['a', 'authrim/generations-v1', 'a'.repeat(128)]) {
        config.destination.artifacts[field] = value;
        expect(parseReplicationConfiguration(config).destination.artifacts[field]).toBe(value);
      }
    }
  );
  it('rejects changed executable, changed SQL and symlinked SQL', async () => {
    const { config, schemaPath, directory } = await fixture();
    const plan = await createReplicationPlan(config, executor);
    expect(() => parseReplicationPlan(canonicalRestoreJson(plan), 'b'.repeat(64))).toThrow();
    await writeFile(schemaPath, 'DROP TABLE private_data;');
    await expect(createReplicationPlan(config, executor)).rejects.toThrow();
    const alias = join(directory, 'alias.sql');
    await symlink(schemaPath, alias);
    config.destination.schemas.core[0] = { path: alias, sha256: 'c'.repeat(64) };
    await expect(createReplicationPlan(config, executor)).rejects.toThrow();
  });
  it('the real CLI creates private plans, refuses overwrite and refuses a stale executable before credentials', async () => {
    const { config, directory } = await fixture();
    const configPath = join(directory, 'config.json');
    const out = join(directory, 'plan.json');
    await writeFile(configPath, JSON.stringify(config));
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await runReplicationCli(['plan', '--config', configPath, '--out', out], {});
    expect(process.exitCode).not.toBe(1);
    expect((await stat(out)).mode & 0o077).toBe(0);
    const raw = await readFile(out, 'utf8');
    expect(stdout).toHaveBeenCalled();
    await runReplicationCli(['plan', '--config', configPath, '--out', out], {});
    expect(process.exitCode).toBe(1);
    expect(await readFile(out, 'utf8')).toBe(raw);
    process.exitCode = 0;
    const stale = parseReplicationPlan(raw);
    stale.executorSha256 = executor;
    await writeFile(out, canonicalRestoreJson(stale));
    await runReplicationCli(
      [
        'sync',
        '--plan',
        out,
        '--plan-sha256',
        replicationPlanDigest(stale),
        '--state',
        join(directory, 'state.json'),
      ],
      {}
    );
    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalled();
    await expect(stat(join(directory, 'state.json'))).rejects.toThrow();
  });
});
