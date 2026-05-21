import { describe, expect, it } from 'vitest';
import { createDiagnosticLogR2Adapter } from '../diagnostic-log-r2-adapter';
import { createDiagnosticLogger, DiagnosticLogger } from '../diagnostic-logger';
import type { DiagnosticLoggingSettings } from '../../../types/settings/diagnostic-logging';
import type { Env } from '../../../types/env';
import type { DiagnosticLogEntry } from '../types';

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

  async list(): Promise<{ objects: Array<{ key: string }>; truncated: boolean }> {
    return {
      objects: Array.from(this.store.keys()).map((key) => ({ key })),
      truncated: false,
    };
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function createSettings(
  overrides: Partial<DiagnosticLoggingSettings> = {}
): DiagnosticLoggingSettings {
  return {
    'diagnostic-logging.enabled': true,
    'diagnostic-logging.log_level': 'debug',
    'diagnostic-logging.http_request_enabled': true,
    'diagnostic-logging.http_response_enabled': true,
    'diagnostic-logging.token_validation_enabled': true,
    'diagnostic-logging.auth_decision_enabled': true,
    'diagnostic-logging.r2_output_enabled': true,
    'diagnostic-logging.r2_bucket_binding': 'DIAGNOSTIC_LOGS',
    'diagnostic-logging.r2_path_prefix': 'diagnostic-logs',
    'diagnostic-logging.output_format': 'jsonl',
    'diagnostic-logging.buffer_strategy': 'realtime',
    'diagnostic-logging.batch_size': 100,
    'diagnostic-logging.batch_interval_ms': 1000,
    'diagnostic-logging.filter_pii': true,
    'diagnostic-logging.filter_tokens': true,
    'diagnostic-logging.token_hash_prefix_length': 12,
    'diagnostic-logging.http_safe_headers':
      'content-type,user-agent,x-diagnostic-session-id,x-request-id',
    'diagnostic-logging.http_body_schema_aware': true,
    'diagnostic-logging.retention_days': 30,
    'diagnostic-logging.storage_mode.default': 'masked',
    'diagnostic-logging.storage_mode.by_client': '{}',
    'diagnostic-logging.sdk_ingest_enabled': true,
    'diagnostic-logging.merged_output_enabled': false,
    ...overrides,
  };
}

function createEnv(bucket: MockR2Bucket): Env {
  return {
    ISSUER_URL: 'https://issuer.example.com',
    OTP_HMAC_SECRET: 'test-secret',
    DIAGNOSTIC_LOGS: bucket as unknown as R2Bucket,
  } as Env;
}

function getStoredEntries(bucket: MockR2Bucket): Array<Record<string, unknown>> {
  const contents = Array.from(bucket.store.values());
  return contents.flatMap((content) =>
    content
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  );
}

describe('DiagnosticLogger', () => {
  it('returns null when diagnostic logging is disabled', () => {
    const bucket = new MockR2Bucket();
    const logger = createDiagnosticLogger({
      env: createEnv(bucket),
      tenantId: 'tenant-1',
      settings: createSettings({
        'diagnostic-logging.enabled': false,
      }),
    });

    expect(logger).toBeNull();
  });

  it('writes sanitized HTTP request logs to R2', async () => {
    const bucket = new MockR2Bucket();
    const logger = new DiagnosticLogger({
      env: createEnv(bucket),
      tenantId: 'tenant-1',
      clientId: 'rp-client',
      settings: createSettings(),
    });

    const request = new Request(
      'https://rp.example.com/token?response_type=code&client_id=rp-client&state=opaque-state&access_token=secret-token',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer top-secret',
          'user-agent': 'Mozilla/5.0 Chrome/123.0.0.0 Safari/537.36',
          'x-diagnostic-session-id': 'session-a',
          'cf-connecting-ip': '203.0.113.42',
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'rp-client',
          client_secret: 'never-log-this',
          code: 'code-1234567890',
        }),
      }
    );

    await logger.logHttpRequest({
      diagnosticSessionId: 'session-a',
      request,
      requestId: 'req-1',
      flowId: 'flow-1',
    });

    const entries = getStoredEntries(bucket);
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.category).toBe('http-request');
    expect(entry.diagnosticSessionId).toBe('session-a');
    expect(entry.requestId).toBe('req-1');

    const headers = entry.headers as Record<string, string>;
    const query = entry.query as Record<string, string>;
    const bodySummary = entry.bodySummary as Record<string, unknown>;

    expect(headers.authorization).toBeUndefined();
    expect(headers['content-type']).toBe('application/json');
    expect(headers['user-agent']).toBe('Chrome/123');
    expect(query.response_type).toBe('code');
    expect(query.client_id).toBe('rp-client');
    expect(query.access_token).toBeUndefined();
    expect(query.state).toContain('hmac:');
    expect(bodySummary.client_secret).toBeUndefined();
    expect(bodySummary.client_id).toBe('rp-client');
    expect(bodySummary.grant_type).toBe('authorization_code');
    expect(bodySummary.code_hash).toBe('sha256:code-123...');
    expect(entry.remoteAddress).toBe('203.0.113.0/24');
  });

  it('writes immutable diagnostic chunk objects instead of appending to an hourly object', async () => {
    const bucket = new MockR2Bucket();
    const logger = new DiagnosticLogger({
      env: createEnv(bucket),
      tenantId: 'tenant-1',
      clientId: 'rp-client',
      settings: createSettings(),
    });

    await logger.logAuthDecision({
      diagnosticSessionId: 'session-a',
      decision: 'allow',
      reason: 'first check',
      requestId: 'req-1',
    });
    await logger.logAuthDecision({
      diagnosticSessionId: 'session-a',
      decision: 'deny',
      reason: 'second check',
      requestId: 'req-2',
    });

    expect(bucket.store.size).toBe(2);
    const keys = Array.from(bucket.store.keys());
    expect(keys.every((key) => key.includes('/v1/'))).toBe(true);
    expect(keys.every((key) => !key.includes('/tenant-1/'))).toBe(true);

    const entries = getStoredEntries(bucket);
    expect(entries).toHaveLength(2);
  });

  it('queries client-scoped immutable chunks without requiring a category filter', async () => {
    const bucket = new MockR2Bucket();
    const adapter = createDiagnosticLogR2Adapter(bucket as unknown as R2Bucket, {
      pathPrefix: 'diagnostic-logs',
      tenantId: 'tenant-1',
      clientId: 'client-a',
    });
    const otherClientAdapter = createDiagnosticLogR2Adapter(bucket as unknown as R2Bucket, {
      pathPrefix: 'diagnostic-logs',
      tenantId: 'tenant-1',
      clientId: 'client-b',
    });
    const baseEntry = {
      tenantId: 'tenant-1',
      level: 'debug',
      timestamp: Date.UTC(2026, 4, 21, 10, 0, 0),
      storageMode: 'masked',
    } satisfies Partial<DiagnosticLogEntry>;

    await adapter.writeLogBatch([
      {
        ...baseEntry,
        id: 'tok-1',
        clientId: 'client-a',
        category: 'token-validation',
        step: 'issuer-check',
        result: 'pass',
      },
      {
        ...baseEntry,
        id: 'auth-1',
        clientId: 'client-a',
        category: 'auth-decision',
        decision: 'allow',
        reason: 'ok',
      },
    ] as DiagnosticLogEntry[]);
    await otherClientAdapter.writeLog({
      ...baseEntry,
      id: 'tok-2',
      clientId: 'client-b',
      category: 'token-validation',
      step: 'issuer-check',
      result: 'pass',
    } as DiagnosticLogEntry);

    const result = await adapter.query({
      tenantId: 'tenant-1',
      clientId: 'client-a',
      limit: 10,
    });

    expect(result.entries.map((entry) => entry.id).sort()).toEqual(['auth-1', 'tok-1']);
  });

  it('skips schema-aware request body summaries when the cloned body is oversized', async () => {
    const bucket = new MockR2Bucket();
    const logger = new DiagnosticLogger({
      env: createEnv(bucket),
      tenantId: 'tenant-1',
      clientId: 'rp-client',
      settings: createSettings(),
    });

    const request = new Request('https://rp.example.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(70 * 1024) }),
    });

    await logger.logHttpRequest({
      request,
      requestId: 'req-oversized',
    });

    const entries = getStoredEntries(bucket);
    expect(entries).toHaveLength(1);
    expect(entries[0].bodySummary).toBeUndefined();
  });

  it('applies minimal privacy transforms to token validation logs before writing', async () => {
    const bucket = new MockR2Bucket();
    const logger = new DiagnosticLogger({
      env: createEnv(bucket),
      tenantId: 'tenant-1',
      clientId: 'minimal-client',
      settings: createSettings({
        'diagnostic-logging.storage_mode.by_client': JSON.stringify({
          'minimal-client': 'minimal',
        }),
      }),
    });

    await logger.logTokenValidation({
      diagnosticSessionId: 'session-b',
      step: 'token-response',
      tokenType: 'id_token',
      token: 'raw-id-token-value',
      result: 'fail',
      errorMessage: 'email leak test@example.com should be redacted',
      details: {
        access_token: 'access-token-value',
        id_token: 'id-token-value',
        refresh_token: 'refresh-token-value',
      },
      requestId: 'req-2',
      flowId: 'flow-2',
    });

    const entries = getStoredEntries(bucket);
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.category).toBe('token-validation');
    expect(entry.tokenHash).toBeUndefined();
    expect(entry.errorMessage).toBe('email leak [EMAIL_REDACTED] should be redacted');

    const details = entry.details as Record<string, unknown>;
    expect(details.access_token).toBeUndefined();
    expect(details.id_token).toBeUndefined();
    expect(details.refresh_token).toBeUndefined();
    expect(details.has_access_token).toBe(true);
    expect(details.has_id_token).toBe(true);
  });
});
