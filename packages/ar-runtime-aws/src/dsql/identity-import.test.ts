import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransactionContext } from '@authrim/ar-lib-core/db/adapter';
import type { VerifiedTenantBackupV2 } from '../import/backup-reader';
import { POSTGRES_RESTORE_TABLE_CONTRACTS } from '../import/postgres-restore-table-contract';
import { createDsqlIdentityFixture, type DsqlIdentityFixture } from './identity-fixture';
import {
  createDsqlIdentityImportJournal,
  DsqlIdentityImportValidationError,
  DsqlIdentityVerificationMismatch,
  restoreDsqlIdentitySlice,
  verifyDsqlIdentitySubset,
  type DsqlIdentityImportDatabase,
  type DsqlIdentityImportInput,
} from './identity-import';
import { DsqlOperationError } from './adapter';

const schema = `authrim_dsql_identity_${'a'.repeat(32)}`;
type Row = Record<string, unknown>;
type State = {
  operation: Row | null;
  chunks: Map<number, Row>;
  native: Record<string, Row[]>;
  jsonbRaw: Map<string, string | null>;
};

/** Transactional SQL fake, including rollback and lost replies, not a DSQL compatibility claim. */
class Database implements DsqlIdentityImportDatabase {
  state: State = {
    operation: null,
    chunks: new Map(),
    native: { users_core: [], users_pii: [], passkeys: [] },
    jsonbRaw: new Map(),
  };
  failCommit: 'before' | 'after' | null = null;
  statements: string[] = [];
  mutationsPerTransaction: number[] = [];
  private mutations = 0;
  private tail: Promise<unknown> = Promise.resolve();

  async retryableTransaction<T>(callback: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const saved = structuredClone(this.state);
      this.mutations = 0;
      try {
        const result = await callback(this);
        const failure = this.failCommit;
        this.failCommit = null;
        this.mutationsPerTransaction.push(this.mutations);
        if (failure === 'before') {
          this.state = saved;
          throw new Error('private row in disconnected commit');
        }
        if (failure === 'after') throw new Error('committed without reply');
        return result;
      } catch (error) {
        if ((error as Error).message !== 'committed without reply') this.state = saved;
        throw error;
      }
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  async queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
    return (await this.query<T>(sql, params))[0] ?? null;
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.statements.push(sql);
    const name = /"authrim_dsql_identity_[a-f0-9]+"\."([a-z_]+)"/u.exec(sql)?.[1];
    if (!name) throw new Error('unknown SQL');
    let rows: Row[] = [];
    if (sql.startsWith('CREATE TABLE')) return [];
    if (name === 'authrim_identity_import_operation') {
      if (sql.startsWith('SELECT')) rows = this.state.operation ? [this.state.operation] : [];
      else if (sql.startsWith('INSERT')) {
        if (this.state.operation) throw new Error('duplicate operation');
        this.state.operation = {
          tenant_id: params[1],
          input_sha256: params[2],
          source_json: params[3],
          status: 'loading',
          dataset_index: 0,
          row_offset: 0,
          cursor: null,
          revision: 0,
          receipt_json: null,
        };
        this.mutations++;
        rows = [{}];
      } else if (sql.includes("SET status='native_subset_verified'")) {
        const operation = this.state.operation;
        if (
          operation &&
          operation.status === 'sealed' &&
          operation.tenant_id === params[2] &&
          operation.input_sha256 === params[3] &&
          operation.revision === params[4]
        ) {
          operation.status = 'native_subset_verified';
          operation.receipt_json = params[0];
          this.mutations++;
          rows = [{}];
        }
      } else if (sql.startsWith('UPDATE')) {
        const operation = this.state.operation;
        if (
          operation &&
          operation.status === 'loading' &&
          operation.tenant_id === params[6] &&
          operation.input_sha256 === params[7] &&
          operation.revision === params[8]
        ) {
          Object.assign(operation, {
            status: params[0],
            dataset_index: params[1],
            row_offset: params[2],
            cursor: params[3],
            revision: params[4],
          });
          this.mutations++;
          rows = [{}];
        }
      }
    } else if (name === 'authrim_identity_import_chunks') {
      if (sql.startsWith('INSERT')) {
        const revision = Number(params[0]);
        if (this.state.chunks.has(revision)) throw new Error('duplicate journal');
        this.state.chunks.set(revision, {
          tenant_id: params[1],
          input_sha256: params[2],
          chunk_json: params[3],
        });
        this.mutations++;
        rows = [{}];
      } else if (sql.includes('COUNT(*)')) rows = [{ count: String(this.state.chunks.size) }];
      else if (sql.includes('WHERE revision=')) {
        const row = this.state.chunks.get(Number(params[0]));
        rows = row ? [row] : [];
      } else rows = [...this.state.chunks.values()].slice(0, 1);
    } else {
      const native = this.state.native[name];
      if (!native) throw new Error('unknown native table');
      if (sql.startsWith('INSERT')) {
        const spec = POSTGRES_RESTORE_TABLE_CONTRACTS.find((entry) => entry.table === name);
        if (!spec) throw new Error('unknown source contract');
        for (let offset = 0; offset < params.length; offset += spec.columns.length) {
          const values = params.slice(offset, offset + spec.columns.length);
          const row = Object.fromEntries(
            spec.columns.map((column, index) => {
              const value = values[index];
              if (!spec.postgresJsonbColumns.includes(column) || value === null)
                return [column, value];
              if (typeof value !== 'string') throw new Error('invalid JSONB parameter');
              return [column, JSON.parse(value)];
            })
          );
          if (native.some((entry) => entry.id === row.id)) throw new DsqlOperationError('23505');
          if (
            name === 'passkeys' &&
            native.some(
              (entry) =>
                entry.tenant_id === row.tenant_id && entry.credential_id === row.credential_id
            )
          )
            throw new DsqlOperationError('23505');
          native.push(row);
          for (const column of spec.postgresJsonbColumns) {
            const raw = values[spec.columns.indexOf(column)];
            if (raw !== null && typeof raw !== 'string') throw new Error('invalid JSONB parameter');
            if (typeof row.id !== 'string') throw new Error('invalid row identity');
            this.state.jsonbRaw.set(`${name}/${row.id}/${column}`, raw);
          }
          this.mutations++;
          rows.push(row);
        }
      } else if (sql.includes('IS DISTINCT FROM expected.value')) {
        const column = /actual\."([a-z_]+)" IS DISTINCT/u.exec(sql)?.[1];
        if (!column) throw new Error('unknown JSONB comparison');
        for (let index = 0; index < params.length - 1; index += 2) {
          const id = params[index];
          if (typeof id !== 'string') throw new Error('invalid JSONB identity');
          const row = native.find((entry) => entry.id === id && entry.tenant_id === params.at(-1));
          const raw = this.state.jsonbRaw.get(`${name}/${id}/${column}`);
          // The fake preserves the original raw value solely to model precision-sensitive checks.
          if (
            !row ||
            raw !== params[index + 1] ||
            (raw !== undefined &&
              JSON.stringify(row[column]) !== JSON.stringify(raw === null ? null : JSON.parse(raw)))
          ) {
            rows = [{}];
            break;
          }
        }
      } else if (sql.includes('LEFT JOIN')) {
        const owner = name === 'passkeys' ? 'user_id' : 'id';
        const parents = this.state.native[name === 'users_core' ? 'users_pii' : 'users_core'];
        rows = native
          .filter(
            (child) =>
              !parents.some(
                (parent) => parent.id === child[owner] && parent.tenant_id === child.tenant_id
              )
          )
          .slice(0, 1);
      } else if (sql.includes('WHERE id=ANY($1)')) {
        rows = native.filter(
          (row) => (params[0] as unknown[]).includes(row.id) && row.tenant_id === params[1]
        );
      } else if (sql.includes('ORDER BY id')) {
        rows = native
          .filter((row) => !params.length || String(row.id) > String(params[0]))
          .sort((a, b) => String(a.id).localeCompare(String(b.id)))
          .slice(0, 100);
      } else if (sql.startsWith('SELECT 1')) rows = native.slice(0, 1);
      else throw new Error('unknown native query');
    }
    return structuredClone(rows) as T[];
  }

  async execute(sql: string, params?: unknown[]) {
    return { success: true, rowsAffected: (await this.query(sql, params)).length };
  }
}

let fixture: DsqlIdentityFixture;
let db: Database;
let input: DsqlIdentityImportInput;

beforeEach(async () => {
  fixture = await createDsqlIdentityFixture({ userCount: 3 });
  db = new Database();
  input = {
    db,
    schema,
    backup: fixture.backup,
    tenantId: fixture.tenantId,
    trustedReceiptSha256: fixture.trustedReceiptDigest,
    maxRowsPerChunk: 2,
  };
});
afterEach(async () => fixture?.close());

async function seal(value = input) {
  for (let attempts = 0; attempts < 30; attempts++) {
    const result = await restoreDsqlIdentitySlice(value);
    if (result.status !== 'loading') return result;
  }
  throw new Error('did not finish');
}

function changeSource(
  datasetId: string,
  edit: (row: Row, index: number) => void
): VerifiedTenantBackupV2 {
  return {
    manifest: fixture.backup.manifest,
    close: () => Promise.resolve(),
    dataset(id) {
      const source = fixture.backup.dataset(id);
      let index = 0;
      return {
        ...source,
        async readNextRow(cursor) {
          const next = await source.readNextRow(cursor);
          if (!next || id !== datasetId) return next;
          const row = JSON.parse(next.rowJson) as Row;
          edit(row, index++);
          return { ...next, rowJson: JSON.stringify(row) };
        },
      };
    },
  };
}

describe('bounded native DSQL identity subset import', () => {
  it('creates each journal in a separate statement and reports confirmed DDL only', async () => {
    const events: string[] = [];
    await createDsqlIdentityImportJournal(db, schema, {
      onProgress: (event) => events.push(`${event.name}:${event.status}`),
    });
    expect(db.statements).toHaveLength(2);
    expect(db.statements.every((sql) => sql.startsWith('CREATE TABLE'))).toBe(true);
    expect(events.map((event) => event.split(':')[1])).toEqual([
      'attempted',
      'created',
      'attempted',
      'created',
    ]);
    await expect(createDsqlIdentityImportJournal(db, 'public')).rejects.toThrow(
      'aurora_dsql_identity_import_invalid'
    );
  });

  it('never reports unsuccessful journal DDL as confirmed', async () => {
    const events: string[] = [];
    await expect(
      createDsqlIdentityImportJournal(
        { execute: async () => ({ success: false, rowsAffected: 0 }) },
        schema,
        {
          onProgress: (event) => events.push(event.status),
        }
      )
    ).rejects.toBeInstanceOf(DsqlOperationError);
    expect(events).toEqual(['attempted']);
  });

  it('resumes after reopening the encrypted source and verifies exact native types without activation', async () => {
    expect(await restoreDsqlIdentitySlice(input)).toMatchObject({
      status: 'loading',
      rowOffset: 2,
      revision: 1,
    });
    input.backup = await fixture.reopen();
    expect(await seal()).toMatchObject({ status: 'sealed', datasetIndex: 3 });
    const receipt = await verifyDsqlIdentitySubset(input);
    expect(receipt).toMatchObject({
      status: 'native_subset_verified',
      fullRuntimeReady: false,
      scope: 'three-table-identity-evaluation',
    });
    expect(receipt.tables.map((entry) => entry.rowCount)).toEqual([3, 3, 3]);
    expect(receipt.omittedDatasets).toHaveLength(15);
    expect(db.state.native.users_core[0].email_verified).toBe(true);
    expect(db.state.native.users_pii[0].custom_attributes_json).toMatchObject({
      purpose: 'DSQL適合試験',
      ordinal: 0,
    });
    expect(db.state.native.passkeys[0].counter).toBe('9007199254740993');
    expect(db.mutationsPerTransaction.every((count) => count <= 4)).toBe(true);
    expect(await verifyDsqlIdentitySubset(input)).toEqual(receipt);
  });

  it('caps default transactions at102 modifications and verifies multiple ordered readback pages', async () => {
    await fixture.close();
    fixture = await createDsqlIdentityFixture({ userCount: 101 });
    input = {
      ...input,
      backup: fixture.backup,
      trustedReceiptSha256: fixture.trustedReceiptDigest,
      maxRowsPerChunk: undefined,
    };
    await seal();
    const receipt = await verifyDsqlIdentitySubset(input);
    expect(receipt.tables.map((entry) => entry.rowCount)).toEqual([101, 101, 101]);
    expect(Math.max(...db.mutationsPerTransaction)).toBe(102);
    expect(db.state.chunks.size).toBe(6);
    expect(db.statements.filter((sql) => sql.includes('WHERE id>$1 ORDER BY id'))).toHaveLength(3);
  });

  it.each(['before', 'after'] as const)(
    'reconciles a commit reply lost %s the commit without duplicate native rows',
    async (failure) => {
      await restoreDsqlIdentitySlice(input);
      db.failCommit = failure;
      if (failure === 'before')
        await expect(restoreDsqlIdentitySlice(input)).rejects.toBeInstanceOf(DsqlOperationError);
      else
        expect(await restoreDsqlIdentitySlice(input)).toMatchObject({
          datasetIndex: 1,
          rowOffset: 0,
        });
      await seal();
      expect((await verifyDsqlIdentitySubset(input)).tables.map((entry) => entry.rowCount)).toEqual(
        [3, 3, 3]
      );
      expect(db.state.native.users_core).toHaveLength(3);
    }
  );

  it('serializes concurrent identical chunks by the durable chunk identity', async () => {
    await restoreDsqlIdentitySlice(input);
    const results = await Promise.all([
      restoreDsqlIdentitySlice(input),
      restoreDsqlIdentitySlice(input),
    ]);
    expect(results.map((result) => result.revision)).toEqual([2, 2]);
    expect(db.state.native.users_core).toHaveLength(3);
  });

  it('pins source snapshot, trusted receipt, tenant and chunk policy across resume', async () => {
    await restoreDsqlIdentitySlice(input);
    const changedManifest = structuredClone(input.backup.manifest);
    changedManifest.snapshotId += '-changed';
    for (const override of [
      { trustedReceiptSha256: '0'.repeat(64) },
      { tenantId: 'another-tenant' },
      { maxRowsPerChunk: 1 },
      { backup: { ...input.backup, manifest: changedManifest } },
    ])
      await expect(restoreDsqlIdentitySlice({ ...input, ...override })).rejects.toThrow(
        'aurora_dsql_identity_import_invalid'
      );
    expect(db.state.native.users_core).toHaveLength(2);
  });

  it.each([
    [
      'cross-tenant',
      (row: Row) => {
        row.tenant_id = ['text', 'other-tenant'];
      },
    ],
    [
      'wrong boolean',
      (row: Row) => {
        row.email_verified = ['integer', '2'];
      },
    ],
    [
      'noncanonical integer',
      (row: Row) => {
        row.created_at = ['integer', '01'];
      },
    ],
    [
      'unknown column',
      (row: Row) => {
        row.secret = ['text', 'private'];
      },
    ],
  ] as const)('rejects %s source rows with no native writes', async (_name, edit) => {
    input.backup = changeSource('core.users_core', edit);
    await expect(restoreDsqlIdentitySlice(input)).rejects.toBeInstanceOf(
      DsqlIdentityImportValidationError
    );
    expect(db.state.native.users_core).toHaveLength(0);
  });

  it('rejects a duplicate native ID across chunks and rolls back its journal/progress', async () => {
    input.maxRowsPerChunk = 1;
    input.backup = changeSource('core.users_core', (row) => {
      row.id = ['text', 'same-id'];
    });
    await restoreDsqlIdentitySlice(input);
    await expect(restoreDsqlIdentitySlice(input)).rejects.toBeInstanceOf(DsqlOperationError);
    expect(db.state.native.users_core).toHaveLength(1);
    expect(db.state.chunks.size).toBe(1);
    expect(db.state.operation?.row_offset).toBe(1);
  });

  it('enforces source byte/row limits and refuses nonempty targets', async () => {
    await expect(restoreDsqlIdentitySlice({ ...input, maxRowsPerChunk: 101 })).rejects.toThrow(
      'aurora_dsql_identity_import_invalid'
    );
    await expect(restoreDsqlIdentitySlice({ ...input, maxBytesPerChunk: 1 })).rejects.toThrow(
      'aurora_dsql_identity_import_invalid'
    );
    db = new Database();
    db.state.native.users_pii.push({ id: 'preexisting' });
    await expect(restoreDsqlIdentitySlice({ ...input, db })).rejects.toThrow(
      'aurora_dsql_identity_import_invalid'
    );
    expect(db.state.operation).toBeNull();
  });

  it('requires sealing before verification and refuses loading writes after seal', async () => {
    await restoreDsqlIdentitySlice(input);
    await expect(verifyDsqlIdentitySubset(input)).rejects.toBeInstanceOf(
      DsqlIdentityImportValidationError
    );
    await seal();
    const before = structuredClone(db.state);
    expect(await restoreDsqlIdentitySlice(input)).toMatchObject({ status: 'sealed' });
    expect(db.state).toEqual(before);
  });

  it('rejects passkey owners absent from the same-tenant Core users', async () => {
    input.backup = changeSource('core.passkeys', (row) => {
      row.user_id = ['text', 'absent-owner'];
    });
    await seal();
    await expect(verifyDsqlIdentitySubset(input)).rejects.toBeInstanceOf(
      DsqlIdentityVerificationMismatch
    );
    expect(db.state.operation?.status).toBe('sealed');
  });

  it('requires a PII row for every Core user in this deliberately narrow evaluation', async () => {
    input.backup = {
      ...fixture.backup,
      dataset(id) {
        const source = fixture.backup.dataset(id);
        return id === 'core.users_core'
          ? source
          : { ...source, rows: 0, bytes: 0, readNextRow: async () => null };
      },
    };
    await seal();
    await expect(verifyDsqlIdentitySubset(input)).rejects.toBeInstanceOf(
      DsqlIdentityVerificationMismatch
    );
  });

  it.each(['digest', 'missing', 'extra', 'revision'] as const)(
    'rejects %s journal evidence despite matching native data',
    async (mutation) => {
      await seal();
      const first = db.state.chunks.get(1);
      const operation = db.state.operation;
      if (!first || !operation) throw new Error('missing test evidence');
      if (mutation === 'digest') first.chunk_json = '{}';
      if (mutation === 'missing') db.state.chunks.delete(1);
      if (mutation === 'extra') db.state.chunks.set(999, structuredClone(first));
      if (mutation === 'revision') operation.revision = 999;
      await expect(verifyDsqlIdentitySubset(input)).rejects.toBeInstanceOf(
        DsqlIdentityVerificationMismatch
      );
      expect(db.state.operation?.status).toBe('sealed');
    }
  );

  it('does not misreport a database outage as a successful negative validation test', async () => {
    await seal();
    vi.spyOn(db, 'query').mockRejectedValueOnce(new DsqlOperationError('08006'));
    await expect(verifyDsqlIdentitySubset(input)).rejects.toBeInstanceOf(DsqlOperationError);
  });

  it('compares JSONB natively so large-number tampering cannot hide behind JavaScript rounding', async () => {
    await seal();
    await verifyDsqlIdentitySubset(input);
    const key = 'users_pii/synthetic-user-000000/custom_attributes_json';
    const raw = db.state.jsonbRaw.get(key);
    if (!raw) throw new Error('missing precise JSON fixture');
    expect(raw).toContain('9007199254740993');
    const corrupted = raw.replace('9007199254740993', '9007199254740992');
    expect(JSON.parse(raw)).toEqual(JSON.parse(corrupted));
    db.state.jsonbRaw.set(key, corrupted);
    await expect(verifyDsqlIdentitySubset(input)).rejects.toBeInstanceOf(
      DsqlIdentityVerificationMismatch
    );
    db.state.jsonbRaw.set(key, raw);
    await expect(verifyDsqlIdentitySubset(input)).resolves.toMatchObject({
      status: 'native_subset_verified',
    });
    expect(
      db.statements.some(
        (sql) => sql.includes('::jsonb') && sql.includes('IS DISTINCT FROM expected.value')
      )
    ).toBe(true);
  });

  it('handles empty datasets with durable transitions and rejects early source EOF', async () => {
    input.backup = {
      ...fixture.backup,
      dataset(id) {
        const source = fixture.backup.dataset(id);
        return { ...source, rows: 0, bytes: 0, readNextRow: async () => null };
      },
    };
    await seal();
    expect((await verifyDsqlIdentitySubset(input)).tables.map((entry) => entry.rowCount)).toEqual([
      0, 0, 0,
    ]);
    expect(db.state.chunks.size).toBe(3);
    const early: DsqlIdentityImportInput = {
      ...input,
      db: new Database(),
      backup: {
        ...fixture.backup,
        dataset: (id) => ({ ...fixture.backup.dataset(id), readNextRow: async () => null }),
      },
    };
    await expect(restoreDsqlIdentitySlice(early)).rejects.toBeInstanceOf(
      DsqlIdentityImportValidationError
    );
  });

  it.each(['changed', 'extra', 'missing', 'cross-tenant'] as const)(
    'rechecks previously verified native rows and rejects %s data',
    async (mutation) => {
      await seal();
      await verifyDsqlIdentitySubset(input);
      if (mutation === 'changed') db.state.native.users_pii[0].name = 'changed private value';
      if (mutation === 'extra')
        db.state.native.users_core.push({ ...db.state.native.users_core[0], id: 'extra-user' });
      if (mutation === 'missing') db.state.native.passkeys.pop();
      if (mutation === 'cross-tenant') db.state.native.users_core[0].tenant_id = 'other-tenant';
      await expect(verifyDsqlIdentitySubset(input)).rejects.toBeInstanceOf(
        DsqlIdentityVerificationMismatch
      );
    }
  );
});
