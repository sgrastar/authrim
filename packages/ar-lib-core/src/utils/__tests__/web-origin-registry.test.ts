import { describe, expect, it, vi } from 'vitest';
import {
  getWebOriginRegistry,
  invalidateWebOriginRegistryCache,
  isIframeOidcAuthEnabled,
  replaceWebOriginRegistry,
  validateWebOriginRegistryPayload,
} from '../web-origin-registry';
import type { Env } from '../../types/env';
import type { DatabaseAdapter } from '../../db/adapter';

class MockKVNamespace implements KVNamespace {
  store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(): Promise<any> {
    return { keys: [] };
  }

  async getWithMetadata(): Promise<any> {
    return { value: null, metadata: null };
  }
}

function createAdapter(rows: unknown[] = []): DatabaseAdapter {
  return {
    query: vi.fn(async () => rows),
    queryOne: vi.fn(async () => null),
    execute: vi.fn(async () => ({ rowsAffected: 1 })),
  };
}

describe('web origin registry utilities', () => {
  it('reads registry rows from D1 and caches the document', async () => {
    const kv = new MockKVNamespace();
    const env = {
      CLIENTS_CACHE: kv as unknown as KVNamespace,
      AUTHRIM_CONFIG: new MockKVNamespace() as unknown as KVNamespace,
    } as Env;
    const adapter = createAdapter([
      {
        origin: 'https://app.example.com',
        client_id: 'rp_web',
        cors_allowed: 1,
        csp_frame_ancestors: JSON.stringify(['https://app.example.com']),
        handoff_allowed: 1,
        iframe_allowed: 1,
        environment: 'production',
      },
    ]);

    const registry = await getWebOriginRegistry(env, 'tenant_a', 'rp_web', adapter);

    expect(registry.origins).toEqual([
      {
        origin: 'https://app.example.com',
        client_ids: ['rp_web'],
        cors: { allowed: true },
        csp: { frame_ancestors: ['https://app.example.com'] },
        handoff_allowed: true,
        iframe_allowed: true,
        environment: 'production',
      },
    ]);
    expect(adapter.query).toHaveBeenCalledTimes(1);

    const cached = await getWebOriginRegistry(env, 'tenant_a', 'rp_web', adapter);
    expect(cached).toEqual(registry);
    expect(adapter.query).toHaveBeenCalledTimes(1);
  });

  it('replaces registry rows with normalized origin metadata', async () => {
    const adapter = createAdapter();

    const registry = await replaceWebOriginRegistry(adapter, 'tenant_a', 'rp_web', {
      origins: [
        {
          origin: 'https://APP.example.com',
          cors: { allowed: false },
          handoff_allowed: false,
          iframe_allowed: true,
        },
      ],
    });

    expect(registry.origins).toMatchObject([
      {
        origin: 'https://app.example.com',
        cors: { allowed: false },
        handoff_allowed: false,
        iframe_allowed: true,
      },
    ]);
    expect(adapter.execute).toHaveBeenCalledWith(
      'DELETE FROM web_origin_registry WHERE tenant_id = ? AND client_id = ?',
      ['tenant_a', 'rp_web']
    );
  });

  it('supports tenant-level iframe OIDC flags before global flags', async () => {
    const config = new MockKVNamespace();
    await config.put('flag:ENABLE_IFRAME_OIDC_AUTH', 'true');
    await config.put('flag:tenant:tenant_a:ENABLE_IFRAME_OIDC_AUTH', 'false');
    const env = { AUTHRIM_CONFIG: config as unknown as KVNamespace } as Env;

    await expect(isIframeOidcAuthEnabled(env, 'tenant_a')).resolves.toBe(false);
    await expect(isIframeOidcAuthEnabled(env, 'tenant_b')).resolves.toBe(true);
  });

  it('rejects invalid CSP frame ancestor values', async () => {
    const adapter = createAdapter();

    await expect(
      replaceWebOriginRegistry(adapter, 'tenant_a', 'rp_web', {
        origins: [
          {
            origin: 'https://app.example.com',
            csp: { frame_ancestors: ['https://app.example.com/path'] },
          },
        ],
      })
    ).rejects.toThrow('Invalid web_origin_registry frame_ancestors');
  });

  it('validates write payloads without mutating storage', () => {
    expect(
      validateWebOriginRegistryPayload({
        origins: [{ origin: 'https://app.example.com/path' }],
      })
    ).toEqual({
      valid: false,
      error: expect.stringContaining('Invalid web_origin_registry origins'),
    });

    expect(
      validateWebOriginRegistryPayload({
        origins: [{ origin: 'https://app.example.com' }],
      })
    ).toEqual({ valid: true });
  });

  it('invalidates the tenant-scoped cache key', async () => {
    const kv = new MockKVNamespace();
    const env = { CLIENTS_CACHE: kv as unknown as KVNamespace } as Env;
    await kv.put('tenant:tenant_a:web-origin-registry:rp_web', '{}');

    await invalidateWebOriginRegistryCache(env, 'tenant_a', 'rp_web');

    expect(await kv.get('tenant:tenant_a:web-origin-registry:rp_web')).toBeNull();
  });
});
