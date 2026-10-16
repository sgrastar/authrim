import { describe, expect, it, vi } from 'vitest';
import { applyPrivacyModeToEntry, buildDiagnosticLogPath, type Env } from '@authrim/ar-lib-core';

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
    ISSUER_URL: 'https://issuer.example.com',
    OTP_HMAC_SECRET: 'otp-secret',
    DIAGNOSTIC_LOGS: bucket as unknown as R2Bucket,
    SETTINGS: createMockKV(kvData),
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

  it('exports only the requested authentication flow', async () => {
    const bucket = new MockR2Bucket();
    const env = createEnv(bucket);

    const key = await buildDiagnosticLogPath({
      pathPrefix: 'diagnostic-logs',
      tenantId: 'tenant-1',
      clientId: 'rp-client',
      category: 'auth-decision',
      timestamp: Date.UTC(2026, 3, 21, 1, 0, 0),
      chunkId: 'chk_flow_filter',
    });
    bucket.store.set(
      key,
      [
        JSON.stringify({
          id: 'auth-flow-a',
          flowId: 'flow-a',
          tenantId: 'tenant-1',
          clientId: 'rp-client',
          category: 'auth-decision',
          level: 'info',
          timestamp: Date.UTC(2026, 3, 21, 1, 0, 0),
          decision: 'allow',
          reason: 'authorization_response',
        }),
        JSON.stringify({
          id: 'auth-flow-b',
          flowId: 'flow-b',
          tenantId: 'tenant-1',
          clientId: 'rp-client',
          category: 'auth-decision',
          level: 'warn',
          timestamp: Date.UTC(2026, 3, 21, 1, 0, 1),
          decision: 'deny',
          reason: 'invalid_issuer',
        }),
      ].join('\n')
    );

    const response = await exportLogsApp.request(
      '/?tenantId=tenant-1&clientId=rp-client&flowIds=flow-b&format=json&categories=auth-decision&startDate=2026-04-21&endDate=2026-04-21',
      { headers: authHeaders() },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { logs: Array<Record<string, unknown>> };
    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]).toMatchObject({
      event: 'auth_decision_deny',
      details: { flowId: 'flow-b', reason: 'invalid_issuer' },
    });
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

  it('rejects reversed date ranges and unknown categories', async () => {
    const bucket = new MockR2Bucket();
    const env = createEnv(bucket);

    const reversed = await exportLogsApp.request(
      '/?tenantId=tenant-1&startDate=2026-04-22&endDate=2026-04-21',
      { headers: authHeaders() },
      env
    );
    expect(reversed.status).toBe(400);
    await expect(reversed.json()).resolves.toMatchObject({ error: 'invalid_date_range' });

    const unknownCategory = await exportLogsApp.request(
      '/?tenantId=tenant-1&categories=token-validation,secrets',
      { headers: authHeaders() },
      env
    );
    expect(unknownCategory.status).toBe(400);
    await expect(unknownCategory.json()).resolves.toMatchObject({
      error: 'invalid_categories',
    });
  });

  it('bounds comma-separated evidence filters', async () => {
    const bucket = new MockR2Bucket();
    const env = createEnv(bucket);
    const flowIds = Array.from({ length: 101 }, (_, index) => `flow-${index}`).join(',');

    const response = await exportLogsApp.request(
      `/?tenantId=tenant-1&flowIds=${flowIds}`,
      { headers: authHeaders() },
      env
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_filter' });
  });

  describe('merged output', () => {
    const SETTINGS_KEY = 'settings:tenant:tenant-1:diagnostic-logging';
    const day = '2026-04-21';
    const at = (seconds: number) => Date.UTC(2026, 3, 21, 0, 0, seconds);

    function entry(
      id: string,
      session: string,
      seconds: number,
      source: 'server' | 'sdk',
      clientId?: string
    ) {
      return {
        id,
        diagnosticSessionId: session,
        tenantId: 'tenant-1',
        ...(clientId ? { clientId } : {}),
        category: 'auth-decision',
        level: 'info',
        timestamp: at(seconds),
        decision: 'allow',
        reason: id,
        source,
      };
    }

    async function seed(bucket: MockR2Bucket) {
      const put = async (clientId: string | undefined, chunkId: string, entries: object[]) => {
        const key = await buildDiagnosticLogPath({
          pathPrefix: 'diagnostic-logs',
          tenantId: 'tenant-1',
          clientId,
          category: 'auth-decision',
          timestamp: at(0),
          chunkId,
        });
        bucket.store.set(key, entries.map((e) => JSON.stringify(e)).join('\n'));
      };
      // SDK entries of two sessions, under the client's folder
      await put('rp-client', 'chk_sdk', [
        entry('sdk-a1', 'session-a', 1, 'sdk', 'rp-client'),
        entry('sdk-b1', 'session-b', 2, 'sdk', 'rp-client'),
        entry('sdk-a2', 'session-a', 5, 'sdk', 'rp-client'),
      ]);
      // what the server wrote with no client, in the tenant folder, and for another session
      await put(undefined, 'chk_server', [
        entry('srv-a1', 'session-a', 3, 'server'),
        entry('srv-b1', 'session-b', 4, 'server'),
        entry('srv-z1', 'session-z', 6, 'server'),
      ]);
    }

    async function exportLogs(
      query: string,
      kvData: Record<string, string>,
      configure?: (kv: KVNamespace) => void,
      extra?: (bucket: MockR2Bucket) => Promise<void>
    ) {
      const bucket = new MockR2Bucket();
      await seed(bucket);
      await extra?.(bucket);
      const env = createEnv(bucket, kvData);
      configure?.(env.SETTINGS as KVNamespace);
      const response = await exportLogsApp.request(
        `/?tenantId=tenant-1&format=json&categories=auth-decision&startDate=${day}&endDate=${day}&${query}`,
        { headers: authHeaders() },
        env
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { logs: Array<Record<string, unknown>> };
      return body.logs;
    }

    const reasonsOf = (logs: Array<Record<string, unknown>>) =>
      logs.map((log) => (log.details as Record<string, unknown>).reason);
    const merged = {
      [SETTINGS_KEY]: JSON.stringify({ 'diagnostic-logging.merged_output_enabled': true }),
    };

    it('exports as it always did while merged output is off: by session, no source, only the requested clients', async () => {
      const everything = await exportLogs('', {});
      expect(reasonsOf(everything)).toEqual([
        'sdk-a1',
        'srv-a1',
        'sdk-a2',
        'sdk-b1',
        'srv-b1',
        'srv-z1',
      ]);
      for (const log of everything) expect(log).not.toHaveProperty('source');

      const forClient = await exportLogs('clientId=rp-client', {});
      expect(reasonsOf(forClient)).toEqual(['sdk-a1', 'sdk-a2', 'sdk-b1']);
      for (const log of forClient) expect(log).not.toHaveProperty('source');
    });

    it('exports one timeline, naming the writer of each entry, when merged output is on', async () => {
      const logs = await exportLogs('', merged);

      expect(reasonsOf(logs)).toEqual(['sdk-a1', 'sdk-b1', 'srv-a1', 'srv-b1', 'sdk-a2', 'srv-z1']);
      expect(logs.map((log) => log.source)).toEqual([
        'sdk',
        'sdk',
        'server',
        'server',
        'sdk',
        'server',
      ]);
    });

    it('brings in what the server wrote for the same sessions when the export is limited to a client', async () => {
      const logs = await exportLogs('clientId=rp-client', merged);

      // session-z has no SDK entry of the client, so it stays out
      expect(reasonsOf(logs)).toEqual(['sdk-a1', 'sdk-b1', 'srv-a1', 'srv-b1', 'sdk-a2']);
    });

    it('limits that to the sessions asked for', async () => {
      const logs = await exportLogs('clientId=rp-client&sessionIds=session-a', merged);

      expect(reasonsOf(logs)).toEqual(['sdk-a1', 'srv-a1', 'sdk-a2']);
    });

    it('never brings in a session that only another client has, nor another tenant', async () => {
      const extra = async (bucket: MockR2Bucket) => {
        const put = async (
          tenantId: string,
          clientId: string | undefined,
          chunkId: string,
          entries: object[]
        ) => {
          const key = await buildDiagnosticLogPath({
            pathPrefix: 'diagnostic-logs',
            tenantId,
            clientId,
            category: 'auth-decision',
            timestamp: at(0),
            chunkId,
          });
          bucket.store.set(key, entries.map((e) => JSON.stringify(e)).join('\n'));
        };
        // session-s exists only under client other-client; the server wrote to it with no client
        await put('tenant-1', 'other-client', 'chk_other', [
          entry('other-s1', 'session-s', 7, 'sdk', 'other-client'),
        ]);
        await put('tenant-1', undefined, 'chk_server_s', [
          entry('srv-s1', 'session-s', 8, 'server'),
        ]);
        // another tenant holds entries of session-a, and of session-s
        await put('tenant-2', 'rp-client', 'chk_t2', [
          { ...entry('t2-a', 'session-a', 9, 'sdk', 'rp-client'), tenantId: 'tenant-2' },
        ]);
        await put('tenant-2', undefined, 'chk_t2_server', [
          { ...entry('t2-srv', 'session-a', 10, 'server'), tenantId: 'tenant-2' },
        ]);
      };

      const onlyOther = await exportLogs(
        'clientId=rp-client&sessionIds=session-s',
        merged,
        undefined,
        extra
      );
      expect(reasonsOf(onlyOther)).toEqual([]);

      // asked for next to a session the client does have: only the latter, with its server entries
      const both = await exportLogs(
        'clientId=rp-client&sessionIds=session-a,session-s',
        merged,
        undefined,
        extra
      );
      expect(reasonsOf(both)).toEqual(['sdk-a1', 'srv-a1', 'sdk-a2']);

      // with no sessionIds: the client's own sessions, never session-s, never tenant-2
      const own = await exportLogs('clientId=rp-client', merged, undefined, extra);
      expect(reasonsOf(own)).toEqual(['sdk-a1', 'sdk-b1', 'srv-a1', 'srv-b1', 'sdk-a2']);
      expect(JSON.stringify(own)).not.toContain('t2-');
    });

    it('keeps an order the request names', async () => {
      const logs = await exportLogs('sortMode=session', merged);

      // grouped by session as asked, and the writer is still named
      expect(reasonsOf(logs)).toEqual(['sdk-a1', 'srv-a1', 'sdk-a2', 'sdk-b1', 'srv-b1', 'srv-z1']);
      expect(logs.every((log) => typeof log.source === 'string')).toBe(true);
    });

    it('exports as if merged output were off when the setting cannot be read', async () => {
      const unreadable = { [SETTINGS_KEY]: JSON.stringify({}) };
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      let logs;
      try {
        logs = await exportLogs('clientId=rp-client', unreadable, (kv) => {
          (kv.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('kv down'));
        });
        expect(warn.mock.calls.flat().join(' ')).toContain(
          'Failed to load diagnostic settings for export'
        );
      } finally {
        warn.mockRestore();
      }

      expect(reasonsOf(logs)).toEqual(['sdk-a1', 'sdk-a2', 'sdk-b1']);
      for (const log of logs) expect(log).not.toHaveProperty('source');
    });

    it('treats anything but an explicit true as off', async () => {
      for (const value of ['true', 1, null]) {
        const logs = await exportLogs('clientId=rp-client', {
          [SETTINGS_KEY]: JSON.stringify({ 'diagnostic-logging.merged_output_enabled': value }),
        });
        expect(reasonsOf(logs), String(value)).toEqual(['sdk-a1', 'sdk-a2', 'sdk-b1']);
      }
    });
  });

  describe('entries stored in full mode', () => {
    const SETTINGS_KEY = 'settings:tenant:tenant-1:diagnostic-logging';
    const raw = {
      id: 'full-1',
      diagnosticSessionId: 'session-f',
      tenantId: 'tenant-1',
      clientId: 'rp-client',
      category: 'token-validation',
      level: 'debug',
      timestamp: Date.UTC(2026, 3, 21, 0, 0, 0),
      storageMode: 'full',
      step: 'userinfo-response',
      result: 'pass',
      errorMessage: 'user jane.doe@example.com',
      details: {
        access_token: 'legacy-raw-access-token',
        claims: { email: 'jane.doe@example.com', name: 'Jane Doe' },
      },
    };

    async function exportRaw(kvData: Record<string, string>) {
      const bucket = new MockR2Bucket();
      const key = await buildDiagnosticLogPath({
        pathPrefix: 'diagnostic-logs',
        tenantId: 'tenant-1',
        clientId: 'rp-client',
        category: 'token-validation',
        timestamp: raw.timestamp,
        chunkId: 'chk_full',
      });
      bucket.store.set(key, JSON.stringify(raw));
      const response = await exportLogsApp.request(
        '/?tenantId=tenant-1&clientId=rp-client&format=json&categories=token-validation&startDate=2026-04-21&endDate=2026-04-21',
        { headers: authHeaders() },
        createEnv(bucket, kvData)
      );
      expect(response.status).toBe(200);
      return response.text();
    }

    it('protects tokens and PII of entries written before, by default', async () => {
      const text = await exportRaw({});

      expect(text).not.toContain('legacy-raw-access-token');
      expect(text).not.toContain('jane.doe@example.com');
      expect(text).not.toContain('Jane Doe');
      expect(text).toContain('sha256:');
    });

    it('shows the PII only when the PII filter is off, and never the token', async () => {
      const text = await exportRaw({
        [SETTINGS_KEY]: JSON.stringify({ 'diagnostic-logging.filter_pii': false }),
      });

      expect(text).toContain('jane.doe@example.com');
      expect(text).toContain('Jane Doe');
      expect(text).not.toContain('legacy-raw-access-token');
    });

    it.each([
      ['full', undefined],
      ['full', 'masked'],
      ['full', 'minimal'],
      ['masked', undefined],
      ['minimal', undefined],
    ])(
      'takes secrets out of entries stored in %s mode (export mode %s), whatever their step',
      async (stored, exportMode) => {
        const bucket = new MockR2Bucket();
        const key = await buildDiagnosticLogPath({
          pathPrefix: 'diagnostic-logs',
          tenantId: 'tenant-1',
          clientId: 'rp-client',
          category: 'token-validation',
          timestamp: raw.timestamp,
          chunkId: 'chk_old',
        });
        bucket.store.set(
          key,
          JSON.stringify({
            ...raw,
            storageMode: stored,
            step: 'issuer-check',
            requestId: 'jane@example.com',
            errorMessage: 'cb https://rp.example.com/cb?code=old-raw-code',
            details: {
              client_secret: 'old-raw-secret',
              nested: [{ refresh_token: 'old-raw-refresh' }, { 'Access-Token': ['old-raw-array'] }],
            },
          })
        );
        const response = await exportLogsApp.request(
          `/?tenantId=tenant-1&clientId=rp-client&format=json&categories=token-validation&startDate=2026-04-21&endDate=2026-04-21${exportMode ? `&exportMode=${exportMode}` : ''}`,
          { headers: authHeaders() },
          createEnv(bucket, {})
        );

        const text = await response.text();
        expect(response.status).toBe(200);
        for (const rawValue of [
          'old-raw-secret',
          'old-raw-refresh',
          'old-raw-array',
          'old-raw-code',
        ]) {
          expect(text, rawValue).not.toContain(rawValue);
        }
        // identifiers are not part of the export entry, but the entry is still returned
        expect(JSON.parse(text).logs).toHaveLength(1);
      }
    );

    it('includes the token hash of an entry in the export', async () => {
      const bucket = new MockR2Bucket();
      const key = await buildDiagnosticLogPath({
        pathPrefix: 'diagnostic-logs',
        tenantId: 'tenant-1',
        clientId: 'rp-client',
        category: 'token-validation',
        timestamp: raw.timestamp,
        chunkId: 'chk_hash',
      });
      bucket.store.set(key, JSON.stringify({ ...raw, tokenHash: 'abcdef012345' }));
      const response = await exportLogsApp.request(
        '/?tenantId=tenant-1&clientId=rp-client&format=json&categories=token-validation&startDate=2026-04-21&endDate=2026-04-21',
        { headers: authHeaders() },
        createEnv(bucket, {})
      );
      const body = (await response.json()) as { logs: Array<{ details: Record<string, unknown> }> };
      expect(body.logs[0].details.tokenHash).toBe('abcdef012345');
    });

    it('keeps the PII filter on when the settings cannot be read', async () => {
      const bucket = new MockR2Bucket();
      const key = await buildDiagnosticLogPath({
        pathPrefix: 'diagnostic-logs',
        tenantId: 'tenant-1',
        clientId: 'rp-client',
        category: 'token-validation',
        timestamp: raw.timestamp,
        chunkId: 'chk_full',
      });
      bucket.store.set(key, JSON.stringify(raw));
      const env = createEnv(bucket, {});
      (env.SETTINGS!.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('kv down'));

      const response = await exportLogsApp.request(
        '/?tenantId=tenant-1&clientId=rp-client&format=json&categories=token-validation&startDate=2026-04-21&endDate=2026-04-21',
        { headers: authHeaders() },
        env
      );

      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).not.toContain('jane.doe@example.com');
      expect(text).not.toContain('legacy-raw-access-token');
    });
  });

  describe('ids are found by the value they were written with', () => {
    const LONG_SESSION = `session-${'A1b2C3d4'.repeat(8)}`;
    const LONG_FLOW = `flow-${'Z9y8X7w6'.repeat(8)}`;
    const SETTINGS_KEY = 'settings:tenant:tenant-1:diagnostic-logging';
    const at = (seconds: number) => Date.UTC(2026, 3, 21, 0, 0, seconds);

    function logEntry(
      id: string,
      session: string,
      flow: string,
      seconds: number,
      clientId?: string
    ) {
      return {
        id,
        diagnosticSessionId: session,
        flowId: flow,
        tenantId: 'tenant-1',
        ...(clientId ? { clientId } : {}),
        category: 'auth-decision',
        level: 'info',
        timestamp: at(seconds),
        decision: 'allow',
        reason: id,
        source: 'sdk',
      };
    }

    /** What ingest and the logger store: the entry after the privacy pass. */
    async function written(raw: object, tokenHashPrefixLength?: number) {
      return applyPrivacyModeToEntry({ ...raw, storageMode: 'masked' } as never, {
        mode: 'masked',
        secret: 'otp-secret:tenant-1',
        tokenHashPrefixLength,
      });
    }

    async function put(
      bucket: MockR2Bucket,
      clientId: string | undefined,
      chunkId: string,
      entries: object[]
    ) {
      const key = await buildDiagnosticLogPath({
        pathPrefix: 'diagnostic-logs',
        tenantId: 'tenant-1',
        clientId,
        category: 'auth-decision',
        timestamp: at(0),
        chunkId,
      });
      bucket.store.set(key, entries.map((e) => JSON.stringify(e)).join('\n'));
    }

    async function search(bucket: MockR2Bucket, query: string, kv: Record<string, string> = {}) {
      const response = await exportLogsApp.request(
        `/?tenantId=tenant-1&format=json&categories=auth-decision&startDate=2026-04-21&endDate=2026-04-21&${query}`,
        { headers: authHeaders() },
        createEnv(bucket, kv)
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { logs: Array<Record<string, any>> };
      return body.logs.map((log) => log.details.reason);
    }

    it('finds a dotted id that is stored as it is', async () => {
      const bucket = new MockR2Bucket();
      const stored = await written(
        logEntry('dotted', 'run-2026.10.16-001', 'flow-v1.2.3', 1, 'rp-client')
      );
      expect((stored as any).diagnosticSessionId).toBe('run-2026.10.16-001');
      expect((stored as any).flowId).toBe('flow-v1.2.3');
      await put(bucket, 'rp-client', 'chk_dotted', [
        stored,
        await written(logEntry('other', 'run-2026.10.16-002', 'flow-other', 2, 'rp-client')),
      ]);

      expect(await search(bucket, 'sessionIds=run-2026.10.16-001')).toEqual(['dotted']);
      expect(await search(bucket, 'flowIds=flow-v1.2.3')).toEqual(['dotted']);
    });

    it('finds an id that is stored as a fingerprint by its original value', async () => {
      const bucket = new MockR2Bucket();
      const stored = await written(logEntry('long', LONG_SESSION, LONG_FLOW, 1, 'rp-client'));
      expect((stored as any).diagnosticSessionId).toMatch(/^sha256:[0-9a-f]{12}$/);
      expect((stored as any).flowId).toMatch(/^sha256:[0-9a-f]{12}$/);
      await put(bucket, 'rp-client', 'chk_long', [
        stored,
        await written(logEntry('other', 'session-other', 'flow-other', 2, 'rp-client')),
      ]);

      expect(await search(bucket, `sessionIds=${LONG_SESSION}`)).toEqual(['long']);
      expect(await search(bucket, `flowIds=${LONG_FLOW}`)).toEqual(['long']);
      expect(await search(bucket, 'sessionIds=session-other')).toEqual(['other']);
    });

    it('finds a raw entry written before, by the same original value', async () => {
      const bucket = new MockR2Bucket();
      await put(bucket, 'rp-client', 'chk_legacy', [
        logEntry('legacy', LONG_SESSION, LONG_FLOW, 1, 'rp-client'),
      ]);

      expect(await search(bucket, `sessionIds=${LONG_SESSION}`)).toEqual(['legacy']);
      expect(await search(bucket, `flowIds=${LONG_FLOW}`)).toEqual(['legacy']);
    });

    it.each([12, 40, 64])(
      'finds an id fingerprinted at length %i by its original value and by the stored fingerprint, and merges on it',
      async (length) => {
        const bucket = new MockR2Bucket();
        const settings = {
          [SETTINGS_KEY]: JSON.stringify({
            'diagnostic-logging.token_hash_prefix_length': length,
            'diagnostic-logging.merged_output_enabled': true,
          }),
        };
        const stored = await written(
          logEntry('sdk-n', LONG_SESSION, LONG_FLOW, 1, 'rp-client'),
          length
        );
        const fingerprint = (stored as any).diagnosticSessionId as string;
        const flowFingerprint = (stored as any).flowId as string;
        expect(fingerprint).toMatch(new RegExp(`^sha256:[0-9a-f]{${length}}$`));
        await put(bucket, 'rp-client', 'chk_n_sdk', [stored]);
        await put(bucket, undefined, 'chk_n_server', [
          await written(logEntry('srv-n', LONG_SESSION, LONG_FLOW, 2), length),
          await written(logEntry('srv-other', 'session-other', 'flow-other', 3), length),
        ]);

        // by the original value, and by the fingerprint that was stored (taken as it is)
        for (const session of [LONG_SESSION, fingerprint]) {
          expect(await search(bucket, `sessionIds=${session}`, settings)).toEqual([
            'sdk-n',
            'srv-n',
          ]);
        }
        for (const flow of [LONG_FLOW, flowFingerprint]) {
          expect(await search(bucket, `flowIds=${flow}`, settings)).toEqual(['sdk-n', 'srv-n']);
        }
        // merged: the server entry of the session joins an export limited to the client
        for (const session of [LONG_SESSION, fingerprint]) {
          expect(
            await search(bucket, `clientId=rp-client&sessionIds=${session}`, settings)
          ).toEqual(['sdk-n', 'srv-n']);
        }
        expect(await search(bucket, 'clientId=rp-client', settings)).toEqual(['sdk-n', 'srv-n']);
      }
    );

    it('merges a legacy raw session with the server entries written since as a fingerprint', async () => {
      const bucket = new MockR2Bucket();
      await put(bucket, 'rp-client', 'chk_sdk_legacy', [
        logEntry('sdk-legacy', LONG_SESSION, 'f', 1, 'rp-client'),
      ]);
      await put(bucket, undefined, 'chk_server_new', [
        await written(logEntry('srv-new', LONG_SESSION, 'f', 2)),
      ]);
      const merged = {
        [SETTINGS_KEY]: JSON.stringify({ 'diagnostic-logging.merged_output_enabled': true }),
      };

      expect(await search(bucket, 'clientId=rp-client', merged)).toEqual(['sdk-legacy', 'srv-new']);
    });

    it('merges the server entries of a session that has a fingerprinted id', async () => {
      const bucket = new MockR2Bucket();
      await put(bucket, 'rp-client', 'chk_sdk', [
        await written(logEntry('sdk-1', LONG_SESSION, 'f', 1, 'rp-client')),
      ]);
      await put(bucket, undefined, 'chk_server', [
        await written(logEntry('srv-1', LONG_SESSION, 'f', 2)),
        await written(logEntry('srv-other', 'session-other', 'f', 3)),
      ]);
      const merged = {
        [SETTINGS_KEY]: JSON.stringify({ 'diagnostic-logging.merged_output_enabled': true }),
      };

      expect(await search(bucket, `clientId=rp-client&sessionIds=${LONG_SESSION}`, merged)).toEqual(
        ['sdk-1', 'srv-1']
      );
      expect(await search(bucket, 'clientId=rp-client', merged)).toEqual(['sdk-1', 'srv-1']);
    });
  });
});
