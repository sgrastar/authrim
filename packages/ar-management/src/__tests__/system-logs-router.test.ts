import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { Hono, type Context } from 'hono';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { LogQueryIncompleteError } from '../log-archive-query';

const { mockAdapter, mockCreateLogReadAdapter } = vi.hoisted(() => ({
  mockAdapter: {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
  } satisfies Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>,
  mockCreateLogReadAdapter: vi.fn<(input: unknown) => unknown>(),
}));

vi.mock('../log-read-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../log-read-adapter')>();
  return {
    ...actual,
    createLogReadAdapter: (input: unknown) => mockCreateLogReadAdapter(input),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    adminAuthMiddleware: vi.fn(
      (options?: { requirePermissions?: string[] }) =>
        async (
          c: Context<{ Bindings: Env; Variables: { adminAuth: unknown } }>,
          next: () => Promise<void>
        ) => {
          const permissions = (c.req.header('X-Admin-Permissions') || '')
            .split(',')
            .map((value: string) => value.trim())
            .filter(Boolean);
          c.set('adminAuth', {
            userId: 'admin-1',
            authMethod: 'session',
            tenantId: 'tenant-a',
            permissions,
            roles: ['ar_viewer'],
            hierarchyLevel: 20,
            mfaVerified: true,
          });
          if (options?.requirePermissions?.length) {
            const hasAll = options.requirePermissions.every((required) =>
              actual.hasAdminPermission(permissions, required)
            );
            if (!hasAll) return c.json({ error: 'insufficient_permissions' }, 403);
          }
          await next();
        }
    ),
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
  };
});

import { systemLogsRouter } from '../routes/admin-management/system-logs';

const ROW = {
  id: 'sys-1',
  tenant_id: 'tenant-a',
  source: 'authrim/account_webhook_outbox',
  event_type: 'webhook.outbox.dropped',
  event_category: 'audit',
  result: 'success',
  severity: 'warn',
  error_code: null,
  target_type: 'account_webhook_outbox',
  target_id: 'tenant-a',
  request_id: null,
  details_json: '{"dropped":3,"reason":"capability_disabled"}',
  created_at: 1_800_000_000_000,
  retention_until: 1_807_776_000_000,
};
const READ = 'admin:system_logs:read';
const coverage = { consistency: 'eventual', pending_deliveries: 0, complete: false };

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/admin/system-logs', systemLogsRouter);
  return app;
}
const request = (path: string, permissions = READ) =>
  createApp().request(path, { method: 'GET', headers: { 'X-Admin-Permissions': permissions } }, {});

describe('system logs router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateLogReadAdapter.mockReturnValue({
      adapter: mockAdapter,
      hasArchive: () => true,
      pagination: () => ({ mode: 'cursor', limit: 50, has_more: false, next_cursor: null }),
      coverage: () => coverage,
    });
    mockAdapter.query.mockResolvedValue([ROW]);
    mockAdapter.queryOne.mockResolvedValue(ROW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses the list and the entry without admin:system_logs:read', async () => {
    expect((await request('/api/admin/system-logs', 'admin:audit:read')).status).toBe(403);
    expect(
      (await request('/api/admin/system-logs/sys-1', 'admin:operational_logs:read')).status
    ).toBe(403);
    expect(mockCreateLogReadAdapter).not.toHaveBeenCalled();
  });

  it('accepts the wildcard the tenant administrator carries', async () => {
    expect((await request('/api/admin/system-logs', 'admin:system_logs:*')).status).toBe(200);
  });

  it('lists the tenant entries from runtime.system_events, newest first, with parsed details', async () => {
    const res = await request(
      '/api/admin/system-logs?source=authrim/account_webhook_outbox&severity=warn&start_date=2027-01-01T00:00:00Z&end_date=2027-01-31'
    );
    expect(res.status).toBe(200);
    expect(mockCreateLogReadAdapter.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-a',
      dataset: 'runtime.system_events',
      page: { limit: 50 },
    });
    const [sql, bindings] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM system_events');
    expect(sql).toContain('ORDER BY created_at DESC, id DESC');
    expect(sql).toMatch(
      /tenant_id = \? AND source = \? AND severity = \? AND created_at >= \? AND created_at <= \?/
    );
    expect(bindings).toEqual([
      'tenant-a',
      'authrim/account_webhook_outbox',
      'warn',
      Date.parse('2027-01-01T00:00:00Z'),
      Date.parse('2027-01-31') + 24 * 60 * 60 * 1000 - 1,
      50,
    ]);
    const body = await res.json<{
      items: Array<Record<string, unknown>>;
      pagination: unknown;
      coverage: unknown;
    }>();
    expect(body.coverage).toEqual(coverage);
    expect(body.pagination).toEqual({
      mode: 'cursor',
      limit: 50,
      has_more: false,
      next_cursor: null,
    });
    expect(body.items).toEqual([
      {
        id: 'sys-1',
        tenant_id: 'tenant-a',
        source: 'authrim/account_webhook_outbox',
        event_type: 'webhook.outbox.dropped',
        event_category: 'audit',
        result: 'success',
        severity: 'warn',
        error_code: null,
        target_type: 'account_webhook_outbox',
        target_id: 'tenant-a',
        request_id: null,
        details: { dropped: 3, reason: 'capability_disabled' },
        created_at: 1_800_000_000_000,
        retention_until: 1_807_776_000_000,
      },
    ]);
  });

  it('clamps the limit and refuses unknown filter values and a reversed period', async () => {
    await request('/api/admin/system-logs?limit=500');
    expect((mockAdapter.query.mock.calls[0] as [string, unknown[]])[1]).toEqual(['tenant-a', 100]);
    expect((await request('/api/admin/system-logs?severity=loud')).status).toBe(400);
    expect((await request('/api/admin/system-logs?result=maybe')).status).toBe(400);
    expect(
      (await request('/api/admin/system-logs?source=' + encodeURIComponent('a b'))).status
    ).toBe(400);
    expect(
      (await request('/api/admin/system-logs?start_date=2027-02-01&end_date=2027-01-01')).status
    ).toBe(400);
    expect((await request('/api/admin/system-logs?start_date=yesterday')).status).toBe(400);
    expect(mockAdapter.query).toHaveBeenCalledTimes(1);
  });

  it('answers 503 log_query_incomplete when the period could not be read in full', async () => {
    mockAdapter.query.mockRejectedValue(new LogQueryIncompleteError('maxFiles'));
    const res = await request('/api/admin/system-logs');
    expect(res.status).toBe(503);
    expect((await res.json<{ error: string }>()).error).toBe('log_query_incomplete');
  });

  it('returns one entry of the tenant, and 404 for another id', async () => {
    const res = await request('/api/admin/system-logs/sys-1?event_at=1800000000000');
    expect(res.status).toBe(200);
    expect(mockCreateLogReadAdapter.mock.calls[0][0]).toMatchObject({
      dataset: 'runtime.system_events',
      window: { fromMs: 1_800_000_000_000 },
    });
    expect(mockAdapter.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('WHERE tenant_id = ? AND id = ?'),
      ['tenant-a', 'sys-1']
    );
    expect(await res.json()).toMatchObject({ id: 'sys-1', details: { dropped: 3 }, coverage });

    mockAdapter.queryOne.mockResolvedValue(null);
    expect((await request('/api/admin/system-logs/other')).status).toBe(404);
  });

  it('answers 503 for an entry when the archive read itself was incomplete', async () => {
    mockAdapter.queryOne.mockRejectedValue(new LogQueryIncompleteError('archive_unavailable'));
    expect((await request('/api/admin/system-logs/sys-1')).status).toBe(503);
  });

  it('returns only what the OpenAPI entry schema declares', async () => {
    const spec = parse(
      readFileSync(
        fileURLToPath(new URL('../../openapi/admin.openapi.yaml', import.meta.url)),
        'utf8'
      )
    ) as {
      components: {
        schemas: Record<
          string,
          { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean }
        >;
      };
    };
    const schema = spec.components.schemas.SystemLogEntry;
    expect(schema.additionalProperties).toBe(false);
    const entry = await (
      await request('/api/admin/system-logs/sys-1')
    ).json<Record<string, unknown>>();
    for (const key of Object.keys(entry)) expect(schema.properties).toHaveProperty(key);
    for (const key of schema.required) expect(entry).toHaveProperty(key);
    const list = await (
      await request('/api/admin/system-logs')
    ).json<{
      items: Array<Record<string, unknown>>;
    }>();
    for (const key of Object.keys(list.items[0])) expect(schema.properties).toHaveProperty(key);
  });
});
