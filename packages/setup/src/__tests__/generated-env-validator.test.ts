import { mkdtemp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import { saveKeysToDirectory, type GeneratedSecrets, type KeyPair } from '../core/keys.js';
import { createLockFile } from '../core/lock.js';
import { getEnvironmentPaths } from '../core/paths.js';
import { WORKER_COMPONENTS } from '../core/naming.js';
import { buildResourceIdsFromLock, generateWranglerConfig, toToml } from '../core/wrangler.js';
import { validateGeneratedEnvironment } from '../core/generated-env-validator.js';

const listD1DatabasesMock = vi.hoisted(() => vi.fn());
const listR2BucketsMock = vi.hoisted(() => vi.fn());
const queryD1RowsMock = vi.hoisted(() => vi.fn());

vi.mock('../core/cloudflare.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/cloudflare.js')>();
  return {
    ...actual,
    listD1Databases: listD1DatabasesMock,
    listR2Buckets: listR2BucketsMock,
    queryD1Rows: queryD1RowsMock,
  };
});

const tempDirs: string[] = [];

async function createFixtureRoot() {
  const root = await mkdtemp(join(process.cwd(), '.test-generated-env-'));
  tempDirs.push(root);
  return root;
}

function createFixtureKeyPair(keyId: string, alg: string = 'RS256'): KeyPair {
  return {
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${keyId}\n-----END PRIVATE KEY-----\n`,
    publicKeyJwk: {
      kty: alg === 'ES256' ? 'EC' : 'RSA',
      kid: keyId,
      use: 'sig',
      alg,
    },
    keyId,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function createFixtureSecrets(keyId: string): GeneratedSecrets {
  return {
    keyPair: createFixtureKeyPair(keyId),
    setupMachineKeyPair: createFixtureKeyPair(`${keyId}-setup`, 'ES256'),
    adminUiBffMachineKeyPair: createFixtureKeyPair(`${keyId}-admin-ui-bff`, 'ES256'),
    tenantRuntimeRegistryKeyPair: {
      privateJwk: {
        kty: 'OKP',
        crv: 'Ed25519',
        kid: `${keyId}-tenant-runtime-registry`,
        d: 'fixture-private',
        x: 'fixture-public',
        use: 'sig',
        alg: 'EdDSA',
      },
      publicJwk: {
        kty: 'OKP',
        crv: 'Ed25519',
        kid: `${keyId}-tenant-runtime-registry`,
        x: 'fixture-public',
        use: 'sig',
        alg: 'EdDSA',
      },
      keyId: `${keyId}-tenant-runtime-registry`,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    rpTokenEncryptionKey: 'a'.repeat(64),
    objectEncryptionRootKey: 'b'.repeat(64),
    versionManagerSecret: 'fixture_version_manager_secret_123',
    loggingCursorHmacSecret: 'fixture_logging_cursor_secret_123',
    adminApiSecret: 'fixture_admin_api_secret_123456',
    keyManagerSecret: 'fixture_key_manager_secret_1234',
    setupToken: 'fixture_setup_token_1234567890',
  };
}

async function writeGeneratedEnvironment(
  root: string,
  options?: {
    externalStorageDefault?: boolean;
    tenantD1StorageDefault?: boolean;
    withTenantD1Slots?: boolean;
    withHyperdriveReferences?: boolean;
    queueEnabled?: boolean;
    withLoggingQueues?: boolean;
    externalKeys?: boolean;
  }
) {
  const env = 'portable';
  const config = createDefaultConfig(env);
  config.keys.storageType = options?.externalKeys ? 'external' : 'internal';
  config.keys.secretsPath = './keys/';
  config.features.queue = { enabled: options?.queueEnabled === true };
  config.urls = {
    api: { custom: null, auto: 'https://portable-ar-router.workers.dev' },
    loginUi: { custom: null, auto: 'https://portable-ar-login-ui.workers.dev', sameAsApi: false },
    adminUi: { custom: null, auto: 'https://portable-ar-admin-ui.workers.dev', sameAsApi: false },
  };
  if (options?.externalStorageDefault) {
    config.profiles.defaults.storage = 'builtin:storage:external-postgres';
  }
  if (options?.tenantD1StorageDefault) {
    config.profiles.defaults.storage = 'builtin:storage:tenant-d1';
  }
  if (options?.withHyperdriveReferences) {
    config.profiles.references.hyperdrive = {
      'core-primary': {
        binding: 'HYPERDRIVE_CORE_PRIMARY',
        id: 'hyperdrive-core-id',
        driver: 'postgres',
      },
      'pii-primary': {
        binding: 'HYPERDRIVE_PII_PRIMARY',
        id: 'hyperdrive-pii-id',
        driver: 'postgres',
      },
    };
  }

  const envPaths = getEnvironmentPaths({ baseDir: root, env });
  await mkdir(envPaths.root, { recursive: true });
  await mkdir(envPaths.wrangler, { recursive: true });

  const d1 = [
    { binding: 'DB', name: `${env}-authrim-core-db`, id: 'db-core-id' },
    { binding: 'DB_PII', name: `${env}-authrim-pii-db`, id: 'db-pii-id' },
    { binding: 'DB_ADMIN', name: `${env}-authrim-admin-db`, id: 'db-admin-id' },
  ];

  if (options?.withTenantD1Slots) {
    for (let slotNumber = 1; slotNumber <= 3; slotNumber += 1) {
      const slot = String(slotNumber).padStart(4, '0');
      d1.push(
        {
          binding: `TDB_SLOT_${slot}_CORE`,
          name: `authrim-${env}-tdb-slot-${slot}-core`,
          id: `slot-${slot}-core-id`,
        },
        {
          binding: `TDB_SLOT_${slot}_PII`,
          name: `authrim-${env}-tdb-slot-${slot}-pii`,
          id: `slot-${slot}-pii-id`,
        }
      );
    }
  }

  const queues = options?.withLoggingQueues
    ? [
        { binding: 'AUDIT_QUEUE', name: `${env}-audit-queue`, id: 'queue-audit' },
        {
          binding: 'LOGGING_DELIVERY_CRITICAL_QUEUE',
          name: `${env}-logging-delivery-critical-queue`,
          id: 'queue-logging-critical',
        },
        {
          binding: 'LOGGING_DELIVERY_QUEUE',
          name: `${env}-logging-delivery-queue`,
          id: 'queue-logging-default',
        },
        {
          binding: 'LOGGING_DELIVERY_BULK_QUEUE',
          name: `${env}-logging-delivery-bulk-queue`,
          id: 'queue-logging-bulk',
        },
      ]
    : [];

  const lock = createLockFile(env, {
    d1,
    kv: [
      { binding: 'CLIENTS_CACHE', name: `${env.toUpperCase()}-CLIENTS_CACHE`, id: 'kv-clients' },
      {
        binding: 'INITIAL_ACCESS_TOKENS',
        name: `${env.toUpperCase()}-INITIAL_ACCESS_TOKENS`,
        id: 'kv-iat',
      },
      { binding: 'SETTINGS', name: `${env.toUpperCase()}-SETTINGS`, id: 'kv-settings' },
      { binding: 'REBAC_CACHE', name: `${env.toUpperCase()}-REBAC_CACHE`, id: 'kv-rebac' },
      { binding: 'USER_CACHE', name: `${env.toUpperCase()}-USER_CACHE`, id: 'kv-user' },
      { binding: 'AUTHRIM_CONFIG', name: `${env.toUpperCase()}-AUTHRIM_CONFIG`, id: 'kv-config' },
      {
        binding: 'TENANT_RUNTIME_REGISTRY',
        name: `${env.toUpperCase()}-TENANT_RUNTIME_REGISTRY`,
        id: 'kv-tenant-runtime-registry',
      },
      { binding: 'STATE_STORE', name: `${env.toUpperCase()}-STATE_STORE`, id: 'kv-state' },
      { binding: 'CONSENT_CACHE', name: `${env.toUpperCase()}-CONSENT_CACHE`, id: 'kv-consent' },
    ],
    queues,
    r2: [
      { binding: 'AVATARS', name: `${env}-authrim-avatars` },
      { binding: 'DIAGNOSTIC_LOGS', name: `${env}-diagnostic-logs` },
      { binding: 'AUDIT_ARCHIVE', name: `${env}-audit-archive` },
      { binding: 'IMPORT_ARTIFACTS', name: `${env}-import-artifacts` },
      { binding: 'EXPORT_ARTIFACTS', name: `${env}-export-artifacts` },
      { binding: 'SENSITIVE_DETAILS', name: `${env}-sensitive-details` },
    ],
  });

  await saveKeysToDirectory(createFixtureSecrets(`${env}-test-key`), {
    baseDir: root,
    env,
    keysBaseDir: options?.externalKeys ? root : undefined,
  });
  await writeFile(envPaths.config, JSON.stringify(config, null, 2), 'utf-8');
  await writeFile(envPaths.lock, JSON.stringify(lock, null, 2), 'utf-8');

  const resourceIds = buildResourceIdsFromLock(lock);
  for (const component of WORKER_COMPONENTS) {
    const packageDir = join(root, 'packages', component);
    await mkdir(packageDir, { recursive: true });
    const toml = toToml(generateWranglerConfig(component, config, resourceIds), env);
    await writeFile(join(packageDir, 'wrangler.toml'), toml, 'utf-8');
  }

  for (const component of WORKER_COMPONENTS) {
    const toml = toToml(generateWranglerConfig(component, config, resourceIds), env);
    await writeFile(join(envPaths.wrangler, `${component}.toml`), toml, 'utf-8');
  }

  return { root, env };
}

function mockLiveRuntimeSchema(
  env: string,
  options?: { missingPiiTables?: string[]; legacyUserCustomFieldsFk?: boolean }
) {
  const schemaTablesByDatabase = new Map<string, string[]>([
    [
      `${env}-authrim-core-db`,
      [
        'users_core',
        'identity_subjects',
        'identity_accounts',
        'profiles',
        'contact_points',
        'custom_claim_schemas',
        'user_custom_fields',
      ],
    ],
    [
      `${env}-authrim-pii-db`,
      ['identity_sensitive_values', 'users_pii', 'users_pii_tombstone'].filter(
        (table) => !(options?.missingPiiTables ?? []).includes(table)
      ),
    ],
    [`${env}-authrim-admin-db`, ['admin_users', 'admin_machine_principals', 'mapping_policy_sets']],
  ]);

  queryD1RowsMock.mockImplementation((dbName: string, sql: string) => {
    if (sql.includes("sqlite_master WHERE type = 'table'")) {
      return Promise.resolve((schemaTablesByDatabase.get(dbName) ?? []).map((name) => ({ name })));
    }
    if (sql.includes('PRAGMA foreign_key_list(user_custom_fields)')) {
      return Promise.resolve(
        options?.legacyUserCustomFieldsFk
          ? [{ table: 'users_core', from: 'user_id', to: 'id' }]
          : []
      );
    }
    if (sql.includes('SELECT COUNT(*) AS count FROM tenant_database_slots')) {
      return Promise.resolve([{ count: 3 }]);
    }
    return Promise.resolve([]);
  });
}

describe('validateGeneratedEnvironment', () => {
  beforeEach(() => {
    listD1DatabasesMock.mockReset();
    listR2BucketsMock.mockReset();
    queryD1RowsMock.mockReset();
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map(async (dir) => {
        await import('node:fs/promises').then(({ rm }) =>
          rm(dir, { recursive: true, force: true })
        );
      })
    );
  });

  it('passes a standard D1-backed generated environment', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot());

    const result = await validateGeneratedEnvironment({ baseDir: root, env });

    expect(result.ok).toBe(true);
    expect(result.checks.every((check) => check.status !== 'fail')).toBe(true);
  });

  it('passes a queue-enabled environment with logging delivery queues', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot(), {
      queueEnabled: true,
      withLoggingQueues: true,
    });

    const result = await validateGeneratedEnvironment({ baseDir: root, env });
    const queueCheck = result.checks.find((check) => check.id === 'logging-queue-bindings');

    expect(result.ok).toBe(true);
    expect(queueCheck?.status).toBe('pass');
    expect(queueCheck?.details).toEqual(
      expect.arrayContaining([
        expect.stringContaining('LOGGING_DELIVERY_CRITICAL_QUEUE'),
        expect.stringContaining('LOGGING_DELIVERY_QUEUE'),
        expect.stringContaining('LOGGING_DELIVERY_BULK_QUEUE'),
      ])
    );
  });

  it('fails a queue-enabled environment missing logging delivery queues', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot(), {
      queueEnabled: true,
    });

    const result = await validateGeneratedEnvironment({ baseDir: root, env });
    const queueCheck = result.checks.find((check) => check.id === 'logging-queue-bindings');

    expect(result.ok).toBe(false);
    expect(queueCheck?.status).toBe('fail');
    expect(queueCheck?.details).toEqual(
      expect.arrayContaining([expect.stringContaining('LOGGING_DELIVERY_QUEUE is missing')])
    );
  });

  it('fails when generated logging cursor key material is missing', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot());
    await unlink(join(root, '.authrim', env, 'keys', 'logging_cursor_hmac_secret.txt'));

    const result = await validateGeneratedEnvironment({ baseDir: root, env });
    const secretCheck = result.checks.find((check) => check.id === 'logging-secret-material');

    expect(result.ok).toBe(false);
    expect(secretCheck?.status).toBe('fail');
    expect(secretCheck?.details).toEqual(
      expect.arrayContaining([expect.stringContaining('LOGGING_CURSOR_HMAC_SECRET')])
    );
  });

  it('uses the external keys directory for external key storage', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot(), {
      externalKeys: true,
    });

    const result = await validateGeneratedEnvironment({ baseDir: root, env, keysBaseDir: root });
    const secretCheck = result.checks.find((check) => check.id === 'logging-secret-material');

    expect(result.ok).toBe(true);
    expect(secretCheck?.status).toBe('pass');
    expect(secretCheck?.details).toEqual(
      expect.arrayContaining([expect.stringContaining('LOGGING_CURSOR_HMAC_SECRET')])
    );
  });

  it('fails when generated logging R2 buckets are missing from lock.json', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot());
    const lockPath = join(root, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    delete lock.r2.DIAGNOSTIC_LOGS;
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf-8');

    const result = await validateGeneratedEnvironment({ baseDir: root, env });
    const r2Check = result.checks.find((check) => check.id === 'logging-r2-bindings');

    expect(result.ok).toBe(false);
    expect(r2Check?.status).toBe('fail');
    expect(r2Check?.details).toEqual(
      expect.arrayContaining([expect.stringContaining('DIAGNOSTIC_LOGS is missing')])
    );
  });

  it('fails when the active storage default requires unsupported external primary bindings', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot(), {
      externalStorageDefault: true,
    });

    const result = await validateGeneratedEnvironment({ baseDir: root, env });

    expect(result.ok).toBe(false);
    expect(
      result.checks.find((check) => check.id === 'active-profile-compatibility')?.details
    ).toEqual(
      expect.arrayContaining([expect.stringContaining('builtin:storage:external-postgres')])
    );
  });

  it('passes tenant-d1 generated environment with runtime registry KV bindings', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot(), {
      tenantD1StorageDefault: true,
    });

    const result = await validateGeneratedEnvironment({ baseDir: root, env });

    expect(result.ok).toBe(true);
    expect(result.checks.every((check) => check.status !== 'fail')).toBe(true);
  });

  it('passes when the active external storage default is backed by configured Hyperdrive references', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot(), {
      externalStorageDefault: true,
      withHyperdriveReferences: true,
    });

    const result = await validateGeneratedEnvironment({ baseDir: root, env });

    expect(result.ok).toBe(true);
    expect(result.checks.every((check) => check.status !== 'fail')).toBe(true);
  });

  it('passes live Cloudflare validation when lock D1 and R2 resources exist', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot());
    mockLiveRuntimeSchema(env);
    listD1DatabasesMock.mockResolvedValueOnce([
      { name: `${env}-authrim-core-db`, uuid: 'db-core-id' },
      { name: `${env}-authrim-pii-db`, uuid: 'db-pii-id' },
      { name: `${env}-authrim-admin-db`, uuid: 'db-admin-id' },
    ]);
    listR2BucketsMock.mockResolvedValueOnce([
      { name: `${env}-authrim-avatars` },
      { name: `${env}-diagnostic-logs` },
      { name: `${env}-audit-archive` },
      { name: `${env}-import-artifacts` },
      { name: `${env}-export-artifacts` },
      { name: `${env}-sensitive-details` },
    ]);

    const result = await validateGeneratedEnvironment({ baseDir: root, env, liveCloudflare: true });

    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.id === 'live-cloudflare-d1')?.status).toBe('pass');
    expect(result.checks.find((check) => check.id === 'live-cloudflare-r2')?.status).toBe('pass');
    expect(result.checks.find((check) => check.id === 'live-runtime-d1-schema')?.status).toBe(
      'pass'
    );
  });

  it('fails live Cloudflare validation when a recorded R2 bucket is missing', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot());
    mockLiveRuntimeSchema(env);
    listD1DatabasesMock.mockResolvedValueOnce([
      { name: `${env}-authrim-core-db`, uuid: 'db-core-id' },
      { name: `${env}-authrim-pii-db`, uuid: 'db-pii-id' },
      { name: `${env}-authrim-admin-db`, uuid: 'db-admin-id' },
    ]);
    listR2BucketsMock.mockResolvedValueOnce([{ name: `${env}-import-artifacts` }]);

    const result = await validateGeneratedEnvironment({ baseDir: root, env, liveCloudflare: true });
    const r2Check = result.checks.find((check) => check.id === 'live-cloudflare-r2');

    expect(result.ok).toBe(false);
    expect(r2Check?.status).toBe('fail');
    expect(r2Check?.details).toEqual(
      expect.arrayContaining([expect.stringContaining(`${env}-export-artifacts is missing`)])
    );
  });

  it('fails live Cloudflare validation when runtime schema tables are missing', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot());
    mockLiveRuntimeSchema(env, { missingPiiTables: ['identity_sensitive_values'] });
    listD1DatabasesMock.mockResolvedValueOnce([
      { name: `${env}-authrim-core-db`, uuid: 'db-core-id' },
      { name: `${env}-authrim-pii-db`, uuid: 'db-pii-id' },
      { name: `${env}-authrim-admin-db`, uuid: 'db-admin-id' },
    ]);
    listR2BucketsMock.mockResolvedValueOnce([
      { name: `${env}-authrim-avatars` },
      { name: `${env}-diagnostic-logs` },
      { name: `${env}-audit-archive` },
      { name: `${env}-import-artifacts` },
      { name: `${env}-export-artifacts` },
      { name: `${env}-sensitive-details` },
    ]);

    const result = await validateGeneratedEnvironment({ baseDir: root, env, liveCloudflare: true });
    const schemaCheck = result.checks.find((check) => check.id === 'live-runtime-d1-schema');

    expect(result.ok).toBe(false);
    expect(schemaCheck?.status).toBe('fail');
    expect(schemaCheck?.details).toEqual(
      expect.arrayContaining([expect.stringContaining('missing PII runtime schema table(s)')])
    );
  });

  it('fails live Cloudflare validation when custom fields still reference users_core', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot());
    mockLiveRuntimeSchema(env, { legacyUserCustomFieldsFk: true });
    listD1DatabasesMock.mockResolvedValueOnce([
      { name: `${env}-authrim-core-db`, uuid: 'db-core-id' },
      { name: `${env}-authrim-pii-db`, uuid: 'db-pii-id' },
      { name: `${env}-authrim-admin-db`, uuid: 'db-admin-id' },
    ]);
    listR2BucketsMock.mockResolvedValueOnce([
      { name: `${env}-authrim-avatars` },
      { name: `${env}-diagnostic-logs` },
      { name: `${env}-audit-archive` },
      { name: `${env}-import-artifacts` },
      { name: `${env}-export-artifacts` },
      { name: `${env}-sensitive-details` },
    ]);

    const result = await validateGeneratedEnvironment({ baseDir: root, env, liveCloudflare: true });
    const schemaCheck = result.checks.find((check) => check.id === 'live-runtime-d1-schema');

    expect(result.ok).toBe(false);
    expect(schemaCheck?.status).toBe('fail');
    expect(schemaCheck?.details).toEqual(
      expect.arrayContaining([expect.stringContaining('references legacy users_core(id)')])
    );
  });

  it('checks live tenant D1 slot count against DB_ADMIN for tenant-d1 environments', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot(), {
      tenantD1StorageDefault: true,
      withTenantD1Slots: true,
    });
    mockLiveRuntimeSchema(env);
    listD1DatabasesMock.mockResolvedValueOnce([
      { name: `${env}-authrim-core-db`, uuid: 'db-core-id' },
      { name: `${env}-authrim-pii-db`, uuid: 'db-pii-id' },
      { name: `${env}-authrim-admin-db`, uuid: 'db-admin-id' },
      { name: `authrim-${env}-tdb-slot-0001-core`, uuid: 'slot-0001-core-id' },
      { name: `authrim-${env}-tdb-slot-0001-pii`, uuid: 'slot-0001-pii-id' },
      { name: `authrim-${env}-tdb-slot-0002-core`, uuid: 'slot-0002-core-id' },
      { name: `authrim-${env}-tdb-slot-0002-pii`, uuid: 'slot-0002-pii-id' },
      { name: `authrim-${env}-tdb-slot-0003-core`, uuid: 'slot-0003-core-id' },
      { name: `authrim-${env}-tdb-slot-0003-pii`, uuid: 'slot-0003-pii-id' },
    ]);
    listR2BucketsMock.mockResolvedValueOnce([
      { name: `${env}-authrim-avatars` },
      { name: `${env}-diagnostic-logs` },
      { name: `${env}-audit-archive` },
      { name: `${env}-import-artifacts` },
      { name: `${env}-export-artifacts` },
      { name: `${env}-sensitive-details` },
    ]);

    const result = await validateGeneratedEnvironment({ baseDir: root, env, liveCloudflare: true });
    const slotCheck = result.checks.find((check) => check.id === 'live-tenant-d1-slots');

    expect(result.ok).toBe(true);
    expect(slotCheck?.status).toBe('pass');
    expect(slotCheck?.details).toEqual(
      expect.arrayContaining([expect.stringContaining('tenant_database_slots count: 3/3')])
    );
    expect(queryD1RowsMock).toHaveBeenLastCalledWith(
      `${env}-authrim-admin-db`,
      'SELECT COUNT(*) AS count FROM tenant_database_slots;'
    );
  });
});
