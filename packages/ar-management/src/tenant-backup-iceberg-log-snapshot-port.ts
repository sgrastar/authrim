import type { Env } from '@authrim/ar-lib-core';
import { runTenantBackupCoveredEffect } from '@authrim/ar-lib-core/services/tenant-portability/covered-mutation';
import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';
import {
  readBackupSqliteSchema,
  readBackupSqliteBoundarySchemaDigest,
} from '@authrim/ar-lib-core/services/tenant-portability/sqlite-schema-reader';
import {
  assessSqliteCaptureStructure,
  sqliteTenantOrderIndex,
} from '@authrim/ar-lib-core/services/tenant-portability/sqlite-schema-assessment';
import {
  sqliteCapturePlan,
  sqliteSnapshotStartOrResumeStatement,
} from '@authrim/ar-lib-core/services/tenant-portability/sqlite-capture-plan';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  sqliteSnapshotRowQuery,
  type CaptureSchema,
} from '@authrim/ar-lib-core/services/tenant-portability/sqlite-snapshot';
import {
  readSqliteSnapshotChunks,
  type SqliteSnapshotSourceCursor,
} from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-source';
import { packedSqliteRowToJson } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-packed-row';
import { lookupSqliteSnapshotRows } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-snapshot-lookup';
import {
  tombstoneSqliteBackupSnapshot,
  cleanupSqliteBackupSnapshotPage,
} from '@authrim/ar-lib-core/services/tenant-portability/sqlite-snapshot-cleanup';
import { splitMigrationSql } from '@authrim/ar-lib-core/services/control-plane/migration-sql';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import { tenantBackupLogWindow } from '@authrim/ar-lib-core/services/tenant-portability/selection-contract';
import {
  encodePortableIcebergLog,
  icebergLogSelected,
  ICEBERG_LOG_SOURCE_DATASETS,
  ICEBERG_LOG_CATEGORIES,
  icebergLogCategory,
  icebergLogDatasetCategory,
  type IcebergLogCategory,
} from '@authrim/ar-lib-core/services/tenant-portability/portable-iceberg-log';
import {
  encryptObjectArtifact,
  decryptObjectArtifact,
  type EncryptedObjectArtifactEnvelope,
} from '@authrim/ar-lib-core/services/object-artifact-crypto';
import { createLogIcebergKeyResolver } from '@authrim/ar-lib-core/services/log-iceberg-keys';
import { resolveLogIcebergConfig } from '@authrim/ar-lib-core/services/log-iceberg-config';
import {
  createLogIcebergCatalog,
  createLogIcebergObjectStore,
  validateLogIcebergTable,
  type LogIcebergCatalogEnv,
} from '@authrim/ar-lib-core/services/log-iceberg-catalog';
import { LogIcebergTableLease } from '@authrim/ar-lib-core/services/log-iceberg-lease';
import {
  logIcebergDigest,
  logIcebergRecordId,
} from '@authrim/ar-lib-core/services/log-iceberg-store';
import {
  readLogIcebergRetryPayload,
  type LogIcebergQueueReference,
} from '@authrim/ar-lib-core/services/log-iceberg-runtime';
import {
  readSnapshotPage,
  IcebergLifecycle,
  advanceIcebergMainForGc,
  assertIcebergSnapshotLineage,
  type SnapshotScanCursor,
  type IcebergCatalogPort,
  type IcebergLoadedTable,
  type IcebergObjectStore,
} from '@authrim/ar-lib-logging/iceberg';
import {
  assertLogArchiveRecord,
  type LogArchiveRecord,
} from '@authrim/ar-lib-logging/iceberg/schema';
import { createDeferredEncryptedTenantBackupRecordSnapshotPort } from './tenant-backup-record-snapshot-port';
import { tenantBackupRecordSnapshotId } from './tenant-backup-phase5-adapter';
import type { Phase5RecordSnapshotPort } from './tenant-backup-phase5-adapter';
import type { AdapterContext } from './tenant-backup-export-dispatcher';

export const ICEBERG_LOG_SNAPSHOT_RESOURCE = 'iceberg-log:records';
const CORE_TABLES = ['log_iceberg_core_publications'] as const;
const ADMIN_TABLES = [
  'log_iceberg_records',
  'log_iceberg_record_parts',
  'log_iceberg_publications',
  'log_iceberg_outbox',
  'log_iceberg_subject_erasures',
  'log_iceberg_restore_holds',
  'log_iceberg_restore_activations',
] as const;
const MAX_ROW_BYTES = 256 * 1024,
  MAX_PLAN_BYTES = 4 * 1024 * 1024,
  PIN_MS = 24 * 3600000;
type Database = DatabaseAdapter;
export interface IcebergLogBackupSource {
  resourceId: string;
  database: Database;
}
interface SourcePlan {
  resourceId: string;
  schemas: CaptureSchema[];
  schemaDigest: string;
}
interface SchemaPlan {
  version: 1;
  tenantId: string;
  tenantKey: string;
  operationId: string;
  generation: string;
  tableUuid: string | null;
  physicalFingerprint: string | null;
  core: SourcePlan;
  admin: SourcePlan;
}
interface Boundary {
  version: 1;
  boundaryUnixMs: number;
  snapshotId: string;
  pinRef: string | null;
  pinSnapshotId: string | null;
  pinExpiresAt: number | null;
}
interface PrepareCursor {
  version: 1;
  stage: 'hot' | 'retry' | 'cold' | 'done';
  sql?: SqliteSnapshotSourceCursor;
  cold?: SnapshotScanCursor;
  pages: number;
  categoryPages: Record<IcebergLogCategory, number>;
}
function invalid(code = 'backup_iceberg_log_snapshot_invalid'): never {
  throw new Error(code);
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function tagged(row: PortableSqliteRow, name: string): string | null {
  const field = row[name];
  if (
    !field ||
    !Array.isArray(field) ||
    field.length !== 2 ||
    !['text', 'integer', 'null'].includes(field[0])
  )
    return invalid();
  if (field[0] === 'null' && field[1] === null) return null;
  if (typeof field[1] !== 'string') return invalid();
  return field[1];
}
function required(row: PortableSqliteRow, name: string): string {
  const value = tagged(row, name);
  if (value === null) return invalid();
  return value;
}
function integer(row: PortableSqliteRow, name: string): number {
  const text = required(row, name);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) return invalid();
  const n = Number(text);
  if (!Number.isSafeInteger(n)) return invalid();
  return n;
}
function nullableTime(row: PortableSqliteRow, name: string): number | null {
  return tagged(row, name) === null ? null : integer(row, name);
}
function portable(value: unknown): PortableSqliteRow {
  if (!object(value)) return invalid();
  const row: Record<string, readonly [string, string | null]> = {};
  for (const [name, field] of Object.entries(value)) {
    if (
      !Array.isArray(field) ||
      field.length !== 2 ||
      typeof field[0] !== 'string' ||
      (field[1] !== null && typeof field[1] !== 'string')
    )
      return invalid();
    row[name] = [field[0], field[1]];
  }
  return row;
}
function identity(context: AdapterContext): { tenantId: string; operationId: string } {
  const { tenantId, operationId } = context.context.lease;
  for (const id of [tenantId, operationId])
    if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(id)) return invalid();
  return { tenantId, operationId };
}
function schemaPrefix(context: AdapterContext): string {
  const { tenantId, operationId } = identity(context);
  return `tenant-backup-iceberg-source/${tenantId}/${operationId}/`;
}
function cowId(snapshotId: string, store: 'core' | 'admin'): string {
  if (!/^[a-f0-9]{64}$/.test(snapshotId)) return invalid();
  return `${snapshotId}-iceberg-${store}`;
}
function schemaOf(plan: SourcePlan, table: string): CaptureSchema {
  const schema = plan.schemas.find((s) => s.table === table);
  if (!schema) return invalid();
  return schema;
}
async function active(database: Database, snapshotId: string, tenantId: string): Promise<void> {
  if (
    !(await database.queryOne(
      "SELECT id FROM tenant_backup_snapshots WHERE id=? AND tenant_id=? AND state='capturing'",
      [snapshotId, tenantId]
    ))
  )
    invalid('backup_iceberg_log_source_expired');
}
async function decodePacked(value: unknown, schema: CaptureSchema): Promise<PortableSqliteRow> {
  if (
    !object(value) ||
    typeof value.row_hex !== 'string' ||
    !['blob', 'text'].includes(String(value.row_type)) ||
    value.row_hex.length > MAX_ROW_BYTES * 2 ||
    value.row_hex.length % 2 ||
    !/^[0-9a-f]*$/i.test(value.row_hex)
  )
    return invalid();
  const bytes = Uint8Array.from(value.row_hex.match(/../g) ?? [], (v) => Number.parseInt(v, 16));
  let text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  if (value.row_type === 'blob') {
    for await (const part of packedSqliteRowToJson(
      (async function* () {
        yield bytes;
      })(),
      schema.columns
    ))
      text += decoder.decode(part, { stream: true });
    text += decoder.decode();
  } else text = decoder.decode(bytes);
  return portable(JSON.parse(text));
}
async function point(
  database: Database,
  schema: CaptureSchema,
  snapshotId: string,
  tenantId: string,
  id: string
): Promise<PortableSqliteRow | null> {
  const row = await database.queryOne(
    `SELECT typeof(row_json) AS row_type,hex(row_json) AS row_hex FROM (${sqliteSnapshotRowQuery(schema)})`,
    [snapshotId, tenantId, JSON.stringify([['text', id]])]
  );
  return row ? decodePacked(row, schema) : null;
}
async function nextRow(
  database: Database,
  schema: CaptureSchema,
  snapshotId: string,
  tenantId: string,
  signal: AbortSignal,
  cursor?: SqliteSnapshotSourceCursor
): Promise<{ row: PortableSqliteRow | null; cursor?: SqliteSnapshotSourceCursor; done: boolean }> {
  const parts: Uint8Array[] = [];
  let size = 0,
    next = cursor;
  for await (const chunk of readSqliteSnapshotChunks({
    database,
    schema,
    snapshotId,
    tenantId,
    signal,
    cursor,
    rowLimit: 1,
  })) {
    next = chunk.nextCursor;
    if (!chunk.bytes.length) return { row: null, cursor: next, done: false };
    size += chunk.bytes.length;
    if (size > MAX_ROW_BYTES) return invalid('backup_iceberg_log_source_row_too_large');
    parts.push(chunk.bytes);
    if (chunk.bytes.at(-1) === 10) {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      return {
        row: portable(
          JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
        ),
        cursor: next,
        done: false,
      };
    }
  }
  if (!parts.length) return { row: null, cursor: next, done: true };
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return {
    row: portable(
      JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
    ),
    cursor: next,
    done: false,
  };
}
function cursor(value: string | null): PrepareCursor {
  if (value === null)
    return {
      version: 1,
      stage: 'hot',
      pages: 0,
      categoryPages: { audit: 0, other: 0, sensitive: 0 },
    };
  if (value.length > 16384) return invalid();
  const v: unknown = JSON.parse(value);
  if (!object(v) || !object(v.categoryPages)) return invalid();
  const categoryPages = v.categoryPages;
  if (
    !object(v) ||
    v.version !== 1 ||
    typeof v.stage !== 'string' ||
    !['hot', 'retry', 'cold', 'done'].includes(v.stage) ||
    typeof v.pages !== 'number' ||
    !Number.isSafeInteger(v.pages) ||
    v.pages < 0 ||
    Object.keys(categoryPages).length !== 3 ||
    ICEBERG_LOG_CATEGORIES.some(
      (category) =>
        typeof categoryPages[category] !== 'number' ||
        !Number.isSafeInteger(categoryPages[category]) ||
        Number(categoryPages[category]) < 0
    )
  )
    return invalid();
  const result: PrepareCursor = {
    version: 1,
    stage: v.stage as PrepareCursor['stage'],
    pages: v.pages,
    categoryPages: {
      audit: Number(categoryPages.audit),
      other: Number(categoryPages.other),
      sensitive: Number(categoryPages.sensitive),
    },
  };
  if (v.sql !== undefined) {
    if (
      !object(v.sql) ||
      typeof v.sql.after !== 'string' ||
      v.sql.after.length > 2048 ||
      typeof v.sql.chunk !== 'number' ||
      !Number.isSafeInteger(v.sql.chunk) ||
      v.sql.chunk < 0 ||
      (v.sql.order !== undefined && v.sql.order !== 'native')
    )
      return invalid();
    result.sql = {
      after: v.sql.after,
      chunk: v.sql.chunk,
      ...(v.sql.order === 'native' ? { order: 'native' as const } : {}),
    };
  }
  if (v.cold !== undefined) {
    const cold = v.cold;
    if (
      !object(cold) ||
      cold.version !== 1 ||
      typeof cold.tableUuid !== 'string' ||
      typeof cold.snapshotId !== 'string' ||
      typeof cold.scopeDigest !== 'string' ||
      typeof cold.physicalFingerprint !== 'string' ||
      !object(cold.position)
    )
      return invalid();
    const pos = cold.position;
    for (const k of ['manifest', 'entry', 'row'])
      if (typeof pos[k] !== 'number' || !Number.isSafeInteger(pos[k]) || Number(pos[k]) < 0)
        return invalid();
    result.cold = {
      version: 1,
      tableUuid: cold.tableUuid,
      snapshotId: cold.snapshotId,
      scopeDigest: cold.scopeDigest,
      physicalFingerprint: cold.physicalFingerprint,
      position: { manifest: Number(pos.manifest), entry: Number(pos.entry), row: Number(pos.row) },
    };
    if (cold.columns !== undefined) {
      if (!Array.isArray(cold.columns) || cold.columns.length > 21) return invalid();
      result.cold.columns = cold.columns.map((raw) => {
        if (
          !object(raw) ||
          !['fieldId', 'groupIndex', 'byteOffset', 'firstRow'].every(
            (k) => typeof raw[k] === 'number' && Number.isSafeInteger(raw[k]) && Number(raw[k]) >= 0
          ) ||
          Number(raw.fieldId) < 1
        )
          return invalid();
        return {
          fieldId: Number(raw.fieldId),
          groupIndex: Number(raw.groupIndex),
          byteOffset: Number(raw.byteOffset),
          firstRow: Number(raw.firstRow),
        };
      });
    }
  }

  return result;
}
export interface IcebergLogSnapshotPortsInput {
  env: Pick<
    Env,
    'EXPORT_ARTIFACTS' | 'OBJECT_ENCRYPTION_ROOT_KEY' | 'OBJECT_ENCRYPTION_KEY_VERSION'
  > &
    LogIcebergCatalogEnv;
  tenantKey: string;
  resolveCoreSource(context: AdapterContext): Promise<IcebergLogBackupSource>;
  resolveAdminSource(context: AdapterContext): Promise<IcebergLogBackupSource>;
  /** Installed source/routing assertion. This port acquires its own Control environment permit for DDL. */
  assertSourceDdlHeld(context: AdapterContext): Promise<void>;
  catalog?: IcebergCatalogPort;
  store?: (table: IcebergLoadedTable) => IcebergObjectStore;
  now?: () => number;
}

export function createTenantBackupIcebergLogSnapshotPorts(input: IcebergLogSnapshotPortsInput) {
  const config = resolveLogIcebergConfig(input.env),
    now = input.now ?? Date.now,
    bucket = input.env.EXPORT_ARTIFACTS ?? invalid('backup_iceberg_log_configuration_invalid');
  const root =
      input.env.OBJECT_ENCRYPTION_ROOT_KEY ?? invalid('backup_iceberg_log_configuration_invalid'),
    version = Number(input.env.OBJECT_ENCRYPTION_KEY_VERSION ?? '1');
  if (
    !bucket ||
    !root ||
    !/^[a-fA-F0-9]{64}$/.test(root) ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    version > 999999999 ||
    !input.tenantKey ||
    input.tenantKey.length > 256
  )
    return invalid('backup_iceberg_log_configuration_invalid');
  let keyResolver: ReturnType<typeof createLogIcebergKeyResolver> | undefined;
  let remoteCatalog: IcebergCatalogPort | undefined;
  const remote = () => (remoteCatalog ??= createLogIcebergCatalog(input.env, config, 'write'));
  const catalog: IcebergCatalogPort | null = config.localStagingOnly
    ? null
    : (input.catalog ?? {
        loadTable: () => remote().loadTable(),
        commit: (update) => remote().commit(update),
      });
  const selected = (context: AdapterContext) =>
    context.selection.logs.audit ||
    context.selection.logs.other ||
    context.selection.logs.sensitive;
  const store = (table: IcebergLoadedTable) =>
    input.store?.(table) ?? createLogIcebergObjectStore(input.env, table);
  const prepared = new Map<
    string,
    {
      lease: LogIcebergTableLease;
      core: IcebergLogBackupSource;
      admin: IcebergLogBackupSource;
      plan: SchemaPlan;
      coreDigest: string;
      adminDigest: string;
    }
  >();
  const assertLease = async (context: AdapterContext) => {
    context.context.signal.throwIfAborted();
    await context.inventory.headForLease(context.context.lease);
  };
  const aad = (context: AdapterContext, key: string) => ({
    tenantId: identity(context).tenantId,
    objectKey: key,
    objectClass: 'dr_bundle' as const,
  });
  async function readJson(context: AdapterContext, key: string): Promise<unknown> {
    const object = await bucket.get(key);
    if (!object) return null;
    if (object.size > 1024 * 1024) {
      await object.body.cancel();
      return invalid();
    }
    const raw: unknown = JSON.parse(await object.text());
    if (!objectEnvelope(raw)) return invalid();
    const plaintext = await decryptObjectArtifact(raw, {
      rootKeyHex: root,
      context: aad(context, key),
    });
    return JSON.parse(plaintext) as unknown;
  }
  async function writeJson(context: AdapterContext, key: string, value: unknown): Promise<void> {
    await assertLease(context);
    const plaintext = JSON.stringify(value);
    if (new TextEncoder().encode(plaintext).length > 256 * 1024) return invalid();
    const existing = await readJson(context, key);
    if (existing !== null) {
      if (JSON.stringify(existing) !== plaintext)
        return invalid('backup_iceberg_log_capture_changed');
      return;
    }
    const envelope = await encryptObjectArtifact(plaintext, {
      rootKeyHex: root,
      keyVersion: version,
      plane: 'EXPORT_ARTIFACTS',
      contentType: 'application/json',
      context: aad(context, key),
    });
    await bucket.put(key, JSON.stringify(envelope), {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/json' },
    });
    await assertLease(context);
    if (JSON.stringify(await readJson(context, key)) !== plaintext)
      return invalid('backup_iceberg_log_capture_changed');
  }
  function parseSource(value: unknown, tables: readonly string[]): SourcePlan {
    if (
      !object(value) ||
      typeof value.resourceId !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.resourceId) ||
      !Array.isArray(value.schemas) ||
      value.schemas.length !== tables.length ||
      typeof value.schemaDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.schemaDigest)
    )
      return invalid();
    const schemas: CaptureSchema[] = value.schemas.map((raw: unknown, index) => {
      if (!object(raw) || !Array.isArray(raw.columns) || !Array.isArray(raw.uniqueKeys))
        return invalid();
      const columns = raw.columns.map((column: unknown) => {
        if (typeof column !== 'string' || !/^[a-z][a-z0-9_]*$/.test(column)) return invalid();
        return column;
      });
      const uniqueKeys = raw.uniqueKeys.map((key: unknown) => {
        if (!Array.isArray(key) || key.length < 1 || key.length > 64) return invalid();
        return key.map((column: unknown) => {
          if (typeof column !== 'string' || !columns.includes(column)) return invalid();
          return column;
        });
      });
      if (
        raw.table !== tables[index] ||
        raw.tenantColumn !== 'tenant_id' ||
        columns.length > 64 ||
        new Set(columns).size !== columns.length ||
        !columns.includes('id') ||
        !columns.includes('tenant_id') ||
        JSON.stringify(raw.primaryKey) !== '["id"]' ||
        uniqueKeys.length > 64 ||
        raw.uniqueExpressions !== undefined ||
        (raw.tenantOrderIndex !== undefined &&
          (typeof raw.tenantOrderIndex !== 'string' ||
            !/^[a-z][a-z0-9_]*$/.test(raw.tenantOrderIndex)))
      )
        return invalid();
      return {
        table: tables[index],
        tenantColumn: 'tenant_id',
        columns,
        primaryKey: ['id'],
        uniqueKeys,
        ...(typeof raw.tenantOrderIndex === 'string'
          ? { tenantOrderIndex: raw.tenantOrderIndex }
          : {}),
      };
    });
    return { resourceId: value.resourceId, schemas, schemaDigest: value.schemaDigest };
  }
  async function plan(context: AdapterContext): Promise<SchemaPlan> {
    const value = await readJson(context, schemaPrefix(context) + 'schema.json'),
      id = identity(context);
    if (
      !object(value) ||
      value.version !== 1 ||
      value.tenantId !== id.tenantId ||
      value.operationId !== id.operationId ||
      value.tenantKey !== input.tenantKey ||
      value.generation !== config.generation ||
      value.tableUuid !== config.tableUuid ||
      value.physicalFingerprint !== config.physicalFingerprint
    )
      return invalid('backup_iceberg_log_source_changed');
    return {
      version: 1,
      ...id,
      tenantKey: input.tenantKey,
      generation: config.generation,
      tableUuid: config.tableUuid,
      physicalFingerprint: config.physicalFingerprint,
      core: parseSource(value.core, CORE_TABLES),
      admin: parseSource(value.admin, ADMIN_TABLES),
    };
  }
  function boundaryKey(context: AdapterContext, snapshotId: string): string {
    return schemaPrefix(context) + snapshotId + '-boundary.json';
  }
  async function boundary(context: AdapterContext, snapshotId: string): Promise<Boundary> {
    const value = await readJson(context, boundaryKey(context, snapshotId));
    if (
      !object(value) ||
      value.version !== 1 ||
      value.snapshotId !== snapshotId ||
      typeof value.boundaryUnixMs !== 'number' ||
      !Number.isSafeInteger(value.boundaryUnixMs) ||
      value.boundaryUnixMs < 0
    )
      return invalid('backup_iceberg_log_boundary_missing');
    if (config.localStagingOnly) {
      if (value.pinRef !== null || value.pinSnapshotId !== null || value.pinExpiresAt !== null)
        return invalid();
      return {
        version: 1,
        snapshotId,
        boundaryUnixMs: value.boundaryUnixMs,
        pinRef: null,
        pinSnapshotId: null,
        pinExpiresAt: null,
      };
    }
    if (
      typeof value.pinRef !== 'string' ||
      value.pinRef !== 'authrim-dr-' + snapshotId ||
      typeof value.pinSnapshotId !== 'string' ||
      !/^\d+$/.test(value.pinSnapshotId) ||
      typeof value.pinExpiresAt !== 'number' ||
      !Number.isSafeInteger(value.pinExpiresAt)
    )
      return invalid();
    return {
      version: 1,
      snapshotId,
      boundaryUnixMs: value.boundaryUnixMs,
      pinRef: value.pinRef,
      pinSnapshotId: value.pinSnapshotId,
      pinExpiresAt: value.pinExpiresAt,
    };
  }
  async function sources(context: AdapterContext, p: SchemaPlan) {
    const [core, admin] = await Promise.all([
      input.resolveCoreSource(context),
      input.resolveAdminSource(context),
    ]);
    if (core.resourceId !== p.core.resourceId || admin.resourceId !== p.admin.resourceId)
      return invalid('backup_iceberg_log_source_changed');
    return { core, admin };
  }
  async function prepareSources(
    context: AdapterContext & { cursor: string | null }
  ): Promise<{ cursor: string | null; done: boolean }> {
    if (!selected(context)) return { cursor: null, done: true };
    await assertLease(context);
    await input.assertSourceDdlHeld(context);
    const [core, admin] = await Promise.all([
      input.resolveCoreSource(context),
      input.resolveAdminSource(context),
    ]);
    const build = async (
      source: IcebergLogBackupSource,
      tables: readonly string[]
    ): Promise<SourcePlan> => {
      const exists = await source.database.queryOne(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name='tenant_backup_snapshots'"
      );
      if (!exists)
        await source.database.batch(
          splitMigrationSql(SQLITE_SNAPSHOT_SCHEMA).map((sql) => ({ sql }))
        );
      const schemas: CaptureSchema[] = [];
      for (const table of tables) {
        const meta = await readBackupSqliteSchema(source.database, table),
          primary = meta.columns
            .filter((c) => c.primaryKeyPosition > 0)
            .sort((a, b) => a.primaryKeyPosition - b.primaryKeyPosition);
        if (
          primary.length !== 1 ||
          primary[0].name !== 'id' ||
          !primary[0].notNull ||
          !meta.columns.some((c) => c.name === 'tenant_id' && c.notNull) ||
          meta.columns.length > 64
        )
          return invalid('backup_iceberg_log_source_schema_invalid');
        const structure = assessSqliteCaptureStructure(meta);
        if (!structure.schema || structure.schema.uniqueExpressions?.length)
          return invalid('backup_iceberg_log_source_schema_invalid');
        const tenantIndex = sqliteTenantOrderIndex(meta, 'tenant_id', ['id']);
        schemas.push({
          ...structure.schema,
          tenantColumn: 'tenant_id',
          ...(tenantIndex ? { tenantOrderIndex: tenantIndex } : {}),
        });
      }
      const capture = sqliteCapturePlan(schemas),
        installed = await source.database.query<{ name: string; sql: string }>(
          `SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name IN(${capture.triggers.map(() => '?').join(',')})`,
          capture.triggers.map((t) => t.name)
        );
      const missing = capture.triggers.filter((t) => {
        const found = installed.find((i) => i.name === t.name);
        if (found && found.sql.trim().replace(/;+$/, '') !== t.sql)
          return invalid('backup_iceberg_log_capture_trigger_changed');
        return !found;
      });
      if (missing.length) {
        if (
          await source.database.queryOne(
            "SELECT id FROM tenant_backup_snapshots WHERE state='capturing' LIMIT 1"
          )
        )
          return invalid('backup_iceberg_log_install_during_capture');
        await input.assertSourceDdlHeld(context);
        await source.database.batch(missing.map((t) => ({ sql: t.sql })));
      }
      return {
        resourceId: source.resourceId,
        schemas,
        schemaDigest: await logIcebergDigest(JSON.stringify(schemas)),
      };
    };
    const value: SchemaPlan = {
      version: 1,
      ...identity(context),
      tenantKey: input.tenantKey,
      generation: config.generation,
      tableUuid: config.tableUuid,
      physicalFingerprint: config.physicalFingerprint,
      core: await build(core, CORE_TABLES),
      admin: await build(admin, ADMIN_TABLES),
    };
    await writeJson(context, schemaPrefix(context) + 'schema.json', value);
    return { cursor: null, done: true };
  }
  async function prepareBoundary(context: AdapterContext, snapshotId: string): Promise<void> {
    await assertLease(context);
    await input.assertSourceDdlHeld(context);
    const p = await plan(context),
      s = await sources(context, p);
    const lease = new LogIcebergTableLease(
      s.admin.database,
      config.tableUuid ?? 'local-iceberg-backup'
    );
    if (!(await lease.acquire())) return invalid('backup_iceberg_log_table_busy');
    try {
      if (catalog) {
        let table = await catalog.loadTable();
        await validateLogIcebergTable(config, table);
        if (
          table.metadata['current-snapshot-id'] === undefined ||
          Number(table.metadata['current-snapshot-id']) === -1
        ) {
          table = (
            await advanceIcebergMainForGc({
              catalog,
              store: store(table),
              operationId: await logIcebergDigest('backup-empty-' + snapshotId),
              assertFence: () => lease.assert(),
            })
          ).table;
        }
      }
      await lease.assert();
      prepared.set(snapshotId, {
        lease,
        ...s,
        plan: p,
        coreDigest: await readBackupSqliteBoundarySchemaDigest(
          s.core.database,
          context.context.signal
        ),
        adminDigest: await readBackupSqliteBoundarySchemaDigest(
          s.admin.database,
          context.context.signal
        ),
      });
    } catch (error) {
      await lease.release();
      throw error;
    }
  }
  const categoryPort = (category: IcebergLogCategory) =>
    createDeferredEncryptedTenantBackupRecordSnapshotPort({
      env: input.env,
      resourceId: `${ICEBERG_LOG_SNAPSHOT_RESOURCE}:${category}`,
      assertSource: async (context) => {
        await assertLease(context);
        await plan(context);
      },
      async *materializePlan(_context, bytes) {
        yield bytes;
      },
    });
  const categoryPorts = {
    audit: categoryPort('audit'),
    other: categoryPort('other'),
    sensitive: categoryPort('sensitive'),
  };
  async function loadPin(context: AdapterContext, b: Boundary): Promise<IcebergLoadedTable | null> {
    if (!catalog) return null;
    const table = await catalog.loadTable();
    await validateLogIcebergTable(config, table);
    const ref = table.metadata.refs?.[b.pinRef ?? ''],
      snapshot = table.metadata.snapshots?.find(
        (s) => String(s['snapshot-id']) === b.pinSnapshotId
      );
    if (
      !ref ||
      ref.type !== 'tag' ||
      String(ref['snapshot-id']) !== b.pinSnapshotId ||
      !snapshot ||
      b.pinExpiresAt === null ||
      now() >= b.pinExpiresAt ||
      snapshot['timestamp-ms'] + (ref['max-ref-age-ms'] ?? 0) !== b.pinExpiresAt
    )
      return invalid('backup_iceberg_log_source_expired');
    return table;
  }
  async function start(
    context: AdapterContext,
    snapshotId: string,
    assertHeld: () => Promise<void>,
    boundaryUnixMs: number
  ): Promise<void> {
    const ready = prepared.get(snapshotId);
    if (!ready) return invalid('backup_iceberg_log_boundary_unprepared');
    const { lease, plan: p, core, admin } = ready;
    try {
      await assertHeld();
      await lease.assert();
      await assertLease(context);
      if (!Number.isSafeInteger(boundaryUnixMs) || boundaryUnixMs < 0) return invalid();
      const done = await readJson(context, boundaryKey(context, snapshotId));
      if (done !== null) {
        const saved = await boundary(context, snapshotId);
        if (saved.boundaryUnixMs !== boundaryUnixMs)
          return invalid('backup_iceberg_log_boundary_changed');
        await Promise.all([
          active(core.database, cowId(snapshotId, 'core'), identity(context).tenantId),
          active(admin.database, cowId(snapshotId, 'admin'), identity(context).tenantId),
        ]);
        await loadPin(context, saved);
        await assertHeld();
        return;
      }
      const intentKey = schemaPrefix(context) + snapshotId + '-intent.json',
        intent = await readJson(context, intentKey);
      if (intent !== null) {
        if (!object(intent) || intent.boundaryUnixMs !== boundaryUnixMs)
          return invalid('backup_iceberg_log_boundary_changed');
        const headers = await Promise.all([
          core.database.queryOne<{ state: string }>(
            'SELECT state FROM tenant_backup_snapshots WHERE id=?',
            [cowId(snapshotId, 'core')]
          ),
          admin.database.queryOne<{ state: string }>(
            'SELECT state FROM tenant_backup_snapshots WHERE id=?',
            [cowId(snapshotId, 'admin')]
          ),
        ]);
        // A new hold cannot silently combine an old partial SQL boundary with a new
        // Catalog boundary. Completed captures recover from the exact persisted pin.
        if (headers.some(Boolean)) {
          const table = catalog ? await catalog.loadTable() : null,
            ref = table?.metadata.refs?.['authrim-dr-' + snapshotId];
          if (!headers.every((h) => h?.state === 'capturing') || (catalog && !ref))
            return invalid('backup_iceberg_log_partial_capture');
          if (!catalog) return invalid('backup_iceberg_log_partial_capture');
          const snapshot = table?.metadata.snapshots?.find(
            (s) => String(s['snapshot-id']) === String(ref?.['snapshot-id'])
          );
          if (!snapshot || !ref) return invalid();
          const recovered: Boundary = {
            version: 1,
            snapshotId,
            boundaryUnixMs,
            pinRef: 'authrim-dr-' + snapshotId,
            pinSnapshotId: String(ref['snapshot-id']),
            pinExpiresAt: snapshot['timestamp-ms'] + (ref['max-ref-age-ms'] ?? 0),
          };
          await loadPin(context, recovered);
          await writeJson(context, boundaryKey(context, snapshotId), recovered);
          await assertHeld();
          return;
        }
      }
      await writeJson(context, intentKey, { version: 1, snapshotId, boundaryUnixMs });
      if (
        (await readBackupSqliteBoundarySchemaDigest(core.database, context.context.signal)) !==
          ready.coreDigest ||
        (await readBackupSqliteBoundarySchemaDigest(admin.database, context.context.signal)) !==
          ready.adminDigest
      )
        return invalid('backup_schema_changed_during_boundary');
      for (const [source, schemas, id] of [
        [core, p.core.schemas, cowId(snapshotId, 'core')],
        [admin, p.admin.schemas, cowId(snapshotId, 'admin')],
      ] as const) {
        await assertHeld();
        await lease.assert();
        const statement = sqliteSnapshotStartOrResumeStatement(
          schemas,
          id,
          identity(context).tenantId,
          input.tenantKey
        );
        const result = await source.database.execute(statement.sql, statement.params);
        if (!result.success || result.rowsAffected !== 1)
          return invalid('backup_iceberg_log_capture_rejected');
      }
      let result: Boundary = {
        version: 1,
        snapshotId,
        boundaryUnixMs,
        pinRef: null,
        pinSnapshotId: null,
        pinExpiresAt: null,
      };
      if (catalog) {
        await assertHeld();
        const table = await catalog.loadTable();
        await validateLogIcebergTable(config, table);
        await lease.assert();
        const watermark = await admin.database.queryOne<{
          snapshot_id: string;
          minimum_sequence_number: number;
        }>(
          'SELECT snapshot_id,minimum_sequence_number FROM log_iceberg_read_watermarks WHERE table_uuid=?',
          [config.tableUuid]
        );
        if (watermark)
          assertIcebergSnapshotLineage(table.metadata, {
            tableUuid: table.metadata['table-uuid'],
            snapshotId: watermark.snapshot_id,
            sequenceNumber: watermark.minimum_sequence_number,
          });
        const ref = 'authrim-dr-' + snapshotId;
        const pinned = await new IcebergLifecycle({
          catalog,
          store: store(table),
          tableLocation: table.metadata.location,
        }).pinSnapshot(ref, String(table.metadata['current-snapshot-id']), PIN_MS);
        const entry = pinned.metadata.refs?.[ref],
          snapshot = pinned.metadata.snapshots?.find(
            (s) => String(s['snapshot-id']) === String(entry?.['snapshot-id'])
          );
        if (!entry || !snapshot) return invalid();
        result = {
          ...result,
          pinRef: ref,
          pinSnapshotId: String(entry['snapshot-id']),
          pinExpiresAt: snapshot['timestamp-ms'] + (entry['max-ref-age-ms'] ?? 0),
        };
      }
      await assertHeld();
      await lease.assert();
      await writeJson(context, boundaryKey(context, snapshotId), result);
      await assertHeld();
    } finally {
      prepared.delete(snapshotId);
      await lease.release();
    }
  }
  async function publication(
    context: AdapterContext,
    p: SchemaPlan,
    s: { core: IcebergLogBackupSource; admin: IcebergLogBackupSource },
    snapshotId: string,
    recordId: string,
    hmac: string,
    publicationId?: string | null
  ): Promise<boolean> {
    const tenantId = identity(context).tenantId,
      adminId = cowId(snapshotId, 'admin');
    let pub: PortableSqliteRow | null;
    if (publicationId === null) return true;
    if (publicationId !== undefined)
      pub = await point(
        s.admin.database,
        schemaOf(p.admin, 'log_iceberg_publications'),
        adminId,
        tenantId,
        publicationId
      );
    else {
      const matches = await lookupSqliteSnapshotRows({
        database: s.admin.database,
        schema: schemaOf(p.admin, 'log_iceberg_publications'),
        snapshotId: adminId,
        tenantId,
        column: 'record_id',
        values: [recordId],
        preimageLimit: 10000,
        signal: context.context.signal,
      });
      if (matches.length > 1) return invalid();
      pub = matches[0]?.row ?? null;
      if (!pub) return true;
    }
    if (!pub) return invalid('backup_iceberg_log_publication_missing');
    const state = required(pub, 'state');
    if (state === 'aborted') return false;
    if (
      required(pub, 'record_id') !== recordId ||
      required(pub, 'payload_hmac') !== hmac ||
      required(pub, 'tenant_id') !== tenantId
    )
      return invalid('backup_iceberg_log_publication_changed');
    const core = await point(
      s.core.database,
      schemaOf(p.core, 'log_iceberg_core_publications'),
      cowId(snapshotId, 'core'),
      tenantId,
      required(pub, 'id')
    );
    if (!core) {
      if (state === 'published') return invalid('backup_iceberg_log_publication_missing');
      return false;
    }
    if (!['committed', 'published'].includes(required(core, 'state'))) return false;
    if (
      integer(core, 'body_prepared') !== 1 ||
      [
        'id',
        'record_id',
        'payload_hmac',
        'source_digest',
        'source_token',
        'tenant_id',
        'storage_generation',
        'source_dataset',
      ].some((k) => tagged(core, k) !== tagged(pub, k))
    )
      return invalid('backup_iceberg_log_publication_changed');
    return true;
  }
  async function restoredRowHidden(
    context: AdapterContext,
    p: SchemaPlan,
    s: IcebergLogBackupSource,
    snapshotId: string,
    record: LogArchiveRecord
  ): Promise<boolean> {
    const id = await logIcebergRecordId(record);
    const hold = await point(
      s.database,
      schemaOf(p.admin, 'log_iceberg_restore_holds'),
      cowId(snapshotId, 'admin'),
      identity(context).tenantId,
      id
    );
    if (!hold) return false;
    if (
      required(hold, 'id') !== id ||
      required(hold, 'tenant_id') !== identity(context).tenantId ||
      required(hold, 'payload_hmac') !== record.payload_hmac ||
      required(hold, 'storage_generation') !== record.storage_generation
    )
      return invalid('backup_iceberg_log_restore_hold_changed');
    const state = required(hold, 'state');
    if (!['holding', 'aborted'].includes(state)) return invalid();
    if (state === 'aborted') return true;
    const operationId = required(hold, 'operation_id');
    const activation = await point(
      s.database,
      schemaOf(p.admin, 'log_iceberg_restore_activations'),
      cowId(snapshotId, 'admin'),
      identity(context).tenantId,
      operationId
    );
    if (!activation) return true;
    if (
      required(activation, 'id') !== operationId ||
      required(activation, 'tenant_id') !== identity(context).tenantId ||
      required(activation, 'storage_generation') !== record.storage_generation
    )
      return invalid('backup_iceberg_log_restore_hold_changed');
    const activationState = required(activation, 'state');
    if (!['pending', 'active', 'aborted'].includes(activationState)) return invalid();
    return activationState !== 'active';
  }
  async function erased(
    context: AdapterContext,
    p: SchemaPlan,
    s: IcebergLogBackupSource,
    snapshotId: string,
    record: LogArchiveRecord
  ): Promise<boolean> {
    if (record.source_dataset !== 'pii.pii_log' || !record.subject_id) return false;
    const id = await logIcebergDigest(
      JSON.stringify([identity(context).tenantId, record.source_dataset, record.subject_id])
    );
    // Only test existence: a physical GC receipt can be large and is not DR data.
    return !!(await s.database.queryOne(
      `SELECT 1 AS present FROM (${sqliteSnapshotRowQuery(schemaOf(p.admin, 'log_iceberg_subject_erasures'))})`,
      [cowId(snapshotId, 'admin'), identity(context).tenantId, JSON.stringify([['text', id]])]
    ));
  }
  async function hotRecord(
    context: AdapterContext,
    p: SchemaPlan,
    s: IcebergLogBackupSource,
    snapshotId: string,
    row: PortableSqliteRow
  ): Promise<LogArchiveRecord> {
    const count = integer(row, 'part_count'),
      bytes = integer(row, 'body_bytes'),
      id = required(row, 'id');
    if (count < 1 || count > 64 || bytes < 1 || bytes > 4 * 1024 * 1024) return invalid();
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
      const part = await point(
        s.database,
        schemaOf(p.admin, 'log_iceberg_record_parts'),
        cowId(snapshotId, 'admin'),
        identity(context).tenantId,
        `${id}_${i}`
      );
      if (!part || required(part, 'record_id') !== id || integer(part, 'part_index') !== i)
        return invalid('backup_iceberg_log_body_missing');
      const body = required(part, 'body');
      if (body.length < 1 || body.length > 65536) return invalid();
      parts.push(body);
    }
    const body = parts.join('');
    if (
      body.length !== bytes ||
      (await logIcebergDigest(body)) !== required(row, 'envelope_digest')
    )
      return invalid('backup_iceberg_log_body_changed');
    const header: unknown = JSON.parse(required(row, 'header_json'));
    if (!object(header)) return invalid();
    const record = { ...header, detail_ciphertext: body };
    assertLogArchiveRecord(record);
    if (
      (await logIcebergRecordId(record)) !== id ||
      record.tenant_key !== input.tenantKey ||
      record.payload_hmac !== required(row, 'payload_hmac') ||
      record.event_id !== required(row, 'event_id') ||
      record.source_dataset !== required(row, 'source_dataset')
    )
      return invalid();
    return record;
  }
  function retryReference(row: PortableSqliteRow): LogIcebergQueueReference {
    const sourceDataset = required(row, 'source_dataset');
    return {
      payload_type: 'iceberg_ingest',
      schema_version: 1,
      id: required(row, 'id'),
      storage_generation: required(row, 'storage_generation'),
      source_dataset: sourceDataset,
      subject_id: tagged(row, 'subject_id'),
      payload_hmac: required(row, 'payload_hmac'),
      payload_key: required(row, 'payload_key'),
      payload_digest: required(row, 'payload_digest'),
      payload_bytes: integer(row, 'payload_bytes'),
      expires_at: nullableTime(row, 'expires_at'),
    };
  }
  async function pull(
    context: AdapterContext,
    p: SchemaPlan,
    s: { core: IcebergLogBackupSource; admin: IcebergLogBackupSource },
    b: Boundary,
    value: PrepareCursor
  ): Promise<{ record: LogArchiveRecord | null; next: PrepareCursor }> {
    const next = { ...value };
    const tenantId = identity(context).tenantId;
    if (value.stage === 'hot' || value.stage === 'retry') {
      if (
        (value.stage === 'hot' && config.mode === 'pipeline') ||
        (value.stage === 'retry' && config.mode === 'scheduled')
      ) {
        next.stage = value.stage === 'hot' ? 'retry' : 'cold';
        delete next.sql;
        return { record: null, next };
      }
      const schema = schemaOf(
        p.admin,
        value.stage === 'hot' ? 'log_iceberg_records' : 'log_iceberg_outbox'
      );
      const read = await nextRow(
        s.admin.database,
        schema,
        cowId(b.snapshotId, 'admin'),
        tenantId,
        context.context.signal,
        value.sql
      );
      next.sql = read.cursor;
      if (read.done) {
        next.stage = value.stage === 'hot' ? 'retry' : 'cold';
        delete next.sql;
        return { record: null, next };
      }
      if (!read.row) return { record: null, next };
      const row = read.row,
        id = required(row, 'id'),
        hmac = required(row, 'payload_hmac'),
        pubId = tagged(row, 'publication_id');
      const expiry = nullableTime(row, 'expires_at');
      if (expiry !== null && expiry <= b.boundaryUnixMs) return { record: null, next };
      if (
        value.stage === 'retry' &&
        (required(row, 'state') === 'erased' ||
          (required(row, 'state') === 'preparing' && pubId === null))
      )
        return { record: null, next };
      if (!(await publication(context, p, s, b.snapshotId, id, hmac, pubId)))
        return { record: null, next };
      const record =
        value.stage === 'hot'
          ? await hotRecord(context, p, s.admin, b.snapshotId, row)
          : await readLogIcebergRetryPayload(input.env, retryReference(row));
      return { record, next };
    }
    if (value.stage === 'cold') {
      if (!catalog) {
        next.stage = 'done';
        return { record: null, next };
      }
      const table = await loadPin(context, b);
      if (!table || !b.pinSnapshotId) return invalid();
      const window = tenantBackupLogWindow(context.selection.logs.period, b.boundaryUnixMs);
      const page = await readSnapshotPage({
        table,
        store: store(table),
        snapshotId: b.pinSnapshotId,
        tenantKey: input.tenantKey,
        sourceDatasets: ICEBERG_LOG_SOURCE_DATASETS,
        nowMs: b.boundaryUnixMs,
        ...(window.fromInclusiveUnixMs === null ? {} : { eventAtFrom: window.fromInclusiveUnixMs }),
        eventAtTo: window.untilInclusiveUnixMs + 1,
        pageSize: 1,
        cursor: value.cold,
      });
      next.cold = page.nextCursor;
      if (page.complete) {
        next.stage = 'done';
        delete next.cold;
      }
      if (page.records.length > 1) return invalid();
      const record = page.records[0] ?? null;
      if (
        record &&
        !(await publication(
          context,
          p,
          s,
          b.snapshotId,
          await logIcebergRecordId(record),
          record.payload_hmac
        ))
      )
        return { record: null, next };
      return { record, next };
    }
    return { record: null, next };
  }
  function operationGuard(context: AdapterContext): { sql: string; params: unknown[] } {
    const lease = context.context.lease;
    return {
      sql: "EXISTS(SELECT 1 FROM tenant_backup_operations WHERE id=? AND tenant_id=? AND state='running' AND lease_owner=? AND fencing_token=? AND lease_expires_at>? AND updated_at<=?)",
      params: [lease.operationId, lease.tenantId, lease.owner, lease.fencingToken, now(), now()],
    };
  }
  async function prepareArtifactResources(
    context: AdapterContext & { cursor: string | null; boundaryUnixMs: number }
  ): Promise<{ cursor: string | null; done: boolean }> {
    if (!selected(context)) return { cursor: null, done: true };
    await assertLease(context);
    const p = await plan(context),
      snapshotId = await tenantBackupRecordSnapshotId(context, ICEBERG_LOG_SNAPSHOT_RESOURCE),
      b = await boundary(context, snapshotId),
      s = await sources(context, p);
    if (b.boundaryUnixMs !== context.boundaryUnixMs)
      return invalid('backup_iceberg_log_boundary_changed');
    await Promise.all([
      active(s.core.database, cowId(snapshotId, 'core'), identity(context).tenantId),
      active(s.admin.database, cowId(snapshotId, 'admin'), identity(context).tenantId),
    ]);
    await loadPin(context, b);
    let position = cursor(context.cursor);
    const plans: { category: IcebergLogCategory; bytes: Uint8Array }[] = [],
      seen: { id: string; hmac: string }[] = [],
      local = new Map<string, string>();
    let bytes = 0;
    const deadline = now() + 8000;
    for (
      let steps = 0;
      steps < 32 && position.stage !== 'done' && plans.length < 16 && now() < deadline;
      steps++
    ) {
      const previous = position,
        read = await pull(context, p, s, b, position),
        record = read.record;
      if (!record) {
        position = read.next;
        continue;
      }
      if (
        !icebergLogSelected(record, context.selection, b.boundaryUnixMs) ||
        (await erased(context, p, s.admin, snapshotId, record)) ||
        (await restoredRowHidden(context, p, s.admin, snapshotId, record))
      ) {
        position = read.next;
        continue;
      }
      if (record.expires_at !== null && record.expires_at <= now())
        return invalid('backup_iceberg_log_source_expired');
      const encoded = await encodePortableIcebergLog({
        record,
        tenantId: identity(context).tenantId,
        tenantKey: input.tenantKey,
        resolveKeys: async (version) =>
          (keyResolver ??= createLogIcebergKeyResolver(input.env))(version),
        includeSensitiveDetails: context.selection.logs.sensitive,
      });
      const id = await logIcebergRecordId(record),
        hmac = record.payload_hmac;
      const saved = await s.admin.database.queryOne<{ payload_hmac: string; page_ordinal: number }>(
        'SELECT payload_hmac,page_ordinal FROM log_iceberg_backup_seen WHERE operation_id=? AND resource_id=? AND record_id=?',
        [identity(context).operationId, ICEBERG_LOG_SNAPSHOT_RESOURCE, id]
      );
      if (saved && (saved.payload_hmac !== hmac || saved.page_ordinal > position.pages))
        return invalid('backup_iceberg_log_content_collision');
      if ((saved && saved.page_ordinal < position.pages) || local.has(id)) {
        if (local.has(id) && local.get(id) !== hmac)
          return invalid('backup_iceberg_log_content_collision');
        position = read.next;
        continue;
      }
      if (encoded.length > MAX_PLAN_BYTES) return invalid('backup_export_too_large');
      if (plans.length && encoded.length > MAX_PLAN_BYTES - bytes) {
        position = previous;
        break;
      }
      plans.push({ category: icebergLogCategory(record), bytes: encoded });
      bytes += encoded.length;
      seen.push({ id, hmac });
      local.set(id, hmac);
      position = read.next;
    }
    if (plans.length) {
      for (const category of ICEBERG_LOG_CATEGORIES) {
        const categoryPlans = plans
          .filter((plan) => plan.category === category)
          .map((plan) => plan.bytes);
        if (categoryPlans.length)
          await categoryPorts[category].writePlanPage(
            context,
            snapshotId,
            position.categoryPages[category],
            categoryPlans
          );
      }
      const guard = operationGuard(context);
      const results = await s.admin.database.batch(
        seen.map((row) => ({
          sql: `INSERT INTO log_iceberg_backup_seen(tenant_id,operation_id,resource_id,record_id,payload_hmac,page_ordinal) SELECT ?,?,?,?,?,? WHERE ${guard.sql} ON CONFLICT(operation_id,resource_id,record_id) DO UPDATE SET payload_hmac=CASE WHEN log_iceberg_backup_seen.tenant_id=excluded.tenant_id AND log_iceberg_backup_seen.payload_hmac=excluded.payload_hmac AND log_iceberg_backup_seen.page_ordinal=excluded.page_ordinal THEN excluded.payload_hmac ELSE NULL END`,
          params: [
            identity(context).tenantId,
            identity(context).operationId,
            ICEBERG_LOG_SNAPSHOT_RESOURCE,
            row.id,
            row.hmac,
            position.pages,
            ...guard.params,
          ],
        }))
      );
      if (results.length !== seen.length || results.some((r) => !r.success || r.rowsAffected !== 1))
        return invalid('backup_iceberg_log_fenced');
      await assertLease(context);
      for (const category of ICEBERG_LOG_CATEGORIES) {
        if (plans.some((plan) => plan.category === category)) position.categoryPages[category]++;
      }
      position.pages++;
    }
    if (position.stage === 'done') {
      for (const category of ICEBERG_LOG_CATEGORIES)
        await categoryPorts[category].publishPlans(
          context,
          snapshotId,
          b.boundaryUnixMs,
          position.categoryPages[category]
        );
      await assertLease(context);
      return { cursor: null, done: true };
    }
    return { cursor: JSON.stringify(position), done: false };
  }
  async function assertCleanup(context: AdapterContext, admin: Database): Promise<void> {
    context.context.signal.throwIfAborted();
    const lease = context.context.lease;
    if (
      !(await admin.queryOne(
        "SELECT id FROM tenant_backup_operations WHERE id=? AND tenant_id=? AND state IN('running','cancelling') AND lease_owner=? AND fencing_token=? AND lease_expires_at>? AND updated_at<=?",
        [lease.operationId, lease.tenantId, lease.owner, lease.fencingToken, now(), now()]
      ))
    )
      return invalid('backup_iceberg_log_fenced');
  }
  async function releasePage(context: AdapterContext, snapshotId: string): Promise<boolean> {
    const schema = await readJson(context, schemaPrefix(context) + 'schema.json');
    const s =
      schema === null
        ? {
            core: await input.resolveCoreSource(context),
            admin: await input.resolveAdminSource(context),
          }
        : await sources(context, await plan(context));
    const tenantId = identity(context).tenantId;
    await assertCleanup(context, s.admin.database);
    if (catalog) {
      const lease = new LogIcebergTableLease(
        s.admin.database,
        config.tableUuid ?? 'local-iceberg-backup'
      );
      if (!(await lease.acquire())) return false;
      try {
        const table = await catalog.loadTable();
        await validateLogIcebergTable(config, table);
        const ref = 'authrim-dr-' + snapshotId,
          entry = table.metadata.refs?.[ref];
        if (entry) {
          const captured = await readJson(context, boundaryKey(context, snapshotId));
          if (captured !== null) {
            const saved = await boundary(context, snapshotId);
            if (saved.pinRef !== ref || saved.pinSnapshotId !== String(entry['snapshot-id']))
              return invalid('backup_iceberg_log_pin_changed');
          } else {
            const pinned = table.metadata.snapshots?.find(
              (s) => String(s['snapshot-id']) === String(entry['snapshot-id'])
            );
            const summary = pinned?.summary;
            if (
              entry.type !== 'tag' ||
              !summary ||
              !('authrim.dr-source-snapshot-id' in summary) ||
              typeof summary['authrim.dr-source-snapshot-id'] !== 'string'
            )
              return invalid('backup_iceberg_log_pin_changed');
          }
          await lease.assert();
          await new IcebergLifecycle({
            catalog,
            store: store(table),
            tableLocation: table.metadata.location,
          }).releaseSnapshotPin(ref, String(entry['snapshot-id']), table.metadata['table-uuid']);
          await lease.assert();
        }
      } finally {
        await lease.release();
      }
    }
    await assertCleanup(context, s.admin.database);
    let complete = true;
    for (const [source, id] of [
      [s.core, cowId(snapshotId, 'core')],
      [s.admin, cowId(snapshotId, 'admin')],
    ] as const) {
      await assertCleanup(context, s.admin.database);
      await tombstoneSqliteBackupSnapshot(source.database, id, tenantId);
      const page = await cleanupSqliteBackupSnapshotPage(source.database, id, tenantId, true);
      if (!page.complete) complete = false;
    }
    const deleted = await s.admin.database.execute(
      'DELETE FROM log_iceberg_backup_seen WHERE operation_id=? AND resource_id=? AND record_id IN(SELECT record_id FROM log_iceberg_backup_seen WHERE operation_id=? AND resource_id=? ORDER BY record_id LIMIT 100)',
      [
        identity(context).operationId,
        ICEBERG_LOG_SNAPSHOT_RESOURCE,
        identity(context).operationId,
        ICEBERG_LOG_SNAPSHOT_RESOURCE,
      ]
    );
    if (!deleted.success) return invalid();
    if (
      await s.admin.database.queryOne(
        'SELECT 1 FROM log_iceberg_backup_seen WHERE operation_id=? AND resource_id=? LIMIT 1',
        [identity(context).operationId, ICEBERG_LOG_SNAPSHOT_RESOURCE]
      )
    )
      complete = false;
    for (const category of ICEBERG_LOG_CATEGORIES)
      if (!(await categoryPorts[category].releasePage(context, snapshotId))) {
        complete = false;
        break;
      }
    await assertCleanup(context, s.admin.database);
    if (complete) {
      const page = await bucket.list({ prefix: schemaPrefix(context), limit: 1000 });
      if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
      if (page.truncated) complete = false;
    }
    return complete;
  }
  const coveredPrepare = (context: AdapterContext, snapshotId: string) =>
    runTenantBackupCoveredEffect(
      { ...input.env, TENANT_BACKUP_WRAPPING_KEY: 'required' },
      { environment: true },
      () => prepareBoundary(context, snapshotId)
    );
  const port: Phase5RecordSnapshotPort = {
    resourceId: ICEBERG_LOG_SNAPSHOT_RESOURCE,
    assertSource: async (context) => {
      await assertLease(context);
      if (selected(context)) await plan(context);
    },
    async readNext(context, snapshotId, cursor, signal) {
      const datasetId = context.datasetId;
      if (typeof datasetId !== 'string') return invalid();
      const category = icebergLogDatasetCategory(datasetId);
      if (!context.selection.logs[category])
        return invalid('backup_iceberg_log_category_not_selected');
      return categoryPorts[category].readNext(context, snapshotId, cursor, signal);
    },
    start,
    prepareBoundary: coveredPrepare,
    releasePage,
    async release(context, snapshotId) {
      for (let i = 0; i < 16; i++) if (await releasePage(context, snapshotId)) return;
      invalid('backup_iceberg_log_cleanup_requires_cursor');
    },
    async assertReleased(context, snapshotId) {
      const [core, admin] = await Promise.all([
        input.resolveCoreSource(context),
        input.resolveAdminSource(context),
      ]);
      for (const [source, id] of [
        [core, cowId(snapshotId, 'core')],
        [admin, cowId(snapshotId, 'admin')],
      ] as const) {
        const header = await source.database.queryOne<{ state: string }>(
          'SELECT state FROM tenant_backup_snapshots WHERE id=?',
          [id]
        );
        if (header && header.state !== 'invalid') return invalid('backup_iceberg_log_not_released');
        if (
          await source.database.queryOne(
            'SELECT 1 FROM tenant_backup_preimages WHERE snapshot_id=? LIMIT 1',
            [id]
          )
        )
          return invalid('backup_iceberg_log_not_released');
      }
      await assertCleanup(context, admin.database);
      if (
        await admin.database.queryOne(
          'SELECT 1 FROM log_iceberg_backup_seen WHERE operation_id=? AND resource_id=? LIMIT 1',
          [identity(context).operationId, ICEBERG_LOG_SNAPSHOT_RESOURCE]
        )
      )
        return invalid('backup_iceberg_log_not_released');
      if (catalog && (await catalog.loadTable()).metadata.refs?.['authrim-dr-' + snapshotId])
        return invalid('backup_iceberg_log_not_released');
      if ((await bucket.list({ prefix: schemaPrefix(context), limit: 1 })).objects.length)
        return invalid('backup_iceberg_log_not_released');
      for (const category of ICEBERG_LOG_CATEGORIES)
        await categoryPorts[category].assertReleased(context, snapshotId);
    },
  };
  return {
    records: port,
    prepareSources: (context: AdapterContext & { cursor: string | null }) =>
      selected(context)
        ? runTenantBackupCoveredEffect(
            { ...input.env, TENANT_BACKUP_WRAPPING_KEY: 'required' },
            { environment: true },
            () => prepareSources(context)
          )
        : Promise.resolve({ cursor: null, done: true }),
    prepareBoundary: coveredPrepare,
    prepareArtifactResources,
  };
}
function objectEnvelope(value: unknown): value is EncryptedObjectArtifactEnvelope {
  return (
    object(value) &&
    value.version === 1 &&
    value.algorithm === 'AES-256-GCM' &&
    value.plane === 'EXPORT_ARTIFACTS' &&
    value.objectClass === 'dr_bundle' &&
    value.contentType === 'application/json' &&
    typeof value.keyVersion === 'number' &&
    Number.isSafeInteger(value.keyVersion) &&
    value.keyVersion > 0 &&
    typeof value.iv === 'string' &&
    typeof value.ciphertext === 'string'
  );
}
