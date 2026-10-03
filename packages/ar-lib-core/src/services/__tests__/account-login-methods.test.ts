import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import type { Env } from '../../types/env';

const { mockFindById, mockProviderAdapter } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockProviderAdapter: { queryOne: vi.fn() },
}));

vi.mock('../../repositories/identity/canonical-runtime-user-store', () => ({
  CanonicalRuntimeUserStore: vi.fn(function CanonicalRuntimeUserStoreMock() {
    return { findById: mockFindById };
  }),
}));

vi.mock('../auth-core-persistence-context', () => ({
  resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => mockProviderAdapter),
}));

import {
  hasRemainingLoginMethod,
  isAuthenticationMethodUsageAvailable,
  type LoginMethodRemoval,
} from '../account-login-methods';

interface Fixture {
  methods?: Record<string, unknown>;
  passkeys?: string[];
  totp?: string[];
  email?: { email: string | null; email_verified: number } | null;
  linked?: Array<{ id: string; provider_id: string }>;
  enabledProviders?: string[];
}

function setup(fixture: Fixture) {
  const env = {
    SETTINGS: {
      get: vi.fn(async (key: string) =>
        key === 'settings:tenant:t1:authentication-methods' && fixture.methods
          ? JSON.stringify(fixture.methods)
          : null
      ),
    },
  } as unknown as Env;
  const coreAdapter = {
    queryOne: vi.fn(async (sql: string, params: unknown[]) => {
      const skip = params[2];
      if (sql.includes('FROM passkeys')) {
        return { count: (fixture.passkeys ?? []).filter((id) => id !== skip).length };
      }
      if (sql.includes('FROM totp_credentials')) {
        return { count: (fixture.totp ?? []).filter((id) => id !== skip).length };
      }
      throw new Error(`unexpected core query: ${sql}`);
    }),
  } as unknown as DatabaseAdapter;
  const piiAdapter = {
    query: vi.fn(async (_sql: string, params: unknown[]) =>
      (fixture.linked ?? [])
        .filter((row) => row.id !== params[2])
        .map((row) => ({ provider_id: row.provider_id }))
    ),
  } as unknown as DatabaseAdapter;
  mockFindById.mockResolvedValue(fixture.email ?? null);
  mockProviderAdapter.queryOne.mockImplementation(async (_sql: string, params: unknown[]) => ({
    count: params.slice(1).filter((id) => (fixture.enabledProviders ?? []).includes(String(id)))
      .length,
  }));
  return (removing: LoginMethodRemoval) =>
    hasRemainingLoginMethod(env, {
      tenantId: 't1',
      userId: 'u1',
      coreAdapter,
      piiAdapter,
      removing,
    });
}

describe('hasRemainingLoginMethod', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps another passkey while passkey login is on (the default)', async () => {
    const check = setup({ passkeys: ['pk1', 'pk2'] });
    await expect(check({ kind: 'passkey', id: 'pk1' })).resolves.toBe(true);
  });

  it('does not count the passkey being removed', async () => {
    const check = setup({ passkeys: ['pk1'] });
    await expect(check({ kind: 'passkey', id: 'pk1' })).resolves.toBe(false);
  });

  it('does not count passkeys while passkey login is off', async () => {
    const check = setup({
      methods: { 'authentication-methods.passkey.login_enabled': false },
      passkeys: ['pk1'],
      linked: [{ id: 'li1', provider_id: 'google' }],
      enabledProviders: ['google'],
    });
    await expect(check({ kind: 'linked_identity', id: 'li1' })).resolves.toBe(false);
  });

  it('counts a verified email only while email-code login is on', async () => {
    const email = { email: 'a@example.com', email_verified: 1 };
    await expect(
      setup({ email, linked: [{ id: 'li1', provider_id: 'google' }] })({
        kind: 'linked_identity',
        id: 'li1',
      })
    ).resolves.toBe(false);
    await expect(
      setup({
        email,
        methods: { 'authentication-methods.email_otp.login_enabled': true },
      })({ kind: 'linked_identity', id: 'li1' })
    ).resolves.toBe(true);
    await expect(
      setup({
        email: { email: 'a@example.com', email_verified: 0 },
        methods: { 'authentication-methods.email_otp.login_enabled': true },
      })({ kind: 'linked_identity', id: 'li1' })
    ).resolves.toBe(false);
  });

  it('does not count an email the tenant only allows for account linking', async () => {
    const check = setup({
      email: { email: 'a@example.com', email_verified: 1 },
      methods: {
        'authentication-methods.email_otp.enabled': true,
        'authentication-methods.email_otp.login_enabled': false,
        'authentication-methods.email_otp.account_link_enabled': true,
      },
    });
    await expect(check({ kind: 'passkey', id: 'pk1' })).resolves.toBe(false);
  });

  it('counts another active TOTP authenticator only while TOTP login is on', async () => {
    await expect(setup({ totp: ['t1', 't2'] })({ kind: 'totp', id: 't1' })).resolves.toBe(false);
    await expect(
      setup({
        totp: ['t1', 't2'],
        methods: { 'authentication-methods.totp.login_enabled': true },
      })({ kind: 'totp', id: 't1' })
    ).resolves.toBe(true);
  });

  it('counts another linked account only when its provider is enabled', async () => {
    const linked = [
      { id: 'li1', provider_id: 'google' },
      { id: 'li2', provider_id: 'github' },
    ];
    await expect(
      setup({ linked, enabledProviders: ['github'] })({ kind: 'linked_identity', id: 'li1' })
    ).resolves.toBe(true);
    await expect(
      setup({ linked, enabledProviders: ['google'] })({ kind: 'linked_identity', id: 'li1' })
    ).resolves.toBe(false);
  });

  it('lets a linked account keep the user signed in when a passkey is removed', async () => {
    const check = setup({
      passkeys: ['pk1'],
      linked: [{ id: 'li1', provider_id: 'google' }],
      enabledProviders: ['google'],
    });
    await expect(check({ kind: 'passkey', id: 'pk1' })).resolves.toBe(true);
  });
});

describe('isAuthenticationMethodUsageAvailable', () => {
  const env = (methods: Record<string, unknown> | null) =>
    ({
      SETTINGS: { get: vi.fn(async () => (methods ? JSON.stringify(methods) : null)) },
    }) as unknown as Env;

  it('falls back from the usage switch to the method switch to the default', async () => {
    await expect(
      isAuthenticationMethodUsageAvailable(env(null), 't1', 'passkey', 'login')
    ).resolves.toBe(true);
    await expect(
      isAuthenticationMethodUsageAvailable(env(null), 't1', 'totp', 'login')
    ).resolves.toBe(false);
    await expect(
      isAuthenticationMethodUsageAvailable(
        env({ 'authentication-methods.totp.enabled': 'true' }),
        't1',
        'totp',
        'login'
      )
    ).resolves.toBe(true);
    await expect(
      isAuthenticationMethodUsageAvailable(
        env({
          'authentication-methods.totp.enabled': true,
          'authentication-methods.totp.login_enabled': false,
        }),
        't1',
        'totp',
        'login'
      )
    ).resolves.toBe(false);
  });
});
