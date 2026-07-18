import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env, OIDCProviderMetadata } from '@authrim/ar-lib-core';
import { buildTenantSystemSettingsKey } from '@authrim/ar-lib-core';
import { clearDiscoveryMetadataCache, discoveryHandler } from '../discovery';

function createApp(tenantId: string) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as { set: (key: string, value: string) => void }).set('tenantId', tenantId);
    await next();
  });
  app.get('/.well-known/openid-configuration', discoveryHandler);
  return app;
}

describe('tenant-scoped certification profiles', () => {
  beforeEach(() => clearDiscoveryMetadataCache());

  it('enables FAPI metadata only for the configured tenant', async () => {
    const values = new Map<string, string>([
      [
        'system_settings',
        JSON.stringify({ fapi: { enabled: false }, oidc: { requirePar: false } }),
      ],
      [
        buildTenantSystemSettingsKey('fapi2'),
        JSON.stringify({
          fapi: { enabled: true },
          oidc: { requirePar: true, responseTypesSupported: ['code'] },
        }),
      ],
    ]);
    const settings = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
    } as unknown as KVNamespace & { get: ReturnType<typeof vi.fn> };
    const env = {
      BASE_DOMAIN: 'example.com',
      DEFAULT_TENANT_ID: 'default',
      SETTINGS: settings,
      PUBLIC_JWK_JSON: JSON.stringify({
        kty: 'RSA',
        use: 'sig',
        alg: 'RS256',
        kid: 'test-kid',
        n: 'test-modulus',
        e: 'AQAB',
      }),
    } as unknown as Env;

    const fapiResponse = await createApp('fapi2').fetch(
      new Request('https://fapi2.example.com/.well-known/openid-configuration'),
      env
    );
    const defaultResponse = await createApp('default').fetch(
      new Request('https://example.com/.well-known/openid-configuration'),
      env
    );
    const fapi = (await fapiResponse.json()) as OIDCProviderMetadata;
    const standard = (await defaultResponse.json()) as OIDCProviderMetadata;

    expect(fapi.require_pushed_authorization_requests).toBe(true);
    expect(standard.require_pushed_authorization_requests).toBe(false);
    expect(fapi.response_types_supported).toEqual(['code']);
    expect(fapi.grant_types_supported).not.toContain('implicit');
    expect(standard.response_types_supported).toContain('code id_token token');
    expect(standard.grant_types_supported).toContain('implicit');
    expect(settings.get).toHaveBeenCalledWith(buildTenantSystemSettingsKey('fapi2'));
    expect(settings.get).toHaveBeenCalledWith(buildTenantSystemSettingsKey('default'));
  });
});
