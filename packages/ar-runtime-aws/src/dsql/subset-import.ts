import { createHash } from 'node:crypto';
import type { TransactionContext } from '@authrim/ar-lib-core/db/adapter';
import type { VerifiedTenantBackupV2 } from '../import/backup-reader';
import {
  POSTGRES_RESTORE_TABLE_CONTRACTS,
  type PostgresRestoreTableContract,
} from '../import/postgres-restore-table-contract';
import { canonicalRestoreJson, restoreEvidenceDigest } from '../import/restore-evidence';
import { DsqlOperationError } from './adapter';

const MAX_ROWS = 100;
const MAX_BYTES = 512 * 1024;
const HASH = /^[a-f0-9]{64}$/u;
const INTEGER = /^(0|-?[1-9][0-9]{0,18})$/u;
const utf8 = new TextEncoder();
type Value = string | boolean | null;
type Status = 'loading' | 'sealed' | 'native_subset_verified';

export interface DsqlSubsetImportDatabase extends TransactionContext {
  retryableTransaction<T>(callback: (tx: TransactionContext) => Promise<T>): Promise<T>;
}

export interface DsqlSubsetImportInput {
  db: DsqlSubsetImportDatabase;
  schema: string;
  backup: VerifiedTenantBackupV2;
  tenantId: string;
  /** SHA256 of the independently trusted export receipt used to open this verified backup. */
  trustedReceiptSha256: string;
  maxRowsPerChunk?: number;
  maxBytesPerChunk?: number;
}

export interface DsqlSubsetImportProgress {
  status: Status;
  fullRuntimeReady: false;
  datasetIndex: number;
  rowOffset: number;
  revision: number;
}

export interface DsqlSubsetReceipt<Scope extends string> {
  formatVersion: 1;
  status: 'native_subset_verified';
  scope: Scope;
  fullRuntimeReady: false;
  schema: string;
  tenantId: string;
  inputSha256: string;
  sourceContractFingerprint: string;
  tables: {
    datasetId: string;
    rowCount: number;
    /** Application-view digest in source order; raw JSONB is pinned separately by chunk journals. */
    sourceSha256: string;
    /** Application-view digest in ID order; exact JSONB equality is checked natively, not by this hash. */
    targetSha256: string;
  }[];
  omittedDatasets: string[];
  digestSha256: string;
}

interface Operation {
  tenant_id: string;
  input_sha256: string;
  source_json: string;
  status: string;
  dataset_index: number | string;
  row_offset: number | string;
  cursor: string | null;
  revision: number | string;
  receipt_json: string | null;
}

/** Internal profiles share bounded import mechanics, never readiness or serving admission. */
export interface DsqlSubsetImportProfile<Scope extends string> {
  scope: Scope;
  operationId: string;
  journalTables: readonly [string, string];
  assertSchemaName(schema: string): void;
  schemaPlan(schema: string): {
    sourceContractFingerprint: string;
    tables: ReadonlyArray<{ datasetId: string }>;
  };
  ValidationError: new () => Error;
  VerificationMismatch: new () => Error;
  verifyReferences(db: TransactionContext, schema: string, tenantId: string): Promise<void>;
}

export function createDsqlSubsetImporter<Scope extends string>(
  profile: DsqlSubsetImportProfile<Scope>
) {
  function invalid(): never {
    throw new profile.ValidationError();
  }

  function mismatch(): never {
    throw new profile.VerificationMismatch();
  }

  function failure(error: unknown): never {
    if (
      error instanceof profile.ValidationError ||
      error instanceof profile.VerificationMismatch ||
      error instanceof DsqlOperationError
    )
      throw error;
    throw new DsqlOperationError();
  }

  function parseJson(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      invalid();
    }
  }

  function table(schema: string, name: string): string {
    try {
      profile.assertSchemaName(schema);
    } catch {
      invalid();
    }
    if (!/^[a-z][a-z0-9_]*$/u.test(name)) invalid();
    return `"${schema}"."${name}"`;
  }

  function count(value: unknown): number {
    if (typeof value !== 'string' && typeof value !== 'number') invalid();
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0 || String(number) !== String(value)) invalid();
    return number;
  }

  function hashRows() {
    const hash = createHash('sha256');
    return {
      add(value: unknown) {
        const text = canonicalRestoreJson(value);
        hash
          .update(String(utf8.encode(text).byteLength))
          .update(':')
          .update(text);
      },
      digest: () => hash.digest('hex'),
    };
  }

  function normalizeSource(
    json: string,
    spec: PostgresRestoreTableContract,
    tenantId: string
  ): { values: Value[]; normalized: Value[]; id: string } {
    const raw = parseJson(json);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid();
    const row = raw as Record<string, unknown>;
    if (
      Object.keys(row).length !== spec.columns.length ||
      Object.keys(row).some((column) => !spec.columns.includes(column))
    )
      invalid();
    const values: Value[] = [];
    const normalized: Value[] = [];
    for (const column of spec.columns) {
      const tagged = row[column];
      if (!Array.isArray(tagged) || tagged.length !== 2) invalid();
      const tag: unknown = tagged[0];
      const value: unknown = tagged[1];
      if (tag === 'null' && value === null) {
        values.push(null);
        normalized.push(null);
      } else if (spec.sqliteIntegerColumns.includes(column)) {
        if (tag !== 'integer' || typeof value !== 'string' || !INTEGER.test(value)) invalid();
        const integer = BigInt(value);
        if (integer < -(2n ** 63n) || integer > 2n ** 63n - 1n) invalid();
        if (spec.postgresBooleanColumns.includes(column)) {
          if (value !== '0' && value !== '1') invalid();
          values.push(value === '1');
          normalized.push(value === '1');
        } else {
          values.push(value);
          normalized.push(value);
        }
      } else {
        if (tag !== 'text' || typeof value !== 'string') invalid();
        values.push(value);
        normalized.push(
          spec.postgresJsonbColumns.includes(column)
            ? canonicalRestoreJson(parseJson(value))
            : value
        );
      }
    }
    const tenant = normalized[spec.columns.indexOf(spec.tenantColumn)];
    const id = normalized[spec.columns.indexOf('id')];
    if (tenant !== tenantId || typeof id !== 'string' || !id || id.includes('\0')) invalid();
    return { values, normalized, id };
  }

  function normalizeTarget(
    row: Record<string, unknown>,
    spec: PostgresRestoreTableContract
  ): Value[] {
    return spec.columns.map((column) => {
      const value = row[column];
      if (value === null) return null;
      if (spec.postgresBooleanColumns.includes(column)) {
        if (typeof value !== 'boolean') invalid();
        return value;
      }
      if (spec.sqliteIntegerColumns.includes(column)) {
        if (typeof value !== 'string' && typeof value !== 'number') invalid();
        const text = String(value);
        if (!INTEGER.test(text)) invalid();
        const integer = BigInt(text);
        if (integer < -(2n ** 63n) || integer > 2n ** 63n - 1n) invalid();
        return text;
      }
      if (spec.postgresJsonbColumns.includes(column)) return canonicalRestoreJson(value);
      if (typeof value !== 'string') invalid();
      return value;
    });
  }

  function sameScalarColumns(
    expected: Value[],
    actual: Value[],
    spec: PostgresRestoreTableContract
  ): boolean {
    return spec.columns.every((column, index) =>
      spec.postgresJsonbColumns.includes(column) ? true : expected[index] === actual[index]
    );
  }

  /** JSONB equality belongs to the database: JavaScript numbers cannot preserve every JSON number. */
  async function assertNativeJsonbEquality(
    db: TransactionContext,
    ctx: Context,
    spec: PostgresRestoreTableContract,
    rows: readonly ReturnType<typeof normalizeSource>[]
  ): Promise<void> {
    if (!rows.length) return;
    for (const column of spec.postgresJsonbColumns) {
      const position = spec.columns.indexOf(column);
      const values = rows.flatMap((row) => [row.id, row.values[position]]);
      const tuples = rows.map((_, index) => `($${index * 2 + 1}::text,$${index * 2 + 2}::jsonb)`);
      values.push(ctx.tenantId);
      const different = await db.queryOne(
        `SELECT 1 FROM (VALUES ${tuples.join(',')}) expected(id,value) LEFT JOIN ${table(ctx.schema, spec.table)} actual ON actual.id=expected.id AND actual.tenant_id=$${values.length} WHERE actual.id IS NULL OR actual."${column}" IS DISTINCT FROM expected.value LIMIT 1`,
        values
      );
      if (different) mismatch();
    }
  }

  function context(input: DsqlSubsetImportInput) {
    const plan = profile.schemaPlan(input.schema);
    const manifest = structuredClone(input.backup.manifest);
    const maxRows = input.maxRowsPerChunk ?? MAX_ROWS;
    const maxBytes = input.maxBytesPerChunk ?? MAX_BYTES;
    if (
      !input.tenantId ||
      input.tenantId !== manifest.source.tenantId ||
      !HASH.test(input.trustedReceiptSha256) ||
      !Number.isSafeInteger(maxRows) ||
      maxRows < 1 ||
      maxRows > MAX_ROWS ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > MAX_BYTES
    )
      invalid();
    const specs = plan.tables.map(({ datasetId: id }) => {
      const spec = POSTGRES_RESTORE_TABLE_CONTRACTS.find((candidate) => candidate.datasetId === id);
      const descriptor = manifest.datasets.find((candidate) => candidate.id === id);
      if (!spec || descriptor?.store !== 'database' || descriptor.disposition !== 'include')
        invalid();
      return spec;
    });
    const sources = specs.map((spec) => {
      const source = input.backup.dataset(spec.datasetId);
      if (source.id !== spec.datasetId) invalid();
      count(source.rows);
      count(source.bytes);
      return source;
    });
    const sourceJson = canonicalRestoreJson({
      formatVersion: 1,
      scope: profile.scope,
      schema: input.schema,
      tenantId: input.tenantId,
      trustedReceiptSha256: input.trustedReceiptSha256,
      manifest,
      sourceContractFingerprint: plan.sourceContractFingerprint,
      contracts: specs,
      datasets: sources.map(({ id, rows, bytes }) => ({ id, rows, bytes })),
      chunkPolicy: { maxRows, maxBytes },
    });
    const inputSha256 = createHash('sha256').update(sourceJson).digest('hex');
    return {
      ...input,
      maxRows,
      maxBytes,
      specs,
      sources,
      manifest,
      sourceJson,
      inputSha256,
      fingerprint: plan.sourceContractFingerprint,
      operation: table(input.schema, profile.journalTables[0]),
      chunks: table(input.schema, profile.journalTables[1]),
    };
  }

  type Context = ReturnType<typeof context>;

  function progress(ctx: Context, row: Operation): DsqlSubsetImportProgress {
    const datasetIndex = count(row.dataset_index);
    const rowOffset = count(row.row_offset);
    const revision = count(row.revision);
    if (
      row.tenant_id !== ctx.tenantId ||
      row.input_sha256 !== ctx.inputSha256 ||
      row.source_json !== ctx.sourceJson ||
      !['loading', 'sealed', 'native_subset_verified'].includes(row.status) ||
      datasetIndex > ctx.specs.length ||
      (row.status === 'loading') !== datasetIndex < ctx.specs.length ||
      (datasetIndex === ctx.specs.length && (rowOffset !== 0 || row.cursor !== null)) ||
      (datasetIndex < ctx.specs.length && rowOffset > ctx.sources[datasetIndex].rows) ||
      (rowOffset === 0 && row.cursor !== null) ||
      (rowOffset > 0 && (typeof row.cursor !== 'string' || !row.cursor))
    )
      invalid();
    return {
      status: row.status as Status,
      fullRuntimeReady: false,
      datasetIndex,
      rowOffset,
      revision,
    };
  }

  async function readOperation(ctx: Context, db: TransactionContext = ctx.db) {
    return db.queryOne<Operation>(
      `SELECT tenant_id,input_sha256,source_json,status,dataset_index,row_offset,cursor,revision,receipt_json FROM ${ctx.operation} WHERE operation_id=$1`,
      [profile.operationId]
    );
  }

  /** Separate autocommit DDL, only inside an already-created, isolated evaluation schema. */
  async function createJournal(
    db: Pick<TransactionContext, 'execute'>,
    schema: string,
    options: {
      onProgress?: (event: {
        kind: 'table';
        name: string;
        status: 'attempted' | 'created';
      }) => void;
    } = {}
  ): Promise<void> {
    try {
      const definitions = [
        `operation_id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,input_sha256 TEXT NOT NULL,source_json TEXT NOT NULL,status TEXT NOT NULL,dataset_index BIGINT NOT NULL,row_offset BIGINT NOT NULL,cursor TEXT,revision BIGINT NOT NULL,receipt_json TEXT`,
        `revision BIGINT PRIMARY KEY,tenant_id TEXT NOT NULL,input_sha256 TEXT NOT NULL,chunk_json TEXT NOT NULL`,
      ];
      for (const [index, name] of profile.journalTables.entries()) {
        const qualified = table(schema, name);
        options.onProgress?.({ kind: 'table', name, status: 'attempted' });
        const result = await db.execute(`CREATE TABLE ${qualified} (${definitions[index]})`);
        if (!result.success) throw new DsqlOperationError();
        options.onProgress?.({ kind: 'table', name, status: 'created' });
      }
    } catch (error) {
      failure(error);
    }
  }

  async function initialize(ctx: Context): Promise<Operation> {
    try {
      await ctx.db.retryableTransaction(async (tx) => {
        const prior = await readOperation(ctx, tx);
        if (prior) {
          progress(ctx, prior);
          return;
        }
        for (const spec of ctx.specs) {
          if (await tx.queryOne(`SELECT 1 FROM ${table(ctx.schema, spec.table)} LIMIT 1`))
            invalid();
        }
        if (await tx.queryOne(`SELECT 1 FROM ${ctx.chunks} LIMIT 1`)) invalid();
        const result = await tx.execute(
          `INSERT INTO ${ctx.operation} (operation_id,tenant_id,input_sha256,source_json,status,dataset_index,row_offset,cursor,revision,receipt_json) VALUES ($1,$2,$3,$4,'loading',0,0,NULL,0,NULL)`,
          [profile.operationId, ctx.tenantId, ctx.inputSha256, ctx.sourceJson]
        );
        if (result.rowsAffected !== 1) invalid();
      });
    } catch (error) {
      // A lost COMMIT response is reconciled only against the exact durable source pin.
      const prior = await readOperation(ctx);
      if (!prior) failure(error);
      progress(ctx, prior);
      return prior;
    }
    const row = await readOperation(ctx);
    if (!row) invalid();
    progress(ctx, row);
    return row;
  }

  async function materializeChunk(
    ctx: Context,
    datasetIndex: number,
    rowOffset: number,
    beforeCursor: string | null
  ) {
    const source = ctx.sources[datasetIndex];
    const spec = ctx.specs[datasetIndex];
    let cursor = beforeCursor;
    let bytes = 0;
    const rows: ReturnType<typeof normalizeSource>[] = [];
    const sourceHash = hashRows();
    const normalizedHash = hashRows();
    while (rows.length < ctx.maxRows && rowOffset + rows.length < source.rows) {
      const next = await source.readNextRow(cursor);
      if (!next || next.nextCursor === cursor) invalid();
      const size = utf8.encode(next.rowJson).byteLength;
      if (size > ctx.maxBytes) invalid();
      if (bytes + size > ctx.maxBytes) break;
      const row = normalizeSource(next.rowJson, spec, ctx.tenantId);
      if (rows.some((prior) => prior.id === row.id)) invalid();
      rows.push(row);
      sourceHash.add(next.rowJson);
      normalizedHash.add(row.normalized);
      bytes += size;
      cursor = next.nextCursor;
    }
    const complete = rowOffset + rows.length === source.rows;
    if (complete && (await source.readNextRow(cursor)) !== null) invalid();
    if (!complete && rows.length === 0) invalid();
    const after = {
      datasetIndex: complete ? datasetIndex + 1 : datasetIndex,
      rowOffset: complete ? 0 : rowOffset + rows.length,
      cursor: complete ? null : cursor,
    };
    const chunkJson = canonicalRestoreJson({
      formatVersion: 1,
      datasetId: spec.datasetId,
      before: { datasetIndex, rowOffset, cursor: beforeCursor },
      after,
      rows: rows.length,
      bytes,
      sourceSha256: sourceHash.digest(),
      normalizedSha256: normalizedHash.digest(),
    });
    return { rows, after, chunkJson };
  }

  /** At most 100 native inserts + one journal insert + one progress update per transaction. */
  async function restoreSlice(input: DsqlSubsetImportInput): Promise<DsqlSubsetImportProgress> {
    try {
      const ctx = context(input);
      const previous = (await readOperation(ctx)) ?? (await initialize(ctx));
      const before = progress(ctx, previous);
      if (before.status !== 'loading') return before;
      const spec = ctx.specs[before.datasetIndex];
      const { rows, after, chunkJson } = await materializeChunk(
        ctx,
        before.datasetIndex,
        before.rowOffset,
        previous.cursor
      );
      const status = after.datasetIndex === ctx.specs.length ? 'sealed' : 'loading';
      const revision = before.revision + 1;
      const checkJournal = async (db: TransactionContext) => {
        const journal = await db.queryOne<{
          tenant_id: string;
          input_sha256: string;
          chunk_json: string;
        }>(`SELECT tenant_id,input_sha256,chunk_json FROM ${ctx.chunks} WHERE revision=$1`, [
          revision,
        ]);
        if (!journal) return false;
        if (
          journal.tenant_id !== ctx.tenantId ||
          journal.input_sha256 !== ctx.inputSha256 ||
          journal.chunk_json !== chunkJson
        )
          invalid();
        return true;
      };
      try {
        await ctx.db.retryableTransaction(async (tx) => {
          const current = await readOperation(ctx, tx);
          if (!current) invalid();
          const state = progress(ctx, current);
          if (state.revision !== before.revision) {
            if (!(await checkJournal(tx))) invalid();
            if (state.revision < revision) invalid();
            return;
          }
          if (
            current.status !== 'loading' ||
            current.cursor !== previous.cursor ||
            state.datasetIndex !== before.datasetIndex ||
            state.rowOffset !== before.rowOffset
          )
            invalid();
          const columns = spec.columns.map((name) => `"${name}"`).join(',');
          const started = Date.now();
          const assertTimeBudget = () => {
            if (Date.now() - started > 120_000) throw new DsqlOperationError();
          };
          if (rows.length) {
            assertTimeBudget();
            const placeholders = rows
              .map(
                (_, rowIndex) =>
                  `(${spec.columns.map((_, columnIndex) => `$${rowIndex * spec.columns.length + columnIndex + 1}`).join(',')})`
              )
              .join(',');
            const inserted = await tx.query<Record<string, unknown>>(
              `INSERT INTO ${table(ctx.schema, spec.table)} (${columns}) VALUES ${placeholders} RETURNING ${columns}`,
              rows.flatMap((row) => row.values)
            );
            const byId = new Map(inserted.map((row) => [row.id, row]));
            if (inserted.length !== rows.length || byId.size !== rows.length) invalid();
            for (const row of rows) {
              const actual = byId.get(row.id);
              if (
                !actual ||
                !sameScalarColumns(row.normalized, normalizeTarget(actual, spec), spec)
              )
                invalid();
            }
            await assertNativeJsonbEquality(tx, ctx, spec, rows);
          }
          assertTimeBudget();
          const journal = await tx.execute(
            `INSERT INTO ${ctx.chunks} (revision,tenant_id,input_sha256,chunk_json) VALUES ($1,$2,$3,$4)`,
            [revision, ctx.tenantId, ctx.inputSha256, chunkJson]
          );
          if (journal.rowsAffected !== 1) invalid();
          const changed = await tx.execute(
            `UPDATE ${ctx.operation} SET status=$1,dataset_index=$2,row_offset=$3,cursor=$4,revision=$5 WHERE operation_id=$6 AND tenant_id=$7 AND input_sha256=$8 AND revision=$9 AND status='loading'`,
            [
              status,
              after.datasetIndex,
              after.rowOffset,
              after.cursor,
              revision,
              profile.operationId,
              ctx.tenantId,
              ctx.inputSha256,
              before.revision,
            ]
          );
          if (changed.rowsAffected !== 1) invalid();
        });
      } catch (error) {
        // Never repeat an uncertain COMMIT merely because the connection failed.
        if (!(await checkJournal(ctx.db))) failure(error);
      }
      const persisted = await readOperation(ctx);
      if (!persisted) invalid();
      const result = progress(ctx, persisted);
      if (result.revision < revision) invalid();
      return result;
    } catch (error) {
      failure(error);
    }
  }

  /** Re-verifies even a previously verified target. This never activates an Authrim runtime. */
  async function verifySubset(input: DsqlSubsetImportInput): Promise<DsqlSubsetReceipt<Scope>> {
    try {
      const ctx = context(input);
      const operation = await readOperation(ctx);
      if (!operation || progress(ctx, operation).status === 'loading') invalid();
      const tables: DsqlSubsetReceipt<Scope>['tables'] = [];
      let expectedRevision = 0;
      for (const [index, spec] of ctx.specs.entries()) {
        const source = ctx.sources[index];
        const columns = spec.columns.map((name) => `"${name}"`).join(',');
        const sourceHash = hashRows();
        let cursor: string | null = null;
        let rowOffset = 0;
        for (;;) {
          const expectedChunk = await materializeChunk(ctx, index, rowOffset, cursor);
          expectedRevision++;
          const journal = await ctx.db.queryOne<{
            tenant_id: string;
            input_sha256: string;
            chunk_json: string;
          }>(`SELECT tenant_id,input_sha256,chunk_json FROM ${ctx.chunks} WHERE revision=$1`, [
            expectedRevision,
          ]);
          if (
            !journal ||
            journal.tenant_id !== ctx.tenantId ||
            journal.input_sha256 !== ctx.inputSha256 ||
            journal.chunk_json !== expectedChunk.chunkJson
          )
            mismatch();
          const actualRows = expectedChunk.rows.length
            ? await ctx.db.query<Record<string, unknown>>(
                `SELECT ${columns} FROM ${table(ctx.schema, spec.table)} WHERE id=ANY($1) AND tenant_id=$2`,
                [expectedChunk.rows.map((row) => row.id), ctx.tenantId]
              )
            : [];
          const actualById = new Map(actualRows.map((row) => [row.id, row]));
          if (
            actualRows.length !== expectedChunk.rows.length ||
            actualById.size !== expectedChunk.rows.length
          )
            mismatch();
          for (const expected of expectedChunk.rows) {
            const actual = actualById.get(expected.id);
            if (
              !actual ||
              !sameScalarColumns(expected.normalized, normalizeTarget(actual, spec), spec)
            )
              mismatch();
            sourceHash.add(expected.normalized);
          }
          await assertNativeJsonbEquality(ctx.db, ctx, spec, expectedChunk.rows);
          if (expectedChunk.after.datasetIndex !== index) break;
          cursor = expectedChunk.after.cursor;
          rowOffset = expectedChunk.after.rowOffset;
        }
        const targetHash = hashRows();
        let lastId: string | null = null;
        let observed = 0;
        for (;;) {
          const page: Record<string, unknown>[] = await ctx.db.query(
            `SELECT ${columns} FROM ${table(ctx.schema, spec.table)} ${lastId === null ? '' : 'WHERE id>$1'} ORDER BY id LIMIT ${MAX_ROWS}`,
            lastId === null ? [] : [lastId]
          );
          if (page.length > MAX_ROWS) mismatch();
          for (const row of page) {
            const normalized = normalizeTarget(row, spec);
            if (normalized[spec.columns.indexOf('tenant_id')] !== ctx.tenantId) mismatch();
            const id = normalized[spec.columns.indexOf('id')];
            if (typeof id !== 'string' || !id || id === lastId) mismatch();
            lastId = id;
            targetHash.add(normalized);
            observed++;
            if (observed > source.rows) mismatch();
          }
          if (page.length < MAX_ROWS) break;
        }
        if (observed !== source.rows) mismatch();
        tables.push({
          datasetId: spec.datasetId,
          rowCount: observed,
          sourceSha256: sourceHash.digest(),
          targetSha256: targetHash.digest(),
        });
      }
      const journalCount = await ctx.db.queryOne<{ count: string | number }>(
        `SELECT COUNT(*) AS count FROM ${ctx.chunks}`
      );
      if (
        !journalCount ||
        count(journalCount.count) !== expectedRevision ||
        count(operation.revision) !== expectedRevision
      )
        mismatch();
      await profile.verifyReferences(ctx.db, ctx.schema, ctx.tenantId);
      const body = {
        formatVersion: 1 as const,
        status: 'native_subset_verified' as const,
        scope: profile.scope,
        fullRuntimeReady: false as const,
        schema: ctx.schema,
        tenantId: ctx.tenantId,
        inputSha256: ctx.inputSha256,
        sourceContractFingerprint: ctx.fingerprint,
        tables,
        omittedDatasets: ctx.manifest.datasets
          .filter((dataset) => !ctx.specs.some((spec) => spec.datasetId === dataset.id))
          .map((dataset) => dataset.id)
          .sort(),
      };
      const receipt = { ...body, digestSha256: restoreEvidenceDigest(body) };
      const receiptJson = canonicalRestoreJson(receipt);
      try {
        await ctx.db.retryableTransaction(async (tx) => {
          const current = await readOperation(ctx, tx);
          if (!current || progress(ctx, current).status === 'loading') invalid();
          if (count(current.revision) !== expectedRevision) mismatch();
          if (current.status === 'native_subset_verified') {
            if (current.receipt_json !== receiptJson) mismatch();
            return;
          }
          const result = await tx.execute(
            `UPDATE ${ctx.operation} SET status='native_subset_verified',receipt_json=$1 WHERE operation_id=$2 AND tenant_id=$3 AND input_sha256=$4 AND revision=$5 AND status='sealed'`,
            [
              receiptJson,
              profile.operationId,
              ctx.tenantId,
              ctx.inputSha256,
              count(operation.revision),
            ]
          );
          if (result.rowsAffected !== 1) invalid();
        });
      } catch (error) {
        const current = await readOperation(ctx);
        if (
          !current ||
          progress(ctx, current).status !== 'native_subset_verified' ||
          current.receipt_json !== receiptJson
        )
          failure(error);
      }
      return receipt;
    } catch (error) {
      failure(error);
    }
  }

  return { createJournal, restoreSlice, verifySubset };
}
