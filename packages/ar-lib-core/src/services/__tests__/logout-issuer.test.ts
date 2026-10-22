/**
 * The issuer of the logout tokens and webhooks of a tenant is the tenant's canonical one: its
 * primary domain, else the configured issuer. It is never made from the host of the request that
 * ended the session, and a lookup that fails does not fall back to another issuer.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db';
import { resolveLogoutIssuer } from '../logout-fanout';

function adapterReturning(queryOne: ReturnType<typeof vi.fn>): DatabaseAdapter {
  return {
    query: vi.fn(),
    queryOne,
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn(),
  } as unknown as DatabaseAdapter;
}

const primaryDomainRow = {
  id: 'vanity-1',
  tenant_id: 'tenant-a',
  hostname: 'login.tenant-a.example',
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
};

describe('resolveLogoutIssuer', () => {
  it("is the tenant's primary domain when it has one", async () => {
    const env = {
      BASE_DOMAIN: 'op.example',
      tenantCoreDb: adapterReturning(vi.fn(async () => primaryDomainRow)),
    };
    await expect(resolveLogoutIssuer(env as never, 'tenant-a')).resolves.toBe(
      'https://login.tenant-a.example'
    );
  });

  it('is the configured issuer of the tenant when it has no primary domain', async () => {
    const env = {
      BASE_DOMAIN: 'op.example',
      tenantCoreDb: adapterReturning(vi.fn(async () => null)),
    };
    await expect(resolveLogoutIssuer(env as never, 'tenant-a')).resolves.toBe(
      'https://tenant-a.op.example'
    );
  });

  it('does not sign with another issuer when the primary domain cannot be read', async () => {
    const env = {
      BASE_DOMAIN: 'op.example',
      tenantCoreDb: adapterReturning(
        vi.fn(async () => {
          throw new Error('d1 unavailable');
        })
      ),
    };
    await expect(resolveLogoutIssuer(env as never, 'tenant-a')).rejects.toThrow('d1 unavailable');
  });

  it('throws when no issuer is configured at all', async () => {
    const env = { tenantCoreDb: adapterReturning(vi.fn(async () => null)) };
    await expect(resolveLogoutIssuer(env as never, 'tenant-a')).rejects.toThrow(
      'logout_issuer_unavailable'
    );
  });
});
