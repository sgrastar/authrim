/**
 * The issuer of the logout tokens and webhooks of a tenant is the tenant's canonical one: its
 * primary domain, else the configured issuer. It is never made from the host of the request that
 * ended the session, and a lookup that fails does not fall back to another issuer.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db';
import { resolveLogoutIssuer, resolveLogoutIssuerWithRetry } from '../logout-fanout';

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

describe('resolveLogoutIssuerWithRetry', () => {
  const failing = (times: number, row: unknown = primaryDomainRow) => {
    let calls = 0;
    const queryOne = vi.fn(async () => {
      calls += 1;
      if (calls <= times) throw new Error('d1 unavailable');
      return row;
    });
    return {
      env: { BASE_DOMAIN: 'op.example', tenantCoreDb: adapterReturning(queryOne) },
      queryOne,
    };
  };
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

  it('gives the issuer at once when the first lookup works', async () => {
    const sleep = vi.fn(async () => undefined);
    const { env, queryOne } = failing(0);
    await expect(
      resolveLogoutIssuerWithRetry(env as never, 'tenant-a', { sleep, log: log as never })
    ).resolves.toBe('https://login.tenant-a.example');
    expect(queryOne).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('tries again after short pauses and gives the issuer when a later attempt works', async () => {
    const sleep = vi.fn(async () => undefined);
    const { env, queryOne } = failing(2);
    await expect(
      resolveLogoutIssuerWithRetry(env as never, 'tenant-a', { sleep, log: log as never })
    ).resolves.toBe('https://login.tenant-a.example');
    expect(queryOne).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    for (const [ms] of sleep.mock.calls as unknown as number[][]) {
      expect(ms).toBeLessThanOrEqual(1000);
    }
    expect(log.error).not.toHaveBeenCalled();
  });

  it('gives null, and logs it, when every attempt fails; it never throws', async () => {
    const sleep = vi.fn(async () => undefined);
    const { env, queryOne } = failing(10);
    await expect(
      resolveLogoutIssuerWithRetry(env as never, 'tenant-a', { sleep, log: log as never })
    ).resolves.toBeNull();
    expect(queryOne).toHaveBeenCalledTimes(3);
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
