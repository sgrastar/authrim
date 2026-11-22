/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-non-null-assertion -- fakes and deliberately malformed inputs are intentionally untyped */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POSTGRES_RESTORE_TABLE_CONTRACTS } from '../import/postgres-restore-table-contract';
import { canonicalRestoreJson, restoreEvidenceDigest } from '../import/restore-evidence';
import { DsqlOperationError } from './adapter';
import { createDsqlSubsetImporter, type DsqlSubsetImportInput } from './subset-import';

class Invalid extends Error {}
class Mismatch extends Error {}
const SCHEMA = 's_test';
const TENANT = 't1';
const RECEIPT_SHA = 'a'.repeat(64);
const A = 'core.identity_providers';
const B = 'core.flow_assignments';
const C = 'pii.identity_sensitive_values';
const specOf = (id: string) => POSTGRES_RESTORE_TABLE_CONTRACTS.find((s) => s.datasetId === id)!;

type Row = Record<string, unknown>;
type Op = Record<string, unknown>;
interface Snapshot {
  op: Op | undefined;
  tables: Map<string, Row[]>;
  chunks: Map<number, Row>;
}

/** In-memory fake of the SQL surface the importer uses; transactions roll back on throw. */
class FakeDb {
  op: Op | undefined;
  tables = new Map<string, Row[]>();
  chunks = new Map<number, Row>();
  created: string[] = [];
  txCount = 0;
  hideOpReads = 0;
  jsonbDifferent = false;
  journalCount: string | number | undefined;
  opInsertRows = 1;
  journalInsertRows = 1;
  updateRows: number | undefined;
  verifyUpdateRows: number | undefined;
  createSuccess = true;
  beforeTx: (index: number) => Promise<void> | void = () => undefined;
  afterOpInsert: (op: Op) => void = () => undefined;
  failAfterCommit = new Set<number>();
  mutateInserted: (rows: Row[]) => Row[] = (rows) => rows;
  mutateRead: (rows: Row[], sql: string) => Row[] = (rows) => rows;
  pageOverride: ((rows: Row[]) => Row[]) | undefined;
  sqls: string[] = [];
  params: unknown[][] = [];

  private snapshot(): Snapshot {
    return {
      op: this.op && { ...this.op },
      tables: new Map([...this.tables].map(([k, v]) => [k, v.map((r) => ({ ...r }))])),
      chunks: new Map(this.chunks),
    };
  }
  private restore(s: Snapshot) {
    this.op = s.op;
    this.tables = s.tables;
    this.chunks = s.chunks;
  }
  private rows(table: string) {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table)!;
  }
  private tableOf(sql: string) {
    return /"[^"]+"\."([a-z_]+)"/u.exec(sql)![1];
  }
  private target(table: string, columns: string[], values: unknown[]): Row {
    const spec = POSTGRES_RESTORE_TABLE_CONTRACTS.find((s) => s.table === table)!;
    const out: Row = {};
    columns.forEach((column, index) => {
      const v = values[index];
      out[column] =
        spec.postgresJsonbColumns.includes(column) && typeof v === 'string' ? JSON.parse(v) : v;
    });
    return out;
  }

  async retryableTransaction<T>(callback: (tx: FakeDb) => Promise<T>): Promise<T> {
    const index = ++this.txCount;
    await this.beforeTx(index);
    const snapshot = this.snapshot();
    let result: T;
    try {
      result = await callback(this);
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
    if (this.failAfterCommit.has(index)) throw new Error('commit response lost');
    return result;
  }

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    this.sqls.push(sql);
    this.params.push(params);
    if (sql.startsWith('SELECT tenant_id,input_sha256,source_json')) {
      if (this.hideOpReads > 0) {
        this.hideOpReads--;
        return null;
      }
      expect(params).toEqual(['op-1']);
      return (this.op ? { ...this.op } : null) as T | null;
    }
    if (sql.startsWith('SELECT 1 FROM (VALUES'))
      return (this.jsonbDifferent ? { 1: 1 } : null) as T | null;
    if (sql.startsWith('SELECT 1 FROM')) {
      const table = this.tableOf(sql);
      if (table === 'chunk_journal') return (this.chunks.size ? { 1: 1 } : null) as T | null;
      return (this.rows(table).length ? { 1: 1 } : null) as T | null;
    }
    if (sql.startsWith('SELECT tenant_id,input_sha256,chunk_json'))
      return (this.chunks.get(params[0] as number) ?? null) as T | null;
    if (sql.startsWith('SELECT COUNT(*)'))
      return { count: this.journalCount ?? String(this.chunks.size) } as T;
    throw new Error(`unexpected queryOne: ${sql}`);
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.sqls.push(sql);
    this.params.push(params);
    const table = this.tableOf(sql);
    if (sql.startsWith('INSERT INTO')) {
      const columns = [
        ...sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).matchAll(/"([a-z_]+)"/gu),
      ].map((m) => m[1]);
      const inserted: Row[] = [];
      for (let i = 0; i < params.length; i += columns.length)
        inserted.push(this.target(table, columns, params.slice(i, i + columns.length)));
      this.rows(table).push(...inserted);
      return this.mutateInserted(inserted.map((r) => ({ ...r }))) as T[];
    }
    if (sql.includes('id=ANY($1)')) {
      const ids = params[0] as string[];
      const rows = this.rows(table).filter(
        (r) => ids.includes(r.id as string) && r.tenant_id === params[1]
      );
      return this.mutateRead(
        rows.map((r) => ({ ...r })),
        sql
      ) as T[];
    }
    let rows = [...this.rows(table)].sort((a, b) => (a.id as string).localeCompare(b.id as string));
    if (sql.includes('WHERE id>$1'))
      rows = rows.filter((r) => (r.id as string) > (params[0] as string));
    rows = rows.slice(0, 100).map((r) => ({ ...r }));
    return (this.pageOverride ? this.pageOverride(rows) : this.mutateRead(rows, sql)) as T[];
  }

  async execute(sql: string, params: unknown[] = []) {
    this.sqls.push(sql);
    this.params.push(params);
    if (sql.startsWith('CREATE TABLE')) {
      this.created.push(sql);
      return { success: this.createSuccess, rowsAffected: 0, durationMs: 0 };
    }
    if (sql.startsWith('INSERT INTO') && sql.includes('op_journal')) {
      if (this.opInsertRows === 1)
        this.op = {
          tenant_id: params[1],
          input_sha256: params[2],
          source_json: params[3],
          status: 'loading',
          dataset_index: '0',
          row_offset: '0',
          cursor: null,
          revision: '0',
          receipt_json: null,
        };
      if (this.op) this.afterOpInsert(this.op);
      return { success: true, rowsAffected: this.opInsertRows, durationMs: 0 };
    }
    if (sql.startsWith('INSERT INTO') && sql.includes('chunk_journal')) {
      this.chunks.set(params[0] as number, {
        tenant_id: params[1],
        input_sha256: params[2],
        chunk_json: params[3],
      });
      return { success: true, rowsAffected: this.journalInsertRows, durationMs: 0 };
    }
    if (sql.includes("SET status='native_subset_verified'")) {
      const ok = this.op?.status === 'sealed' && this.op.revision === String(params[4]);
      if (ok && this.verifyUpdateRows === undefined) {
        this.op!.status = 'native_subset_verified';
        this.op!.receipt_json = params[0];
      }
      return {
        success: true,
        rowsAffected: this.verifyUpdateRows ?? (ok ? 1 : 0),
        durationMs: 0,
      };
    }
    if (sql.startsWith('UPDATE') && sql.includes('SET status=$1')) {
      const ok = this.op?.revision === String(params[8]) && this.op.status === 'loading';
      if (ok && this.updateRows === undefined) {
        Object.assign(this.op!, {
          status: params[0],
          dataset_index: String(params[1]),
          row_offset: String(params[2]),
          cursor: params[3],
          revision: String(params[4]),
        });
      }
      return { success: true, rowsAffected: this.updateRows ?? (ok ? 1 : 0), durationMs: 0 };
    }
    throw new Error(`unexpected execute: ${sql}`);
  }
}

let plan: string[] = [A, B, C];
const verifyReferences = vi.fn();
const importer = createDsqlSubsetImporter({
  scope: 'test-scope',
  operationId: 'op-1',
  journalTables: ['op_journal', 'chunk_journal'],
  assertSchemaName(schema) {
    if (!/^s_[a-z]+$/u.test(schema)) throw new Error('bad schema');
  },
  schemaPlan: () => ({
    sourceContractFingerprint: 'fingerprint-1',
    tables: plan.map((datasetId) => ({ datasetId })),
  }),
  ValidationError: Invalid,
  VerificationMismatch: Mismatch,
  verifyReferences,
});

function tagged(ds: string, id: string, over: Record<string, unknown> = {}): string {
  const spec = specOf(ds);
  const o: Record<string, unknown> = {};
  for (const c of spec.columns) {
    if (c === spec.tenantColumn) o[c] = ['text', TENANT];
    else if (c === 'id') o[c] = ['text', id];
    else if (spec.sqliteIntegerColumns.includes(c))
      o[c] = ['integer', spec.postgresBooleanColumns.includes(c) ? '1' : '5'];
    else if (spec.postgresJsonbColumns.includes(c)) o[c] = ['text', '{"n":9007199254740993}'];
    else o[c] = ['text', `${c}-${id}`];
  }
  return JSON.stringify({ ...o, ...over });
}
const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${String(i).padStart(4, '0')}`);
const standardRows = (n: number): Record<string, string[]> => ({
  [A]: ids(n).map((id) => tagged(A, id)),
  [B]: [tagged(B, 'id-0000')],
  [C]: ids(2).map((id) => tagged(C, id)),
});

interface Backup {
  manifest: { source: { tenantId: string }; datasets: Array<Record<string, unknown>> };
  dataset: (id: string) => Record<string, unknown>;
}
function makeBackup(
  rows: Record<string, string[]>,
  extra: {
    datasets?: Array<Record<string, unknown>>;
    tweak?: (id: string, source: Record<string, unknown>) => Record<string, unknown>;
  } = {}
): Backup {
  return {
    manifest: {
      source: { tenantId: TENANT },
      datasets: [
        ...Object.keys(rows).map((id) => ({ id, store: 'database', disposition: 'include' })),
        ...(extra.datasets ?? []),
      ],
    },
    dataset(id) {
      const list = rows[id];
      const base = {
        id,
        rows: list.length,
        bytes: list.reduce((n, r) => n + r.length, 0),
        readNextRow: async (cursor: string | null) => {
          const index = cursor === null ? 0 : Number(cursor);
          return index >= list.length
            ? null
            : { rowJson: list[index], nextCursor: String(index + 1) };
        },
      };
      return extra.tweak ? extra.tweak(id, base) : base;
    },
  };
}
const makeInput = (
  db: FakeDb,
  backup: Backup,
  over: Partial<DsqlSubsetImportInput> = {}
): DsqlSubsetImportInput =>
  ({
    db,
    schema: SCHEMA,
    backup,
    tenantId: TENANT,
    trustedReceiptSha256: RECEIPT_SHA,
    ...over,
  }) as unknown as DsqlSubsetImportInput;

async function restoreAll(input: DsqlSubsetImportInput) {
  const steps = [];
  for (let i = 0; i < 50; i++) {
    const step = await importer.restoreSlice(input);
    steps.push(step);
    if (step.status !== 'loading') return steps;
  }
  throw new Error('did not seal');
}

afterEach(() => {
  vi.restoreAllMocks();
  verifyReferences.mockReset();
  plan = [A, B, C];
});

describe('DSQL subset importer (mutation hardening)', () => {
  it('restores in bounded chunks, seals, verifies natively and returns a digest-pinned receipt', async () => {
    const db = new FakeDb();
    const backup = makeBackup(standardRows(250), {
      datasets: [
        { id: 'z.omitted', store: 'database', disposition: 'exclude' },
        { id: 'a.omitted', store: 'database', disposition: 'exclude' },
      ],
    });
    const input = makeInput(db, backup);
    const steps = await restoreAll(input);
    expect(steps.map((s) => [s.status, s.datasetIndex, s.rowOffset, s.revision])).toEqual([
      ['loading', 0, 100, 1],
      ['loading', 0, 200, 2],
      ['loading', 1, 0, 3],
      ['loading', 2, 0, 4],
      ['sealed', 3, 0, 5],
    ]);
    expect(steps.every((s) => s.fullRuntimeReady === false)).toBe(true);
    // A had 250 rows: chunks of 100, 100, 50
    expect(db.chunks.size).toBe(5);
    // already sealed: further calls are idempotent
    expect(await importer.restoreSlice(input)).toEqual(steps.at(-1));
    expect(db.chunks.size).toBe(5);

    const receipt = await importer.verifySubset(input);
    const body = {
      formatVersion: 1,
      status: 'native_subset_verified',
      scope: 'test-scope',
      fullRuntimeReady: false,
      schema: SCHEMA,
      tenantId: TENANT,
      inputSha256: receipt.inputSha256,
      sourceContractFingerprint: 'fingerprint-1',
      tables: receipt.tables,
      omittedDatasets: ['a.omitted', 'z.omitted'],
    };
    expect(receipt).toEqual({ ...body, digestSha256: restoreEvidenceDigest(body) });
    expect(receipt.inputSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt.tables.map((t) => [t.datasetId, t.rowCount])).toEqual([
      [A, 250],
      [B, 1],
      [C, 2],
    ]);
    for (const t of receipt.tables) {
      expect(t.sourceSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(t.targetSha256).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(verifyReferences).toHaveBeenCalledWith(db, SCHEMA, TENANT);
    expect(db.op).toMatchObject({
      status: 'native_subset_verified',
      receipt_json: canonicalRestoreJson(receipt),
    });
    // idempotent re-verification
    expect(await importer.verifySubset(input)).toEqual(receipt);
    expect((await importer.restoreSlice(input)).status).toBe('native_subset_verified');
    // a differing stored receipt is a mismatch, not a silent success
    db.op!.receipt_json = 'something else';
    await expect(importer.verifySubset(input)).rejects.toBeInstanceOf(Mismatch);
  });

  it('inserts native rows in one transaction with positional parameters and returns target digests', async () => {
    const db = new FakeDb();
    plan = [B];
    const input = makeInput(db, makeBackup({ [B]: [tagged(B, 'id-0000')] }));
    await importer.restoreSlice(input);
    const insert = db.sqls.findIndex((s) =>
      s.startsWith('INSERT INTO "s_test"."flow_assignments"')
    );
    expect(db.sqls[insert]).toContain('RETURNING "id","tenant_id"');
    const values = db.params[insert];
    expect(values).toHaveLength(specOf(B).columns.length);
    // boolean column carries a boolean, integer columns decimal text
    expect(values[specOf(B).columns.indexOf('enabled')]).toBe(true);
    expect(values[specOf(B).columns.indexOf('created_at')]).toBe('5');
    expect(db.sqls[insert]).toContain('VALUES ($1,$2,$3');
  });

  it('allows a zero-row dataset: no native insert, journal still advances', async () => {
    const db = new FakeDb();
    plan = [A];
    const input = makeInput(db, makeBackup({ [A]: [] }));
    const step = await importer.restoreSlice(input);
    expect(step).toMatchObject({ status: 'sealed', datasetIndex: 1, rowOffset: 0, revision: 1 });
    expect(db.sqls.some((s) => s.startsWith('INSERT INTO "s_test"."identity_providers"'))).toBe(
      false
    );
    expect(db.chunks.size).toBe(1);
    await expect(importer.verifySubset(input)).resolves.toMatchObject({
      tables: [{ rowCount: 0 }],
    });
  });

  describe('input validation', () => {
    const rejects = async (input: DsqlSubsetImportInput, cls: new () => Error = Invalid) => {
      await expect(importer.restoreSlice(input)).rejects.toBeInstanceOf(cls);
      await expect(importer.verifySubset(input)).rejects.toBeInstanceOf(cls);
    };
    it('rejects bad tenant, receipt digest and chunk bounds', async () => {
      plan = [A];
      const backup = makeBackup({ [A]: [] });
      const db = new FakeDb();
      await rejects(makeInput(db, backup, { tenantId: '' }));
      await rejects(makeInput(db, backup, { tenantId: 'other' }));
      for (const bad of [
        '',
        'A'.repeat(64),
        'a'.repeat(63),
        'a'.repeat(65),
        `${'a'.repeat(63)}g`,
        ` ${'a'.repeat(64)}`,
        `${'a'.repeat(64)}\n`,
      ])
        await rejects(makeInput(db, backup, { trustedReceiptSha256: bad }));
      for (const maxRowsPerChunk of [0, -1, 101, 1.5, Number.NaN, Infinity])
        await rejects(makeInput(db, backup, { maxRowsPerChunk }));
      for (const maxBytesPerChunk of [0, -1, 512 * 1024 + 1, 1.5, Number.NaN])
        await rejects(makeInput(db, backup, { maxBytesPerChunk }));
      expect(db.txCount).toBe(0);
      for (const opts of [
        { maxRowsPerChunk: 1 },
        { maxRowsPerChunk: 100 },
        { maxBytesPerChunk: 1 },
        { maxBytesPerChunk: 512 * 1024 },
      ])
        await expect(
          importer.restoreSlice(makeInput(new FakeDb(), backup, opts))
        ).resolves.toMatchObject({
          status: 'sealed',
        });
    });
    it('rejects an unusable schema name before touching the database', async () => {
      const db = new FakeDb();
      await rejects(makeInput(db, makeBackup(standardRows(1)), { schema: 'Bad-Schema' }));
      expect(db.txCount).toBe(0);
      expect(db.sqls).toEqual([]);
      await expect(importer.createJournal(db as never, 'Bad-Schema')).rejects.toBeInstanceOf(
        Invalid
      );
      expect(db.created).toEqual([]);
    });
    it('requires every planned dataset to be an included database dataset with a matching source', async () => {
      const base = standardRows(1);
      const mk = (datasets: Array<Record<string, unknown>>) => {
        const backup = makeBackup(base);
        backup.manifest.datasets = datasets;
        return backup;
      };
      const ok = (id: string) => ({ id, store: 'database', disposition: 'include' });
      const db = new FakeDb();
      await rejects(makeInput(db, mk([ok(A), ok(B)])));
      await rejects(makeInput(db, mk([ok(A), ok(B), { ...ok(C), store: 'object' }])));
      await rejects(makeInput(db, mk([ok(A), ok(B), { ...ok(C), disposition: 'exclude' }])));
      plan = [A, 'core.unknown'];
      await rejects(makeInput(db, mk([ok(A), ok('core.unknown')])));
      plan = [A];
      await rejects(makeInput(db, makeBackup(base, { tweak: (id, s) => ({ ...s, id: 'other' }) })));
    });
    it('requires safe-integer row and byte counts', async () => {
      plan = [A];
      const withCounts = (patch: Record<string, unknown>) =>
        makeInput(
          new FakeDb(),
          makeBackup({ [A]: [] }, { tweak: (_id, s) => ({ ...s, ...patch }) })
        );
      for (const patch of [
        { rows: null },
        { bytes: null },
        { rows: {} },
        { bytes: {} },
        { rows: 1.5 },
        { bytes: 1.5 },
        { bytes: -1 },
        { rows: -1 },
        { bytes: '01' },
        { rows: '01' },
        { bytes: '1e2' },
        { rows: Number.MAX_SAFE_INTEGER + 1 },
        { bytes: '-5' },
      ])
        await rejects(withCounts(patch));
      await expect(
        importer.restoreSlice(withCounts({ rows: 0, bytes: '0' }))
      ).resolves.toMatchObject({ status: 'sealed' });
    });
    it('rejects a zero maxRows even when no row would be read', async () => {
      plan = [A];
      const input = makeInput(new FakeDb(), makeBackup({ [A]: [] }), { maxRowsPerChunk: 0 });
      await rejects(input);
    });
  });

  describe('source row normalisation', () => {
    const restoreOne = async (
      ds: string,
      rowJson: string,
      over: Partial<DsqlSubsetImportInput> = {}
    ) => {
      plan = [ds];
      const db = new FakeDb();
      const backup = makeBackup({ [ds]: [rowJson] });
      return { db, run: () => importer.restoreSlice(makeInput(db, backup, over)) };
    };
    const invalidRow = async (ds: string, rowJson: string) => {
      const { run } = await restoreOne(ds, rowJson);
      await expect(run(), rowJson.slice(0, 80)).rejects.toBeInstanceOf(Invalid);
    };
    const withCol = (ds: string, column: string, value: unknown) =>
      tagged(ds, 'id-1', { [column]: value });

    it('rejects non-object rows and column set differences', async () => {
      for (const json of ['{bad', 'null', '[]', '"x"', '5', 'true', '{}'])
        await invalidRow(A, json);
      const full = JSON.parse(tagged(A, 'id-1'));
      await invalidRow(A, JSON.stringify({ ...full, extra: ['text', 'x'] }));
      const missing = { ...full };
      delete missing.name;
      await invalidRow(A, JSON.stringify({ ...missing, other: ['text', 'x'] }));
      await invalidRow(A, JSON.stringify(missing));
    });
    it('rejects malformed tagged values', async () => {
      for (const value of [
        'x',
        5,
        null,
        ['text'],
        ['text', 'a', 'b'],
        {},
        ['null', 'x'],
        ['null'],
        ['integer', null],
      ])
        await invalidRow(A, withCol(A, 'name', value));
      await invalidRow(A, withCol(A, 'name', ['integer', 'x']));
      await invalidRow(A, withCol(A, 'name', ['text', 5]));
      await invalidRow(A, withCol(A, 'name', ['text', null]));
    });
    it('accepts nulls and keeps them', async () => {
      const { run } = await restoreOne(A, withCol(A, 'name', ['null', null]));
      await expect(run()).resolves.toMatchObject({ status: 'sealed' });
      const { run: run2 } = await restoreOne(A, withCol(A, 'enabled', ['null', null]));
      await expect(run2()).resolves.toMatchObject({ status: 'sealed' });
    });
    it('validates integer columns strictly and within the signed 64-bit range', async () => {
      for (const value of [
        ['text', '1'],
        ['integer', 1],
        ['integer', '01'],
        ['integer', '1.5'],
        ['integer', '+1'],
        ['integer', ''],
        ['integer', '-0'],
        ['integer', ' 1'],
        ['integer', '1 '],
        ['integer', '9223372036854775808'],
        ['integer', '-9223372036854775809'],
        ['integer', '12345678901234567890'],
        ['integer', null],
        ['null', 'x'],
      ])
        await invalidRow(A, withCol(A, 'enabled', value));
      for (const ok of ['0', '-1', '9223372036854775807', '-9223372036854775808']) {
        const { run } = await restoreOne(A, withCol(A, 'created_at', ['integer', ok]));
        await expect(run(), ok).resolves.toMatchObject({ status: 'sealed' });
      }
    });
    it('maps boolean columns from 0/1 only', async () => {
      for (const bad of ['2', '-1', '10', '01', 'true'])
        await invalidRow(B, withCol(B, 'enabled', ['integer', bad]));
      for (const [text, expected] of [
        ['0', false],
        ['1', true],
      ] as const) {
        const { db, run } = await restoreOne(
          B,
          tagged(B, 'id-0000', { enabled: ['integer', text] })
        );
        await run();
        const inserted = db.params.find((p, i) =>
          db.sqls[i].startsWith('INSERT INTO "s_test"."flow_assignments"')
        )!;
        expect(inserted[specOf(B).columns.indexOf('enabled')]).toBe(expected);
      }
    });
    it('requires JSON text in jsonb columns', async () => {
      const { run } = await restoreOne(C, withCol(C, 'value_json', ['text', '{broken']));
      await expect(run()).rejects.toBeInstanceOf(Invalid);
      const { run: ok } = await restoreOne(C, withCol(C, 'value_json', ['text', '[1,2]']));
      await expect(ok()).resolves.toMatchObject({ status: 'sealed' });
    });
    it('requires the tenant, a non-empty id without NUL bytes', async () => {
      await invalidRow(A, withCol(A, 'tenant_id', ['text', 'other']));
      await invalidRow(A, withCol(A, 'tenant_id', ['null', null]));
      await invalidRow(A, withCol(A, 'id', ['text', '']));
      await invalidRow(A, withCol(A, 'id', ['null', null]));
      await invalidRow(A, withCol(A, 'id', ['text', 'a\0b']));
    });
    it('rejects duplicate ids inside a chunk', async () => {
      plan = [A];
      const db = new FakeDb();
      const backup = makeBackup({ [A]: [tagged(A, 'dup'), tagged(A, 'dup')] });
      await expect(importer.restoreSlice(makeInput(db, backup))).rejects.toBeInstanceOf(Invalid);
    });
  });

  describe('source reader contract', () => {
    const rowsOf = (n: number) => ids(n).map((id) => tagged(A, id));
    it('rejects an exhausted or non-advancing reader and surplus rows', async () => {
      plan = [A];
      const rows = rowsOf(2);
      const mk = (readNextRow: (c: string | null) => Promise<unknown>) =>
        makeInput(
          new FakeDb(),
          makeBackup({ [A]: rows }, { tweak: (_i, s) => ({ ...s, readNextRow }) })
        );
      await expect(importer.restoreSlice(mk(async () => null))).rejects.toBeInstanceOf(Invalid);
      await expect(
        importer.restoreSlice(mk(async (c) => ({ rowJson: rows[0], nextCursor: c as string })))
      ).rejects.toBeInstanceOf(Invalid);
      await expect(
        importer.restoreSlice(
          mk(async (c) =>
            c === '2'
              ? null
              : { rowJson: rows[c === null ? 0 : 1], nextCursor: c === null ? '1' : '2' }
          )
        )
      ).resolves.toMatchObject({ status: 'sealed' });
      // claims 2 rows but the reader still has a third
      const db = new FakeDb();
      const backup = makeBackup({ [A]: rowsOf(3) }, { tweak: (_i, s) => ({ ...s, rows: 2 }) });
      await expect(importer.restoreSlice(makeInput(db, backup))).rejects.toBeInstanceOf(Invalid);
    });
    it('rejects a row larger than the byte budget and splits chunks at the byte budget', async () => {
      plan = [A];
      const rows = rowsOf(3);
      const size = new TextEncoder().encode(rows[0]).byteLength;
      const db = new FakeDb();
      await expect(
        importer.restoreSlice(
          makeInput(db, makeBackup({ [A]: rows }), { maxBytesPerChunk: size - 1 })
        )
      ).rejects.toBeInstanceOf(Invalid);
      const exact = makeInput(new FakeDb(), makeBackup({ [A]: rows }), {
        maxBytesPerChunk: size * 2,
      });
      const steps = await restoreAll(exact);
      expect(steps.map((s) => [s.status, s.rowOffset])).toEqual([
        ['loading', 2],
        ['sealed', 0],
      ]);
      const one = makeInput(new FakeDb(), makeBackup({ [A]: rows }), {
        maxBytesPerChunk: size * 2 - 1,
      });
      expect((await restoreAll(one)).map((s) => s.rowOffset)).toEqual([1, 2, 0]);
    });
  });

  describe('operation journal pinning', () => {
    const setup = async (n = 150) => {
      plan = [A];
      const db = new FakeDb();
      const input = makeInput(db, makeBackup({ [A]: ids(n).map((id) => tagged(A, id)) }));
      await importer.restoreSlice(input);
      return { db, input };
    };
    it('rejects every inconsistent stored operation state', async () => {
      const { db, input } = await setup();
      const good = { ...db.op! };
      const patches: Array<Record<string, unknown>> = [
        { tenant_id: 'other' },
        { input_sha256: 'x' },
        { source_json: '{}' },
        { status: 'weird' },
        { status: 'sealed' },
        { status: 'native_subset_verified' },
        { dataset_index: '2' },
        { dataset_index: '1', status: 'loading' },
        { dataset_index: '0', status: 'sealed' },
        { dataset_index: '1', status: 'sealed', row_offset: '1', cursor: 'c' },
        { dataset_index: '1', status: 'sealed', cursor: 'c' },
        { row_offset: '151' },
        { row_offset: '0', cursor: '1' },
        { row_offset: '5', cursor: null },
        { row_offset: '5', cursor: '' },
        { row_offset: '5', cursor: 5 },
        { row_offset: '-1' },
        { revision: '-1' },
        { revision: 'x' },
        { dataset_index: 'x' },
        { row_offset: '1.5' },
      ];
      for (const patch of patches) {
        db.op = { ...good, ...patch };
        await expect(importer.restoreSlice(input), JSON.stringify(patch)).rejects.toBeInstanceOf(
          Invalid
        );
        await expect(importer.verifySubset(input), JSON.stringify(patch)).rejects.toBeInstanceOf(
          Invalid
        );
      }
      db.op = { ...good, row_offset: '150', cursor: '150' };
      await expect(importer.restoreSlice(input)).resolves.toMatchObject({ status: 'sealed' });
    });
    it('refuses to initialise over existing native rows or journal chunks', async () => {
      plan = [A];
      let db = new FakeDb();
      db.tables.set('identity_providers', [{ id: 'x' }]);
      await expect(
        importer.restoreSlice(makeInput(db, makeBackup({ [A]: [] })))
      ).rejects.toBeInstanceOf(Invalid);
      expect(db.op).toBeUndefined();
      db = new FakeDb();
      db.chunks.set(1, { tenant_id: TENANT });
      await expect(
        importer.restoreSlice(makeInput(db, makeBackup({ [A]: [] })))
      ).rejects.toBeInstanceOf(Invalid);
      db = new FakeDb();
      db.opInsertRows = 0;
      await expect(
        importer.restoreSlice(makeInput(db, makeBackup({ [A]: [] })))
      ).rejects.toBeInstanceOf(Invalid);
      // the INSERT succeeded but the operation row cannot be read back
      db = new FakeDb();
      db.opInsertRows = 1;
      const realExecute = db.execute.bind(db);
      db.execute = async (sql: string, params?: unknown[]) => {
        const r = await realExecute(sql, params);
        if (sql.startsWith('INSERT INTO') && sql.includes('op_journal')) db.op = undefined;
        return r;
      };
      await expect(
        importer.restoreSlice(makeInput(db, makeBackup({ [A]: [] })))
      ).rejects.toBeInstanceOf(Invalid);
    });
    it('reconciles a lost initial COMMIT only against the exact durable pin', async () => {
      plan = [A];
      const backup = makeBackup({ [A]: [] });
      let db = new FakeDb();
      db.failAfterCommit.add(1);
      await expect(importer.restoreSlice(makeInput(db, backup))).resolves.toMatchObject({
        status: 'sealed',
      });
      db = new FakeDb();
      db.failAfterCommit.add(1);
      db.afterOpInsert = (op) => {
        op.tenant_id = 'other';
      };
      await expect(importer.restoreSlice(makeInput(db, backup))).rejects.toBeInstanceOf(Invalid);
      // an unrelated failure with no durable row is reported as an operation error
      db = new FakeDb();
      db.beforeTx = () => {
        throw new Error('network');
      };
      await expect(importer.restoreSlice(makeInput(db, backup))).rejects.toBeInstanceOf(
        DsqlOperationError
      );
      // a failure with the known classes keeps its class
      db = new FakeDb();
      db.beforeTx = () => {
        throw new Mismatch();
      };
      await expect(importer.restoreSlice(makeInput(db, backup))).rejects.toBeInstanceOf(Mismatch);
      const original = new DsqlOperationError('40001');
      db = new FakeDb();
      db.beforeTx = () => {
        throw original;
      };
      await expect(importer.restoreSlice(makeInput(db, backup))).rejects.toBe(original);
    });
    it('uses an operation that appears between the first read and the initialising transaction', async () => {
      plan = [A];
      const db = new FakeDb();
      const input = makeInput(db, makeBackup({ [A]: ids(3).map((id) => tagged(A, id)) }));
      await importer.restoreSlice(input);
      db.hideOpReads = 1;
      const step = await importer.restoreSlice(input);
      expect(step.status).toBe('sealed');
      // the prior operation is validated before it is accepted
      db.hideOpReads = 1;
      db.op!.tenant_id = 'other';
      await expect(importer.restoreSlice(input)).rejects.toBeInstanceOf(Invalid);
    });
  });

  describe('native write verification', () => {
    const setup = (n = 3, ds = A) => {
      plan = [ds];
      const db = new FakeDb();
      const rows = ids(n).map((id) => tagged(ds, id));
      return { db, input: makeInput(db, makeBackup({ [ds]: rows })) };
    };
    it('rejects a native INSERT that does not return exactly the inserted rows', async () => {
      let { db, input } = setup();
      db.mutateInserted = (rows) => rows.slice(1);
      await expect(importer.restoreSlice(input)).rejects.toBeInstanceOf(Invalid);
      ({ db, input } = setup());
      db.mutateInserted = (rows) => [...rows, rows[0]];
      await expect(importer.restoreSlice(input)).rejects.toBeInstanceOf(Invalid);
      ({ db, input } = setup());
      db.mutateInserted = (rows) => rows.map((r, i) => (i === 1 ? { ...rows[0] } : r));
      await expect(importer.restoreSlice(input)).rejects.toBeInstanceOf(Invalid);
      ({ db, input } = setup());
      db.mutateInserted = (rows) => rows.map((r) => ({ ...r, id: `x-${String(r.id)}` }));
      await expect(importer.restoreSlice(input)).rejects.toBeInstanceOf(Invalid);
      ({ db, input } = setup());
      db.mutateInserted = (rows) => rows.map((r, i) => (i === 2 ? { ...r, name: 'changed' } : r));
      await expect(importer.restoreSlice(input)).rejects.toBeInstanceOf(Invalid);
      // the failed transaction left nothing behind
      expect(db.chunks.size).toBe(0);
      expect(db.tables.get('identity_providers') ?? []).toEqual([]);
    });
    it('normalises target values: integers as numbers or text, null passthrough', async () => {
      const { db, input } = setup();
      db.mutateInserted = (rows) =>
        rows.map((r) => ({ ...r, enabled: Number(r.enabled), created_at: String(r.created_at) }));
      await expect(importer.restoreSlice(input)).resolves.toMatchObject({ status: 'sealed' });
    });
    it('rejects invalid target representations', async () => {
      const bad: Array<[string, Row]> = [
        [A, { enabled: true }],
        [A, { enabled: {} }],
        [A, { enabled: '1.5' }],
        [A, { enabled: '9223372036854775808' }],
        [A, { enabled: '-9223372036854775809' }],
        [A, { name: 5 }],
        [A, { name: undefined }],
        [B, { enabled: 'true' }],
        [B, { enabled: 1 }],
      ];
      for (const [ds, patch] of bad) {
        const { db, input } = setup(1, ds);
        db.mutateInserted = (rows) => rows.map((r) => ({ ...r, ...patch }));
        await expect(importer.restoreSlice(input), JSON.stringify(patch)).rejects.toBeInstanceOf(
          Invalid
        );
      }
    });
    it('delegates JSONB equality to the database and surfaces a mismatch', async () => {
      const { db, input } = setup(2, C);
      db.jsonbDifferent = true;
      await expect(importer.restoreSlice(input)).rejects.toBeInstanceOf(Mismatch);
      expect(db.chunks.size).toBe(0);
      const ok = setup(2, C);
      await importer.restoreSlice(ok.input);
      const query = ok.db.sqls.find((s) => s.startsWith('SELECT 1 FROM (VALUES'))!;
      expect(query).toContain('($1::text,$2::jsonb),($3::text,$4::jsonb)');
      expect(query).toContain('actual.tenant_id=$5');
      expect(query).toContain('"s_test"."identity_sensitive_values"');
      const params = ok.db.params[ok.db.sqls.indexOf(query)];
      expect(params).toEqual([
        'id-0000',
        '{"n":9007199254740993}',
        'id-0001',
        '{"n":9007199254740993}',
        TENANT,
      ]);
    });
    it('requires the journal insert and the progress update to each change one row', async () => {
      let { db, input } = setup();
      db.journalInsertRows = 0;
      await expect(importer.restoreSlice(input)).rejects.toBeInstanceOf(Invalid);
      ({ db, input } = setup());
      db.updateRows = 0;
      await expect(importer.restoreSlice(input)).rejects.toBeInstanceOf(Invalid);
      ({ db, input } = setup());
      db.updateRows = 2;
      await expect(importer.restoreSlice(input)).rejects.toBeInstanceOf(Invalid);
    });
    it('enforces the 120 second transaction budget before the insert and before the journal write', async () => {
      const run = async (clock: number[]) => {
        const { db, input } = setup();
        const queue = [...clock];
        vi.spyOn(Date, 'now').mockImplementation(() => queue.shift() ?? 0);
        return importer.restoreSlice(input).finally(() => db.sqls.length);
      };
      await expect(run([0, 120_001])).rejects.toBeInstanceOf(DsqlOperationError);
      await expect(run([0, 0, 120_001])).rejects.toBeInstanceOf(DsqlOperationError);
      await expect(run([0, 120_000, 120_000])).resolves.toMatchObject({ status: 'sealed' });
      // zero-row chunk skips the first check but not the journal check
      plan = [A];
      const db = new FakeDb();
      const input = makeInput(db, makeBackup({ [A]: [] }));
      const queue = [0, 120_001];
      vi.spyOn(Date, 'now').mockImplementation(() => queue.shift() ?? 0);
      await expect(importer.restoreSlice(input)).rejects.toBeInstanceOf(DsqlOperationError);
    });
  });

  describe('concurrent writers and lost COMMIT responses', () => {
    const setup = async () => {
      plan = [A];
      const db = new FakeDb();
      const input = makeInput(db, makeBackup({ [A]: ids(250).map((id) => tagged(A, id)) }));
      await importer.restoreSlice(input); // revision 1
      return { db, input };
    };
    it('accepts a concurrent writer that journaled the identical chunk', async () => {
      const { db, input } = await setup();
      let nested = false;
      db.beforeTx = async () => {
        if (nested) return;
        nested = true;
        await importer.restoreSlice(input); // concurrent writer commits revision 2
      };
      const step = await importer.restoreSlice(input);
      expect(step).toMatchObject({ revision: 2, rowOffset: 200 });
      expect(db.chunks.size).toBe(2);
    });
    it.each([
      ['a different journal entry', (db: FakeDb) => (db.chunks.get(2)!.chunk_json = 'x')],
      ['a different tenant in the journal', (db: FakeDb) => (db.chunks.get(2)!.tenant_id = 'x')],
      [
        'a different input pin in the journal',
        (db: FakeDb) => (db.chunks.get(2)!.input_sha256 = 'x'),
      ],
      ['a missing journal entry', (db: FakeDb) => db.chunks.delete(2)],
    ])('rejects a concurrent writer with %s', async (_n, tamper) => {
      const { db, input } = await setup();
      let nested = false;
      db.beforeTx = async () => {
        if (nested) return;
        nested = true;
        await importer.restoreSlice(input);
        tamper(db);
      };
      await expect(importer.restoreSlice(input)).rejects.toBeInstanceOf(Invalid);
    });
    it('rejects a writer that moved the revision backwards', async () => {
      const { db, input } = await setup();
      let nested = false;
      db.beforeTx = async () => {
        if (nested) return;
        nested = true;
        const initial = { ...db.op! };
        await importer.restoreSlice(input); // journal for revision 2 exists
        db.op = { ...initial, revision: '0', row_offset: '0', cursor: null };
      };
      await expect(importer.restoreSlice(input)).rejects.toBeInstanceOf(Invalid);
    });
    it('rejects an operation whose position changed without a revision change', async () => {
      for (const patch of [{ cursor: '77' }, { row_offset: '50', cursor: '50' }]) {
        const { db, input } = await setup();
        db.beforeTx = () => {
          Object.assign(db.op!, patch);
        };
        await expect(importer.restoreSlice(input), JSON.stringify(patch)).rejects.toBeInstanceOf(
          Invalid
        );
      }
    });
    it('rejects an operation that vanished inside the transaction', async () => {
      const { db, input } = await setup();
      db.beforeTx = () => {
        db.hideOpReads = 1;
      };
      await expect(importer.restoreSlice(input)).rejects.toBeInstanceOf(Invalid);
    });
    it('treats an uncertain COMMIT as success only when the exact journal entry exists', async () => {
      const { db, input } = await setup();
      db.failAfterCommit.add(db.txCount + 1);
      await expect(importer.restoreSlice(input)).resolves.toMatchObject({ revision: 2 });
      // lost COMMIT where the write did not happen: the original failure surfaces
      const second = await setup();
      second.db.failAfterCommit.add(second.db.txCount + 1);
      second.db.updateRows = 0;
      await expect(importer.restoreSlice(second.input)).rejects.toBeInstanceOf(Invalid);
      const third = await setup();
      third.db.beforeTx = () => {
        throw new Error('network');
      };
      await expect(importer.restoreSlice(third.input)).rejects.toBeInstanceOf(DsqlOperationError);
    });
    it('rejects a journal entry that does not match after an uncertain COMMIT', async () => {
      const { db, input } = await setup();
      db.failAfterCommit.add(db.txCount + 1);
      db.afterOpInsert = () => undefined;
      const realExecute = db.execute.bind(db);
      db.execute = async (sql: string, params?: unknown[]) => {
        const r = await realExecute(sql, params);
        if (sql.startsWith('INSERT INTO') && sql.includes('chunk_journal'))
          db.chunks.get(2)!.chunk_json = 'tampered';
        return r;
      };
      await expect(importer.restoreSlice(input)).rejects.toBeInstanceOf(Invalid);
    });
    it('rejects a persisted state that is behind the written revision or missing', async () => {
      let { db, input } = await setup();
      db.failAfterCommit.add(db.txCount + 1);
      const realQueryOne = db.queryOne.bind(db);
      let afterWrite = false;
      const realExecute = db.execute.bind(db);
      db.execute = async (sql: string, params?: unknown[]) => {
        const r = await realExecute(sql, params);
        if (sql.includes('SET status=$1')) afterWrite = true;
        return r;
      };
      db.queryOne = (async (sql: string, params?: unknown[]) => {
        if (afterWrite && sql.startsWith('SELECT tenant_id,input_sha256,source_json'))
          return {
            ...db.op!,
            revision: '1',
            status: 'loading',
            dataset_index: '0',
            row_offset: '100',
            cursor: '100',
          };
        return realQueryOne(sql, params);
      }) as never;
      await expect(importer.restoreSlice(input)).rejects.toBeInstanceOf(Invalid);
      ({ db, input } = await setup());
      const real2 = db.queryOne.bind(db);
      let writes = 0;
      const exec2 = db.execute.bind(db);
      db.execute = async (sql: string, params?: unknown[]) => {
        const r = await exec2(sql, params);
        if (sql.includes('SET status=$1')) writes++;
        return r;
      };
      db.queryOne = (async (sql: string, params?: unknown[]) => {
        if (writes > 0 && sql.startsWith('SELECT tenant_id,input_sha256,source_json')) return null;
        return real2(sql, params);
      }) as never;
      await expect(importer.restoreSlice(input)).rejects.toBeInstanceOf(Invalid);
    });
  });

  describe('createJournal', () => {
    it('creates both journal tables in order, reporting progress', async () => {
      const db = new FakeDb();
      const events: unknown[] = [];
      await importer.createJournal(db, SCHEMA, { onProgress: (e) => events.push(e) });
      expect(events).toEqual([
        { kind: 'table', name: 'op_journal', status: 'attempted' },
        { kind: 'table', name: 'op_journal', status: 'created' },
        { kind: 'table', name: 'chunk_journal', status: 'attempted' },
        { kind: 'table', name: 'chunk_journal', status: 'created' },
      ]);
      expect(db.created).toHaveLength(2);
      expect(db.created[0]).toContain(
        'CREATE TABLE "s_test"."op_journal" (operation_id TEXT PRIMARY KEY,'
      );
      expect(db.created[0]).toContain('receipt_json TEXT');
      expect(db.created[1]).toContain(
        'CREATE TABLE "s_test"."chunk_journal" (revision BIGINT PRIMARY KEY,'
      );
      expect(db.created[1]).toContain('chunk_json TEXT NOT NULL');
      await importer.createJournal(new FakeDb(), SCHEMA);
    });
    it('maps failures to an operation error without a created event', async () => {
      const db = new FakeDb();
      db.createSuccess = false;
      const events: unknown[] = [];
      await expect(
        importer.createJournal(db as never, SCHEMA, { onProgress: (e) => events.push(e) })
      ).rejects.toBeInstanceOf(DsqlOperationError);
      expect(events).toEqual([{ kind: 'table', name: 'op_journal', status: 'attempted' }]);
      const broken = { execute: async () => Promise.reject(new Error('x')) };
      await expect(importer.createJournal(broken as never, SCHEMA)).rejects.toBeInstanceOf(
        DsqlOperationError
      );
    });
  });

  describe('verifySubset', () => {
    const sealed = async (n = 3, rows: Record<string, string[]> | undefined = undefined) => {
      plan = [A];
      const db = new FakeDb();
      const input = makeInput(db, makeBackup(rows ?? { [A]: ids(n).map((id) => tagged(A, id)) }));
      await restoreAll(input);
      return { db, input };
    };
    it('refuses to verify before the import is sealed', async () => {
      plan = [A];
      const db = new FakeDb();
      const input = makeInput(db, makeBackup({ [A]: ids(150).map((id) => tagged(A, id)) }));
      await expect(importer.verifySubset(input)).rejects.toBeInstanceOf(Invalid);
      await importer.restoreSlice(input);
      await expect(importer.verifySubset(input)).rejects.toBeInstanceOf(Invalid);
      expect(verifyReferences).not.toHaveBeenCalled();
    });
    it.each([
      ['missing journal', (db: FakeDb) => db.chunks.clear()],
      ['journal tenant', (db: FakeDb) => (db.chunks.get(1)!.tenant_id = 'x')],
      ['journal input pin', (db: FakeDb) => (db.chunks.get(1)!.input_sha256 = 'x')],
      ['journal content', (db: FakeDb) => (db.chunks.get(1)!.chunk_json = 'x')],
      ['missing native row', (db: FakeDb) => db.tables.get('identity_providers')!.pop()],
      [
        'duplicate native row',
        (db: FakeDb) =>
          db.tables.get('identity_providers')!.push({ ...db.tables.get('identity_providers')![0] }),
      ],
      [
        'extra native row',
        (db: FakeDb) =>
          db.tables
            .get('identity_providers')!
            .push({ ...db.tables.get('identity_providers')![0], id: 'zzz' }),
      ],
      [
        'changed scalar',
        (db: FakeDb) => (db.tables.get('identity_providers')![1].name = 'changed'),
      ],
      ['wrong journal count', (db: FakeDb) => (db.journalCount = '2')],
      ['unparseable journal count', (db: FakeDb) => (db.journalCount = 'many')],
    ])('detects %s as a verification mismatch', async (_n, tamper) => {
      const { db, input } = await sealed();
      tamper(db);
      const outcome = await importer.verifySubset(input).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(outcome).toBeInstanceOf(_n === 'unparseable journal count' ? Invalid : Mismatch);
      expect(verifyReferences).not.toHaveBeenCalled();
    });
    it('detects a target row of another tenant or with an unusable id, and oversized pages', async () => {
      const cases: Array<(rows: Row[]) => Row[]> = [
        (rows) => rows.map((r, i) => (i === 1 ? { ...r, tenant_id: 'other' } : r)),
        (rows) => rows.map((r, i) => (i === 1 ? { ...r, id: '' } : r)),
        (rows) => rows.map((r, i) => (i === 1 ? { ...r, id: null } : r)),
        (rows) => rows.map((r, i) => (i === 1 ? { ...rows[0] } : r)),
        (rows) => Array.from({ length: 101 }, (_, i) => ({ ...rows[0], id: `p-${i}` })),
      ];
      for (const page of cases) {
        const { db, input } = await sealed();
        const real = db.query.bind(db);
        db.query = (async (sql: string, params?: unknown[]) => {
          const rows = await real(sql, params);
          return sql.includes('ORDER BY id LIMIT 100') ? page(rows as Row[]) : rows;
        }) as never;
        await expect(importer.verifySubset(input)).rejects.toSatisfy(
          (e) => e instanceof Mismatch || e instanceof Invalid
        );
      }
    });
    it('detects JSONB drift found by the native comparison during verification', async () => {
      plan = [C];
      const db = new FakeDb();
      const input = makeInput(db, makeBackup({ [C]: ids(2).map((id) => tagged(C, id)) }));
      await restoreAll(input);
      db.jsonbDifferent = true;
      await expect(importer.verifySubset(input)).rejects.toBeInstanceOf(Mismatch);
    });
    it('detects a target that has fewer rows than the source in the full scan', async () => {
      const { db, input } = await sealed();
      db.pageOverride = (rows) => rows.slice(0, 2);
      await expect(importer.verifySubset(input)).rejects.toBeInstanceOf(Mismatch);
    });
    it('detects a target with more rows than the source in the full scan', async () => {
      const { db, input } = await sealed();
      db.pageOverride = (rows) => [...rows, { ...rows[0], id: 'zzz' }];
      await expect(importer.verifySubset(input)).rejects.toBeInstanceOf(Mismatch);
    });
    it('pages the full scan by id and verifies large tables', async () => {
      const { db, input } = await sealed(230);
      const receipt = await importer.verifySubset(input);
      expect(receipt.tables[0].rowCount).toBe(230);
      const scans = db.sqls.filter((s) => s.includes('ORDER BY id LIMIT 100'));
      expect(scans).toHaveLength(3);
      expect(scans[0]).not.toContain('WHERE id>$1');
      expect(scans[1]).toContain('WHERE id>$1');
      const scanParams = db.sqls
        .map((sql, i) => (sql.includes('ORDER BY id LIMIT 100') ? db.params[i] : undefined))
        .filter((p) => p !== undefined);
      expect(scanParams).toEqual([[], ['id-0099'], ['id-0199']]);
    });
    it('exactly 100 rows requires a terminating empty page', async () => {
      const { db, input } = await sealed(100);
      const receipt = await importer.verifySubset(input);
      expect(receipt.tables[0].rowCount).toBe(100);
      expect(db.sqls.filter((s) => s.includes('ORDER BY id LIMIT 100'))).toHaveLength(2);
    });
    it('requires the operation revision to equal the verified journal length', async () => {
      const { db, input } = await sealed();
      db.op!.revision = '5';
      await expect(importer.verifySubset(input)).rejects.toBeInstanceOf(Mismatch);
    });
    it('does not record a receipt when the sealing update touches no row', async () => {
      const { db, input } = await sealed();
      db.verifyUpdateRows = 0;
      await expect(importer.verifySubset(input)).rejects.toBeInstanceOf(Invalid);
      db.verifyUpdateRows = 2;
      await expect(importer.verifySubset(input)).rejects.toBeInstanceOf(Invalid);
    });
    it('rejects a receipt that races with a revision change', async () => {
      const { db, input } = await sealed();
      db.beforeTx = () => {
        db.op!.revision = '9';
      };
      await expect(importer.verifySubset(input)).rejects.toBeInstanceOf(Mismatch);
    });
    it('rejects an operation that went back to loading during receipt recording', async () => {
      const { db, input } = await sealed(150);
      db.beforeTx = () => {
        db.op!.status = 'loading';
        db.op!.dataset_index = '0';
        db.op!.row_offset = '10';
        db.op!.cursor = '10';
      };
      await expect(importer.verifySubset(input)).rejects.toBeInstanceOf(Invalid);
    });
    it('reconciles an uncertain COMMIT only when the stored receipt matches', async () => {
      let { db, input } = await sealed();
      db.failAfterCommit.add(db.txCount + 1);
      const receipt = await importer.verifySubset(input);
      expect(db.op!.receipt_json).toBe(canonicalRestoreJson(receipt));
      ({ db, input } = await sealed());
      db.failAfterCommit.add(db.txCount + 1);
      db.verifyUpdateRows = 1; // update reported but nothing was stored
      await expect(importer.verifySubset(input)).rejects.toBeInstanceOf(Error);
      ({ db, input } = await sealed());
      db.failAfterCommit.add(db.txCount + 1);
      const real = db.execute.bind(db);
      db.execute = async (sql: string, params?: unknown[]) => {
        const r = await real(sql, params);
        if (sql.includes("SET status='native_subset_verified'")) db.op!.receipt_json = 'different';
        return r;
      };
      await expect(importer.verifySubset(input)).rejects.toBeInstanceOf(Error);
      // the conversion keeps validation classes and wraps unknown failures
      ({ db, input } = await sealed());
      db.beforeTx = (i) => {
        if (i > 0 && db.op?.status === 'sealed' && db.txCount > 0 && !db.failAfterCommit.size) {
          db.failAfterCommit.add(db.txCount);
          throw new Error('network');
        }
      };
      await expect(importer.verifySubset(input)).rejects.toBeInstanceOf(DsqlOperationError);
    });
  });
});
