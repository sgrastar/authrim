import { describe, expect, it, vi } from 'vitest';
import { Hono, type Context } from 'hono';
import type { Env } from '../../types/env';
import {
  createDiagnosticLoggerFromContext,
  diagnosticLoggingMiddleware,
} from '../diagnostic-logging-middleware';

function createKV(values: Record<string, string>): KVNamespace {
  return {
    get: vi.fn(async (key: string) => values[key] ?? null),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

describe('diagnostic logging settings source', () => {
  it('loads tenant settings from the SETTINGS namespace used by Settings v2', async () => {
    const settings = createKV({
      'settings:tenant:tenant-1:diagnostic-logging': JSON.stringify({
        'diagnostic-logging.enabled': true,
        'diagnostic-logging.r2_output_enabled': false,
      }),
    });
    const legacy = createKV({});
    const env = {
      SETTINGS: settings,
      AUTHRIM_CONFIG: legacy,
    } as unknown as Env;
    const context = {
      env,
      executionCtx: { waitUntil: vi.fn(), passThroughOnException: vi.fn() },
    } as unknown as Context<{ Bindings: Env }>;

    const logger = await createDiagnosticLoggerFromContext(context, {
      tenantId: 'tenant-1',
      clientId: 'client-1',
    });

    expect(logger).not.toBeNull();
    expect(settings.get).toHaveBeenCalledWith('settings:tenant:tenant-1:diagnostic-logging');
    expect(legacy.get).not.toHaveBeenCalled();
  });
});

describe('diagnostic logging PII filter through the middleware', () => {
  class Bucket {
    readonly store = new Map<string, string>();
    async put(key: string, value: string) {
      this.store.set(key, value);
    }
    async get(key: string) {
      const value = this.store.get(key);
      return value === undefined ? null : { text: async () => value };
    }
    async list() {
      return { objects: [...this.store.keys()].map((key) => ({ key })), truncated: false };
    }
  }

  const SETTINGS_KEY = 'settings:tenant:tenant-1:diagnostic-logging';

  function createApp(settings: KVNamespace, bucket: Bucket) {
    const env = {
      SETTINGS: settings,
      DIAGNOSTIC_LOGS: bucket as unknown as R2Bucket,
      OTP_HMAC_SECRET: 'secret',
    } as unknown as Env;
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', diagnosticLoggingMiddleware({ tenantId: 'tenant-1' }));
    app.get('/userinfo', (c) => c.json({ ok: true }));
    const pending: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
      passThroughOnException: vi.fn(),
    };
    const call = async (extraHeaders: Record<string, string> = {}) => {
      const response = await app.request(
        '/userinfo',
        { headers: { 'cf-connecting-ip': '203.0.113.42', ...extraHeaders } },
        env,
        executionCtx as never
      );
      await Promise.all(pending);
      return response;
    };
    return { call };
  }

  function stored(bucket: Bucket): string {
    return [...bucket.store.values()].join('\n');
  }

  const FULL_MODE = {
    'diagnostic-logging.enabled': true,
    'diagnostic-logging.r2_output_enabled': true,
    'diagnostic-logging.buffer_strategy': 'realtime',
    'diagnostic-logging.storage_mode.default': 'full',
  };

  it('logs nothing on the first request after a cold start, then redacts the client address', async () => {
    const bucket = new Bucket();
    const { call } = createApp(createKV({ [SETTINGS_KEY]: JSON.stringify(FULL_MODE) }), bucket);

    await call();
    // until the tenant's settings are read the defaults apply: logging off
    expect(bucket.store.size).toBe(0);

    await call();
    expect(bucket.store.size).toBeGreaterThan(0);
    expect(stored(bucket)).not.toContain('203.0.113.42');
    expect(stored(bucket)).toContain('203.0.113.0/24');
  });

  it('shows the client address in full mode only when the filter is explicitly off', async () => {
    const bucket = new Bucket();
    const { call } = createApp(
      createKV({
        [SETTINGS_KEY]: JSON.stringify({ ...FULL_MODE, 'diagnostic-logging.filter_pii': false }),
      }),
      bucket
    );

    await call();
    await call();
    expect(stored(bucket)).toContain('203.0.113.42');
  });

  it('logs nothing when the tenant settings cannot be read', async () => {
    const bucket = new Bucket();
    const failing = createKV({});
    (failing.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('kv down'));
    const { call } = createApp(failing, bucket);

    await call();
    await call();
    expect(bucket.store.size).toBe(0);
  });

  it.each([['jane@example.com'], ['Bearer abc.def'], ['a'.repeat(300)], ['id with spaces']])(
    'does not adopt a client-supplied request id that is not a plain identifier (%s)',
    async (supplied) => {
      for (const filter of [true, false]) {
        const bucket = new Bucket();
        const { call } = createApp(
          createKV({
            [SETTINGS_KEY]: JSON.stringify({
              ...FULL_MODE,
              'diagnostic-logging.filter_pii': filter,
            }),
          }),
          bucket
        );
        await call();
        await call({ 'x-request-id': supplied });

        const text = stored(bucket);
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toContain(supplied);
        expect(text).toMatch(/"requestId":"[0-9a-f-]{36}"/);
      }
    }
  );

  it('adopts a plain request id', async () => {
    const bucket = new Bucket();
    const { call } = createApp(createKV({ [SETTINGS_KEY]: JSON.stringify(FULL_MODE) }), bucket);
    await call();
    await call({ 'x-request-id': 'req-123' });
    expect(stored(bucket)).toContain('"requestId":"req-123"');
  });
});
