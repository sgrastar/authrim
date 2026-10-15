import { describe, it, expect, vi } from 'vitest';
import { getTenantReachableIssuers } from '../tenant-binding-policy';
import { tenantPrimaryVanityDomainCacheKey } from '../../services/tenant-vanity-domain-resolver';

function kv(documents: Record<string, string>): KVNamespace {
  return {
    get: vi.fn(async (key: string) => documents[key] ?? null),
    put: vi.fn(async () => undefined),
    delete: vi.fn(),
  } as unknown as KVNamespace;
}

function tenantDocument(tenantId: string, settings: Record<string, unknown>) {
  return { [`settings:tenant:${tenantId}:tenant`]: JSON.stringify(settings) };
}

const BASE = { BASE_DOMAIN: 'example.com' };

describe('getTenantReachableIssuers', () => {
  const reachable = (
    env: Record<string, unknown>,
    documents: Record<string, string>,
    tenantId = 'acme'
  ) => {
    const store = kv(documents);
    return getTenantReachableIssuers(
      store,
      { ...env, AUTHRIM_CONFIG: store, SETTINGS: store } as never,
      tenantId
    );
  };

  it('is the subdomain issuer for a normal tenant', async () => {
    await expect(reachable(BASE, {})).resolves.toEqual(['https://acme.example.com']);
  });

  it('is the naked domain for the primary tenant of a naked-domain deployment', async () => {
    await expect(
      reachable({ ...BASE, NAKED_DOMAIN_AS_ISSUER: 'true', PRIMARY_TENANT_ID: 'acme' }, {})
    ).resolves.toEqual(['https://example.com']);
  });

  it('holds both when the primary tenant allows both domains and identifiers', async () => {
    const issuers = await reachable(
      { ...BASE, NAKED_DOMAIN_AS_ISSUER: 'true', PRIMARY_TENANT_ID: 'acme' },
      tenantDocument('acme', {
        'tenant.allowed_domains': 'example.com\nacme.example.com',
        'tenant.allowed_identifiers': 'https://example.com, https://acme.example.com',
      })
    );
    expect(issuers.sort()).toEqual(['https://acme.example.com', 'https://example.com']);
  });

  it('leaves out an allowed domain the router would refuse (its identifier is not allowed)', async () => {
    const issuers = await reachable(
      BASE,
      tenantDocument('acme', {
        'tenant.allowed_domains': 'acme.example.com, sso.acme.example.org',
        'tenant.allowed_identifiers': 'https://acme.example.com',
      })
    );
    expect(issuers).toEqual(['https://acme.example.com']);
  });

  it('holds every allowed domain whose identifier is allowed', async () => {
    const issuers = await reachable(
      BASE,
      tenantDocument('acme', {
        'tenant.allowed_domains': 'acme.example.com, sso.acme.example.org',
        'tenant.allowed_identifiers': 'https://acme.example.com, https://sso.acme.example.org',
      })
    );
    expect(issuers.sort()).toEqual(['https://acme.example.com', 'https://sso.acme.example.org']);
  });

  it('holds the primary custom domain', async () => {
    const vanity = {
      id: 'v1',
      tenant_id: 'acme',
      hostname: 'login.acme.test',
      is_active: true,
      is_primary: true,
      status: 'active',
      cloudflare_zone_id: null,
      cloudflare_custom_hostname_id: null,
      ssl_status: null,
      ownership_status: null,
      validation_method: null,
      validation_records_json: null,
      last_sync_at: null,
      created_by: null,
      created_at: 1,
      updated_at: 1,
    };
    const issuers = await reachable(BASE, {
      [tenantPrimaryVanityDomainCacheKey('acme')]: JSON.stringify(vanity),
    });
    expect(issuers).toContain('https://login.acme.test');
  });

  describe('when the primary custom domain cannot be looked up', () => {
    const failingDb = {
      prepare: () => ({
        bind() {
          return this;
        },
        first: async () => {
          throw new Error('D1 unavailable');
        },
      }),
    };
    const env = { ...BASE, tenantCoreDb: failingDb };

    it('reads as no custom domain for routing', async () => {
      const store = kv({});
      await expect(
        getTenantReachableIssuers(store, { ...env, AUTHRIM_CONFIG: store } as never, 'acme')
      ).resolves.toEqual(['https://acme.example.com']);
    });

    it('throws with strictVanity', async () => {
      const store = kv({});
      await expect(
        getTenantReachableIssuers(store, { ...env, AUTHRIM_CONFIG: store } as never, 'acme', {
          strictVanity: true,
        })
      ).rejects.toThrow();
    });

    it('is fine with strictVanity when the lookup succeeds and finds none', async () => {
      const store = kv({});
      const empty = {
        prepare: () => ({
          bind() {
            return this;
          },
          first: async () => null,
        }),
      };
      await expect(
        getTenantReachableIssuers(
          store,
          { ...BASE, tenantCoreDb: empty, AUTHRIM_CONFIG: store } as never,
          'acme',
          { strictVanity: true }
        )
      ).resolves.toEqual(['https://acme.example.com']);
    });
  });
});
