import { describe, expect, it, vi } from 'vitest';
import {
  listCertificationProfileTenants,
  planPlatformImport,
  planTenantProfileImport,
  readGlobalSystemSettings,
} from '../legacy-settings-import';

function kv(values: Record<string, unknown>, pageSize = 1000): KVNamespace {
  const names = Object.keys(values).sort();
  return {
    get: vi.fn(async (key: string) => {
      const value = values[key];
      if (value instanceof Error) throw value;
      if (value === undefined) return null;
      return typeof value === 'string' ? value : JSON.stringify(value);
    }),
    list: vi.fn(async ({ prefix, cursor }: { prefix?: string; cursor?: string }) => {
      const matching = names.filter((name) => !prefix || name.startsWith(prefix));
      const start = cursor ? Number(cursor) : 0;
      const page = matching.slice(start, start + pageSize);
      const next = start + pageSize;
      return {
        keys: page.map((name) => ({ name })),
        list_complete: next >= matching.length,
        cursor: String(next),
      };
    }),
  } as unknown as KVNamespace;
}

describe('listCertificationProfileTenants', () => {
  it('finds the tenants with a profile, a page at a time', async () => {
    const store = kv(
      {
        'settings:tenant:a:certification-profile': {},
        'settings:tenant:a:oauth': {},
        'settings:tenant:b:certification-profile': {},
        'settings:tenant:c:certification-profile': {},
        'settings:tenant:bad id:certification-profile': {},
      },
      2
    );
    const tenants: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await listCertificationProfileTenants(store, cursor, 2);
      tenants.push(...page.tenants);
      cursor = page.cursor;
      pages += 1;
    } while (cursor);
    expect(tenants).toEqual(['a', 'b', 'c']);
    expect(pages).toBe(3);
  });
});

describe('planPlatformImport and planTenantProfileImport', () => {
  it('plans platform values per store, and each profile as its tenant’s values', async () => {
    const env = {
      SETTINGS: kv({
        system_settings: {
          fapi: { enabled: false },
          conformance: { enabled: true },
          oidc: { tokenExchange: { enabled: true } },
        },
        'settings:tenant:acme:certification-profile': {
          fapi: { enabled: true },
          conformance: { enabled: false },
        },
        'policy:flags:ENABLE_ABAC': 'true',
      }),
      AUTHRIM_CONFIG: kv({ 'oauth:config:TOKEN_EXPIRY': '900' }),
      ENABLE_TOKEN_EXCHANGE: 'true',
      FAPI_ALLOW_PUBLIC_CLIENTS: 'false',
    };

    const writes = [
      ...(await planPlatformImport(env)),
      ...(await planTenantProfileImport(env, 'acme', await readGlobalSystemSettings(env))),
    ];
    const platform = (category: string) =>
      Object.assign(
        {},
        ...writes
          .filter((write) => write.scope.type === 'platform' && write.category === category)
          .map((write) => write.values)
      );

    expect(platform('oauth')).toEqual({ 'oauth.access_token_expiry': 900 });
    expect(platform('security')).toEqual({ 'security.fapi_enabled': false });
    expect(platform('tokens')).toEqual({ 'tokens.exchange_enabled': true });
    expect(platform('feature-flags')).toMatchObject({
      'feature.enable_abac': true,
      'feature.conformance_enabled': true,
    });

    const tenant = writes.filter((write) => write.scope.type === 'tenant');
    // Only the sections the profile replaces; platform-only settings (conformance) stay out.
    expect(tenant.map((write) => write.category).sort()).toEqual(['oauth', 'security']);
    expect(tenant.find((write) => write.category === 'security')).toMatchObject({
      scope: { type: 'tenant', id: 'acme' },
      values: {
        'security.fapi_enabled': true,
        // Left out of the profile's section: what applied (env, else the default).
        'security.fapi_allow_public_clients': false,
        'security.fapi_strict_dpop': true,
        'security.require_signed_request_object': false,
        'security.dpop_required': 'with_fapi',
        // No list: authorization never limited it.
        'security.authorization_signing_algs': '',
      },
    });
    // The FAPI request_uri lifetime lives in the fapi section too: none, the PAR lifetime applies.
    expect(tenant.find((write) => write.category === 'oauth')?.values).toEqual({
      'oauth.par_fapi_ttl': 0,
    });
  });

  it('fails when a store cannot be read', async () => {
    const env = {
      SETTINGS: kv({ system_settings: new Error('kv unavailable') }),
      AUTHRIM_CONFIG: kv({}),
    };
    await expect(planPlatformImport(env)).rejects.toThrow();
    await expect(readGlobalSystemSettings(env)).rejects.toThrow();
  });
});
