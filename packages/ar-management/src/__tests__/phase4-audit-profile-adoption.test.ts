import { describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveTenantRuntimeProfilesFromEnv: vi.fn(async (env: Partial<Env>) => {
      const auditProfileId = (env as Record<string, unknown>).DEFAULT_AUDIT_PROFILE_ID;
      if (auditProfileId === 'builtin:audit:archive-only-logpush') {
        return {
          auditProfile: {
            id: 'builtin:audit:archive-only-logpush',
            kind: 'audit',
            label: 'Archive Only + Logpush',
            builtin: true,
            primary: null,
            archive: { type: 'r2', bucketRef: 'DIAGNOSTIC_LOGS', prefix: 'audit/' },
            sinks: [],
          },
        };
      }

      return {
        auditProfile: {
          id: 'builtin:audit:standard',
          kind: 'audit',
          label: 'Standard Audit',
          builtin: true,
          primary: { type: 'd1', bindingRef: 'DB', dataset: 'event_log' },
          archive: null,
          sinks: [],
        },
      };
    }),
  };
});

import { adminSecurityIpReputationHandler } from '../admin-security';
import {
  adminComplianceStatusHandler,
  adminDataRetentionStatusHandler,
} from '../admin-compliance';

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
        all: vi.fn(async () => ({ results: ((await handler(sql, boundParams, 'all')) ?? []) as any[] })),
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
  const contextStore = new Map<string, unknown>([['tenantId', 'default']]);
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
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    get: vi.fn((key: string) => contextStore.get(key)),
    set: vi.fn((key: string, value: unknown) => contextStore.set(key, value)),
  } as any;
}

describe('Phase 4 audit profile adoption', () => {
  it('uses event_log for IP reputation checks when the standard audit profile is active', async () => {
    const mockDB = createSqlAwareMockDB(async (sql, params, op) => {
      if (sql.includes('FROM event_log') && sql.includes("LIKE 'auth.%failed%'") && op === 'first') {
        expect(params[0]).toBe('default');
        expect(params[1]).toBe('203.0.113.10');
        return { count: 3 };
      }

      if (
        sql.includes('FROM event_log') &&
        sql.includes("= 'rate_limit.exceeded'") &&
        op === 'first'
      ) {
        return { count: 1 };
      }

      if (sql.includes('FROM ip_blocklist') && op === 'first') {
        return null;
      }

      return null;
    });

    const c = createMockContext({
      path: '/api/admin/security/ip-reputation',
      body: { ip_addresses: ['203.0.113.10'] },
      db: mockDB,
      envOverrides: {
        DEFAULT_AUDIT_PROFILE_ID: 'builtin:audit:standard',
      },
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

  it('reports archive-only hot-query limits in compliance endpoints', async () => {
    const mockDB = createSqlAwareMockDB(async (sql, _params, op) => {
      if (sql.includes('SELECT settings FROM tenants') && op === 'first') {
        return {
          settings: JSON.stringify({
            data_retention: {
              enabled: true,
              days: 365,
              last_cleanup_at: null,
              next_cleanup_at: null,
            },
            audit: { retention_days: 90 },
            session: { retention_days: 30 },
            security: { mfa_enforced: true },
            compliance: { tombstone_retention_days: 2555 },
          }),
        };
      }
      if (sql.includes('FROM users_core') && sql.includes("pii_status = 'deleted'") && op === 'first') {
        return { pending_deletions: 0 };
      }
      if (sql.includes('FROM signing_keys') && op === 'first') {
        return { last_rotation: null };
      }
      if (sql.includes('FROM users') && sql.includes('mfa_enabled') && op === 'first') {
        return { users_with_mfa: 1, users_without_mfa: 1 };
      }
      if (sql.includes('FROM roles') && op === 'first') {
        return { active_roles: 1, users_with_roles: 1 };
      }
      if (sql.includes('FROM sessions') && op === 'first') {
        return { total: 5, expired: 1, oldest_date: 1710000000 };
      }
      if (sql.includes('FROM tombstones') && op === 'first') {
        return { total: 2, oldest_date: 1710000000 };
      }
      if (sql.includes('scheduled_deletion_at') && op === 'first') {
        return { pending: 0 };
      }
      return null;
    });

    const envOverrides = {
      DEFAULT_AUDIT_PROFILE_ID: 'builtin:audit:archive-only-logpush',
    } as Partial<Env>;

    const complianceResponse = await adminComplianceStatusHandler(
      createMockContext({
        path: '/api/admin/compliance/status',
        db: mockDB,
        envOverrides,
      })
    );
    expect(complianceResponse.status).toBe(200);
    const complianceBody = (await complianceResponse.json()) as {
      audit_log: { hot_query_status?: string; total_entries: number };
    };
    expect(complianceBody.audit_log.hot_query_status).toBe('not_supported');
    expect(complianceBody.audit_log.total_entries).toBe(0);

    const retentionResponse = await adminDataRetentionStatusHandler(
      createMockContext({
        path: '/api/admin/data-retention/status',
        db: mockDB,
        envOverrides,
      })
    );
    expect(retentionResponse.status).toBe(200);
    const retentionBody = (await retentionResponse.json()) as {
      categories: Array<{ category: string; hot_query_status?: string; total_records: number }>;
    };
    expect(retentionBody.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'audit_logs',
          hot_query_status: 'not_supported',
          total_records: 0,
        }),
      ])
    );
  });
});
