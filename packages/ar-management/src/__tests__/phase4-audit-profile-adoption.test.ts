import { describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
const writeAudit = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  createAuditLogFromContext: writeAudit,
}));

const readLogs = vi.hoisted(() => vi.fn());
vi.mock('@authrim/ar-lib-core/services/log-iceberg-read', () => ({
  readLogIcebergDataset: readLogs,
  loadLogIcebergProtectedDetail: vi.fn(async () => null),
}));

import { adminSecurityIpReputationHandler } from '../admin-security';

function createSqlAwareMockDB(
  handler: (
    sql: string,
    params: unknown[],
    op: 'first' | 'all' | 'run'
  ) => unknown | Promise<unknown>
) {
  return {
    prepare: vi.fn((sql: string) => {
      let boundParams: unknown[] = [];
      const statement = {
        bind: vi.fn((...params: unknown[]) => {
          boundParams = params;
          return statement;
        }),
        first: vi.fn(async () => (await handler(sql, boundParams, 'first')) ?? null),
        all: vi.fn(async () => ({
          results: ((await handler(sql, boundParams, 'all')) ?? []) as any[],
        })),
        run: vi.fn(async () => (await handler(sql, boundParams, 'run')) ?? { success: true }),
      };
      return statement;
    }),
    batch: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue(undefined),
    dump: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
  } as unknown as D1Database;
}

function createMockContext(options: {
  path: string;
  body?: Record<string, unknown>;
  db: D1Database;
  envOverrides?: Partial<Env>;
}) {
  const contextStore = new Map<string, unknown>([
    ['tenantId', 'default'],
    ['tenantMetadataContext', { tenantId: 'default', coreDb: options.db, route: {} }],
    ['adminAuth', { userId: 'admin-user-1' }],
  ]);
  return {
    req: {
      path: options.path,
      header: vi.fn(() => undefined),
      json: vi.fn().mockResolvedValue(options.body ?? {}),
    },
    env: {
      DB: options.db,
      DB_PII: options.db,
      ...options.envOverrides,
    } as unknown as Env,
    header: vi.fn(),
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    get: vi.fn((key: string) => contextStore.get(key)),
    set: vi.fn((key: string, value: unknown) => contextStore.set(key, value)),
  } as any;
}

describe('canonical audit dataset read', () => {
  it('counts canonical event rows for IP reputation without querying former log tables', async () => {
    const ip = '203.0.113.10';
    const now = Date.now();
    readLogs.mockResolvedValue({
      rows: [
        ...Array.from({ length: 3 }, (_, index) => ({
          id: `failed-${index}`,
          tenant_id: 'default',
          event_type: 'auth.password.failed',
          created_at: now,
          details_json: JSON.stringify({ ip_address: ip }),
        })),
        {
          id: 'rate-1',
          tenant_id: 'default',
          event_type: 'rate_limit.exceeded',
          created_at: now,
          details_json: JSON.stringify({ ip_address: ip }),
        },
        {
          id: 'other-ip',
          tenant_id: 'default',
          event_type: 'auth.password.failed',
          created_at: now,
          details_json: JSON.stringify({ ip_address: '198.51.100.8' }),
        },
        {
          id: 'too-old',
          tenant_id: 'default',
          event_type: 'auth.password.failed',
          created_at: now - 2 * 86400000,
          details_json: JSON.stringify({ ip_address: ip }),
        },
      ],
      hasArchive: true,
      consistency: 'snapshot',
      pendingDeliveries: 0,
    });
    const mockDB = createSqlAwareMockDB(async (sql, params, op) => {
      expect(sql).not.toMatch(/FROM (?:event_log|audit_log)/);
      if (sql.includes('FROM ip_blocklist') && op === 'first') {
        expect(params.slice(0, 2)).toEqual(['default', ip]);
        return null;
      }
      throw new Error(`unexpected metadata SQL: ${sql}`);
    });

    const c = createMockContext({
      path: '/api/admin/security/ip-reputation',
      body: { ip_addresses: ['203.0.113.10'] },
      db: mockDB,
    });

    const response = await adminSecurityIpReputationHandler(c);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      results: Array<{
        ip_address: string;
        risk_score: number;
        risk_level: string;
        indicators: { failed_auth_attempts_24h: number; rate_limit_violations_24h: number };
      }>;
    };

    expect(writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      'security.ip_reputation_check',
      'security',
      'default',
      expect.objectContaining({ ip_count: 1, high_risk_count: 0 })
    );
    expect(readLogs).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: 'default', sourceDataset: 'core.event_log' })
    );
    expect(body.results).toEqual([
      expect.objectContaining({
        ip_address: '203.0.113.10',
        risk_score: 25,
        risk_level: 'medium',
        indicators: {
          failed_auth_attempts_24h: 3,
          rate_limit_violations_24h: 1,
        },
      }),
    ]);
  });
});
