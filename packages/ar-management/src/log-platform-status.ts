/**
 * Log platform status: one read-only picture of the log archive (Iceberg in R2 Data Catalog),
 * the delivery path that fills it, the audit coverage registry and the sensitive-detail chunk
 * catalog. Everything here is a cheap read: one Catalog `loadTable()`, a handful of COUNTs and the
 * code registry. No Basin Catalog maintenance API is called (Workers hold no account API token),
 * so compaction is inferred from the table's own snapshots.
 */
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import { AdminLoggingControlRepository } from '@authrim/ar-lib-core';
import {
  resolveLogIcebergConfig,
  type LogIcebergConfig,
  type LogIcebergSettingsEnv,
} from '@authrim/ar-lib-core/services/log-iceberg-config';
import {
  createLogIcebergCatalog,
  type LogIcebergCatalogEnv,
} from '@authrim/ar-lib-core/services/log-iceberg-catalog';
import { logIcebergPublicationVisibleSql } from '@authrim/ar-lib-core/services/log-iceberg-store';
import { LOG_ARCHIVE_READ_LIMITS, type IcebergLoadedTable } from '@authrim/ar-lib-logging/iceberg';
import {
  LOGGING_ADMIN_AUDIT_COVERAGE_REGISTRY,
  summarizeAdminAuditCoverage,
  type AdminAuditCoverageSummary,
} from '@authrim/ar-lib-logging/coverage';
import type { LogReadCoverage } from './log-read-adapter';

export interface LogPlatformSnapshot {
  id: string;
  committed_at: number;
  operation: string | null;
  total_data_files: number | null;
  total_records: number | null;
}

export interface LogPlatformArchiveStatus {
  configured: boolean;
  /** `log_iceberg_configuration_required` / `_invalid` when not configured. */
  configuration_error: string | null;
  mode: 'pipeline' | 'scheduled' | null;
  generation: string | null;
  activated_at: number | null;
  local_staging_only: boolean;
  /** Scheduled mode: how often an export is due, in minutes. */
  export_interval_minutes: number | null;
  /** `loadTable()` answered and the table is the configured one. */
  reachable: boolean;
  reachability_error: string | null;
  /**
   * The table's own statistics. Every tenant shares the table, so they are only handed to a
   * platform caller; a tenant caller gets null here and keeps its own `read_probe`.
   */
  table: {
    uuid: string;
    snapshot_count: number;
    current_snapshot: LogPlatformSnapshot | null;
    /** Newest snapshot whose operation is `replace` (what Catalog compaction commits). */
    last_compaction_at: number | null;
  } | null;
  /**
   * A size heuristic, platform callers only: the reader opens at most `max_files` files per
   * read after pruning by tenant, dataset and time, so a table with more data files than that is
   * at risk of incomplete views, not certain to give them. `read_probe` is the real answer.
   */
  table_size_hint: {
    max_files: number;
    data_files_over_limit: boolean;
  } | null;
  /** Outcome of the 24-hour admin audit read through the ordinary read path. */
  read_probe: {
    ok: boolean;
    reason: string | null;
    has_archive: boolean;
    coverage: LogReadCoverage | null;
  };
}

export interface LogPlatformDeliveryStatus {
  /**
   * Records in the window (`window_start_at` to now), by how far they got: sealed as the
   * authoritative entry (`published`), still being sealed (`prepared`), withdrawn (`aborted`),
   * and confirmed inside an Iceberg snapshot (`ingested`, pipeline mode).
   */
  recent: { prepared: number; published: number; aborted: number; ingested: number };
  /**
   * When the Pipeline stream last acknowledged a record of this scope (pipeline mode).
   * Acceptance is not yet a commit: the record is in a Parquet file only after the next commit.
   */
  last_ingested_at: number | null;
  /**
   * When the oldest publication still `prepared` was created, in either mode. A publication
   * whose reconciliation stalled after the business commit never becomes visible to export or
   * delivery, so it is tracked here on its own.
   */
  oldest_prepared_at: number | null;
  /**
   * Pipeline mode only. `pending` includes intents still `preparing`: a publication whose
   * reconciliation stalled after the business commit sits there and must count as waiting.
   */
  outbox: {
    pending: number;
    queued: number;
    oldest_pending_at: number | null;
    last_error_code: string | null;
  } | null;
  /** Scheduled mode only. */
  export: {
    last_state: string | null;
    last_error_code: string | null;
    updated_at: number | null;
    /** The newest batch that failed and is not done yet, whatever happened after it. */
    active_failure: { batch_id: string; error_code: string; updated_at: number } | null;
    /** When the oldest batch that is not done yet was created; a stalled exporter shows here. */
    oldest_unfinished_at: number | null;
    /**
     * Since when the oldest export-eligible record has been waiting for a batch: a published,
     * visible staged record past the D1 retention period that no batch has selected. An
     * exporter that stopped between batches leaves no unfinished batch, only these.
     */
    oldest_eligible_since: number | null;
    watermark: {
      snapshot_id: string;
      minimum_sequence_number: number;
      updated_at: number;
    } | null;
  } | null;
}

export interface LogPlatformStatus {
  generated_at: number;
  window_start_at: number;
  archive: LogPlatformArchiveStatus;
  delivery: LogPlatformDeliveryStatus;
  audit_coverage: AdminAuditCoverageSummary;
  /**
   * The chunk-format catalog that the sensitive-detail writer (and the retention archive copy)
   * still fill. Findings are what the safe repair would act on; `sensitive_detail` is the part
   * of them on that plane.
   */
  chunk_catalog: {
    /** The detector looks at the newest `scan_limit` catalog rows: a sample, not a backlog total. */
    scan_limit: number;
    sampled_repair_findings: number;
    sampled_sensitive_detail_findings: number;
    /**
     * Live sensitive-detail chunk index rows, per index store (stores may alias one database).
     * A store without the table reports null and a fixed code instead of failing the view.
     */
    sensitive_detail_index: {
      store: string;
      indexed_objects: number | null;
      error: 'index_table_missing' | 'index_unavailable' | null;
    }[];
  };
  delivery_lanes: { lane: string; status: string; total: number }[];
}

export interface LogPlatformReadProbe {
  ok: boolean;
  reason: string | null;
  has_archive: boolean;
  coverage: LogReadCoverage | null;
}

export interface BuildLogPlatformStatusInput {
  env: LogIcebergSettingsEnv & LogIcebergCatalogEnv;
  adapter: DatabaseAdapter;
  repository?: Pick<
    AdminLoggingControlRepository,
    'detectCatalogRepairFindings' | 'readCoverageLastCheckedAt'
  >;
  /** Null for a platform caller: every tenant is counted. */
  tenantId: string | null;
  /** Platform authority: table-wide statistics are shown only to it. */
  platform: boolean;
  /** Where `sensitive_detail_chunk_index` may live; counted per store, never summed. */
  sensitiveDetailIndexStores?: { store: string; adapter: DatabaseAdapter }[];
  tenantKey: string | null;
  now: number;
  windowMs?: number;
  readProbe: LogPlatformReadProbe;
  /** Test seam; defaults to the configured read-only Catalog. */
  loadTable?: (config: LogIcebergConfig) => Promise<IcebergLoadedTable>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const REPAIR_PENDING_TTL_MS = 15 * 60 * 1000;
const REPAIR_FINDINGS_LIMIT = 200;

/** Internal codes only (`snake_case` words); a driver or HTTP message is never put in a response. */
function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^[a-z][a-z0-9_]{2,79}$/.test(message) ? message : 'unknown_error';
}

/** Why one sensitive-detail index store could not be counted, as a fixed code. */
function indexStoreErrorCode(error: unknown): 'index_table_missing' | 'index_unavailable' {
  const message = error instanceof Error ? error.message : '';
  return /no such table/i.test(message) ? 'index_table_missing' : 'index_unavailable';
}

function integer(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value)) return Number(value);
  return 0;
}

function optionalInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = integer(value);
  return typeof value === 'number' || typeof value === 'string' ? parsed : null;
}

function snapshotIdText(value: unknown): string | null {
  return typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string'
    ? String(value)
    : null;
}

function summaryInteger(summary: Record<string, unknown> | undefined, key: string): number | null {
  const raw = summary?.[key];
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return raw;
  if (typeof raw === 'string' && /^(0|[1-9][0-9]*)$/.test(raw)) return Number(raw);
  return null;
}

/** Reads what the table metadata says about itself; nothing in R2 is opened. */
export function summarizeLogArchiveTable(
  table: IcebergLoadedTable
): NonNullable<LogPlatformArchiveStatus['table']> {
  const metadata = table.metadata as unknown as {
    'table-uuid'?: unknown;
    'current-snapshot-id'?: unknown;
    snapshots?: unknown;
  };
  const snapshots = Array.isArray(metadata.snapshots) ? metadata.snapshots : [];
  // Snapshot IDs are 64-bit; the Catalog JSON parser hands the large ones over as bigint.
  const currentId = snapshotIdText(metadata['current-snapshot-id']);
  let current: LogPlatformSnapshot | null = null;
  let lastCompactionAt: number | null = null;
  for (const raw of snapshots) {
    if (typeof raw !== 'object' || raw === null) continue;
    const snapshot = raw as Record<string, unknown>;
    const summary =
      typeof snapshot.summary === 'object' && snapshot.summary !== null
        ? (snapshot.summary as Record<string, unknown>)
        : undefined;
    const committedAt = integer(snapshot['timestamp-ms']);
    const operation = typeof summary?.operation === 'string' ? summary.operation : null;
    if (operation === 'replace' && (lastCompactionAt === null || committedAt > lastCompactionAt))
      lastCompactionAt = committedAt;
    if (currentId !== null && snapshotIdText(snapshot['snapshot-id']) === currentId) {
      current = {
        id: currentId,
        committed_at: committedAt,
        operation,
        total_data_files: summaryInteger(summary, 'total-data-files'),
        total_records: summaryInteger(summary, 'total-records'),
      };
    }
  }
  return {
    uuid: typeof metadata['table-uuid'] === 'string' ? metadata['table-uuid'] : '',
    snapshot_count: snapshots.length,
    current_snapshot: current,
    last_compaction_at: lastCompactionAt,
  };
}

async function describeArchive(
  input: BuildLogPlatformStatusInput
): Promise<{ archive: LogPlatformArchiveStatus; config: LogIcebergConfig | null }> {
  const base: LogPlatformArchiveStatus = {
    configured: false,
    configuration_error: null,
    mode: null,
    generation: null,
    activated_at: null,
    local_staging_only: false,
    export_interval_minutes: null,
    reachable: false,
    reachability_error: null,
    table: null,
    table_size_hint: null,
    read_probe: input.readProbe,
  };
  let config: LogIcebergConfig;
  try {
    config = resolveLogIcebergConfig(input.env);
  } catch (error) {
    return { archive: { ...base, configuration_error: errorCode(error) }, config: null };
  }
  const archive: LogPlatformArchiveStatus = {
    ...base,
    configured: true,
    mode: config.mode,
    generation: config.generation,
    activated_at: config.activatedAt,
    local_staging_only: config.localStagingOnly === true,
    export_interval_minutes: config.exportIntervalMinutes,
  };
  if (config.localStagingOnly) return { archive, config };
  try {
    const load =
      input.loadTable ??
      ((resolved: LogIcebergConfig) =>
        createLogIcebergCatalog(input.env, resolved, 'read').loadTable());
    const table = await load(config);
    const summary = summarizeLogArchiveTable(table);
    if (summary.uuid !== config.tableUuid) throw new Error('log_iceberg_table_identity_changed');
    archive.reachable = true;
    if (input.platform) {
      archive.table = summary;
      const files = summary.current_snapshot?.total_data_files;
      archive.table_size_hint = {
        max_files: LOG_ARCHIVE_READ_LIMITS.maxFiles,
        data_files_over_limit:
          typeof files === 'number' && files > LOG_ARCHIVE_READ_LIMITS.maxFiles,
      };
    }
  } catch (error) {
    archive.reachability_error = errorCode(error);
  }
  return { archive, config };
}

function tenantClause(column: string, tenantId: string | null): { sql: string; binds: string[] } {
  return tenantId === null
    ? { sql: '', binds: [] }
    : { sql: ` AND ${column} = ?`, binds: [tenantId] };
}

async function describeDelivery(
  input: BuildLogPlatformStatusInput,
  config: LogIcebergConfig | null,
  windowStart: number
): Promise<LogPlatformDeliveryStatus> {
  const { adapter, tenantId } = input;
  const scope = tenantClause('tenant_id', tenantId);
  const generation = config?.generation ?? null;
  const generationClause = generation === null ? '' : ' AND storage_generation = ?';
  const generationBinds = generation === null ? [] : [generation];

  const publicationRows = await adapter.query<{ state: string; total: unknown }>(
    `SELECT state, COUNT(*) AS total FROM log_iceberg_publications
     WHERE created_at >= ?${scope.sql}${generationClause} GROUP BY state`,
    [windowStart, ...scope.binds, ...generationBinds]
  );
  const recent = { prepared: 0, published: 0, aborted: 0, ingested: 0 };
  for (const row of publicationRows) {
    if (row.state === 'prepared' || row.state === 'published' || row.state === 'aborted')
      recent[row.state] = integer(row.total);
  }
  let lastIngestedAt: number | null = null;
  const prepared = await adapter.queryOne<{ oldest: unknown }>(
    `SELECT MIN(created_at) AS oldest FROM log_iceberg_publications
     WHERE state = 'prepared'${scope.sql}${generationClause}`,
    [...scope.binds, ...generationBinds]
  );
  const oldestPreparedAt = optionalInteger(prepared?.oldest);

  let outbox: LogPlatformDeliveryStatus['outbox'] = null;
  let exportState: LogPlatformDeliveryStatus['export'] = null;
  if (config?.mode === 'pipeline') {
    const counts = await adapter.queryOne<{
      pending: unknown;
      queued: unknown;
      oldest_pending_at: unknown;
    }>(
      `SELECT
         SUM(CASE WHEN state IN ('preparing','pending') THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN state = 'queued' THEN 1 ELSE 0 END) AS queued,
         MIN(CASE WHEN state IN ('preparing','pending','queued') THEN created_at END) AS oldest_pending_at
       FROM log_iceberg_outbox WHERE 1 = 1${scope.sql}${generationClause}`,
      [...scope.binds, ...generationBinds]
    );
    const lastError = await adapter.queryOne<{ last_error_code: string | null }>(
      `SELECT last_error_code FROM log_iceberg_outbox
       WHERE last_error_code IS NOT NULL AND state IN ('preparing','pending','queued')${scope.sql}${generationClause}
       ORDER BY updated_at DESC LIMIT 1`,
      [...scope.binds, ...generationBinds]
    );
    const ingested = await adapter.queryOne<{ total: unknown; last_at: unknown }>(
      `SELECT
         SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS total,
         MAX(stream_acknowledged_at) AS last_at
       FROM log_iceberg_outbox
       WHERE state = 'ingested' AND stream_acknowledged_at IS NOT NULL${scope.sql}${generationClause}`,
      [windowStart, ...scope.binds, ...generationBinds]
    );
    recent.ingested = integer(ingested?.total);
    lastIngestedAt = optionalInteger(ingested?.last_at);
    outbox = {
      pending: integer(counts?.pending),
      queued: integer(counts?.queued),
      oldest_pending_at: optionalInteger(counts?.oldest_pending_at),
      last_error_code: lastError?.last_error_code ?? null,
    };
  } else if (config?.mode === 'scheduled') {
    const batch = await adapter.queryOne<{
      state: string;
      last_error_code: string | null;
      updated_at: unknown;
    }>(
      `SELECT state, last_error_code, updated_at FROM log_iceberg_export_batches
       WHERE 1 = 1${scope.sql}${generationClause} ORDER BY updated_at DESC LIMIT 1`,
      [...scope.binds, ...generationBinds]
    );
    const failing = await adapter.queryOne<{
      id: string;
      last_error_code: string;
      updated_at: unknown;
    }>(
      `SELECT id, last_error_code, updated_at FROM log_iceberg_export_batches
       WHERE last_error_code IS NOT NULL AND state != 'done'${scope.sql}${generationClause}
       ORDER BY updated_at DESC LIMIT 1`,
      [...scope.binds, ...generationBinds]
    );
    const unfinished = await adapter.queryOne<{ oldest: unknown }>(
      `SELECT MIN(created_at) AS oldest FROM log_iceberg_export_batches
       WHERE state != 'done'${scope.sql}${generationClause}`,
      [...scope.binds, ...generationBinds]
    );
    // The exporter's own eligibility: visible, published, past the D1 retention period.
    const retentionMs = (config.dbRetentionDays ?? 0) * 86_400_000;
    const eligible = await adapter.queryOne<{ oldest: unknown }>(
      `SELECT MIN(ingested_at) AS oldest FROM log_iceberg_records
       WHERE batch_id IS NULL AND ${logIcebergPublicationVisibleSql()}
         AND ingested_at <= ? - ?${scope.sql}${generationClause}`,
      [input.now, retentionMs, ...scope.binds, ...generationBinds]
    );
    const oldestEligible = optionalInteger(eligible?.oldest);
    const watermark =
      config.localStagingOnly || !config.tableUuid
        ? null
        : await adapter.queryOne<{
            snapshot_id: string;
            minimum_sequence_number: unknown;
            updated_at: unknown;
          }>(
            `SELECT snapshot_id, minimum_sequence_number, updated_at
             FROM log_iceberg_read_watermarks WHERE table_uuid = ? ORDER BY updated_at DESC LIMIT 1`,
            [config.tableUuid]
          );
    exportState = {
      last_state: batch?.state ?? null,
      last_error_code: batch?.last_error_code ?? null,
      updated_at: optionalInteger(batch?.updated_at),
      active_failure: failing
        ? {
            batch_id: failing.id,
            error_code: failing.last_error_code,
            updated_at: integer(failing.updated_at),
          }
        : null,
      oldest_unfinished_at: optionalInteger(unfinished?.oldest),
      oldest_eligible_since: oldestEligible === null ? null : oldestEligible + retentionMs,
      watermark: watermark
        ? {
            snapshot_id: watermark.snapshot_id,
            minimum_sequence_number: integer(watermark.minimum_sequence_number),
            updated_at: integer(watermark.updated_at),
          }
        : null,
    };
  }
  return {
    recent,
    last_ingested_at: lastIngestedAt,
    oldest_prepared_at: oldestPreparedAt,
    outbox,
    export: exportState,
  };
}

export async function buildLogPlatformStatus(
  input: BuildLogPlatformStatusInput
): Promise<LogPlatformStatus> {
  const windowStart = input.now - (input.windowMs ?? DAY_MS);
  const repository = input.repository ?? new AdminLoggingControlRepository(input.adapter);
  const { archive, config } = await describeArchive(input);
  const delivery = await describeDelivery(input, config, windowStart);

  const lastCheckedAt = await repository.readCoverageLastCheckedAt();
  const auditCoverage = summarizeAdminAuditCoverage(
    LOGGING_ADMIN_AUDIT_COVERAGE_REGISTRY,
    lastCheckedAt
  );

  const indexScope = tenantClause('tenant_id', input.tenantId);
  const indexStores = input.sensitiveDetailIndexStores ?? [
    { store: 'DB_ADMIN', adapter: input.adapter },
  ];
  const sensitiveDetailIndex: LogPlatformStatus['chunk_catalog']['sensitive_detail_index'] = [];
  for (const { store, adapter } of indexStores) {
    try {
      const indexed = await adapter.queryOne<{ total: unknown }>(
        `SELECT COUNT(*) AS total FROM sensitive_detail_chunk_index
         WHERE deleted_at IS NULL${indexScope.sql}`,
        indexScope.binds
      );
      sensitiveDetailIndex.push({ store, indexed_objects: integer(indexed?.total), error: null });
    } catch (error) {
      // A store that never held the table (or is down) must not take the whole view with it.
      sensitiveDetailIndex.push({
        store,
        indexed_objects: null,
        error: indexStoreErrorCode(error),
      });
    }
  }
  const findings = await repository.detectCatalogRepairFindings({
    now: input.now,
    limit: REPAIR_FINDINGS_LIMIT,
    pendingTtlMs: REPAIR_PENDING_TTL_MS,
    tenantKey: input.tenantKey ?? undefined,
  });
  const sensitiveDetailFindings = findings.filter(
    (finding) => finding.plane === 'sensitive_detail'
  ).length;

  const laneScope = tenantClause('tenant_key', input.tenantKey);
  const lanes = await input.adapter.query<{ lane: string; status: string; total: unknown }>(
    `SELECT lane, status, SUM(batch_count) AS total
     FROM logging_delivery_event_aggregates
     WHERE bucket_start_at >= ?${laneScope.sql}
     GROUP BY lane, status`,
    [windowStart, ...laneScope.binds]
  );

  return {
    generated_at: input.now,
    window_start_at: windowStart,
    archive,
    delivery,
    audit_coverage: auditCoverage,
    chunk_catalog: {
      scan_limit: REPAIR_FINDINGS_LIMIT,
      sampled_repair_findings: findings.length,
      sampled_sensitive_detail_findings: sensitiveDetailFindings,
      sensitive_detail_index: sensitiveDetailIndex,
    },
    delivery_lanes: lanes.map((row) => ({
      lane: row.lane,
      status: row.status,
      total: integer(row.total),
    })),
  };
}
