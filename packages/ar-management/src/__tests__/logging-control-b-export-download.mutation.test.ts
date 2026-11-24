/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- admin API response bodies are untyped JSON in these route tests */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../admin-shared', async (original) => ({
  ...(await original<typeof import('../admin-shared')>()),
  writeAdminAuditLog: (await import('./logging-control-b-harness')).auditWrite,
}));
vi.mock('../admin-step-up-gate', async () => {
  const { stepUpFakes } = await import('./logging-control-b-harness');
  return {
    requireAdminStepUp: stepUpFakes.requireAdminStepUp,
    refuseAdminFreshAuth: stepUpFakes.refuseAdminFreshAuth,
  };
});
vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./logging-control-b-harness')).buildCoreMock(
    await importOriginal<typeof import('@authrim/ar-lib-core')>()
  )
);

import type { Env } from '@authrim/ar-lib-core';
import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { decodeLoggingCursor, encodeLoggingCursor } from '@authrim/ar-lib-logging/delivery';
import { deriveTenantKeyFromTenantId } from '@authrim/ar-lib-logging/contract';
import { envFixture, mockAdapter, resetFakes, stepUpFakes } from './logging-control-b-harness';
import { POLICIES, call, createApp, createPlatformApp } from './logging-control-b-app';
import { must } from './helpers/must';

const READ = [ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ];
const SENSITIVE = 'admin:logging:sensitive_detail:export';
const SECRET = 'test-logging-cursor-secret';
const MAX = 64 * 1024 * 1024;
const PREFIX = 'logging-exports/v1/lexp_1/';

function r2Object(text: string, size?: number) {
  const body = new TextEncoder().encode(text);
  return {
    size: size ?? body.byteLength,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    }),
  };
}

function exportRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lexp_1',
    tenant_key: 'tk_a',
    log_type: 'audit',
    plane: 'archive',
    format: 'jsonl',
    status: 'completed',
    artifact_object_ref: `${PREFIX}artifact.jsonl`,
    manifest_object_ref: null,
    checksum_sha256: 'sum',
    record_count: 2,
    byte_count: 10,
    requested_by: 'admin-1',
    error_class: null,
    filter_json: JSON.stringify({ include_payload: false, detail_scope: 'none' }),
    created_at: 1,
    updated_at: 2,
    completed_at: 3,
    expires_at: 4,
    ...overrides,
  };
}

function bucketEnv(
  objects: Record<string, ReturnType<typeof r2Object> | null>,
  withHead = true,
  heads: Record<string, { size: number } | null> = {}
) {
  const bucket: Record<string, unknown> = {
    get: vi.fn(async (ref: string) => objects[ref] ?? null),
  };
  if (withHead) {
    bucket.head = vi.fn(async (ref: string) =>
      ref in heads
        ? heads[ref]
        : ref in objects && objects[ref]
          ? { size: objects[ref].size }
          : null
    );
  }
  return {
    bucket: bucket as { get: ReturnType<typeof vi.fn>; head?: ReturnType<typeof vi.fn> },
    env: { ...envFixture, EXPORT_ARTIFACTS: bucket } as unknown as Env,
  };
}

beforeEach(() => resetFakes());

describe('GET /exports/:id', () => {
  const path = `${POLICIES}/exports/lexp_1`;

  it('requires delivery-events read', async () => {
    expect((await call(createApp([]), 'GET', path)).status).toBe(403);
    expect(mockAdapter.queryOne).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown export and refuses another tenant', async () => {
    expect((await call(createPlatformApp(READ), 'GET', path)).status).toBe(404);
    expect(mockAdapter.queryOne.mock.calls[0][1]).toEqual(['lexp_1']);
    mockAdapter.queryOne.mockResolvedValue(exportRow({ tenant_key: 'tk_other' }));
    const foreign = await call(createApp(READ), 'GET', path);
    expect(foreign.status).toBe(403);
    expect(foreign.body.details.permission.reason).toBe('tenant_key_scope_mismatch');
  });

  it('protects sensitive-detail exports behind their own permission', async () => {
    mockAdapter.queryOne.mockResolvedValue(exportRow({ plane: 'sensitive_detail' }));
    const denied = await call(createPlatformApp(READ), 'GET', path);
    expect(denied.status).toBe(403);
    expect(denied.body.details.permission).toEqual({
      required_permission: SENSITIVE,
      reason: 'sensitive_detail_export_permission_required',
    });
    const allowed = await call(createPlatformApp([...READ, SENSITIVE]), 'GET', path);
    expect(allowed.status).toBe(200);
    expect(allowed.body.item.plane).toBe('sensitive_detail');
  });

  it('returns the export to its own tenant and answers 500 on failure', async () => {
    const row = exportRow({ tenant_key: await deriveTenantKeyFromTenantId('tenant-a', undefined) });
    mockAdapter.queryOne.mockResolvedValue(row);
    const res = await call(createApp(READ), 'GET', path);
    expect(res.body.item).toEqual(row);
    mockAdapter.queryOne.mockRejectedValue(new Error('x'));
    expect((await call(createApp(READ), 'GET', path)).status).toBe(500);
  });
});

describe('GET /exports/:id/artifact', () => {
  const path = `${POLICIES}/exports/lexp_1/artifact`;
  const app = () => createPlatformApp(READ);

  it('requires read permission and the export bucket', async () => {
    expect((await call(createApp([]), 'GET', path)).status).toBe(403);
    const res = await call(app(), 'GET', path, undefined, {}, {
      ...envFixture,
      EXPORT_ARTIFACTS: undefined,
    } as unknown as Env);
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual([
      {
        path: 'destination',
        code: 'bucket_unavailable',
        message: 'Export artifact bucket is unavailable.',
      },
    ]);
  });

  it('answers 404 when the export has neither artifact nor manifest', async () => {
    expect((await call(app(), 'GET', path)).status).toBe(404);
    mockAdapter.queryOne.mockResolvedValue(
      exportRow({ artifact_object_ref: null, manifest_object_ref: null })
    );
    expect((await call(app(), 'GET', path)).status).toBe(404);
  });

  it('enforces tenancy, the sensitive-detail permission and the inline size cap', async () => {
    mockAdapter.queryOne.mockResolvedValue(exportRow({ tenant_key: 'tk_other' }));
    expect((await call(createApp(READ), 'GET', path)).status).toBe(403);
    mockAdapter.queryOne.mockResolvedValue(exportRow({ plane: 'sensitive_detail' }));
    expect((await call(app(), 'GET', path)).status).toBe(403);
    mockAdapter.queryOne.mockResolvedValue(exportRow({ byte_count: MAX }));
    const { env } = bucketEnv({ [`${PREFIX}artifact.jsonl`]: r2Object('x') });
    expect((await call(app(), 'GET', path, undefined, {}, env)).status).toBe(200);
    mockAdapter.queryOne.mockResolvedValue(exportRow({ byte_count: MAX + 1 }));
    const big = await call(app(), 'GET', path, undefined, {}, env);
    expect(big.status).toBe(400);
    expect(big.body.details.fields).toEqual([
      {
        path: 'artifact',
        code: 'artifact_too_large_for_inline_download',
        message: 'Export artifact is too large for inline API download.',
      },
    ]);
  });

  it('rejects an artifact ref outside the export prefix', async () => {
    mockAdapter.queryOne.mockResolvedValue(
      exportRow({ artifact_object_ref: 'logging-exports/v1/other/a' })
    );
    const res = await call(app(), 'GET', path);
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual([
      {
        path: 'artifact_object_ref',
        code: 'invalid_object_ref',
        message: 'Export artifact ref is invalid.',
      },
    ]);
  });

  it('streams a single artifact with download headers for each format', async () => {
    const cases: Array<[string, string, string]> = [
      ['jsonl', 'application/x-ndjson', 'jsonl'],
      ['csv', 'text/csv', 'csv'],
    ];
    for (const [format, type, ext] of cases) {
      const ref = `${PREFIX}artifact.${ext}`;
      mockAdapter.queryOne.mockResolvedValue(exportRow({ format, artifact_object_ref: ref }));
      const { env, bucket } = bucketEnv({ [ref]: r2Object('a,b\n1,2\n') });
      const response = await app().request(path, {}, env);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('a,b\n1,2\n');
      expect(response.headers.get('content-type')).toBe(type);
      expect(response.headers.get('content-disposition')).toBe(
        `attachment; filename="lexp_1.${ext}"`
      );
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(bucket.head).toHaveBeenCalledWith(ref);
      expect(stepUpFakes.requireAdminStepUp).not.toHaveBeenCalled();
    }
  });

  it('returns zip artifacts as bytes', async () => {
    const ref = `${PREFIX}artifact.zip`;
    mockAdapter.queryOne.mockResolvedValue(exportRow({ format: 'zip', artifact_object_ref: ref }));
    const { env } = bucketEnv({ [ref]: r2Object('PK-bytes') });
    const response = await app().request(path, {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="lexp_1.zip"');
    expect(await response.text()).toBe('PK-bytes');
  });

  it('answers 404 for a missing object and rejects an oversized object before reading', async () => {
    const ref = `${PREFIX}artifact.jsonl`;
    mockAdapter.queryOne.mockResolvedValue(exportRow());
    const missing = bucketEnv({});
    expect((await call(app(), 'GET', path, undefined, {}, missing.env)).status).toBe(404);
    expect(missing.bucket.get).not.toHaveBeenCalled();
    const big = bucketEnv({ [ref]: r2Object('x') }, true, { [ref]: { size: MAX + 1 } });
    const res = await call(app(), 'GET', path, undefined, {}, big.env);
    expect(res.status).toBe(400);
    expect(res.body.details.fields[0].code).toBe('artifact_too_large_for_inline_download');
    expect(big.bucket.get).not.toHaveBeenCalled();
    const noHead = bucketEnv({}, false);
    expect((await call(app(), 'GET', path, undefined, {}, noHead.env)).status).toBe(404);
    expect(noHead.bucket.get).toHaveBeenCalledWith(ref);
  });

  it('gates sensitive exports behind step-up right before the first read', async () => {
    const ref = `${PREFIX}artifact.jsonl`;
    mockAdapter.queryOne.mockResolvedValue(
      exportRow({ filter_json: JSON.stringify({ include_payload: true }) })
    );
    const { env, bucket } = bucketEnv({ [ref]: r2Object('secret') });
    const ok = await call(app(), 'GET', path, undefined, {}, env);
    expect(ok.status).toBe(200);
    expect(stepUpFakes.requireAdminStepUp).toHaveBeenCalledWith(expect.anything(), {
      operation: 'log.sensitive.export',
      targetTenantId: 'tenant-a',
      targetIds: ['lexp_1'],
      params: {
        kind: 'logging.export.download',
        export_id: 'lexp_1',
        tenant_key: 'tk_a',
        checksum_sha256: 'sum',
        artifact_object_ref: ref,
        manifest_object_ref: null,
        format: 'jsonl',
      },
    });
    bucket.get.mockClear();
    stepUpFakes.requireAdminStepUp.mockResolvedValueOnce(new Response('stepup', { status: 401 }));
    const refused = await call(app(), 'GET', path, undefined, {}, env);
    expect(refused.status).toBe(401);
    expect(bucket.get).not.toHaveBeenCalled();
    for (const filter of [JSON.stringify({ detail_scope: 'full' }), 'not json']) {
      stepUpFakes.requireAdminStepUp.mockClear();
      mockAdapter.queryOne.mockResolvedValue(exportRow({ filter_json: filter }));
      await call(app(), 'GET', path, undefined, {}, env);
      expect(stepUpFakes.requireAdminStepUp).toHaveBeenCalledTimes(1);
    }
    stepUpFakes.requireAdminStepUp.mockClear();
    mockAdapter.queryOne.mockResolvedValue(exportRow({ filter_json: null }));
    await call(app(), 'GET', path, undefined, {}, env);
    mockAdapter.queryOne.mockResolvedValue(exportRow({ filter_json: '[1]' }));
    await call(app(), 'GET', path, undefined, {}, env);
    expect(stepUpFakes.requireAdminStepUp).not.toHaveBeenCalled();
  });

  describe('manifest exports', () => {
    const manifestRef = `${PREFIX}manifest.json`;
    const part = (n: number) => `${PREFIX}part-${n}.jsonl`;
    const row = (overrides: Record<string, unknown> = {}) =>
      exportRow({ artifact_object_ref: null, manifest_object_ref: manifestRef, ...overrides });
    const manifest = (parts: unknown[]) =>
      r2Object(JSON.stringify({ parts: parts.map((object_ref) => ({ object_ref })) }));

    it('rejects an invalid manifest ref and answers 404 for missing objects', async () => {
      mockAdapter.queryOne.mockResolvedValue(
        row({ manifest_object_ref: 'logging-exports/v1/x/m.json' })
      );
      const invalid = await call(app(), 'GET', path);
      expect(invalid.body.details.fields).toEqual([
        {
          path: 'manifest_object_ref',
          code: 'invalid_object_ref',
          message: 'Export manifest ref is invalid.',
        },
      ]);
      mockAdapter.queryOne.mockResolvedValue(row());
      expect((await call(app(), 'GET', path, undefined, {}, bucketEnv({}).env)).status).toBe(404);
    });

    it('rejects oversized and malformed manifests', async () => {
      mockAdapter.queryOne.mockResolvedValue(row());
      const huge = bucketEnv({ [manifestRef]: r2Object('x', 1024 * 1024 + 1) });
      const tooLarge = await call(app(), 'GET', path, undefined, {}, huge.env);
      expect(tooLarge.status).toBe(400);
      expect(tooLarge.body.details.fields).toEqual([
        {
          path: 'manifest_object_ref',
          code: 'manifest_too_large_for_inline_download',
          message: 'Export manifest is too large for inline API download.',
        },
      ]);
      const malformed = bucketEnv({ [manifestRef]: r2Object('{nope') });
      const res = await call(app(), 'GET', path, undefined, {}, malformed.env);
      expect(res.body.details.fields).toEqual([
        {
          path: 'manifest_object_ref',
          code: 'manifest_malformed_json',
          message: 'Export manifest is invalid.',
        },
      ]);
    });

    it('applies the part-count and zip rules', async () => {
      mockAdapter.queryOne.mockResolvedValue(row());
      const none = bucketEnv({ [manifestRef]: r2Object(JSON.stringify({})) });
      expect((await call(app(), 'GET', path, undefined, {}, none.env)).status).toBe(404);
      const nonStrings = bucketEnv({ [manifestRef]: manifest([7, null]) });
      expect((await call(app(), 'GET', path, undefined, {}, nonStrings.env)).status).toBe(404);

      const many = bucketEnv({
        [manifestRef]: manifest(Array.from({ length: 1001 }, (_, i) => part(i))),
      });
      const tooMany = await call(app(), 'GET', path, undefined, {}, many.env);
      expect(tooMany.body.details.fields).toEqual([
        {
          path: 'manifest.parts',
          code: 'too_many_parts_for_inline_download',
          message: 'Export has too many parts for inline API download.',
        },
      ]);
      const exactly = bucketEnv({
        [manifestRef]: manifest(Array.from({ length: 1000 }, (_, i) => part(i))),
      });
      expect((await call(app(), 'GET', path, undefined, {}, exactly.env)).status).toBe(404);

      mockAdapter.queryOne.mockResolvedValue(row({ format: 'zip' }));
      const zipMulti = bucketEnv({ [manifestRef]: manifest([part(1), part(2)]) });
      const res = await call(app(), 'GET', path, undefined, {}, zipMulti.env);
      expect(res.body.details.fields).toEqual([
        {
          path: 'manifest.parts',
          code: 'zip_multi_part_inline_download_unsupported',
          message: 'ZIP exports with multiple parts must be downloaded part-by-part.',
        },
      ]);
    });

    it('rejects part refs outside the export prefix and unavailable parts', async () => {
      mockAdapter.queryOne.mockResolvedValue(row());
      const outside = bucketEnv({
        [manifestRef]: manifest([part(1), 'logging-exports/v1/other/p']),
      });
      const res = await call(app(), 'GET', path, undefined, {}, outside.env);
      expect(res.body.details.fields).toEqual([
        {
          path: 'manifest.parts',
          code: 'invalid_object_ref',
          message: 'Export manifest contains invalid part refs.',
        },
      ]);
      const missingPart = bucketEnv({ [manifestRef]: manifest([part(1)]) });
      expect((await call(app(), 'GET', path, undefined, {}, missingPart.env)).status).toBe(404);
      const noHead = bucketEnv({ [manifestRef]: manifest([part(1)]) }, false);
      expect((await call(app(), 'GET', path, undefined, {}, noHead.env)).status).toBe(404);
      const oversize = bucketEnv(
        { [manifestRef]: manifest([part(1)]), [part(1)]: r2Object('x') },
        true,
        { [part(1)]: { size: MAX } }
      );
      const big = await call(app(), 'GET', path, undefined, {}, oversize.env);
      expect(big.status).toBe(400);
      expect(big.body.details.fields[0].code).toBe('artifact_too_large_for_inline_download');
    });

    it('concatenates jsonl parts', async () => {
      mockAdapter.queryOne.mockResolvedValue(row());
      const { env } = bucketEnv({
        [manifestRef]: manifest([part(1), part(2)]),
        [part(1)]: r2Object('{"a":1}\n'),
        [part(2)]: r2Object('{"a":2}\n'),
      });
      const response = await app().request(path, {}, env);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('{"a":1}\n{"a":2}\n');
      expect(response.headers.get('content-type')).toBe('application/x-ndjson');
      expect(response.headers.get('content-disposition')).toBe(
        'attachment; filename="lexp_1.jsonl"'
      );
    });

    it('joins csv parts, dropping the header of every part after the first', async () => {
      mockAdapter.queryOne.mockResolvedValue(row({ format: 'csv' }));
      const { env } = bucketEnv({
        [manifestRef]: manifest([part(1), part(2), part(3)]),
        [part(1)]: r2Object('h1,h2\n1,2'),
        [part(2)]: r2Object('h1,h2\r\n3,4\r\n5,6'),
        [part(3)]: r2Object('h1,h2\n7,8'),
      });
      const response = await app().request(path, {}, env);
      expect(await response.text()).toBe('h1,h2\n1,2\n3,4\n5,6\n7,8');
      expect(response.headers.get('content-type')).toBe('text/csv');
      expect(response.headers.get('content-disposition')).toBe('attachment; filename="lexp_1.csv"');
    });

    it('returns a single zip part as bytes and gates sensitive manifests with step-up', async () => {
      mockAdapter.queryOne.mockResolvedValue(row({ format: 'zip' }));
      const zip = bucketEnv({
        [manifestRef]: manifest([part(1)]),
        [part(1)]: r2Object('ZIPDATA'),
      });
      const response = await app().request(path, {}, zip.env);
      expect(response.headers.get('content-type')).toBe('application/zip');
      expect(await response.text()).toBe('ZIPDATA');

      mockAdapter.queryOne.mockResolvedValue(row({ plane: 'sensitive_detail' }));
      const sensitive = bucketEnv({
        [manifestRef]: manifest([part(1)]),
        [part(1)]: r2Object('x'),
      });
      stepUpFakes.requireAdminStepUp.mockResolvedValueOnce(new Response('stepup', { status: 401 }));
      const refused = await call(
        createPlatformApp([...READ, SENSITIVE]),
        'GET',
        path,
        undefined,
        {},
        sensitive.env
      );
      expect(refused.status).toBe(401);
      expect(stepUpFakes.requireAdminStepUp.mock.calls[0][1].params).toMatchObject({
        manifest_object_ref: manifestRef,
        artifact_object_ref: null,
      });
      expect(sensitive.bucket.get).toHaveBeenCalledTimes(1); // only the manifest was read
    });

    it('answers 404 when a listed part vanished and 500 on unexpected failure', async () => {
      mockAdapter.queryOne.mockResolvedValue(row());
      const gone = bucketEnv({ [manifestRef]: manifest([part(1)]) }, true, {
        [part(1)]: { size: 1 },
      });
      expect((await call(app(), 'GET', path, undefined, {}, gone.env)).status).toBe(404);
      mockAdapter.queryOne.mockRejectedValue(new Error('x'));
      expect((await call(app(), 'GET', path)).status).toBe(500);
    });
  });
});

describe('DLQ listing', () => {
  const path = `${POLICIES}/dlq-items`;

  function dlqRows(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      id: `dlq_${count - index}`,
      created_at: 9000 - index,
    }));
  }

  it('is served on both route aliases and requires delivery-events read', async () => {
    expect((await call(createApp([]), 'GET', path)).status).toBe(403);
    for (const alias of [`${POLICIES}/dlq`, path]) {
      expect((await call(createPlatformApp(READ), 'GET', alias)).status).toBe(200);
    }
    expect((await call(createApp(READ), 'GET', `${path}?tenant_key=other`)).status).toBe(403);
  });

  it('applies every filter in order with limit+1 last', async () => {
    const res = await call(
      createPlatformApp(READ),
      'GET',
      `${path}?filter[tenant_key]=tk_1&filter[lane]=bulk&filter[status]=open&time_start=10&time_end=20&limit=4`
    );
    expect(res.status).toBe(200);
    const [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      'WHERE tenant_key = ? AND lane = ? AND status = ? AND created_at >= ? AND created_at <= ?'
    );
    expect(sql).toContain('FROM logging_dlq_items');
    expect(params).toEqual(['tk_1', 'bulk', 'open', 10, 20, 5]);
    expect(res.body.page).toEqual({
      next_cursor: null,
      has_more: false,
      limit: 4,
      time_start: 10,
      time_end: 20,
    });
    mockAdapter.query.mockClear();
    const bare = await call(createPlatformApp(READ), 'GET', path);
    expect(mockAdapter.query.mock.calls[0][0]).not.toContain('WHERE');
    expect(mockAdapter.query.mock.calls[0][1]).toEqual([51]);
    expect(bare.body.page).not.toHaveProperty('time_start');
    mockAdapter.query.mockClear();
    await call(createPlatformApp(READ), 'GET', `${path}?tenant_key=a&lane=critical&status=failed`);
    expect(mockAdapter.query.mock.calls[0][1]).toEqual(['a', 'critical', 'failed', 51]);
  });

  it('pages with a cursor bound to the dlq filters', async () => {
    const app = createPlatformApp(READ);
    mockAdapter.query.mockResolvedValueOnce(dlqRows(3));
    const first = await call(app, 'GET', `${path}?lane=bulk&limit=2`);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.page.has_more).toBe(true);
    const cursor = first.body.page.next_cursor as string;
    const decoded = await decodeLoggingCursor(cursor, SECRET);
    expect(decoded.payload?.sort).toEqual({ created_at: 8999, id: 'dlq_2' });
    mockAdapter.query.mockClear();
    const second = await call(
      app,
      'GET',
      `${path}?lane=bulk&limit=2&cursor=${encodeURIComponent(cursor)}`
    );
    expect(second.status).toBe(200);
    const [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('lane = ? AND (created_at < ? OR (created_at = ? AND id < ?))');
    expect(params).toEqual(['bulk', 8999, 8999, 'dlq_2', 3]);
    // a cursor from the delivery-events listing is not valid here
    const mismatch = await call(
      app,
      'GET',
      `${path}?lane=other&limit=2&cursor=${encodeURIComponent(cursor)}`
    );
    expect(mismatch.body.details.fields[0].code).toBe('filter_mismatch');
  });

  it('rejects unusable cursors', async () => {
    const app = createPlatformApp(READ);
    const garbage = await call(app, 'GET', `${path}?cursor=garbage`);
    expect(garbage.status).toBe(400);
    expect(garbage.body.details.fields[0]).toMatchObject({
      path: 'cursor',
      message: 'Cursor is invalid or expired.',
    });
    mockAdapter.query.mockResolvedValueOnce(dlqRows(2));
    const seed = await call(app, 'GET', `${path}?limit=1`);
    const payload = must((await decodeLoggingCursor(seed.body.page.next_cursor, SECRET)).payload);
    const badSort = await encodeLoggingCursor({ ...payload, sort: { created_at: 5 } }, SECRET);
    const res = await call(app, 'GET', `${path}?limit=1&cursor=${encodeURIComponent(badSort)}`);
    expect(res.body.details.fields).toEqual([
      { path: 'cursor', code: 'invalid_sort', message: 'Cursor sort key is invalid.' },
    ]);
    const saved = envFixture.LOGGING_CURSOR_HMAC_SECRET;
    try {
      (envFixture as { LOGGING_CURSOR_HMAC_SECRET?: string }).LOGGING_CURSOR_HMAC_SECRET =
        undefined;
      const noSecret = await call(app, 'GET', `${path}?cursor=abc`);
      expect(noSecret.body.details.fields[0].code).toBe('cursor_secret_unavailable');
      mockAdapter.query.mockResolvedValueOnce(dlqRows(3));
      const page = await call(app, 'GET', `${path}?limit=2`);
      expect(page.body.page.next_cursor).toBeNull();
    } finally {
      envFixture.LOGGING_CURSOR_HMAC_SECRET = saved;
    }
    mockAdapter.query.mockRejectedValue(new Error('x'));
    expect((await call(app, 'GET', path)).status).toBe(500);
  });
});
