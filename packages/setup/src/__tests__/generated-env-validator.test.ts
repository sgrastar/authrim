import { mkdtemp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import { saveKeysToDirectory, type GeneratedSecrets, type KeyPair } from '../core/keys.js';
import { createLockFile } from '../core/lock.js';
import { getEnvironmentPaths } from '../core/paths.js';
import { KV_NAMESPACES, WORKER_COMPONENTS, getKVNamespaceName } from '../core/naming.js';
import { buildResourceIdsFromLock, generateWranglerConfig, toToml } from '../core/wrangler.js';
import {
  resolveGeneratedEnvValidationTarget,
  validateGeneratedEnvironment,
} from '../core/generated-env-validator.js';

const listD1DatabasesMock = vi.hoisted(() => vi.fn());
const listKVNamespacesMock = vi.hoisted(() => vi.fn());
const listR2BucketsMock = vi.hoisted(() => vi.fn());
const queryD1RowsMock = vi.hoisted(() => vi.fn());

vi.mock('../core/cloudflare.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/cloudflare.js')>();
  return {
    ...actual,
    listD1Databases: listD1DatabasesMock,
    listKVNamespaces: listKVNamespacesMock,
    listR2Buckets: listR2BucketsMock,
    queryD1Rows: queryD1RowsMock,
  };
});

const tempDirs: string[] = [];
const PORTABLE_KV_IDS: Record<(typeof KV_NAMESPACES)[number], string> = {
  CLIENTS_CACHE: 'kv-clients',
  INITIAL_ACCESS_TOKENS: 'kv-iat',
  SETTINGS: 'kv-settings',
  REBAC_CACHE: 'kv-rebac',
  USER_CACHE: 'kv-user',
  AUTHRIM_CONFIG: 'kv-config',
  TENANT_RUNTIME_REGISTRY: 'kv-tenant-runtime-registry',
  STATE_STORE: 'kv-state',
  CONSENT_CACHE: 'kv-consent',
};

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
    controlSmokeKeyPair: {
      privateJwk: {
        kty: 'OKP',
        crv: 'Ed25519',
        kid: `${keyId}-control-smoke`,
        d: 'fixture-private',
        x: 'fixture-public',
        use: 'sig',
        alg: 'EdDSA',
      },
      publicJwk: {
        kty: 'OKP',
        crv: 'Ed25519',
        kid: `${keyId}-control-smoke`,
        x: 'fixture-public',
        use: 'sig',
        alg: 'EdDSA',
      },
      keyId: `${keyId}-control-smoke`,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    notificationPayloadKeyPair: {
      privateJwk: {
        kty: 'RSA',
        kid: `${keyId}-notification-payload`,
        n: 'fixture-modulus',
        e: 'AQAB',
        d: 'fixture-private',
        use: 'enc',
        alg: 'RSA-OAEP-256',
        key_ops: ['decrypt'],
      },
      publicJwk: {
        kty: 'RSA',
        kid: `${keyId}-notification-payload`,
        n: 'fixture-modulus',
        e: 'AQAB',
        use: 'enc',
        alg: 'RSA-OAEP-256',
        key_ops: ['encrypt'],
      },
      keyId: `${keyId}-notification-payload`,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    rpTokenEncryptionKey: 'a'.repeat(64),
    piiEncryptionKey: 'd'.repeat(64),
    objectEncryptionRootKey: 'b'.repeat(64),
    otpHmacSecret: 'fixture_otp_hmac_secret_1234567890',
    loggingCursorHmacSecret: 'fixture_logging_cursor_secret_123',
    lookupHmacKeySlotA: 'fixture_lookup_hmac_key_slot_a_1234567890',
    flowRuntimeHmacSecret: 'fixture_flow_runtime_secret_123',
    vcTransactionCodeHmacSecret: 't'.repeat(43),
    vcEvidenceHmacSecret: 'e'.repeat(43),
    vcProfileContractHmacSecret: 'p'.repeat(43),
    pluginEncryptionKey: 'c'.repeat(64),
    pluginMutationHmacKey: 'm'.repeat(43),
    notificationIntentHmacKey: 'n'.repeat(43),
    agentElevationEncryptionKey: 'd'.repeat(64),
    setupToken: 'fixture_setup_token_1234567890',
  };
}

async function writeGeneratedEnvironment(
  root: string,
  options?: {
    externalStorageDefault?: boolean;
    tenantD1StorageDefault?: boolean;
    withTenantD1Bootstrap?: boolean;
    withHyperdriveReferences?: boolean;
    queueEnabled?: boolean;
    withLoggingQueues?: boolean;
    externalKeys?: boolean;
  }
) {
  const env = 'portable';
  const config = createDefaultConfig(env);
  config.profiles.defaults.storage = 'builtin:storage:shared-d1';
  config.cloudflare.accountId = 'account-id';
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
    { binding: 'CONTROL_DB', name: `${env}-authrim-control-db`, id: 'db-control-id' },
    { binding: 'LOOKUP_DB', name: `${env}-authrim-lookup-db`, id: 'db-lookup-id' },
    {
      binding: 'PLUGIN_RUNNER_DB',
      name: `${env}-authrim-plugin-runner-db`,
      id: 'db-plugin-runner-id',
    },
  ];

  if (options?.withTenantD1Bootstrap) {
    d1.push(
      {
        binding: 'TDB_DEFAULT_BOOTSTRAP_CORE',
        name: `authrim-${env}-default-bootstrap`,
        id: 'bootstrap-default-core-id',
      },
      {
        binding: 'TDB_USERS_BOOTSTRAP_CORE',
        name: `authrim-${env}-users-bootstrap`,
        id: 'bootstrap-users-core-id',
      },
      {
        binding: 'TDB_PII_BOOTSTRAP_PII',
        name: `authrim-${env}-pii-bootstrap`,
        id: 'bootstrap-pii-id',
      }
    );
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
      { binding: 'MIGRATION_RELEASES', name: `${env}-migration-releases` },
      { binding: 'PUBLIC_ASSETS', name: `${env}-public-assets` },
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
  options?: {
    missingCoreTables?: string[];
    missingPiiTables?: string[];
    legacyUserCustomFieldsFk?: boolean;
  }
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
        'event_log',
      ].filter((table) => !(options?.missingCoreTables ?? []).includes(table)),
    ],
    [
      `${env}-authrim-pii-db`,
      ['identity_sensitive_values', 'users_pii', 'users_pii_tombstone'].filter(
        (table) => !(options?.missingPiiTables ?? []).includes(table)
      ),
    ],
    [`${env}-authrim-admin-db`, ['admin_users', 'admin_machine_principals', 'field_mapping_sets']],
    [
      `${env}-authrim-control-db`,
      [
        'control_environments',
        'control_operations',
        'control_operation_steps',
        'control_desired_resources',
        'control_observed_resources',
        'control_migration_release_catalog',
        'control_operation_release_pins',
        'control_tenant_database_migration_state',
        'control_worker_deployment_leases',
        'control_worker_binding_reconciliations',
        'control_bootstrap_handoffs',
        'control_bootstrap_worker_evidence',
        'control_directory_rewrite_leases',
        'control_environment_resource_policies',
        'control_d1_create_budget_reservations',
        'control_residency_partitions',
        'control_tenant_shards',
        'control_shard_capacity',
        'control_tenant_shard_allocations',
        'control_read_replication_policies',
        'control_read_replication_rollouts',
        'control_lookup_physical_shards',
        'control_lookup_bucket_assignments',
        'control_lookup_registry_publications',
        'control_lookup_bucket_migrations',
        'control_hmac_rotation_operations',
        'control_lookup_hmac_key_states',
        'control_lookup_hmac_key_state_publications',
        'control_lookup_hmac_rotation_sources',
        'control_lookup_hmac_rotation_verification_shards',
        'control_lookup_hmac_candidate_verifications',
        'control_route_projection_migrations',
        'control_signing_key_metadata',
        'control_signing_key_verifications',
        'control_runtime_registry_publications',
        'control_runtime_registry_routes',
        'control_desired_worker_inventory',
        'control_worker_inventory_change_events',
        'control_worker_required_data_roles',
        'control_worker_desired_bindings',
        'control_worker_observed_bindings',
        'control_worker_inventory_drift_findings',
        'control_external_capability_sources',
        'control_external_capability_bindings',
        'control_plugin_desired_resources',
        'control_plugin_dynamic_worker_bindings',
        'control_plugin_runner_registry_publications',
        'control_read_replication_rollout_targets',
        'control_tenant_default_allocations',
        'control_audit_events',
      ],
    ],
    [
      `${env}-authrim-lookup-db`,
      [
        'lookup_schema_metadata',
        'lookup_identifiers',
        'lookup_tenant_aliases',
        'lookup_identifier_reservations',
        'lookup_bucket_counters',
        'lookup_discovery_otp_challenges',
        'lookup_identifier_replacements',
        'lookup_directory_job_cursors',
        'lookup_migration_state',
      ],
    ],
    [
      `${env}-authrim-plugin-runner-db`,
      [
        'plugin_runner_shard_cursors',
        'plugin_runner_full_sweep_state',
        'plugin_runner_hook_policies',
        'plugin_runner_egress_allowed_hosts',
        'plugin_runner_circuit_breakers',
        'plugin_runner_migration_state',
      ],
    ],
  ]);

  queryD1RowsMock.mockImplementation((dbName: string, sql: string) => {
    if (sql.includes("name = 'control_plugin_desired_resources'")) {
      return Promise.resolve(
        schemaTablesByDatabase.get(dbName)?.includes('control_plugin_desired_resources')
          ? [{ name: 'control_plugin_desired_resources' }]
          : []
      );
    }
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
    if (sql.includes('SELECT state FROM control_bootstrap_handoffs')) {
      return Promise.resolve([{ state: 'accepted' }]);
    }
    return Promise.resolve([]);
  });
}

describe('validateGeneratedEnvironment', () => {
  beforeEach(() => {
    listD1DatabasesMock.mockReset();
    listKVNamespacesMock.mockReset();
    listKVNamespacesMock.mockResolvedValue(
      KV_NAMESPACES.map((binding) => ({
        title: getKVNamespaceName('portable', binding),
        id: PORTABLE_KV_IDS[binding],
      }))
    );
    listR2BucketsMock.mockReset();
    queryD1RowsMock.mockReset();
    queryD1RowsMock.mockResolvedValue([]);
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

    expect(result.checks.filter((check) => check.status === 'fail')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checks.every((check) => check.status !== 'fail')).toBe(true);
    expect(queryD1RowsMock).not.toHaveBeenCalled();
  });

  it('resolves validation targets from an environment or generated config path', async () => {
    const root = await createFixtureRoot();
    const generated = resolveGeneratedEnvValidationTarget({ baseDir: root, env: 'portable' });

    expect(generated).toEqual({
      baseDir: root,
      env: 'portable',
      configPath: join(root, '.authrim', 'portable', 'config.json'),
    });
    expect(resolveGeneratedEnvValidationTarget({ configPath: generated.configPath })).toEqual(
      generated
    );
    expect(() => resolveGeneratedEnvValidationTarget({ baseDir: root })).toThrow(
      'env_or_config_path_is_required'
    );
  });

  it('returns focused failures when config or lock files are unavailable', async () => {
    const root = await createFixtureRoot();
    const missingConfig = await validateGeneratedEnvironment({ baseDir: root, env: 'portable' });

    expect(missingConfig.ok).toBe(false);
    expect(missingConfig.checks).toHaveLength(1);
    expect(missingConfig.checks[0]).toMatchObject({ id: 'config', status: 'fail' });

    const { env } = await writeGeneratedEnvironment(root);
    await unlink(join(root, '.authrim', env, 'lock.json'));
    const missingLock = await validateGeneratedEnvironment({ baseDir: root, env });

    expect(missingLock.ok).toBe(false);
    expect(missingLock.checks.map((check) => check.id)).toEqual(['config', 'lock']);
    expect(missingLock.checks[1].status).toBe('fail');
  });

  it('reports invalid secret formats and a missing keys directory', async () => {
    const first = await writeGeneratedEnvironment(await createFixtureRoot());
    await writeFile(
      join(first.root, '.authrim', first.env, 'keys', 'object_encryption_root_key.txt'),
      'not-a-hex-key',
      'utf-8'
    );
    const invalid = await validateGeneratedEnvironment({ baseDir: first.root, env: first.env });
    expect(invalid.checks.find((check) => check.id === 'logging-secret-material')).toMatchObject({
      status: 'fail',
      details: expect.arrayContaining([expect.stringContaining('invalid format')]),
    });

    const second = await writeGeneratedEnvironment(await createFixtureRoot());
    const { rm } = await import('node:fs/promises');
    await rm(join(second.root, '.authrim', second.env, 'keys'), { recursive: true });
    const missing = await validateGeneratedEnvironment({ baseDir: second.root, env: second.env });
    expect(missing.checks.find((check) => check.id === 'logging-secret-material')).toMatchObject({
      status: 'fail',
      details: [expect.stringContaining('keys directory is missing')],
    });
  });

  it('fails without disclosing values when a generated artifact contains secret material', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot());
    const secret = await readFile(
      join(root, '.authrim', env, 'keys', 'otp_hmac_secret.txt'),
      'utf8'
    );
    const lockPath = join(root, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    lock.leaked = secret;
    await writeFile(lockPath, JSON.stringify(lock, null, 2), 'utf8');

    const result = await validateGeneratedEnvironment({ baseDir: root, env });
    const check = result.checks.find((entry) => entry.id === 'generated-artifacts-secret-free');

    expect(result.ok).toBe(false);
    expect(check).toMatchObject({
      status: 'fail',
      details: expect.arrayContaining([expect.stringContaining('otp_hmac_secret.txt')]),
    });
    expect(JSON.stringify(check)).not.toContain(secret);
  });

  it('warns explicitly when R2 and queues are disabled without hiding valid output', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot());
    const configPath = join(root, '.authrim', env, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    config.features.r2 = { enabled: false };
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');

    const result = await validateGeneratedEnvironment({ baseDir: root, env });

    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.id === 'logging-r2-bindings')?.status).toBe('warn');
    expect(result.checks.find((check) => check.id === 'logging-queue-bindings')?.status).toBe(
      'warn'
    );
  });

  it('rejects unresolved default profiles and missing required D1/KV bindings', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot());
    const configPath = join(root, '.authrim', env, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    config.profiles.defaults.residency = 'tenant:unknown';
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
    const lockPath = join(root, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    delete lock.d1.DB_PII;
    delete lock.kv.AUTHRIM_CONFIG;
    await writeFile(lockPath, JSON.stringify(lock, null, 2), 'utf-8');

    const result = await validateGeneratedEnvironment({ baseDir: root, env });

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'default-profiles')?.details).toEqual(
      expect.arrayContaining([expect.stringContaining('neither built-in nor a seeded profile')])
    );
    expect(result.checks.find((check) => check.id === 'lock-d1-bindings')?.details).toEqual(
      expect.arrayContaining([expect.stringContaining('DB_PII is missing')])
    );
    expect(result.checks.find((check) => check.id === 'deploy-wranglers')?.details).toEqual(
      expect.arrayContaining([expect.stringContaining('AUTHRIM_CONFIG namespace is missing')])
    );
  });

  it('detects missing deploy and master Wrangler files', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot());
    await unlink(join(root, 'packages', 'ar-auth', 'wrangler.toml'));
    await unlink(join(root, '.authrim', env, 'wrangler', 'ar-token.toml'));

    const result = await validateGeneratedEnvironment({ baseDir: root, env });

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'deploy-wranglers')?.details).toEqual(
      expect.arrayContaining([
        expect.stringContaining('ar-auth: packages/ar-auth/wrangler.toml is missing'),
      ])
    );
    expect(result.checks.find((check) => check.id === 'master-wranglers')?.details).toEqual(
      expect.arrayContaining([expect.stringContaining('ar-token: master config is missing')])
    );
  });

  it('rejects active seeded storage and audit profiles with unresolved database targets', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot());
    const configPath = join(root, '.authrim', env, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    config.profiles.defaults.storage = 'tenant:storage:broken';
    config.profiles.defaults.audit = 'tenant:audit:broken';
    config.profiles.seed.storage = [
      {
        id: 'tenant:storage:broken',
        label: 'Broken storage',
        slices: {
          identity_core: { driver: 'd1', bindingRef: 'UNKNOWN_DB' },
          identity_pii: { driver: 'postgres', connectionRef: 'missing-primary' },
        },
      },
    ];
    config.profiles.seed.audit = [
      {
        id: 'tenant:audit:broken',
        label: 'Broken audit',
        primary: { type: 'mysql', connectionRef: 'missing-audit' },
        archive: { type: 'd1', bindingRef: 'UNKNOWN_DB' },
      },
    ];
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');

    const result = await validateGeneratedEnvironment({ baseDir: root, env });
    const compatibility = result.checks.find(
      (check) => check.id === 'active-profile-compatibility'
    );

    expect(result.ok).toBe(false);
    expect(compatibility?.details).toEqual(
      expect.arrayContaining([
        expect.stringContaining('UNKNOWN_DB is not a built-in D1 binding'),
        expect.stringContaining('requires a configured Hyperdrive reference'),
      ])
    );
  });

  it('accepts active seeded profiles backed by built-in D1 and configured Hyperdrive', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot(), {
      withHyperdriveReferences: true,
    });
    const configPath = join(root, '.authrim', env, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    config.profiles.defaults.storage = 'tenant:storage:hybrid';
    config.profiles.defaults.audit = 'tenant:audit:hybrid';
    config.profiles.seed.storage = [
      {
        id: 'tenant:storage:hybrid',
        label: 'Hybrid storage',
        slices: {
          identity_core: { driver: 'd1', bindingRef: 'DB' },
          identity_pii: { driver: 'postgres', connectionRef: 'pii-primary' },
        },
      },
    ];
    config.profiles.seed.audit = [
      {
        id: 'tenant:audit:hybrid',
        label: 'Hybrid audit',
        primary: { type: 'postgres', connectionRef: 'core-primary' },
        archive: { type: 'd1', bindingRef: 'DB_ADMIN' },
      },
    ];
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');

    const result = await validateGeneratedEnvironment({ baseDir: root, env });
    const compatibility = result.checks.find(
      (check) => check.id === 'active-profile-compatibility'
    );

    expect(compatibility?.status).toBe('pass');
    expect(compatibility?.details).toEqual(
      expect.arrayContaining([
        expect.stringContaining('HYPERDRIVE_PII_PRIMARY'),
        expect.stringContaining('HYPERDRIVE_CORE_PRIMARY'),
      ])
    );
  });

  it('warns about unresolved non-default seed backends without rejecting the active defaults', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot());
    const configPath = join(root, '.authrim', env, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    config.profiles.seed.storage = [
      {
        id: 'tenant:storage:future',
        label: 'Future storage',
        slices: {
          identity_core: { driver: 'postgres', connectionRef: 'future-core' },
          identity_pii: { driver: 'mysql', bindingRef: 'FUTURE_MYSQL' },
          custom_claims: { driver: 'd1', bindingRef: 'CUSTOM_DB' },
        },
      },
    ];
    config.profiles.seed.audit = [
      {
        id: 'tenant:audit:future',
        label: 'Future audit',
        primary: { type: 'postgres', connectionRef: 'future-audit' },
        archive: { type: 'd1', bindingRef: 'CUSTOM_AUDIT_DB' },
      },
    ];
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');

    const result = await validateGeneratedEnvironment({ baseDir: root, env });
    const portability = result.checks.find((check) => check.id === 'seeded-profile-portability');

    expect(result.ok).toBe(true);
    expect(portability?.status).toBe('warn');
    expect(portability?.details).toEqual(
      expect.arrayContaining([
        expect.stringContaining('connectionRef=future-core'),
        expect.stringContaining('driver=mysql'),
        expect.stringContaining('bindingRef=CUSTOM_DB'),
        expect.stringContaining('connectionRef=future-audit'),
        expect.stringContaining('bindingRef=CUSTOM_AUDIT_DB'),
      ])
    );
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

  it('fails when generated OTP key material is missing', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot());
    await unlink(join(root, '.authrim', env, 'keys', 'otp_hmac_secret.txt'));

    const result = await validateGeneratedEnvironment({ baseDir: root, env });
    const secretCheck = result.checks.find((check) => check.id === 'logging-secret-material');

    expect(result.ok).toBe(false);
    expect(secretCheck?.status).toBe('fail');
    expect(secretCheck?.details).toEqual(
      expect.arrayContaining([expect.stringContaining('OTP_HMAC_SECRET')])
    );
  });

  it.each([
    ['vc_evidence_hmac_secret.txt', 'VC_EVIDENCE_HMAC_SECRET'],
    ['vc_profile_contract_hmac_secret.txt', 'VC_PROFILE_CONTRACT_HMAC_SECRET'],
  ])('fails when generated VC key material %s is missing', async (fileName, secretName) => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot());
    await unlink(join(root, '.authrim', env, 'keys', fileName));

    const result = await validateGeneratedEnvironment({ baseDir: root, env });
    const secretCheck = result.checks.find((check) => check.id === 'logging-secret-material');

    expect(result.ok).toBe(false);
    expect(secretCheck?.status).toBe('fail');
    expect(secretCheck?.details).toEqual(
      expect.arrayContaining([expect.stringContaining(secretName)])
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

  it('fails when the baseline migration release bucket is missing even if product R2 is disabled', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot());
    const configPath = join(root, '.authrim', env, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    config.features.r2 = { enabled: false };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
    const lockPath = join(root, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    delete lock.r2.MIGRATION_RELEASES;
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf-8');

    const result = await validateGeneratedEnvironment({ baseDir: root, env });
    const check = result.checks.find(
      (candidate) => candidate.id === 'migration-release-r2-binding'
    );

    expect(result.ok).toBe(false);
    expect(check?.status).toBe('fail');
    expect(check?.details).toContain('MIGRATION_RELEASES is missing from lock.json');
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

    expect(result.checks.filter((check) => check.status === 'fail')).toEqual([]);
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
      { name: `${env}-authrim-control-db`, uuid: 'db-control-id' },
      { name: `${env}-authrim-lookup-db`, uuid: 'db-lookup-id' },
      { name: `${env}-authrim-plugin-runner-db`, uuid: 'db-plugin-runner-id' },
    ]);
    listR2BucketsMock.mockResolvedValueOnce([
      { name: `${env}-migration-releases` },
      { name: `${env}-public-assets` },
      { name: `${env}-authrim-avatars` },
      { name: `${env}-diagnostic-logs` },
      { name: `${env}-audit-archive` },
      { name: `${env}-import-artifacts` },
      { name: `${env}-export-artifacts` },
      { name: `${env}-sensitive-details` },
    ]);

    const result = await validateGeneratedEnvironment({ baseDir: root, env, liveCloudflare: true });

    expect(result.checks.filter((check) => check.status === 'fail')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.id === 'live-cloudflare-d1')?.status).toBe('pass');
    expect(result.checks.find((check) => check.id === 'live-cloudflare-kv')?.status).toBe('pass');
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

  it('fails live Cloudflare validation when a recorded KV namespace ID is stale', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot());
    mockLiveRuntimeSchema(env);
    listD1DatabasesMock.mockResolvedValueOnce([
      { name: `${env}-authrim-core-db`, uuid: 'db-core-id' },
      { name: `${env}-authrim-pii-db`, uuid: 'db-pii-id' },
      { name: `${env}-authrim-admin-db`, uuid: 'db-admin-id' },
    ]);
    listKVNamespacesMock.mockResolvedValueOnce(
      KV_NAMESPACES.map((binding) => ({
        title: getKVNamespaceName(env, binding),
        id: binding === 'AUTHRIM_CONFIG' ? 'replacement-config-id' : PORTABLE_KV_IDS[binding],
      }))
    );
    listR2BucketsMock.mockResolvedValueOnce([
      { name: `${env}-migration-releases` },
      { name: `${env}-public-assets` },
      { name: `${env}-authrim-avatars` },
      { name: `${env}-diagnostic-logs` },
      { name: `${env}-audit-archive` },
      { name: `${env}-import-artifacts` },
      { name: `${env}-export-artifacts` },
      { name: `${env}-sensitive-details` },
    ]);

    const result = await validateGeneratedEnvironment({ baseDir: root, env, liveCloudflare: true });
    const kvCheck = result.checks.find((check) => check.id === 'live-cloudflare-kv');

    expect(result.ok).toBe(false);
    expect(kvCheck?.status).toBe('fail');
    expect(kvCheck?.details).toEqual(
      expect.arrayContaining([expect.stringContaining('AUTHRIM_CONFIG')])
    );
    expect(kvCheck?.details).toEqual(
      expect.arrayContaining([expect.stringContaining('id mismatch')])
    );
  });

  it('fails live Cloudflare validation when runtime schema tables are missing', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot());
    mockLiveRuntimeSchema(env, {
      missingCoreTables: ['event_log'],
      missingPiiTables: ['identity_sensitive_values'],
    });
    listD1DatabasesMock.mockResolvedValueOnce([
      { name: `${env}-authrim-core-db`, uuid: 'db-core-id' },
      { name: `${env}-authrim-pii-db`, uuid: 'db-pii-id' },
      { name: `${env}-authrim-admin-db`, uuid: 'db-admin-id' },
    ]);
    listR2BucketsMock.mockResolvedValueOnce([
      { name: `${env}-migration-releases` },
      { name: `${env}-public-assets` },
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
    expect(schemaCheck?.details).toEqual(
      expect.arrayContaining([expect.stringContaining('missing core runtime schema table(s)')])
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
      { name: `${env}-migration-releases` },
      { name: `${env}-public-assets` },
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

  it('checks the live initial tenant D1 resources and accepted Control handoff', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot(), {
      tenantD1StorageDefault: true,
      withTenantD1Bootstrap: true,
    });
    mockLiveRuntimeSchema(env);
    listD1DatabasesMock.mockResolvedValueOnce([
      { name: `${env}-authrim-core-db`, uuid: 'db-core-id' },
      { name: `${env}-authrim-pii-db`, uuid: 'db-pii-id' },
      { name: `${env}-authrim-admin-db`, uuid: 'db-admin-id' },
      { name: `${env}-authrim-control-db`, uuid: 'db-control-id' },
      { name: `${env}-authrim-lookup-db`, uuid: 'db-lookup-id' },
      { name: `${env}-authrim-plugin-runner-db`, uuid: 'db-plugin-runner-id' },
      { name: `authrim-${env}-default-bootstrap`, uuid: 'bootstrap-default-core-id' },
      { name: `authrim-${env}-users-bootstrap`, uuid: 'bootstrap-users-core-id' },
      { name: `authrim-${env}-pii-bootstrap`, uuid: 'bootstrap-pii-id' },
    ]);
    listR2BucketsMock.mockResolvedValueOnce([
      { name: `${env}-migration-releases` },
      { name: `${env}-public-assets` },
      { name: `${env}-authrim-avatars` },
      { name: `${env}-diagnostic-logs` },
      { name: `${env}-audit-archive` },
      { name: `${env}-import-artifacts` },
      { name: `${env}-export-artifacts` },
      { name: `${env}-sensitive-details` },
    ]);

    const result = await validateGeneratedEnvironment({ baseDir: root, env, liveCloudflare: true });
    const bootstrapCheck = result.checks.find((check) => check.id === 'live-tenant-d1-bootstrap');

    expect(result.checks.filter((check) => check.status === 'fail')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(bootstrapCheck?.status).toBe('pass');
    expect(bootstrapCheck?.details).toEqual(
      expect.arrayContaining([expect.stringContaining('bootstrap handoff state: accepted')])
    );
    expect(queryD1RowsMock).toHaveBeenLastCalledWith(
      `${env}-authrim-control-db`,
      "SELECT state FROM control_bootstrap_handoffs WHERE environment_id = 'portable';"
    );
  });
});
