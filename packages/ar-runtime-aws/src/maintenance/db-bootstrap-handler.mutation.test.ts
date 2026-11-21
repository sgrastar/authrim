/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalRestoreJson, restoreEvidenceDigest } from '../import/restore-evidence';
import { maintenanceDatabaseUrl } from './database';

const h = vi.hoisted(() => {
  class ResourceNotFoundException extends Error {
    constructor() {
      super('secret not found');
      this.name = 'ResourceNotFoundException';
    }
  }
  class GetSecretValueCommand {
    constructor(public input: any) {}
  }
  class PutSecretValueCommand {
    constructor(public input: any) {}
  }
  const secretsConstructed = vi.fn();
  const sender = { send: async (_command: unknown): Promise<any> => undefined };
  class SecretsManagerClient {
    constructor(config: unknown) {
      secretsConstructed(config);
    }
    send(command: unknown) {
      return sender.send(command);
    }
  }
  return {
    ResourceNotFoundException,
    GetSecretValueCommand,
    PutSecretValueCommand,
    SecretsManagerClient,
    secretsConstructed,
    sender,
    readFile: vi.fn(),
    mkdtemp: vi.fn(),
    writeFile: vi.fn(),
    rm: vi.fn(),
    randomBytes: vi.fn(),
    createRuntime: vi.fn(),
    restore: vi.fn(),
    createReader: vi.fn(),
    getObject: vi.fn(),
    parseSecrets: vi.fn(),
    loadTenant: vi.fn(),
    rehearse: vi.fn(),
    prepare: vi.fn(),
    snapshot: vi.fn(),
    inspect: vi.fn(),
    countAudit: vi.fn(),
    repairAudit: vi.fn(),
    normalizeUi: vi.fn(),
    normalizeAuthState: vi.fn(),
    countRows: vi.fn(),
    createSql: vi.fn(),
    assertTls: vi.fn(),
    initDatabases: vi.fn(),
    inspectTargets: vi.fn(),
    loadMigrations: vi.fn(),
    withLock: vi.fn(),
    getSecret: vi.fn(),
    putSecret: vi.fn(),
  };
});

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readFile: h.readFile,
  mkdtemp: h.mkdtemp,
  writeFile: h.writeFile,
  rm: h.rm,
}));
vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  randomBytes: h.randomBytes,
}));
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  GetSecretValueCommand: h.GetSecretValueCommand,
  PutSecretValueCommand: h.PutSecretValueCommand,
  ResourceNotFoundException: h.ResourceNotFoundException,
  SecretsManagerClient: h.SecretsManagerClient,
}));
vi.mock('../http-runtime', () => ({ createAwsSamlRuntime: h.createRuntime }));
vi.mock('../import/restore-offline', () => ({ restoreOfflineAwsSamlTenant: h.restore }));
vi.mock('../startup/aws-assets', () => ({ createAwsSdkAssetReader: h.createReader }));
vi.mock('../startup/deployment-config', () => ({ parseAwsSamlDeploymentSecrets: h.parseSecrets }));
vi.mock('../startup/load-activated-tenant', () => ({ loadActivatedAwsSamlTenant: h.loadTenant }));
vi.mock('./authentication-rehearsal', () => ({
  runSyntheticAwsAuthenticationRehearsal: h.rehearse,
}));
vi.mock('./prepare-browser-sp', () => ({ prepareBrowserSp: h.prepare }));
vi.mock('./browser-rehearsal-snapshot', () => ({ readBrowserRehearsalSnapshot: h.snapshot }));
vi.mock('./inspect-restore', () => ({ readCommittedMaintenanceActivation: h.inspect }));
vi.mock('../storage/repair-audit-session-ids', () => ({
  countLegacyAuditSessionIds: h.countAudit,
  repairLegacyAuditSessionIds: h.repairAudit,
}));
vi.mock('../ui/runtime-ui-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui/runtime-ui-config')>();
  h.normalizeUi.mockImplementation(actual.normalizeAwsRuntimeUiConfig);
  return { ...actual, normalizeAwsRuntimeUiConfig: h.normalizeUi };
});
vi.mock('../storage/auth-state-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storage/auth-state-config')>();
  h.normalizeAuthState.mockImplementation(actual.normalizeAwsAuthStateConfig);
  return { ...actual, normalizeAwsAuthStateConfig: h.normalizeAuthState };
});
vi.mock('./database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./database')>()),
  countMaintenanceRows: h.countRows,
  createMaintenanceSqlClient: h.createSql,
  assertMaintenanceTls: h.assertTls,
  initializeMaintenanceDatabases: h.initDatabases,
  inspectMaintenanceTargets: h.inspectTargets,
  loadMaintenanceMigrations: h.loadMigrations,
  withMaintenanceLock: h.withLock,
}));

type Handler = typeof import('./db-bootstrap-handler');
let mod: Handler;

const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const enc = (text: string) => new TextEncoder().encode(text);
const INIT_ID = '01234567-89ab-cdef-0123-456789abcdef';
const RESTORE_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CORE_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const PII_ID = 'cccccccc-3333-4333-8333-cccccccccccc';
const HOST = 'db.example.ap-northeast-1.rds.amazonaws.com';
const OWNER = '123456789012';
const REGION = 'ap-northeast-1';
const TENANT = 'tenant-a';
const ISSUER = 'https://tenant-a.example.test';
const CA = '/var/task/certs/rds-ca.pem';
const PUBLIC = (stage: string) => `aws_database_maintenance_failed:${stage}`;
const secretArn = (name: string, region = REGION, owner = OWNER) =>
  `arn:aws:secretsmanager:${region}:${owner}:secret:${name}`;

function makeEnv(overrides: Record<string, string | undefined> = {}) {
  const region = overrides.AWS_REGION ?? REGION;
  const owner = overrides.AUTHRIM_AWS_BUCKET_OWNER ?? OWNER;
  return {
    AWS_REGION: region,
    NODE_EXTRA_CA_CERTS: CA,
    AUTHRIM_AWS_DB_HOST: HOST,
    AUTHRIM_AWS_DB_PORT: '5432',
    AUTHRIM_AWS_MASTER_SECRET_ARN: secretArn('master', region, owner),
    AUTHRIM_AWS_JOB_CONFIG_SECRET_ARN: secretArn('config', region, owner),
    AUTHRIM_AWS_JOB_CONFIG_SECRET_VERSION_ID: INIT_ID,
    AUTHRIM_AWS_RUNTIME_SECRET_ARN: secretArn('runtime', region, owner),
    AUTHRIM_AWS_INITIALIZATION_ID: INIT_ID,
    AUTHRIM_AWS_DATABASE_PREFIX: 'authrim_dr_rehearsal',
    AUTHRIM_AWS_ASSETS_BUCKET: 'bucket-example',
    AUTHRIM_AWS_BUCKET_OWNER: owner,
    AUTHRIM_AWS_ASSET_PREFIX: 'rehearsal/1/',
    AUTHRIM_AWS_FIXTURE_KEY: 'rehearsal/1/fixture.json',
    AUTHRIM_AWS_FIXTURE_VERSION_ID: 'version-1',
    AUTHRIM_AWS_FIXTURE_SHA256: 'a'.repeat(64),
    ...overrides,
  } as Record<string, string | undefined>;
}
const bad = (overrides: Record<string, string | undefined>) => () =>
  mod.parseMaintenanceConfiguration(makeEnv(overrides));
const INVALID_CONFIG = 'aws_maintenance_configuration_invalid';

describe('parseMaintenanceConfiguration', () => {
  beforeEach(async () => {
    vi.resetModules();
    mod = await import('./db-bootstrap-handler');
  });
  it('returns the parsed configuration for the reviewed environment', () => {
    expect(mod.parseMaintenanceConfiguration(makeEnv())).toStrictEqual({
      region: REGION,
      host: HOST,
      port: 5432,
      masterSecretArn: secretArn('master'),
      configSecretArn: secretArn('config'),
      configSecretVersionId: INIT_ID,
      runtimeSecretArn: secretArn('runtime'),
      initializationId: INIT_ID,
      databasePrefix: 'authrim_dr_rehearsal',
      bucket: 'bucket-example',
      bucketOwner: OWNER,
      assetPrefix: 'rehearsal/1/',
      fixtureKey: 'rehearsal/1/fixture.json',
      fixtureVersionId: 'version-1',
      fixtureSha256: 'a'.repeat(64),
    });
  });
  it.each([
    'AWS_REGION',
    'AUTHRIM_AWS_DB_HOST',
    'AUTHRIM_AWS_DB_PORT',
    'AUTHRIM_AWS_MASTER_SECRET_ARN',
    'AUTHRIM_AWS_JOB_CONFIG_SECRET_ARN',
    'AUTHRIM_AWS_JOB_CONFIG_SECRET_VERSION_ID',
    'AUTHRIM_AWS_RUNTIME_SECRET_ARN',
    'AUTHRIM_AWS_INITIALIZATION_ID',
    'AUTHRIM_AWS_DATABASE_PREFIX',
    'AUTHRIM_AWS_ASSETS_BUCKET',
    'AUTHRIM_AWS_BUCKET_OWNER',
    'AUTHRIM_AWS_ASSET_PREFIX',
    'AUTHRIM_AWS_FIXTURE_KEY',
    'AUTHRIM_AWS_FIXTURE_VERSION_ID',
    'AUTHRIM_AWS_FIXTURE_SHA256',
  ])('requires %s', (key) => {
    expect(bad({ [key]: undefined })).toThrow(INVALID_CONFIG);
    expect(bad({ [key]: '' })).toThrow(INVALID_CONFIG);
  });
  it.each([
    ['unanchored start', { AWS_REGION: 'a-ap-northeast-1' }],
    ['unanchored end', { AWS_REGION: 'ap-northeast-1x' }],
    ['numeric region', { AWS_REGION: 'ap-northeast-12' }],
    ['short owner', { AUTHRIM_AWS_BUCKET_OWNER: '12345678901' }],
    ['long owner', { AUTHRIM_AWS_BUCKET_OWNER: '1234567890123' }],
    ['prefixed owner', { AUTHRIM_AWS_BUCKET_OWNER: 'x123456789012' }],
    ['suffixed owner', { AUTHRIM_AWS_BUCKET_OWNER: '123456789012x' }],
    ['uppercase prefix', { AUTHRIM_AWS_DATABASE_PREFIX: 'Aabc' }],
    ['prefix with a dash', { AUTHRIM_AWS_DATABASE_PREFIX: 'abc-' }],
    ['prefix starting with a digit', { AUTHRIM_AWS_DATABASE_PREFIX: '1abc' }],
    ['overlong prefix', { AUTHRIM_AWS_DATABASE_PREFIX: `a${'b'.repeat(50)}` }],
    ['unanchored initialization id start', { AUTHRIM_AWS_INITIALIZATION_ID: `x${INIT_ID}` }],
    ['unanchored initialization id end', { AUTHRIM_AWS_INITIALIZATION_ID: `${INIT_ID}x` }],
    ['uppercase initialization id', { AUTHRIM_AWS_INITIALIZATION_ID: INIT_ID.toUpperCase() }],
    ['host not rds', { AUTHRIM_AWS_DB_HOST: 'db.example.test' }],
    ['host with prefix underscore', { AUTHRIM_AWS_DB_HOST: 'a_b.rds.amazonaws.com' }],
    ['host with suffix', { AUTHRIM_AWS_DB_HOST: 'x.rds.amazonaws.com.evil.test' }],
    ['port 5433', { AUTHRIM_AWS_DB_PORT: '5433' }],
    ['port text', { AUTHRIM_AWS_DB_PORT: '5432x' }],
    ['bucket too short', { AUTHRIM_AWS_ASSETS_BUCKET: 'ab' }],
    ['bucket uppercase prefix', { AUTHRIM_AWS_ASSETS_BUCKET: 'Abucket-example' }],
    ['bucket underscore suffix', { AUTHRIM_AWS_ASSETS_BUCKET: 'bucket-example_' }],
    ['bucket too long', { AUTHRIM_AWS_ASSETS_BUCKET: 'a'.repeat(64) }],
    ['asset prefix without slash', { AUTHRIM_AWS_ASSET_PREFIX: 'rehearsal/1' }],
    ['asset prefix with leading slash', { AUTHRIM_AWS_ASSET_PREFIX: '/rehearsal/1/' }],
    ['asset prefix with space', { AUTHRIM_AWS_ASSET_PREFIX: 'rehearsal 1/' }],
    ['asset prefix with parent', { AUTHRIM_AWS_ASSET_PREFIX: 'rehearsal/../' }],
    ['fixture outside prefix', { AUTHRIM_AWS_FIXTURE_KEY: 'other/fixture.json' }],
    ['fixture with parent', { AUTHRIM_AWS_FIXTURE_KEY: 'rehearsal/1/../fixture.json' }],
    ['fixture hash uppercase', { AUTHRIM_AWS_FIXTURE_SHA256: 'A'.repeat(64) }],
    ['fixture hash prefixed', { AUTHRIM_AWS_FIXTURE_SHA256: `g${'a'.repeat(64)}` }],
    ['fixture hash suffixed', { AUTHRIM_AWS_FIXTURE_SHA256: `${'a'.repeat(64)}g` }],
    ['null fixture version', { AUTHRIM_AWS_FIXTURE_VERSION_ID: 'null' }],
    ['short config version', { AUTHRIM_AWS_JOB_CONFIG_SECRET_VERSION_ID: 'a'.repeat(31) }],
    ['long config version', { AUTHRIM_AWS_JOB_CONFIG_SECRET_VERSION_ID: 'a'.repeat(65) }],
    ['config version prefixed', { AUTHRIM_AWS_JOB_CONFIG_SECRET_VERSION_ID: `_${'a'.repeat(32)}` }],
    ['config version suffixed', { AUTHRIM_AWS_JOB_CONFIG_SECRET_VERSION_ID: `${'a'.repeat(32)}_` }],
    ['wrong CA path', { NODE_EXTRA_CA_CERTS: '/etc/ssl/other.pem' }],
    ['missing CA path', { NODE_EXTRA_CA_CERTS: undefined }],
  ])('rejects %s', (_label, overrides) => {
    expect(bad(overrides)).toThrow(INVALID_CONFIG);
  });
  it('accepts the boundary values of every length bound', () => {
    expect(
      mod.parseMaintenanceConfiguration(
        makeEnv({
          AUTHRIM_AWS_DATABASE_PREFIX: `a${'b'.repeat(49)}`,
          AUTHRIM_AWS_JOB_CONFIG_SECRET_VERSION_ID: 'a'.repeat(32),
          AUTHRIM_AWS_ASSETS_BUCKET: `a${'b'.repeat(61)}c`,
        })
      ).databasePrefix
    ).toHaveLength(50);
    expect(
      mod.parseMaintenanceConfiguration(
        makeEnv({ AUTHRIM_AWS_JOB_CONFIG_SECRET_VERSION_ID: 'A-'.repeat(32) })
      ).configSecretVersionId
    ).toHaveLength(64);
    expect(
      mod.parseMaintenanceConfiguration(makeEnv({ AUTHRIM_AWS_ASSETS_BUCKET: 'ab3' })).bucket
    ).toBe('ab3');
    expect(
      mod.parseMaintenanceConfiguration(
        makeEnv({ AUTHRIM_AWS_ASSET_PREFIX: 'A9_./-x/', AUTHRIM_AWS_FIXTURE_KEY: 'A9_./-x/f.json' })
      ).assetPrefix
    ).toBe('A9_./-x/');
  });
  it('requires three distinct secrets in the reviewed account and region', () => {
    expect(
      bad({
        AUTHRIM_AWS_CONFIG_PLACEHOLDER: '',
        AUTHRIM_AWS_JOB_CONFIG_SECRET_ARN: secretArn('master'),
      })
    ).toThrow(INVALID_CONFIG);
    expect(bad({ AUTHRIM_AWS_RUNTIME_SECRET_ARN: secretArn('master') })).toThrow(INVALID_CONFIG);
    expect(
      bad({
        AUTHRIM_AWS_RUNTIME_SECRET_ARN: secretArn('config'),
        AUTHRIM_AWS_JOB_CONFIG_SECRET_ARN: secretArn('config'),
      })
    ).toThrow(INVALID_CONFIG);
    for (const key of [
      'AUTHRIM_AWS_MASTER_SECRET_ARN',
      'AUTHRIM_AWS_JOB_CONFIG_SECRET_ARN',
      'AUTHRIM_AWS_RUNTIME_SECRET_ARN',
    ]) {
      expect(bad({ [key]: secretArn('x', REGION, '999999999999') })).toThrow(INVALID_CONFIG);
      expect(bad({ [key]: secretArn('x', 'us-east-1') })).toThrow(INVALID_CONFIG);
      expect(bad({ [key]: `${secretArn('x')}`.replace('arn:aws', 'arn:aws-cn') })).toThrow(
        INVALID_CONFIG
      );
    }
  });
  it('bounds a secret ARN at 2048 characters', () => {
    const exact = secretArn('x'.repeat(2048 - secretArn('').length));
    expect(exact).toHaveLength(2048);
    expect(
      mod.parseMaintenanceConfiguration(makeEnv({ AUTHRIM_AWS_MASTER_SECRET_ARN: exact }))
        .masterSecretArn
    ).toBe(exact);
    for (const key of [
      'AUTHRIM_AWS_MASTER_SECRET_ARN',
      'AUTHRIM_AWS_JOB_CONFIG_SECRET_ARN',
      'AUTHRIM_AWS_RUNTIME_SECRET_ARN',
    ])
      expect(bad({ [key]: `${exact}x` })).toThrow(INVALID_CONFIG);
  });
  describe('browser service provider secret', () => {
    const browser = {
      AUTHRIM_AWS_DATABASE_PREFIX: 'authrim_dr_browser',
      AUTHRIM_AWS_BROWSER_SP_SECRET_ARN: secretArn('browser-sp'),
    };
    it('is optional and parsed when the browser rehearsal prefix and region match', () => {
      expect(mod.parseMaintenanceConfiguration(makeEnv(browser)).browserSpSecretArn).toBe(
        secretArn('browser-sp')
      );
      expect(mod.parseMaintenanceConfiguration(makeEnv())).not.toHaveProperty('browserSpSecretArn');
    });
    it.each([
      [
        'another account',
        { AUTHRIM_AWS_BROWSER_SP_SECRET_ARN: secretArn('b', REGION, '999999999999') },
      ],
      ['another region', { AUTHRIM_AWS_BROWSER_SP_SECRET_ARN: secretArn('b', 'us-east-1') }],
      ['the master secret', { AUTHRIM_AWS_BROWSER_SP_SECRET_ARN: secretArn('master') }],
      ['the config secret', { AUTHRIM_AWS_BROWSER_SP_SECRET_ARN: secretArn('config') }],
      ['the runtime secret', { AUTHRIM_AWS_BROWSER_SP_SECRET_ARN: secretArn('runtime') }],
      ['the rehearsal prefix', { AUTHRIM_AWS_DATABASE_PREFIX: 'authrim_dr_rehearsal' }],
      ['another prefix', { AUTHRIM_AWS_DATABASE_PREFIX: 'authrim_dr_browser2' }],
    ])('rejects a browser secret for %s', (_label, change) => {
      expect(bad({ ...browser, ...change })).toThrow(INVALID_CONFIG);
    });
    it('rejects a browser secret outside ap-northeast-1 and an overlong one', () => {
      const env = {
        ...browser,
        AWS_REGION: 'us-east-1',
        AUTHRIM_AWS_BROWSER_SP_SECRET_ARN: secretArn('browser-sp', 'us-east-1'),
      };
      expect(bad(env)).toThrow(INVALID_CONFIG);
      const exact = secretArn('x'.repeat(2048 - secretArn('').length));
      expect(
        mod.parseMaintenanceConfiguration(
          makeEnv({ ...browser, AUTHRIM_AWS_BROWSER_SP_SECRET_ARN: exact })
        ).browserSpSecretArn
      ).toBe(exact);
      expect(bad({ ...browser, AUTHRIM_AWS_BROWSER_SP_SECRET_ARN: `${exact}x` })).toThrow(
        INVALID_CONFIG
      );
    });
  });
});

describe('parseMaintenanceAction', () => {
  beforeEach(async () => {
    vi.resetModules();
    mod = await import('./db-bootstrap-handler');
  });
  const INVALID = 'aws_maintenance_configuration_invalid';
  it.each([undefined, null, 'initialize', 5, [], ['initialize'], true])(
    'rejects the non-object event %j',
    (event) => {
      expect(() => mod.parseMaintenanceAction(event)).toThrow(INVALID);
    }
  );
  it.each(['', 'Initialize', 'query', 'verify ', undefined, null, 5])(
    'rejects the action %j',
    (action) => {
      expect(() => mod.parseMaintenanceAction({ action })).toThrow(INVALID);
      expect(() => mod.parseMaintenanceAction({ action, evidence: {} })).toThrow(INVALID);
    }
  );
  it.each([
    'initialize',
    'restore',
    'inspect-restore',
    'inspect-audit-session-ids',
    'repair-audit-session-ids',
  ])('accepts %s with no extra keys and refuses evidence', (action) => {
    expect(mod.parseMaintenanceAction({ action })).toStrictEqual({ action });
    expect(() => mod.parseMaintenanceAction({ action, evidence: {} })).toThrow(INVALID);
    expect(() => mod.parseMaintenanceAction({ action, extra: 1 })).toThrow(INVALID);
  });
  it.each(['verify', 'authenticate', 'prepare-browser-sp'])(
    'requires an evidence object for %s and nothing else',
    (action) => {
      const evidence = { restoreId: RESTORE_ID };
      expect(mod.parseMaintenanceAction({ action, evidence })).toStrictEqual({ action, evidence });
      expect(mod.parseMaintenanceAction({ evidence, action })).toStrictEqual({ action, evidence });
      for (const missing of [undefined, null, 'text', 0, 5, true])
        expect(() => mod.parseMaintenanceAction({ action, evidence: missing })).toThrow(INVALID);
      expect(() => mod.parseMaintenanceAction({ action })).toThrow(INVALID);
      expect(() => mod.parseMaintenanceAction({ action, evidence, extra: 1 })).toThrow(INVALID);
      expect(() => mod.parseMaintenanceAction({ evidence })).toThrow(INVALID);
    }
  );
});

// ---------------------------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------------------------
const DIR = '/tmp/authrim-maintenance-test';
const PASSWORDS = { core: 'A'.repeat(43), pii: 'B'.repeat(43), state: 'C'.repeat(43) };
const FAMILIES = ['core', 'pii', 'state'] as const;
const urlFor = (family: (typeof FAMILIES)[number], prefix = 'authrim_dr_rehearsal') =>
  maintenanceDatabaseUrl({
    host: HOST,
    port: 5432,
    database: `${prefix}_${family}`,
    username: `${prefix}_${family}`,
    password: PASSWORDS[family],
  });
const part = (bytes: Uint8Array, key: string, versionId: string) => ({
  key,
  versionId,
  sha256: sha(bytes),
  size: bytes.length,
});

interface Asset {
  versionId: string;
  bytes: Uint8Array;
  size?: number | undefined;
  chunks?: Uint8Array[];
  throwInBody?: boolean;
}
interface Ctx {
  env: Record<string, string | undefined>;
  fixture: any;
  fixtureBytes?: Uint8Array;
  assets: Map<string, Asset>;
  closes: Array<ReturnType<typeof vi.fn>>;
  runtime: any;
  master: any;
  seed: any;
  runtimeExists: boolean;
  ca: string;
  evidence: any;
  admin: { tag: string };
  stateDb: { connect: any; end: any; query: any };
  loaded: any[];
  restored: any;
  app: { app: { request: any } };
  authState: any;
  runtimeCurrent?: string;
}
let ctx: Ctx;
const PART0 = new Uint8Array(400).map((_, i) => i % 251);
const PART1 = new Uint8Array(420).map((_, i) => (i * 7) % 253);
const SUPPLEMENT = new Uint8Array(500).map((_, i) => (i * 3) % 247);

function baseFixture() {
  return {
    formatVersion: 1,
    manifest: { source: { tenantId: TENANT, issuer: ISSUER } },
    backup: {
      receipt: { receiptId: 'receipt-1' },
      maxSnapshotAgeMs: 3_600_000,
      parts: [
        part(PART0, 'rehearsal/1/part-0.bin', 'part-v0'),
        part(PART1, 'rehearsal/1/part-1.bin', 'part-v1'),
      ],
    },
    supplement: part(SUPPLEMENT, 'rehearsal/1/supplement.json', 'supplement-v'),
    restoreId: RESTORE_ID,
    core: { targetId: CORE_ID, bindingRefs: ['core-ref'] },
    pii: { targetId: PII_ID, bindingRefs: ['pii-ref'] },
    environmentName: 'aws-synthetic-rehearsal',
    spEntityIds: ['https://sp.example.test/entity'],
    allocationScope: 'shared_pool',
  };
}

async function setup(envOverrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  for (const fn of Object.values(h)) if (vi.isMockFunction(fn)) fn.mockReset();
  h.secretsConstructed.mockReset();
  h.normalizeUi.mockImplementation(
    (await vi.importActual<typeof import('../ui/runtime-ui-config')>('../ui/runtime-ui-config'))
      .normalizeAwsRuntimeUiConfig
  );
  h.normalizeAuthState.mockImplementation(
    (
      await vi.importActual<typeof import('../storage/auth-state-config')>(
        '../storage/auth-state-config'
      )
    ).normalizeAwsAuthStateConfig
  );
  const closes: Ctx['closes'] = [];
  const request = vi.fn(async () => ({ status: 200 }));
  ctx = {
    env: makeEnv(envOverrides),
    fixture: baseFixture(),
    assets: new Map(),
    closes,
    runtime: {
      formatVersion: 1,
      tenantId: TENANT,
      backupPassphrase: 'backup-pass',
      coreDatabaseUrl: urlFor('core'),
      piiDatabaseUrl: urlFor('pii'),
      stateDatabaseUrl: urlFor('state'),
      flowHmacSecret: 'flow-hmac',
      lookupReadKeys: { current: 'lookup-key' },
    },
    master: { username: 'admin', password: 'p'.repeat(24) },
    seed: {
      backupPassphrase: 'seed-backup-pass',
      awsFlowRuntimeHmacSecret: 'seed-flow-hmac',
      awsLookupReadKeys: { current: 'seed-lookup' },
    },
    runtimeExists: true,
    ca: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
    evidence: { restoreId: RESTORE_ID, marker: 'evidence-from-caller' },
    admin: { tag: 'admin-client' },
    stateDb: {
      connect: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
      query: vi.fn(),
    },
    loaded: [],
    restored: undefined,
    app: { app: { request } },
    authState: { config: { backend: 'postgresql' } },
  };
  ctx.restored = {
    runtime: { assertReady: vi.fn(async () => undefined) },
    evidence: { restoreId: RESTORE_ID, marker: 'evidence-from-restore' },
    close: vi.fn(async () => undefined),
  };
  h.readFile.mockImplementation(async (path: string) => {
    if (path === CA) return ctx.ca;
    throw new Error('ENOENT');
  });
  h.mkdtemp.mockResolvedValue(DIR);
  h.writeFile.mockResolvedValue(undefined);
  h.rm.mockResolvedValue(undefined);
  h.randomBytes.mockImplementation(() =>
    Buffer.from([...Array.from({ length: 10 }, () => [0xfb, 0xef, 0xbe]).flat(), 0xff, 0xff])
  );
  h.createRuntime.mockReturnValue(ctx.app);
  h.restore.mockImplementation(async () => ctx.restored);
  h.createReader.mockReturnValue({ getObject: h.getObject });
  h.getObject.mockImplementation(async (args: { key: string }) => {
    const asset = ctx.assets.get(args.key);
    if (!asset) throw new Error('missing asset');
    const close = vi.fn();
    closes.push(close);
    return {
      versionId: asset.versionId,
      size: 'size' in asset ? asset.size : asset.bytes.length,
      body: (async function* () {
        for (const chunk of asset.chunks ?? [asset.bytes]) yield chunk;
        if (asset.throwInBody) throw new Error('private body failure');
      })(),
      close,
    };
  });
  h.parseSecrets.mockImplementation((raw: string) => JSON.parse(raw));
  h.loadTenant.mockImplementation(async () => {
    const loaded = {
      runtime: { assertReady: vi.fn(async () => undefined) },
      authState: ctx.authState,
      close: vi.fn(async () => undefined),
    };
    ctx.loaded.push(loaded);
    return loaded;
  });
  h.rehearse.mockResolvedValue({ rehearsal: 'done' });
  h.prepare.mockResolvedValue({ prepared: true });
  h.snapshot.mockResolvedValue({ snapshot: 'browser' });
  h.inspect.mockImplementation(async () => ({
    restoreId: RESTORE_ID,
    marker: 'evidence-from-inspect',
  }));
  h.countAudit.mockResolvedValue(3);
  h.repairAudit.mockResolvedValue({ repaired: 3, remaining: 0 });
  h.countRows.mockResolvedValue({ 'core.users_core': 1 });
  h.createSql.mockReturnValue(ctx.stateDb);
  h.assertTls.mockResolvedValue(undefined);
  h.initDatabases.mockResolvedValue([{ family: 'core', database: 'x', schemaSha256: 'y' }]);
  h.inspectTargets.mockResolvedValue({ databases: [], roles: [] });
  h.loadMigrations.mockImplementation(async (family: string) => ({
    digest: `${family}-digest`,
    sql: `-- ${family}`,
    files: [`${family}.sql`],
  }));
  h.withLock.mockImplementation(async (_url: string, _id: string, run: any) => run(ctx.admin));
  h.getSecret.mockImplementation(async (input: any) => {
    const arn = input.SecretId as string;
    if (arn === secretArn('master'))
      return { ARN: arn, VersionId: 'mv', SecretString: JSON.stringify(ctx.master) };
    if (arn === secretArn('runtime')) {
      if (!input.VersionId)
        return {
          ARN: arn,
          VersionId: 'current',
          SecretString: JSON.stringify({ formatVersion: 1, uninitialized: true }),
        };
      if (!ctx.runtimeExists) throw new h.ResourceNotFoundException();
      return { ARN: arn, VersionId: input.VersionId, SecretString: JSON.stringify(ctx.runtime) };
    }
    if (arn === secretArn('config'))
      return { ARN: arn, VersionId: input.VersionId, SecretString: JSON.stringify(ctx.seed) };
    if (arn === secretArn('browser-sp'))
      return { ARN: arn, VersionId: 'bv', SecretString: 'current-browser-secret' };
    throw new Error('unexpected secret');
  });
  h.putSecret.mockImplementation(async (input: any) => ({
    ARN: input.SecretId,
    VersionId: input.ClientRequestToken,
  }));
  h.sender.send = async (command: any) =>
    command instanceof h.GetSecretValueCommand
      ? h.getSecret(command.input)
      : h.putSecret(command.input);
  mod = await import('./db-bootstrap-handler');
}

function applyEnvironment() {
  for (const [key, value] of Object.entries(ctx.env)) vi.stubEnv(key, value);
  const fixtureBytes = ctx.fixtureBytes ?? enc(JSON.stringify(ctx.fixture));
  const fixtureKey = ctx.env.AUTHRIM_AWS_FIXTURE_KEY as string;
  if (!ctx.assets.has(fixtureKey))
    ctx.assets.set(fixtureKey, { versionId: 'version-1', bytes: fixtureBytes });
  if (!('AUTHRIM_AWS_FIXTURE_SHA256_FIXED' in ctx.env))
    vi.stubEnv('AUTHRIM_AWS_FIXTURE_SHA256', sha(fixtureBytes));
  const fixture = ctx.fixture;
  for (const pin of [...(fixture?.backup?.parts ?? []), fixture?.supplement]) {
    if (pin && typeof pin.key === 'string' && !ctx.assets.has(pin.key)) {
      const bytes = pin.key.includes('supplement')
        ? SUPPLEMENT
        : pin.key.endsWith('1.bin')
          ? PART1
          : PART0;
      ctx.assets.set(pin.key, { versionId: pin.versionId, bytes });
    }
  }
}
function run(event: unknown) {
  applyEnvironment();
  return mod.handler(event);
}
async function fails(event: unknown, stage: string) {
  const error = await run(event).then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(PUBLIC(stage));
  return error as Error;
}
const targetsExpected = (prefix = 'authrim_dr_rehearsal') =>
  Object.fromEntries(
    FAMILIES.map((family) => [
      family,
      {
        name: `${prefix}_${family}`,
        user: `${prefix}_${family}`,
        password: PASSWORDS[family],
        connectionString: urlFor(family, prefix),
      },
    ])
  );
const MASTER_URL = () =>
  maintenanceDatabaseUrl({
    host: HOST,
    port: 5432,
    database: 'postgres',
    username: 'admin',
    password: 'p'.repeat(24),
  });
const restoreInput = (extra: Record<string, unknown> = {}) => ({
  backup: {
    receipt: { receiptId: 'receipt-1' },
    maxSnapshotAgeMs: 3_600_000,
    partPaths: [`${DIR}/part-0.bin`, `${DIR}/part-1.bin`],
    passphrase: 'backup-pass',
  },
  supplement: { path: `${DIR}/supplement.json`, expectedSha256: sha(SUPPLEMENT) },
  restoreId: RESTORE_ID,
  core: { targetId: CORE_ID, bindingRefs: ['core-ref'], connectionString: urlFor('core') },
  pii: { targetId: PII_ID, bindingRefs: ['pii-ref'], connectionString: urlFor('pii') },
  state: { connectionString: urlFor('state'), initializeEmptySchema: false },
  environmentName: 'aws-synthetic-rehearsal',
  spEntityIds: ['https://sp.example.test/entity'],
  allocationScope: 'shared_pool',
  awsFlowRuntimeHmacSecret: 'flow-hmac',
  awsLookupReadKeys: { current: 'lookup-key' },
  ...extra,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('handler gate before any secret or database access', () => {
  beforeEach(() => setup());
  it.each([
    ['an unknown action', { action: 'drop' }],
    ['an array event', []],
    ['a null event', null],
    ['extra properties', { action: 'initialize', sql: 'DROP' }],
    ['missing evidence', { action: 'verify' }],
  ])('rejects %s as a validation failure', async (_label, event) => {
    await fails(event, 'validate');
    expect(h.createReader).not.toHaveBeenCalled();
    expect(h.secretsConstructed).not.toHaveBeenCalled();
  });
  it('rejects an invalid environment', async () => {
    ctx.env.AUTHRIM_AWS_DB_PORT = '5433';
    await fails({ action: 'initialize' }, 'validate');
    expect(h.secretsConstructed).not.toHaveBeenCalled();
  });
  it('requires the browser secret for prepare-browser-sp', async () => {
    await fails({ action: 'prepare-browser-sp', evidence: ctx.evidence }, 'validate');
    expect(h.readFile).not.toHaveBeenCalled();
  });
  it.each([
    ['unreadable', null],
    ['empty', ''],
    ['without a certificate', 'just text'],
  ])('rejects a %s reviewed CA bundle before any secret access', async (_label, content) => {
    if (content === null) h.readFile.mockRejectedValue(new Error('ENOENT private'));
    else ctx.ca = content;
    await fails({ action: 'initialize' }, 'validate');
    expect(h.readFile).toHaveBeenCalledWith(CA, 'utf8');
    expect(h.secretsConstructed).not.toHaveBeenCalled();
    expect(h.createReader).not.toHaveBeenCalled();
    expect(h.getObject).not.toHaveBeenCalled();
  });
  it('configures one single-region Secrets Manager client and one asset reader per process', async () => {
    vi.stubEnv('AWS_REGION', REGION);
    await run({ action: 'initialize' });
    await run({ action: 'initialize' });
    expect(h.secretsConstructed).toHaveBeenCalledTimes(1);
    expect(h.secretsConstructed).toHaveBeenCalledWith({
      region: REGION,
      maxAttempts: 2,
      ignoreConfiguredEndpointUrls: true,
      requestHandler: { connectionTimeout: 3_000, requestTimeout: 30_000 },
    });
    expect(h.createReader).toHaveBeenCalledTimes(1);
    expect(h.createReader).toHaveBeenCalledWith(REGION);
  });
});

describe('handler fixture and master secret', () => {
  beforeEach(() => setup());
  it('reads the pinned fixture version from the configured bucket with a timeout signal', async () => {
    await run({ action: 'initialize' });
    expect(h.getObject).toHaveBeenCalledTimes(1);
    expect(h.getObject).toHaveBeenCalledWith({
      bucket: 'bucket-example',
      owner: OWNER,
      key: 'rehearsal/1/fixture.json',
      versionId: 'version-1',
      signal: expect.any(AbortSignal),
    });
    expect(ctx.closes[0]).toHaveBeenCalledOnce();
  });
  it('accepts a fixture of exactly 2 MiB', async () => {
    const json = enc(JSON.stringify(ctx.fixture));
    const exact = new Uint8Array(2 * 1024 * 1024).fill(0x20);
    exact.set(json);
    ctx.fixtureBytes = exact;
    await expect(run({ action: 'initialize' })).resolves.toMatchObject({ status: 'initialized' });
  });
  it('rejects a fixture larger than 2 MiB', async () => {
    const size = 2 * 1024 * 1024 + 1;
    ctx.assets.set(ctx.env.AUTHRIM_AWS_FIXTURE_KEY as string, {
      versionId: 'version-1',
      bytes: new Uint8Array(0),
      size,
    });
    await fails({ action: 'initialize' }, 'read_fixture');
    expect(ctx.closes[0]).toHaveBeenCalledOnce();
  });
  it('reads the master secret without a version and connects with its credentials', async () => {
    await run({ action: 'initialize' });
    expect(h.getSecret).toHaveBeenCalledWith({ SecretId: secretArn('master') });
    expect(h.withLock).toHaveBeenCalledWith(MASTER_URL(), INIT_ID, expect.any(Function));
  });
  it.each([
    ['another ARN', { ARN: secretArn('other') }],
    ['no secret string', { SecretString: undefined }],
    ['an empty secret string', { SecretString: '' }],
  ])('rejects a master response with %s', async (_label, change) => {
    h.getSecret.mockImplementation(async (input: any) => ({
      ARN: input.SecretId,
      SecretString: JSON.stringify(ctx.master),
      ...change,
    }));
    await fails({ action: 'initialize' }, 'read_master');
    expect(h.withLock).not.toHaveBeenCalled();
  });
  it.each([
    ['not json', 'not json'],
    ['another host', { host: 'other.rds.amazonaws.com' }],
    ['another port', { port: 5433 }],
    ['another engine', { engine: 'mysql' }],
    ['a numeric username', { username: 5 }],
    ['a missing username', { username: undefined }],
    ['a numeric password', { password: 5 }],
    ['a missing password', { password: undefined }],
    ['a too short password', { password: 'short' }],
    ['an invalid username', { username: '1bad-user' }],
  ])('rejects a master secret with %s', async (_label, change) => {
    ctx.master = typeof change === 'string' ? change : { ...ctx.master, ...change };
    const raw = typeof change === 'string' ? change : JSON.stringify(ctx.master);
    h.getSecret.mockImplementation(async (input: any) => ({
      ARN: input.SecretId,
      SecretString: raw,
    }));
    await fails({ action: 'initialize' }, 'read_master');
    expect(h.withLock).not.toHaveBeenCalled();
  });
  it('accepts a master secret that states the matching host, port and engine', async () => {
    ctx.master = { ...ctx.master, host: HOST, port: 5432, engine: 'postgres' };
    await expect(run({ action: 'initialize' })).resolves.toMatchObject({ status: 'initialized' });
  });
  it('reports a lock failure as connect_master', async () => {
    h.withLock.mockRejectedValue(new Error('aws_database_maintenance_busy private'));
    await fails({ action: 'initialize' }, 'connect_master');
  });
});

describe('handler asset validation', () => {
  beforeEach(() => setup());
  const fixtureAsset = () => ctx.env.AUTHRIM_AWS_FIXTURE_KEY as string;
  const baseBytes = () => enc(JSON.stringify(ctx.fixture));
  it.each([
    ['another version', (a: Asset) => void (a.versionId = 'other')],
    ['no size', (a: Asset) => void (a.size = undefined)],
    ['a fractional size', (a: Asset) => void (a.size = 1.5)],
    ['a zero size', (a: Asset) => void (a.size = 0)],
    ['a body larger than declared', (a: Asset) => void (a.chunks = [a.bytes, new Uint8Array(1)])],
    ['a body smaller than declared', (a: Asset) => void (a.chunks = [a.bytes.slice(1)])],
    ['a body with the wrong content', (a: Asset) => void (a.chunks = [a.bytes.map((b) => b ^ 1)])],
    ['a failing body', (a: Asset) => void (a.throwInBody = true)],
  ])('rejects a fixture object with %s and still closes it', async (_label, change) => {
    const asset: Asset = { versionId: 'version-1', bytes: baseBytes() };
    change(asset);
    ctx.assets.set(fixtureAsset(), asset);
    await fails({ action: 'initialize' }, 'read_fixture');
    expect(ctx.closes[0]).toHaveBeenCalledOnce();
  });
  it('rejects a fixture whose hash differs from the configured pin', async () => {
    ctx.env.AUTHRIM_AWS_FIXTURE_SHA256_FIXED = '1';
    ctx.env.AUTHRIM_AWS_FIXTURE_SHA256 = 'b'.repeat(64);
    await fails({ action: 'initialize' }, 'read_fixture');
  });
  it('rejects a fixture that is not valid UTF-8 or JSON', async () => {
    ctx.fixtureBytes = new Uint8Array([0xff, 0xfe, 0x7b]);
    await fails({ action: 'initialize' }, 'read_fixture');
  });
  it('joins chunks in order', async () => {
    const bytes = baseBytes();
    ctx.assets.set(fixtureAsset(), {
      versionId: 'version-1',
      bytes,
      chunks: [bytes.slice(0, 10), bytes.slice(10, 50), bytes.slice(50)],
    });
    await expect(run({ action: 'initialize' })).resolves.toMatchObject({ status: 'initialized' });
  });
  const partPin = (change: (pin: any) => void) => () => change(ctx.fixture.backup.parts[0]);
  it.each([
    ['a key outside the prefix', partPin((p) => void (p.key = 'other/part-0.bin'))],
    ['a key with a parent segment', partPin((p) => void (p.key = 'rehearsal/1/../part-0.bin'))],
    ['an empty version', partPin((p) => void (p.versionId = ''))],
    ['a null version', partPin((p) => void (p.versionId = 'null'))],
    ['an uppercase hash', partPin((p) => void (p.sha256 = p.sha256.toUpperCase()))],
    ['a prefixed hash', partPin((p) => void (p.sha256 = `g${p.sha256}`))],
    ['a suffixed hash', partPin((p) => void (p.sha256 = `${p.sha256}g`))],
  ])('rejects a backup pin with %s while downloading', async (_label, change) => {
    change();
    await fails({ action: 'verify', evidence: ctx.evidence }, 'download_backup');
    expect(h.mkdtemp).toHaveBeenCalled();
    expect(h.rm).toHaveBeenCalledWith(DIR, { recursive: true, force: true });
  });
  it.each([
    ['another version', (a: Asset) => void (a.versionId = 'other')],
    ['a different declared size', (a: Asset) => void (a.size = a.bytes.length + 1)],
    ['an unsafe size', (a: Asset) => void (a.size = Number.NaN)],
    ['more bytes than declared', (a: Asset) => void (a.chunks = [a.bytes, new Uint8Array(1)])],
    ['fewer bytes than declared', (a: Asset) => void (a.chunks = [a.bytes.slice(1)])],
    ['other content of the same size', (a: Asset) => void (a.chunks = [a.bytes.map((b) => b ^ 1)])],
  ])('rejects a backup part with %s', async (_label, change) => {
    const bytes = PART0;
    const asset: Asset = { versionId: 'part-v0', bytes };
    change(asset);
    ctx.assets.set('rehearsal/1/part-0.bin', asset);
    await fails({ action: 'verify', evidence: ctx.evidence }, 'download_backup');
    expect(ctx.closes.at(-1)).toHaveBeenCalledOnce();
  });
  it('rejects a supplement larger than its own pinned size', async () => {
    ctx.assets.set('rehearsal/1/supplement.json', {
      versionId: 'supplement-v',
      bytes: SUPPLEMENT,
      chunks: [SUPPLEMENT, new Uint8Array(1)],
    });
    await fails({ action: 'verify', evidence: ctx.evidence }, 'download_backup');
  });
});

describe('handler fixture validation', () => {
  beforeEach(() => setup());
  const cases: Array<[string, (f: any) => void]> = [
    ['an unsupported format', (f) => void (f.formatVersion = 2)],
    ['no manifest', (f) => void delete f.manifest],
    ['no source', (f) => void (f.manifest = {})],
    ['an empty tenant', (f) => void (f.manifest.source.tenantId = '')],
    ['an empty issuer', (f) => void (f.manifest.source.issuer = '')],
    ['a malformed restore id', (f) => void (f.restoreId = 'restore')],
    ['a prefixed restore id', (f) => void (f.restoreId = `x${RESTORE_ID}`)],
    ['a suffixed restore id', (f) => void (f.restoreId = `${RESTORE_ID}x`)],
    ['an uppercase restore id', (f) => void (f.restoreId = RESTORE_ID.toUpperCase())],
    ['no core', (f) => void delete f.core],
    ['a malformed core target', (f) => void (f.core.targetId = 'core')],
    ['no pii', (f) => void delete f.pii],
    ['a malformed pii target', (f) => void (f.pii.targetId = 'pii')],
    ['equal core and pii targets', (f) => void (f.pii.targetId = f.core.targetId)],
    ['no backup', (f) => void delete f.backup],
    ['non-array parts', (f) => void (f.backup.parts = 'parts')],
    ['no parts', (f) => void (f.backup.parts = [])],
    ['129 parts', (f) => void (f.backup.parts = Array(129).fill(f.backup.parts[0]))],
    ['no supplement', (f) => void delete f.supplement],
    ['non-array service providers', (f) => void (f.spEntityIds = 'sp')],
    ['no service providers field', (f) => void delete f.spEntityIds],
    ['an empty environment', (f) => void (f.environmentName = '')],
    ['an unknown allocation scope', (f) => void (f.allocationScope = 'other')],
    ['a zero part size', (f) => void (f.backup.parts[0].size = 0)],
    ['a fractional part size', (f) => void (f.backup.parts[0].size = 1.5)],
    ['a negative part size', (f) => void (f.backup.parts[0].size = -1)],
    ['a text part size', (f) => void (f.backup.parts[0].size = '400')],
    ['a missing part size', (f) => void delete f.backup.parts[0].size],
    ['a zero supplement size', (f) => void (f.supplement.size = 0)],
    ['a text supplement size', (f) => void (f.supplement.size = '500')],
    [
      'a total above 256 MiB',
      (f) => {
        f.backup.parts[0].size = 128 * 1024 * 1024;
        f.backup.parts[1].size = 128 * 1024 * 1024;
        f.supplement.size = 1;
      },
    ],
    [
      'an invalid UI configuration',
      (f) => void (f.destinationUi = { components: { loginUi: true } }),
    ],
    ['an invalid auth state', (f) => void (f.authState = { backend: 'dynamodb' })],
  ];
  it.each(cases)('rejects %s in the read_fixture stage', async (_label, change) => {
    change(ctx.fixture);
    await fails({ action: 'initialize' }, 'read_fixture');
    expect(h.getSecret).not.toHaveBeenCalled();
  });
  it('accepts 128 backup parts', async () => {
    ctx.fixture.backup.parts = Array(128).fill(ctx.fixture.backup.parts[0]);
    await expect(run({ action: 'verify', evidence: ctx.evidence })).resolves.toMatchObject({
      status: 'verified',
    });
    expect(h.writeFile).toHaveBeenCalledTimes(129);
  });
  it('does not normalize optional UI or auth-state selections that are absent', async () => {
    await run({ action: 'initialize' });
    expect(h.normalizeUi).not.toHaveBeenCalled();
    expect(h.normalizeAuthState).not.toHaveBeenCalled();
  });
  it('normalizes a supplied UI selection and a supplied auth-state selection', async () => {
    const ui = {
      components: { loginUi: false, adminUi: false },
      ui: { login: { mode: 'disabled' }, admin: { mode: 'disabled' } },
    };
    ctx.fixture.destinationUi = ui;
    ctx.fixture.authState = { backend: 'postgresql' };
    await run({ action: 'initialize' });
    expect(h.normalizeUi).toHaveBeenCalledWith(ui);
    expect(h.normalizeAuthState).toHaveBeenCalledWith(
      { backend: 'postgresql' },
      { restoreId: RESTORE_ID }
    );
  });
});

describe('handler runtime secret', () => {
  beforeEach(() => setup());
  it('reads the pinned runtime secret version and validates it for the fixture tenant', async () => {
    await run({ action: 'initialize' });
    expect(h.getSecret).toHaveBeenCalledWith({
      SecretId: secretArn('runtime'),
      VersionId: INIT_ID,
    });
    expect(h.parseSecrets).toHaveBeenCalledWith(JSON.stringify(ctx.runtime), TENANT);
    expect(h.putSecret).not.toHaveBeenCalled();
    expect(h.inspectTargets).not.toHaveBeenCalled();
  });
  it.each([
    ['another ARN', { ARN: secretArn('other') }],
    ['no secret string', { SecretString: undefined }],
    ['another version', { VersionId: 'other-version' }],
  ])('rejects a runtime secret response with %s', async (_label, change) => {
    h.getSecret.mockImplementation(async (input: any) =>
      input.SecretId === secretArn('master')
        ? { ARN: input.SecretId, SecretString: JSON.stringify(ctx.master) }
        : {
            ARN: input.SecretId,
            VersionId: input.VersionId,
            SecretString: JSON.stringify(ctx.runtime),
            ...change,
          }
    );
    await fails({ action: 'initialize' }, 'read_runtime_secret');
  });
  it('does not create credentials for a missing runtime secret outside initialize', async () => {
    ctx.runtimeExists = false;
    for (const event of [
      { action: 'restore' },
      { action: 'inspect-restore' },
      { action: 'inspect-audit-session-ids' },
      { action: 'verify', evidence: ctx.evidence },
    ])
      await fails(event, 'read_runtime_secret');
    expect(h.putSecret).not.toHaveBeenCalled();
    expect(h.inspectTargets).not.toHaveBeenCalled();
  });
  it('does not treat other read failures as a missing secret during initialize', async () => {
    h.getSecret.mockImplementation(async (input: any) => {
      if (input.SecretId === secretArn('master'))
        return { ARN: input.SecretId, SecretString: JSON.stringify(ctx.master) };
      throw new Error('AccessDenied private');
    });
    await fails({ action: 'initialize' }, 'read_runtime_secret');
    expect(h.putSecret).not.toHaveBeenCalled();
  });
  it('reports a rejected runtime secret payload in the read stage', async () => {
    h.parseSecrets.mockImplementation(() => {
      throw new Error('aws_runtime_secret_invalid private');
    });
    await fails({ action: 'initialize' }, 'read_runtime_secret');
  });
  it.each([
    [
      'unrelated URLs',
      (r: any) =>
        void (r.coreDatabaseUrl = r.coreDatabaseUrl.replace(HOST, 'other.rds.amazonaws.com')),
    ],
    [
      'another port',
      (r: any) => void (r.piiDatabaseUrl = r.piiDatabaseUrl.replace(':5432', ':5433')),
    ],
    ['no port', (r: any) => void (r.stateDatabaseUrl = r.stateDatabaseUrl.replace(':5432', ''))],
    [
      'another database',
      (r: any) =>
        void (r.coreDatabaseUrl = r.coreDatabaseUrl.replace(
          '/authrim_dr_rehearsal_core',
          '/postgres'
        )),
    ],
    [
      'another user',
      (r: any) =>
        void (r.piiDatabaseUrl = r.piiDatabaseUrl.replace(
          '//authrim_dr_rehearsal_pii:',
          '//other:'
        )),
    ],
    [
      'a short password',
      (r: any) =>
        void (r.stateDatabaseUrl = r.stateDatabaseUrl.replace('C'.repeat(43), 'C'.repeat(42))),
    ],
    [
      'a long password',
      (r: any) =>
        void (r.coreDatabaseUrl = r.coreDatabaseUrl.replace('A'.repeat(43), 'A'.repeat(44))),
    ],
    [
      'a password with another alphabet',
      (r: any) =>
        void (r.piiDatabaseUrl = r.piiDatabaseUrl.replace('B'.repeat(43), `${'B'.repeat(42)}!`)),
    ],
    [
      'a password with a prefix character',
      (r: any) =>
        void (r.piiDatabaseUrl = r.piiDatabaseUrl.replace('B'.repeat(43), `.${'B'.repeat(43)}`)),
    ],
  ])('refuses stored runtime credentials with %s', async (_label, change) => {
    change(ctx.runtime);
    await fails({ action: 'initialize' }, 'read_runtime_secret');
    expect(h.initDatabases).not.toHaveBeenCalled();
  });
  it('passes the decoded database targets derived from the runtime secret', async () => {
    await run({ action: 'initialize' });
    expect(h.initDatabases).toHaveBeenCalledWith(
      expect.objectContaining({ databases: targetsExpected() })
    );
  });
});

describe('handler credential creation for a missing runtime secret', () => {
  beforeEach(async () => {
    await setup();
    ctx.runtimeExists = false;
    h.parseSecrets.mockImplementation((raw: string) => {
      if (raw === JSON.stringify(ctx.runtime)) throw new h.ResourceNotFoundException();
      return JSON.parse(raw);
    });
    h.getSecret.mockImplementation(async (input: any) => {
      const arn = input.SecretId as string;
      if (arn === secretArn('master'))
        return { ARN: arn, SecretString: JSON.stringify(ctx.master) };
      if (arn === secretArn('config'))
        return { ARN: arn, VersionId: input.VersionId, SecretString: JSON.stringify(ctx.seed) };
      if (arn === secretArn('runtime')) {
        if (input.VersionId) throw new h.ResourceNotFoundException();
        return {
          ARN: arn,
          VersionId: 'current',
          SecretString:
            ctx.runtimeCurrent ?? JSON.stringify({ formatVersion: 1, uninitialized: true }),
        };
      }
      throw new Error('unexpected');
    });
  });
  const createdRuntime = () => {
    const password = `${'-'.repeat(40)}__8`;
    const url = (family: string) =>
      maintenanceDatabaseUrl({
        host: HOST,
        port: 5432,
        database: `authrim_dr_rehearsal_${family}`,
        username: `authrim_dr_rehearsal_${family}`,
        password,
      });
    return {
      formatVersion: 1,
      tenantId: TENANT,
      backupPassphrase: 'seed-backup-pass',
      coreDatabaseUrl: url('core'),
      piiDatabaseUrl: url('pii'),
      stateDatabaseUrl: url('state'),
      flowHmacSecret: 'seed-flow-hmac',
      lookupReadKeys: { current: 'seed-lookup' },
    };
  };
  it('generates URL-safe credentials, stores them under the initialization token and continues', async () => {
    const result = await run({ action: 'initialize' });
    expect(h.getSecret).toHaveBeenNthCalledWith(2, {
      SecretId: secretArn('runtime'),
      VersionId: INIT_ID,
    });
    expect(h.getSecret).toHaveBeenNthCalledWith(3, { SecretId: secretArn('runtime') });
    expect(h.inspectTargets).toHaveBeenCalledWith(ctx.admin, [
      'authrim_dr_rehearsal_core',
      'authrim_dr_rehearsal_pii',
      'authrim_dr_rehearsal_state',
    ]);
    expect(h.getSecret).toHaveBeenNthCalledWith(4, {
      SecretId: secretArn('config'),
      VersionId: INIT_ID,
    });
    expect(h.randomBytes).toHaveBeenCalledTimes(3);
    expect(h.randomBytes).toHaveBeenCalledWith(32);
    const expected = createdRuntime();
    expect(h.parseSecrets).toHaveBeenLastCalledWith(JSON.stringify(expected), TENANT);
    expect(h.putSecret).toHaveBeenCalledTimes(1);
    expect(h.putSecret).toHaveBeenCalledWith({
      SecretId: secretArn('runtime'),
      ClientRequestToken: INIT_ID,
      SecretString: canonicalRestoreJson(expected),
    });
    expect(result).toMatchObject({ status: 'initialized' });
    expect(h.initDatabases).toHaveBeenCalledWith(
      expect.objectContaining({
        databases: expect.objectContaining({
          core: expect.objectContaining({ password: `${'-'.repeat(40)}__8` }),
        }),
      })
    );
  });
  it.each([
    ['the stored version is not the pending marker', { formatVersion: 1 }],
    ['an extra key is present', { formatVersion: 1, uninitialized: true, extra: 1 }],
    ['the format version differs', { formatVersion: 2, uninitialized: true }],
    ['it is not marked uninitialized', { formatVersion: 1, uninitialized: false }],
    ['the marker is a string', { formatVersion: 1, uninitialized: 'true' }],
    ['the marker is missing', { formatVersion: 1, other: true }],
  ])('refuses to replace a current secret when %s', async (_label, current) => {
    ctx.runtimeCurrent = JSON.stringify(current);
    await fails({ action: 'initialize' }, 'read_runtime_secret');
    expect(h.putSecret).not.toHaveBeenCalled();
    expect(h.inspectTargets).not.toHaveBeenCalled();
  });
  it.each(['null', '[]', '"text"', '5'])('refuses a current secret that is %s', async (raw) => {
    ctx.runtimeCurrent = raw;
    await fails({ action: 'initialize' }, 'read_runtime_secret');
    expect(h.putSecret).not.toHaveBeenCalled();
  });
  it.each([
    ['a database', { databases: [{ name: 'x', owner: 'y', marker: null }], roles: [] }],
    ['a role', { databases: [], roles: [{ name: 'x', marker: null, safe: true }] }],
  ])('refuses to adopt pre-existing %s', async (_label, found) => {
    h.inspectTargets.mockResolvedValue(found);
    await fails({ action: 'initialize' }, 'read_runtime_secret');
    expect(h.putSecret).not.toHaveBeenCalled();
    expect(h.getSecret).not.toHaveBeenCalledWith(
      expect.objectContaining({ SecretId: secretArn('config') })
    );
  });
  it.each([
    ['another ARN', { ARN: secretArn('other'), VersionId: INIT_ID }],
    ['another version', { ARN: secretArn('runtime'), VersionId: 'other' }],
    ['no version', { ARN: secretArn('runtime') }],
  ])('rejects a persisted secret receipt with %s', async (_label, receipt) => {
    h.putSecret.mockResolvedValue(receipt);
    await fails({ action: 'initialize' }, 'persist_credentials');
    expect(h.initDatabases).not.toHaveBeenCalled();
  });
  it('reports a failed write in the persist stage', async () => {
    h.putSecret.mockRejectedValue(new Error('AccessDenied private'));
    await fails({ action: 'initialize' }, 'persist_credentials');
  });
  it('resumes initialization with the created runtime for later databases', async () => {
    await run({ action: 'initialize' });
    expect(h.initDatabases).toHaveBeenCalledTimes(1);
  });
});

describe('handler initialize action', () => {
  beforeEach(() => setup());
  it('loads every family migration and returns the schema receipt without touching the backup', async () => {
    const result = await run({ action: 'initialize' });
    expect(result).toStrictEqual({
      status: 'initialized',
      initializationId: INIT_ID,
      runtimeSecretVersionId: INIT_ID,
      schema: [{ family: 'core', database: 'x', schemaSha256: 'y' }],
    });
    expect(h.loadMigrations.mock.calls).toEqual([['core'], ['pii'], ['state']]);
    expect(h.initDatabases).toHaveBeenCalledWith({
      master: ctx.admin,
      initializationId: INIT_ID,
      databases: targetsExpected(),
      migrations: {
        core: { digest: 'core-digest', sql: '-- core', files: ['core.sql'] },
        pii: { digest: 'pii-digest', sql: '-- pii', files: ['pii.sql'] },
        state: { digest: 'state-digest', sql: '-- state', files: ['state.sql'] },
      },
    });
    expect(h.mkdtemp).not.toHaveBeenCalled();
    expect(h.rm).not.toHaveBeenCalled();
  });
  it('reports migration and initialization failures in the initialize_databases stage', async () => {
    h.loadMigrations.mockRejectedValueOnce(new Error('ENOENT private'));
    await fails({ action: 'initialize' }, 'initialize_databases');
    h.initDatabases.mockRejectedValue(new Error('SQL private'));
    await fails({ action: 'initialize' }, 'initialize_databases');
  });
});

describe('handler audit session id actions', () => {
  beforeEach(() => setup());
  it('inspects through a verified-TLS state connection and always closes it', async () => {
    const result = await run({ action: 'inspect-audit-session-ids' });
    expect(result).toStrictEqual({ status: 'audit-session-ids-inspected', before: 3 });
    expect(h.createSql).toHaveBeenCalledWith(urlFor('state'));
    expect(ctx.stateDb.connect).toHaveBeenCalledOnce();
    expect(h.assertTls).toHaveBeenCalledWith(ctx.stateDb);
    expect(h.countAudit).toHaveBeenCalledWith(ctx.stateDb);
    expect(h.repairAudit).not.toHaveBeenCalled();
    expect(ctx.stateDb.end).toHaveBeenCalledOnce();
    expect(h.mkdtemp).not.toHaveBeenCalled();
  });
  it('repairs and reports the before count with the repair result', async () => {
    const result = await run({ action: 'repair-audit-session-ids' });
    expect(result).toStrictEqual({
      status: 'audit-session-ids-repaired',
      before: 3,
      repaired: 3,
      remaining: 0,
    });
    expect(h.repairAudit).toHaveBeenCalledWith(ctx.stateDb);
    expect(ctx.stateDb.end).toHaveBeenCalledOnce();
  });
  it('fails an incomplete repair in the repair stage', async () => {
    h.repairAudit.mockResolvedValue({ repaired: 2, remaining: 1 });
    await fails({ action: 'repair-audit-session-ids' }, 'repair-audit-session-ids');
    expect(ctx.stateDb.end).toHaveBeenCalledOnce();
  });
  it.each(['inspect-audit-session-ids', 'repair-audit-session-ids'])(
    'closes the connection and names the stage when TLS or the read fails for %s',
    async (action) => {
      h.assertTls.mockRejectedValueOnce(new Error('aws_database_tls_required'));
      await fails({ action }, action);
      expect(ctx.stateDb.end).toHaveBeenCalledOnce();
      h.countAudit.mockRejectedValueOnce(new Error('SQL private'));
      await fails({ action }, action);
      expect(ctx.stateDb.end).toHaveBeenCalledTimes(2);
    }
  );
  it('reports a failed connect in the action stage without closing an unopened connection twice', async () => {
    ctx.stateDb.connect.mockRejectedValueOnce(new Error('ECONNREFUSED private'));
    await fails({ action: 'inspect-audit-session-ids' }, 'inspect-audit-session-ids');
    expect(h.countAudit).not.toHaveBeenCalled();
  });
});

describe('handler restore action', () => {
  beforeEach(() => setup());
  it('stages the pinned parts privately, restores, verifies readiness and cleans up', async () => {
    const result = await run({ action: 'restore' });
    expect(h.mkdtemp).toHaveBeenCalledWith(join(tmpdir(), 'authrim-maintenance-'));
    expect(h.writeFile).toHaveBeenCalledTimes(3);
    const written = h.writeFile.mock.calls.map(([path, data, options]) => [
      path,
      Array.from(data as Uint8Array),
      options,
    ]);
    expect(written).toEqual([
      [`${DIR}/part-0.bin`, Array.from(PART0), { mode: 0o600, flag: 'wx' }],
      [`${DIR}/part-1.bin`, Array.from(PART1), { mode: 0o600, flag: 'wx' }],
      [`${DIR}/supplement.json`, Array.from(SUPPLEMENT), { mode: 0o600, flag: 'wx' }],
    ]);
    expect(h.getObject).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'rehearsal/1/part-1.bin', versionId: 'part-v1' })
    );
    expect(h.restore).toHaveBeenCalledWith(restoreInput());
    expect(Object.keys(h.restore.mock.calls[0][0]).sort()).toEqual(
      Object.keys(restoreInput()).sort()
    );
    expect(ctx.restored.runtime.assertReady).toHaveBeenCalledOnce();
    expect(ctx.restored.close).toHaveBeenCalledOnce();
    expect(h.loadTenant).toHaveBeenCalledWith({
      ...restoreInput(),
      evidence: ctx.restored.evidence,
    });
    expect(result).toStrictEqual({
      status: 'restored',
      evidence: ctx.restored.evidence,
      runtimeSecretVersionId: INIT_ID,
      readinessStatus: 200,
      coldReloadVerified: true,
      rowCounts: { 'core.users_core': 1 },
    });
    expect(h.rm).toHaveBeenCalledWith(DIR, { recursive: true, force: true });
    for (const close of ctx.closes) expect(close).toHaveBeenCalledOnce();
  });
  it('includes normalized destination UI and auth state selections in the restore input', async () => {
    const ui = {
      components: { loginUi: false, adminUi: false },
      ui: { login: { mode: 'disabled' }, admin: { mode: 'disabled' } },
    };
    ctx.fixture.destinationUi = ui;
    ctx.fixture.authState = {
      backend: 'dynamodb',
      region: REGION,
      tableArn: `arn:aws:dynamodb:${REGION}:${OWNER}:table/auth-state-table`,
      namespace: RESTORE_ID,
    };
    await run({ action: 'restore' });
    const input = h.restore.mock.calls[0][0];
    expect(input.destinationUi).toEqual(ui);
    expect(input.authState).toEqual(ctx.fixture.authState);
    expect(h.normalizeAuthState).toHaveBeenLastCalledWith(ctx.fixture.authState, {
      accountId: OWNER,
      region: REGION,
      restoreId: RESTORE_ID,
    });
  });
  it('rejects an auth-state selection in another account at restore time', async () => {
    ctx.fixture.authState = {
      backend: 'dynamodb',
      region: REGION,
      tableArn: `arn:aws:dynamodb:${REGION}:999999999999:table/auth-state-table`,
      namespace: RESTORE_ID,
    };
    await fails({ action: 'restore' }, 'download_backup');
    expect(h.restore).not.toHaveBeenCalled();
    expect(h.rm).toHaveBeenCalledWith(DIR, { recursive: true, force: true });
  });
  it('omits optional selections that the fixture does not carry', async () => {
    await run({ action: 'restore' });
    const input = h.restore.mock.calls[0][0];
    expect(input).not.toHaveProperty('destinationUi');
    expect(input).not.toHaveProperty('authState');
  });
  it('reports a failed restore, never exposing details, and still cleans up', async () => {
    h.restore.mockRejectedValue(new Error('SQL private-password'));
    const error = await fails({ action: 'restore' }, 'restore');
    expect(error.message).not.toContain('private');
    expect(h.rm).toHaveBeenCalledWith(DIR, { recursive: true, force: true });
    expect(h.loadTenant).not.toHaveBeenCalled();
  });
  it('closes the restored runtime when readiness fails and reports the restore stage', async () => {
    ctx.restored.runtime.assertReady.mockRejectedValue(new Error('not ready'));
    await fails({ action: 'restore' }, 'restore');
    expect(ctx.restored.close).toHaveBeenCalledOnce();
    expect(h.loadTenant).not.toHaveBeenCalled();
  });
  it('fails staging errors in the download stage and removes the staging directory', async () => {
    h.writeFile.mockRejectedValue(new Error('EEXIST private'));
    await fails({ action: 'restore' }, 'download_backup');
    expect(h.rm).toHaveBeenCalledWith(DIR, { recursive: true, force: true });
    expect(h.restore).not.toHaveBeenCalled();
  });
  it('does not remove anything when the staging directory could not be created', async () => {
    h.mkdtemp.mockRejectedValue(new Error('EACCES private'));
    await fails({ action: 'restore' }, 'download_backup');
    expect(h.rm).not.toHaveBeenCalled();
  });
});

describe('handler inspect-restore action', () => {
  beforeEach(() => setup());
  it('reads the committed marker with every expectation and then cold reloads it', async () => {
    const result = await run({ action: 'inspect-restore' });
    expect(h.inspect).toHaveBeenCalledWith({
      connectionString: urlFor('state'),
      expected: {
        restoreId: RESTORE_ID,
        tenantId: TENANT,
        issuer: ISSUER,
        backupReceiptSha256: restoreEvidenceDigest({ receiptId: 'receipt-1' }),
        supplementFileSha256: sha(SUPPLEMENT),
        coreTargetId: CORE_ID,
        piiTargetId: PII_ID,
        maxSnapshotAgeMs: 3_600_000,
      },
    });
    expect(h.restore).not.toHaveBeenCalled();
    expect(h.loadTenant).toHaveBeenCalledWith({
      ...restoreInput(),
      evidence: { restoreId: RESTORE_ID, marker: 'evidence-from-inspect' },
    });
    expect(result).toMatchObject({
      status: 'verified',
      evidence: { marker: 'evidence-from-inspect' },
    });
  });
  it('names the inspect stage when the marker cannot be verified', async () => {
    h.inspect.mockRejectedValue(new Error('aws_maintenance_restore_not_verifiable'));
    await fails({ action: 'inspect-restore' }, 'inspect_restore');
    expect(h.loadTenant).not.toHaveBeenCalled();
  });
});

describe('handler verify action', () => {
  beforeEach(() => setup());
  it('verifies the supplied evidence by cold reload and reports readiness', async () => {
    const result = await run({ action: 'verify', evidence: ctx.evidence });
    expect(h.restore).not.toHaveBeenCalled();
    expect(h.inspect).not.toHaveBeenCalled();
    expect(h.loadTenant).toHaveBeenCalledTimes(1);
    expect(h.loadTenant).toHaveBeenCalledWith({ ...restoreInput(), evidence: ctx.evidence });
    expect(h.createRuntime).toHaveBeenCalledWith({ tenants: [ctx.loaded[0].runtime] });
    expect(ctx.loaded[0].runtime.assertReady).toHaveBeenCalledOnce();
    expect(ctx.app.app.request).toHaveBeenCalledTimes(1);
    expect(ctx.app.app.request).toHaveBeenCalledWith(`${ISSUER}/health/ready`);
    expect(h.countRows).toHaveBeenCalledWith(targetsExpected(), TENANT);
    expect(ctx.loaded[0].close).toHaveBeenCalledOnce();
    expect(result).toStrictEqual({
      status: 'verified',
      evidence: ctx.evidence,
      runtimeSecretVersionId: INIT_ID,
      readinessStatus: 200,
      coldReloadVerified: true,
      rowCounts: { 'core.users_core': 1 },
    });
    expect(result).not.toHaveProperty('browserSnapshot');
    expect(h.snapshot).not.toHaveBeenCalled();
  });
  it('rejects evidence for another restore in the verify stage', async () => {
    await fails(
      { action: 'verify', evidence: { restoreId: 'aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb' } },
      'verify'
    );
    expect(h.loadTenant).not.toHaveBeenCalled();
    await fails({ action: 'verify', evidence: {} }, 'verify');
  });
  it('fails a loader error in the cold reload stage', async () => {
    h.loadTenant.mockRejectedValue(new Error('SQL private'));
    await fails({ action: 'verify', evidence: ctx.evidence }, 'cold_reload');
  });
  it('closes the reloaded runtime and names the cold reload stage when it is not ready', async () => {
    h.loadTenant.mockImplementation(async () => {
      const loaded = {
        runtime: {
          assertReady: vi.fn(async () => {
            throw new Error('not ready private');
          }),
        },
        authState: ctx.authState,
        close: vi.fn(async () => undefined),
      };
      ctx.loaded.push(loaded);
      return loaded;
    });
    await fails({ action: 'verify', evidence: ctx.evidence }, 'cold_reload');
    expect(ctx.loaded[0].close).toHaveBeenCalledOnce();
    expect(h.createRuntime).not.toHaveBeenCalled();
  });
  it.each([503, 404, 201])('fails readiness answered with HTTP %i', async (status) => {
    ctx.app.app.request.mockResolvedValue({ status });
    await fails({ action: 'verify', evidence: ctx.evidence }, 'cold_reload');
    expect(ctx.loaded[0].close).toHaveBeenCalledOnce();
    expect(h.countRows).not.toHaveBeenCalled();
  });
  it('attaches the browser snapshot only for the reviewed browser rehearsal', async () => {
    ctx.fixture.environmentName = 'aws-browser-rehearsal';
    ctx.runtime = {
      ...ctx.runtime,
      coreDatabaseUrl: urlFor('core', 'authrim_dr_browser'),
      piiDatabaseUrl: urlFor('pii', 'authrim_dr_browser'),
      stateDatabaseUrl: urlFor('state', 'authrim_dr_browser'),
    };
    ctx.env.AUTHRIM_AWS_DATABASE_PREFIX = 'authrim_dr_browser';
    const result: any = await run({ action: 'verify', evidence: ctx.evidence });
    expect(result.browserSnapshot).toEqual({ snapshot: 'browser' });
    expect(h.snapshot).toHaveBeenCalledWith(
      targetsExpected('authrim_dr_browser'),
      undefined,
      ctx.authState
    );
  });
  it.each([
    ['another environment', { name: 'aws-synthetic-rehearsal', prefix: 'authrim_dr_browser' }],
    ['another database prefix', { name: 'aws-browser-rehearsal', prefix: 'authrim_dr_rehearsal' }],
  ])('omits the browser snapshot for %s', async (_label, { name, prefix }) => {
    ctx.fixture.environmentName = name;
    ctx.runtime = {
      ...ctx.runtime,
      coreDatabaseUrl: urlFor('core', prefix),
      piiDatabaseUrl: urlFor('pii', prefix),
      stateDatabaseUrl: urlFor('state', prefix),
    };
    ctx.env.AUTHRIM_AWS_DATABASE_PREFIX = prefix;
    const result: any = await run({ action: 'verify', evidence: ctx.evidence });
    expect(result).not.toHaveProperty('browserSnapshot');
    expect(h.snapshot).not.toHaveBeenCalled();
  });
  it('fails a snapshot error in the cold reload stage', async () => {
    ctx.fixture.environmentName = 'aws-browser-rehearsal';
    ctx.runtime = {
      ...ctx.runtime,
      coreDatabaseUrl: urlFor('core', 'authrim_dr_browser'),
      piiDatabaseUrl: urlFor('pii', 'authrim_dr_browser'),
      stateDatabaseUrl: urlFor('state', 'authrim_dr_browser'),
    };
    ctx.env.AUTHRIM_AWS_DATABASE_PREFIX = 'authrim_dr_browser';
    h.snapshot.mockRejectedValue(new Error('aws_browser_rehearsal_snapshot_failed'));
    await fails({ action: 'verify', evidence: ctx.evidence }, 'cold_reload');
    expect(ctx.loaded[0].close).toHaveBeenCalledOnce();
  });
});

describe('handler authenticate action', () => {
  beforeEach(() => setup());
  it('inspects the activated tenant, releases it and rehearses with fresh loads', async () => {
    const result = await run({ action: 'authenticate', evidence: ctx.evidence });
    expect(h.loadTenant).toHaveBeenCalledTimes(1);
    expect(ctx.loaded[0].close).toHaveBeenCalledOnce();
    expect(h.rehearse).toHaveBeenCalledTimes(1);
    const arg = h.rehearse.mock.calls[0][0];
    expect(Object.keys(arg).sort()).toEqual(['authState', 'databases', 'fixture', 'load', 'seed']);
    expect(arg.databases).toEqual(targetsExpected());
    expect(arg.fixture).toEqual(ctx.fixture);
    expect(arg.authState).toBe(ctx.authState);
    expect(arg.seed).toEqual(ctx.seed);
    expect(h.getSecret).toHaveBeenCalledWith({
      SecretId: secretArn('config'),
      VersionId: INIT_ID,
    });
    await arg.load();
    expect(h.loadTenant).toHaveBeenCalledTimes(2);
    expect(h.loadTenant).toHaveBeenLastCalledWith({ ...restoreInput(), evidence: ctx.evidence });
    expect(h.countRows).toHaveBeenCalledWith(targetsExpected(), TENANT);
    expect(h.createRuntime).not.toHaveBeenCalled();
    expect(result).toStrictEqual({
      status: 'authenticated',
      evidence: ctx.evidence,
      runtimeSecretVersionId: INIT_ID,
      authentication: { rehearsal: 'done' },
      rowCounts: { 'core.users_core': 1 },
    });
  });
  it('rejects evidence for another restore in the verify stage', async () => {
    await fails(
      { action: 'authenticate', evidence: { restoreId: 'aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb' } },
      'verify'
    );
    expect(h.rehearse).not.toHaveBeenCalled();
  });
  it('names the authenticate stage when the initial load fails', async () => {
    h.loadTenant.mockRejectedValue(new Error('SQL private'));
    await fails({ action: 'authenticate', evidence: ctx.evidence }, 'authenticate');
  });
  it.each([
    ['aws_synthetic_authentication_rehearsal_failed:probe_1', 'probe_1'],
    [
      'aws_synthetic_authentication_rehearsal_failed:probe_2:signed_claims',
      'probe_2:signed_claims',
    ],
    ['aws_synthetic_authentication_rehearsal_failed:snapshot_before', 'snapshot_before'],
    ['aws_synthetic_authentication_rehearsal_failed:bad-origin_0', 'bad-origin_0'],
    [
      `aws_synthetic_authentication_rehearsal_failed:${'a'.repeat(40)}:${'b'.repeat(40)}`,
      `${'a'.repeat(40)}:${'b'.repeat(40)}`,
    ],
  ])('relays the safe rehearsal stage from %s', async (message, tail) => {
    h.rehearse.mockRejectedValue(new Error(message));
    await fails({ action: 'authenticate', evidence: ctx.evidence }, `authenticate:${tail}`);
  });
  it.each([
    ['an uppercase stage', 'aws_synthetic_authentication_rehearsal_failed:Probe'],
    ['an overlong stage', `aws_synthetic_authentication_rehearsal_failed:${'a'.repeat(41)}`],
    [
      'an overlong second stage',
      `aws_synthetic_authentication_rehearsal_failed:a:${'b'.repeat(41)}`,
    ],
    ['a third segment', 'aws_synthetic_authentication_rehearsal_failed:a:b:c'],
    ['an empty stage', 'aws_synthetic_authentication_rehearsal_failed:'],
    ['a prefixed message', 'x aws_synthetic_authentication_rehearsal_failed:probe_1'],
    [
      'a message with trailing text',
      'aws_synthetic_authentication_rehearsal_failed:probe_1 secret',
    ],
    ['a multiline message', 'aws_synthetic_authentication_rehearsal_failed:probe_1\nsecret'],
    ['another error', 'SQL private-password'],
  ])('does not relay %s', async (_label, message) => {
    h.rehearse.mockRejectedValue(new Error(message));
    await fails({ action: 'authenticate', evidence: ctx.evidence }, 'authenticate');
  });
  it('does not relay a non-error rejection', async () => {
    h.rehearse.mockRejectedValue('aws_synthetic_authentication_rehearsal_failed:probe_1');
    await fails({ action: 'authenticate', evidence: ctx.evidence }, 'authenticate');
  });
  it('does not relay a rehearsal-shaped error from another stage', async () => {
    h.restore.mockRejectedValue(new Error('aws_synthetic_authentication_rehearsal_failed:probe_1'));
    await fails({ action: 'restore' }, 'restore');
  });
});

describe('handler prepare-browser-sp action', () => {
  beforeEach(() =>
    setup({
      AUTHRIM_AWS_DATABASE_PREFIX: 'authrim_dr_browser',
      AUTHRIM_AWS_BROWSER_SP_SECRET_ARN: secretArn('browser-sp'),
    }).then(() => {
      ctx.runtime = {
        ...ctx.runtime,
        coreDatabaseUrl: urlFor('core', 'authrim_dr_browser'),
        piiDatabaseUrl: urlFor('pii', 'authrim_dr_browser'),
        stateDatabaseUrl: urlFor('state', 'authrim_dr_browser'),
      };
      ctx.fixture.environmentName = 'aws-browser-rehearsal';
    })
  );
  const event = () => ({ action: 'prepare-browser-sp', evidence: ctx.evidence });
  it('prepares the synthetic service provider from the reloaded runtime and stores the secret', async () => {
    let captured: any;
    h.prepare.mockImplementation(async (options: any) => {
      captured = options;
      return { prepared: true };
    });
    const result = await run(event());
    expect(result).toStrictEqual({
      status: 'browser-sp-prepared',
      prepared: true,
      browserSpSecretVersionId: INIT_ID,
    });
    expect(Object.keys(captured).sort()).toEqual(
      [
        'authState',
        'currentSecret',
        'databasePrefix',
        'environmentName',
        'host',
        'issuer',
        'metadata',
        'onStage',
        'saveSecret',
        'seed',
        'spEntityIds',
        'stateDatabaseUrl',
        'tenantId',
      ].sort()
    );
    expect(captured).toMatchObject({
      databasePrefix: 'authrim_dr_browser',
      environmentName: 'aws-browser-rehearsal',
      tenantId: TENANT,
      issuer: ISSUER,
      spEntityIds: ['https://sp.example.test/entity'],
      host: HOST,
      stateDatabaseUrl: urlFor('state', 'authrim_dr_browser'),
      authState: ctx.authState,
      seed: ctx.seed,
    });
    expect(h.createRuntime).toHaveBeenCalledWith({ tenants: [ctx.loaded[0].runtime] });
    expect(ctx.loaded[0].close).toHaveBeenCalledOnce();
    expect(h.countRows).not.toHaveBeenCalled();
    expect(ctx.app.app.request).not.toHaveBeenCalledWith(`${ISSUER}/health/ready`);
  });
  it('wires metadata, the current secret and the secret writer to the right collaborators', async () => {
    let captured: any;
    h.prepare.mockImplementation(async (options: any) => {
      captured = options;
      return {};
    });
    await run(event());
    ctx.app.app.request.mockResolvedValue({ status: 200, marker: 'metadata' });
    await expect(captured.metadata()).resolves.toEqual({ status: 200, marker: 'metadata' });
    expect(ctx.app.app.request).toHaveBeenLastCalledWith(`${ISSUER}/saml/idp/metadata`, undefined, {
      requestContext: { http: { sourceIp: '203.0.113.8' } },
    });
    await expect(captured.currentSecret()).resolves.toBe('current-browser-secret');
    expect(h.getSecret).toHaveBeenLastCalledWith({ SecretId: secretArn('browser-sp') });
    await captured.saveSecret('new-browser-secret');
    expect(h.putSecret).toHaveBeenCalledWith({
      SecretId: secretArn('browser-sp'),
      ClientRequestToken: INIT_ID,
      SecretString: 'new-browser-secret',
    });
    h.putSecret.mockResolvedValueOnce({ ARN: secretArn('other'), VersionId: INIT_ID });
    await expect(captured.saveSecret('x')).rejects.toThrow('aws_maintenance_configuration_invalid');
    h.putSecret.mockResolvedValueOnce({ ARN: secretArn('browser-sp'), VersionId: 'other' });
    await expect(captured.saveSecret('x')).rejects.toThrow('aws_maintenance_configuration_invalid');
  });
  it('reports the substage active when preparation fails', async () => {
    h.prepare.mockImplementation(async (options: any) => {
      options.onStage('write_secret');
      throw new Error('private');
    });
    await fails(event(), 'prepare_browser_sp_write_secret');
    expect(ctx.loaded[0].close).toHaveBeenCalledOnce();
  });
  it('reports the base stage when preparation fails before any substage', async () => {
    h.prepare.mockRejectedValue(new Error('private'));
    await fails(event(), 'prepare_browser_sp');
  });
  it('rejects evidence for another restore in the verify stage', async () => {
    await fails(
      {
        action: 'prepare-browser-sp',
        evidence: { restoreId: 'aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb' },
      },
      'verify'
    );
    expect(h.prepare).not.toHaveBeenCalled();
  });
});
