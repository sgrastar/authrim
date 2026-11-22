/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- mock call inspection */
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalRestoreJson } from '../import/restore-evidence';
import { readReplicationAuthoritySchema } from './initialize';
import {
  createReplicationPlan,
  parseReplicationConfiguration,
  parseReplicationPlan,
  replicationPlanDigest,
  replicationSecret,
  type ReplicationConfiguration,
} from './plan';

const folders: string[] = [];
const executor = 'a'.repeat(64);
afterEach(async () => {
  await Promise.all(folders.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'authrim-plan-mut-'));
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
  return { directory, schemaPath, pin, sql, config };
}

const bad = (c: unknown) =>
  expect(() => parseReplicationConfiguration(c)).toThrow('replication_plan_invalid');
const good = (c: unknown) => expect(() => parseReplicationConfiguration(c)).not.toThrow();
type C = any;
const mutate = async (fn: (c: C, f: Awaited<ReturnType<typeof fixture>>) => void) => {
  const f = await fixture();
  const c: C = structuredClone(f.config);
  fn(c, f);
  return c;
};

describe('failover approval', () => {
  const approval = (over: Record<string, unknown> = {}) => ({
    standbyStatePath: '/abs/standby.json',
    standbyStateSha256: 'b'.repeat(64),
    maximumSnapshotAgeMs: 60_000,
    ...over,
  });
  it('accepts a complete approval and keeps it', async () => {
    const c = await mutate((c) => (c.failover = approval()));
    expect(parseReplicationConfiguration(c).failover).toEqual(approval());
  });
  it('treats an explicitly undefined failover key as absent', async () => {
    good(await mutate((c) => (c.failover = undefined)));
  });
  it('rejects malformed approvals', async () => {
    for (const over of [
      { standbyStatePath: 'relative.json' },
      { standbyStateSha256: 'B'.repeat(64) },
      { standbyStateSha256: 'b'.repeat(63) },
      { standbyStateSha256: `x${'b'.repeat(64)}` },
      { standbyStateSha256: `${'b'.repeat(64)}x` },
      { maximumSnapshotAgeMs: 999 },
      { maximumSnapshotAgeMs: 30 * 86_400_000 + 1 },
      { maximumSnapshotAgeMs: 1.5 },
      { maximumSnapshotAgeMs: '60000' },
      { extra: 1 },
    ])
      bad(await mutate((c) => (c.failover = approval(over))));
  });
  it('accepts approval boundaries 1000 ms and 30 days', async () => {
    for (const ms of [1000, 30 * 86_400_000])
      good(await mutate((c) => (c.failover = approval({ maximumSnapshotAgeMs: ms }))));
  });
  it('rejects a missing field in the approval', async () => {
    bad(
      await mutate(
        (c) => (c.failover = { standbyStatePath: '/a.json', standbyStateSha256: 'b'.repeat(64) })
      )
    );
  });
});

describe('top-level bounds', () => {
  it('accepts expectedEpoch 1 and rejects 0, floats, strings', async () => {
    good(await mutate((c) => (c.expectedEpoch = 1)));
    good(await mutate((c) => (c.expectedEpoch = 9_007_199_254_740_991)));
    for (const v of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 2])
      bad(await mutate((c) => (c.expectedEpoch = v)));
  });
  it('bounds maxSnapshotAgeMs at 1000 ms .. 30 days inclusive', async () => {
    for (const v of [1000, 30 * 86_400_000]) good(await mutate((c) => (c.maxSnapshotAgeMs = v)));
    for (const v of [999, 30 * 86_400_000 + 1, 1000.5, '1000'])
      bad(await mutate((c) => (c.maxSnapshotAgeMs = v)));
  });
  it('requires formatVersion 1 and no unknown keys', async () => {
    bad(await mutate((c) => (c.formatVersion = 2)));
    bad(await mutate((c) => (c.extra = 1)));
    bad(await mutate((c) => delete c.maxSnapshotAgeMs));
    bad(null);
    bad([]);
    bad('x');
  });
  it('requires distinct, correctly-typed deployments', async () => {
    bad(await mutate((c) => (c.destinationDeploymentId = 'cf-a')));
    bad(await mutate((c) => (c.sourceDeploymentId = 'aws-a')));
    bad(await mutate((c) => (c.destinationDeploymentId = 'missing')));
    bad(await mutate((c) => (c.sourceDeploymentId = 'missing')));
    bad(await mutate((c) => (c.sourceDeploymentId = 'bad id!')));
    bad(await mutate((c) => (c.destinationDeploymentId = 'bad id!')));
    bad(await mutate((c) => (c.pair.tenantId = '')));
  });
});

describe('authority section', () => {
  const bootstrap = (over: Record<string, unknown> = {}) => ({
    databaseUrlEnv: 'OWNER_DB',
    serviceRole: 'svc_role',
    journalRole: 'jrn_role',
    ...over,
  });
  it('accepts a valid bootstrap', async () => {
    const c = await mutate((c) => (c.authority.bootstrap = bootstrap()));
    expect(parseReplicationConfiguration(c).authority.bootstrap).toEqual(bootstrap());
  });
  it('rejects bad bootstrap shapes', async () => {
    for (const b of [
      bootstrap({ databaseUrlEnv: 'lower' }),
      bootstrap({ databaseUrlEnv: 'AUTHORITY_DB' }),
      bootstrap({ serviceRole: 'Bad' }),
      bootstrap({ journalRole: 'svc_role' }),
      bootstrap({ extra: 1 }),
    ])
      bad(await mutate((c) => (c.authority.bootstrap = b)));
  });
  it('validates endpoint, credential id and secret names', async () => {
    bad(
      await mutate(
        (c) => (c.authority.endpoint = 'http://authority.example.test/replication/v1/rpc')
      )
    );
    bad(await mutate((c) => (c.authority.endpoint = 'https://authority.example.test/other')));
    bad(await mutate((c) => (c.authority.credentialId = 'bad id')));
    for (const v of ['lower', '1ABC', 'A-B', '', 'A'.repeat(129)]) {
      bad(await mutate((c) => (c.authority.secretEnv = v)));
      bad(await mutate((c) => (c.authority.databaseUrlEnv = v)));
    }
    good(await mutate((c) => (c.authority.secretEnv = 'A'.repeat(128))));
    good(await mutate((c) => (c.authority.databaseUrlEnv = 'A1_B')));
  });
});

describe('source section', () => {
  it('validates kind, versions, origins, grant and env names', async () => {
    bad(await mutate((c) => (c.source.kind = 'aws')));
    for (const v of [
      '1.2',
      '1.2.3.4',
      'v1.2.3',
      '1.2.3-',
      '1.2.3 ',
      ' 1.2.3',
      '1.2.x',
      '1.2.3-a_b',
    ])
      bad(await mutate((c) => (c.source.identity.productVersion = v)));
    for (const v of ['1.2.3', '10.20.30-rc.1', '1.2.3+build.5', '0.0.0-a-b'])
      good(await mutate((c) => (c.source.identity.productVersion = v)));
    for (const v of [
      'http://source.example.test',
      'https://source.example.test/',
      'https://source.example.test/path',
      'https://user@source.example.test',
      'https://user:pw@source.example.test',
      'not a url',
    ]) {
      bad(await mutate((c) => (c.source.managementOrigin = v)));
      bad(await mutate((c) => (c.source.identity.issuer = v)));
    }
    bad(await mutate((c) => (c.source.grantId = 'bad id')));
    bad(await mutate((c) => (c.source.credentialEnv = 'x')));
    bad(await mutate((c) => (c.source.passphraseEnv = 'x')));
    bad(await mutate((c) => (c.source.extra = 1)));
    bad(await mutate((c) => (c.source.identity.extra = 1)));
    bad(await mutate((c) => delete c.source.identity.issuer));
  });
});

describe('destination section', () => {
  it('validates fixed kinds, prefix and allocation scope', async () => {
    bad(await mutate((c) => (c.destination.kind = 'cloudflare')));
    for (const v of ['A', '1a', '_a', 'a-b', '', 'a'.repeat(20)])
      bad(await mutate((c) => (c.destination.databasePrefix = v)));
    for (const v of ['a', 'a'.repeat(19), 'a_1'])
      good(await mutate((c) => (c.destination.databasePrefix = v)));
    bad(await mutate((c) => (c.destination.allocationScope = 'other')));
    good(await mutate((c) => (c.destination.allocationScope = 'shared_pool')));
    bad(await mutate((c) => (c.destination.environmentName = 'bad id')));
    bad(await mutate((c) => (c.destination.writerCredentialId = 'bad id')));
  });
  it('validates every destination secret env name', async () => {
    for (const k of ['masterUrlEnv', 'credentialSeedEnv', 'flowHmacSecretEnv', 'writerSecretEnv'])
      bad(await mutate((c) => (c.destination[k] = 'lower')));
  });
  it('bounds the reference lists (count, length, control characters, uniqueness)', async () => {
    for (const [key, max] of [
      ['coreBindingRefs', 1024],
      ['piiBindingRefs', 1024],
      ['spEntityIds', 1000],
    ] as const) {
      const make = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`);
      good(await mutate((c) => (c.destination[key] = make(max))));
      bad(await mutate((c) => (c.destination[key] = make(max + 1))));
      bad(await mutate((c) => (c.destination[key] = [])));
      bad(await mutate((c) => (c.destination[key] = ['a', 'a'])));
      bad(await mutate((c) => (c.destination[key] = [''])));
      bad(await mutate((c) => (c.destination[key] = [5])));
      bad(await mutate((c) => (c.destination[key] = 'a')));
      good(await mutate((c) => (c.destination[key] = ['x'.repeat(2048)])));
      bad(await mutate((c) => (c.destination[key] = ['x'.repeat(2049)])));
      bad(await mutate((c) => (c.destination[key] = ['a\u001fb'])));
      bad(await mutate((c) => (c.destination[key] = ['a\u007fb'])));
      good(await mutate((c) => (c.destination[key] = ['a b', 'a\u0080b', 'a~b'])));
      bad(await mutate((c) => (c.destination[key] = ['a\tb'])));
    }
  });
  it('validates UI config through the runtime normalizer', async () => {
    bad(await mutate((c) => (c.destination.ui = { bogus: true })));
  });
  it('requires one or two distinct lookup keys with valid generations', async () => {
    const key = (generation: unknown, secretEnv: unknown = 'LOOKUP_SECRET') => ({
      generation,
      secretEnv,
    });
    good(await mutate((c) => (c.destination.lookupReadKeys = [key(1), key(2, 'OTHER_SECRET')])));
    bad(await mutate((c) => (c.destination.lookupReadKeys = [])));
    bad(await mutate((c) => (c.destination.lookupReadKeys = [key(1), key(2), key(3)])));
    bad(await mutate((c) => (c.destination.lookupReadKeys = [key(1), key(1, 'OTHER_SECRET')])));
    bad(await mutate((c) => (c.destination.lookupReadKeys = [key(0)])));
    bad(await mutate((c) => (c.destination.lookupReadKeys = [key(1.5)])));
    bad(await mutate((c) => (c.destination.lookupReadKeys = [key('1')])));
    bad(await mutate((c) => (c.destination.lookupReadKeys = [key(1, 'lower')])));
    bad(await mutate((c) => (c.destination.lookupReadKeys = [{ generation: 1 }])));
    bad(await mutate((c) => (c.destination.lookupReadKeys = [{ ...key(1), extra: 1 }])));
    bad(await mutate((c) => (c.destination.lookupReadKeys = 'x')));
    good(await mutate((c) => (c.destination.lookupReadKeys = [key(1)])));
  });
  it('validates artifacts', async () => {
    const a = (over: Record<string, unknown>) =>
      mutate((c) => Object.assign(c.destination.artifacts, over));
    const kms = (r: string, o: string) =>
      `arn:aws:kms:${r}:${o}:key/11111111-1111-4111-8111-111111111111`;
    for (const over of [
      { region: 'AP-northeast-1' },
      { region: 'ap-northeast-12' },
      { region: '1ap-northeast-1' },
      { region: 'ap-northeast' },
      { bucketOwner: '12345678901' },
      { bucketOwner: '1234567890123' },
      { bucketOwner: 'x123456789012' },
      { bucket: 'a' },
      { bucket: 'A-bucket' },
      { bucket: '-bucket' },
      { bucket: 'bucket-' },
      { bucket: 'a'.repeat(64) },
      { bucket: 'my..bucket' },
      { bucket: 'my.-bucket' },
      { bucket: 'my-.bucket' },
      { keyPrefix: '' },
      { keyPrefix: '/a' },
      { keyPrefix: 'a/' },
      { keyPrefix: 'a//b' },
      { keyPrefix: '-a' },
      { keyPrefix: 'a b' },
      { keyPrefix: 'a'.repeat(129) },
      { secretNamePrefix: '' },
      { secretNamePrefix: 'a/' },
      { secretNamePrefix: '_a' },
      { secretNamePrefix: 'a'.repeat(129) },
      { kmsKeyArn: kms('ap-northeast-1', '123456789012').replace('arn:aws:', 'arn:aws-cn:') },
      { kmsKeyArn: `${kms('ap-northeast-1', '123456789012')}x` },
      { kmsKeyArn: `x${kms('ap-northeast-1', '123456789012')}` },
      { kmsKeyArn: kms('us-east-1', '123456789012') },
      { kmsKeyArn: kms('ap-northeast-1', '999999999999') },
      { kmsKeyArn: kms('ap-northeast-1', '123456789012').replace('key/', 'alias/') },
      { extra: 1 },
    ])
      bad(await a(over));
    for (const over of [
      { bucket: 'ab1' },
      { bucket: 'a'.repeat(63) },
      { bucket: 'a.b-c.d' },
      { keyPrefix: 'a'.repeat(128) },
      { secretNamePrefix: 'a'.repeat(128) },
      { keyPrefix: 'a/b_c-d/e' },
      { region: 'us-gov-west-1', kmsKeyArn: kms('us-gov-west-1', '123456789012') },
    ])
      good(await a(over));
  });
  it('validates authState variants', async () => {
    bad(await mutate((c) => (c.destination.authState = { backend: 'postgresql', region: 'x' })));
    bad(await mutate((c) => (c.destination.authState = { backend: 'dynamodb' })));
    const table = 'arn:aws:dynamodb:ap-northeast-1:123456789012:table/authrim-state';
    const ok = await mutate(
      (c) =>
        (c.destination.authState = {
          backend: 'dynamodb',
          region: 'ap-northeast-1',
          tableArn: table,
        })
    );
    good(ok);
    expect(parseReplicationConfiguration(ok).destination.authState).toEqual({
      backend: 'dynamodb',
      region: 'ap-northeast-1',
      tableArn: table,
    });
    bad(
      await mutate(
        (c) =>
          (c.destination.authState = {
            backend: 'dynamodb',
            region: 'ap-northeast-1',
            tableArn: table.replace('123456789012', '999999999999'),
          })
      )
    );
    bad(
      await mutate(
        (c) =>
          (c.destination.authState = { backend: 'dynamodb', region: 'us-east-1', tableArn: table })
      )
    );
    bad(
      await mutate(
        (c) =>
          (c.destination.authState = {
            backend: 'dynamodb',
            region: 'ap-northeast-1',
            tableArn: table,
            extra: 1,
          })
      )
    );
  });
  it('validates schema file lists', async () => {
    const f = await fixture();
    const mk = (fn: (s: C) => void) => {
      const c: C = structuredClone(f.config);
      fn(c.destination.schemas);
      return c;
    };
    const file = (n: number, over: Record<string, unknown> = {}) => ({
      path: `/abs/f${n}.sql`,
      sha256: 'c'.repeat(64),
      ...over,
    });
    for (const key of ['core', 'pii', 'state'] as const) {
      bad(mk((s) => (s[key] = [])));
      bad(mk((s) => (s[key] = 'x')));
      bad(mk((s) => (s[key] = [file(1), file(1)])));
      bad(mk((s) => (s[key] = [file(1, { path: 'rel.sql' })])));
      bad(mk((s) => (s[key] = [file(1, { path: '/abs/f.txt' })])));
      bad(mk((s) => (s[key] = [file(1, { sha256: 'C'.repeat(64) })])));
      bad(mk((s) => (s[key] = [file(1, { sha256: 'c'.repeat(65) })])));
      bad(mk((s) => (s[key] = [file(1, { sha256: `x${'c'.repeat(64)}` })])));
      bad(mk((s) => (s[key] = [file(1, { sha256: `${'c'.repeat(64)}x` })])));
      bad(mk((s) => (s[key] = [file(1, { extra: 1 })])));
      bad(mk((s) => (s[key] = [{ path: '/abs/f.sql' }])));
      good(mk((s) => (s[key] = Array.from({ length: 1024 }, (_, i) => file(i)))));
      bad(mk((s) => (s[key] = Array.from({ length: 1025 }, (_, i) => file(i)))));
    }
    bad(mk((s) => (s.extra = [file(1)])));
    bad(mk((s) => delete s.state));
  });
  it('returns an independent deep copy', async () => {
    const f = await fixture();
    const parsed = parseReplicationConfiguration(f.config);
    expect(parsed).toEqual(f.config);
    expect(parsed).not.toBe(f.config);
    expect(parsed.destination).not.toBe(f.config.destination);
  });
});

describe('createReplicationPlan', () => {
  it('builds a plan from pinned local files with the authority schema digest', async () => {
    const f = await fixture();
    const plan = await createReplicationPlan(f.config, executor, 1234);
    expect(plan.formatVersion).toBe(1);
    expect(plan.createdAtMs).toBe(1234);
    expect(plan.executorSha256).toBe(executor);
    expect(plan.planId).toMatch(/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
    expect(plan.authoritySchemaSha256).toBe((await readReplicationAuthoritySchema()).digest);
    expect(plan.configuration).toEqual(f.config);
    const other = await createReplicationPlan(f.config, executor, 1234);
    expect(other.planId).not.toBe(plan.planId);
  });
  it('defaults createdAtMs to the current time', async () => {
    const f = await fixture();
    const before = Date.now();
    const plan = await createReplicationPlan(f.config, executor);
    expect(plan.createdAtMs).toBeGreaterThanOrEqual(before);
    expect(plan.createdAtMs).toBeLessThanOrEqual(Date.now());
  });
  it('validates the clock and executor digest', async () => {
    const f = await fixture();
    for (const now of [0, -1, 1.5, Number.NaN]) {
      await expect(createReplicationPlan(f.config, executor, now)).rejects.toThrow(
        'replication_plan_invalid'
      );
    }
    await expect(createReplicationPlan(f.config, executor, 1)).resolves.toBeTruthy();
    for (const sha of [
      '',
      'A'.repeat(64),
      'a'.repeat(63),
      'a'.repeat(65),
      `x${executor}`,
      `${executor}x`,
    ]) {
      await expect(createReplicationPlan(f.config, sha, 1000)).rejects.toThrow(
        'replication_plan_invalid'
      );
    }
  });
  it('rejects schema files whose digest differs from the pin', async () => {
    const f = await fixture();
    const c: C = structuredClone(f.config);
    c.destination.schemas.pii = [{ path: f.schemaPath, sha256: 'd'.repeat(64) }];
    await expect(createReplicationPlan(c, executor, 1000)).rejects.toThrow();
  });
  it('pins the standby state file when a failover approval is present', async () => {
    const f = await fixture();
    const standby = join(f.directory, 'standby.json');
    const body = '{"a":1}';
    await writeFile(standby, body, { mode: 0o600 });
    const approval = {
      standbyStatePath: standby,
      standbyStateSha256: createHash('sha256').update(body).digest('hex'),
      maximumSnapshotAgeMs: 60_000,
    };
    const ok = await createReplicationPlan({ ...f.config, failover: approval }, executor, 1000);
    expect(ok.configuration.failover).toEqual(approval);
    await expect(
      createReplicationPlan(
        { ...f.config, failover: { ...approval, standbyStateSha256: 'e'.repeat(64) } },
        executor,
        1000
      )
    ).rejects.toThrow();
  });
  it('allows a failover state file of up to 8 MiB but not larger', async () => {
    const f = await fixture();
    const standby = join(f.directory, 'standby.json');
    const big = Buffer.alloc(8 * 1024 * 1024, 0x20);
    await writeFile(standby, big, { mode: 0o600 });
    const approval = {
      standbyStatePath: standby,
      standbyStateSha256: createHash('sha256').update(big).digest('hex'),
      maximumSnapshotAgeMs: 60_000,
    };
    await expect(
      createReplicationPlan({ ...f.config, failover: approval }, executor, 1000)
    ).resolves.toBeTruthy();
    const bigger = Buffer.alloc(8 * 1024 * 1024 + 1, 0x20);
    await writeFile(standby, bigger, { mode: 0o600 });
    await expect(
      createReplicationPlan(
        {
          ...f.config,
          failover: {
            ...approval,
            standbyStateSha256: createHash('sha256').update(bigger).digest('hex'),
          },
        },
        executor,
        1000
      )
    ).rejects.toThrow();
  });
});

describe('parseReplicationPlan', () => {
  async function planRaw(over: (p: C) => void = () => {}) {
    const f = await fixture();
    const plan: C = await createReplicationPlan(f.config, executor, 1000);
    over(plan);
    return { plan, raw: canonicalRestoreJson(plan), f };
  }
  it('round-trips and digests', async () => {
    const { plan, raw } = await planRaw();
    expect(parseReplicationPlan(raw, executor)).toEqual(plan);
    expect(parseReplicationPlan(raw)).toEqual(plan);
    expect(replicationPlanDigest(plan)).toMatch(/^[a-f0-9]{64}$/u);
  });
  it('rejects invalid shapes, ids and digests', async () => {
    const cases: Array<(p: C) => void> = [
      (p) => (p.formatVersion = 2),
      (p) => (p.planId = 'not-a-uuid'),
      (p) => (p.planId = `x${p.planId}`),
      (p) => (p.planId = `${p.planId}x`),
      (p) => (p.planId = p.planId.toUpperCase()),
      (p) => (p.createdAtMs = 0),
      (p) => (p.createdAtMs = 1.5),
      (p) => (p.createdAtMs = '1'),
      (p) => (p.executorSha256 = 'A'.repeat(64)),
      (p) => (p.executorSha256 = `${'a'.repeat(64)}x`),
      (p) => (p.executorSha256 = `x${'a'.repeat(64)}`),
      (p) => (p.authoritySchemaSha256 = 'A'.repeat(64)),
      (p) => (p.authoritySchemaSha256 = `${'a'.repeat(64)}x`),
      (p) => (p.authoritySchemaSha256 = `x${'a'.repeat(64)}`),
      (p) => (p.extra = 1),
      (p) => delete p.planId,
      (p) => (p.configuration.expectedEpoch = 0),
    ];
    for (const fn of cases) {
      const { raw } = await planRaw(fn);
      expect(() => parseReplicationPlan(raw)).toThrow('replication_plan_invalid');
    }
  });
  it('requires the pinned executor digest', async () => {
    const { raw } = await planRaw();
    expect(() => parseReplicationPlan(raw, 'b'.repeat(64))).toThrow('replication_plan_invalid');
  });
  it('rejects non-canonical, non-JSON and non-object input', async () => {
    const { plan } = await planRaw();
    expect(() => parseReplicationPlan(JSON.stringify(plan, null, 2))).toThrow(
      'replication_plan_invalid'
    );
    expect(() => parseReplicationPlan(`${canonicalRestoreJson(plan)} `)).toThrow(
      'replication_plan_invalid'
    );
    expect(() => parseReplicationPlan('nope')).toThrow('replication_plan_invalid');
    expect(() => parseReplicationPlan('null')).toThrow('replication_plan_invalid');
    expect(() => parseReplicationPlan('[]')).toThrow('replication_plan_invalid');
  });
});

describe('replicationSecret', () => {
  it('returns present values and rejects missing/empty or malformed names', () => {
    expect(replicationSecret({ ABC: 'v' }, 'ABC')).toBe('v');
    expect(() => replicationSecret({}, 'ABC')).toThrow(
      new Error('replication_credentials_missing')
    );
    expect(() => replicationSecret({ ABC: '' }, 'ABC')).toThrow('replication_credentials_missing');
    expect(() => replicationSecret({ abc: 'v' }, 'abc')).toThrow('replication_plan_invalid');
    expect(() => replicationSecret({ A: 'v' }, '')).toThrow('replication_plan_invalid');
    expect(() => replicationSecret({ ['A'.repeat(129)]: 'v' }, 'A'.repeat(129))).toThrow(
      'replication_plan_invalid'
    );
    expect(replicationSecret({ ['A'.repeat(128)]: 'v' }, 'A'.repeat(128))).toBe('v');
  });
});
