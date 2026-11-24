/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- admin API response bodies are untyped JSON in these route tests */
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

import { ADMIN_PERMISSIONS, AR_ERROR_CODES } from '@authrim/ar-lib-core';
import { decodeLoggingCursor, encodeLoggingCursor } from '@authrim/ar-lib-logging/delivery';
import { deriveTenantKeyFromTenantId } from '@authrim/ar-lib-logging/contract';
import { envFixture, mockAdapter, resetFakes } from './logging-control-b-harness';
import { POLICIES, call, createApp, createPlatformApp } from './logging-control-b-app';
import { must } from './helpers/must';

const EVENTS = `${POLICIES}/delivery-events`;
const SUMMARY = `${POLICIES}/delivery-summary`;
const SECRET = 'test-logging-cursor-secret';

function eventRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `evt_${count - index}`,
    created_at: 5000 - index,
  }));
}

describe('delivery-events (mutation coverage, part B)', () => {
  beforeEach(() => resetFakes());

  it('rejects callers without the delivery-events read permission', async () => {
    const res = await call(createApp([ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ]), 'GET', EVENTS);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    expect(mockAdapter.query).not.toHaveBeenCalled();
  });

  it('refuses a tenant admin asking for another tenant', async () => {
    const res = await call(
      createApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ]),
      'GET',
      `${EVENTS}?tenant_id=tenant-b`
    );
    expect(res.status).toBe(403);
    expect(res.body.details.permission).toEqual({
      required_scope: 'current_tenant',
      reason: 'tenant_id_scope_mismatch',
    });
    expect(mockAdapter.query).not.toHaveBeenCalled();
  });

  it('applies every filter and the time window in order, with limit+1 as the last param', async () => {
    const res = await call(
      createPlatformApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ]),
      'GET',
      `${EVENTS}?tenant_key=tk_1&lane=critical&status=failed&time_start=100&time_end=900&limit=7`
    );
    expect(res.status).toBe(200);
    const [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      'WHERE tenant_key = ? AND lane = ? AND status = ? AND created_at >= ? AND created_at <= ?'
    );
    expect(sql).toContain('ORDER BY created_at DESC, id DESC');
    expect(params).toEqual(['tk_1', 'critical', 'failed', 100, 900, 8]);
    expect(res.body.page).toEqual({
      next_cursor: null,
      has_more: false,
      limit: 7,
      time_start: 100,
      time_end: 900,
    });
  });

  it('uses the filter[...] aliases and omits WHERE and time bounds when nothing is filtered', async () => {
    const aliased = await call(
      createPlatformApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ]),
      'GET',
      `${EVENTS}?filter[tenant_key]=tk_2&filter[lane]=bulk&filter[status]=sent`
    );
    expect(aliased.status).toBe(200);
    expect(mockAdapter.query.mock.calls[0][1]).toEqual(['tk_2', 'bulk', 'sent', 51]);
    expect(aliased.body.page).not.toHaveProperty('time_start');
    expect(aliased.body.page).not.toHaveProperty('time_end');

    mockAdapter.query.mockClear();
    const bare = await call(
      createPlatformApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ]),
      'GET',
      EVENTS
    );
    expect(bare.status).toBe(200);
    const [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain('WHERE');
    expect(params).toEqual([51]);
  });

  it('scopes a tenant admin to the tenant key derived for its own tenant', async () => {
    await call(createApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ]), 'GET', EVENTS);
    expect(mockAdapter.query.mock.calls[0][1]).toEqual([
      await deriveTenantKeyFromTenantId('tenant-a', undefined),
      51,
    ]);
  });

  it('pages with a signed cursor that is bound to the filters', async () => {
    const app = createPlatformApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ]);
    mockAdapter.query.mockResolvedValueOnce(eventRows(3));
    const first = await call(app, 'GET', `${EVENTS}?lane=critical&limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.page.has_more).toBe(true);
    const cursor = first.body.page.next_cursor as string;
    expect(cursor).toEqual(expect.any(String));
    const decoded = await decodeLoggingCursor(cursor, SECRET);
    expect(decoded.payload?.sort).toEqual({ created_at: 4999, id: 'evt_2' });
    expect(decoded.payload?.direction).toBe('next');

    mockAdapter.query.mockClear();
    const second = await call(
      app,
      'GET',
      `${EVENTS}?lane=critical&limit=2&cursor=${encodeURIComponent(cursor)}`
    );
    expect(second.status).toBe(200);
    const [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('lane = ? AND (created_at < ? OR (created_at = ? AND id < ?))');
    expect(params).toEqual(['critical', 4999, 4999, 'evt_2', 3]);

    const mismatch = await call(
      app,
      'GET',
      `${EVENTS}?lane=bulk&limit=2&cursor=${encodeURIComponent(cursor)}`
    );
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.details.fields).toEqual([
      {
        path: 'cursor',
        code: 'filter_mismatch',
        message: 'Cursor does not match the current filters.',
      },
    ]);
  });

  it('does not issue a next cursor without a signing secret and rejects cursors then', async () => {
    const app = createPlatformApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ]);
    const saved = envFixture.LOGGING_CURSOR_HMAC_SECRET;
    try {
      (envFixture as { LOGGING_CURSOR_HMAC_SECRET?: string }).LOGGING_CURSOR_HMAC_SECRET =
        undefined;
      mockAdapter.query.mockResolvedValueOnce(eventRows(3));
      const noSecretPage = await call(app, 'GET', `${EVENTS}?limit=2`);
      expect(noSecretPage.status).toBe(200);
      expect(noSecretPage.body.page).toMatchObject({ has_more: true, next_cursor: null });

      const withCursor = await call(app, 'GET', `${EVENTS}?cursor=abc`);
      expect(withCursor.status).toBe(400);
      expect(withCursor.body.details.fields).toEqual([
        {
          path: 'cursor',
          code: 'cursor_secret_unavailable',
          message: 'Cursor signing secret is not configured.',
        },
      ]);
    } finally {
      envFixture.LOGGING_CURSOR_HMAC_SECRET = saved;
    }
  });

  it('rejects malformed cursors, wrong directions and unsortable cursors', async () => {
    const app = createPlatformApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ]);
    const garbage = await call(app, 'GET', `${EVENTS}?cursor=not-a-cursor`);
    expect(garbage.status).toBe(400);
    expect(garbage.body.details.fields).toHaveLength(1);
    expect(garbage.body.details.fields[0]).toMatchObject({
      path: 'cursor',
      message: 'Cursor is invalid or expired.',
    });
    expect(garbage.body.details.fields[0].code).not.toBe('filter_mismatch');

    // Learn the filter hash of the unfiltered listing from a real cursor.
    mockAdapter.query.mockResolvedValueOnce(eventRows(2));
    const seed = await call(app, 'GET', `${EVENTS}?limit=1`);
    const seedPayload = must(
      (await decodeLoggingCursor(seed.body.page.next_cursor, SECRET)).payload
    );

    const badSort = await encodeLoggingCursor(
      { ...seedPayload, sort: { created_at: 'nan', id: 'x' } },
      SECRET
    );
    const badSortRes = await call(
      app,
      'GET',
      `${EVENTS}?limit=1&cursor=${encodeURIComponent(badSort)}`
    );
    expect(badSortRes.status).toBe(400);
    expect(badSortRes.body.details.fields).toEqual([
      { path: 'cursor', code: 'invalid_sort', message: 'Cursor sort key is invalid.' },
    ]);

    const noId = await encodeLoggingCursor({ ...seedPayload, sort: { created_at: 10 } }, SECRET);
    const noIdRes = await call(app, 'GET', `${EVENTS}?limit=1&cursor=${encodeURIComponent(noId)}`);
    expect(noIdRes.body.details.fields[0].code).toBe('invalid_sort');
  });

  it('answers 500 when the query fails', async () => {
    mockAdapter.query.mockRejectedValueOnce(new Error('boom'));
    const res = await call(
      createPlatformApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ]),
      'GET',
      EVENTS
    );
    expect(res.status).toBe(500);
    expect(res.body.error).toBe(AR_ERROR_CODES.INTERNAL_ERROR);
  });
});

describe('delivery-summary (mutation coverage, part B)', () => {
  beforeEach(() => resetFakes());

  it('requires overview or delivery-events read', async () => {
    const denied = await call(createApp([]), 'GET', SUMMARY);
    expect(denied.status).toBe(403);
    for (const permission of [
      ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ,
      ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
    ]) {
      expect((await call(createApp([permission]), 'GET', SUMMARY)).status).toBe(200);
    }
  });

  it('refuses a tenant key outside the caller tenant', async () => {
    const res = await call(
      createApp([ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ]),
      'GET',
      `${SUMMARY}?tenant_key=someone-else`
    );
    expect(res.status).toBe(403);
    expect(res.body.details.permission.reason).toBe('tenant_key_scope_mismatch');
  });

  it('applies window, tenant key, lane and status filters and echoes the window', async () => {
    mockAdapter.query.mockResolvedValueOnce([{ lane: 'critical', status: 'sent' }]);
    const res = await call(
      createPlatformApp([ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ]),
      'GET',
      `${SUMMARY}?time_start=100&time_end=900&tenant_key=tk_1&lane=critical&status=sent&limit=9`
    );
    expect(res.status).toBe(200);
    const [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      'WHERE bucket_start_at >= ? AND bucket_start_at <= ? AND tenant_key = ? AND lane = ? AND status = ?'
    );
    expect(params).toEqual([100, 900, 'tk_1', 'critical', 'sent', 9]);
    expect(res.body.item).toEqual({
      window_start_at: 100,
      window_end_at: 900,
      items: [{ lane: 'critical', status: 'sent' }],
    });
  });

  it('defaults the window to the last 24 hours and the limit to 100 (capped at 500)', async () => {
    const before = Date.now();
    const res = await call(
      createPlatformApp([ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ]),
      'GET',
      SUMMARY
    );
    const after = Date.now();
    const [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE bucket_start_at >= ?\n');
    expect(params).toHaveLength(2);
    expect(params[0] as number).toBeGreaterThanOrEqual(before - 24 * 3600 * 1000);
    expect(params[0] as number).toBeLessThanOrEqual(after - 24 * 3600 * 1000);
    expect(params[1]).toBe(100);
    expect(res.body.item.window_end_at).toBeNull();

    mockAdapter.query.mockClear();
    await call(
      createPlatformApp([ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ]),
      'GET',
      `${SUMMARY}?limit=9999`
    );
    expect(mockAdapter.query.mock.calls[0][1].at(-1)).toBe(500);
  });

  it('answers 500 when the query fails', async () => {
    mockAdapter.query.mockRejectedValueOnce(new Error('boom'));
    const res = await call(
      createPlatformApp([ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ]),
      'GET',
      SUMMARY
    );
    expect(res.status).toBe(500);
  });
});
