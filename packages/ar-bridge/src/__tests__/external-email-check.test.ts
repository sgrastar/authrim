/**
 * The sign-up Flow's check of an external address: when a sign-up through a provider needs its
 * address checked by email code, and that no policy leaves the sign-up as it was.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  loadPolicy: vi.fn(),
  loadTenantPolicy: vi.fn(),
}));
vi.mock('@authrim/ar-lib-core', () => ({
  resolveAuthCorePersistenceAdapterFromEnv: mocks.resolve,
  loadInteractionRegistrationPolicy: mocks.loadPolicy,
  loadTenantRegistrationPolicy: mocks.loadTenantPolicy,
}));

import {
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
  });
});
