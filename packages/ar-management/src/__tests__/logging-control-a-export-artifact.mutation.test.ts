/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- admin API response bodies and hono/vi fakes are untyped in these route tests */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const auditWrite = vi.hoisted(() => vi.fn(async () => 'audit_1'));
vi.mock('../admin-shared', async (original) => ({
  ...(await original<typeof import('../admin-shared')>()),
  writeAdminAuditLog: auditWrite,
}));

const stepUp = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<Response | null> => null));
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: stepUp,
  refuseAdminFreshAuth: vi.fn(async () => null),
}));

const mockAdapter = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  batch: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const statusByCode: Record<string, number> = {
    [actual.AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS]: 403,
    [actual.AR_ERROR_CODES.ADMIN_INVALID_REQUEST]: 400,
    [actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND]: 404,
    [actual.AR_ERROR_CODES.ADMIN_CONFLICT]: 409,
    [actual.AR_ERROR_CODES.INTERNAL_ERROR]: 500,
  };
  return {
    ...actual,
    requireAdminDatabaseAdapter: vi.fn(() => mockAdapter),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mockAdapter),
    getTenantIdFromContext: vi.fn((c: { get: (key: string) => unknown }) => c.get('tenantId')),
    createErrorResponse: vi.fn(
      (
        c: { json: (body: unknown, status?: number) => Response },
        errorCode: string,
        options?: { extensions?: Record<string, unknown> }
      ) =>
        c.json({ error: errorCode, ...(options?.extensions ?? {}) }, statusByCode[errorCode] ?? 500)
    ),
  };
});

import { ADMIN_PERMISSIONS, AR_ERROR_CODES } from '@authrim/ar-lib-core';
import { deriveTenantKeyFromTenantId } from '@authrim/ar-lib-logging/contract';
import { createApp, resetAdapter, routeSql, textObject } from './logging-control-a-harness';

const READ = ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ;
const MAX = 64 * 1024 * 1024;
type Body = Record<string, any>;

let exportBucket: { get: ReturnType<typeof vi.fn>; head?: ReturnType<typeof vi.fn> };
let tenantKey: string;

async function download(opts: { bucket?: boolean } = {}) {
  return createApp([READ]).request(
    '/api/admin/logging-policies/exports/exp_1/artifact',
    { method: 'GET' },
    {
      DB_ADMIN: {},
      ...(opts.bucket === false ? {} : { EXPORT_ARTIFACTS: exportBucket }),
    }
  );
}

const exportRow = (extra: Record<string, unknown> = {}) => ({
  id: 'exp_1',
  tenant_key: tenantKey,
  log_type: 'audit',
  plane: 'archive',
  format: 'zip',
  status: 'completed',
  artifact_object_ref: 'logging-exports/v1/exp_1/data.zip',
  manifest_object_ref: null,
  checksum_sha256: 'sha',
  record_count: 1,
  byte_count: 10,
  requested_by: 'admin-1',
  error_class: null,
  filter_json: null,
  created_at: 1,
  updated_at: 2,
  completed_at: 3,
  expires_at: null,
  ...extra,
});

function streamObject(chunks: Array<Uint8Array | undefined>, extra: Record<string, unknown> = {}) {
  const queue = [...chunks];
  const cancel = vi.fn().mockResolvedValue(undefined);
  const releaseLock = vi.fn();
  return {
    cancel,
    releaseLock,
    object: {
      body: {
        getReader: () => ({
          read: async () =>
            queue.length === 0
              ? { done: true, value: undefined }
              : { done: false, value: queue.shift() },
          cancel,
          releaseLock,
        }),
      },
      ...extra,
    } as unknown as R2ObjectBody,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetAdapter(mockAdapter);
  stepUp.mockReset().mockResolvedValue(null);
  exportBucket = { get: vi.fn().mockResolvedValue(null) };
  tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
  routeSql(mockAdapter, {
    one: [{ match: /FROM logging_export_jobs/, result: exportRow() }],
  });
});

describe('GET /exports/:id/artifact (zip, byte reads)', () => {
  it('requires the read permission and an export bucket', async () => {
    const denied = await createApp([]).request(
      '/api/admin/logging-policies/exports/exp_1/artifact',
      {},
      { DB_ADMIN: {} }
    );
    expect(denied.status).toBe(403);
    const res = await download({ bucket: false });
    expect(res.status).toBe(400);
    const body = await res.json<Body>();
    expect(body.details.fields).toEqual([
      {
        path: 'destination',
        code: 'bucket_unavailable',
        message: 'Export artifact bucket is unavailable.',
      },
    ]);
  });

  it('404s exports without refs and rejects refs outside the export prefix', async () => {
    routeSql(mockAdapter, {
      one: [
        { match: /FROM logging_export_jobs/, result: exportRow({ artifact_object_ref: null }) },
      ],
    });
    expect((await download()).status).toBe(404);
    routeSql(mockAdapter, {
      one: [
        {
          match: /FROM logging_export_jobs/,
          result: exportRow({ artifact_object_ref: 'logging-exports/v1/other/data.zip' }),
        },
      ],
    });
    const res = await download();
    expect(res.status).toBe(400);
    expect((await res.json<Body>()).details.fields[0]).toEqual({
      path: 'artifact_object_ref',
      code: 'invalid_object_ref',
      message: 'Export artifact ref is invalid.',
    });
    expect(exportBucket.get).not.toHaveBeenCalled();
  });

  it('streams chunks into one body with download headers', async () => {
    const { object, releaseLock } = streamObject(
      [new Uint8Array([1, 2]), undefined, new Uint8Array([3]), new Uint8Array([4, 5, 6])],
      { size: 6 }
    );
    exportBucket.get.mockResolvedValue(object);
    const res = await download();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="exp_1.zip"');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(exportBucket.get).toHaveBeenCalledWith('logging-exports/v1/exp_1/data.zip');
  });

  it('refuses objects larger than the inline limit by size or while streaming', async () => {
    exportBucket.get.mockResolvedValue({ size: MAX + 1, body: undefined });
    const bySize = await download();
    expect(bySize.status).toBe(400);
    expect((await bySize.json<Body>()).details.fields[0].code).toBe(
      'artifact_too_large_for_inline_download'
    );

    const { object, cancel, releaseLock } = streamObject([
      new Uint8Array(4),
      { byteLength: MAX } as unknown as Uint8Array,
      new Uint8Array(4),
    ]);
    exportBucket.get.mockResolvedValue(object);
    const streaming = await download();
    expect(streaming.status).toBe(400);
    expect((await streaming.json<Body>()).details.fields[0].code).toBe(
      'artifact_too_large_for_inline_download'
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('rejects a streamed chunk that exceeds the limit by one byte', async () => {
    const over = streamObject([{ byteLength: MAX + 1 } as unknown as Uint8Array]);
    exportBucket.get.mockResolvedValue(over.object);
    const res = await download();
    expect(res.status).toBe(400);
    expect(over.cancel).toHaveBeenCalled();
  });

  it('still answers too-large when cancelling the stream fails', async () => {
    const over = streamObject([{ byteLength: MAX + 1 } as unknown as Uint8Array]);
    over.cancel.mockRejectedValue(new Error('cancel failed'));
    exportBucket.get.mockResolvedValue(over.object);
    const res = await download();
    expect(res.status).toBe(400);
    expect((await res.json<Body>()).details.fields[0].code).toBe(
      'artifact_too_large_for_inline_download'
    );
    expect(over.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('falls back to arrayBuffer for objects without a body stream', async () => {
    exportBucket.get.mockResolvedValue({
      size: 3,
      arrayBuffer: async () => new Uint8Array([7, 8, 9]).buffer,
    });
    const res = await download();
    expect(res.status).toBe(200);
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([7, 8, 9]);
    exportBucket.get.mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(MAX + 1) });
    const big = await download();
    expect(big.status).toBe(400);
    expect((await big.json<Body>()).details.fields[0].code).toBe(
      'artifact_too_large_for_inline_download'
    );
  });

  it('404s when the object disappeared and when the head probe misses', async () => {
    exportBucket.get.mockResolvedValue(null);
    expect((await download()).status).toBe(404);
    exportBucket.head = vi.fn().mockResolvedValue(null);
    const missing = await download();
    expect(missing.status).toBe(404);
    expect((await missing.json<Body>()).error).toBe(AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    exportBucket.head = vi.fn().mockResolvedValue({ size: MAX + 5 });
    const big = await download();
    expect(big.status).toBe(400);
  });

  it('rejects exports above the inline download size before reading anything', async () => {
    routeSql(mockAdapter, {
      one: [{ match: /FROM logging_export_jobs/, result: exportRow({ byte_count: MAX + 1 }) }],
    });
    const res = await download();
    expect(res.status).toBe(400);
    expect(exportBucket.get).not.toHaveBeenCalled();
  });

  it('serves text formats through the text reader with the right content type', async () => {
    for (const [format, type, ext] of [
      ['csv', 'text/csv', 'csv'],
      ['jsonl', 'application/x-ndjson', 'jsonl'],
    ] as const) {
      routeSql(mockAdapter, {
        one: [
          {
            match: /FROM logging_export_jobs/,
            result: exportRow({
              format,
              artifact_object_ref: `logging-exports/v1/exp_1/data.${ext}`,
            }),
          },
        ],
      });
      exportBucket.get.mockResolvedValue(textObject('a,b\n1,2\n'));
      const res = await download();
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(type);
      expect(res.headers.get('content-disposition')).toBe(`attachment; filename="exp_1.${ext}"`);
      expect(await res.text()).toBe('a,b\n1,2\n');
    }
  });
});
