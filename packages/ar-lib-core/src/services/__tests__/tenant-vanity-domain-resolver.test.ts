import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db';
import {
  getPrimaryTenantVanityDomain,
  resolveTenantFromVanityHost,
} from '../tenant-vanity-domain-resolver';

function createMockAdapter(): DatabaseAdapter {
  return {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn(),
  };
}

function createMockKV(): KVNamespace {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ keys: [] }),
    getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

describe('tenant-vanity-domain-resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves tenant IDs from an adapter source and warms the cache', async () => {
    const adapter = createMockAdapter();
    const kv = createMockKV();

    vi.mocked(adapter.queryOne).mockResolvedValueOnce({
      tenant_id: 'tenant-123',
      status: 'active',
      is_active: 1,
    });

    const result = await resolveTenantFromVanityHost(adapter, kv, 'Login.Example.com');

    expect(result).toBe('tenant-123');
    expect(adapter.queryOne).toHaveBeenCalledOnce();
    expect(kv.put).toHaveBeenCalledOnce();
  });

  it('loads the primary vanity domain through the portable adapter helper', async () => {
    const adapter = createMockAdapter();
    const kv = createMockKV();

    vi.mocked(adapter.queryOne).mockResolvedValueOnce({
      id: 'vanity-1',
      tenant_id: 'tenant-123',
      hostname: 'login.example.com',
      is_active: 1,
      is_primary: 1,
      status: 'active',
      cloudflare_zone_id: null,
      cloudflare_custom_hostname_id: null,
      ssl_status: null,
      ownership_status: null,
      validation_method: null,
      validation_records_json: null,
      last_sync_at: null,
      created_by: null,
      created_at: 100,
      updated_at: 200,
    });

    const result = await getPrimaryTenantVanityDomain(
      { DB: adapter as never, AUTHRIM_CONFIG: kv } as never,
      'tenant-123'
    );

    expect(result).toEqual(
      expect.objectContaining({
        tenant_id: 'tenant-123',
        hostname: 'login.example.com',
        is_primary: true,
        is_active: true,
      })
    );
    expect(adapter.queryOne).toHaveBeenCalledOnce();
    expect(kv.put).toHaveBeenCalledOnce();
  });
});
