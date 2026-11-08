import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const resolveVanityHostTenantId = vi.hoisted(() => vi.fn());
vi.mock('@authrim/ar-lib-core', () => ({ resolveVanityHostTenantId }));

import { TenantHostEntrypoint } from '../tenant-host-entrypoint';

const ROUTER_PROPS = {
  caller: 'ar-router',
  audience: 'authrim-tenant-host-v1',
  environmentId: 'prod',
};

function entrypoint(props: unknown = ROUTER_PROPS, env: Partial<Env> = {}) {
  return new TenantHostEntrypoint(
    { props } as unknown as ConstructorParameters<typeof TenantHostEntrypoint>[0],
    { AUTHRIM_ENVIRONMENT_NAME: 'prod', ...env } as Env
  );
}

describe('TenantHostEntrypoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveVanityHostTenantId.mockResolvedValue('acme');
  });

  it('returns the tenant that owns the custom domain', async () => {
    await expect(entrypoint().resolveTenantForHost('login.acme.example')).resolves.toEqual({
      tenantId: 'acme',
    });
    expect(resolveVanityHostTenantId).toHaveBeenCalledWith(
      expect.objectContaining({ AUTHRIM_ENVIRONMENT_NAME: 'prod' }),
      'login.acme.example'
    );
  });

  it('returns null when no tenant owns the domain', async () => {
    resolveVanityHostTenantId.mockResolvedValue(null);
    await expect(entrypoint().resolveTenantForHost('unknown.example')).resolves.toEqual({
      tenantId: null,
    });
  });

  it('throws a generic error when the lookup fails', async () => {
    resolveVanityHostTenantId.mockRejectedValue(new Error('d1 timeout at shard-7'));
    await expect(entrypoint().resolveTenantForHost('login.acme.example')).rejects.toThrow(
      /^tenant_host_lookup_failed$/u
    );
  });

  it.each([
    ['another caller', { ...ROUTER_PROPS, caller: 'ar-auth' }, {}],
    ['another audience', { ...ROUTER_PROPS, audience: 'authrim-other-v1' }, {}],
    ['another environment', { ...ROUTER_PROPS, environmentId: 'staging' }, {}],
    ['no props', null, {}],
    ['no environment name', ROUTER_PROPS, { AUTHRIM_ENVIRONMENT_NAME: undefined }],
  ])('refuses %s', async (_label, props, env) => {
    await expect(entrypoint(props, env).resolveTenantForHost('login.acme.example')).rejects.toThrow(
      'tenant_host_rpc_caller_unauthorized'
    );
    expect(resolveVanityHostTenantId).not.toHaveBeenCalled();
  });

  it.each([undefined, 42, '', 'a b.example', 'evil.example/path', 'x'.repeat(261), '-bad.example'])(
    'returns null without a lookup for a malformed host (%j)',
    async (host) => {
      await expect(entrypoint().resolveTenantForHost(host as string)).resolves.toEqual({
        tenantId: null,
      });
      expect(resolveVanityHostTenantId).not.toHaveBeenCalled();
    }
  );
});
