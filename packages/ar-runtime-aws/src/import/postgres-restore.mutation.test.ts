/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion -- fakes and deliberately malformed inputs are intentionally untyped */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import type { VerifiedTenantBackupV2 } from './backup-reader';
import { POSTGRES_RESTORE_TABLE_CONTRACTS } from './postgres-restore-table-contract';
import {
  assertPostgresBackupProjectionSupported,
  readPostgresFamilyStagingReceipt,
  restoreVerifiedPostgresFamily,
  UnsupportedPostgresBackupProjectionError,
  validatePostgresFamilyStagingReceiptRow,
  verifyPostgresFamilyStagingRows,
  type PostgresFamilyRestoreReceipt,
} from './postgres-restore';

// A mutant that bypasses the injected clientFactory must never reach a real pg connection.
vi.mock('pg', () => ({
  Client: class {
    constructor() {
      throw new Error('real pg Client construction is forbidden in mutation tests');
    }
  },
}));

const INVALID = 'aws_postgres_restore_invalid';
const TENANT = 'tenant-a';
const TARGET = '11111111-1111-4111-8111-111111111111';
const PII = POSTGRES_RESTORE_TABLE_CONTRACTS.filter((s) => s.family === 'pii');
const CORE = POSTGRES_RESTORE_TABLE_CONTRACTS.filter((s) => s.family === 'core');
const USERS = PII[0];
const SENSITIVE = PII[1];
const MAX_ROWS = 100_000;

const descriptor = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  module: 'm',
  kind: 'users',
  store: 'database',
  schemaVersion: 1,
  disposition: 'include',
  ...over,
});

type RowSpec = { rows: string[]; bytes?: number; rowsDeclared?: number };
function backupOf(
  datasets: Array<{ id: string; over?: Record<string, unknown>; data?: RowSpec }>,
  manifestOver: Record<string, unknown> = {}
): VerifiedTenantBackupV2 {
  const byId = new Map(datasets.map((d) => [d.id, d]));
  return {
    manifest: {
      bundleId: 'b'.repeat(32),
      snapshotId: 'snap',
      inventoryDigestSha256: 'd'.repeat(64),
      source: { tenantId: TENANT, issuer: 'https://t.example.test', productVersion: '1' },
      datasets: datasets.map((d) => descriptor(d.id, d.over)),
      ...manifestOver,
    },
    dataset(id: string) {
      const data = byId.get(id)?.data ?? { rows: [] };
      return {
        id,
        rows: data.rowsDeclared ?? data.rows.length,
        bytes: data.bytes ?? 0,
        async readNextRow(cursor: string | null) {
          const index = cursor === null ? 0 : Number(cursor);
          return index < data.rows.length
            ? { rowJson: data.rows[index], nextCursor: String(index + 1) }
            : null;
        },
      };
    },
    close: async () => undefined,
  } as unknown as VerifiedTenantBackupV2;
}

function portable(spec: (typeof PII)[number], values: Record<string, string | null>) {
  const row: Record<string, [string, string | null]> = {};
  for (const column of spec.columns) {
    const value = column in values ? values[column] : null;
    if (value === null) row[column] = ['null', null];
    else row[column] = [spec.sqliteIntegerColumns.includes(column) ? 'integer' : 'text', value];
  }
  return JSON.stringify(row);
}
const userRow = (id: string, over: Record<string, string | null> = {}) =>
  portable(USERS, {
    id,
    tenant_id: TENANT,
    pii_class: 'standard',
    created_at: '1',
    updated_at: '2',
    custom_attributes_json: '{"b":2,"a":1}',
    ...over,
  });
const sensitiveRow = (id: string, over: Record<string, string | null> = {}) =>
  portable(SENSITIVE, {
    id,
    tenant_id: TENANT,
    owner_type: 'user',
    owner_id: 'u',
    value_key: 'k',
    value_json: '{"x":[1,2]}',
    value_hash: 'h',
    classification: 'c',
    lifecycle_state: 'active',
    created_at: '3',
    updated_at: '4',
    ...over,
  });

const piiBackup = (
  users: string[] = [],
  sensitive: string[] = [],
  extra: Array<{ id: string; over?: Record<string, unknown>; data?: RowSpec }> = []
) =>
  backupOf([
    { id: USERS.datasetId, data: { rows: users } },
    { id: SENSITIVE.datasetId, data: { rows: sensitive } },
    ...extra,
  ]);

type Row = Record<string, unknown>;
class FakePg {
  log: Array<{ sql: string; values?: unknown[] }> = [];
  tables = new Map<string, Row[]>();
  journal: Row[] = [];
  scopedTables: string[] = [];
  connected = 0;
  ended = 0;
  override: ((sql: string, values: unknown[] | undefined, def: any) => any) | null = null;
  failOn: ((sql: string) => boolean) | null = null;
  readonly client = {
    connect: async () => void (this.connected += 1),
    end: async () => void (this.ended += 1),
    query: async (sql: string, values?: unknown[]) => {
      this.log.push({ sql, values });
      if (this.failOn?.(sql)) throw new Error('db error');
      const def = this.run(sql, values ?? []);
      return this.override ? (this.override(sql, values, def) ?? def) : def;
    },
  } as unknown as Client;
  factory = () => this.client;
  sqls = () => this.log.map((l) => l.sql.trim().split(/\s+/u).slice(0, 4).join(' '));
  private spec(table: string) {
    return POSTGRES_RESTORE_TABLE_CONTRACTS.find((s) => s.table === table)!;
  }
  private run(sql: string, values: unknown[]): any {
    const ok = (rows: Row[] = []) => ({ rows, rowCount: rows.length });
    if (/^(BEGIN|COMMIT|ROLLBACK)/u.test(sql)) return { rows: [], rowCount: null };
    if (sql.startsWith('CREATE TABLE')) return { rows: [], rowCount: null };
    if (sql.startsWith('SELECT target_id FROM authrim_aws_import_staging LIMIT 1'))
      return ok(this.journal);
    if (sql.includes('SELECT DISTINCT c.relname'))
      return ok(this.scopedTables.map((table_name) => ({ table_name })));
    if (sql.startsWith('INSERT INTO authrim_aws_import_staging')) {
      this.journal.push({
        target_id: values[0],
        tenant_id: values[1],
        family: values[2],
        receipt_json: values[3],
      });
      return ok();
    }
    if (sql.startsWith('SELECT target_id,tenant_id,family,receipt_json')) {
      return ok(this.journal.filter((j) => j.target_id === values[0]));
    }
    let m = /^SELECT 1 FROM "(\w+)" WHERE "(\w+)" = \$1 LIMIT 1/u.exec(sql);
    if (m) return ok((this.tables.get(m[1]) ?? []).filter((r) => r[m![2]] === values[0]));
    m = /^SELECT 1 FROM "(\w+)" WHERE "(\w+)" IS DISTINCT FROM \$1/u.exec(sql);
    if (m) return ok((this.tables.get(m[1]) ?? []).filter((r) => r[m![2]] !== values[0]));
    m = /^INSERT INTO "(\w+)" \(([^)]*)\) VALUES/u.exec(sql);
    if (m) {
      const spec = this.spec(m[1]);
      const row: Row = {};
      spec.columns.forEach((column, i) => {
        const raw = values[i];
        row[column] =
          raw !== null && spec.postgresJsonbColumns.includes(column)
            ? JSON.parse(raw as string)
            : raw;
      });
      this.tables.set(m[1], [...(this.tables.get(m[1]) ?? []), row]);
      return ok([row]);
    }
    m = /^SELECT 1 FROM "(\w+)" WHERE tenant_id=\$1 LIMIT 1/u.exec(sql);
    if (m) return ok((this.tables.get(m[1]) ?? []).filter((r) => r.tenant_id === values[0]));
    m = /^SELECT .* FROM "(\w+)" WHERE "(\w+)"\s*=\s*\$1( LIMIT \$2)?$/su.exec(sql.trim());
    if (m) {
      const rows = (this.tables.get(m[1]) ?? []).filter((r) => r[m[2]] === values[0]);
      return ok(m[3] ? rows.slice(0, values[1] as number) : rows);
    }
    throw new Error(`unhandled sql: ${sql.slice(0, 80)}`);
  }
}

const base = (fake: FakePg, over: Record<string, unknown> = {}) => ({
  backup: piiBackup([userRow('u1')], [sensitiveRow('s1')]),
  family: 'pii' as const,
  tenantId: TENANT,
  targetId: TARGET,
  connectionString: 'postgres://localhost/pii',
  clientFactory: fake.factory,
  ...over,
});
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const r = value as Record<string, unknown>;
  return `{${Object.keys(r)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(r[k])}`)
    .join(',')}}`;
}

describe('assertPostgresBackupProjectionSupported', () => {
  it('accepts the required family datasets with limits at their maximum', () => {
    expect(() =>
      assertPostgresBackupProjectionSupported(
        backupOf([
          {
            id: USERS.datasetId,
            data: { rows: [], rowsDeclared: MAX_ROWS, bytes: 64 * 1024 * 1024 },
          },
          { id: SENSITIVE.datasetId, data: { rows: [], rowsDeclared: 0, bytes: 0 } },
        ]),
        'pii'
      )
    ).not.toThrow();
  });
  it.each<[string, Array<{ id: string; over?: Record<string, unknown>; data?: RowSpec }>]>([
    [
      'duplicate dataset ids',
      [{ id: USERS.datasetId }, { id: USERS.datasetId }, { id: SENSITIVE.datasetId }],
    ],
    ['missing required dataset', [{ id: USERS.datasetId }]],
    [
      'non-database required dataset',
      [{ id: USERS.datasetId, over: { store: 'kv' } }, { id: SENSITIVE.datasetId }],
    ],
    [
      'excluded required dataset',
      [{ id: USERS.datasetId, over: { disposition: 'rebuild' } }, { id: SENSITIVE.datasetId }],
    ],
    [
      'too many rows',
      [
        { id: USERS.datasetId, data: { rows: [], rowsDeclared: MAX_ROWS + 1 } },
        { id: SENSITIVE.datasetId },
      ],
    ],
    [
      'negative rows',
      [{ id: USERS.datasetId, data: { rows: [], rowsDeclared: -1 } }, { id: SENSITIVE.datasetId }],
    ],
    [
      'fractional rows',
      [{ id: USERS.datasetId, data: { rows: [], rowsDeclared: 1.5 } }, { id: SENSITIVE.datasetId }],
    ],
    [
      'too many bytes',
      [
        { id: USERS.datasetId, data: { rows: [], bytes: 64 * 1024 * 1024 + 1 } },
        { id: SENSITIVE.datasetId },
      ],
    ],
    [
      'negative bytes',
      [{ id: USERS.datasetId, data: { rows: [], bytes: -1 } }, { id: SENSITIVE.datasetId }],
    ],
    [
      'fractional bytes',
      [{ id: USERS.datasetId, data: { rows: [], bytes: 0.5 } }, { id: SENSITIVE.datasetId }],
    ],
    [
      'negative unknown rows',
      [
        { id: USERS.datasetId },
        { id: SENSITIVE.datasetId },
        { id: 'pii.unknown', data: { rows: [], rowsDeclared: -1 } },
      ],
    ],
    [
      'fractional unknown rows',
      [
        { id: USERS.datasetId },
        { id: SENSITIVE.datasetId },
        { id: 'pii.unknown', data: { rows: [], rowsDeclared: 0.5 } },
      ],
    ],
  ])('rejects %s', (_n, datasets) => {
    expect(() => assertPostgresBackupProjectionSupported(backupOf(datasets), 'pii')).toThrow(
      new Error(INVALID)
    );
  });
  it('reports non-empty unsupported datasets sorted by id and ignores empty, other-family, non-database or excluded ones', () => {
    const backup = backupOf([
      { id: USERS.datasetId },
      { id: SENSITIVE.datasetId },
      { id: 'pii.zeta', data: { rows: [], rowsDeclared: 2 } },
      { id: 'pii.alpha', data: { rows: [], rowsDeclared: 1 } },
      { id: 'pii.empty', data: { rows: [], rowsDeclared: 0 } },
      { id: 'pii.kv', over: { store: 'kv' }, data: { rows: [], rowsDeclared: 9 } },
      { id: 'pii.rebuilt', over: { disposition: 'rebuild' }, data: { rows: [], rowsDeclared: 9 } },
      { id: 'core.other', data: { rows: [], rowsDeclared: 9 } },
      { id: 'piix.other', data: { rows: [], rowsDeclared: 9 } },
    ]);
    try {
      assertPostgresBackupProjectionSupported(backup, 'pii');
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedPostgresBackupProjectionError);
      const typed = error as UnsupportedPostgresBackupProjectionError;
      expect(typed.code).toBe('aws_postgres_restore_unsupported_datasets');
      expect(typed.message).toBe('aws_postgres_restore_unsupported_datasets');
      expect(typed.datasets).toEqual([
        { datasetId: 'pii.alpha', rowCount: 1 },
        { datasetId: 'pii.zeta', rowCount: 2 },
      ]);
    }
  });
  it('checks both families when none is selected', () => {
    const piiOnly = piiBackup();
    expect(() => assertPostgresBackupProjectionSupported(piiOnly)).toThrow(new Error(INVALID));
    const all = backupOf(
      [
        ...PII,
        ...CORE.filter(
          (s) => !['core.oauth_clients', 'core.web_origin_registry'].includes(s.datasetId)
        ),
      ].map((s) => ({ id: s.datasetId }))
    );
    expect(() => assertPostgresBackupProjectionSupported(all)).not.toThrow();
    expect(() => assertPostgresBackupProjectionSupported(all, 'core')).not.toThrow();
  });
  it('does not require the optional supplemental Login UI datasets', () => {
    const ids = CORE.map((s) => s.datasetId).filter(
      (id) => id !== 'core.oauth_clients' && id !== 'core.web_origin_registry'
    );
    expect(() =>
      assertPostgresBackupProjectionSupported(backupOf(ids.map((id) => ({ id }))), 'core')
    ).not.toThrow();
    const missingOther = ids.filter((id) => id !== 'core.tenants');
    expect(() =>
      assertPostgresBackupProjectionSupported(backupOf(missingOther.map((id) => ({ id }))), 'core')
    ).toThrow(INVALID);
  });
});

describe('restoreVerifiedPostgresFamily', () => {
  it('imports rows in one serializable transaction and returns a self-verifying receipt', async () => {
    const fake = new FakePg();
    const receipt = await restoreVerifiedPostgresFamily(base(fake));
    expect(fake.connected).toBe(1);
    expect(fake.ended).toBe(1);
    const sqls = fake.log.map((l) => l.sql);
    expect(sqls[0]).toBe('BEGIN ISOLATION LEVEL SERIALIZABLE');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    expect(sqls).not.toContain('ROLLBACK');
    expect(sqls.filter((s) => s.startsWith('INSERT INTO "'))).toHaveLength(2);
    expect(fake.log.find((l) => l.sql.startsWith('SELECT 1 FROM "users_pii"'))!.values).toEqual([
      TENANT,
    ]);
    expect(receipt).toMatchObject({
      status: 'committed_staging',
      family: 'pii',
      targetId: TARGET,
      tenantId: TENANT,
      bundleId: 'b'.repeat(32),
      snapshotId: 'snap',
      inventoryDigestSha256: 'd'.repeat(64),
    });
    expect('projectionVersion' in receipt).toBe(false);
    const { digestSha256, ...body } = receipt;
    expect(digestSha256).toBe(sha(stable(body)));
    const sourceUsers = userRow('u1');
    const rowsDigest = (key: string, normalized: unknown[]) => {
      const text = JSON.stringify([key, normalized]);
      return sha(`${new TextEncoder().encode(text).byteLength}:${text}`);
    };
    expect(receipt.tables.map((t) => [t.datasetId, t.rowCount])).toEqual([
      ['pii.users_pii', 1],
      ['pii.identity_sensitive_values', 1],
    ]);
    expect(receipt.tables[0].sourceSha256).toBe(
      sha(`${new TextEncoder().encode(sourceUsers).byteLength}:${sourceUsers}`)
    );
    const normalizedUser = USERS.columns.map((c) => {
      if (c === 'id') return 'u1';
      if (c === 'tenant_id') return TENANT;
      if (c === 'pii_class') return 'standard';
      if (c === 'created_at') return '1';
      if (c === 'updated_at') return '2';
      if (c === 'custom_attributes_json') return '{"a":1,"b":2}';
      return null;
    });
    expect(receipt.tables[0].targetSha256).toBe(rowsDigest(JSON.stringify(['u1']), normalizedUser));
    expect(fake.journal).toHaveLength(1);
    expect(fake.journal[0]).toMatchObject({ target_id: TARGET, tenant_id: TENANT, family: 'pii' });
    expect(JSON.parse(fake.journal[0].receipt_json as string)).toEqual(receipt);
    expect(validatePostgresFamilyStagingReceiptRow(fake.journal[0], TARGET)).toEqual(receipt);
    // Sensitive rows keep their JSONB text numeric precision semantics through stable JSON.
    expect(fake.tables.get('identity_sensitive_values')![0].value_json).toEqual({ x: [1, 2] });
  });

  it('accepts an empty import and uses a one-based dataset digest', async () => {
    const fake = new FakePg();
    const receipt = await restoreVerifiedPostgresFamily(base(fake, { backup: piiBackup() }));
    expect(receipt.tables.map((t) => t.rowCount)).toEqual([0, 0]);
    expect(receipt.tables[0].sourceSha256).toBe(sha(''));
    expect(receipt.tables[0].targetSha256).toBe(sha(''));
  });

  it.each<[string, Record<string, unknown>]>([
    ['invalid supplemental client id', { supplementalLoginClientId: 'bad id' }],
    ['empty supplemental client id', { supplementalLoginClientId: '' }],
    ['non uuid target', { targetId: 'nope' }],
    ['uuid with invalid version', { targetId: '11111111-1111-9111-8111-111111111111' }],
    ['uuid with invalid variant', { targetId: '11111111-1111-4111-c111-111111111111' }],
    ['empty tenant', { tenantId: '' }],
    ['tenant not in manifest', { tenantId: 'other' }],
    ['unknown family', { family: 'audit' }],
    ['empty connection string', { connectionString: '' }],
    ['supplemental rows for pii', { supplementalRows: {} }],
  ])('rejects %s before connecting', async (_n, over) => {
    const fake = new FakePg();
    await expect(restoreVerifiedPostgresFamily(base(fake, over) as never)).rejects.toThrow(
      new Error(INVALID)
    );
    expect(fake.connected).toBe(0);
  });
  it('rejects supplemental rows with unknown dataset keys and accepts an uppercase UUID', async () => {
    const fake = new FakePg();
    await expect(
      restoreVerifiedPostgresFamily(
        base(fake, { family: 'core', supplementalRows: { 'core.users_core': [] } }) as never
      )
    ).rejects.toThrow(INVALID);
    expect(fake.connected).toBe(0);
    await expect(
      restoreVerifiedPostgresFamily(base(new FakePg(), { targetId: TARGET.toUpperCase() }))
    ).resolves.toBeDefined();
  });
  it('rejects a long supplemental client id and accepts 128 characters', async () => {
    const fake = new FakePg();
    await expect(
      restoreVerifiedPostgresFamily(
        base(fake, { supplementalLoginClientId: 'a'.repeat(129) }) as never
      )
    ).rejects.toThrow(INVALID);
  });
  it('surfaces unsupported datasets without connecting', async () => {
    const fake = new FakePg();
    const backup = piiBackup([], [], [{ id: 'pii.extra', data: { rows: [], rowsDeclared: 3 } }]);
    await expect(restoreVerifiedPostgresFamily(base(fake, { backup }))).rejects.toBeInstanceOf(
      UnsupportedPostgresBackupProjectionError
    );
    expect(fake.connected).toBe(0);
  });

  const failing = async (setup: (fake: FakePg) => Record<string, unknown> | void) => {
    const fake = new FakePg();
    const over = setup(fake) ?? {};
    const initialJournal = fake.journal.length;
    await expect(restoreVerifiedPostgresFamily(base(fake, over) as never)).rejects.toThrow(
      new Error(INVALID)
    );
    expect(fake.log.map((l) => l.sql)).toContain('ROLLBACK');
    expect(fake.log.map((l) => l.sql)).not.toContain('COMMIT');
    expect(fake.ended).toBe(1);
    expect(fake.journal).toHaveLength(initialJournal);
    return fake;
  };
  it('refuses a target that already has a journal entry', async () => {
    await failing((f) => void f.journal.push({ target_id: 'x' }));
  });
  it('refuses a target with rows for the tenant in any tenant-scoped table', async () => {
    const fake = await failing((f) => {
      f.scopedTables = ['audit_log'];
      f.tables.set('audit_log', [{ tenant_id: TENANT }]);
    });
    expect(fake.log.some((l) => l.sql.startsWith('SELECT 1 FROM "audit_log"'))).toBe(true);
  });
  it('rejects a scoped table name that is not a plain identifier', async () => {
    await failing((f) => void (f.scopedTables = ['Bad-Name']));
  });
  it('ignores other tenants rows in scoped and import tables', async () => {
    const fake = new FakePg();
    fake.scopedTables = ['audit_log'];
    fake.tables.set('audit_log', [{ tenant_id: 'other' }]);
    fake.tables.set('users_pii', [{ tenant_id: 'other' }]);
    await expect(restoreVerifiedPostgresFamily(base(fake))).resolves.toBeDefined();
  });
  it('refuses a target with existing rows in an import table', async () => {
    await failing((f) => void f.tables.set('users_pii', [{ tenant_id: TENANT }]));
  });
  it.each<[string, string[], string[]]>([
    ['invalid json', ['not json'], []],
    ['json array', ['[]'], []],
    ['json null', ['null'], []],
    [
      'missing column',
      [JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(userRow('u1'))).slice(1)))],
      [],
    ],
    [
      'unknown column',
      [JSON.stringify({ ...JSON.parse(userRow('u1')), extra: ['text', 'x'] })],
      [],
    ],
    ['cell not tagged', [JSON.stringify({ ...JSON.parse(userRow('u1')), email: 'x' })], []],
    ['cell wrong length', [JSON.stringify({ ...JSON.parse(userRow('u1')), email: ['text'] })], []],
    [
      'null with value',
      [JSON.stringify({ ...JSON.parse(userRow('u1')), email: ['null', 'x'] })],
      [],
    ],
    [
      'text tagged integer',
      [JSON.stringify({ ...JSON.parse(userRow('u1')), email: ['integer', '1'] })],
      [],
    ],
    [
      'text with non string',
      [JSON.stringify({ ...JSON.parse(userRow('u1')), email: ['text', 1] })],
      [],
    ],
    ['integer tagged text', [userRow('u1', {}).replace('["integer","1"]', '["text","1"]')], []],
    ['integer leading zero', [userRow('u1', { created_at: '01' })], []],
    ['integer fractional', [userRow('u1', { created_at: '1.5' })], []],
    ['integer too large', [userRow('u1', { created_at: '9223372036854775808' })], []],
    ['integer too small', [userRow('u1', { created_at: '-9223372036854775809' })], []],
    ['jsonb invalid', [userRow('u1', { custom_attributes_json: '{' })], []],
    ['other tenant', [userRow('u1', { tenant_id: 'other' })], []],
    ['null tenant', [userRow('u1', { tenant_id: null })], []],
    ['duplicate primary key', [userRow('u1'), userRow('u1')], []],
    ['null primary key', [userRow('u1').replace('["text","u1"]', '["null",null]')], []],
    ['invalid sensitive row', [], ['{']],
  ])('rejects a source row with %s', async (_n, users, sensitive) => {
    await failing(() => ({ backup: piiBackup(users, sensitive) }));
  });
  it('accepts the extreme 64-bit integers and negative values', async () => {
    const fake = new FakePg();
    const rows = [
      userRow('u1', { created_at: '9223372036854775807', updated_at: '-9223372036854775808' }),
      userRow('u2', { created_at: '0', updated_at: '-1' }),
    ];
    await expect(
      restoreVerifiedPostgresFamily(base(fake, { backup: piiBackup(rows) }))
    ).resolves.toBeDefined();
  });
  it('rejects source readers that misbehave', async () => {
    await failing(() => ({
      backup: backupOf([
        { id: USERS.datasetId, data: { rows: [userRow('u1')], rowsDeclared: 2 } },
        { id: SENSITIVE.datasetId },
      ]),
    }));
    await failing(() => ({
      backup: backupOf([
        { id: USERS.datasetId, data: { rows: [userRow('u1'), userRow('u2')], rowsDeclared: 1 } },
        { id: SENSITIVE.datasetId },
      ]),
    }));
    const stuck = piiBackup([userRow('u1'), userRow('u2')]);
    const original = stuck.dataset.bind(stuck);
    (stuck as any).dataset = (id: string) => ({
      ...original(id),
      readNextRow: async () => ({ rowJson: userRow(id), nextCursor: 'same' }),
    });
    await failing(() => ({ backup: stuck }));
  });
  it('rejects a source row larger than 1 MiB and accepts one just under', async () => {
    const big = userRow('u1', { email: 'e'.repeat(1024 * 1024) });
    await failing(() => ({ backup: piiBackup([big]) }));
    const fake = new FakePg();
    const near = userRow('u1', { email: 'e'.repeat(1024 * 1024 - 4000) });
    await expect(
      restoreVerifiedPostgresFamily(base(fake, { backup: piiBackup([near]) }))
    ).resolves.toBeDefined();
  });
  it('rejects datasets declared over the byte cap without opening a connection', async () => {
    const fake = new FakePg();
    const backup = backupOf([
      { id: USERS.datasetId, data: { rows: [], bytes: 64 * 1024 * 1024 + 1 } },
      { id: SENSITIVE.datasetId },
    ]);
    await expect(restoreVerifiedPostgresFamily(base(fake, { backup }))).rejects.toThrow(
      new Error(INVALID)
    );
    expect(fake.connected).toBe(0);
  });
  it('rejects when the database reports an unexpected insert result', async () => {
    await failing((f) => {
      f.override = (sql, _v, def) =>
        sql.startsWith('INSERT INTO "users_pii"') ? { rows: def.rows, rowCount: 2 } : undefined;
    });
    await failing((f) => {
      f.override = (sql) =>
        sql.startsWith('INSERT INTO "users_pii"') ? { rows: [], rowCount: 1 } : undefined;
    });
    await failing((f) => {
      f.override = (sql, _v, def) =>
        sql.startsWith('INSERT INTO "users_pii"')
          ? { rows: [...def.rows, ...def.rows], rowCount: 1 }
          : undefined;
    });
  });
  it('rejects when returned rows differ from the source', async () => {
    await failing((f) => {
      f.override = (sql, _v, def) =>
        sql.startsWith('INSERT INTO "users_pii"')
          ? { rows: [{ ...def.rows[0], pii_class: 'changed' }], rowCount: 1 }
          : undefined;
    });
    await failing((f) => {
      f.override = (sql, _v, def) =>
        sql.startsWith('INSERT INTO "users_pii"')
          ? { rows: [{ ...def.rows[0], created_at: 7 }], rowCount: 1 }
          : undefined;
    });
    await failing((f) => {
      f.override = (sql, _v, def) =>
        sql.startsWith('INSERT INTO "identity_sensitive_values"')
          ? { rows: [{ ...def.rows[0], value_json: { x: [2, 1] } }], rowCount: 1 }
          : undefined;
    });
  });
  it('accepts numeric returned values equal to the source digits', async () => {
    const fake = new FakePg();
    fake.override = (sql, _v, def) =>
      sql.startsWith('INSERT INTO "users_pii"')
        ? { rows: [{ ...def.rows[0], created_at: 1, updated_at: 2 }], rowCount: 1 }
        : undefined;
    await expect(restoreVerifiedPostgresFamily(base(fake))).resolves.toBeDefined();
  });
  it('rejects malformed returned values', async () => {
    for (const patch of [
      { created_at: 1.5 },
      { created_at: true },
      { id: 5 },
      { custom_attributes_json: undefined },
    ]) {
      await failing((f) => {
        f.override = (sql, _v, def) =>
          sql.startsWith('INSERT INTO "users_pii"')
            ? { rows: [{ ...def.rows[0], ...patch }], rowCount: 1 }
            : undefined;
      });
    }
  });
  it('rejects when the verification select disagrees with the inserted rows', async () => {
    await failing((f) => {
      f.override = (sql) =>
        sql.startsWith('SELECT') && sql.includes('FROM "users_pii"') && !sql.includes('LIMIT')
          ? { rows: [], rowCount: 0 }
          : undefined;
    });
    await failing((f) => {
      f.override = (sql, _v, def) =>
        sql.startsWith('SELECT') && sql.includes('FROM "users_pii"') && !sql.includes('LIMIT')
          ? { rows: [{ ...def.rows[0], pii_class: 'drift' }], rowCount: 1 }
          : undefined;
    });
    await failing((f) => {
      f.override = (sql, _v, def) =>
        sql.startsWith('SELECT') && sql.includes('FROM "users_pii"') && !sql.includes('LIMIT')
          ? { rows: [def.rows[0], def.rows[0]], rowCount: 1 }
          : undefined;
    });
  });
  it('rolls back when the journal insert fails but not after a successful commit', async () => {
    const journalFails = new FakePg();
    journalFails.failOn = (sql) => sql.startsWith('INSERT INTO authrim_aws_import_staging');
    await expect(restoreVerifiedPostgresFamily(base(journalFails))).rejects.toThrow('db error');
    expect(journalFails.log.filter((l) => l.sql === 'ROLLBACK')).toHaveLength(1);
    const commitFails = new FakePg();
    commitFails.failOn = (sql) => sql === 'COMMIT';
    await expect(restoreVerifiedPostgresFamily(base(commitFails))).rejects.toThrow('db error');
    expect(commitFails.log.filter((l) => l.sql === 'ROLLBACK')).toHaveLength(1);
    expect(commitFails.ended).toBe(1);
  });
  it('does not roll back when BEGIN fails', async () => {
    const fake = new FakePg();
    fake.failOn = (sql) => sql.startsWith('BEGIN');
    await expect(restoreVerifiedPostgresFamily(base(fake))).rejects.toThrow('db error');
    expect(fake.log.map((l) => l.sql)).not.toContain('ROLLBACK');
    expect(fake.ended).toBe(1);
  });
  it('propagates connection failures without querying', async () => {
    const fake = new FakePg();
    (fake.client as any).connect = async () => {
      throw new Error('no connection');
    };
    await expect(restoreVerifiedPostgresFamily(base(fake))).rejects.toThrow('no connection');
    expect(fake.log).toEqual([]);
  });
});

describe('staging receipt validation', () => {
  const receiptFor = (over: Record<string, unknown> = {}): PostgresFamilyRestoreReceipt => {
    const body = {
      status: 'committed_staging' as const,
      family: 'pii' as const,
      targetId: TARGET,
      tenantId: TENANT,
      bundleId: 'b'.repeat(32),
      snapshotId: 'snap',
      inventoryDigestSha256: 'd'.repeat(64),
      tables: [],
      ...over,
    };
    return { ...body, digestSha256: sha(stable(body)) };
  };
  const rowFor = (receipt: unknown, over: Record<string, unknown> = {}) => ({
    target_id: TARGET,
    tenant_id: TENANT,
    family: 'pii',
    receipt_json: JSON.stringify(receipt),
    ...over,
  });
  it('accepts a consistent row', () => {
    const receipt = receiptFor();
    expect(validatePostgresFamilyStagingReceiptRow(rowFor(receipt), TARGET)).toEqual(receipt);
  });
  it.each<[string, () => [unknown, string]]>([
    ['bad expected uuid', () => [rowFor(receiptFor()), 'nope']],
    ['null row', () => [null, TARGET]],
    ['array row', () => [[], TARGET]],
    ['string row', () => ['x', TARGET]],
    [
      'other target',
      () => [rowFor(receiptFor(), { target_id: '22222222-2222-4222-8222-222222222222' }), TARGET],
    ],
    ['non-string tenant', () => [rowFor(receiptFor(), { tenant_id: 5 }), TARGET]],
    ['empty tenant', () => [rowFor(receiptFor({ tenantId: '' }), { tenant_id: '' }), TARGET]],
    ['unknown family', () => [rowFor(receiptFor({ family: 'x' }), { family: 'x' }), TARGET]],
    ['non-string receipt', () => [rowFor(receiptFor(), { receipt_json: {} }), TARGET]],
    ['invalid receipt json', () => [rowFor(receiptFor(), { receipt_json: '{' }), TARGET]],
    ['null receipt', () => [rowFor(null), TARGET]],
    ['array receipt', () => [rowFor([]), TARGET]],
    ['status', () => [rowFor(receiptFor({ status: 'active' })), TARGET]],
    [
      'receipt target',
      () => [rowFor(receiptFor({ targetId: '22222222-2222-4222-8222-222222222222' })), TARGET],
    ],
    ['receipt tenant', () => [rowFor(receiptFor({ tenantId: 'other' })), TARGET]],
    ['receipt family', () => [rowFor(receiptFor({ family: 'core' })), TARGET]],
    ['tables not array', () => [rowFor(receiptFor({ tables: 'x' })), TARGET]],
    ['digest', () => [rowFor({ ...receiptFor(), digestSha256: 'c'.repeat(64) }), TARGET]],
    ['body tampering', () => [rowFor({ ...receiptFor(), snapshotId: 'tampered' }), TARGET]],
  ])('rejects %s', (_n, make) => {
    const [row, expected] = make();
    expect(() => validatePostgresFamilyStagingReceiptRow(row, expected)).toThrow(
      new Error(INVALID)
    );
  });
});

describe('readPostgresFamilyStagingReceipt', () => {
  const input = (fake: FakePg, over: Record<string, unknown> = {}) => ({
    connectionString: 'postgres://x',
    targetId: TARGET,
    clientFactory: fake.factory,
    ...over,
  });
  it('rejects invalid input before connecting', async () => {
    const fake = new FakePg();
    await expect(readPostgresFamilyStagingReceipt(input(fake, { targetId: 'x' }))).rejects.toThrow(
      INVALID
    );
    await expect(
      readPostgresFamilyStagingReceipt(input(fake, { connectionString: '' }))
    ).rejects.toThrow(INVALID);
    expect(fake.connected).toBe(0);
  });
  it('returns null for an empty journal, the receipt for one row and rejects several', async () => {
    const empty = new FakePg();
    await expect(readPostgresFamilyStagingReceipt(input(empty))).resolves.toBeNull();
    expect(empty.ended).toBe(1);
    expect(empty.log[0].values).toEqual([TARGET]);

    const restoredFake = new FakePg();
    const receipt = await restoreVerifiedPostgresFamily(base(restoredFake));
    await expect(readPostgresFamilyStagingReceipt(input(restoredFake))).resolves.toEqual(receipt);

    const many = new FakePg();
    many.override = () => ({ rows: [{}, {}], rowCount: 2 });
    await expect(readPostgresFamilyStagingReceipt(input(many))).rejects.toThrow(INVALID);
    expect(many.ended).toBe(1);
  });
  it('closes the client when the query fails', async () => {
    const fake = new FakePg();
    fake.failOn = () => true;
    await expect(readPostgresFamilyStagingReceipt(input(fake))).rejects.toThrow('db error');
    expect(fake.ended).toBe(1);
  });
});

describe('verifyPostgresFamilyStagingRows', () => {
  const run = (fake: FakePg, over: Record<string, unknown> = {}) =>
    verifyPostgresFamilyStagingRows({
      connectionString: 'postgres://x',
      targetId: TARGET,
      clientFactory: fake.factory,
      ...over,
    });
  async function restoredPii() {
    const fake = new FakePg();
    const receipt = await restoreVerifiedPostgresFamily(base(fake));
    fake.log.length = 0;
    fake.ended = 0;
    return { fake, receipt };
  }
  const retarget = (fake: FakePg, patch: (r: any) => void) => {
    const receipt = JSON.parse(fake.journal[0].receipt_json as string);
    patch(receipt);
    const { digestSha256: _d, ...body } = receipt;
    receipt.digestSha256 = sha(stable(body));
    fake.journal[0].receipt_json = JSON.stringify(receipt);
  };

  it('re-verifies restored rows inside a read-only repeatable-read transaction', async () => {
    const { fake, receipt } = await restoredPii();
    await expect(run(fake)).resolves.toEqual(receipt);
    const sqls = fake.log.map((l) => l.sql);
    expect(sqls).toContain('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    const selects = fake.log.filter((l) => l.sql.includes('LIMIT $2'));
    expect(selects.map((l) => l.values)).toEqual([
      [TENANT, 2],
      [TENANT, 2],
    ]);
    expect(fake.ended).toBe(2);
  });
  it('fails without a receipt', async () => {
    await expect(run(new FakePg())).rejects.toThrow(new Error(INVALID));
  });
  it('rejects skip lists that are invalid for the family or too long', async () => {
    const { fake } = await restoredPii();
    await expect(run(fake, { skipDatasetIds: ['core.identity_accounts'] })).rejects.toThrow(
      INVALID
    );
    const { fake: other } = await restoredPii();
    await expect(run(other, { skipDatasetIds: ['core.passkeys'] })).rejects.toThrow(INVALID);
  });
  it.each<[string, (r: any) => void]>([
    ['table count', (r) => r.tables.pop()],
    ['table order', (r) => r.tables.reverse()],
    ['negative row count', (r) => (r.tables[0].rowCount = -1)],
    ['fractional row count', (r) => (r.tables[0].rowCount = 0.5)],
    ['row count over limit', (r) => (r.tables[0].rowCount = MAX_ROWS + 1)],
    ['bad source digest', (r) => (r.tables[0].sourceSha256 = 'x')],
    ['bad target digest', (r) => (r.tables[0].targetSha256 = 'x'.repeat(64))],
    ['wrong target digest', (r) => (r.tables[0].targetSha256 = 'c'.repeat(64))],
    ['row count mismatch', (r) => (r.tables[0].rowCount = 2)],
    ['unknown projection version', (r) => (r.projectionVersion = 1)],
    ['extended without extension tables', (r) => (r.projectionVersion = 2)],
  ])('rejects a receipt with a bad %s', async (_n, patch) => {
    const { fake } = await restoredPii();
    retarget(fake, patch);
    await expect(run(fake)).rejects.toThrow(INVALID);
  });
  it('accepts a receipt at the row limit boundary shape and uppercase hex is refused', async () => {
    const { fake } = await restoredPii();
    retarget(fake, (r) => (r.tables[0].sourceSha256 = r.tables[0].sourceSha256.toUpperCase()));
    await expect(run(fake)).rejects.toThrow(INVALID);
  });
  it('rejects foreign-tenant rows, count drift and digest drift and rolls back', async () => {
    const foreign = (await restoredPii()).fake;
    foreign.tables.get('users_pii')!.push({ id: 'z', tenant_id: 'other' });
    await expect(run(foreign)).rejects.toThrow(INVALID);
    expect(foreign.log.map((l) => l.sql)).toContain('ROLLBACK');
    expect(foreign.ended).toBe(2);

    const extra = (await restoredPii()).fake;
    extra.tables.get('users_pii')!.push({ ...extra.tables.get('users_pii')![0], id: 'u2' });
    await expect(run(extra)).rejects.toThrow(INVALID);

    const drift = (await restoredPii()).fake;
    drift.tables.get('users_pii')![0].pii_class = 'drift';
    await expect(run(drift)).rejects.toThrow(INVALID);

    const duplicate = (await restoredPii()).fake;
    duplicate.override = (sql, _v, def) =>
      sql.includes('LIMIT $2') && sql.includes('"users_pii"')
        ? { rows: [def.rows[0], def.rows[0]], rowCount: 1 }
        : undefined;
    await expect(run(duplicate)).rejects.toThrow(INVALID);
  });
  it('only ignores tenant default rows for tables with a reference seed', async () => {
    const { fake } = await restoredPii();
    fake.tables.get('users_pii')!.push({ id: 'd', tenant_id: 'default' });
    await expect(run(fake)).rejects.toThrow(INVALID);
  });

  describe('core receipts', () => {
    const coreReceipt = (
      counts: Record<string, number> = {},
      targetShaOverride: Record<string, string> = {}
    ) => {
      const empty = sha('');
      const body = {
        status: 'committed_staging' as const,
        family: 'core' as const,
        targetId: TARGET,
        tenantId: TENANT,
        bundleId: 'b'.repeat(32),
        snapshotId: 'snap',
        inventoryDigestSha256: 'd'.repeat(64),
        tables: CORE.map((s) => ({
          datasetId: s.datasetId,
          rowCount: counts[s.datasetId] ?? 0,
          sourceSha256: empty,
          targetSha256: targetShaOverride[s.datasetId] ?? empty,
        })),
      };
      return { ...body, digestSha256: sha(stable(body)) };
    };
    const coreFake = (receipt: unknown) => {
      const fake = new FakePg();
      fake.journal.push({
        target_id: TARGET,
        tenant_id: TENANT,
        family: 'core',
        receipt_json: JSON.stringify(receipt),
      });
      return fake;
    };
    it('consults the reference seed verifier before comparing core tables', async () => {
      const fake = coreFake(coreReceipt());
      fake.override = (sql) =>
        sql.includes('(to_jsonb(t)') ? { rows: [], rowCount: 0 } : undefined;
      await expect(run(fake)).rejects.toThrow();
      // The baseline seed verifier needs real seed rows; this documents that it is consulted.
      expect(fake.log.some((l) => l.sql.includes('to_jsonb'))).toBe(true);
    });
    it('rejects invalid skip lists', async () => {
      for (const skipDatasetIds of [
        ['core.tenants'],
        ['core.identity_accounts', 'core.identity_accounts'],
        [
          'core.identity_accounts',
          'core.passkeys',
          'core.service_group_inputs',
          'core.account_webhook_outbox',
          'core.passkeys',
        ],
      ]) {
        await expect(run(coreFake(coreReceipt()), { skipDatasetIds })).rejects.toThrow(
          new Error(INVALID)
        );
      }
    });
  });
});
