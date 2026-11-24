/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- SQL parameter arrays and vi fakes are untyped in these maintenance job tests */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const mockAdapter = vi.hoisted(() => {
  const adapter = {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
  };
  adapter.transaction.mockImplementation(async (callback) => callback(adapter));
  return adapter;
});
const store = vi.hoisted(() => ({
  listExpiredQueuedJobs: vi.fn(),
  listStuckClaimJobs: vi.fn(),
  claimDueJob: vi.fn(),
  markRunning: vi.fn(),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
  markRetrying: vi.fn(),
  markBlocked: vi.fn(),
  markCancelled: vi.fn(),
  recordRepairFinding: vi.fn(),
}));
const payloadRead = vi.hoisted(() => vi.fn());
const parsePayload = vi.hoisted(() => vi.fn());
const sensitiveLoader = vi.hoisted(() => vi.fn());

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mockAdapter),
    loadChunkedSensitiveDetailJson: sensitiveLoader,
  };
});
vi.mock('@authrim/ar-lib-logging/messaging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-logging/messaging')>();
  return {
    ...actual,
    SqlLoggingMessageJobStore: class {
      constructor() {
        return store;
      }
    },
    parseLoggingMessageQueuePayload: parsePayload,
  };
});
vi.mock('../logging-message-payload-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logging-message-payload-storage')>();
  return { ...actual, readEncryptedLoggingMessagePayload: payloadRead };
});

import { processLoggingStorageMaintenanceJobs } from '../logging-storage-maintenance-jobs';
import { must } from './helpers/must';

const NOW = 1_800_000_000_000;
const CUTOFF = NOW - 1000;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

describe('export_build artifacts', () => {
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  let put: ReturnType<typeof vi.fn>;
  let env: Env;
  let catalogRows: Record<string, unknown>[];
  let sensitiveRows: Record<string, unknown>[];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    put = vi.fn().mockResolvedValue(undefined);
    env = {
      AUDIT_ARCHIVE: { delete: vi.fn() },
      EXPORT_ARTIFACTS: { put },
    } as unknown as Env;
    catalogRows = [];
    sensitiveRows = [];
    for (const fn of Object.values(store)) fn.mockReset();
    store.listExpiredQueuedJobs.mockResolvedValue([]);
    store.listStuckClaimJobs.mockResolvedValue([]);
    store.markCompleted.mockResolvedValue(true);
    payloadRead.mockReset();
    parsePayload.mockReset();
    sensitiveLoader.mockReset();
    mockAdapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM sensitive_detail_chunk_index sdci')) return sensitiveRows;
      if (
        sql.includes('FROM log_object_catalog') &&
        sql.includes('ORDER BY created_at ASC, id ASC')
      )
        return catalogRows;
      return [];
    });
    mockAdapter.queryOne.mockResolvedValue(null);
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 1 });
  });
  afterEach(() => vi.restoreAllMocks());

  async function runExport(
    options: {
      format?: 'jsonl' | 'csv';
      filters?: Record<string, unknown>;
      expiresAt?: number | null;
    } = {}
  ) {
    const filters = {
      tenant_key: null,
      log_type: null,
      plane: null,
      source: 'catalog',
      time_start: null,
      time_end: null,
      limit: 100,
      include_payload: false,
      ...options.filters,
    };
    store.claimDueJob
      .mockResolvedValueOnce({
        id: 'job_1',
        kind: 'export_build',
        status: 'running',
        lane: 'default',
        criticality: 'standard',
        tenantKey: 't_a',
        sourceType: 'payload_object',
        sourceId: 'exp_1',
        payloadObjectRef: 'message-jobs/job_1.json',
        attemptCount: 1,
        maxAttempts: 5,
        attemptPolicy: null,
        errorClass: null,
        cancelRequestedAt: null,
      })
      .mockResolvedValue(null);
    payloadRead.mockResolvedValue({ ok: true, value: { filters } });
    parsePayload.mockReturnValue({
      ok: true,
      payload: {
        message_job_id: 'job_1',
        payload_type: 'export_build',
        export_job_id: 'exp_1',
        phase: 'plan',
        snapshot_cutoff_at: CUTOFF,
      },
    });
    mockAdapter.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('FROM logging_export_jobs')
        ? {
            id: 'exp_1',
            format: options.format ?? 'jsonl',
            status: 'queued',
            expires_at: options.expiresAt === undefined ? NOW + 1000 : options.expiresAt,
          }
        : null
    );
    const result = await processLoggingStorageMaintenanceJobs(env, log);
    return { result, filters };
  }

  const part = () => put.mock.calls.find(([key]) => String(key).includes('/parts/'));
  const manifest = () => {
    const call = put.mock.calls.find(([key]) => String(key).endsWith('/manifest.json'));
    return call ? JSON.parse(call[1] as string) : null;
  };
  const catalogQuery = () =>
    must(
      mockAdapter.query.mock.calls.find(
        ([sql]) =>
          String(sql).includes('FROM log_object_catalog') &&
          String(sql).includes('ORDER BY created_at ASC, id ASC')
      )
    );

  describe('csv', () => {
    it('writes a csv part with preferred headers first and extra headers sorted', async () => {
      catalogRows = [
        { zeta: 'z1', id: 'obj_1', tenant_key: 't', alpha: 'a1', log_type: 'audit' },
        { id: 'obj_2', beta: 'b2', tenant_key: 't' },
      ];
      const { result } = await runExport({ format: 'csv' });
      expect(result.messageJobs).toMatchObject({ claimed: 1, completed: 1 });
      const call = must(part());
      const expected = [
        'id,tenant_key,log_type,alpha,beta,zeta',
        'obj_1,t,audit,a1,,z1',
        'obj_2,t,,,b2,',
      ].join('\n');
      expect(call[0]).toBe('logging-exports/v1/exp_1/parts/part-00000.csv');
      expect(call[1]).toBe(expected);
      expect(call[2]).toEqual({ httpMetadata: { contentType: 'text/csv' } });
      const m = manifest();
      expect(m.format).toBe('csv');
      expect(m.parts).toEqual([
        {
          partition_index: 0,
          object_ref: 'logging-exports/v1/exp_1/parts/part-00000.csv',
          checksum_sha256: await sha256Hex(expected),
          record_count: 2,
          byte_count: new TextEncoder().encode(expected).byteLength,
        },
      ]);
      expect(m.record_count).toBe(2);
      expect(m.checksum_sha256).toBe(await sha256Hex(expected));
      expect(m.snapshot_cutoff_at).toBe(CUTOFF);
      expect(m.expires_at).toBe(NOW + 1000);
      expect(m.message_job_id).toBe('job_1');
      expect(m.export_id).toBe('exp_1');
    });

    it('quotes delimiters and neutralizes spreadsheet formulas', async () => {
      catalogRows = [
        {
          at: '@x',
          cr: '\rx',
          eq: '=SUM(A1)',
          minus: '-x',
          minusnum: '-5',
          multi: 'l1\nl2',
          note: 'a,b',
          nul: null,
          obj: { a: 1 },
          plus: '+1',
          quote: 'say "hi"',
          spaced: '  =1',
          tab: '\tfoo',
          zero: 0,
        },
      ];
      await runExport({ format: 'csv' });
      const [header, ...cells] = (must(part())[1] as string).split('\n');
      expect(header).toBe('at,cr,eq,minus,minusnum,multi,note,nul,obj,plus,quote,spaced,tab,zero');
      expect(must(part())[1]).toContain(
        [
          `'@x`,
          `"'\rx"`,
          `'=SUM(A1)`,
          `'-x`,
          '-5',
          '"l1\nl2"',
          '"a,b"',
          '',
          '"{""a"":1}"',
          `'+1`,
          '"say ""hi"""',
          `'  =1`,
          `'\tfoo`,
          '0',
        ].join(',')
      );
      expect(cells.length).toBeGreaterThan(0);
    });

    it('writes an empty csv for no rows', async () => {
      await runExport({ format: 'csv' });
      expect(must(part())[1]).toBe('');
      expect(manifest().record_count).toBe(0);
      expect(manifest().byte_count).toBe(0);
    });
  });

  describe('jsonl', () => {
    it('writes one json object per line with a trailing newline', async () => {
      catalogRows = [
        { id: 'a', n: 1 },
        { id: 'b', n: null },
      ];
      await runExport();
      const call = must(part());
      expect(call[0]).toBe('logging-exports/v1/exp_1/parts/part-00000.jsonl');
      expect(call[1]).toBe('{"id":"a","n":1}\n{"id":"b","n":null}\n');
      expect(call[2]).toEqual({ httpMetadata: { contentType: 'application/x-ndjson' } });
    });

    it('writes nothing but still completes when there are no rows', async () => {
      const { result } = await runExport();
      expect(must(part())[1]).toBe('');
      expect(result.messageJobs.completed).toBe(1);
    });
  });

  describe('catalog query', () => {
    it('only applies the filters that were given', async () => {
      await runExport();
      const [sql, params] = catalogQuery();
      expect(String(sql)).toMatch(/WHERE status = \? AND created_at <= \?\s+ORDER BY/);
      expect(params).toEqual(['committed', CUTOFF, 100, 0]);
    });

    it('applies tenant, type, plane and time window', async () => {
      await runExport({
        filters: {
          tenant_key: 't_a',
          log_type: 'audit',
          plane: 'archive',
          time_start: 10,
          time_end: 20,
          limit: 7,
        },
      });
      const [sql, params] = catalogQuery();
      expect(String(sql)).toContain(
        'status = ? AND created_at <= ? AND tenant_key = ? AND log_type = ? AND plane = ? AND created_at >= ? AND created_at <= ?'
      );
      expect(params).toEqual(['committed', CUTOFF, 't_a', 'audit', 'archive', 10, 20, 7, 0]);
    });

    it('uses event time for the record index and joins the catalog', async () => {
      await runExport({
        filters: {
          source: 'record_index',
          tenant_key: 't_a',
          time_start: 10,
          time_end: 20,
          limit: 3,
        },
      });
      const call = must(
        mockAdapter.query.mock.calls.find(([sql]) =>
          String(sql).includes('FROM log_chunk_record_index idx')
        )
      );
      expect(String(call[0])).toContain(
        'idx.status = ? AND idx.event_at <= ? AND idx.tenant_key = ? AND idx.event_at >= ? AND idx.event_at <= ?'
      );
      expect(call[1]).toEqual(['committed', CUTOFF, 't_a', 10, 20, 3, 0]);
    });

    it('rejects filters with an unknown log type or plane as invalid configuration', async () => {
      await runExport({ filters: { log_type: 'bogus' } });
      expect(store.markBlocked).toHaveBeenCalledWith(
        expect.objectContaining({ blockedReason: 'invalid_export_build_filters' })
      );
      store.markBlocked.mockClear();
      await runExport({ filters: { plane: 'bogus' } });
      expect(store.markBlocked).toHaveBeenCalledWith(
        expect.objectContaining({ blockedReason: 'invalid_export_build_filters' })
      );
    });

    it('defaults a non-positive limit to 1000 and truncates a fractional one', async () => {
      await runExport({ filters: { limit: 0 } });
      expect(catalogQuery()[1]).toEqual(['committed', CUTOFF, 1000, 0]);
      mockAdapter.query.mockClear();
      await runExport({ filters: { limit: 12.9 } });
      expect(catalogQuery()[1]).toEqual(['committed', CUTOFF, 12, 0]);
      mockAdapter.query.mockClear();
      await runExport({ filters: { limit: 'many' } });
      expect(catalogQuery()[1]).toEqual(['committed', CUTOFF, 1000, 0]);
    });
  });

  describe('sensitive detail plane', () => {
    const sensitiveRow = (over: Record<string, unknown> = {}) => ({
      record_id: 'rec_1',
      tenant_id: 'tenant-1',
      tenant_key: 't_a',
      object_catalog_id: 'cat_1',
      object_class: 'webhook_delivery_payload',
      object_key: 'k',
      object_kind: 'chunk',
      created_at: 5,
      ...over,
    });
    const sensitiveQuery = () =>
      mockAdapter.query.mock.calls.find(([sql]) =>
        String(sql).includes('FROM sensitive_detail_chunk_index sdci')
      );

    it('queries every detail class when no log type is given and maps classes to log types', async () => {
      sensitiveRows = [
        sensitiveRow({ object_class: 'admin_audit_detail' }),
        sensitiveRow({ record_id: 'r2', object_class: 'approval_transport_detail' }),
        sensitiveRow({ record_id: 'r3', object_class: 'webhook_delivery_payload' }),
        sensitiveRow({ record_id: 'r4', object_class: 'operational_log_detail' }),
      ];
      await runExport({ filters: { plane: 'sensitive_detail' } });
      const call = must(sensitiveQuery());
      expect(String(call[0])).toContain('sdci.object_class IN (?, ?, ?, ?)');
      expect(call[1]).toEqual([
        CUTOFF,
        'admin_audit_detail',
        'approval_transport_detail',
        'webhook_delivery_payload',
        'operational_log_detail',
        100,
        0,
      ]);
      const lines = (must(part())[1] as string)
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(lines.map((l) => [l.log_type, l.surface])).toEqual([
        ['admin_audit', 'admin_audit'],
        ['admin_audit', 'approval_transport'],
        ['webhook', 'webhook'],
        ['operational', 'operational'],
      ]);
      for (const line of lines) {
        expect(line.plane).toBe('sensitive_detail');
        expect(line.status).toBe('committed');
        expect(line.tenant_id).toBeUndefined();
        expect(line.record_payload).toBeUndefined();
      }
      expect(sensitiveLoader).not.toHaveBeenCalled();
    });

    it.each([
      ['admin_audit', ['admin_audit_detail', 'approval_transport_detail']],
      ['webhook', ['webhook_delivery_payload']],
      ['operational', ['operational_log_detail']],
    ])(
      'narrows the classes for %s logs and applies tenant and time filters',
      async (logType, classes) => {
        await runExport({
          filters: {
            plane: 'sensitive_detail',
            log_type: logType,
            tenant_key: 't_a',
            time_start: 1,
            time_end: 9,
          },
        });
        const call = must(sensitiveQuery());
        expect(String(call[0])).toContain(
          `sdci.object_class IN (${classes.map(() => '?').join(', ')}) AND t.tenant_key = ? AND sdci.created_at >= ? AND sdci.created_at <= ?`
        );
        expect(call[1]).toEqual([CUTOFF, ...classes, 't_a', 1, 9, 100, 0]);
      }
    );

    it('returns nothing for log types that have no sensitive detail', async () => {
      const { result } = await runExport({
        filters: { plane: 'sensitive_detail', log_type: 'security' },
      });
      expect(sensitiveQuery()).toBeUndefined();
      expect(must(part())[1]).toBe('');
      expect(result.messageJobs.completed).toBe(1);
    });

    it('flags rows of an unknown detail class', async () => {
      sensitiveRows = [sensitiveRow({ object_class: 'mystery' })];
      await runExport({ filters: { plane: 'sensitive_detail' } });
      const line = JSON.parse((must(part())[1] as string).trim());
      expect(line.record_payload_error).toBe('unsupported_sensitive_detail_object_class');
      expect(line.object_class).toBe('mystery');
    });

    it('loads payloads on request, and reports unavailable ones', async () => {
      sensitiveRows = [
        sensitiveRow({ record_id: 'ok' }),
        sensitiveRow({ record_id: 'null' }),
        sensitiveRow({ record_id: 'boom' }),
      ];
      sensitiveLoader.mockImplementation(
        async (
          _adapter: unknown,
          _env: unknown,
          input: { tenantId: string; objectCatalogId: string }
        ) => {
          calls.push(input);
          return null;
        }
      );
      const calls: unknown[] = [];
      let n = 0;
      sensitiveLoader.mockReset();
      sensitiveLoader.mockImplementation(async (_a: unknown, _e: unknown, input: unknown) => {
        calls.push(input);
        n += 1;
        if (n === 1) return { secret: 'value' };
        if (n === 2) return null;
        throw new Error('decrypt failed');
      });
      await runExport({ filters: { plane: 'sensitive_detail', include_payload: true } });
      const lines = (must(part())[1] as string)
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(lines[0].record_payload).toEqual({ secret: 'value' });
      expect(lines[0].record_payload_error).toBeUndefined();
      expect(lines[1].record_payload_error).toBe('record_payload_unavailable');
      expect(lines[1].record_payload).toBeUndefined();
      expect(lines[2].record_payload_error).toBe('record_payload_unavailable');
      expect(calls[0]).toEqual({
        tenantId: 'tenant-1',
        objectCatalogId: 'cat_1',
        expectedClass: 'webhook_delivery_payload',
      });
      for (const line of lines) expect(line.tenant_id).toBeUndefined();
    });
  });
});
