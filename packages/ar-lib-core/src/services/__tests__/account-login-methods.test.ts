import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import type { Env } from '../../types/env';

const { mockFindById, mockProviderAdapter, mockResolveRoute, mockChallengeStore } = vi.hoisted(
  () => ({
    mockFindById: vi.fn(),
    mockProviderAdapter: { query: vi.fn() },
    mockResolveRoute: vi.fn(),
    mockChallengeStore: {
      claimChallengeRpc: vi.fn(),
      isClaimHeldRpc: vi.fn(),
      consumeChallengeRpc: vi.fn(),
    },
  })
);

vi.mock('../../repositories/identity/canonical-runtime-user-store', () => ({
  CanonicalRuntimeUserStore: vi.fn(function CanonicalRuntimeUserStoreMock() {
    return { findById: mockFindById };
  }),
}));

vi.mock('../auth-core-persistence-context', () => ({
  resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => mockProviderAdapter),
}));

vi.mock('../runtime-data-context', () => ({
  resolveAccountDataContextByIdentifier: mockResolveRoute,
}));

vi.mock('../../utils/challenge-sharding', () => ({
  getChallengeStoreForLease: vi.fn(() => mockChallengeStore),
}));

import {
  hasRemainingLoginMethod,
  isAuthenticationMethodUsageAvailable,
  LoginMethodRemovalInProgressError,
  withLoginMethodRemovalLock,
  type LoginMethodRemoval,
} from '../account-login-methods';

interface Fixture {
  methods?: Record<string, unknown>;
  passkeys?: string[];
  totp?: string[];
  email?: { email: string | null; email_verified: number } | null;
  linked?: Array<{ id: string; provider_id: string }>;
  enabledProviders?: string[];
  /** Whose account each external subject's directory route reaches (absent: unpublished). */
  routes?: Record<string, string>;
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
        .map((row) => ({ provider_id: row.provider_id, provider_user_id: `sub-${row.id}` }))
    ),
  } as unknown as DatabaseAdapter;
  mockFindById.mockResolvedValue(fixture.email ?? null);
  mockProviderAdapter.query.mockImplementation(async (_sql: string, params: unknown[]) =>
    params
      .slice(1)
      .filter((id) => (fixture.enabledProviders ?? []).includes(String(id)))
      .map((id) => ({ id }))
  );
  const routes = fixture.routes ?? {
    ...Object.fromEntries((fixture.linked ?? []).map((row) => [`sub-${row.id}`, 'u1'])),
    ...(fixture.email?.email ? { [fixture.email.email]: 'u1' } : {}),
  };
  mockResolveRoute.mockImplementation(
    async (_env, input: { identifier: string | { subject: string } }) => {
      const key =
        typeof input.identifier === 'string' ? input.identifier : input.identifier.subject;
      const owner = routes[key];
      if (!owner) throw new Error('account_data_route_not_found');
      return { legacyUserId: owner };
    }
  );
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
    const email = { email: 'a@example.com', email_verified: 0 };
    await expect(setup({ email, totp: ['t1', 't2'] })({ kind: 'totp', id: 't1' })).resolves.toBe(
      false
    );
    await expect(
      setup({
        email,
        totp: ['t1', 't2'],
        methods: { 'authentication-methods.totp.login_enabled': true },
      })({ kind: 'totp', id: 't1' })
    ).resolves.toBe(true);
  });

  it('does not count TOTP or email sign-in that cannot find the account by its email', async () => {
    const methods = {
      'authentication-methods.totp.login_enabled': true,
      'authentication-methods.email_otp.login_enabled': true,
    };
    // No email at all: TOTP sign-in has nothing to look the account up by.
    await expect(
      setup({ methods, email: { email: null, email_verified: 0 }, totp: ['t1'] })({
        kind: 'passkey',
        id: 'pk1',
      })
    ).resolves.toBe(false);
    // The email's route is not published, or reaches another account.
    for (const routes of [{}, { 'a@example.com': 'someone-else' }]) {
      await expect(
        setup({
          methods,
          email: { email: 'a@example.com', email_verified: 1 },
          totp: ['t1'],
          routes,
        })({ kind: 'passkey', id: 'pk1' })
      ).resolves.toBe(false);
    }
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

describe('linked accounts and their directory routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const linked = [{ id: 'li2', provider_id: 'google' }];

  it('does not count a link whose route is not published', async () => {
    const check = setup({ passkeys: ['pk1'], linked, enabledProviders: ['google'], routes: {} });
    await expect(check({ kind: 'passkey', id: 'pk1' })).resolves.toBe(false);
  });

  it('does not count a link whose route reaches another account', async () => {
    const check = setup({
      passkeys: ['pk1'],
      linked,
      enabledProviders: ['google'],
      routes: { 'sub-li2': 'someone-else' },
    });
    await expect(check({ kind: 'passkey', id: 'pk1' })).resolves.toBe(false);
  });

  it('lets a directory failure stop the removal', async () => {
    const check = setup({ passkeys: ['pk1'], linked, enabledProviders: ['google'] });
    mockResolveRoute.mockRejectedValueOnce(new Error('lookup unavailable'));
    await expect(check({ kind: 'passkey', id: 'pk1' })).rejects.toThrow('lookup unavailable');
  });
});

describe('withLoginMethodRemovalLock', () => {
  const env = {} as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChallengeStore.consumeChallengeRpc.mockResolvedValue({});
  });

  it('runs the removal under the account lease and releases its own lease', async () => {
    mockChallengeStore.claimChallengeRpc.mockResolvedValueOnce({ claimed: true });

    await expect(withLoginMethodRemovalLock(env, 't1', 'u1', async () => 'done')).resolves.toBe(
      'done'
    );

    const claim = mockChallengeStore.claimChallengeRpc.mock.calls[0][0];
    expect(claim).toMatchObject({
      id: 'login-method-removal:u1',
      tenantId: 't1',
      type: 'login_method_removal_lock',
    });
    expect(mockChallengeStore.consumeChallengeRpc).toHaveBeenCalledWith({
      id: 'login-method-removal:u1',
      tenantId: 't1',
      type: 'login_method_removal_lock',
      challenge: claim.challenge,
    });
  });

  it('lets the removal check, right before its write, that the lease is still its own', async () => {
    mockChallengeStore.claimChallengeRpc.mockResolvedValueOnce({ claimed: true });
    mockChallengeStore.isClaimHeldRpc.mockResolvedValueOnce({ held: true });
    mockChallengeStore.isClaimHeldRpc.mockResolvedValueOnce({ held: false });

    await expect(
      withLoginMethodRemovalLock(env, 't1', 'u1', async (lease) => {
        await lease.assertHeld();
        await lease.assertHeld();
      })
    ).rejects.toBeInstanceOf(LoginMethodRemovalInProgressError);

    const claim = mockChallengeStore.claimChallengeRpc.mock.calls[0][0];
    expect(mockChallengeStore.isClaimHeldRpc).toHaveBeenCalledWith({
      id: 'login-method-removal:u1',
      tenantId: 't1',
      challenge: claim.challenge,
      minRemainingMs: 10_000,
    });
    expect(mockChallengeStore.consumeChallengeRpc).toHaveBeenCalledTimes(1);
  });

  it('refuses while another removal holds the lease', async () => {
    mockChallengeStore.claimChallengeRpc.mockResolvedValueOnce({ claimed: false });
    const removal = vi.fn();

    await expect(withLoginMethodRemovalLock(env, 't1', 'u1', removal)).rejects.toBeInstanceOf(
      LoginMethodRemovalInProgressError
    );
    expect(removal).not.toHaveBeenCalled();
  });

  it('releases the lease when the removal fails', async () => {
    mockChallengeStore.claimChallengeRpc.mockResolvedValueOnce({ claimed: true });

    await expect(
      withLoginMethodRemovalLock(env, 't1', 'u1', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(mockChallengeStore.consumeChallengeRpc).toHaveBeenCalledTimes(1);
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
