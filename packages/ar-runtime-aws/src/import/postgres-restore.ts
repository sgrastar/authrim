import { createHash } from 'node:crypto';
import { Client } from 'pg';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import type { VerifiedTenantBackupV2 } from './backup-reader';
import {
  POSTGRES_RESTORE_TABLE_CONTRACTS,
  type PostgresRestoreTableContract,
} from './postgres-restore-table-contract';

import {
  POSTGRES_RESTORE_EXTENSION_CONTRACTS,
  POSTGRES_RESTORE_DEPENDENCIES,
} from './postgres-restore-extension-contract';
import {
  suspendSnapshotProjectionTriggers,
  restoreSnapshotProjectionTriggers,
} from './postgres-restore-triggers';

import {
  hasPostgresReferenceSeed,
  preparePostgresReferenceSeeds,
  verifyPostgresReferenceSeed,
} from './postgres-restore-reference-seeds';

type Family = 'core' | 'pii';
type NormalizedValue = string | boolean | null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const INTEGER = /^(0|-?[1-9][0-9]{0,18})$/u;
const MAX_DATASET_ROWS = 100_000;
const MAX_DATASET_BYTES = 64 * 1024 * 1024;
const utf8 = new TextEncoder();
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
  /** Absent on the original 18-table contract. Version 2 preserves exact native JSONB text. */
  projectionVersion?: 2;
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
  skipDatasetIds?: readonly (
    | 'core.identity_accounts'
    | 'core.passkeys'
    | 'core.service_group_inputs'
    | 'core.account_webhook_outbox'
  )[];
}

/** No row data or secrets are included in this diagnostic. */
export class UnsupportedPostgresBackupProjectionError extends Error {
  readonly code = 'aws_postgres_restore_unsupported_datasets';
  constructor(readonly datasets: readonly { datasetId: string; rowCount: number }[]) {
    super('aws_postgres_restore_unsupported_datasets');
  }
}

// These contracts pin schema only. Source guards are rebuild state and admissions are held
// authority; neither may become live in a new target before explicit PR7 rebinding.
const STATEMENT_CONSENT_SOURCE_AUTHORITY_DATASETS: ReadonlySet<string> = new Set([
  'core.statement_consent_guards',
  'core.statement_consent_admissions',
]);

function projectionContracts(ids: ReadonlySet<string>, family: Family) {
  return [
    ...POSTGRES_RESTORE_TABLE_CONTRACTS.filter((spec) => spec.family === family),
    ...POSTGRES_RESTORE_EXTENSION_CONTRACTS.filter(
      (spec) =>
        spec.family === family &&
        ids.has(spec.datasetId) &&
        !STATEMENT_CONSENT_SOURCE_AUTHORITY_DATASETS.has(spec.datasetId)
    ),
  ];
}

/** Validate authenticated dataset descriptors/counts without opening or creating a database. */
export function assertPostgresBackupProjectionSupported(
  backup: VerifiedTenantBackupV2,
  family?: Family
): void {
  const ids = new Set(backup.manifest.datasets.map((dataset) => dataset.id));
  if (ids.size !== backup.manifest.datasets.length) invalid();
  const families = family ? [family] : (['core', 'pii'] as const);
  const unsupported: { datasetId: string; rowCount: number }[] = [];
  for (const selectedFamily of families) {
    const specs = projectionContracts(ids, selectedFamily);
    const required = specs.filter(
      (spec) => !['core.oauth_clients', 'core.web_origin_registry'].includes(spec.datasetId)
    );
    if (required.some((spec) => !ids.has(spec.datasetId))) invalid();
    for (const dataset of backup.manifest.datasets) {
      if (!dataset.id.startsWith(`${selectedFamily}.`)) continue;
      if (specs.some((spec) => spec.datasetId === dataset.id)) {
        if (dataset.store !== 'database' || dataset.disposition !== 'include') invalid();
        const source = backup.dataset(dataset.id);
        if (
          !Number.isSafeInteger(source.rows) ||
          source.rows < 0 ||
          source.rows > MAX_DATASET_ROWS ||
          !Number.isSafeInteger(source.bytes) ||
          source.bytes < 0 ||
          source.bytes > MAX_DATASET_BYTES
        )
          invalid();
      } else if (dataset.store === 'database' && dataset.disposition === 'include') {
        const rowCount = backup.dataset(dataset.id).rows;
        if (!Number.isSafeInteger(rowCount) || rowCount < 0) invalid();
        if (rowCount !== 0) unsupported.push({ datasetId: dataset.id, rowCount });
      }
    }
  }
  if (unsupported.length)
    throw new UnsupportedPostgresBackupProjectionError(
      unsupported.sort((left, right) => left.datasetId.localeCompare(right.datasetId))
    );
}

function insertionOrder(specs: readonly PostgresRestoreTableContract[]) {
  const remaining = new Map(specs.map((spec) => [spec.datasetId, spec]));
  const result: PostgresRestoreTableContract[] = [];
  while (remaining.size) {
    const next = [...remaining.values()].find((spec) =>
      (POSTGRES_RESTORE_DEPENDENCIES[spec.datasetId] ?? []).every((id) => !remaining.has(id))
    );
    if (!next) invalid();
    result.push(next);
    remaining.delete(next.datasetId);
  }
  return result;
}

function invalid(): never {
  throw new Error('aws_postgres_restore_invalid');
}

function parentFirstRoles(
  rows: readonly string[],
  spec: PostgresRestoreTableContract,
  tenantId: string
): string[] {
  const byId = new Map<string, { json: string; parent: string | null }>();
  let bytes = 0;
  for (const json of rows) {
    bytes += utf8.encode(json).byteLength;
    if (bytes > MAX_DATASET_BYTES) invalid();
    sourceRow(json, spec, tenantId);
    const row = JSON.parse(json) as PortableSqliteRow;
    const id = row.id[1];
    const parent = row.parent_role_id[1];
    if (!id || byId.has(id)) invalid();
    byId.set(id, { json, parent });
  }
  const children = new Map<string, string[]>();
  const ready: string[] = [];
  for (const [id, row] of byId) {
    if (row.parent === null) ready.push(id);
    else {
      if (!byId.has(row.parent)) invalid();
      const list = children.get(row.parent) ?? [];
      list.push(id);
      children.set(row.parent, list);
    }
  }
  const result: string[] = [];
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index];
    const row = byId.get(id);
    if (!row) invalid();
    result.push(row.json);
    ready.push(...(children.get(id) ?? []));
  }
  if (result.length !== rows.length) invalid();
  return result;
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
  spec: PostgresRestoreTableContract,
  preciseJsonb = false
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
    if (jsonb.has(column)) {
      if (preciseJsonb) {
        if (typeof value !== 'string') invalid();
        return value;
      }
      return stableJson(value);
    }
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
  assertPostgresBackupProjectionSupported(backup, family);
  const inManifest = new Map(backup.manifest.datasets.map((dataset) => [dataset.id, dataset]));
  const specs = projectionContracts(new Set(inManifest.keys()), family);
  const extended = specs.some((spec) => POSTGRES_RESTORE_EXTENSION_CONTRACTS.includes(spec));
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
    if (family === 'core')
      await preparePostgresReferenceSeeds(
        client,
        tenantId,
        new Set(specs.map((spec) => spec.datasetId))
      );
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
      if (
        tenantId === 'default' &&
        family === 'core' &&
        hasPostgresReferenceSeed(`core.${tableName}`) &&
        !specs.some((spec) => spec.table === tableName)
      )
        continue;
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
    const suspended = extended ? await suspendSnapshotProjectionTriggers(client, specs) : [];
    const tableReceipts = new Map<string, PostgresRestoreTableReceipt>();
    for (const spec of insertionOrder(specs)) {
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
      const placeholders = names.map((_, index) =>
        extended && spec.postgresJsonbColumns.includes(spec.columns[index])
          ? `$${index + 1}::text::jsonb`
          : `$${index + 1}`
      );
      const returnedNames = names.map((name, index) =>
        extended && spec.postgresJsonbColumns.includes(spec.columns[index])
          ? `${name}::text AS ${name}`
          : name
      );
      const jsonChecks = extended
        ? spec.postgresJsonbColumns.map(
            (column) =>
              `(${identifier(column)} IS NOT DISTINCT FROM $${spec.columns.indexOf(column) + 1}::text::jsonb AND ($${spec.columns.indexOf(column) + 1}::text IS NULL OR $${spec.columns.indexOf(column) + 1}::text IS JSON WITH UNIQUE KEYS)) AS ${identifier(`authrim_json_${spec.columns.indexOf(column)}`)}`
          )
        : [];
      const insertSql = `INSERT INTO ${identifier(spec.table)} (${names.join(',')}) VALUES (${placeholders.join(',')}) RETURNING ${[...returnedNames, ...jsonChecks].join(',')}`;
      const recordSourceRow = (rowJson: string) => {
        const rowBytes = utf8.encode(rowJson).byteLength;
        sourceBytes += rowBytes;
        if (rowBytes > 1024 * 1024 || sourceBytes > MAX_DATASET_BYTES) invalid();
        sourceHash.update(String(rowBytes)).update(':').update(rowJson);
      };
      const insertRow = async (rowJson: string, supplement: boolean, alreadyHashed = false) => {
        if (supplement) {
          const row = JSON.parse(rowJson) as PortableSqliteRow;
          const clientId = row.client_id;
          if (!clientId || clientId[0] !== 'text' || clientId[1] !== supplementalClientId)
            invalid();
        }
        if (!alreadyHashed) recordSourceRow(rowJson);
        const decoded = sourceRow(rowJson, spec, tenantId);
        if (expected.has(decoded.key)) invalid();
        let inserted;
        if (spec.datasetId === 'core.account_lifecycle_event_outbox') {
          // Historical outbox states enter through the same guarded state machine.
          // No notification workers can observe this isolated, uncommitted staging DB.
          const initial = [...decoded.values];
          const at = (column: string) => spec.columns.indexOf(column);
          initial[at('status')] = 'pending';
          initial[at('attempt_count')] = '0';
          initial[at('lease_owner')] = null;
          initial[at('lease_expires_at')] = null;
          await client.query(insertSql, initial);
          if (decoded.values[at('status')] === 'retry') {
            await client.query(
              `UPDATE account_lifecycle_event_outbox SET status='leased',lease_owner='authrim-isolated-restore',lease_expires_at=1 WHERE event_id=$1 AND tenant_id=$2`,
              [decoded.values[at('event_id')], tenantId]
            );
          }
          inserted = await client.query<Record<string, unknown>>(
            `UPDATE ${identifier(spec.table)} SET ${names.map((name, index) => `${name}=$${index + 1}`).join(',')}
             WHERE event_id=$${at('event_id') + 1} AND tenant_id=$${at('tenant_id') + 1} RETURNING ${returnedNames.join(',')}`,
            decoded.values
          );
        } else inserted = await client.query<Record<string, unknown>>(insertSql, decoded.values);
        if (inserted.rowCount !== 1 || inserted.rows.length !== 1) invalid();
        const observed = returnedRow(inserted.rows[0], spec, extended);
        if (extended) {
          for (const column of spec.postgresJsonbColumns) {
            const index = spec.columns.indexOf(column);
            if (inserted.rows[0][`authrim_json_${index}`] !== true) invalid();
            decoded.normalized[index] = observed[index];
          }
        }
        if (JSON.stringify(observed) !== JSON.stringify(decoded.normalized)) invalid();
        expected.set(decoded.key, decoded.normalized);
      };
      const roleRows: string[] = [];
      for (let count = 0; source && count < source.rows; count++) {
        const next = await source.readNextRow(cursor);
        if (!next || next.nextCursor === cursor) invalid();
        cursor = next.nextCursor;
        if (spec.datasetId === 'core.roles') {
          recordSourceRow(next.rowJson);
          roleRows.push(next.rowJson);
        } else await insertRow(next.rowJson, false);
      }
      if (source && (await source.readNextRow(cursor)) !== null) invalid();
      if (roleRows.length)
        for (const role of parentFirstRoles(roleRows, spec, tenantId))
          await insertRow(role, false, true);
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
        `SELECT ${returnedNames.join(',')} FROM ${identifier(spec.table)} WHERE ${identifier(spec.tenantColumn)} = $1`,
        [tenantId]
      );
      if (selected.rowCount !== expected.size) invalid();
      const observed = new Map<string, NormalizedValue[]>();
      for (const row of selected.rows) {
        const key = JSON.stringify(spec.primaryKey.map((column) => String(row[column])));
        if (observed.has(key)) invalid();
        observed.set(key, returnedRow(row, spec, extended));
      }
      const expectedDigest = rowsDigest(expected);
      const targetDigest = rowsDigest(observed);
      if (targetDigest !== expectedDigest) invalid();
      tableReceipts.set(spec.datasetId, {
        datasetId: spec.datasetId,
        rowCount: expected.size,
        sourceSha256: sourceHash.digest('hex'),
        targetSha256: targetDigest,
      });
    }
    if (
      family === 'core' &&
      specs.some((spec) => spec.datasetId === 'core.account_legal_hold_states')
    ) {
      const inconsistent = await client.query(
        `SELECT 1 FROM identity_accounts a LEFT JOIN account_legal_hold_states s
           ON s.tenant_id=a.tenant_id AND s.account_id=a.id
         WHERE a.tenant_id=$1 AND s.account_id IS NULL
         UNION ALL
         SELECT 1 FROM account_legal_hold_states s LEFT JOIN legal_holds h
           ON h.tenant_id=s.tenant_id AND h.subject_id=s.account_id AND h.id=s.active_hold_id AND h.state='active'
         WHERE s.tenant_id=$1 AND s.projection_state='active' AND h.id IS NULL
         UNION ALL
         SELECT 1 FROM legal_holds h LEFT JOIN account_legal_hold_states s
           ON s.tenant_id=h.tenant_id AND s.account_id=h.subject_id AND s.active_hold_id=h.id AND s.projection_state='active'
         WHERE h.tenant_id=$1 AND h.state='active' AND s.account_id IS NULL LIMIT 1`,
        [tenantId]
      );
      if (inconsistent.rows.length) invalid();
    }
    await restoreSnapshotProjectionTriggers(client, suspended);
    const tables = specs.map((spec) => {
      const receipt = tableReceipts.get(spec.datasetId);
      if (!receipt) invalid();
      return receipt;
    });
    const body = {
      ...(extended ? { projectionVersion: 2 as const } : {}),
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
    skipDatasetIds.length > 4 ||
    skipped.size !== skipDatasetIds.length ||
    skipDatasetIds.some(
      (id) =>
        receipt.family !== 'core' ||
        ![
          'core.identity_accounts',
          'core.passkeys',
          'core.service_group_inputs',
          'core.account_webhook_outbox',
        ].includes(id)
    )
  )
    invalid();
  const extended = receipt.projectionVersion === 2;
  if (receipt.projectionVersion !== undefined && !extended) invalid();
  const specs = extended
    ? projectionContracts(new Set(receipt.tables.map((table) => table.datasetId)), receipt.family)
    : POSTGRES_RESTORE_TABLE_CONTRACTS.filter((spec) => spec.family === receipt.family);
  if (extended && !specs.some((spec) => POSTGRES_RESTORE_EXTENSION_CONTRACTS.includes(spec)))
    invalid();
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
      const permitsBaselineDefaultRows =
        hasPostgresReferenceSeed(spec.datasetId) && receipt.tenantId !== 'default';
      if (permitsBaselineDefaultRows) await verifyPostgresReferenceSeed(client, spec.table);
      const foreign = await client.query(
        `SELECT 1 FROM ${identifier(spec.table)} WHERE ${identifier(spec.tenantColumn)} IS DISTINCT FROM $1${permitsBaselineDefaultRows ? ` AND ${identifier(spec.tenantColumn)} IS DISTINCT FROM 'default'` : ''} LIMIT 1`,
        [receipt.tenantId]
      );
      if (foreign.rowCount !== 0) invalid();
      // Live verification separately proves source rows immutable and the bounded login-only append set.
      if (spec.datasetId === 'core.account_webhook_outbox' && skipped.has(spec.datasetId)) continue;
      const names = spec.columns.map((column) =>
        extended && spec.postgresJsonbColumns.includes(column)
          ? `${identifier(column)}::text AS ${identifier(column)}`
          : identifier(column)
      );
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
        observed.set(key, returnedRow(row, spec, extended));
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
