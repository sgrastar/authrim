/* eslint-disable @typescript-eslint/no-unsafe-member-access -- admin API response bodies are untyped JSON in these route tests */
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
import { auditWrite, mockAdapter, resetFakes } from './logging-control-b-harness';
import { NOTIFICATIONS, call, createApp, createPlatformApp } from './logging-control-b-app';
import { must } from './helpers/must';

const PLATFORM_UPDATE = ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE;
const NOW = Date.UTC(2026, 2, 5, 10, 20, 30, 123);
const NOW_ISO = new Date(NOW).toISOString();
const RUN = `${NOTIFICATIONS}/delivery/run`;
const DELIVER = `${NOTIFICATIONS}/ine_1/deliver`;

const fetchMock = vi.fn();

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ine_1',
    tenant_id: 'tenant-a',
    category: 'logging_dlq_backlog',
    event_type: 'logging.dlq.backlog',
    severity: 'high',
    status: 'pending',
    payload_json: JSON.stringify({ n: 1 }),
    attempts: '2',
    ...overrides,
  };
}

function routeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'indr_1',
    name: 'ops',
    scope_type: 'platform',
    scope_id: 'global',
    provider: 'webhook',
    destination_id: 'dest_1',
    categories_json: null,
    severities_json: null,
    min_severity: 'medium',
    enabled: 1,
    failure_policy: 'retry_until_dead_letter',
    max_attempts: 4,
    retry_after_seconds: '60',
    suppression_key: null,
    ...overrides,
  };
}

function destinationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dest_1',
    lifecycle_status: 'active',
    provider: 'http',
    provider_config: JSON.stringify({ url: 'https://hooks.example.com/notify' }),
    ...overrides,
  };
}

function arrange(input: {
  events?: Array<Record<string, unknown>>;
  event?: Record<string, unknown> | null;
  routes?: Array<Record<string, unknown>>;
  destination?: Record<string, unknown> | null;
}) {
  mockAdapter.query.mockImplementation(async (sql: string) =>
    String(sql).includes('FROM internal_notification_delivery_routes')
      ? (input.routes ?? [])
      : (input.events ?? [])
  );
  mockAdapter.queryOne.mockImplementation(async (sql: string) =>
    String(sql).includes('FROM admin_destinations')
      ? input.destination === undefined
        ? destinationRow()
        : input.destination
      : (input.event ?? null)
  );
}

const attemptInsert = () =>
  (
    mockAdapter.execute.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO internal_notification_delivery_attempts')
    ) as [string, unknown[]]
  )[1];
const eventUpdate = () =>
  mockAdapter.execute.mock.calls.find(([sql]) =>
    String(sql).includes('UPDATE internal_notification_events')
  ) as [string, unknown[]] | undefined;

beforeEach(() => {
  resetFakes();
  fetchMock.mockReset().mockResolvedValue(new Response('ok', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('notifications/delivery/run', () => {
  const app = () => createPlatformApp([PLATFORM_UPDATE]);

  it('requires the platform defaults permission and global platform authority', async () => {
    expect((await call(createApp([]), 'POST', RUN, {})).status).toBe(403);
    const res = await call(
      createApp([PLATFORM_UPDATE], ['ar_super_admin'], false),
      'POST',
      RUN,
      {}
    );
    expect(res.status).toBe(403);
    expect(res.body.details.permission.reason).toBe('platform_authority_required');
    expect(mockAdapter.query).not.toHaveBeenCalled();
  });

  it('bounds the batch size to 1-50 and defaults to 25', async () => {
    const cases: Array<[unknown, number]> = [
      [10, 10],
      [50, 50],
      [51, 50],
      [100, 50],
      [1, 1],
      [0, 25],
      [-3, 25],
      [1.5, 25],
      ['7', 25],
      [undefined, 25],
    ];
    for (const [limit, expected] of cases) {
      mockAdapter.query.mockClear();
      auditWrite.mockClear();
      arrange({});
      await call(app(), 'POST', RUN, { limit });
      const [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("WHERE status IN ('pending', 'failed')");
      expect(sql).toContain('next_attempt_at IS NULL OR next_attempt_at <= ?');
      expect(params).toEqual([NOW_ISO, expected]);
      expect(auditWrite).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ metadata: { requested_limit: expected, processed: 0 } })
      );
    }
    const second = mockAdapter.query.mock.calls[1] as [string];
    expect(second[0]).toContain('WHERE enabled = 1');
    expect(second[0]).toContain('LIMIT 100');
  });

  it('skips events no route matches', async () => {
    arrange({
      events: [eventRow()],
      routes: [routeRow({ scope_type: 'tenant', scope_id: 'other' })],
    });
    const res = await call(app(), 'POST', RUN, {});
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({
      processed: 1,
      results: [{ event_id: 'ine_1', status: 'skipped', reason: 'no_matching_route' }],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'internal_notification.delivery.run',
        resourceType: 'internal_notification_event',
        resourceId: 'bulk-delivery',
        result: 'success',
        severity: 'info',
        metadata: { requested_limit: 25, processed: 1 },
      })
    );
  });

  it('delivers to every matching route over https and records each attempt', async () => {
    arrange({
      events: [eventRow(), eventRow({ id: 'ine_2', tenant_id: 'tenant-b', severity: 'low' })],
      routes: [routeRow(), routeRow({ id: 'indr_2', provider: 'slack' })],
    });
    const res = await call(app(), 'POST', RUN, {});
    expect(res.body.result.processed).toBe(3);
    expect(res.body.result.results).toEqual([
      { event_id: 'ine_1', route_id: 'indr_1', status: 'delivered', error_class: null },
      { event_id: 'ine_1', route_id: 'indr_2', status: 'delivered', error_class: null },
      { event_id: 'ine_2', status: 'skipped', reason: 'no_matching_route' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.example.com/notify');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      'x-authrim-notification': 'ine_1',
      'x-authrim-notification-route': 'indr_1',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      id: 'ine_1',
      tenant_id: 'tenant-a',
      category: 'logging_dlq_backlog',
      event_type: 'logging.dlq.backlog',
      severity: 'high',
      payload: { n: 1 },
    });
    expect(attemptInsert()).toEqual([
      expect.stringMatching(/^inda_/),
      'ine_1',
      'indr_1',
      'webhook',
      'dest_1',
      'delivered',
      3,
      200,
      null,
      null,
      null,
      null,
      NOW,
      NOW,
      NOW,
    ]);
    expect(eventUpdate()).toBeUndefined();
    expect(mockAdapter.queryOne.mock.calls[0][1]).toEqual(['dest_1']);
  });

  const failures: Array<{
    name: string;
    route?: Record<string, unknown>;
    destination?: Record<string, unknown> | null;
    fetch?: () => Promise<Response>;
    errorClass: string;
    message: string;
    responseStatus?: number;
  }> = [
    {
      name: 'no destination on the route',
      route: { destination_id: null },
      errorClass: 'notification_destination_required',
      message: 'notification_destination_required',
    },
    {
      name: 'destination not found',
      destination: null,
      errorClass: 'notification_destination_unavailable',
      message: 'notification_destination_unavailable',
    },
    {
      name: 'destination not active',
      destination: destinationRow({ lifecycle_status: 'disabled' }),
      errorClass: 'notification_destination_unavailable',
      message: 'notification_destination_unavailable',
    },
    {
      name: 'destination is not an http provider',
      destination: destinationRow({ provider: 'r2' }),
      errorClass: 'notification_provider_requires_http_destination',
      message: 'notification_provider_requires_http_destination',
    },
    {
      name: 'http destination without url',
      destination: destinationRow({ provider_config: '{}' }),
      errorClass: 'notification_provider_requires_http_destination',
      message: 'notification_provider_requires_http_destination',
    },
    {
      name: 'plain http url',
      destination: destinationRow({
        provider_config: JSON.stringify({ url: 'http://hooks.example.com/x' }),
      }),
      errorClass: 'notification_destination_url_invalid',
      message: 'notification_destination_url_invalid',
    },
    {
      name: 'internal address',
      destination: destinationRow({
        provider_config: JSON.stringify({ url: 'https://127.0.0.1/x' }),
      }),
      errorClass: 'notification_destination_url_invalid',
      message: 'notification_destination_url_invalid',
    },
    {
      name: 'http error response',
      fetch: async () => new Response('no', { status: 503 }),
      errorClass: 'notification_destination_http_503',
      message: 'notification_destination_http_503',
      responseStatus: 503,
    },
    {
      name: 'network error with detail',
      fetch: async () => {
        throw new Error('connect_failed: ECONNRESET');
      },
      errorClass: 'connect_failed',
      message: 'connect_failed: ECONNRESET',
    },
    {
      name: 'non-error rejection',
      fetch: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- a non-Error rejection is the case under test
        throw 'weird';
      },
      errorClass: 'notification_delivery_failed',
      message: 'notification_delivery_failed',
    },
  ];

  for (const failure of failures) {
    it(`records a failed attempt and schedules a retry: ${failure.name}`, async () => {
      arrange({
        events: [eventRow()],
        routes: [routeRow(failure.route)],
        destination: failure.destination,
      });
      if (failure.fetch) fetchMock.mockImplementation(failure.fetch);
      const res = await call(app(), 'POST', RUN, {});
      expect(res.status).toBe(200);
      expect(res.body.result.results).toEqual([
        {
          event_id: 'ine_1',
          route_id: 'indr_1',
          status: 'failed',
          error_class: failure.errorClass,
        },
      ]);
      expect(attemptInsert()).toEqual([
        expect.stringMatching(/^inda_/),
        'ine_1',
        'indr_1',
        'webhook',
        failure.route?.destination_id === null ? null : 'dest_1',
        'failed',
        3,
        failure.responseStatus ?? null,
        failure.errorClass,
        failure.message,
        NOW + 60_000,
        null,
        null,
        NOW,
        NOW,
      ]);
      const update = must(eventUpdate());
      expect(update[0]).toContain(
        "CASE WHEN attempts + 1 >= ? THEN 'dead_letter' ELSE 'failed' END"
      );
      expect(update[1]).toEqual([
        4,
        failure.message,
        new Date(NOW + 60_000).toISOString(),
        NOW_ISO,
        'ine_1',
      ]);
      expect(auditWrite).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ severity: 'warn' })
      );
    });
  }

  it('answers 500 when the event query fails', async () => {
    mockAdapter.query.mockRejectedValue(new Error('x'));
    expect((await call(app(), 'POST', RUN, {})).status).toBe(500);
  });
});

describe('notifications/:id/deliver', () => {
  it('requires the platform defaults permission', async () => {
    expect(
      (await call(createApp([ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ]), 'POST', DELIVER)).status
    ).toBe(403);
  });

  it('answers 404 for an unknown event and refuses another tenant for a non-platform caller', async () => {
    arrange({ event: null });
    const missing = await call(createApp([PLATFORM_UPDATE]), 'POST', DELIVER);
    expect(missing.status).toBe(404);
    expect(mockAdapter.queryOne.mock.calls[0][1]).toEqual(['ine_1']);
    arrange({ event: eventRow({ tenant_id: 'tenant-b' }) });
    const foreign = await call(createApp([PLATFORM_UPDATE]), 'POST', DELIVER);
    expect(foreign.status).toBe(403);
    expect(foreign.body.error).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    const platform = await call(createPlatformApp([PLATFORM_UPDATE]), 'POST', DELIVER);
    expect(platform.status).toBe(200);
  });

  it('delivers through each matching route and audits the manual delivery', async () => {
    arrange({ event: eventRow(), routes: [routeRow(), routeRow({ id: 'indr_2', enabled: '0' })] });
    const res = await call(createApp([PLATFORM_UPDATE]), 'POST', DELIVER);
    expect(res.body.result).toEqual({
      event_id: 'ine_1',
      route_count: 1,
      results: [{ route_id: 'indr_1', status: 'delivered', error_class: null }],
    });
    expect(res.body.audit_id).toBe('audit-id-1');
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'internal_notification.delivery.manual',
        resourceType: 'internal_notification_event',
        resourceId: 'ine_1',
        result: 'success',
        severity: 'info',
        metadata: { route_count: 1 },
      })
    );
  });

  it('reports failures with a warning audit and an empty result without routes', async () => {
    arrange({ event: eventRow(), routes: [routeRow()], destination: null });
    const failed = await call(createApp([PLATFORM_UPDATE]), 'POST', DELIVER);
    expect(failed.body.result.results[0]).toMatchObject({ status: 'failed' });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: 'warn' })
    );
    arrange({ event: eventRow(), routes: [] });
    auditWrite.mockClear();
    const none = await call(createApp([PLATFORM_UPDATE]), 'POST', DELIVER);
    expect(none.body.result).toEqual({ event_id: 'ine_1', route_count: 0, results: [] });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: 'info' })
    );
  });

  it('answers 500 when the lookup fails', async () => {
    mockAdapter.queryOne.mockRejectedValue(new Error('x'));
    expect((await call(createApp([PLATFORM_UPDATE]), 'POST', DELIVER)).status).toBe(500);
  });

  describe('route matching', () => {
    const matches = async (
      route: Record<string, unknown>,
      event: Record<string, unknown> = {}
    ): Promise<boolean> => {
      arrange({ event: eventRow(event), routes: [routeRow(route)] });
      const res = await call(createPlatformApp([PLATFORM_UPDATE]), 'POST', DELIVER);
      return res.body.result.route_count === 1;
    };

    it('requires the route to be enabled', async () => {
      expect(await matches({ enabled: 1 })).toBe(true);
      expect(await matches({ enabled: '1' })).toBe(true);
      expect(await matches({ enabled: 0 })).toBe(false);
      expect(await matches({ enabled: '0' })).toBe(false);
    });

    it('limits tenant routes to their own tenant', async () => {
      expect(await matches({ scope_type: 'tenant', scope_id: 'tenant-a' })).toBe(true);
      expect(await matches({ scope_type: 'tenant', scope_id: 'tenant-b' })).toBe(false);
      expect(await matches({ scope_type: 'platform', scope_id: 'tenant-b' })).toBe(true);
    });

    it('applies the category and severity allow lists', async () => {
      expect(await matches({ categories_json: JSON.stringify(['logging_dlq_backlog']) })).toBe(
        true
      );
      expect(await matches({ categories_json: JSON.stringify(['other']) })).toBe(false);
      expect(await matches({ categories_json: '[]' })).toBe(true);
      expect(await matches({ categories_json: 'not json' })).toBe(true);
      expect(await matches({ severities_json: JSON.stringify(['high', 'critical']) })).toBe(true);
      expect(await matches({ severities_json: JSON.stringify(['low']) })).toBe(false);
    });

    it('enforces the minimum severity rank', async () => {
      expect(await matches({ min_severity: 'high' }, { severity: 'high' })).toBe(true);
      expect(await matches({ min_severity: 'high' }, { severity: 'critical' })).toBe(true);
      expect(await matches({ min_severity: 'high' }, { severity: 'medium' })).toBe(false);
      expect(await matches({ min_severity: 'info' }, { severity: 'info' })).toBe(true);
      expect(await matches({ min_severity: 'critical' }, { severity: 'high' })).toBe(false);
    });

    it('honours a provider list embedded in the event routing policy', async () => {
      const policy = (providers: unknown) =>
        JSON.stringify({ notification_routing_policy: { providers } });
      expect(await matches({ provider: 'webhook' }, { payload_json: policy(['webhook']) })).toBe(
        true
      );
      expect(await matches({ provider: 'webhook' }, { payload_json: policy(['email']) })).toBe(
        false
      );
      expect(await matches({ provider: 'webhook' }, { payload_json: policy([]) })).toBe(false);
      expect(await matches({ provider: 'webhook' }, { payload_json: policy('webhook') })).toBe(
        true
      );
      expect(
        await matches(
          { provider: 'webhook' },
          { payload_json: JSON.stringify({ notification_routing_policy: ['webhook'] }) }
        )
      ).toBe(true);
      expect(await matches({ provider: 'webhook' }, { payload_json: 'not json' })).toBe(true);
    });
  });
});
