import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const resolveVanityHostTenantId = vi.hoisted(() => vi.fn());
vi.mock('@authrim/ar-lib-core', () => ({ resolveVanityHostTenantId }));

import { TENANT_HOST_RPC_AUDIENCE, TenantHostEntrypoint } from '../tenant-host-entrypoint';

function entrypoint(): TenantHostEntrypoint {
  return new TenantHostEntrypoint(
    {
      props: { caller: 'ar-router', audience: TENANT_HOST_RPC_AUDIENCE, environmentId: 'prod' },
    } as unknown as ConstructorParameters<typeof TenantHostEntrypoint>[0],
    { AUTHRIM_ENVIRONMENT_NAME: 'prod' } as Env
  );
}

describe('TenantHostEntrypoint host validation (exact limits)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveVanityHostTenantId.mockResolvedValue('acme');
  });

  const label = (length: number) => 'a'.repeat(length);

  it('names the audience of the Router call', () => {
    expect(TENANT_HOST_RPC_AUDIENCE).toBe('authrim-tenant-host-v1');
  });

  it.each([
    ['upper-case letters', 'Login.Acme.Example'],
    ['a five-digit port', 'login.acme.example:65535'],
    ['a single-label host', 'localhost'],
    ['a label of 63 characters', `${label(63)}.example`],
    ['hyphens inside a label', 'a-b-c.example'],
    ['a digit at both ends of a label', '1a1.example'],
  ])('looks up a host with %s', async (_label, host) => {
    await expect(entrypoint().resolveTenantForHost(host)).resolves.toEqual({ tenantId: 'acme' });
    expect(resolveVanityHostTenantId).toHaveBeenCalledWith(expect.anything(), host);
  });

  it.each([
    ['a label of 64 characters', `${label(64)}.example`],
    ['a six-digit port', 'login.acme.example:123456'],
    ['an empty port', 'login.acme.example:'],
    ['a trailing dot', 'login.acme.example.'],
    ['an empty label', 'login..example'],
    ['a label ending in a hyphen', 'login-.example'],
    ['an underscore', 'log_in.example'],
    ['a newline after the host', 'login.example\n'],
  ])('does not look up a host with %s', async (_label, host) => {
    await expect(entrypoint().resolveTenantForHost(host)).resolves.toEqual({ tenantId: null });
    expect(resolveVanityHostTenantId).not.toHaveBeenCalled();
  });

  it('accepts a 253-character hostname with a port', async () => {
    const host = `${label(63)}.${label(63)}.${label(63)}.${label(61)}:8080`;
    expect(host.split(':')[0]).toHaveLength(253);
    await expect(entrypoint().resolveTenantForHost(host)).resolves.toEqual({ tenantId: 'acme' });
  });

  it.each([
    ['without a port', ''],
    ['with a port', ':8080'],
  ])('does not look up a 254-character hostname %s', async (_label, port) => {
    const hostname = `${label(63)}.${label(63)}.${label(63)}.${label(62)}`;
    expect(hostname).toHaveLength(254);
    await expect(entrypoint().resolveTenantForHost(`${hostname}${port}`)).resolves.toEqual({
      tenantId: null,
    });
    expect(resolveVanityHostTenantId).not.toHaveBeenCalled();
  });

  it('does not look up a 255-character hostname with the longest port', async () => {
    const hostname = `${label(63)}.${label(63)}.${label(63)}.${label(63)}`;
    expect(hostname).toHaveLength(255);
    await expect(entrypoint().resolveTenantForHost(`${hostname}:65535`)).resolves.toEqual({
      tenantId: null,
    });
  });

  it('does not look up a host far beyond any valid length', async () => {
    const host = `${label(63)}.${label(63)}.${label(63)}.${label(63)}.${label(63)}.${label(63)}`;
    expect(host.length).toBeGreaterThan(260);
    await expect(entrypoint().resolveTenantForHost(host)).resolves.toEqual({ tenantId: null });
    expect(resolveVanityHostTenantId).not.toHaveBeenCalled();
  });
});
