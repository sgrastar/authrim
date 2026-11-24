/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- admin API response bodies are untyped JSON in these route tests */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { auditWrite, mockAdapter, resetFakes, stepUpFakes } from './logging-control-b-harness';
import {
  NOTIFICATIONS,
  POLICIES,
  call,
  createApp,
  createPlatformApp,
} from './logging-control-b-app';
import { must } from './helpers/must';

const READ = [ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ];
const PLATFORM_UPDATE = ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE;
const NOW = Date.UTC(2026, 2, 5, 10, 20, 30, 123);
const NOW_ISO = new Date(NOW).toISOString();
const LOGGING_CATEGORIES = `category IN (
      'logging_destination_health',
      'logging_delivery_failure',
      'logging_fallback_used',
      'logging_dlq_backlog'
    )`;

beforeEach(() => {
  resetFakes();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('logging-policies/notifications', () => {
  const list = `${POLICIES}/notifications`;

  it('requires overview or delivery-events read and tenant scope', async () => {
    expect((await call(createApp([]), 'GET', list)).status).toBe(403);
    const mismatch = await call(createApp(READ), 'GET', `${list}?tenant_id=tenant-b`);
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.details.permission.reason).toBe('tenant_scope_mismatch');
  });

  it('lists unresolved logging notifications of the caller tenant by default', async () => {
    mockAdapter.query.mockResolvedValue([{ id: 'ine_1' }]);
    const res = await call(createApp(READ), 'GET', list);
    expect(res.body).toEqual({ items: [{ id: 'ine_1' }], total: 1 });
    const [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      `WHERE ${LOGGING_CATEGORIES} AND tenant_id = ? AND status IN ('pending', 'failed', 'dead_letter')\n`
    );
    expect(sql).toContain("WHEN 'critical' THEN 0");
    expect(params).toEqual(['tenant-a', 25]);
  });

  it('applies explicit status, severity and time filters and clamps the limit', async () => {
    await call(
      createPlatformApp(READ),
      'GET',
      `${list}?filter[status]=delivered&filter[severity]=high&time_start=1000&time_end=2000&limit=500&tenant_id=tenant-z`
    );
    const [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      'tenant_id = ? AND status = ? AND severity = ? AND created_at >= ? AND created_at <= ?'
    );
    expect(sql).not.toContain("status IN ('pending'");
    expect(params).toEqual([
      'tenant-z',
      'delivered',
      'high',
      new Date(1000).toISOString(),
      new Date(2000).toISOString(),
      100,
    ]);
    mockAdapter.query.mockClear();
    await call(createPlatformApp(READ), 'GET', list);
    expect(mockAdapter.query.mock.calls[0][1]).toEqual([25]);
  });

  it('answers 500 when the query fails', async () => {
    mockAdapter.query.mockRejectedValue(new Error('x'));
    expect((await call(createApp(READ), 'GET', list)).status).toBe(500);
  });
});

describe('notification resolve (logging-policies and notification center)', () => {
  const routes = [
    {
      name: 'logging-policies',
      path: `${POLICIES}/notifications/ine_1/resolve`,
      permission: READ,
      action: 'logging_notification.resolve',
      category: 'logging_dlq_backlog',
    },
    {
      name: 'notification center',
      path: `${NOTIFICATIONS}/ine_1/resolve`,
      permission: [ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_LIST],
      action: 'internal_notification.resolve',
      category: 'control_plane_drift',
    },
  ];
  const row = (overrides: Record<string, unknown>) => ({
    id: 'ine_1',
    tenant_id: 'tenant-a',
    category: 'logging_dlq_backlog',
    event_type: 'backlog',
    severity: 'medium',
    status: 'pending',
    ...overrides,
  });

  for (const route of routes) {
    describe(route.name, () => {
      it('requires a read permission', async () => {
        const res = await call(
          createApp([ADMIN_PERMISSIONS.LOGGING_SNAPSHOTS_PUBLISH]),
          'POST',
          route.path,
          {}
        );
        expect(res.status).toBe(403);
        expect(mockAdapter.queryOne).not.toHaveBeenCalled();
      });

      it('answers 404 for an unknown event and refuses another tenant', async () => {
        const missing = await call(createApp(route.permission), 'POST', route.path, {});
        expect(missing.status).toBe(404);
        expect(mockAdapter.queryOne.mock.calls[0][1][0]).toBe('ine_1');
        mockAdapter.queryOne.mockResolvedValue(row({ tenant_id: 'tenant-b' }));
        const foreign = await call(createApp(route.permission), 'POST', route.path, {});
        expect(foreign.status).toBe(403);
        expect(foreign.body.error).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
        expect(mockAdapter.execute).not.toHaveBeenCalled();
      });

      it('only resolves pending, failed or dead-letter events', async () => {
        for (const status of ['delivered', 'suppressed']) {
          mockAdapter.queryOne.mockResolvedValue(row({ status }));
          const res = await call(createApp(route.permission), 'POST', route.path, {});
          expect(res.status).toBe(400);
          expect(res.body.details.fields).toEqual([
            {
              path: 'status',
              code: 'invalid_state',
              message: 'Only unresolved notifications can be resolved.',
            },
          ]);
        }
        expect(mockAdapter.execute).not.toHaveBeenCalled();
      });

      it('suppresses the event and audits severity by event severity', async () => {
        for (const [status, severity, auditSeverity] of [
          ['pending', 'high', 'warn'],
          ['failed', 'critical', 'warn'],
          ['dead_letter', 'low', 'info'],
        ] as const) {
          mockAdapter.execute.mockClear();
          auditWrite.mockClear();
          mockAdapter.queryOne.mockResolvedValue(
            row({ status, severity, category: route.category })
          );
          const res = await call(createApp(route.permission), 'POST', route.path, {});
          expect(res.status).toBe(200);
          expect(res.body.result).toEqual({
            id: 'ine_1',
            status: 'suppressed',
            updated_at: NOW_ISO,
          });
          expect(res.body.audit_id).toBe('audit-id-1');
          const update = must(
            mockAdapter.execute.mock.calls.find(([sql]) =>
              String(sql).includes('UPDATE internal_notification_events')
            )
          );
          expect(update[0]).toContain("SET status = 'suppressed'");
          expect(update[1]).toEqual([NOW_ISO, 'ine_1']);
          expect(auditWrite).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
              action: route.action,
              resourceType: 'internal_notification_event',
              resourceId: 'ine_1',
              result: 'success',
              severity: auditSeverity,
              metadata: {
                tenant_id: 'tenant-a',
                category: route.category,
                event_type: 'backlog',
                previous_status: status,
                next_status: 'suppressed',
              },
            })
          );
        }
      });

      it('still resolves when clearing the admin notice fails, and answers 500 on update failure', async () => {
        mockAdapter.queryOne.mockResolvedValue(row({}));
        mockAdapter.execute.mockImplementation(async (sql: string) => {
          if (!String(sql).includes('UPDATE internal_notification_events'))
            throw new Error('notice');
          return { rowsAffected: 1 };
        });
        expect((await call(createApp(route.permission), 'POST', route.path, {})).status).toBe(200);
        mockAdapter.execute.mockRejectedValue(new Error('x'));
        expect((await call(createApp(route.permission), 'POST', route.path, {})).status).toBe(500);
      });
    });
  }

  it('looks the logging event up by id restricted to logging categories', async () => {
    await call(createApp(READ), 'POST', routes[0].path, {});
    expect(mockAdapter.queryOne.mock.calls[0][0]).toContain("'logging_dlq_backlog'");
    expect(mockAdapter.queryOne.mock.calls[0][1]).toEqual(['ine_1']);
  });

  it('looks the center event up by id restricted to center categories', async () => {
    await call(createApp(routes[1].permission), 'POST', routes[1].path, {});
    const [sql, params] = mockAdapter.queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('category IN (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    expect(params).toHaveLength(13);
    expect(params.slice(0, 3)).toEqual([
      'ine_1',
      'storage_registry_security',
      'storage_registry_health',
    ]);
    expect(params.at(-1)).toBe('notification_delivery_failure');
  });
});

describe('notification center listing', () => {
  const path = NOTIFICATIONS;
  const center = [ADMIN_PERMISSIONS.DATABASE_ROUTING_READ];

  function arrangeList() {
    mockAdapter.query.mockImplementation(async (sql: string) =>
      String(sql).includes('GROUP BY') ? [{ category: 'c', count: 2 }] : [{ id: 'ine_1' }]
    );
    mockAdapter.queryOne.mockResolvedValue({ total: '42' });
  }

  it('requires a notification-center read permission and tenant scope', async () => {
    expect(
      (await call(createApp([ADMIN_PERMISSIONS.LOGGING_SNAPSHOTS_PUBLISH]), 'GET', path)).status
    ).toBe(403);
    expect((await call(createApp(center), 'GET', `${path}?tenant_id=tenant-b`)).status).toBe(403);
  });

  it('reports every unsupported filter at once', async () => {
    const res = await call(
      createApp(center),
      'GET',
      `${path}?category=bogus,logging_dlq_backlog&status=weird&severity=urgent`
    );
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual([
      {
        path: 'category',
        code: 'invalid_value',
        message: 'Notification category is not supported.',
      },
      { path: 'status', code: 'invalid_value', message: 'Notification status is not supported.' },
      {
        path: 'severity',
        code: 'invalid_value',
        message: 'Notification severity is not supported.',
      },
    ]);
    expect(mockAdapter.query).not.toHaveBeenCalled();
  });

  it('lists unresolved events across all categories by default with a summary and total', async () => {
    arrangeList();
    const res = await call(createApp(center), 'GET', path);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([{ id: 'ine_1' }]);
    expect(res.body.total).toBe(42);
    expect(res.body.page.summary).toEqual([{ category: 'c', count: 2 }]);
    expect(res.body.page.filters).toEqual({
      tenant_id: 'tenant-a',
      categories: expect.arrayContaining([
        'storage_registry_security',
        'notification_delivery_failure',
      ]),
      status: 'unresolved',
      severity: null,
      time_start: null,
      time_end: null,
    });
    expect(res.body.page.filters.categories).toHaveLength(12);
    const calls = mockAdapter.query.mock.calls as Array<[string, unknown[]]>;
    const listCall = must(calls.find(([sql]) => !sql.includes('GROUP BY')));
    const summaryCall = must(calls.find(([sql]) => sql.includes('GROUP BY')));
    expect(listCall[0]).toContain(
      'WHERE category IN (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) AND tenant_id = ? AND status IN (?, ?, ?)'
    );
    expect(listCall[1]).toHaveLength(12 + 1 + 3 + 1);
    expect(listCall[1].slice(-5)).toEqual(['tenant-a', 'pending', 'failed', 'dead_letter', 50]);
    expect(summaryCall[1]).toHaveLength(16);
    expect(summaryCall[0]).toContain('GROUP BY category, severity, status');
    expect(mockAdapter.queryOne.mock.calls[0][0]).toContain('SELECT COUNT(*) AS total');
    expect(mockAdapter.queryOne.mock.calls[0][1]).toHaveLength(16);
  });

  it('applies csv categories (deduplicated), exact status, severity and time bounds', async () => {
    arrangeList();
    const res = await call(
      createPlatformApp(center),
      'GET',
      `${path}?filter[category]=logging_dlq_backlog, control_plane_drift,logging_dlq_backlog&filter[status]=delivered&filter[severity]=info&time_start=1000&time_end=2000&limit=999&tenant_id=tenant-z`
    );
    expect(res.status).toBe(200);
    const listCall = must(
      (mockAdapter.query.mock.calls as Array<[string, unknown[]]>).find(
        ([sql]) => !sql.includes('GROUP BY')
      )
    );
    expect(listCall[0]).toContain(
      'WHERE category IN (?, ?) AND tenant_id = ? AND status = ? AND severity = ? AND created_at >= ? AND created_at <= ?'
    );
    expect(listCall[1]).toEqual([
      'logging_dlq_backlog',
      'control_plane_drift',
      'tenant-z',
      'delivered',
      'info',
      new Date(1000).toISOString(),
      new Date(2000).toISOString(),
      200,
    ]);
    expect(res.body.page.filters).toEqual({
      tenant_id: 'tenant-z',
      categories: ['logging_dlq_backlog', 'control_plane_drift'],
      status: 'delivered',
      severity: 'info',
      time_start: 1000,
      time_end: 2000,
    });
  });

  it('skips the status condition for status=all and falls back to the row count for the total', async () => {
    mockAdapter.query.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    mockAdapter.queryOne.mockResolvedValue(null);
    const res = await call(createPlatformApp(center), 'GET', `${path}?status=all`);
    expect(res.body.total).toBe(2);
    const listCall = mockAdapter.query.mock.calls[0] as [string, unknown[]];
    expect(listCall[0]).not.toContain('status IN');
    expect(listCall[0]).not.toContain('status = ?');
    expect(listCall[0]).not.toContain('tenant_id = ?');
    expect(res.body.page.filters.tenant_id).toBeNull();
  });

  it('answers 500 when a query fails', async () => {
    mockAdapter.query.mockRejectedValue(new Error('x'));
    expect((await call(createApp(center), 'GET', path)).status).toBe(500);
  });
});

describe('notification delivery routes', () => {
  const routesPath = `${NOTIFICATIONS}/delivery-routes`;
  const center = [ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_LIST];

  it('lists routes scoped to the caller tenant unless platform', async () => {
    expect((await call(createApp([]), 'GET', routesPath)).status).toBe(403);
    mockAdapter.query.mockResolvedValue([{ id: 'indr_1' }]);
    const tenant = await call(createApp(center), 'GET', routesPath);
    expect(tenant.body).toEqual({ items: [{ id: 'indr_1' }], total: 1 });
    let [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE (scope_type = ? AND scope_id = ?)');
    expect(sql).toContain('ORDER BY scope_type ASC, scope_id ASC, name ASC');
    expect(params).toEqual(['tenant', 'tenant-a', 100]);
    mockAdapter.query.mockClear();
    await call(createPlatformApp(center), 'GET', `${routesPath}?limit=900`);
    [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain('WHERE');
    expect(params).toEqual([500]);
    mockAdapter.query.mockRejectedValue(new Error('x'));
    expect((await call(createApp(center), 'GET', routesPath)).status).toBe(500);
  });

  it('validates the route body', async () => {
    const app = createPlatformApp([PLATFORM_UPDATE]);
    expect((await call(createApp(center), 'POST', routesPath, {})).status).toBe(403);
    const res = await call(app, 'POST', routesPath, {
      name: '  ',
      provider: 'carrier-pigeon',
      max_attempts: 51,
      retry_after_seconds: -1,
    });
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual([
      { path: 'name', code: 'required', message: 'Route name is required.' },
      {
        path: 'provider',
        code: 'invalid_value',
        message: 'Notification provider is not supported.',
      },
      { path: 'max_attempts', code: 'invalid_value', message: 'Max attempts must be 1-50.' },
      {
        path: 'retry_after_seconds',
        code: 'invalid_value',
        message: 'Retry delay must be zero or greater.',
      },
    ]);
    const zero = await call(app, 'POST', routesPath, {
      name: 'n',
      provider: 'webhook',
      max_attempts: 0,
    });
    expect(zero.body.details.fields.map((f: { path: string }) => f.path)).toEqual(['max_attempts']);
    const fifty = await call(app, 'POST', routesPath, {
      name: 'n',
      provider: 'webhook',
      max_attempts: 50,
      retry_after_seconds: 0,
    });
    expect(fifty.status).toBe(201);
  });

  it('keeps the platform scope behind platform authority and the tenant scope in its tenant', async () => {
    const notGlobal = await call(
      createApp([PLATFORM_UPDATE], ['ar_super_admin'], false),
      'POST',
      routesPath,
      { name: 'n', provider: 'webhook' }
    );
    expect(notGlobal.status).toBe(403);
    expect(notGlobal.body.details.permission.reason).toBe('platform_authority_required');
    const foreign = await call(createApp([PLATFORM_UPDATE]), 'POST', routesPath, {
      name: 'n',
      provider: 'webhook',
      scope_type: 'tenant',
      scope_id: 'tenant-b',
    });
    expect(foreign.status).toBe(403);
    expect(foreign.body.details.permission.reason).toBe('tenant_scope_mismatch');
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('binds the route destination into step-up, then inserts the route', async () => {
    mockAdapter.queryOne.mockResolvedValue({
      provider_config: JSON.stringify({ url: 'https://hooks.example.com/a' }),
    });
    const res = await call(createApp([PLATFORM_UPDATE]), 'POST', routesPath, {
      name: ' Ops ',
      scope_type: 'tenant',
      provider: 'slack',
      destination_id: 'dest_1',
      categories: ['b', 'a', 'a', ' '],
      severities: ['high'],
      min_severity: 'low',
      enabled: false,
      failure_policy: 'retry_until_dead_letter',
      max_attempts: '7',
      retry_after_seconds: '30',
      suppression_key: 'sk',
    });
    expect(res.status).toBe(201);
    expect(res.body.item).toEqual({
      id: expect.stringMatching(/^indr_/),
      version: 1,
      created_at: NOW,
    });
    expect(mockAdapter.queryOne.mock.calls[0]).toEqual([
      'SELECT provider_config FROM admin_destinations WHERE id = ? AND deleted_at IS NULL',
      ['dest_1'],
    ]);
    const stepUp = stepUpFakes.requireAdminStepUp.mock.calls[0][1];
    expect(stepUp).toMatchObject({
      operation: 'webhook.destination.update',
      targetTenantId: 'tenant-a',
      params: {
        kind: 'notification.delivery_route.create',
        scope_type: 'tenant',
        scope_id: 'tenant-a',
        provider: 'slack',
        destination_id: 'dest_1',
        destination_url_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        categories: ['a', 'b'],
        severities: ['high'],
        min_severity: 'low',
        enabled: false,
        failure_policy: 'retry_until_dead_letter',
      },
    });
    expect(mockAdapter.execute.mock.calls[0][1]).toEqual([
      res.body.item.id,
      'Ops',
      'tenant',
      'tenant-a',
      'slack',
      'dest_1',
      JSON.stringify(['b', 'a']),
      JSON.stringify(['high']),
      'low',
      0,
      'retry_until_dead_letter',
      7,
      30,
      'sk',
      'admin-1',
      'admin-1',
      NOW,
      NOW,
    ]);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'internal_notification.delivery_route.create',
        resourceType: 'internal_notification_delivery_route',
        resourceId: res.body.item.id,
        severity: 'info',
      })
    );
  });

  it('uses defaults, the platform tenant for step-up, and returns a step-up refusal as is', async () => {
    const res = await call(createPlatformApp([PLATFORM_UPDATE]), 'POST', routesPath, {
      name: 'n',
      provider: 'email',
    });
    expect(res.status).toBe(201);
    expect(mockAdapter.queryOne).not.toHaveBeenCalled();
    expect(stepUpFakes.requireAdminStepUp.mock.calls[0][1]).toMatchObject({
      targetTenantId: 'tenant-a',
      params: {
        scope_type: 'platform',
        scope_id: 'global',
        destination_id: null,
        destination_url_sha256: null,
        categories: null,
        severities: null,
        min_severity: 'medium',
        enabled: true,
        failure_policy: 'retry_until_dead_letter',
      },
    });
    const params = mockAdapter.execute.mock.calls[0][1] as unknown[];
    expect(params.slice(6, 14)).toEqual([
      null,
      null,
      'medium',
      1,
      'retry_until_dead_letter',
      5,
      300,
      null,
    ]);

    mockAdapter.execute.mockClear();
    stepUpFakes.requireAdminStepUp.mockResolvedValueOnce(new Response('stepup', { status: 401 }));
    const refused = await call(createPlatformApp([PLATFORM_UPDATE]), 'POST', routesPath, {
      name: 'n',
      provider: 'email',
    });
    expect(refused.status).toBe(401);
    expect(refused.body.raw).toBe('stepup');
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('hashes no url when the destination config has none and answers 500 on insert failure', async () => {
    mockAdapter.queryOne.mockResolvedValue({ provider_config: '{}' });
    await call(createPlatformApp([PLATFORM_UPDATE]), 'POST', routesPath, {
      name: 'n',
      provider: 'webhook',
      destination_id: 'dest_1',
    });
    expect(
      stepUpFakes.requireAdminStepUp.mock.calls[0][1].params.destination_url_sha256
    ).toBeNull();
    mockAdapter.execute.mockRejectedValue(new Error('x'));
    expect(
      (
        await call(createPlatformApp([PLATFORM_UPDATE]), 'POST', routesPath, {
          name: 'n',
          provider: 'webhook',
        })
      ).status
    ).toBe(500);
  });
});
