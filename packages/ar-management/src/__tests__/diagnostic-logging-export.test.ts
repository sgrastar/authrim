import { describe, expect, it, vi } from 'vitest';
import { buildDiagnosticLogPath, type Env } from '@authrim/ar-lib-core';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    adminAuthMiddleware: vi.fn(
      () =>
        async (c: { set?: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
          c.set?.('adminAuth', {
            userId: 'admin-1',
            authMethod: 'test',
            permissions: ['admin:diagnostics:read'],
          });
          await next();
        }
    ),
  };
});

import exportLogsApp from '../routes/diagnostic-logging/export-logs';

class MockR2ObjectBody {
  constructor(private readonly value: string) {}

  async text(): Promise<string> {
    return this.value;
  }
}

class MockR2Bucket {
  readonly store = new Map<string, string>();

  async get(key: string): Promise<{ text: () => Promise<string> } | null> {
    const value = this.store.get(key);
    return value === undefined ? null : new MockR2ObjectBody(value);
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async list(options?: {
    prefix?: string;
  }): Promise<{ objects: Array<{ key: string }>; truncated: boolean }> {
    const prefix = options?.prefix ?? '';
    const objects = Array.from(this.store.keys())
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key }));

    return { objects, truncated: false };
  }
}

function createMockKV(data: Record<string, string> = {}): KVNamespace {
  return {
    get: vi.fn(async (key: string) => data[key] ?? null),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

function createEnv(bucket: MockR2Bucket, kvData: Record<string, string> = {}): Env {
  return {
    ADMIN_API_SECRET: 'admin-secret',
    ISSUER_URL: 'https://issuer.example.com',
    OTP_HMAC_SECRET: 'otp-secret',
    DIAGNOSTIC_LOGS: bucket as unknown as R2Bucket,
    AUTHRIM_CONFIG: createMockKV(kvData),
  } as Env;
}

function authHeaders(): HeadersInit {
  return {
    Authorization: 'Bearer admin-secret',
  };
}

describe('Diagnostic Logs Export API', () => {
  it('returns 400 when tenantId is missing', async () => {
    const bucket = new MockR2Bucket();
    const env = createEnv(bucket);

    const response = await exportLogsApp.request('/?format=json', { headers: authHeaders() }, env);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'missing_tenant_id',
    });
  });

  it('exports JSONL filtered by diagnosticSessionId and clientId', async () => {
    const bucket = new MockR2Bucket();
    const env = createEnv(bucket);

    const key = await buildDiagnosticLogPath({
      pathPrefix: 'diagnostic-logs',
      tenantId: 'tenant-1',
      clientId: 'rp-client',
      category: 'token-validation',
      timestamp: Date.UTC(2026, 3, 21, 0, 0, 0),
      chunkId: 'chk_test_1',
    });
    bucket.store.set(
      key,
      [
        JSON.stringify({
          id: 'tok-1',
          diagnosticSessionId: 'session-a',
          flowId: 'flow-a',
          tenantId: 'tenant-1',
          clientId: 'rp-client',
          category: 'token-validation',
          level: 'error',
          timestamp: Date.UTC(2026, 3, 21, 0, 0, 0),
          step: 'issuer-check',
          tokenType: 'id_token',
          result: 'fail',
          expected: 'https://issuer.example.com',
          actual: 'https://bad.example.com',
          errorMessage: 'issuer mismatch',
          details: {
            issuer: 'https://bad.example.com',
          },
        }),
        JSON.stringify({
          id: 'tok-2',
          diagnosticSessionId: 'session-b',
          flowId: 'flow-b',
          tenantId: 'tenant-1',
          clientId: 'rp-client',
          category: 'token-validation',
          level: 'debug',
          timestamp: Date.UTC(2026, 3, 21, 0, 5, 0),
          step: 'audience-check',
          tokenType: 'id_token',
          result: 'pass',
        }),
      ].join('\n')
    );

    const response = await exportLogsApp.request(
      '/?tenantId=tenant-1&clientId=rp-client&sessionIds=session-a&format=jsonl&categories=token-validation&startDate=2026-04-21&endDate=2026-04-21',
      { headers: authHeaders() },
      env
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/x-ndjson');

    const body = await response.text();
    const lines = body.split('\n').filter((line) => line.trim().length > 0);

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry).toMatchObject({
      sessionId: 'session-a',
      category: 'token-validation',
      event: 'token_validation_issuer-check',
    });

    const details = entry.details as Record<string, unknown>;
    expect(details.result).toBe('fail');
    expect(details.errorMessage).toBe('issuer mismatch');
  });

  it('exports JSON with statistics and applies stricter privacy mode on request', async () => {
    const bucket = new MockR2Bucket();
    const env = createEnv(bucket, {
      'tenant:tenant-1:diagnostic-logging.storage_mode.default': 'full',
    });

    const key = await buildDiagnosticLogPath({
      pathPrefix: 'diagnostic-logs',
      tenantId: 'tenant-1',
      clientId: 'rp-client',
      category: 'token-validation',
      timestamp: Date.UTC(2026, 3, 21, 0, 10, 0),
      chunkId: 'chk_test_2',
    });
    bucket.store.set(
      key,
      JSON.stringify({
        id: 'tok-3',
        diagnosticSessionId: 'session-c',
        flowId: 'flow-c',
        tenantId: 'tenant-1',
        clientId: 'rp-client',
        category: 'token-validation',
        level: 'error',
        timestamp: Date.UTC(2026, 3, 21, 0, 10, 0),
        storageMode: 'full',
        step: 'token-response',
        tokenType: 'id_token',
        result: 'fail',
        errorMessage: 'contact user test@example.com',
        details: {
          access_token: 'access-secret',
          id_token: 'id-secret',
          refresh_token: 'refresh-secret',
        },
      })
    );

    const response = await exportLogsApp.request(
      '/?tenantId=tenant-1&clientId=rp-client&format=json&includeStats=true&categories=token-validation&sessionIds=session-c&exportMode=minimal&startDate=2026-04-21&endDate=2026-04-21',
      { headers: authHeaders() },
      env
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');

    const body = (await response.json()) as {
      logs: Array<Record<string, unknown>>;
      statistics: {
        totalLogs: number;
        sessionCount: number;
      };
    };

    expect(body.statistics).toMatchObject({
      totalLogs: 1,
      sessionCount: 1,
    });
    expect(body.logs).toHaveLength(1);

    const details = body.logs[0].details as Record<string, unknown>;
    expect(details.access_token).toBeUndefined();
    expect(details.id_token).toBeUndefined();
    expect(details.refresh_token).toBeUndefined();
    expect(details.has_access_token).toBe(true);
    expect(details.has_id_token).toBe(true);
    expect(details.errorMessage).toBe('contact user [EMAIL_REDACTED]');
  });

  it('returns 400 for invalid date format', async () => {
    const bucket = new MockR2Bucket();
    const env = createEnv(bucket);

    const response = await exportLogsApp.request(
      '/?tenantId=tenant-1&startDate=not-a-date',
      { headers: authHeaders() },
      env
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_date',
    });
  });
});
