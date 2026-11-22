/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion -- fakes and deliberately malformed inputs are intentionally untyped */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TenantBundleManifest } from '@authrim/ar-lib-core/services/tenant-portability/bundle-manifest';
import type { PostgresQueryClient } from '../storage/postgres-transient-state';
import {
  assertAwsLiveStateCompatible,
  assertVerifiedAwsStateRestored,
  assertVerifiedAwsStateSource,
  awsStateSupplementPayloadSha256,
  restoreVerifiedAwsState,
  type AwsStateReadbackInput,
  type AwsStateSourceExpectations,
  type VerifiedAwsStateSupplement,
} from './state-restore';

const INVALID = 'aws_state_restore_invalid';
const TENANT = 'tenant-a';
const NOW = 1_700_000_000_000;
const SP = 'https://sp.example.test';
const ACCOUNTS = 'authrim_aws_account_auth_state';
const COUNTERS = 'authrim_aws_passkey_counters';
const NAMEIDS = 'authrim_aws_saml_persistent_nameids';

const manifest: TenantBundleManifest = {
  formatVersion: 1,
  bundleId: 'a'.repeat(32),
  source: { tenantId: TENANT, issuer: 'https://tenant-a.example.test', productVersion: '0.4.2' },
  snapshotId: 'snapshot-a',
  boundaryUnixMs: NOW,
  inventoryDigestSha256: 'b'.repeat(64),
  selection: {
    settings: true,
    users: true,
    admin: false,
    artifacts: false,
    logs: { audit: false, other: false, sensitive: false, period: 7 },
  },
  datasets: [],
};

const pad = (i: number) => String(i).padStart(4, '0');
const nameIdKey = (i: number) =>
  `saml:persistent-nameid:tenant:${TENANT}:sp:${encodeURIComponent(SP)}:subject:user-${pad(i)}`;

function fixture(n = 2): {
  supplement: VerifiedAwsStateSupplement;
  expected: AwsStateSourceExpectations;
} {
  const ids = Array.from({ length: n }, (_v, i) => i + 1);
  const supplement: VerifiedAwsStateSupplement = {
    receipt: {
      tenantId: TENANT,
      issuer: manifest.source.issuer,
      productVersion: manifest.source.productVersion,
      bundleId: manifest.bundleId,
      snapshotId: manifest.snapshotId,
      inventoryDigestSha256: manifest.inventoryDigestSha256,
      supplementSha256: '',
    },
    accountAuthStates: ids.map((i) => ({
      tenantId: TENANT,
      userId: `user-${pad(i)}`,
      accountId: `account:user-${pad(i)}`,
      lifecycle: 'active',
      lifecycleVersionMs: NOW - 2000 - i,
      lifecycleOperationId: i === 1 ? 'op-1' : null,
      revokedAfterMs: i === 1 ? NOW - 500 : null,
      lastLoginAtMs: i === 1 ? NOW - 1000 : null,
    })),
    passkeyCounters: ids.map((i) => ({
      tenantId: TENANT,
      passkeyId: `passkey-${pad(i)}`,
      userId: `user-${pad(i)}`,
      credentialId: `cred-${pad(i)}`,
      counter: String(5 + i),
      updatedAtMs: NOW - 1000 - i,
    })),
    persistentNameIdsComplete: true,
    persistentNameIds: ids.map((i) => ({
      tenantId: TENANT,
      registryKey: nameIdKey(i),
      valueJson: JSON.stringify({
        version: 1,
        tenantId: TENANT,
        spEntityId: SP,
        subjectId: `user-${pad(i)}`,
        nameId: `pairwise-${i}`,
        createdAt: NOW - 3000 - i,
      }),
      createdAtMs: NOW - 3000 - i,
    })),
  };
  supplement.receipt.supplementSha256 = awsStateSupplementPayloadSha256(supplement);
  const expected: AwsStateSourceExpectations = {
    users: ids.map((i) => ({ userId: `user-${pad(i)}` })),
    accounts: ids.map((i) => ({
      accountId: `account:user-${pad(i)}`,
      userId: `user-${pad(i)}`,
      lifecycle: 'active' as const,
    })),
    passkeys: ids.map((i) => ({
      passkeyId: `passkey-${pad(i)}`,
      userId: `user-${pad(i)}`,
      credentialId: `cred-${pad(i)}`,
      sourceCounter: String(5 + i),
    })),
  };
  return { supplement, expected };
}
const repin = (s: VerifiedAwsStateSupplement) => {
  s.receipt.supplementSha256 = awsStateSupplementPayloadSha256(s);
  return s;
};

type Row = Record<string, unknown>;

/** In-memory fake that understands exactly the statements the restore module issues. */
class FakeDb {
  log: Array<{ sql: string; values: unknown[] }> = [];
  accounts = new Map<string, Row>();
  counters = new Map<string, Row>();
  nameids = new Map<string, Row>();
  /** Alters the response of a statement; receives the default rows. */
  respond: ((sql: string, values: unknown[], rows: Row[]) => Row[]) | null = null;
  failOn: ((sql: string) => boolean) | null = null;
  rollbackFails = false;

  readonly client: PostgresQueryClient = {
    query: async <R extends Record<string, unknown>>(sql: string, values: unknown[]) => {
      this.log.push({ sql, values });
      if (/^ROLLBACK/u.test(sql) && this.rollbackFails) throw new Error('rollback failed');
      if (this.failOn?.(sql)) throw new Error('db failure');
      const rows = this.run(sql, values);
      const out = this.respond ? this.respond(sql, values, rows) : rows;
      return { rows: out as R[], rowCount: out.length };
    },
  };
  statements = () => this.log.map((entry) => entry.sql.trim().split(/\s+/u).slice(0, 3).join(' '));
  private run(sql: string, values: unknown[]): Row[] {
    if (/^(BEGIN|COMMIT|ROLLBACK)/u.test(sql)) return [];
    if (sql.includes('pg_advisory_xact_lock')) return [];
    const exists = /SELECT EXISTS \(SELECT 1 FROM (\w+) WHERE tenant_id = \$1\)/u.exec(sql);
    if (exists) {
      const table = this.table(exists[1]);
      return [{ present: [...table.values()].some((row) => row.tenant_id === values[0]) }];
    }
    const count = /SELECT count\(\*\) AS count FROM (\w+) WHERE/u.exec(sql);
    if (count) {
      const table = this.table(count[1]);
      return [
        { count: String([...table.values()].filter((r) => r.tenant_id === values[0]).length) },
      ];
    }
    if (sql.includes(`INSERT INTO ${ACCOUNTS}`)) {
      const out: Row[] = [];
      for (let i = 0; i < values.length; i += 8) {
        const row = {
          tenant_id: values[i],
          user_id: values[i + 1],
          account_id: values[i + 2],
          lifecycle: values[i + 3],
          lifecycle_version_ms: values[i + 4],
          lifecycle_operation_id: values[i + 5],
          revoked_after_ms: values[i + 6],
          last_login_at_ms: values[i + 7],
        };
        const key = `${String(row.tenant_id)}|${String(row.user_id)}`;
        if (this.accounts.has(key)) throw new Error('duplicate');
        this.accounts.set(key, row);
        out.push(row);
      }
      return out;
    }
    if (sql.includes(`INSERT INTO ${COUNTERS}`)) {
      const out: Row[] = [];
      for (let i = 0; i < values.length; i += 5) {
        const row = {
          tenant_id: values[i],
          user_id: values[i + 1],
          credential_id: values[i + 2],
          counter: values[i + 3],
          updated_at_ms: values[i + 4],
        };
        const key = `${String(row.tenant_id)}|${String(row.credential_id)}`;
        if (this.counters.has(key)) throw new Error('duplicate');
        this.counters.set(key, row);
        out.push(row);
      }
      return out;
    }
    if (sql.includes(`INSERT INTO ${NAMEIDS}`)) {
      const key = `${String(values[0])}|${String(values[1])}`;
      if (this.nameids.has(key)) return [];
      this.nameids.set(key, {
        tenant_id: values[0],
        registry_key: values[1],
        value_json: values[2],
        created_at_ms: values[3],
      });
      return [{ registry_key: values[1] }];
    }
    if (sql.includes('SELECT value_json FROM')) {
      const row = this.nameids.get(`${String(values[0])}|${String(values[1])}`);
      return row ? [{ value_json: row.value_json }] : [];
    }
    if (sql.includes(`FROM ${ACCOUNTS}`)) {
      const wanted = values[1] as string[];
      return [...this.accounts.values()].filter(
        (r) => r.tenant_id === values[0] && wanted.includes(r.user_id as string)
      );
    }
    if (sql.includes(`FROM ${COUNTERS}`)) {
      const wanted = values[1] as string[];
      return [...this.counters.values()].filter(
        (r) => r.tenant_id === values[0] && wanted.includes(r.credential_id as string)
      );
    }
    if (sql.includes(`FROM ${NAMEIDS}`) && sql.includes('ANY($2::text[])')) {
      const wanted = values[1] as string[];
      return [...this.nameids.values()].filter(
        (r) => r.tenant_id === values[0] && wanted.includes(r.registry_key as string)
      );
    }
    if (sql.includes(`FROM ${NAMEIDS}`) && sql.includes('registry_key > $2')) {
      return [...this.nameids.values()]
        .filter(
          (r) => r.tenant_id === values[0] && (r.registry_key as string) > (values[1] as string)
        )
        .sort((a, b) => ((a.registry_key as string) < (b.registry_key as string) ? -1 : 1))
        .slice(0, values[2] as number);
    }
    throw new Error(`unhandled sql: ${sql}`);
  }
  private table(name: string): Map<string, Row> {
    if (name === ACCOUNTS) return this.accounts;
    if (name === COUNTERS) return this.counters;
    if (name === NAMEIDS) return this.nameids;
    throw new Error(`unknown table ${name}`);
  }
}

function connection(db: FakeDb) {
  return {
    opened: 0,
    async withDedicatedConnection<T>(run: (client: PostgresQueryClient) => Promise<T>): Promise<T> {
      this.opened += 1;
      return run(db.client);
    },
  };
}

async function restored(n = 2) {
  const { supplement, expected } = fixture(n);
  const db = new FakeDb();
  const conn = connection(db);
  const receipt = await restoreVerifiedAwsState({
    manifest,
    supplement,
    expected,
    connection: conn,
  });
  const readback = (): AwsStateReadbackInput => ({
    manifest,
    supplement,
    expected,
    receipt,
    connection: conn,
  });
  return { supplement, expected, db, conn, receipt, readback };
}

const validate = (s: VerifiedAwsStateSupplement, e: AwsStateSourceExpectations, m = manifest) =>
  assertVerifiedAwsStateSource({ manifest: m, supplement: s, expected: e });

describe('supplement digest', () => {
  it('hashes a canonical, sorted payload independent of input order', () => {
    const { supplement } = fixture(3);
    // Fixed canonical form (key order, field order, no whitespace) and its SHA-256, hard-coded
    // rather than re-derived from the implementation's field list.
    const canonical =
      '{"accountAuthStates":[{"tenantId":"tenant-a","userId":"user-0001","accountId":"account:user-0001","lifecycle":"active","lifecycleVersionMs":1699999997999,"lifecycleOperationId":"op-1","revokedAfterMs":1699999999500,"lastLoginAtMs":1699999999000},{"tenantId":"tenant-a","userId":"user-0002","accountId":"account:user-0002","lifecycle":"active","lifecycleVersionMs":1699999997998,"lifecycleOperationId":null,"revokedAfterMs":null,"lastLoginAtMs":null},{"tenantId":"tenant-a","userId":"user-0003","accountId":"account:user-0003","lifecycle":"active","lifecycleVersionMs":1699999997997,"lifecycleOperationId":null,"revokedAfterMs":null,"lastLoginAtMs":null}],"passkeyCounters":[{"tenantId":"tenant-a","passkeyId":"passkey-0001","userId":"user-0001","credentialId":"cred-0001","counter":"6","updatedAtMs":1699999998999},{"tenantId":"tenant-a","passkeyId":"passkey-0002","userId":"user-0002","credentialId":"cred-0002","counter":"7","updatedAtMs":1699999998998},{"tenantId":"tenant-a","passkeyId":"passkey-0003","userId":"user-0003","credentialId":"cred-0003","counter":"8","updatedAtMs":1699999998997}],"persistentNameIdsComplete":true,"persistentNameIds":[{"tenantId":"tenant-a","registryKey":"saml:persistent-nameid:tenant:tenant-a:sp:https%3A%2F%2Fsp.example.test:subject:user-0001","valueJson":"{\\"version\\":1,\\"tenantId\\":\\"tenant-a\\",\\"spEntityId\\":\\"https://sp.example.test\\",\\"subjectId\\":\\"user-0001\\",\\"nameId\\":\\"pairwise-1\\",\\"createdAt\\":1699999996999}","createdAtMs":1699999996999},{"tenantId":"tenant-a","registryKey":"saml:persistent-nameid:tenant:tenant-a:sp:https%3A%2F%2Fsp.example.test:subject:user-0002","valueJson":"{\\"version\\":1,\\"tenantId\\":\\"tenant-a\\",\\"spEntityId\\":\\"https://sp.example.test\\",\\"subjectId\\":\\"user-0002\\",\\"nameId\\":\\"pairwise-2\\",\\"createdAt\\":1699999996998}","createdAtMs":1699999996998},{"tenantId":"tenant-a","registryKey":"saml:persistent-nameid:tenant:tenant-a:sp:https%3A%2F%2Fsp.example.test:subject:user-0003","valueJson":"{\\"version\\":1,\\"tenantId\\":\\"tenant-a\\",\\"spEntityId\\":\\"https://sp.example.test\\",\\"subjectId\\":\\"user-0003\\",\\"nameId\\":\\"pairwise-3\\",\\"createdAt\\":1699999996997}","createdAtMs":1699999996997}]}';
    const expected = '18b9c70b77ee55b17e9acbd685c4e9b3ba21193b354145c0395a1825f1e9094f';
    expect(createHash('sha256').update(canonical).digest('hex')).toBe(expected);
    expect(awsStateSupplementPayloadSha256(supplement)).toBe(expected);
    const reversed: VerifiedAwsStateSupplement = {
      ...supplement,
      accountAuthStates: [...supplement.accountAuthStates].reverse(),
      passkeyCounters: [...supplement.passkeyCounters].reverse(),
      persistentNameIds: [...supplement.persistentNameIds].reverse(),
    };
    expect(awsStateSupplementPayloadSha256(reversed)).toBe(expected);
    const shuffled: VerifiedAwsStateSupplement = {
      ...supplement,
      accountAuthStates: [
        supplement.accountAuthStates[1],
        supplement.accountAuthStates[2],
        supplement.accountAuthStates[0],
      ],
      passkeyCounters: [
        supplement.passkeyCounters[2],
        supplement.passkeyCounters[0],
        supplement.passkeyCounters[1],
      ],
      persistentNameIds: [
        supplement.persistentNameIds[1],
        supplement.persistentNameIds[2],
        supplement.persistentNameIds[0],
      ],
    };
    expect(awsStateSupplementPayloadSha256(shuffled)).toBe(expected);
  });
});

describe('assertVerifiedAwsStateSource', () => {
  it('accepts a consistent source and does not mutate its inputs', () => {
    const { supplement, expected } = fixture(3);
    const before = JSON.stringify({ supplement, expected, manifest });
    expect(() => validate(supplement, expected)).not.toThrow();
    expect(JSON.stringify({ supplement, expected, manifest })).toBe(before);
  });

  type Case = [
    string,
    (s: VerifiedAwsStateSupplement, e: AwsStateSourceExpectations) => void,
    boolean?,
  ];
  const cases: Case[] = [
    ['receipt tenant mismatch', (s) => (s.receipt.tenantId = 'tenant-b')],
    ['receipt issuer mismatch', (s) => (s.receipt.issuer = 'https://x.example.test')],
    ['receipt product mismatch', (s) => (s.receipt.productVersion = '9')],
    ['receipt bundle mismatch', (s) => (s.receipt.bundleId = 'c'.repeat(32))],
    ['receipt snapshot mismatch', (s) => (s.receipt.snapshotId = 'x')],
    ['receipt inventory mismatch', (s) => (s.receipt.inventoryDigestSha256 = 'c'.repeat(64))],
    ['bad supplement sha format', (s) => (s.receipt.supplementSha256 = 'Z'.repeat(64))],
    ['wrong supplement sha', (s) => (s.receipt.supplementSha256 = 'c'.repeat(64))],
    ['accounts not array', (s) => ((s as any).accountAuthStates = {})],
    ['counters not array', (s) => ((s as any).passkeyCounters = {})],
    ['nameids not array', (s) => ((s as any).persistentNameIds = {})],
    ['nameids incomplete', (s) => ((s as any).persistentNameIdsComplete = false)],
    ['expected users not array', (_s, e) => ((e as any).users = {})],
    ['expected accounts not array', (_s, e) => ((e as any).accounts = {})],
    ['expected passkeys not array', (_s, e) => ((e as any).passkeys = {})],
    ['duplicate expected user', (_s, e) => (e.users as any[]).push({ userId: 'user-0001' })],
    ['invalid expected user id', (_s, e) => ((e.users as any[])[0].userId = '.bad')],
    ['expected user id 257 chars', (_s, e) => ((e.users as any[])[0].userId = 'a'.repeat(257))],
    [
      'account id not derived from user',
      (_s, e) => ((e.accounts as any[])[0].accountId = 'account:other'),
    ],
    ['unknown lifecycle', (_s, e) => ((e.accounts as any[])[0].lifecycle = 'weird')],
    ['duplicate expected account', (_s, e) => (e.accounts as any[]).push({ ...e.accounts[0] })],
    [
      'account for unknown user',
      (_s, e) =>
        ((e.accounts as any[])[0] = {
          accountId: 'account:ghost',
          userId: 'ghost',
          lifecycle: 'active',
        }),
    ],
    ['user without account', (_s, e) => (e.users as any[]).push({ userId: 'extra' })],
    ['supplement missing account row', (s) => (s.accountAuthStates = s.accountAuthStates.slice(1))],
    ['account row extra key', (s) => ((s.accountAuthStates[0] as any).extra = 1), true],
    [
      'account row other tenant',
      (s) => ((s.accountAuthStates[0] as any).tenantId = 'tenant-b'),
      true,
    ],
    ['account row unknown user', (s) => ((s.accountAuthStates[0] as any).userId = 'ghost'), true],
    [
      'duplicate account row',
      (s) => ((s.accountAuthStates as unknown[])[1] = { ...s.accountAuthStates[0] }),
      true,
    ],
    ['account id mismatch', (s) => ((s.accountAuthStates[0] as any).accountId = 'account:x'), true],
    ['lifecycle mismatch', (s) => ((s.accountAuthStates[0] as any).lifecycle = 'locked'), true],
    [
      'lifecycleVersion zero',
      (s) => ((s.accountAuthStates[0] as any).lifecycleVersionMs = 0),
      true,
    ],
    [
      'lifecycleVersion fractional',
      (s) => ((s.accountAuthStates[0] as any).lifecycleVersionMs = 1.5),
      true,
    ],
    [
      'lifecycleVersion string',
      (s) => ((s.accountAuthStates[0] as any).lifecycleVersionMs = '5'),
      true,
    ],
    [
      'lifecycleVersion after boundary',
      (s) => ((s.accountAuthStates[0] as any).lifecycleVersionMs = NOW + 1),
      true,
    ],
    [
      'operation id empty',
      (s) => ((s.accountAuthStates[0] as any).lifecycleOperationId = ''),
      true,
    ],
    [
      'operation id too long',
      (s) => ((s.accountAuthStates[0] as any).lifecycleOperationId = 'a'.repeat(513)),
      true,
    ],
    [
      'operation id control char',
      (s) => ((s.accountAuthStates[0] as any).lifecycleOperationId = 'a\u001fb'),
      true,
    ],
    [
      'operation id DEL',
      (s) => ((s.accountAuthStates[0] as any).lifecycleOperationId = 'a\u007fb'),
      true,
    ],
    [
      'operation id number',
      (s) => ((s.accountAuthStates[0] as any).lifecycleOperationId = 5),
      true,
    ],
    ['revokedAfter negative', (s) => ((s.accountAuthStates[0] as any).revokedAfterMs = -1), true],
    [
      'revokedAfter after boundary',
      (s) => ((s.accountAuthStates[0] as any).revokedAfterMs = NOW + 1),
      true,
    ],
    [
      'revokedAfter undefined',
      (s) => ((s.accountAuthStates[0] as any).revokedAfterMs = undefined),
      true,
    ],
    ['lastLogin negative', (s) => ((s.accountAuthStates[0] as any).lastLoginAtMs = -1), true],
    [
      'lastLogin after boundary',
      (s) => ((s.accountAuthStates[0] as any).lastLoginAtMs = NOW + 1),
      true,
    ],
    ['lastLogin fractional', (s) => ((s.accountAuthStates[0] as any).lastLoginAtMs = 0.5), true],
    ['expected passkey bad id', (_s, e) => ((e.passkeys as any[])[0].passkeyId = 'a b')],
    ['expected passkey id empty', (_s, e) => ((e.passkeys as any[])[0].passkeyId = '')],
    ['expected passkey id 257', (_s, e) => ((e.passkeys as any[])[0].passkeyId = 'a'.repeat(257))],
    ['expected passkey bad user id', (_s, e) => ((e.passkeys as any[])[0].userId = '.x')],
    ['expected passkey bad credential', (_s, e) => ((e.passkeys as any[])[0].credentialId = 'a b')],
    ['expected passkey unknown user', (_s, e) => ((e.passkeys as any[])[0].userId = 'ghost')],
    [
      'duplicate expected passkey id',
      (_s, e) => ((e.passkeys as any[])[1].passkeyId = e.passkeys[0].passkeyId),
    ],
    [
      'duplicate expected credential',
      (_s, e) => ((e.passkeys as any[])[1].credentialId = e.passkeys[0].credentialId),
    ],
    ['source counter leading zero', (_s, e) => ((e.passkeys as any[])[0].sourceCounter = '05')],
    ['source counter not string', (_s, e) => ((e.passkeys as any[])[0].sourceCounter = 5)],
    [
      'source counter unsafe',
      (_s, e) => ((e.passkeys as any[])[0].sourceCounter = '9007199254740993'),
    ],
    ['source counter negative', (_s, e) => ((e.passkeys as any[])[0].sourceCounter = '-1')],
    ['missing counter row', (s) => (s.passkeyCounters = s.passkeyCounters.slice(1))],
    ['counter row extra key', (s) => ((s.passkeyCounters[0] as any).extra = 1), true],
    [
      'counter row other tenant',
      (s) => ((s.passkeyCounters[0] as any).tenantId = 'tenant-b'),
      true,
    ],
    [
      'counter row unknown passkey',
      (s) => ((s.passkeyCounters[0] as any).passkeyId = 'ghost'),
      true,
    ],
    [
      'counter row duplicate credential',
      (s) =>
        ((s.passkeyCounters as unknown[])[1] = {
          ...s.passkeyCounters[1],
          credentialId: s.passkeyCounters[0].credentialId,
        }),
      true,
    ],
    [
      'counter row user mismatch',
      (s) => ((s.passkeyCounters[0] as any).userId = 'user-0002'),
      true,
    ],
    [
      'counter row credential mismatch',
      (s) => ((s.passkeyCounters[0] as any).credentialId = 'cred-x'),
      true,
    ],
    ['counter updated zero', (s) => ((s.passkeyCounters[0] as any).updatedAtMs = 0), true],
    [
      'counter updated after boundary',
      (s) => ((s.passkeyCounters[0] as any).updatedAtMs = NOW + 1),
      true,
    ],
    ['counter rolled back', (s) => ((s.passkeyCounters[0] as any).counter = '5'), true],
    ['counter invalid decimal', (s) => ((s.passkeyCounters[0] as any).counter = '06'), true],
    ['nameid bad key', (s) => ((s.persistentNameIds[0] as any).registryKey = 'nope'), true],
    ['nameid bad value', (s) => ((s.persistentNameIds[0] as any).valueJson = '{}'), true],
    ['nameid extra key', (s) => ((s.persistentNameIds[0] as any).extra = 1), true],
    ['nameid other tenant', (s) => ((s.persistentNameIds[0] as any).tenantId = 'tenant-b'), true],
    [
      'nameid unknown subject',
      (_s, e) => {
        (e.users as any[])[1] = { userId: 'user-9999' };
        (e.accounts as any[])[1] = {
          accountId: 'account:user-9999',
          userId: 'user-9999',
          lifecycle: 'active',
        };
        (e.passkeys as any[])[1].userId = 'user-9999';
      },
    ],
    [
      'duplicate nameid',
      (s) => ((s.persistentNameIds as unknown[])[1] = { ...s.persistentNameIds[0] }),
      true,
    ],
    ['nameid created zero', (s) => ((s.persistentNameIds[0] as any).createdAtMs = 0), true],
    [
      'nameid created after boundary',
      (s) => {
        const row = s.persistentNameIds[0] as any;
        row.createdAtMs = NOW + 1;
        row.valueJson = JSON.stringify({ ...JSON.parse(row.valueJson), createdAt: NOW + 1 });
      },
      true,
    ],
    [
      'nameid created differs from record',
      (s) => ((s.persistentNameIds[0] as any).createdAtMs += 1),
      true,
    ],
  ];
  it.each(cases)('rejects %s', (_name, mutate, repinAfter) => {
    const { supplement, expected } = fixture(2);
    mutate(supplement, expected);
    if (repinAfter) repin(supplement);
    expect(() => validate(supplement, expected)).toThrow(new Error(INVALID));
  });

  it.each([
    ['upper-case tenant', 'Tenant-a'],
    ['leading dash', '-tenant'],
    ['trailing dash', 'tenant-'],
    ['underscore', 'tenant_a'],
  ])('rejects a %s manifest tenant', (_n, tenantId) => {
    const { supplement, expected } = fixture(2);
    supplement.receipt.tenantId = tenantId;
    expect(() =>
      validate(supplement, expected, { ...manifest, source: { ...manifest.source, tenantId } })
    ).toThrow(INVALID);
  });
  it('rejects a bundle id that is not 32 hex chars even when the manifest agrees', () => {
    const { supplement, expected } = fixture(2);
    supplement.receipt.bundleId = 'A'.repeat(32);
    expect(() => validate(supplement, expected, { ...manifest, bundleId: 'A'.repeat(32) })).toThrow(
      INVALID
    );
  });
  it('rejects an inventory digest that is not 64 hex chars even when the manifest agrees', () => {
    const { supplement, expected } = fixture(2);
    supplement.receipt.inventoryDigestSha256 = 'g'.repeat(64);
    expect(() =>
      validate(supplement, expected, { ...manifest, inventoryDigestSha256: 'g'.repeat(64) })
    ).toThrow(INVALID);
  });
  it('rejects a missing receipt', () => {
    const { supplement, expected } = fixture(2);
    delete (supplement as any).receipt;
    expect(() => validate(supplement, expected)).toThrow(INVALID);
  });

  it('accepts boundary values and permissive text', () => {
    const { supplement, expected } = fixture(2);
    const first = supplement.accountAuthStates[0] as any;
    first.lifecycleVersionMs = NOW;
    first.revokedAfterMs = 0;
    first.lastLoginAtMs = NOW;
    first.lifecycleOperationId = ` ${'é'.repeat(510)}~`;
    const second = supplement.accountAuthStates[1] as any;
    second.lifecycleVersionMs = 1;
    second.revokedAfterMs = NOW;
    second.lifecycleOperationId = 'a'.repeat(512);
    (supplement.passkeyCounters[0] as any).updatedAtMs = NOW;
    (supplement.passkeyCounters[0] as any).counter = '9007199254740991';
    (supplement.passkeyCounters[1] as any).counter = '100';
    (expected.users as any[])[0].userId = `a${'b'.repeat(255)}`;
    repin(supplement);
    // user id length change breaks cross references, so only validate the numeric boundaries here.
    (expected.users as any[])[0].userId = 'user-0001';
    expect(() => validate(supplement, expected)).not.toThrow();
  });
  it('accepts all lifecycle states and 256-character identifiers', () => {
    const { supplement, expected } = fixture(1);
    const id = `a${'b'.repeat(255)}`;
    (expected.users as any[])[0].userId = id;
    (expected.accounts as any[])[0] = {
      accountId: `account:${id}`,
      userId: id,
      lifecycle: 'deleting',
    };
    (expected.passkeys as any[])[0] = {
      passkeyId: 'p'.repeat(256),
      userId: id,
      credentialId: 'c'.repeat(256),
      sourceCounter: '0',
    };
    const account = supplement.accountAuthStates[0] as any;
    Object.assign(account, { userId: id, accountId: `account:${id}`, lifecycle: 'deleting' });
    Object.assign(supplement.passkeyCounters[0], {
      userId: id,
      passkeyId: 'p'.repeat(256),
      credentialId: 'c'.repeat(256),
      counter: '0',
    });
    supplement.persistentNameIds = [];
    repin(supplement);
    expect(() => validate(supplement, expected)).not.toThrow();
    for (const lifecycle of ['active', 'suspended', 'locked', 'deleting', 'deleted', 'inactive']) {
      account.lifecycle = lifecycle;
      (expected.accounts as any[])[0].lifecycle = lifecycle;
      repin(supplement);
      expect(() => validate(supplement, expected)).not.toThrow();
    }
  });
  it('rejects an empty expectation set paired with state rows', () => {
    const { supplement } = fixture(1);
    expect(() => validate(supplement, { users: [], accounts: [], passkeys: [] })).toThrow(INVALID);
  });
});

describe('restoreVerifiedAwsState', () => {
  it('writes every table in one serializable transaction and returns an exact receipt', async () => {
    const { supplement, db, receipt, conn } = await restored(2);
    expect(receipt).toEqual({
      tenantId: TENANT,
      source: manifest.source,
      bundleId: manifest.bundleId,
      snapshotId: manifest.snapshotId,
      inventoryDigestSha256: manifest.inventoryDigestSha256,
      supplementSha256: supplement.receipt.supplementSha256,
      accountAuthStates: 2,
      passkeyCounters: 2,
      persistentNameIds: 2,
    });
    expect(receipt.source).not.toBe(manifest.source);
    expect(conn.opened).toBe(1);
    expect(db.log[0].sql).toBe('BEGIN ISOLATION LEVEL SERIALIZABLE');
    expect(db.log[0].values).toEqual([]);
    expect(db.log[1].sql).toContain(
      `pg_advisory_xact_lock(hashtextextended('authrim_aws_state_restore:' || $1, 0))`
    );
    expect(db.log[1].values).toEqual([TENANT]);
    const exists = db.log.filter((e) => e.sql.includes('SELECT EXISTS'));
    expect(exists.map((e) => e.sql.match(/FROM (\w+) WHERE/u)![1])).toEqual([
      ACCOUNTS,
      COUNTERS,
      NAMEIDS,
    ]);
    expect(exists.every((e) => e.values.length === 1 && e.values[0] === TENANT)).toBe(true);
    const last = db.log[db.log.length - 1];
    expect(last).toEqual({ sql: 'COMMIT', values: [] });
    expect(db.statements().filter((s) => s.startsWith('ROLLBACK'))).toEqual([]);
    expect(db.accounts.size).toBe(2);
    expect(db.counters.size).toBe(2);
    expect(db.nameids.size).toBe(2);
    expect([...db.accounts.values()][0]).toEqual({
      tenant_id: TENANT,
      user_id: 'user-0001',
      account_id: 'account:user-0001',
      lifecycle: 'active',
      lifecycle_version_ms: NOW - 2001,
      lifecycle_operation_id: 'op-1',
      revoked_after_ms: NOW - 500,
      last_login_at_ms: NOW - 1000,
    });
    expect([...db.counters.values()][1]).toEqual({
      tenant_id: TENANT,
      user_id: 'user-0002',
      credential_id: 'passkey-0002',
      counter: '7',
      updated_at_ms: NOW - 1002,
    });
  });

  it('inserts in pages of 200 rows', async () => {
    const { db } = await restored(201);
    const accountInserts = db.log.filter((e) => e.sql.includes(`INSERT INTO ${ACCOUNTS}`));
    expect(accountInserts.map((e) => e.values.length)).toEqual([200 * 8, 8]);
    expect(accountInserts[0].sql).toContain('($1,$2,$3,$4,$5,$6,$7,$8),($9,$10');
    const counterInserts = db.log.filter((e) => e.sql.includes(`INSERT INTO ${COUNTERS}`));
    expect(counterInserts.map((e) => e.values.length)).toEqual([200 * 5, 5]);
    expect(counterInserts[1].sql).toContain('($1,$2,$3,$4,$5)');
    expect(db.accounts.size).toBe(201);
    const reads = db.log.filter(
      (e) =>
        e.sql.includes('user_id = ANY') ||
        (e.sql.includes(`FROM ${ACCOUNTS}`) && e.sql.includes('ANY'))
    );
    expect(reads.map((e) => (e.values[1] as string[]).length)).toEqual([200, 1]);
  });

  it('does not open a connection when the source is invalid', async () => {
    const { supplement, expected } = fixture(2);
    supplement.accountAuthStates = [];
    const db = new FakeDb();
    const conn = connection(db);
    await expect(
      restoreVerifiedAwsState({
        manifest,
        supplement: repin(supplement),
        expected,
        connection: conn,
      })
    ).rejects.toThrow(new Error(INVALID));
    expect(conn.opened).toBe(0);
  });

  it.each([ACCOUNTS, COUNTERS, NAMEIDS])(
    'refuses to overwrite existing %s rows and rolls back',
    async (table) => {
      const { supplement, expected } = fixture(2);
      const db = new FakeDb();
      const seed = new Map<string, Row>([['x', { tenant_id: TENANT }]]);
      if (table === ACCOUNTS) db.accounts = seed;
      if (table === COUNTERS) db.counters = seed;
      if (table === NAMEIDS) db.nameids = seed;
      await expect(
        restoreVerifiedAwsState({ manifest, supplement, expected, connection: connection(db) })
      ).rejects.toThrow(new Error(INVALID));
      expect(db.log.map((e) => e.sql)).toContain('ROLLBACK');
      expect(db.log.map((e) => e.sql)).not.toContain('COMMIT');
      expect(db.log.some((e) => e.sql.includes('INSERT'))).toBe(false);
    }
  );

  it('ignores other tenants rows when checking for existing state', async () => {
    const { supplement, expected } = fixture(2);
    const db = new FakeDb();
    db.accounts.set('x', { tenant_id: 'tenant-z' });
    await expect(
      restoreVerifiedAwsState({ manifest, supplement, expected, connection: connection(db) })
    ).resolves.toBeDefined();
  });

  it('rolls back, and tolerates a failing rollback, on database errors', async () => {
    for (const rollbackFails of [false, true]) {
      const { supplement, expected } = fixture(2);
      const db = new FakeDb();
      db.rollbackFails = rollbackFails;
      db.failOn = (sql) => sql.includes('INSERT INTO authrim_aws_passkey_counters');
      await expect(
        restoreVerifiedAwsState({ manifest, supplement, expected, connection: connection(db) })
      ).rejects.toThrow(new Error(INVALID));
      expect(db.log.map((e) => e.sql)).toContain('ROLLBACK');
      expect(db.log.map((e) => e.sql)).not.toContain('COMMIT');
    }
  });

  it('does not roll back when BEGIN itself fails', async () => {
    const { supplement, expected } = fixture(2);
    const db = new FakeDb();
    db.failOn = (sql) => sql.startsWith('BEGIN');
    await expect(
      restoreVerifiedAwsState({ manifest, supplement, expected, connection: connection(db) })
    ).rejects.toThrow(INVALID);
    expect(db.log.map((e) => e.sql)).not.toContain('ROLLBACK');
  });

  it('does not roll back after the commit succeeded and fails when COMMIT fails', async () => {
    const { supplement, expected } = fixture(2);
    const db = new FakeDb();
    db.failOn = (sql) => sql === 'COMMIT';
    await expect(
      restoreVerifiedAwsState({ manifest, supplement, expected, connection: connection(db) })
    ).rejects.toThrow(INVALID);
    expect(db.log.map((e) => e.sql).filter((s) => s === 'ROLLBACK')).toHaveLength(1);
  });

  const accountColumns = [
    'tenant_id',
    'account_id',
    'lifecycle',
    'lifecycle_version_ms',
    'lifecycle_operation_id',
    'revoked_after_ms',
    'last_login_at_ms',
  ];
  it.each(accountColumns)(
    'rejects an account insert that returns a different %s',
    async (column) => {
      const { supplement, expected } = fixture(2);
      const db = new FakeDb();
      db.respond = (sql, _v, rows) =>
        sql.includes(`INSERT INTO ${ACCOUNTS}`)
          ? rows.map((r, i) =>
              i === 0 ? { ...r, [column]: r[column] === 'zzz' ? 'yyy' : 'zzz' } : r
            )
          : rows;
      await expect(
        restoreVerifiedAwsState({ manifest, supplement, expected, connection: connection(db) })
      ).rejects.toThrow(INVALID);
    }
  );
  it('rejects account inserts that return fewer, unknown or string-equal numeric rows correctly', async () => {
    const { supplement, expected } = fixture(2);
    for (const mode of ['fewer', 'unknown'] as const) {
      const db = new FakeDb();
      db.respond = (sql, _v, rows) =>
        !sql.includes(`INSERT INTO ${ACCOUNTS}`)
          ? rows
          : mode === 'fewer'
            ? rows.slice(1)
            : rows.map((r, i) => (i === 0 ? { ...r, user_id: 'ghost' } : r));
      await expect(
        restoreVerifiedAwsState({ manifest, supplement, expected, connection: connection(db) })
      ).rejects.toThrow(INVALID);
    }
    const db = new FakeDb();
    db.respond = (sql, _v, rows) =>
      sql.includes(`INSERT INTO ${ACCOUNTS}`)
        ? rows.map((r) => ({
            ...r,
            lifecycle_version_ms: String(r.lifecycle_version_ms),
            revoked_after_ms:
              r.revoked_after_ms === null ? null : String(r.revoked_after_ms as number),
            last_login_at_ms:
              r.last_login_at_ms === null ? null : String(r.last_login_at_ms as number),
          }))
        : rows;
    await expect(
      restoreVerifiedAwsState({ manifest, supplement, expected, connection: connection(db) })
    ).resolves.toBeDefined();
  });
  it.each(['tenant_id', 'user_id', 'counter', 'updated_at_ms'])(
    'rejects a counter insert that returns a different %s',
    async (column) => {
      const { supplement, expected } = fixture(2);
      const db = new FakeDb();
      db.respond = (sql, _v, rows) =>
        sql.includes(`INSERT INTO ${COUNTERS}`)
          ? rows.map((r, i) => (i === 0 ? { ...r, [column]: 'zzz' } : r))
          : rows;
      await expect(
        restoreVerifiedAwsState({ manifest, supplement, expected, connection: connection(db) })
      ).rejects.toThrow(INVALID);
    }
  );
  it('rejects counter inserts with fewer or unknown rows', async () => {
    const { supplement, expected } = fixture(2);
    for (const mode of ['fewer', 'unknown'] as const) {
      const db = new FakeDb();
      db.respond = (sql, _v, rows) =>
        !sql.includes(`INSERT INTO ${COUNTERS}`)
          ? rows
          : mode === 'fewer'
            ? rows.slice(1)
            : rows.map((r, i) => (i === 0 ? { ...r, credential_id: 'ghost' } : r));
      await expect(
        restoreVerifiedAwsState({ manifest, supplement, expected, connection: connection(db) })
      ).rejects.toThrow(INVALID);
    }
  });
  it('rejects a NameID that cannot be read back identically or conflicts', async () => {
    const { supplement, expected } = fixture(2);
    const db = new FakeDb();
    db.respond = (sql, _v, rows) =>
      sql.includes('SELECT value_json FROM')
        ? rows.map((r) => ({ value_json: `${r.value_json as string} ` }))
        : rows;
    await expect(
      restoreVerifiedAwsState({ manifest, supplement, expected, connection: connection(db) })
    ).rejects.toThrow(INVALID);
    const conflict = new FakeDb();
    conflict.respond = (sql, _v, rows) => (sql.includes(`INSERT INTO ${NAMEIDS}`) ? [] : rows);
    await expect(
      restoreVerifiedAwsState({ manifest, supplement, expected, connection: connection(conflict) })
    ).rejects.toThrow(INVALID);
  });
  it('rejects when the post-restore row count differs for any table', async () => {
    for (const table of [ACCOUNTS, COUNTERS, NAMEIDS]) {
      const { supplement, expected } = fixture(2);
      const db = new FakeDb();
      db.respond = (sql, _v, rows) =>
        sql.includes('count(*)') && sql.includes(table) ? [{ count: '3' }] : rows;
      await expect(
        restoreVerifiedAwsState({ manifest, supplement, expected, connection: connection(db) })
      ).rejects.toThrow(INVALID);
      const fewer = new FakeDb();
      fewer.respond = (sql, _v, rows) =>
        sql.includes('count(*)') && sql.includes(table) ? [{ count: '1' }] : rows;
      await expect(
        restoreVerifiedAwsState({ manifest, supplement, expected, connection: connection(fewer) })
      ).rejects.toThrow(INVALID);
    }
  });
  it('rejects a non-numeric count', async () => {
    const { supplement, expected } = fixture(2);
    const db = new FakeDb();
    db.respond = (sql, _v, rows) => (sql.includes('count(*)') ? [{ count: 'abc' }] : rows);
    await expect(
      restoreVerifiedAwsState({ manifest, supplement, expected, connection: connection(db) })
    ).rejects.toThrow(INVALID);
  });
});

describe('state readback', () => {
  it('accepts a faithfully restored state in a read-only repeatable-read transaction', async () => {
    const { db, readback } = await restored(2);
    db.log.length = 0;
    await expect(assertVerifiedAwsStateRestored(readback())).resolves.toBeUndefined();
    expect(db.log[0]).toEqual({
      sql: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      values: [],
    });
    expect(db.log[db.log.length - 1]).toEqual({ sql: 'COMMIT', values: [] });
    expect(db.log.some((e) => e.sql.includes('INSERT'))).toBe(false);
    const counts = db.log.filter((e) => e.sql.includes('count(*)'));
    expect(counts.map((e) => e.sql.match(/FROM (\w+) WHERE/u)![1])).toEqual([
      ACCOUNTS,
      COUNTERS,
      NAMEIDS,
    ]);
    expect(counts.every((e) => e.values.length === 1 && e.values[0] === TENANT)).toBe(true);
    const lookups = db.log.filter((e) => e.sql.includes('ANY($2::text[])'));
    expect(lookups.map((e) => e.values[1])).toEqual([
      ['user-0001', 'user-0002'],
      ['passkey-0001', 'passkey-0002'],
      [nameIdKey(1), nameIdKey(2)],
    ]);
    expect(lookups.every((e) => e.values[0] === TENANT)).toBe(true);
    // The staging readback never walks the whole NameID registry.
    expect(db.log.some((e) => e.sql.includes('registry_key > $2'))).toBe(false);
  });

  it('pages through more than 200 rows', async () => {
    const { db, readback } = await restored(201);
    db.log.length = 0;
    await expect(assertVerifiedAwsStateRestored(readback())).resolves.toBeUndefined();
    const lookups = db.log.filter((e) => e.sql.includes('ANY($2::text[])'));
    expect(lookups.map((e) => (e.values[1] as string[]).length)).toEqual([200, 1, 200, 1, 200, 1]);
  });

  const receiptMutations: Array<[string, (r: any) => void]> = [
    ['tenantId', (r) => (r.tenantId = 'tenant-b')],
    ['source tenant', (r) => (r.source.tenantId = 'tenant-b')],
    ['source issuer', (r) => (r.source.issuer = 'https://x.example.test')],
    ['source product version', (r) => (r.source.productVersion = '9')],
    ['bundle id', (r) => (r.bundleId = 'c'.repeat(32))],
    ['snapshot id', (r) => (r.snapshotId = 'x')],
    ['inventory digest', (r) => (r.inventoryDigestSha256 = 'c'.repeat(64))],
    ['supplement sha', (r) => (r.supplementSha256 = 'c'.repeat(64))],
    ['account count', (r) => (r.accountAuthStates += 1)],
    ['counter count', (r) => (r.passkeyCounters += 1)],
    ['nameid count', (r) => (r.persistentNameIds += 1)],
  ];
  it.each(receiptMutations)(
    'rejects a readback receipt with a different %s before any query',
    async (_n, mutate) => {
      const { db, readback, conn } = await restored(2);
      db.log.length = 0;
      const input = readback();
      input.receipt = structuredClone(input.receipt);
      mutate(input.receipt);
      const opened = conn.opened;
      await expect(assertVerifiedAwsStateRestored(input)).rejects.toThrow(new Error(INVALID));
      await expect(assertAwsLiveStateCompatible(input)).rejects.toThrow(new Error(INVALID));
      expect(conn.opened).toBe(opened);
      expect(db.log).toEqual([]);
    }
  );
  it('rejects readback of an invalid source before opening a connection', async () => {
    const { db, readback, conn } = await restored(2);
    const input = readback();
    input.expected = { users: [], accounts: [], passkeys: [] };
    const opened = conn.opened;
    await expect(assertVerifiedAwsStateRestored(input)).rejects.toThrow(INVALID);
    expect(conn.opened).toBe(opened);
    expect(db.log.length).toBeGreaterThan(0);
  });

  const tamper = (db: FakeDb, edit: (sql: string, rows: Row[]) => Row[]) => {
    db.respond = (sql, _v, rows) => edit(sql, rows);
  };

  it.each([
    ['account_id', ACCOUNTS],
    ['lifecycle', ACCOUNTS],
    ['lifecycle_version_ms', ACCOUNTS],
    ['lifecycle_operation_id', ACCOUNTS],
    ['revoked_after_ms', ACCOUNTS],
    ['last_login_at_ms', ACCOUNTS],
    ['user_id', COUNTERS],
    ['counter', COUNTERS],
    ['updated_at_ms', COUNTERS],
    ['value_json', NAMEIDS],
    ['created_at_ms', NAMEIDS],
  ])('rejects a restored %s that differs in %s', async (column, table) => {
    for (const read of [assertVerifiedAwsStateRestored, assertAwsLiveStateCompatible]) {
      const { db, readback } = await restored(2);
      db.log.length = 0;
      tamper(db, (sql, rows) =>
        sql.includes('ANY($2::text[])') && sql.includes(table)
          ? rows.map((r, i) =>
              i === 0 ? { ...r, [column]: r[column] === 'zzz' ? 'yyy' : 'zzz' } : r
            )
          : rows
      );
      const live = read === assertAwsLiveStateCompatible;
      // In live mode counters may legitimately move forward, so those columns are covered below.
      if (live && table === COUNTERS && (column === 'counter' || column === 'updated_at_ms'))
        continue;
      await expect(read(readback())).rejects.toThrow(new Error(INVALID));
      expect(db.log.map((e) => e.sql)).toContain('ROLLBACK');
      expect(db.log.map((e) => e.sql)).not.toContain('COMMIT');
    }
  });
  it.each([
    ['accounts', 'authrim_aws_account_auth_state'],
    ['counters', 'authrim_aws_passkey_counters'],
    ['nameids', 'authrim_aws_saml_persistent_nameids'],
  ])('rejects missing, unknown and null-vs-value %s rows', async (_label, table) => {
    const { db, readback } = await restored(2);
    tamper(db, (sql, rows) =>
      sql.includes('ANY($2::text[])') && sql.includes(`FROM ${table}`) ? rows.slice(1) : rows
    );
    await expect(assertVerifiedAwsStateRestored(readback())).rejects.toThrow(INVALID);
    const unknown = await restored(2);
    const key =
      table === ACCOUNTS ? 'user_id' : table === COUNTERS ? 'credential_id' : 'registry_key';
    tamper(unknown.db, (sql, rows) =>
      sql.includes('ANY($2::text[])') && sql.includes(`FROM ${table}`)
        ? rows.map((r, i) => (i === 0 ? { ...r, [key]: 'ghost' } : r))
        : rows
    );
    await expect(assertVerifiedAwsStateRestored(unknown.readback())).rejects.toThrow(INVALID);
  });
  it('rejects a revoked/last-login value that turned null or non-null', async () => {
    const { db, readback } = await restored(2);
    tamper(db, (sql, rows) =>
      sql.includes('ANY($2::text[])') && sql.includes(`FROM ${ACCOUNTS}`)
        ? rows.map((r) => ({ ...r, revoked_after_ms: r.revoked_after_ms === null ? 5 : null }))
        : rows
    );
    await expect(assertVerifiedAwsStateRestored(readback())).rejects.toThrow(INVALID);
    const second = await restored(2);
    tamper(second.db, (sql, rows) =>
      sql.includes('ANY($2::text[])') && sql.includes(`FROM ${ACCOUNTS}`)
        ? rows.map((r) => ({ ...r, last_login_at_ms: r.last_login_at_ms === null ? 5 : null }))
        : rows
    );
    await expect(assertVerifiedAwsStateRestored(second.readback())).rejects.toThrow(INVALID);
  });
  it('rejects readback when queries throw and rolls back', async () => {
    const { db, readback } = await restored(2);
    db.rollbackFails = true;
    db.failOn = (sql) => sql.includes('count(*)');
    await expect(assertVerifiedAwsStateRestored(readback())).rejects.toThrow(INVALID);
    expect(db.log.map((e) => e.sql)).toContain('ROLLBACK');
  });
  it('does not roll back when BEGIN fails', async () => {
    const { db, readback } = await restored(2);
    db.log.length = 0;
    db.failOn = (sql) => sql.startsWith('BEGIN');
    await expect(assertVerifiedAwsStateRestored(readback())).rejects.toThrow(INVALID);
    expect(db.log.map((e) => e.sql)).not.toContain('ROLLBACK');
  });
  it('rejects counts that differ per table in both modes (staging exact, live NameIDs at least)', async () => {
    for (const table of [ACCOUNTS, COUNTERS, NAMEIDS]) {
      const { db, readback } = await restored(2);
      tamper(db, (sql, rows) =>
        sql.includes('count(*)') && sql.includes(table) ? [{ count: '3' }] : rows
      );
      await expect(assertVerifiedAwsStateRestored(readback())).rejects.toThrow(INVALID);
      if (table === NAMEIDS) {
        // More NameIDs than the supplement are allowed after activation (new valid records).
        const live = await restored(2);
        tamper(live.db, (sql, rows) =>
          sql.includes('count(*)') && sql.includes(table) ? [{ count: '3' }] : rows
        );
        await expect(assertAwsLiveStateCompatible(live.readback())).resolves.toBeUndefined();
      } else {
        const live = await restored(2);
        tamper(live.db, (sql, rows) =>
          sql.includes('count(*)') && sql.includes(table) ? [{ count: '3' }] : rows
        );
        await expect(assertAwsLiveStateCompatible(live.readback())).rejects.toThrow(INVALID);
      }
      const fewer = await restored(2);
      tamper(fewer.db, (sql, rows) =>
        sql.includes('count(*)') && sql.includes(table) ? [{ count: '1' }] : rows
      );
      await expect(assertAwsLiveStateCompatible(fewer.readback())).rejects.toThrow(INVALID);
    }
  });
});

describe('live state compatibility', () => {
  it('accepts advanced counters, newer activity and a new valid NameID', async () => {
    const { db, readback, supplement } = await restored(2);
    const counter = db.counters.get(`${TENANT}|passkey-0001`)!;
    counter.counter = '99';
    counter.updated_at_ms = NOW + 5000;
    // A new NameID for an existing subject, created after activation.
    const key = `saml:persistent-nameid:tenant:${TENANT}:sp:${encodeURIComponent('https://sp2.example.test')}:subject:user-0001`;
    db.nameids.set(`${TENANT}|${key}`, {
      tenant_id: TENANT,
      registry_key: key,
      value_json: JSON.stringify({
        version: 1,
        tenantId: TENANT,
        spEntityId: 'https://sp2.example.test',
        subjectId: 'user-0001',
        nameId: 'x',
        createdAt: NOW + 10,
      }),
      created_at_ms: NOW + 10,
    });
    db.log.length = 0;
    await expect(assertAwsLiveStateCompatible(readback())).resolves.toBeUndefined();
    expect(db.log[0].sql).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const pages = db.log.filter((e) => e.sql.includes('registry_key > $2'));
    expect(pages[0].values).toEqual([TENANT, '', 200]);
    expect(supplement.persistentNameIds).toHaveLength(2);
    // The staging readback is strict about the extra NameID row count.
    await expect(assertVerifiedAwsStateRestored(readback())).rejects.toThrow(INVALID);
  });
  it('accepts a counter equal to the source value and rejects a rollback', async () => {
    const { db, readback } = await restored(2);
    await expect(assertAwsLiveStateCompatible(readback())).resolves.toBeUndefined();
    db.counters.get(`${TENANT}|passkey-0001`)!.counter = '1';
    await expect(assertAwsLiveStateCompatible(readback())).rejects.toThrow(INVALID);
  });
  it('rejects updated_at moving backwards, and accepts equal', async () => {
    const { db, readback } = await restored(2);
    const row = db.counters.get(`${TENANT}|passkey-0001`)!;
    row.updated_at_ms = (row.updated_at_ms as number) + 0;
    await expect(assertAwsLiveStateCompatible(readback())).resolves.toBeUndefined();
    row.updated_at_ms = (row.updated_at_ms as number) - 1;
    await expect(assertAwsLiveStateCompatible(readback())).rejects.toThrow(INVALID);
  });
  it('rejects a non-finite updated_at', async () => {
    const { db, readback } = await restored(2);
    db.counters.get(`${TENANT}|passkey-0001`)!.updated_at_ms = Number.NaN;
    await expect(assertAwsLiveStateCompatible(readback())).rejects.toThrow(INVALID);
  });
  const addNameId = (db: FakeDb, key: string, value: unknown, created: unknown) =>
    db.nameids.set(`${TENANT}|${key}`, {
      tenant_id: TENANT,
      registry_key: key,
      value_json: typeof value === 'string' ? value : JSON.stringify(value),
      created_at_ms: created,
    });
  const record = (subject: string, createdAt: number) => ({
    version: 1,
    tenantId: TENANT,
    spEntityId: 'https://sp3.example.test',
    subjectId: subject,
    nameId: 'n',
    createdAt,
  });
  const keyFor = (subject: string) =>
    `saml:persistent-nameid:tenant:${TENANT}:sp:${encodeURIComponent('https://sp3.example.test')}:subject:${subject}`;
  it('rejects NameIDs for unknown subjects, invalid records and mismatched creation times', async () => {
    const unknown = await restored(2);
    addNameId(unknown.db, keyFor('stranger'), record('stranger', NOW), NOW);
    await expect(assertAwsLiveStateCompatible(unknown.readback())).rejects.toThrow(INVALID);

    const invalidRecord = await restored(2);
    addNameId(invalidRecord.db, keyFor('user-0001'), '{', NOW);
    await expect(assertAwsLiveStateCompatible(invalidRecord.readback())).rejects.toThrow(INVALID);

    const wrongTime = await restored(2);
    addNameId(wrongTime.db, keyFor('user-0001'), record('user-0001', NOW), NOW + 1);
    await expect(assertAwsLiveStateCompatible(wrongTime.readback())).rejects.toThrow(INVALID);

    const ok = await restored(2);
    addNameId(ok.db, keyFor('user-0001'), record('user-0001', NOW), NOW);
    await expect(assertAwsLiveStateCompatible(ok.readback())).resolves.toBeUndefined();

    const sameStringTime = await restored(2);
    addNameId(sameStringTime.db, keyFor('user-0001'), record('user-0001', NOW), String(NOW));
    await expect(assertAwsLiveStateCompatible(sameStringTime.readback())).resolves.toBeUndefined();
  });
  it('rejects a registry row from a different tenant record and a non-ascending page', async () => {
    const other = await restored(2);
    const foreign = `saml:persistent-nameid:tenant:tenant-b:sp:${encodeURIComponent('https://sp3.example.test')}:subject:user-0001`;
    other.db.nameids.set(`${TENANT}|${foreign}`, {
      tenant_id: TENANT,
      registry_key: foreign,
      value_json: JSON.stringify({ ...record('user-0001', NOW), tenantId: 'tenant-b' }),
      created_at_ms: NOW,
    });
    await expect(assertAwsLiveStateCompatible(other.readback())).rejects.toThrow(INVALID);

    const unsorted = await restored(2);
    unsorted.db.respond = (sql, _v, rows) =>
      sql.includes('registry_key > $2') ? [...rows].reverse() : rows;
    await expect(assertAwsLiveStateCompatible(unsorted.readback())).rejects.toThrow(INVALID);
  });
  it('walks the registry in pages of 200 using a moving cursor', async () => {
    const { db, readback } = await restored(201);
    db.log.length = 0;
    await expect(assertAwsLiveStateCompatible(readback())).resolves.toBeUndefined();
    const pages = db.log.filter((e) => e.sql.includes('registry_key > $2'));
    expect(pages.map((e) => e.values)).toEqual([
      [TENANT, '', 200],
      [TENANT, nameIdKey(200), 200],
    ]);
  });
  it('stops after a short page and after an empty page', async () => {
    const exact = await restored(200);
    exact.db.log.length = 0;
    await expect(assertAwsLiveStateCompatible(exact.readback())).resolves.toBeUndefined();
    const pages = exact.db.log.filter((e) => e.sql.includes('registry_key > $2'));
    expect(pages).toHaveLength(2);
    const small = await restored(2);
    small.db.log.length = 0;
    await assertAwsLiveStateCompatible(small.readback());
    expect(small.db.log.filter((e) => e.sql.includes('registry_key > $2'))).toHaveLength(1);
  });
});
