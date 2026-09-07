import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '../../types/env';
import { createDiagnosticLoggerFromContext } from '../diagnostic-logging-middleware';

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
