import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono, type Context } from 'hono';
import { logProducerFixture } from '../../services/__tests__/log-iceberg-producer-fixture';
import type { Env } from '../../types/env';
import {
  createDiagnosticLoggerFromContext,
  diagnosticLoggingMiddleware,
} from '../diagnostic-logging-middleware';

vi.mock('@authrim/ar-lib-logging/iceberg/capabilities', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-logging/iceberg/capabilities')>()),
  LOG_ARCHIVE_IMPLEMENTED_MODES: ['scheduled', 'pipeline'],
}));
const close: (() => void)[] = [];
afterEach(() => close.splice(0).forEach((fn) => fn()));

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
  const SETTINGS_KEY = 'settings:tenant:tenant-1:diagnostic-logging';

  async function createApp(settings: KVNamespace) {
    const f = await logProducerFixture('scheduled', { tenantId: 'tenant-1' });
    close.push(f.close);
    const env = {
      ...f.env,
      SETTINGS: settings,
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
    const stored = async () =>
      (await f.rows('diagnostic.diagnostic_log', 'tenant-1'))
        .map((row) => String(row.entry_json))
        .join('\n');
    return { call, stored };
  }

  const FULL_MODE = {
    'diagnostic-logging.enabled': true,
    'diagnostic-logging.storage_mode.default': 'full',
  };

  it('logs nothing on the first request after a cold start, then redacts the client address', async () => {
    const { call, stored } = await createApp(
      createKV({ [SETTINGS_KEY]: JSON.stringify(FULL_MODE) })
    );

    await call();
    // until the tenant's settings are read the defaults apply: logging off
    expect(await stored()).toBe('');

    await call();
    expect((await stored()).length).toBeGreaterThan(0);
    expect(await stored()).not.toContain('203.0.113.42');
    expect(await stored()).toContain('203.0.113.0/24');
  });

  it('shows the client address in full mode only when the filter is explicitly off', async () => {
    const { call, stored } = await createApp(
      createKV({
        [SETTINGS_KEY]: JSON.stringify({ ...FULL_MODE, 'diagnostic-logging.filter_pii': false }),
      })
    );

    await call();
    await call();
    expect(await stored()).toContain('203.0.113.42');
  });

  it('logs nothing when the tenant settings cannot be read', async () => {
    const failing = createKV({});
    (failing.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('kv down'));
    const { call, stored } = await createApp(failing);

    await call();
    await call();
    expect(await stored()).toBe('');
  });

  it.each([['jane@example.com'], ['Bearer abc.def'], ['a'.repeat(300)], ['id with spaces']])(
    'does not adopt a client-supplied request id that is not a plain identifier (%s)',
    async (supplied) => {
      for (const filter of [true, false]) {
        const { call, stored } = await createApp(
          createKV({
            [SETTINGS_KEY]: JSON.stringify({
              ...FULL_MODE,
              'diagnostic-logging.filter_pii': filter,
            }),
          })
        );
        await call();
        await call({ 'x-request-id': supplied });

        const text = await stored();
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toContain(supplied);
        expect(text).toMatch(/"requestId":"[0-9a-f-]{36}"/);
      }
    }
  );

  it('adopts a plain request id', async () => {
    const { call, stored } = await createApp(
      createKV({ [SETTINGS_KEY]: JSON.stringify(FULL_MODE) })
    );
    await call();
    await call({ 'x-request-id': 'req-123' });
    expect(await stored()).toContain('"requestId":"req-123"');
  });
});
