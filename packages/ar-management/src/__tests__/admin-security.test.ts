import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  core: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() },
  audit: { queryOne: vi.fn() },
  hotSupport: vi.fn(),
  unsupported: vi.fn(),
  auditLog: vi.fn(),
  logger: { error: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.core })),
    createAuditLogFromContext: mocks.auditLog,
    createErrorResponse: vi.fn((c, code, options) => {
      const status =
        code === actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND
          ? 404
          : code === actual.AR_ERROR_CODES.INTERNAL_ERROR
            ? 500
            : 400;
      return c.json({ error: code, ...options }, status);
    }),
    getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
  };
});

vi.mock('../audit-hot-query', () => ({
  getAuditHotQuerySupport: mocks.hotSupport,
  createAuditHotQueryUnsupportedResponse: mocks.unsupported,
  getAuditHotQuerySqlSpec: vi.fn(() => ({ tableName: 'audit_events', actionColumn: 'action' })),
  getAuditTimeRange: vi.fn((from: number, to: number, context) =>
    context.createdAtUnit === 'milliseconds' ? [from * 1000, to * 1000] : [from, to]
  ),
}));

import {
  adminSecurityAlertAcknowledgeHandler,
  adminSecurityAlertsListHandler,
  adminSecurityIpReputationHandler,
  adminSecuritySuspiciousActivitiesHandler,
  adminSecurityThreatsHandler,
} from '../admin-security';

function context(
  options: {
    query?: Record<string, string | undefined>;
    id?: string;
    body?: unknown;
    bodyError?: boolean;
    adminId?: string;
  } = {}
) {
  const query = options.query ?? {};
  return {
    get: vi.fn((name: string) =>
      name === 'adminAuth' ? (options.adminId ? { adminId: options.adminId } : null) : undefined
    ),
    req: {
      query: vi.fn((name: string) => query[name]),
      param: vi.fn((name: string) => (name === 'id' ? (options.id ?? 'alert-1') : undefined)),
      json: options.bodyError
        ? vi.fn().mockRejectedValue(new SyntaxError('bad json'))
        : vi.fn().mockResolvedValue(options.body ?? {}),
    },
    env: {},
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

function cursor(id: string, createdAt: number) {
  return Buffer.from(JSON.stringify({ id, created_at: createdAt })).toString('base64url');
}

function alert(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-1',
    tenant_id: 'tenant-a',
    type: 'brute_force',
    severity: 'high',
    status: 'open',
    title: 'Repeated failures',
    description: null,
    source_ip: '203.0.113.1',
    user_id: 'user-1',
    client_id: 'client-1',
    metadata: JSON.stringify({ attempts: 10 }),
    created_at: 1_700_000_000,
    updated_at: 1_700_000_001_000,
    acknowledged_at: null,
    acknowledged_by: null,
    resolved_at: null,
    resolved_by: null,
    ...overrides,
  };
}

describe('admin security monitoring APIs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.core.query.mockResolvedValue([]);
    mocks.core.queryOne.mockResolvedValue(null);
    mocks.core.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.audit.queryOne.mockResolvedValue({ count: 0 });
    mocks.hotSupport.mockResolvedValue({
      supported: true,
      context: { adapter: mocks.audit, mode: 'events', createdAtUnit: 'seconds' },
    });
    mocks.unsupported.mockImplementation((c) => c.json({ error: 'unsupported' }, 503));
    mocks.auditLog.mockResolvedValue(undefined);
  });

  describe('alerts list validation and pagination', () => {
    it.each([
      [{ page: '1' }, 'pagination'],
      [{ page_size: '20' }, 'pagination'],
      [{ limit: '0' }, 'query'],
      [{ limit: '101' }, 'query'],
      [{ filter: 'unknown=value' }, 'filter'],
      [{ sort: 'title' }, 'sort'],
      [{ cursor: 'not-a-cursor' }, 'cursor'],
      [{ cursor: Buffer.from('{}').toString('base64url') }, 'cursor'],
      [{ cursor: Buffer.from('{').toString('base64url') }, 'cursor'],
    ])('rejects invalid alert query %#', async (query, field) => {
      const response = await adminSecurityAlertsListHandler(context({ query }));
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).toContain(field);
    });

    it.each([
      ['status=open,severity=high,type=brute_force', '-created_at'],
      ['status=invalid,severity=invalid,type=invalid', 'created_at'],
      ['created_at=ignored', '-acknowledged_at'],
      ['status=open,badpair', 'severity'],
      ['status=', '-severity'],
    ])('applies allowlisted filters=%s and sort=%s', async (filter, sort) => {
      await adminSecurityAlertsListHandler(context({ query: { filter, sort } }));
      expect(mocks.core.query).toHaveBeenCalledWith(
        expect.stringContaining('FROM security_alerts'),
        expect.any(Array)
      );
    });

    it('returns formatted alerts and a tamper-evident next cursor', async () => {
      mocks.core.query.mockResolvedValueOnce([
        alert(),
        alert({ id: 'alert-2', metadata: '{', acknowledged_at: 1_700_000_002 }),
        alert({ id: 'extra' }),
      ]);
      const response = await adminSecurityAlertsListHandler(
        context({ query: { limit: '2', cursor: cursor('previous', 1_700_000_100) } })
      );
      const body = (await response.json()) as {
        data: Array<Record<string, unknown>>;
        pagination: { has_more: boolean; next_cursor?: string };
      };
      expect(body.data).toHaveLength(2);
      expect(body.data[0]).toMatchObject({
        alert_id: 'alert-1',
        metadata: { attempts: 10 },
        created_at: expect.stringContaining('2023'),
      });
      expect(body.data[1]).toMatchObject({ metadata: null, acknowledged_at: expect.any(String) });
      expect(body.pagination).toMatchObject({ has_more: true, next_cursor: expect.any(String) });
    });

    it('returns no cursor when results fit the requested page', async () => {
      mocks.core.query.mockResolvedValueOnce([alert({ created_at: 0, updated_at: 0 })]);
      const body = (await (await adminSecurityAlertsListHandler(context())).json()) as {
        pagination: Record<string, unknown>;
      };
      expect(body.pagination).toEqual({ has_more: false });
    });

    it('returns internal_error for alert query failures', async () => {
      mocks.core.query.mockRejectedValueOnce(new Error('D1 unavailable'));
      expect((await adminSecurityAlertsListHandler(context())).status).toBe(500);
    });
  });

  describe('alert acknowledgement', () => {
    it('requires route ID', async () => {
      expect((await adminSecurityAlertAcknowledgeHandler(context({ id: '' }))).status).toBe(400);
    });

    it.each([[{ notes: 'x'.repeat(1001) }], [{ resolution: 'x'.repeat(501) }]])(
      'rejects oversized acknowledgement text %#',
      async (body) => {
        expect((await adminSecurityAlertAcknowledgeHandler(context({ body }))).status).toBe(400);
      }
    );

    it('treats malformed JSON as an empty acknowledgement body', async () => {
      mocks.core.queryOne.mockResolvedValueOnce(alert());
      expect(
        (await adminSecurityAlertAcknowledgeHandler(context({ bodyError: true }))).status
      ).toBe(200);
    });

    it('does not acknowledge an alert outside the tenant', async () => {
      expect((await adminSecurityAlertAcknowledgeHandler(context())).status).toBe(404);
    });

    it.each([['acknowledged'], ['resolved']])(
      'returns idempotent response for already %s alert',
      async (status) => {
        mocks.core.queryOne.mockResolvedValueOnce(alert({ status }));
        const response = await adminSecurityAlertAcknowledgeHandler(context());
        await expect(response.json()).resolves.toMatchObject({
          status,
          already_acknowledged: true,
        });
        expect(mocks.core.execute).not.toHaveBeenCalled();
      }
    );

    it.each([
      [{}, 'unknown', false],
      [{ notes: 'Investigating' }, 'admin-1', true],
      [{ resolution: 'False positive' }, 'admin-1', true],
      [{ notes: 'Done', resolution: 'Blocked IP' }, 'admin-1', true],
    ])('acknowledges with body=%o admin=%s metadata=%s', async (body, adminId, metadata) => {
      mocks.core.queryOne.mockResolvedValueOnce(alert());
      const response = await adminSecurityAlertAcknowledgeHandler(
        context({ body, adminId: adminId === 'unknown' ? undefined : adminId })
      );
      expect(response.status).toBe(200);
      expect(mocks.core.execute).toHaveBeenCalledWith(
        expect.stringContaining(metadata ? 'json_patch' : 'acknowledged_by'),
        expect.arrayContaining(['acknowledged', adminId, 'alert-1', 'tenant-a'])
      );
      expect(mocks.auditLog).toHaveBeenCalledWith(
        expect.anything(),
        'security_alert.acknowledge',
        'security_alert',
        'alert-1',
        expect.objectContaining({
          has_notes: 'notes' in body && !!body.notes,
          has_resolution: 'resolution' in body && !!body.resolution,
        })
      );
    });

    it('returns internal_error for acknowledgement persistence failure', async () => {
      mocks.core.queryOne.mockRejectedValueOnce(new Error('D1 unavailable'));
      expect((await adminSecurityAlertAcknowledgeHandler(context())).status).toBe(500);
    });
  });

  describe('suspicious activity listing', () => {
    it.each([[{ page: '1' }], [{ page_size: '20' }], [{ limit: 'bad' }], [{ cursor: 'bad' }]])(
      'rejects invalid suspicious activity query %#',
      async (query) => {
        expect((await adminSecuritySuspiciousActivitiesHandler(context({ query }))).status).toBe(
          400
        );
      }
    );

    it.each([
      ['type=new_device,severity=medium,user_id=user-1', '-severity'],
      ['type=invalid,severity=invalid', 'type'],
      ['', 'unknown'],
    ])('applies suspicious filters=%s sort=%s', async (filter, sort) => {
      await adminSecuritySuspiciousActivitiesHandler(context({ query: { filter, sort } }));
      expect(mocks.core.query).toHaveBeenCalled();
    });

    it('formats valid and malformed metadata with cursor pagination', async () => {
      mocks.core.query.mockResolvedValueOnce([
        {
          id: 'activity-1',
          tenant_id: 'tenant-a',
          type: 'new_device',
          severity: 'medium',
          user_id: 'user-1',
          client_id: null,
          source_ip: '203.0.113.1',
          user_agent: 'Browser',
          description: 'New device',
          metadata: JSON.stringify({ device: 'phone' }),
          created_at: 1_700_000_000,
          resolved_at: null,
        },
        {
          id: 'activity-2',
          created_at: 1_700_000_001,
          metadata: '{',
          type: 'failed_mfa',
          severity: 'high',
          description: 'Failed MFA',
        },
      ]);
      const body = (await (
        await adminSecuritySuspiciousActivitiesHandler(context({ query: { limit: '1' } }))
      ).json()) as { data: Array<Record<string, unknown>>; pagination: Record<string, unknown> };
      expect(body.data[0]).toMatchObject({
        activity_id: 'activity-1',
        metadata: { device: 'phone' },
      });
      expect(body.pagination).toMatchObject({ has_more: true, next_cursor: expect.any(String) });
    });

    it('returns internal_error for suspicious activity query failure', async () => {
      mocks.core.query.mockRejectedValueOnce(new Error('D1 unavailable'));
      expect((await adminSecuritySuspiciousActivitiesHandler(context())).status).toBe(500);
    });
  });

  describe('threat listing', () => {
    it.each([[{ page: '1' }], [{ page_size: '20' }], [{ limit: '101' }], [{ cursor: 'bad' }]])(
      'rejects invalid threat query %#',
      async (query) => {
        expect((await adminSecurityThreatsHandler(context({ query }))).status).toBe(400);
      }
    );

    it.each([
      ['type=phishing,severity=critical,status=detected', '-severity'],
      ['type=invalid,severity=invalid,status=invalid', 'status'],
      ['', 'unknown'],
    ])('applies threat filters=%s sort=%s', async (filter, sort) => {
      await adminSecurityThreatsHandler(context({ query: { filter, sort } }));
      expect(mocks.core.query).toHaveBeenCalled();
    });

    it('formats threat evidence and tolerates malformed JSON', async () => {
      mocks.core.query.mockResolvedValueOnce([
        {
          id: 'threat-1',
          tenant_id: 'tenant-a',
          type: 'phishing',
          severity: 'critical',
          status: 'detected',
          title: 'Phishing',
          description: null,
          source: 'email',
          affected_resources: JSON.stringify(['user-1']),
          indicators: JSON.stringify(['bad.example']),
          metadata: JSON.stringify({ campaign: 'test' }),
          created_at: 1_700_000_000,
          updated_at: 1_700_000_001,
          detected_at: 1_700_000_002,
          mitigated_at: null,
        },
        {
          id: 'threat-2',
          type: 'malware',
          severity: 'high',
          status: 'mitigated',
          title: 'Malware',
          affected_resources: '{',
          indicators: '{',
          metadata: '{',
          created_at: 1,
          updated_at: 1,
          detected_at: 1,
          mitigated_at: 2,
        },
      ]);
      const body = (await (await adminSecurityThreatsHandler(context())).json()) as {
        data: Array<Record<string, unknown>>;
      };
      expect(body.data[0]).toMatchObject({
        threat_id: 'threat-1',
        affected_resources: ['user-1'],
        indicators: ['bad.example'],
        metadata: { campaign: 'test' },
      });
      expect(body.data[1]).toMatchObject({
        affected_resources: null,
        indicators: null,
        metadata: null,
        mitigated_at: expect.any(String),
      });
    });

    it('generates next cursor from detected_at', async () => {
      const base = {
        type: 'phishing',
        severity: 'high',
        status: 'detected',
        title: 'Threat',
        created_at: 1,
        updated_at: 1,
        detected_at: 10,
        mitigated_at: null,
      };
      mocks.core.query.mockResolvedValueOnce([
        { ...base, id: 'threat-1' },
        { ...base, id: 'threat-2', detected_at: 9 },
      ]);
      const body = (await (
        await adminSecurityThreatsHandler(context({ query: { limit: '1' } }))
      ).json()) as { pagination: Record<string, unknown> };
      expect(body.pagination).toMatchObject({ has_more: true, next_cursor: expect.any(String) });
    });

    it('returns internal_error for threat query failure', async () => {
      mocks.core.query.mockRejectedValueOnce(new Error('D1 unavailable'));
      expect((await adminSecurityThreatsHandler(context())).status).toBe(500);
    });
  });

  describe('IP reputation', () => {
    it.each([
      [{}],
      [{ ip_addresses: [] }],
      [{ ip_addresses: ['999.1.1.1'] }],
      [{ ip_addresses: Array.from({ length: 101 }, () => '192.0.2.1') }],
    ])('rejects invalid IP batch %#', async (body) => {
      expect((await adminSecurityIpReputationHandler(context({ body }))).status).toBe(400);
    });

    it.each([
      [{ supported: false }, 503],
      [{ supported: true, context: null }, 503],
    ])('returns unsupported audit response %#', async (support, status) => {
      mocks.hotSupport.mockResolvedValueOnce(support);
      expect(
        (await adminSecurityIpReputationHandler(context({ body: { ip_addresses: ['192.0.2.1'] } })))
          .status
      ).toBe(status);
    });

    it('classifies low, medium, high, critical, and blocked addresses with audit evidence', async () => {
      const ips = ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4', '2001:db8:0:0:0:0:0:1'];
      const failedByIp = new Map(ips.map((ip, index) => [ip, [0, 5, 10, 10, 0][index]]));
      const rateByIp = new Map(ips.map((ip, index) => [ip, [0, 0, 1, 3, 0][index]]));
      mocks.audit.queryOne.mockImplementation(async (sql: string, bindings: unknown[]) => ({
        count: (sql.includes('rate_limit.exceeded') ? rateByIp : failedByIp).get(
          String(bindings[1])
        ),
      }));
      mocks.core.queryOne.mockImplementation(async (_sql: string, bindings: unknown[]) =>
        bindings[1] === ips[4] ? { id: 'blocked' } : null
      );
      const response = await adminSecurityIpReputationHandler(
        context({ body: { ip_addresses: ips } })
      );
      const body = (await response.json()) as {
        results: Array<{ risk_level: string; recommendation: string }>;
        summary: Record<string, number>;
      };
      expect(body.results.map((r) => r.risk_level)).toEqual([
        'low',
        'medium',
        'high',
        'critical',
        'critical',
      ]);
      expect(body.results.map((r) => r.recommendation)).toEqual([
        'No action needed',
        'Review activity',
        'Monitor closely',
        'Block immediately',
        'Block immediately',
      ]);
      expect(body.summary).toEqual({ total_checked: 5, critical: 2, high: 1, medium: 1, low: 1 });
      expect(mocks.auditLog).toHaveBeenCalledWith(
        expect.anything(),
        'security.ip_reputation_check',
        'security',
        'tenant-a',
        { ip_count: 5, high_risk_count: 3 }
      );
    });

    it('caps individual failed/rate-limit contributions to risk score', async () => {
      mocks.audit.queryOne
        .mockResolvedValueOnce({ count: 100 })
        .mockResolvedValueOnce({ count: 100 });
      mocks.core.queryOne.mockResolvedValueOnce(null);
      const body = (await (
        await adminSecurityIpReputationHandler(context({ body: { ip_addresses: ['192.0.2.1'] } }))
      ).json()) as { results: Array<{ risk_score: number }> };
      expect(body.results[0]?.risk_score).toBe(70);
    });

    it('uses zero counts when audit aggregates are absent', async () => {
      mocks.audit.queryOne.mockResolvedValue(null);
      const response = await adminSecurityIpReputationHandler(
        context({ body: { ip_addresses: ['::1'] } })
      );
      await expect(response.json()).resolves.toMatchObject({
        results: [{ risk_score: 0, risk_level: 'low' }],
      });
    });

    it('returns internal_error for reputation lookup failures', async () => {
      mocks.hotSupport.mockRejectedValueOnce(new Error('audit unavailable'));
      expect(
        (await adminSecurityIpReputationHandler(context({ body: { ip_addresses: ['192.0.2.1'] } })))
          .status
      ).toBe(500);
    });
  });
});
