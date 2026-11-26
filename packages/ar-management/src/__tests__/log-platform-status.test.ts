/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unnecessary-type-assertion -- untyped fake adapter rows and table metadata */
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import type { IcebergLoadedTable } from '@authrim/ar-lib-logging/iceberg';
import {
  buildLogPlatformStatus,
  summarizeLogArchiveTable,
  type BuildLogPlatformStatusInput,
} from '../log-platform-status';

const NOW = Date.UTC(2026, 10, 26, 6, 0, 0);
const TABLE_UUID = '4eb1cd44-3610-4b17-81eb-035776e79fa2';

const pipelineEnv = {
  AUTHRIM_LOG_ARCHIVE_MODE: 'pipeline',
  AUTHRIM_LOG_ARCHIVE_STORAGE_GENERATION: 'gen-2026-11-01',
  AUTHRIM_LOG_ARCHIVE_SCHEMA_VERSION: '1',
  AUTHRIM_LOG_ARCHIVE_ACTIVATED_AT: '2026-11-01T00:00:00.000Z',
  AUTHRIM_LOG_ARCHIVE_ACCOUNT_ID: '98edc9b77724418e61ae577980a7369b',
  AUTHRIM_LOG_ARCHIVE_BUCKET: 'demo-log-archive',
  AUTHRIM_LOG_ARCHIVE_CATALOG_URI:
    'https://catalog.cloudflarestorage.com/98edc9b77724418e61ae577980a7369b/demo-log-archive',
  AUTHRIM_LOG_ARCHIVE_WAREHOUSE: '98edc9b77724418e61ae577980a7369b_demo-log-archive',
  AUTHRIM_LOG_ARCHIVE_NAMESPACE: 'authrim',
  AUTHRIM_LOG_ARCHIVE_TABLE: 'logs_v1',
  AUTHRIM_LOG_ARCHIVE_TABLE_UUID: TABLE_UUID,
  AUTHRIM_LOG_ARCHIVE_PHYSICAL_FINGERPRINT: 'f'.repeat(64),
  LOG_ARCHIVE_CATALOG_READ_TOKEN: 'read-token',
} as any;

const scheduledEnv = {
  ...pipelineEnv,
  AUTHRIM_LOG_ARCHIVE_MODE: 'scheduled',
  AUTHRIM_LOG_ARCHIVE_DB_RETENTION_DAYS: '7',
  AUTHRIM_LOG_ARCHIVE_EXPORT_INTERVAL_MINUTES: '15',
} as any;

function table(
  snapshots: { id: number; at: number; operation: string; files?: number; records?: number }[],
  currentId: number | null,
  uuid = TABLE_UUID
): IcebergLoadedTable {
  return {
    metadataLocation: 's3://demo-log-archive/metadata/v9.metadata.json',
    metadata: {
      'table-uuid': uuid,
      'current-snapshot-id': currentId,
      snapshots: snapshots.map((s) => ({
        'snapshot-id': s.id,
        'timestamp-ms': s.at,
        summary: {
          operation: s.operation,
          ...(s.files === undefined ? {} : { 'total-data-files': String(s.files) }),
          ...(s.records === undefined ? {} : { 'total-records': String(s.records) }),
        },
      })),
    } as any,
  };
}

/** Answers each SQL by the table it reads; unknown statements return nothing. */
function fakeAdapter(rows: Record<string, unknown>): DatabaseAdapter {
  const pick = (sql: string) => {
    for (const [needle, value] of Object.entries(rows)) if (sql.includes(needle)) return value;
    return undefined;
  };
  return {
    query: vi.fn(async (sql: string) => (pick(sql) as unknown[]) ?? []),
    queryOne: vi.fn(async (sql: string) => pick(sql) ?? null),
  } as unknown as DatabaseAdapter;
}

const okProbe = {
  ok: true,
  reason: null,
  has_archive: true,
  coverage: { consistency: 'eventual' as const, pending_deliveries: 0, complete: false },
};

function input(overrides: Partial<BuildLogPlatformStatusInput>): BuildLogPlatformStatusInput {
  return {
    env: pipelineEnv,
    adapter: fakeAdapter({}),
    repository: {
      detectCatalogRepairFindings: vi.fn(async () => []),
      readCoverageLastCheckedAt: vi.fn(async () => null),
    },
    tenantId: 'tenant-a',
    platform: false,
    tenantKey: 'tk-a',
    now: NOW,
    readProbe: okProbe,
    loadTable: async () => table([], null),
    ...overrides,
  };
}

describe('summarizeLogArchiveTable', () => {
  it('reads the current snapshot and the newest compaction from the metadata alone', () => {
    const summary = summarizeLogArchiveTable(
      table(
        [
          { id: 1, at: NOW - 5000, operation: 'append', files: 600, records: 1700 },
          { id: 2, at: NOW - 4000, operation: 'replace', files: 11, records: 1700 },
          { id: 3, at: NOW - 3000, operation: 'append', files: 12, records: 1732 },
          { id: 4, at: NOW - 6000, operation: 'replace', files: 9 },
        ],
        3
      )
    );
    expect(summary).toEqual({
      uuid: TABLE_UUID,
      snapshot_count: 4,
      current_snapshot: {
        id: '3',
        committed_at: NOW - 3000,
        operation: 'append',
        total_data_files: 12,
        total_records: 1732,
      },
      last_compaction_at: NOW - 4000,
    });
  });

  it('keeps 64-bit snapshot IDs that arrive as bigint', () => {
    const big = 9_007_199_254_740_993n;
    const summary = summarizeLogArchiveTable({
      metadataLocation: 'x',
      metadata: {
        'table-uuid': TABLE_UUID,
        'current-snapshot-id': big,
        snapshots: [
          {
            'snapshot-id': big,
            'timestamp-ms': BigInt(NOW),
            summary: { operation: 'append', 'total-data-files': '200' },
          },
        ],
      } as any,
    });
    expect(summary.current_snapshot).toEqual({
      id: '9007199254740993',
      committed_at: NOW,
      operation: 'append',
      total_data_files: 200,
      total_records: null,
    });
  });

  it('tolerates a table without snapshots or summaries', () => {
    expect(summarizeLogArchiveTable(table([], null))).toEqual({
      uuid: TABLE_UUID,
      snapshot_count: 0,
      current_snapshot: null,
      last_compaction_at: null,
    });
    const bare = table([{ id: 7, at: NOW, operation: 'append' }], 7);
    delete (bare.metadata as any).snapshots[0].summary;
    expect(summarizeLogArchiveTable(bare).current_snapshot).toEqual({
      id: '7',
      committed_at: NOW,
      operation: null,
      total_data_files: null,
      total_records: null,
    });
  });
});

describe('buildLogPlatformStatus', () => {
  it('reports an unconfigured archive without touching the catalog', async () => {
    const loadTable = vi.fn();
    const status = await buildLogPlatformStatus(input({ env: {} as any, loadTable }));
    expect(loadTable).not.toHaveBeenCalled();
    expect(status.archive).toMatchObject({
      configured: false,
      configuration_error: 'log_iceberg_configuration_required',
      reachable: false,
      table: null,
      table_size_hint: null,
    });
    expect(status.delivery).toEqual({
      recent: { prepared: 0, published: 0, aborted: 0, ingested: 0 },
      last_ingested_at: null,
      oldest_prepared_at: null,
      outbox: null,
      export: null,
    });
    expect(status.audit_coverage.last_checked_at).toBeNull();
    expect(status.audit_coverage.covered).toBeGreaterThan(0);
  });

  it('flags, for a platform caller, a pipeline archive whose table outgrew the read limit', async () => {
    const adapter = fakeAdapter({
      "WHERE state = 'prepared'": { oldest: NOW - 5000 },
      'FROM log_iceberg_publications': [
        { state: 'published', total: '40' },
        { state: 'prepared', total: 2 },
      ],
      "SUM(CASE WHEN state IN ('preparing','pending')": {
        pending: '3',
        queued: 1,
        oldest_pending_at: NOW - 60000,
        orphaned: '1',
        oldest_orphaned_at: NOW - 7_200_000,
        abandoned: '2',
      },
      'WHERE last_error_code IS NOT NULL': { last_error_code: 'stream_timeout' },
      "WHERE state = 'ingested' AND stream_acknowledged_at IS NOT NULL": {
        total: '38',
        last_at: NOW - 240000,
      },
      'FROM sensitive_detail_chunk_index': { total: 5 },
      'FROM logging_delivery_event_aggregates': [
        { lane: 'critical', status: 'delivered', total: 9 },
      ],
    });
    const repository = {
      detectCatalogRepairFindings: vi.fn(async () => [
        { safety: 'safe_auto', plane: 'sensitive_detail' },
        { safety: 'safe_auto', plane: 'archive' },
      ]),
      readCoverageLastCheckedAt: vi.fn(async () => NOW - 1000),
    } as any;
    const status = await buildLogPlatformStatus(
      input({
        adapter,
        repository,
        platform: true,
        loadTable: async () =>
          table([{ id: 1, at: NOW - 1000, operation: 'append', files: 603, records: 1700 }], 1),
      })
    );
    expect(status.archive).toMatchObject({
      configured: true,
      mode: 'pipeline',
      generation: 'gen-2026-11-01',
      reachable: true,
      reachability_error: null,
      table_size_hint: { max_files: 128, data_files_over_limit: true },
      export_interval_minutes: null,
      read_probe: okProbe,
    });
    expect(status.archive.table?.current_snapshot?.total_data_files).toBe(603);
    expect(status.archive.table?.last_compaction_at).toBeNull();
    expect(status.delivery).toEqual({
      recent: { prepared: 2, published: 40, aborted: 0, ingested: 38 },
      last_ingested_at: NOW - 240000,
      oldest_prepared_at: NOW - 5000,
      outbox: {
        pending: 3,
        queued: 1,
        oldest_pending_at: NOW - 60000,
        orphaned: 1,
        oldest_orphaned_at: NOW - 7_200_000,
        abandoned: 2,
        last_error_code: 'stream_timeout',
      },
      export: null,
    });
    expect(status.audit_coverage.last_checked_at).toBe(NOW - 1000);
    expect(status.chunk_catalog).toEqual({
      scan_limit: 200,
      sampled_repair_findings: 2,
      sampled_sensitive_detail_findings: 1,
      sensitive_detail_index: [{ store: 'DB_ADMIN', indexed_objects: 5, error: null }],
    });
    expect(status.delivery_lanes).toEqual([{ lane: 'critical', status: 'delivered', total: 9 }]);
    // Tenant scoping: the tenant id goes to the Iceberg tables, the tenant key to the lanes.
    const sql = (adapter.query as any).mock.calls.map((c: unknown[]) => c[0] as string);
    const publicationSql = sql.find((s: string) => s.includes('log_iceberg_publications'));
    expect(publicationSql).toContain('tenant_id = ?');
    // The counts are the window's, not the generation's lifetime.
    expect(publicationSql).toContain('created_at >= ?');
    expect(sql.find((s: string) => s.includes('logging_delivery_event_aggregates'))).toContain(
      'tenant_key = ?'
    );
    expect(repository.detectCatalogRepairFindings).toHaveBeenCalledWith(
      expect.objectContaining({ tenantKey: 'tk-a', now: NOW })
    );
  });

  it('keeps the shared table statistics away from a tenant caller', async () => {
    const status = await buildLogPlatformStatus(
      input({
        platform: false,
        loadTable: async () =>
          table([{ id: 1, at: NOW - 1000, operation: 'append', files: 603, records: 1700 }], 1),
      })
    );
    expect(status.archive.reachable).toBe(true);
    expect(status.archive.table).toBeNull();
    expect(status.archive.table_size_hint).toBeNull();
    expect(status.archive.read_probe).toEqual(okProbe);
  });

  it('keeps answering when the catalog is unreachable or belongs to another table', async () => {
    const down = await buildLogPlatformStatus(
      input({
        loadTable: async () => {
          throw new Error('iceberg_catalog_http_503');
        },
      })
    );
    expect(down.archive).toMatchObject({
      configured: true,
      reachable: false,
      reachability_error: 'iceberg_catalog_http_503',
      table: null,
    });
    // A message that is not one of our codes (an HTTP body, a driver text) never gets through.
    const noisy = await buildLogPlatformStatus(
      input({
        loadTable: async () => {
          throw new Error('503 Service Unavailable: <html>upstream connect error</html>');
        },
      })
    );
    expect(noisy.archive.reachability_error).toBe('unknown_error');
    const other = await buildLogPlatformStatus(
      input({ loadTable: async () => table([], null, 'another-table-uuid') })
    );
    expect(other.archive.reachable).toBe(false);
    expect(other.archive.reachability_error).toBe('log_iceberg_table_identity_changed');
  });

  it('reads the export batch and watermark in scheduled mode, platform-wide for a platform caller', async () => {
    const adapter = fakeAdapter({
      "last_error_code IS NOT NULL AND state != 'done'": {
        id: 'batch-7',
        last_error_code: 'catalog_commit_conflict',
        updated_at: NOW - 900,
      },
      'SELECT MIN(created_at) AS oldest FROM log_iceberg_export_batches': { oldest: NOW - 3000 },
      'SELECT MIN(ingested_at) AS oldest FROM log_iceberg_records': {
        oldest: NOW - 7 * 86_400_000 - 7000,
      },
      'FROM log_iceberg_export_batches': {
        state: 'verified',
        last_error_code: null,
        updated_at: NOW - 500,
      },
      'FROM log_iceberg_read_watermarks': {
        snapshot_id: '42',
        minimum_sequence_number: '17',
        updated_at: NOW - 400,
      },
    });
    const status = await buildLogPlatformStatus(
      input({
        env: scheduledEnv,
        adapter,
        tenantId: null,
        platform: true,
        tenantKey: null,
        sensitiveDetailIndexStores: [
          {
            store: 'LOGGING_INDEX_DB',
            adapter: fakeAdapter({ 'FROM sensitive_detail_chunk_index': { total: '7' } }),
          },
          {
            store: 'DB',
            adapter: {
              query: vi.fn(async () => []),
              queryOne: vi.fn(async () => {
                throw new Error('no such table: sensitive_detail_chunk_index');
              }),
            } as unknown as DatabaseAdapter,
          },
        ],
        loadTable: async () =>
          table([{ id: 42, at: NOW - 400, operation: 'replace', files: 3, records: 10 }], 42),
      })
    );
    expect(status.delivery.outbox).toBeNull();
    expect(status.chunk_catalog.sensitive_detail_index).toEqual([
      { store: 'LOGGING_INDEX_DB', indexed_objects: 7, error: null },
      { store: 'DB', indexed_objects: null, error: 'index_table_missing' },
    ]);
    expect(status.delivery.export).toEqual({
      last_state: 'verified',
      last_error_code: null,
      updated_at: NOW - 500,
      active_failure: {
        batch_id: 'batch-7',
        error_code: 'catalog_commit_conflict',
        updated_at: NOW - 900,
      },
      oldest_unfinished_at: NOW - 3000,
      oldest_eligible_since: NOW - 7000,
      watermark: { snapshot_id: '42', minimum_sequence_number: 17, updated_at: NOW - 400 },
    });
    expect(status.archive.table?.last_compaction_at).toBe(NOW - 400);
    const sql = (adapter.query as any).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(sql.find((s: string) => s.includes('log_iceberg_publications'))).not.toContain(
      'tenant_id = ?'
    );
  });
});
