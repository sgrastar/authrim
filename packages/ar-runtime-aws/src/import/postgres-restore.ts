import { createHash } from 'node:crypto';
import { Client } from 'pg';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import type { VerifiedTenantBackupV2 } from './backup-reader';
import {
  POSTGRES_RESTORE_TABLE_CONTRACTS,
  type PostgresRestoreTableContract,
} from './postgres-restore-table-contract';

type Family = 'core' | 'pii';
type NormalizedValue = string | boolean | null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const INTEGER = /^(0|-?[1-9][0-9]{0,18})$/u;
const MAX_DATASET_ROWS = 100_000;
const MAX_DATASET_BYTES = 64 * 1024 * 1024;
const utf8 = new TextEncoder();
/** The Core PostgreSQL baseline seeds these reference Flow rows for tenant `default`. */
const BASELINE_DEFAULT_REFERENCE_DATASETS = new Set([
  'core.flows',
  'core.flow_versions',
  'core.flow_assignments',
]);

export interface PostgresRestoreTableReceipt {
  datasetId: string;
  rowCount: number;
  sourceSha256: string;
  targetSha256: string;
}

export interface PostgresFamilyRestoreReceipt {
  status: 'committed_staging';
  family: Family;
  targetId: string;
  tenantId: string;
  bundleId: string;
  snapshotId: string;
  inventoryDigestSha256: string;
  tables: PostgresRestoreTableReceipt[];
  digestSha256: string;
}

export interface RestoreVerifiedPostgresFamilyInput {
  /** Fully verified, independently pinned AUTHRIM2 input. */
  backup: VerifiedTenantBackupV2;
  family: Family;
  tenantId: string;
  /** Unique identity of this empty staging database. Core and PII use different target IDs. */
  targetId: string;
  connectionString: string;
  /** Source system Login UI rows, pinned and reviewed separately by the coordinator. */
  /** The one captured public Login UI client admitted by the separate supplement. */
  supplementalLoginClientId?: string;
  supplementalRows?: Partial<
    Record<'core.oauth_clients' | 'core.web_origin_registry', readonly PortableSqliteRow[]>
  >;
  clientFactory?: (connectionString: string) => Client;
}

export interface ReadPostgresFamilyStagingReceiptInput {
  connectionString: string;
  targetId: string;
  clientFactory?: (connectionString: string) => Client;
}

export interface PostgresFamilyStagingReceiptRow {
  target_id: string;
  tenant_id: string;
  family: Family;
  receipt_json: string;
}

export interface VerifyPostgresFamilyStagingRowsInput extends ReadPostgresFamilyStagingReceiptInput {
  /**
   * Only these Core tables may be omitted from the historical row digest after serving begins.
   * The caller must verify their immutable columns and allowed live changes separately.
   */
  skipDatasetIds?: readonly ('core.identity_accounts' | 'core.passkeys')[];
}

function invalid(): never {
  throw new Error('aws_postgres_restore_invalid');
}

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) invalid();
  return `"${value}"`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function sourceRow(rowJson: string, spec: PostgresRestoreTableContract, tenantId: string) {
  let row: PortableSqliteRow;
  try {
    row = JSON.parse(rowJson) as PortableSqliteRow;
  } catch {
    return invalid();
  }
  if (
    !row ||
    Array.isArray(row) ||
    typeof row !== 'object' ||
    Object.keys(row).length !== spec.columns.length ||
    Object.keys(row).some((column) => !spec.columns.includes(column))
  ) {
    invalid();
  }
  const numeric = new Set(spec.sqliteIntegerColumns);
  const boolean = new Set(spec.postgresBooleanColumns);
  const jsonb = new Set(spec.postgresJsonbColumns);
  const values: (string | boolean | null)[] = [];
  const normalized: NormalizedValue[] = [];
  for (const column of spec.columns) {
    const tagged: unknown = row[column];
    if (!Array.isArray(tagged) || tagged.length !== 2) invalid();
    const tag: unknown = tagged[0];
    const raw: unknown = tagged[1];
    if (tag === 'null' && raw === null) {
      values.push(null);
      normalized.push(null);
      continue;
    }
    if (numeric.has(column)) {
      if (tag !== 'integer' || typeof raw !== 'string' || !INTEGER.test(raw)) invalid();
      const number = BigInt(raw);
      if (number < -(2n ** 63n) || number > 2n ** 63n - 1n) invalid();
      if (boolean.has(column)) {
        if (raw !== '0' && raw !== '1') invalid();
        const value = raw === '1';
        values.push(value);
        normalized.push(value);
      } else {
        values.push(raw);
        normalized.push(raw);
      }
      continue;
    }
    if (tag !== 'text' || typeof raw !== 'string') invalid();
    if (jsonb.has(column)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return invalid();
      }
      values.push(raw);
      normalized.push(stableJson(parsed));
    } else {
      values.push(raw);
      normalized.push(raw);
    }
  }
  const tenant = row[spec.tenantColumn];
  if (!tenant || tenant[0] !== 'text' || tenant[1] !== tenantId) invalid();
  if (spec.table === 'identity_accounts') {
    const generation = row.account_route_generation;
    if (!generation || generation[0] !== 'integer' || BigInt(generation[1] ?? '0') < 1n) invalid();
  }
  const key = spec.primaryKey.map((column) => {
    const value = row[column];
    if (!value || value[1] === null) invalid();
    return value[1];
  });
  return { values, normalized, key: JSON.stringify(key) };
}

function returnedRow(
  row: Record<string, unknown>,
  spec: PostgresRestoreTableContract
): NormalizedValue[] {
  const numeric = new Set(spec.sqliteIntegerColumns);
  const boolean = new Set(spec.postgresBooleanColumns);
  const jsonb = new Set(spec.postgresJsonbColumns);
  return spec.columns.map((column) => {
    const value = row[column];
    if (value === null) return null;
    if (numeric.has(column)) {
      if (boolean.has(column)) {
        if (typeof value !== 'boolean') invalid();
        return value;
      }
      if (typeof value !== 'string' && typeof value !== 'number') invalid();
      const decimal = String(value);
      if (!INTEGER.test(decimal)) invalid();
      return decimal;
    }
    if (jsonb.has(column)) return stableJson(value);
    if (typeof value !== 'string') invalid();
    return value;
  });
}

function rowsDigest(rows: Map<string, NormalizedValue[]>): string {
  const hash = createHash('sha256');
  for (const key of [...rows.keys()].sort()) {
    const text = JSON.stringify([key, rows.get(key)]);
    hash
      .update(String(utf8.encode(text).byteLength))
      .update(':')
      .update(text);
  }
  return hash.digest('hex');
}

function receiptDigest(receipt: Omit<PostgresFamilyRestoreReceipt, 'digestSha256'>): string {
  return sha256(stableJson(receipt));
}

function journalSql(): string {
  return `CREATE TABLE IF NOT EXISTS authrim_aws_import_staging (
    target_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    family TEXT NOT NULL CHECK (family IN ('core','pii')),
    receipt_json TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    UNIQUE (tenant_id, family)
  )`;
}

/**
 * Imports one SQL family into a non-activated staging target. This is one PostgreSQL
 * transaction; it is not a distributed commit across Core and PII databases.
 */
export async function restoreVerifiedPostgresFamily(
  input: RestoreVerifiedPostgresFamilyInput
): Promise<PostgresFamilyRestoreReceipt> {
  const { backup, family, tenantId, targetId } = input;
  const supplementalClientId = input.supplementalLoginClientId ?? 'login-ui';
  if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(supplementalClientId)) invalid();
  if (
    !UUID.test(targetId) ||
    !tenantId ||
    tenantId !== backup.manifest.source.tenantId ||
    !['core', 'pii'].includes(family) ||
    !input.connectionString
  ) {
    invalid();
  }
  if (
    input.supplementalRows &&
    (family !== 'core' ||
      Object.keys(input.supplementalRows).some(
        (id) => id !== 'core.oauth_clients' && id !== 'core.web_origin_registry'
      ))
  )
    invalid();
  const specs = POSTGRES_RESTORE_TABLE_CONTRACTS.filter((spec) => spec.family === family);
  const inManifest = new Map(backup.manifest.datasets.map((dataset) => [dataset.id, dataset]));
  const required = specs.filter(
    (spec) => !['core.oauth_clients', 'core.web_origin_registry'].includes(spec.datasetId)
  );
  if (required.some((spec) => !inManifest.has(spec.datasetId))) invalid();
  for (const dataset of backup.manifest.datasets) {
    if (
      !dataset.id.startsWith(`${family}.`) ||
      dataset.store !== 'database' ||
      dataset.disposition !== 'include'
    )
      continue;
    if (specs.some((spec) => spec.datasetId === dataset.id)) continue;
    if (backup.dataset(dataset.id).rows !== 0) invalid();
  }
  const client =
    input.clientFactory?.(input.connectionString) ??
    new Client({ connectionString: input.connectionString });
  await client.connect();
  let began = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    began = true;
    await client.query(journalSql());
    const priorJournal = await client.query(
      'SELECT target_id FROM authrim_aws_import_staging LIMIT 1'
    );
    if (priorJournal.rowCount !== 0) invalid();
    // Existing rows in any tenant-scoped table make this target nonempty, even if
    // the table is outside the deliberately narrow import allowlist.
    const scopedTables = await client.query<{ table_name: string }>(
      `SELECT DISTINCT c.relname AS table_name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid=c.relnamespace
         JOIN pg_attribute a ON a.attrelid=c.oid
        WHERE n.nspname='public' AND c.relkind IN ('r','p')
          AND a.attname='tenant_id' AND NOT a.attisdropped`
    );
    for (const { table_name: tableName } of scopedTables.rows) {
      const prior = await client.query(
        `SELECT 1 FROM ${identifier(tableName)} WHERE tenant_id=$1 LIMIT 1`,
        [tenantId]
      );
      if (prior.rowCount !== 0) invalid();
    }
    for (const spec of specs) {
      const table = identifier(spec.table);
      const scope = identifier(spec.tenantColumn);
      const prior = await client.query(`SELECT 1 FROM ${table} WHERE ${scope} = $1 LIMIT 1`, [
        tenantId,
      ]);
      if (prior.rowCount !== 0) invalid();
    }
    const tables: PostgresRestoreTableReceipt[] = [];
    for (const spec of specs) {
      const dataset = inManifest.get(spec.datasetId);
      const source = dataset ? backup.dataset(spec.datasetId) : null;
      const supplements =
        input.supplementalRows?.[
          spec.datasetId as 'core.oauth_clients' | 'core.web_origin_registry'
        ] ?? [];
      if (dataset && (dataset.store !== 'database' || dataset.disposition !== 'include')) invalid();
      if (
        (source?.rows ?? 0) + supplements.length > MAX_DATASET_ROWS ||
        (source?.bytes ?? 0) > MAX_DATASET_BYTES
      )
        invalid();
      const sourceHash = createHash('sha256');
      let sourceBytes = 0;
      const expected = new Map<string, NormalizedValue[]>();
      let cursor: string | null = null;
      const names = spec.columns.map(identifier);
      const placeholders = names.map((_, index) => `$${index + 1}`);
      const insertSql = `INSERT INTO ${identifier(spec.table)} (${names.join(',')}) VALUES (${placeholders.join(',')}) RETURNING ${names.join(',')}`;
      const insertRow = async (rowJson: string, supplement: boolean) => {
        if (supplement) {
          const row = JSON.parse(rowJson) as PortableSqliteRow;
          const clientId = row.client_id;
          if (!clientId || clientId[0] !== 'text' || clientId[1] !== supplementalClientId)
            invalid();
        }
        const rowBytes = utf8.encode(rowJson).byteLength;
        sourceBytes += rowBytes;
        if (rowBytes > 1024 * 1024 || sourceBytes > MAX_DATASET_BYTES) invalid();
        sourceHash.update(String(rowBytes)).update(':').update(rowJson);
        const decoded = sourceRow(rowJson, spec, tenantId);
        if (expected.has(decoded.key)) invalid();
        expected.set(decoded.key, decoded.normalized);
        const inserted = await client.query<Record<string, unknown>>(insertSql, decoded.values);
        if (
          inserted.rowCount !== 1 ||
          inserted.rows.length !== 1 ||
          JSON.stringify(returnedRow(inserted.rows[0], spec)) !== JSON.stringify(decoded.normalized)
        )
          invalid();
      };
      for (let count = 0; source && count < source.rows; count++) {
        const next = await source.readNextRow(cursor);
        if (!next || next.nextCursor === cursor) invalid();
        cursor = next.nextCursor;
        await insertRow(next.rowJson, false);
      }
      if (source && (await source.readNextRow(cursor)) !== null) invalid();
      for (const row of supplements) {
        let rowJson: string;
        try {
          rowJson = JSON.stringify(row);
        } catch {
          return invalid();
        }
        await insertRow(rowJson, true);
      }
      const selected = await client.query<Record<string, unknown>>(
        `SELECT ${names.join(',')} FROM ${identifier(spec.table)} WHERE ${identifier(spec.tenantColumn)} = $1`,
        [tenantId]
      );
      if (selected.rowCount !== expected.size) invalid();
      const observed = new Map<string, NormalizedValue[]>();
      for (const row of selected.rows) {
        const key = JSON.stringify(spec.primaryKey.map((column) => String(row[column])));
        if (observed.has(key)) invalid();
        observed.set(key, returnedRow(row, spec));
      }
      const expectedDigest = rowsDigest(expected);
      const targetDigest = rowsDigest(observed);
      if (targetDigest !== expectedDigest) invalid();
      tables.push({
        datasetId: spec.datasetId,
        rowCount: expected.size,
        sourceSha256: sourceHash.digest('hex'),
        targetSha256: targetDigest,
      });
    }
    const body = {
      status: 'committed_staging' as const,
      family,
      targetId,
      tenantId,
      bundleId: backup.manifest.bundleId,
      snapshotId: backup.manifest.snapshotId,
      inventoryDigestSha256: backup.manifest.inventoryDigestSha256,
      tables,
    };
    const receipt: PostgresFamilyRestoreReceipt = { ...body, digestSha256: receiptDigest(body) };
    await client.query(
      'INSERT INTO authrim_aws_import_staging (target_id,tenant_id,family,receipt_json,created_at) VALUES ($1,$2,$3,$4,$5)',
      [targetId, tenantId, family, JSON.stringify(receipt), Date.now()]
    );
    await client.query('COMMIT');
    began = false;
    return receipt;
  } catch (error) {
    if (began) await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

/** Validate a staging journal row returned by an existing Core/PII database adapter. */
export function validatePostgresFamilyStagingReceiptRow(
  row: unknown,
  expectedTargetId: string
): PostgresFamilyRestoreReceipt {
  if (!UUID.test(expectedTargetId) || !row || typeof row !== 'object' || Array.isArray(row))
    invalid();
  const fields = row as Record<string, unknown>;
  if (
    fields.target_id !== expectedTargetId ||
    typeof fields.tenant_id !== 'string' ||
    !fields.tenant_id ||
    (fields.family !== 'core' && fields.family !== 'pii') ||
    typeof fields.receipt_json !== 'string'
  )
    invalid();
  let receipt: PostgresFamilyRestoreReceipt;
  try {
    receipt = JSON.parse(fields.receipt_json) as PostgresFamilyRestoreReceipt;
  } catch {
    return invalid();
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) invalid();
  const { digestSha256, ...body } = receipt;
  if (
    receipt.status !== 'committed_staging' ||
    receipt.targetId !== expectedTargetId ||
    receipt.tenantId !== fields.tenant_id ||
    receipt.family !== fields.family ||
    !Array.isArray(receipt.tables) ||
    digestSha256 !== receiptDigest(body)
  )
    invalid();
  return receipt;
}

/** Read the family marker back from its own database before publishing activation. */
export async function readPostgresFamilyStagingReceipt(
  input: ReadPostgresFamilyStagingReceiptInput
): Promise<PostgresFamilyRestoreReceipt | null> {
  if (!UUID.test(input.targetId) || !input.connectionString) invalid();
  const client =
    input.clientFactory?.(input.connectionString) ??
    new Client({ connectionString: input.connectionString });
  await client.connect();
  try {
    const result = await client.query<PostgresFamilyStagingReceiptRow>(
      'SELECT target_id,tenant_id,family,receipt_json FROM authrim_aws_import_staging WHERE target_id=$1',
      [input.targetId]
    );
    if (result.rowCount === 0) return null;
    if (result.rowCount !== 1) invalid();
    return validatePostgresFamilyStagingReceiptRow(result.rows[0], input.targetId);
  } finally {
    await client.end();
  }
}

/** Recheck restored SQL rows before activation, while the staging target is still quiescent. */
export async function verifyPostgresFamilyStagingRows(
  input: VerifyPostgresFamilyStagingRowsInput
): Promise<PostgresFamilyRestoreReceipt> {
  const receipt = await readPostgresFamilyStagingReceipt(input);
  if (!receipt) invalid();
  const skipDatasetIds = input.skipDatasetIds ?? [];
  const skipped = new Set<string>(skipDatasetIds);
  if (
    skipDatasetIds.length > 2 ||
    skipped.size !== skipDatasetIds.length ||
    skipDatasetIds.some(
      (id) =>
        receipt.family !== 'core' || (id !== 'core.identity_accounts' && id !== 'core.passkeys')
    )
  )
    invalid();
  const specs = POSTGRES_RESTORE_TABLE_CONTRACTS.filter((spec) => spec.family === receipt.family);
  if (
    receipt.tables.length !== specs.length ||
    receipt.tables.some(
      (table, index) =>
        table.datasetId !== specs[index].datasetId ||
        !Number.isSafeInteger(table.rowCount) ||
        table.rowCount < 0 ||
        table.rowCount > MAX_DATASET_ROWS ||
        !/^[a-f0-9]{64}$/u.test(table.sourceSha256) ||
        !/^[a-f0-9]{64}$/u.test(table.targetSha256)
    )
  )
    invalid();
  const client =
    input.clientFactory?.(input.connectionString) ??
    new Client({ connectionString: input.connectionString });
  await client.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (let index = 0; index < specs.length; index++) {
      const spec = specs[index];
      const tableReceipt = receipt.tables[index];
      const permitsBaselineDefaultRows = BASELINE_DEFAULT_REFERENCE_DATASETS.has(spec.datasetId);
      const foreign = await client.query(
        `SELECT 1 FROM ${identifier(spec.table)} WHERE ${identifier(spec.tenantColumn)} IS DISTINCT FROM $1${permitsBaselineDefaultRows ? ` AND ${identifier(spec.tenantColumn)} IS DISTINCT FROM 'default'` : ''} LIMIT 1`,
        [receipt.tenantId]
      );
      if (foreign.rowCount !== 0) invalid();
      const names = spec.columns.map(identifier);
      const selected = await client.query<Record<string, unknown>>(
        `SELECT ${names.join(',')} FROM ${identifier(spec.table)} WHERE ${identifier(spec.tenantColumn)}=$1 LIMIT $2`,
        [receipt.tenantId, tableReceipt.rowCount + 1]
      );
      if (selected.rowCount !== tableReceipt.rowCount) invalid();
      if (skipped.has(spec.datasetId)) continue;
      const observed = new Map<string, NormalizedValue[]>();
      for (const row of selected.rows) {
        const key = JSON.stringify(spec.primaryKey.map((column) => String(row[column])));
        if (observed.has(key)) invalid();
        observed.set(key, returnedRow(row, spec));
      }
      if (rowsDigest(observed) !== tableReceipt.targetSha256) invalid();
    }
    await client.query('COMMIT');
    return receipt;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}
