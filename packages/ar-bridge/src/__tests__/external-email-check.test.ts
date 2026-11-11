/**
 * The sign-up Flow's check of an external address: when a sign-up through a provider needs its
 * address checked by email code, and that no policy leaves the sign-up as it was.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  loadPolicy: vi.fn(),
  loadTenantPolicy: vi.fn(),
  flowRefs: vi.fn(),
  methodProfile: vi.fn(),
  sessionTtl: vi.fn(),
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  normalizeMethodHandle: (await importOriginal<typeof import('@authrim/ar-lib-core')>())
    .normalizeMethodHandle,
  profileAllowsHandle: (await importOriginal<typeof import('@authrim/ar-lib-core')>())
    .profileAllowsHandle,
  loadInteractionFlowProfileRefs: mocks.flowRefs,
  readAuthenticationProfile: mocks.methodProfile,
  resolveProfiledSessionTtl: mocks.sessionTtl,
  resolveAuthCorePersistenceAdapterFromEnv: mocks.resolve,
  loadInteractionRegistrationPolicy: mocks.loadPolicy,
  loadTenantRegistrationPolicy: mocks.loadTenantPolicy,
}));

import {
  externalSessionProfile,
  externalEmailCheckNeeded,
  loadExternalSignUpPolicy,
  providerHandle,
} from '../services/external-email-check';

describe('externalEmailCheckNeeded', () => {
  const trusted = { email: 'a@example.com', emailVerified: true, trustEmail: true };

  it.each([null, undefined, []])('checks nothing under %j (no policy: unchanged)', (checks) => {
    expect(externalEmailCheckNeeded(checks, { email: null })).toBeNull();
    expect(externalEmailCheckNeeded(checks, { email: 'a@example.com' })).toBeNull();
  });

  it('no_email: the provider gave no address', () => {
    expect(externalEmailCheckNeeded(['no_email'], { email: undefined })).toBe('no_email');
    expect(externalEmailCheckNeeded(['no_email'], { email: '  ' })).toBe('no_email');
    expect(externalEmailCheckNeeded(['no_email'], trusted)).toBeNull();
  });

  it('unverified: an address the provider did not mark verified', () => {
    expect(externalEmailCheckNeeded(['unverified'], { ...trusted, emailVerified: false })).toBe(
      'unverified'
    );
    expect(externalEmailCheckNeeded(['unverified'], { ...trusted, emailVerified: undefined })).toBe(
      'unverified'
    );
    expect(externalEmailCheckNeeded(['unverified'], trusted)).toBeNull();
    // No address at all is the no_email case, not this one.
    expect(externalEmailCheckNeeded(['unverified'], { email: null })).toBeNull();
  });

  it('low_trust: a provider whose trust_email is not on', () => {
    expect(externalEmailCheckNeeded(['low_trust'], { ...trusted, trustEmail: false })).toBe(
      'low_trust'
    );
    expect(externalEmailCheckNeeded(['low_trust'], { ...trusted, trustEmail: undefined })).toBe(
      'low_trust'
    );
    expect(externalEmailCheckNeeded(['low_trust'], trusted)).toBeNull();
  });

  it('only the checks the policy lists apply', () => {
    const untrusted = { email: 'a@example.com', emailVerified: false, trustEmail: false };
    expect(externalEmailCheckNeeded(['no_email'], untrusted)).toBeNull();
    expect(externalEmailCheckNeeded(['low_trust'], { email: null })).toBe('low_trust');
  });
});

describe('loadExternalSignUpPolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolve.mockResolvedValue({ db: true });
  });

  it('is the policy of the live registration Flow the start named', async () => {
    const policy = { external_email_check: ['no_email', 'low_trust'] };
    mocks.loadPolicy.mockResolvedValueOnce({ policy, profileRef: 'members', live: true });
    await expect(loadExternalSignUpPolicy({} as never, 't1', 'i1')).resolves.toEqual({
      policy,
      profileRef: 'members',
    });
    expect(mocks.loadPolicy).toHaveBeenCalledWith({ db: true }, 't1', 'i1');
    expect(mocks.loadTenantPolicy).not.toHaveBeenCalled();
  });

  it('is the tenant’s own when the start named another kind of interaction, or none', async () => {
    const tenant = { policy: { eligibility: 'invite' }, profileRef: 'default' };
    mocks.loadTenantPolicy.mockResolvedValue(tenant);
    mocks.loadPolicy.mockResolvedValueOnce(null);
    await expect(loadExternalSignUpPolicy({} as never, 't1', 'login-interaction')).resolves.toBe(
      tenant
    );
    await expect(loadExternalSignUpPolicy({} as never, 't1', undefined)).resolves.toBe(tenant);
  });

  it('names a provider as the runtime does', () => {
    expect(providerHandle({ slug: 'Google', id: 'p1' })).toBe('google');
    expect(providerHandle({ id: 'Okta Corp' })).toBe('okta_corp');
    expect(providerHandle({ id: `__a${'_'.repeat(50_000)}` })).toBe('a');
  });
});

describe('externalSessionProfile', () => {
  const env = {} as never;
  const refs = (overrides: Record<string, unknown> = {}) => ({
    methodProfileRef: 'default',
    sessionProfileRef: 'short',
    flowKind: 'login',
    completion: null,
    live: true,
    ...overrides,
  });

  beforeEach(() => {
    mocks.resolve.mockReset().mockResolvedValue({});
    mocks.flowRefs.mockReset();
    mocks.methodProfile.mockReset();
    mocks.loadPolicy.mockReset().mockResolvedValue(null);
    mocks.loadTenantPolicy.mockReset().mockResolvedValue(null);
    mocks.sessionTtl
      .mockReset()
      .mockImplementation(
        async (_env: unknown, _tenant: string, _context: string, ref: string) => ({
          ttl: { seconds: ref === 'short' ? 60 : 3600 },
          snapshot: {},
        })
      );
  });

  it('makes a sign-in’s session by its Flow’s session profile', async () => {
    mocks.flowRefs.mockResolvedValue(refs());
    const result = await externalSessionProfile(env, {
      tenantId: 't',
      interactionId: 'i-1',
      provider: { id: 'google' },
      isNewUser: false,
    });
    expect(result.allowed).toBe(true);
    expect(result.profiled.ttl.seconds).toBe(60);
  });

  it('refuses a provider the Flow’s method profile does not take', async () => {
    mocks.flowRefs.mockResolvedValue(refs({ methodProfileRef: 'members' }));
    mocks.methodProfile.mockResolvedValue({
      kind: 'profile',
      values: {
        'authentication-methods.external_provider_usage': [
          { id: 'google', enabled: true, loginEnabled: false },
        ],
      },
    });
    const result = await externalSessionProfile(env, {
      tenantId: 't',
      interactionId: 'i-1',
      provider: { id: 'google' },
      isNewUser: false,
    });
    expect(result.allowed).toBe(false);
  });

  it('uses no stale Flow’s profiles once its interaction is gone or no longer live', async () => {
    const input = {
      tenantId: 't',
      interactionId: 'i-1',
      provider: { id: 'google' },
      isNewUser: false,
    };
    mocks.flowRefs.mockResolvedValue(refs({ live: false, methodProfileRef: 'members' }));
    const stale = await externalSessionProfile(env, input);
    expect(stale.allowed).toBe(true);
    expect(stale.profiled.ttl.seconds).toBe(3600);
    expect(mocks.methodProfile).not.toHaveBeenCalled();
    mocks.flowRefs.mockResolvedValue(null);
    expect((await externalSessionProfile(env, input)).profiled.ttl.seconds).toBe(3600);
    // One that cannot be read refuses the sign-in.
    mocks.flowRefs.mockRejectedValue(new Error('d1 down'));
    await expect(externalSessionProfile(env, input)).rejects.toThrow('d1 down');
  });

  it('makes a sign-up’s session by the registration Flow it was held to', async () => {
    mocks.loadTenantPolicy.mockResolvedValue({
      policy: {},
      profileRef: 'default',
      sessionProfileRef: 'short',
    });
    const result = await externalSessionProfile(env, {
      tenantId: 't',
      interactionId: undefined,
      provider: { id: 'google' },
      isNewUser: true,
    });
    expect(result.profiled.ttl.seconds).toBe(60);
    expect(mocks.flowRefs).not.toHaveBeenCalled();
  });
});
