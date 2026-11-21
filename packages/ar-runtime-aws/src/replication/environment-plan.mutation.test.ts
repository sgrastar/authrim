/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- mock call inspection */
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalRestoreJson, restoreEvidenceDigest } from '../import/restore-evidence';
import { environmentTestConfiguration } from './environment-test-fixture';
import {
  createEnvironmentReplicationPlan,
  environmentReplicationPlanDigest,
  parseEnvironmentReplicationConfiguration,
  parseEnvironmentReplicationPlan,
} from './environment-plan';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const EX = 'a'.repeat(64);
type C = any;

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'authrim-envplan-mut-'));
  folders.push(root);
  const path = join(root, 'schema.sql');
  const sql = 'CREATE TABLE synthetic (id TEXT PRIMARY KEY);';
  await writeFile(path, sql, { mode: 0o600 });
  const configuration: C = environmentTestConfiguration(
    path,
    createHash('sha256').update(sql).digest('hex')
  );
  configuration.inventory ??= {
    managementOrigin: 'https://management.example.test',
    grantId: 'grant-inv',
    credentialEnv: 'INVENTORY_TOKEN',
    ownerTenantId: 'tenant-a',
  };
  return { root, path, configuration };
}
const mutate = async (fn: (c: C, f: Awaited<ReturnType<typeof fixture>>) => void) => {
  const f = await fixture();
  const c: C = structuredClone(f.configuration);
  fn(c, f);
  return c;
};
const bad = (c: unknown) =>
  expect(() => parseEnvironmentReplicationConfiguration(c)).toThrow(
    'environment_replication_plan_invalid'
  );
const good = (c: unknown) =>
  expect(() => parseEnvironmentReplicationConfiguration(c)).not.toThrow();

describe('environment configuration', () => {
  it('accepts the base fixture and returns a deep copy', async () => {
    const f = await fixture();
    const out = parseEnvironmentReplicationConfiguration(f.configuration);
    expect(out).toEqual(f.configuration);
    expect(out).not.toBe(f.configuration);
    expect(out.tenants[0]).not.toBe(f.configuration.tenants[0]);
  });
  it('rejects non-objects, unknown keys, wrong format and missing keys', async () => {
    bad(null);
    bad(undefined);
    bad([]);
    bad('x');
    bad(await mutate((c) => (c.formatVersion = 1)));
    bad(await mutate((c) => (c.extra = 1)));
    bad(await mutate((c) => delete c.inventory));
    bad(await mutate((c) => delete c.maxSnapshotAgeMs));
  });
  it('treats an explicitly undefined failover key as optional-but-present (no failover)', async () => {
    good(await mutate((c) => (c.failover = undefined)));
  });
  it('validates the pair', async () => {
    bad(await mutate((c) => (c.pair.extra = 1)));
    bad(await mutate((c) => delete c.pair.pairId));
    bad(await mutate((c) => (c.pair.environmentId = 'bad id')));
    bad(await mutate((c) => (c.pair.environmentId = '')));
    bad(await mutate((c) => (c.pair.deployments = [])));
    bad(await mutate((c) => (c.pair.initialOwnerDeploymentId = 'unknown')));
    bad(await mutate((c) => (c.pair.tenantId = 'tenant-a')));
  });
  describe('inventory', () => {
    it('requires exact keys', async () => {
      bad(await mutate((c) => (c.inventory.extra = 1)));
      bad(await mutate((c) => delete c.inventory.ownerTenantId));
    });
    it('requires an https origin without path, credentials or trailing slash', async () => {
      for (const v of [
        'http://management.example.test',
        'https://management.example.test/',
        'https://management.example.test/x',
        'https://user@management.example.test',
        'not a url',
      ])
        bad(await mutate((c) => (c.inventory.managementOrigin = v)));
      good(
        await mutate((c) => (c.inventory.managementOrigin = 'https://management.example.test:8443'))
      );
    });
    it('validates identifiers and credential env name', async () => {
      bad(await mutate((c) => (c.inventory.grantId = 'bad id')));
      bad(await mutate((c) => (c.inventory.ownerTenantId = 'bad id')));
      for (const v of ['lower', '1ABC', 'A-B', '', 'A'.repeat(129), 'ABC\n'])
        bad(await mutate((c) => (c.inventory.credentialEnv = v)));
      good(await mutate((c) => (c.inventory.credentialEnv = 'A'.repeat(128))));
      good(await mutate((c) => (c.inventory.credentialEnv = 'A_1')));
    });
  });
  describe('tenants', () => {
    const t = (c: C, i: number) => c.tenants[i];
    it('requires a non-empty array of at most 16', async () => {
      bad(await mutate((c) => (c.tenants = [])));
      bad(await mutate((c) => (c.tenants = 'x')));
      good(await mutate((c) => (c.tenants = [t(c, 0)])));
      const many = (c: C, n: number) =>
        Array.from({ length: n }, (_, i) => {
          const child = structuredClone(t(c, 0));
          const id = `tenant-${String(i).padStart(2, '0')}`;
          child.pair.tenantId = id;
          child.source.identity.tenantId = id;
          child.source.identity.issuer = `https://${id}.example.test`;
          child.source.grantId = `grant-${id}`;
          child.source.credentialEnv = `EXPORT_${i}`;
          return child;
        });
      good(await mutate((c) => (c.tenants = many(c, 16))));
      bad(await mutate((c) => (c.tenants = many(c, 17))));
    });
    it('rejects invalid child configuration', async () => {
      bad(await mutate((c) => (t(c, 0).expectedEpoch = 0)));
    });
    it('rejects duplicate tenant ids and duplicate issuers', async () => {
      bad(await mutate((c) => (c.tenants = [t(c, 0), t(c, 0)])));
      bad(
        await mutate((c) => {
          t(c, 1).source.identity.issuer = t(c, 0).source.identity.issuer;
        })
      );
    });
    it('rejects children carrying their own failover approval', async () => {
      bad(
        await mutate((c) => {
          t(c, 0).failover = {
            standbyStatePath: '/abs/s.json',
            standbyStateSha256: 'b'.repeat(64),
            maximumSnapshotAgeMs: 60_000,
          };
        })
      );
    });
    it('requires children to match the environment pair, deployments, epoch, age and authority', async () => {
      bad(await mutate((c) => (t(c, 1).pair.initialGenerationId = 'other')));
      bad(await mutate((c) => (t(c, 1).pair.pairId = 'other')));
      bad(await mutate((c) => (t(c, 1).pair.initialOwnerDeploymentId = 'aws-a')));
      bad(await mutate((c) => (t(c, 1).sourceDeploymentId = 'aws-a')));
      bad(await mutate((c) => (t(c, 1).destinationDeploymentId = 'cf-a')));
      bad(await mutate((c) => (t(c, 1).expectedEpoch = c.expectedEpoch + 1)));
      bad(await mutate((c) => (t(c, 1).maxSnapshotAgeMs = c.maxSnapshotAgeMs + 1)));
      bad(await mutate((c) => (t(c, 1).authority.credentialId = 'other-controller')));
      bad(await mutate((c) => (c.expectedEpoch = 2)));
      bad(await mutate((c) => (c.maxSnapshotAgeMs = 1000)));
      bad(await mutate((c) => (c.authority.credentialId = 'different')));
    });
    it('requires a single shared storage location and writer credential', async () => {
      const bumps: Array<(c: C) => void> = [
        (c) => (t(c, 1).destination.artifacts.bucket = 'different-bucket'),
        (c) => {
          t(c, 1).destination.artifacts.region = 'us-east-1';
          t(c, 1).destination.artifacts.kmsKeyArn = t(c, 1).destination.artifacts.kmsKeyArn.replace(
            'ap-northeast-1',
            'us-east-1'
          );
        },
        (c) => {
          t(c, 1).destination.artifacts.bucketOwner = '999999999999';
          t(c, 1).destination.artifacts.kmsKeyArn = t(c, 1).destination.artifacts.kmsKeyArn.replace(
            '123456789012',
            '999999999999'
          );
        },
        (c) =>
          (t(c, 1).destination.artifacts.kmsKeyArn =
            'arn:aws:kms:ap-northeast-1:123456789012:key/22222222-2222-4222-8222-222222222222'),
        (c) => (t(c, 1).destination.masterUrlEnv = 'OTHER_MASTER'),
        (c) => (t(c, 1).destination.writerCredentialId = 'other-writer'),
        (c) => (t(c, 1).destination.writerSecretEnv = 'OTHER_WRITER_SECRET'),
      ];
      for (const fn of bumps) bad(await mutate(fn));
    });
  });
  describe('failover approval', () => {
    const approval = (over: Record<string, unknown> = {}) => ({
      standbyStatePath: '/abs/standby.json',
      standbyStateSha256: 'b'.repeat(64),
      maximumSnapshotAgeMs: 60_000,
      ...over,
    });
    it('accepts a normalized absolute approval', async () => {
      const c = await mutate((c) => (c.failover = approval()));
      expect(parseEnvironmentReplicationConfiguration(c).failover).toEqual(approval());
    });
    it('rejects malformed approvals', async () => {
      for (const over of [
        { standbyStatePath: 'relative.json' },
        { standbyStatePath: '/abs/../standby.json' },
        { standbyStatePath: '/abs//standby.json' },
        { standbyStatePath: '/abs/standby.json/' },
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
      bad(
        await mutate(
          (c) =>
            (c.failover = {
              standbyStatePath: '/abs/standby.json',
              standbyStateSha256: 'b'.repeat(64),
            })
        )
      );
    });
    it('accepts boundary ages 1000 ms and 30 days', async () => {
      for (const ms of [1000, 30 * 86_400_000])
        good(await mutate((c) => (c.failover = approval({ maximumSnapshotAgeMs: ms }))));
    });
  });
  it('requires tenants to be sorted by tenant id', async () => {
    bad(
      await mutate((c) => {
        c.tenants = [c.tenants[1], c.tenants[0]];
      })
    );
  });
});

describe('createEnvironmentReplicationPlan', () => {
  it('builds a plan with a shared authority schema digest', async () => {
    const f = await fixture();
    const plan = await createEnvironmentReplicationPlan(f.configuration, EX, 1234);
    expect(plan.formatVersion).toBe(2);
    expect(plan.createdAtMs).toBe(1234);
    expect(plan.executorSha256).toBe(EX);
    expect(plan.planId).toMatch(/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
    expect(plan.authoritySchemaSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(plan.configuration).toEqual(f.configuration);
    const again = await createEnvironmentReplicationPlan(f.configuration, EX, 1234);
    expect(again.planId).not.toBe(plan.planId);
  });
  it('defaults the clock to now', async () => {
    const f = await fixture();
    const before = Date.now();
    const plan = await createEnvironmentReplicationPlan(f.configuration, EX);
    expect(plan.createdAtMs).toBeGreaterThanOrEqual(before);
  });
  it('validates executor digest and clock (negative and non-integer rejected)', async () => {
    const f = await fixture();
    // The boundary value 0 is deliberately not pinned: the environment validator accepts
    // it (environment-plan.ts:183, :202 use `< 0`) while the child plan requires >= 1
    // (plan.ts:378), so the contract is currently inconsistent.
    await expect(createEnvironmentReplicationPlan(f.configuration, EX, 1)).resolves.toBeTruthy();
    for (const now of [-1, 1.5, Number.NaN]) {
      await expect(createEnvironmentReplicationPlan(f.configuration, EX, now)).rejects.toThrow(
        'environment_replication_plan_invalid'
      );
    }
    for (const sha of ['', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `x${EX}`, `${EX}x`]) {
      await expect(createEnvironmentReplicationPlan(f.configuration, sha, 1000)).rejects.toThrow(
        'environment_replication_plan_invalid'
      );
    }
  });
  it('rejects invalid configurations and unpinned SQL files', async () => {
    const f = await fixture();
    await expect(createEnvironmentReplicationPlan({ formatVersion: 2 }, EX, 1000)).rejects.toThrow(
      'environment_replication_plan_invalid'
    );
    const c: C = structuredClone(f.configuration);
    c.tenants[0].destination.schemas.core = [{ path: f.path, sha256: 'd'.repeat(64) }];
    await expect(createEnvironmentReplicationPlan(c, EX, 1000)).rejects.toThrow();
  });
});

describe('parseEnvironmentReplicationPlan', () => {
  async function raw(over: (p: C) => void = () => {}) {
    const f = await fixture();
    const plan: C = await createEnvironmentReplicationPlan(f.configuration, EX, 1000);
    over(plan);
    return { plan, raw: canonicalRestoreJson(plan) };
  }
  const invalid = 'environment_replication_plan_invalid';
  it('round-trips with and without a pinned executor', async () => {
    const { plan, raw: text } = await raw();
    expect(parseEnvironmentReplicationPlan(text, EX)).toEqual(plan);
    expect(parseEnvironmentReplicationPlan(text)).toEqual(plan);
  });
  it('rejects invalid fields', async () => {
    const cases: Array<(p: C) => void> = [
      (p) => (p.formatVersion = 1),
      (p) => (p.planId = 'nope'),
      (p) => (p.planId = `x${p.planId}`),
      (p) => (p.planId = `${p.planId}x`),
      (p) => (p.planId = p.planId.toUpperCase()),
      (p) => (p.createdAtMs = -1),
      (p) => (p.createdAtMs = 1.5),
      (p) => (p.createdAtMs = '1'),
      (p) => (p.executorSha256 = 'A'.repeat(64)),
      (p) => (p.executorSha256 = `x${EX}`),
      (p) => (p.executorSha256 = `${EX}x`),
      (p) => (p.authoritySchemaSha256 = 'A'.repeat(64)),
      (p) => (p.authoritySchemaSha256 = `x${EX}`),
      (p) => (p.authoritySchemaSha256 = `${EX}x`),
      (p) => (p.extra = 1),
      (p) => delete p.configuration,
      (p) => (p.configuration.expectedEpoch = 0),
    ];
    for (const fn of cases) {
      const { raw: text } = await raw(fn);
      expect(() => parseEnvironmentReplicationPlan(text)).toThrow(invalid);
    }
  });
  it('requires the expected executor digest', async () => {
    const { raw: text } = await raw();
    expect(() => parseEnvironmentReplicationPlan(text, 'b'.repeat(64))).toThrow(invalid);
  });
  it('requires canonical form and valid JSON objects', async () => {
    const { plan } = await raw();
    expect(() => parseEnvironmentReplicationPlan(JSON.stringify(plan, null, 2))).toThrow(invalid);
    expect(() => parseEnvironmentReplicationPlan(`${canonicalRestoreJson(plan)}\n`)).toThrow(
      invalid
    );
    expect(() => parseEnvironmentReplicationPlan('nope')).toThrow(invalid);
    expect(() => parseEnvironmentReplicationPlan('null')).toThrow(invalid);
    expect(() => parseEnvironmentReplicationPlan('[]')).toThrow(invalid);
  });
});

describe('environmentReplicationPlanDigest', () => {
  it('is the evidence digest of the full plan', async () => {
    const f = await fixture();
    const plan = await createEnvironmentReplicationPlan(f.configuration, EX, 1000);
    const digest = environmentReplicationPlanDigest(plan);
    expect(digest).toBe(restoreEvidenceDigest(plan));
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(environmentReplicationPlanDigest({ ...plan, createdAtMs: 1001 })).not.toBe(digest);
  });
});
