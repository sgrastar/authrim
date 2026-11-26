/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- untyped fake adapter rows and table metadata */
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
      read_budget: { max_files: 128, over_budget: false },
    });
    expect(status.delivery).toEqual({
      publications: { prepared: 0, published: 0, aborted: 0 },
      outbox: null,
      export: null,
    });
    expect(status.audit_coverage.last_checked_at).toBeNull();
    expect(status.audit_coverage.covered).toBeGreaterThan(0);
  });

  it('flags a pipeline archive whose current snapshot exceeds the read budget', async () => {
    const adapter = fakeAdapter({
      'FROM log_iceberg_publications': [
        { state: 'published', total: '40' },
        { state: 'prepared', total: 2 },
      ],
      "SUM(CASE WHEN state = 'pending'": {
        pending: '3',
        queued: 1,
        oldest_pending_at: NOW - 60000,
      },
      'WHERE last_error_code IS NOT NULL': { last_error_code: 'stream_timeout' },
      'FROM sensitive_detail_chunk_index': { total: 5 },
      'FROM logging_delivery_event_aggregates': [
        { lane: 'critical', status: 'delivered', total: 9 },
      ],
    });
    const repository = {
      detectCatalogRepairFindings: vi.fn(async () => [
        { safety: 'safe_auto' },
        { safety: 'manual_review' },
      ]),
      readCoverageLastCheckedAt: vi.fn(async () => NOW - 1000),
    } as any;
    const status = await buildLogPlatformStatus(
      input({
        adapter,
        repository,
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
      read_budget: { max_files: 128, over_budget: true },
      read_probe: okProbe,
    });
    expect(status.archive.table?.current_snapshot?.total_data_files).toBe(603);
    expect(status.archive.table?.last_compaction_at).toBeNull();
    expect(status.delivery).toEqual({
      publications: { prepared: 2, published: 40, aborted: 0 },
      outbox: {
        pending: 3,
        queued: 1,
        oldest_pending_at: NOW - 60000,
        last_error_code: 'stream_timeout',
      },
      export: null,
    });
    expect(status.audit_coverage.last_checked_at).toBe(NOW - 1000);
    expect(status.sensitive_detail_catalog).toEqual({
      indexed_objects: 5,
      pending_repair_findings: 2,
      manual_review_findings: 1,
    });
    expect(status.delivery_lanes).toEqual([{ lane: 'critical', status: 'delivered', total: 9 }]);
    // Tenant scoping: the tenant id goes to the Iceberg tables, the tenant key to the lanes.
    const sql = (adapter.query as any).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(sql.find((s: string) => s.includes('log_iceberg_publications'))).toContain(
      'tenant_id = ?'
    );
    expect(sql.find((s: string) => s.includes('logging_delivery_event_aggregates'))).toContain(
      'tenant_key = ?'
    );
    expect(repository.detectCatalogRepairFindings).toHaveBeenCalledWith(
      expect.objectContaining({ tenantKey: 'tk-a', now: NOW })
    );
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
    const other = await buildLogPlatformStatus(
      input({ loadTable: async () => table([], null, 'another-table-uuid') })
    );
    expect(other.archive.reachable).toBe(false);
    expect(other.archive.reachability_error).toBe('log_iceberg_table_identity_changed');
  });

  it('reads the export batch and watermark in scheduled mode, platform-wide for a platform caller', async () => {
    const adapter = fakeAdapter({
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
        tenantKey: null,
        loadTable: async () =>
          table([{ id: 42, at: NOW - 400, operation: 'replace', files: 3, records: 10 }], 42),
      })
    );
    expect(status.delivery.outbox).toBeNull();
    expect(status.delivery.export).toEqual({
      last_state: 'verified',
      last_error_code: null,
      updated_at: NOW - 500,
      watermark: { snapshot_id: '42', minimum_sequence_number: 17, updated_at: NOW - 400 },
    });
    expect(status.archive.table?.last_compaction_at).toBe(NOW - 400);
    const sql = (adapter.query as any).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(sql.find((s: string) => s.includes('log_iceberg_publications'))).not.toContain(
      'tenant_id = ?'
    );
  });
});
