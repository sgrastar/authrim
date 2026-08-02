import { describe, expect, it, vi } from 'vitest';
import { createControlApiClients } from '../control-api-clients';
import type { ControlEnv } from '../types';

function env(overrides: Partial<ControlEnv> = {}): ControlEnv {
  return {
    CONTROL_DB: {} as D1Database,
    MIGRATION_RELEASES: {} as ControlEnv['MIGRATION_RELEASES'],
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_D1_API_TOKEN: 'd1-token',
    CLOUDFLARE_WORKERS_API_TOKEN: 'workers-token',
    ...overrides,
  };
}

describe('Control API client composition', () => {
  it('uses only the operation-specific D1 and Workers tokens', async () => {
    const fetcher = vi.fn(async (url: string, init: NonNullable<Parameters<typeof fetch>[1]>) => {
      const authorization = new Headers(init.headers).get('Authorization');
      if (url.includes('/d1/database')) {
        expect(authorization).toBe('Bearer d1-token');
        return Response.json({ success: true, result: [] });
      }
      if (url.endsWith('/workers/scripts')) {
        expect(authorization).toBe('Bearer workers-token');
        return Response.json({ success: true, result: [] });
      }
      throw new Error('unexpected_provider_path');
    });
    const clients = createControlApiClients(env(), { fetcher });

    await expect(clients.d1.listD1Databases()).resolves.toEqual([]);
    await expect(clients.workers.listWorkerScripts()).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('fails before provider access when optional KV or R2 capability is absent', async () => {
    const fetcher = vi.fn();
    const clients = createControlApiClients(env(), { fetcher });

    await expect(clients.kv.listKvNamespaces()).rejects.toThrow(
      'cloudflare_kv_token_required_for:kv.namespace.list'
    );
    await expect(clients.r2.listR2Buckets()).rejects.toThrow(
      'cloudflare_r2_token_required_for:r2.bucket.list'
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
