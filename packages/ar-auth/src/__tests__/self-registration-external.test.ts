import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const { query, resolveAdapter } = vi.hoisted(() => {
  const query = vi.fn();
  return { query, resolveAdapter: vi.fn(async () => ({ query })) };
});

vi.mock('@authrim/ar-lib-core', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@authrim/ar-lib-core')),
  resolveAuthCorePersistenceAdapterFromEnv: resolveAdapter,
}));

import { isSelfRegistrationAvailable } from '../authentication-method-settings';

const noOwnMethods = {
  'authentication-methods.passkey.signup_enabled': false,
  'authentication-methods.email_otp.signup_enabled': false,
  'authentication-methods.totp.signup_enabled': false,
};

function envWith(documents: Record<string, unknown>): Env {
  const store = new Map(
    Object.entries(documents).map(([key, value]) => [
      `settings:tenant:t1:${key}`,
      typeof value === 'string' ? value : JSON.stringify(value),
    ])
  );
  return { SETTINGS: { get: async (key: string) => store.get(key) ?? null } } as never;
}

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'prov-1',
  slug: 'corp',
  enabled: 1,
  jit_provisioning: 1,
  ...overrides,
});

describe('isSelfRegistrationAvailable through an external provider', () => {
  beforeEach(() => {
    query.mockReset();
    resolveAdapter.mockClear();
  });

  it('is available for a provider that creates accounts when the tenant has no method of its own', async () => {
    query.mockResolvedValue([row()]);
    expect(
      await isSelfRegistrationAvailable(envWith({ 'authentication-methods': noOwnMethods }), 't1')
    ).toBe(true);
  });

  it("asks for the tenant's enabled providers in the order and number the page lists them", async () => {
    query.mockResolvedValue([row()]);
    await isSelfRegistrationAvailable(envWith({ 'authentication-methods': noOwnMethods }), 't1');
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM upstream_providers');
    expect(sql).toContain('tenant_id = ?');
    expect(sql).toContain('enabled = 1');
    expect(sql).toContain('ORDER BY priority ASC, name ASC');
    expect(params).toEqual(['t1', 20]);
  });

  it('is not available for a provider that only links', async () => {
    query.mockResolvedValue([row({ jit_provisioning: 0 })]);
    expect(
      await isSelfRegistrationAvailable(envWith({ 'authentication-methods': noOwnMethods }), 't1')
    ).toBe(false);
  });

  it('is not available when the provider list cannot be read', async () => {
    query.mockRejectedValue(new Error('D1 down'));
    expect(
      await isSelfRegistrationAvailable(envWith({ 'authentication-methods': noOwnMethods }), 't1')
    ).toBe(false);
  });

  it('is not available when the database of the tenant cannot be resolved', async () => {
    resolveAdapter.mockRejectedValueOnce(new Error('missing_generation'));
    expect(
      await isSelfRegistrationAvailable(envWith({ 'authentication-methods': noOwnMethods }), 't1')
    ).toBe(false);
  });

  it('does not touch the database when JIT provisioning is off, or no provider is listed', async () => {
    query.mockResolvedValue([row()]);
    expect(
      await isSelfRegistrationAvailable(
        envWith({
          'authentication-methods': noOwnMethods,
          'external-idp': { 'external_idp.jit_provisioning_enabled': false },
        }),
        't1'
      )
    ).toBe(false);
    expect(
      await isSelfRegistrationAvailable(
        envWith({
          'authentication-methods': {
            ...noOwnMethods,
            'authentication-methods.external_provider_usage': [],
          },
        }),
        't1'
      )
    ).toBe(false);
    expect(resolveAdapter).not.toHaveBeenCalled();
  });

  it.each([
    ['passkey', { ...noOwnMethods, 'authentication-methods.passkey.signup_enabled': true }],
    ['email code', { ...noOwnMethods, 'authentication-methods.email_otp.signup_enabled': true }],
    ['authenticator app', { ...noOwnMethods, 'authentication-methods.totp.signup_enabled': true }],
  ])('is available with %s alone, without reading the providers', async (_label, methods) => {
    query.mockRejectedValue(new Error('D1 down'));
    expect(
      await isSelfRegistrationAvailable(envWith({ 'authentication-methods': methods }), 't1')
    ).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it('is not available when the authentication-methods settings are damaged, whatever the providers', async () => {
    query.mockResolvedValue([row()]);
    expect(
      await isSelfRegistrationAvailable(envWith({ 'authentication-methods': '{not json' }), 't1')
    ).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});
