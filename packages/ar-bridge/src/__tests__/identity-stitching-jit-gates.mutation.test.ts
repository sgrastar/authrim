import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTERNAL_IDP_DEFAULTS } from '@authrim/ar-lib-core';
import { ExternalIdPError, ExternalIdPErrorCode, type HandleIdentityParams } from '../types';
import { callArg } from './helpers/mock-args';
import {
  NOW,
  m,
  makeEnv,
  params,
  provider,
  resetIdentityMocks,
  userInfo,
} from './helpers/identity-mocks';

vi.mock('@authrim/ar-lib-core', async (original) =>
  (await import('./helpers/identity-mocks')).libCoreMock(
    await original<typeof import('@authrim/ar-lib-core')>()
  )
);
vi.mock('../services/linked-identity-store', async () => {
  const { m: mocks } = await import('./helpers/identity-mocks');
  return {
    findLinkedIdentity: mocks.findLinked,
    createLinkedIdentity: mocks.createLinked,
    updateLinkedIdentity: mocks.updateLinked,
    findPendingLinkedIdentityProvisioning: mocks.findPending,
    activatePendingLinkedIdentity: mocks.activate,
  };
});
vi.mock('../services/external-usage-gate', async () => ({
  assertExternalProviderUsageAllowed: (await import('./helpers/identity-mocks')).m.gate,
}));

import { handleIdentity } from '../services/identity-stitching';

const ENV = makeEnv();
const jit = (extra: Record<string, unknown> = {}) => ({
  ...EXTERNAL_IDP_DEFAULTS,
  'external_idp.jit_provisioning_enabled': true,
  'external_idp.jit_require_verified_email': false,
  'external_idp.jit_allowed_provider_ids': '',
  'external_idp.jit_default_role_id': '',
  'external_idp.jit_join_all_matching_orgs': false,
  'external_idp.jit_allow_user_without_org': true,
  'external_idp.jit_allow_unverified_domain_mappings': false,
  ...extra,
});

async function failure(promise: Promise<unknown>): Promise<ExternalIdPError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(ExternalIdPError);
  return error as ExternalIdPError;
}

const run = (extra: Partial<HandleIdentityParams> = {}, env = ENV) =>
  handleIdentity(env, params(extra));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetIdentityMocks();
  m.settings.mockResolvedValue(jit());
});
afterEach(() => {
  vi.useRealTimers();
});

describe('which sign-ins may create an account', () => {
  it('refuses a provider that does not provision, with the standard message', async () => {
    const error = await failure(run({ provider: provider({ jitProvisioning: false }) }));
    expect(error.code).toBe(ExternalIdPErrorCode.JIT_PROVISIONING_DISABLED);
    expect(error.message).toContain(
      'New account registration via external providers is not available'
    );
    expect(error.details).toEqual({ providerName: 'Corp' });
    expect(m.provision).not.toHaveBeenCalled();
  });

  it('refuses a sign-in that may not create an account, before any other check', async () => {
    const error = await failure(run({ accountCreationAllowed: false }));
    expect(error.code).toBe(ExternalIdPErrorCode.JIT_PROVISIONING_DISABLED);
    expect(error.message).toBe('Automatic account creation is not available for this sign-in.');
    expect(m.gate).not.toHaveBeenCalled();
    expect(m.settings).not.toHaveBeenCalled();
  });

  it('holds the sign-up to its policy, then to the tenant sign-up switch, before any settings', async () => {
    const order: string[] = [];
    m.gate.mockImplementation(async () => void order.push('gate'));
    await run({
      loadSignUpPolicy: async () => {
        order.push('policy');
        return null;
      },
    });
    expect(order).toEqual(['policy', 'gate']);
    expect(m.gate).toHaveBeenCalledWith(ENV, 'tenant-a', provider(), 'signup');
    m.gate.mockRejectedValue(new Error('signup off'));
    m.provision.mockClear();
    await expect(run()).rejects.toThrow('signup off');
    expect(m.provision).not.toHaveBeenCalled();
    expect(m.settings).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an invite-only policy without an invitation', { eligibility: 'invite' }, undefined, false],
    [
      'an invite-only policy with an invitation',
      { eligibility: 'invite' },
      { invitedEmail: null, requireVerifiedEmail: false },
      true,
    ],
    [
      'a domain policy for an allowed domain',
      { eligibility: 'domain', allowed_domains: ['example.com'] },
      undefined,
      true,
    ],
    [
      'a domain policy for another domain',
      { eligibility: 'domain', allowed_domains: ['corp.test'] },
      undefined,
      false,
    ],
    ['an open policy', { eligibility: 'open' }, undefined, true],
  ])('with %s', async (_n, policy, invitation, allowed) => {
    const loadSignUpPolicy = async () => ({
      policy: { allowed_domains: [], external_email_check: [], ...policy },
      profileRef: 'default',
    });
    const attempt = run({ loadSignUpPolicy, invitation } as never);
    if (allowed) {
      await expect(attempt).resolves.toMatchObject({ status: 'pending' });
    } else {
      const error = await failure(attempt);
      expect(error.code).toBe(ExternalIdPErrorCode.JIT_PROVISIONING_DISABLED);
      expect(error.message).toBe('This sign-up is not open to this account.');
      expect(error.details).toEqual({ providerName: 'Corp' });
    }
  });

  it('refuses a domain policy for a sign-in without an email', async () => {
    const loadSignUpPolicy = async () => ({
      policy: { eligibility: 'domain', allowed_domains: ['example.com'], external_email_check: [] },
      profileRef: 'default',
    });
    const error = await failure(
      run({ loadSignUpPolicy, userInfo: userInfo({ email: undefined }) } as never)
    );
    expect(error.message).toBe('This sign-up is not open to this account.');
  });

  describe('the authentication method profile of the sign-up Flow', () => {
    const open = { eligibility: 'open', allowed_domains: [], external_email_check: [] };
    const withProfile = (values: Record<string, unknown> | 'missing' | 'default') => {
      m.readProfile.mockResolvedValue(
        values === 'missing' || values === 'default'
          ? { kind: values }
          : { kind: 'profile', values }
      );
      return run({
        loadSignUpPolicy: async () => ({ policy: open, profileRef: 'flow-profile' }),
      } as never);
    };

    it('reads the named profile for the tenant', async () => {
      await withProfile('default');
      expect(m.readProfile).toHaveBeenCalledWith(ENV, 'tenant-a', 'flow-profile');
    });

    it('does not read a profile for the default reference', async () => {
      await run({
        loadSignUpPolicy: async () => ({ policy: open, profileRef: 'default' }),
      } as never);
      expect(m.readProfile).not.toHaveBeenCalled();
    });

    it.each([
      ['a missing profile', 'missing'],
      [
        'sign-up off for the provider slug',
        {
          'authentication-methods.external_provider_usage': [{ id: 'corp', signupEnabled: false }],
        },
      ],
      [
        'sign-up off for the provider id',
        {
          'authentication-methods.external_provider_usage': [
            { id: 'prov-1', signupEnabled: false },
          ],
        },
      ],
    ] as const)('refuses %s', async (_n, profile) => {
      const error = await failure(withProfile(profile));
      expect(error.code).toBe(ExternalIdPErrorCode.JIT_PROVISIONING_DISABLED);
      expect(error.message).toBe('This provider does not sign people up here.');
      expect(error.details).toEqual({ providerName: 'Corp' });
    });

    it('accepts a profile that lists the provider with sign-up on, or not at all', async () => {
      await expect(
        withProfile({
          'authentication-methods.external_provider_usage': [{ id: 'corp', signupEnabled: true }],
        })
      ).resolves.toMatchObject({ status: 'pending' });
      await expect(withProfile({})).resolves.toMatchObject({ status: 'pending' });
    });

    it('holds a provider without a slug to the profile by its id alone', async () => {
      const values = {
        'authentication-methods.external_provider_usage': [{ id: 'prov-1', signupEnabled: false }],
      };
      m.readProfile.mockResolvedValue({ kind: 'profile', values });
      const error = await failure(
        run({
          provider: provider({ slug: undefined }),
          loadSignUpPolicy: async () => ({ policy: open, profileRef: 'flow-profile' }),
        } as never)
      );
      expect(error.message).toBe('This provider does not sign people up here.');
    });
  });

  describe('the email check of the sign-up Flow', () => {
    const checked = (checks: string[], extra: Partial<HandleIdentityParams> = {}) =>
      run({
        loadSignUpPolicy: async () => ({
          policy: { eligibility: 'open', allowed_domains: [], external_email_check: checks },
          profileRef: 'default',
        }),
        ...extra,
      } as never);

    it.each([
      ['no_email', { userInfo: userInfo({ email: undefined }) }],
      [
        'unverified',
        {
          userInfo: userInfo({ email_verified: false }),
          provider: provider({ requireEmailVerified: false }),
        },
      ],
      ['low_trust', { provider: provider({ trustEmail: false }) }],
    ])('asks for the email code when %s matches', async (check, extra) => {
      const error = await failure(checked([check], extra));
      expect(error.code).toBe(ExternalIdPErrorCode.EMAIL_NOT_VERIFIED);
      expect(error.message).toBe(
        'The email address needs to be verified by email code before this sign-up can finish.'
      );
      expect(error.details).toEqual({ providerName: 'Corp', emailCheck: check });
      expect(m.provision).not.toHaveBeenCalled();
    });

    it('lets a trusted, verified address through', async () => {
      await expect(
        checked(['no_email', 'unverified', 'low_trust'], {
          provider: provider({ trustEmail: true }),
        })
      ).resolves.toMatchObject({ status: 'pending' });
    });
  });
});

describe('verified email requirements', () => {
  const unverified = userInfo({ email_verified: false });

  it.each([
    ['the environment and the provider both ask', {}, { requireEmailVerified: true }, true],
    ['only the environment asks', {}, { requireEmailVerified: false }, true],
    [
      'only the provider asks',
      { ENABLE_IDENTITY_STITCHING_REQUIRE_VERIFIED_EMAIL: 'false' },
      { requireEmailVerified: true },
      true,
    ],
    [
      'neither asks',
      { ENABLE_IDENTITY_STITCHING_REQUIRE_VERIFIED_EMAIL: 'false' },
      { requireEmailVerified: false },
      false,
    ],
  ])('when %s', async (_n, envExtra, providerExtra, refused) => {
    const attempt = handleIdentity(
      makeEnv({ SETTINGS: undefined, ...envExtra }),
      params({ userInfo: unverified, provider: provider(providerExtra) })
    );
    if (refused) {
      const error = await failure(attempt);
      expect(error.code).toBe(ExternalIdPErrorCode.EMAIL_NOT_VERIFIED);
      expect(error.message).toContain('The email from your external account is not verified');
      expect(error.details).toEqual({ providerName: 'Corp' });
    } else {
      await expect(attempt).resolves.toMatchObject({ status: 'pending' });
    }
  });

  it('does not ask a sign-in without an email to be verified', async () => {
    await expect(
      run({ userInfo: userInfo({ email: undefined, email_verified: false }) })
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('also holds the JIT setting to a verified email', async () => {
    m.settings.mockResolvedValue(jit({ 'external_idp.jit_require_verified_email': true }));
    const error = await failure(
      run(
        { userInfo: unverified, provider: provider({ requireEmailVerified: false }) },
        makeEnv({ ENABLE_IDENTITY_STITCHING_REQUIRE_VERIFIED_EMAIL: 'false' })
      )
    );
    expect(error.message).toBe('A verified email is required for automatic account creation.');
    // a verified email is required: none at all, an empty one and an unverified one are refused
    for (const info of [
      userInfo({ email: undefined, email_verified: false }),
      userInfo({ email: undefined, email_verified: true }),
      userInfo({ email: '', email_verified: true }),
      userInfo({ email_verified: undefined }),
    ]) {
      m.provision.mockClear();
      const refused = await failure(
        run(
          { userInfo: info, provider: provider({ requireEmailVerified: false }) },
          makeEnv({ ENABLE_IDENTITY_STITCHING_REQUIRE_VERIFIED_EMAIL: 'false' })
        )
      );
      expect(refused.code).toBe(ExternalIdPErrorCode.EMAIL_NOT_VERIFIED);
      expect(refused.message).toBe('A verified email is required for automatic account creation.');
      expect(m.provision).not.toHaveBeenCalled();
    }
    // without the requirement an address-less sign-up is made
    m.settings.mockResolvedValue(jit());
    await expect(
      run(
        { userInfo: userInfo({ email: undefined, email_verified: false }) },
        makeEnv({ ENABLE_IDENTITY_STITCHING_REQUIRE_VERIFIED_EMAIL: 'false' })
      )
    ).resolves.toMatchObject({ status: 'pending' });
  });
});

describe('the tenant JIT settings', () => {
  it('reads them as saved now', async () => {
    await run();
    expect(m.settings).toHaveBeenCalledWith(ENV, 'external-idp', {
      tenantId: 'tenant-a',
      fresh: true,
    });
  });

  it('refuses when JIT is off, or its settings cannot be read', async () => {
    m.settings.mockResolvedValue(jit({ 'external_idp.jit_provisioning_enabled': false }));
    const off = await failure(run());
    expect(off.message).toBe(
      'JIT Provisioning is currently disabled. Please contact your administrator.'
    );
    m.settings.mockRejectedValue(new Error('kv'));
    expect((await failure(run())).code).toBe(ExternalIdPErrorCode.JIT_PROVISIONING_DISABLED);
    m.settings.mockResolvedValue(jit({ 'external_idp.jit_default_role_id': 5 }));
    expect((await failure(run())).code).toBe(ExternalIdPErrorCode.JIT_PROVISIONING_DISABLED);
    expect(m.provision).not.toHaveBeenCalled();
  });

  it('allows only the listed providers when a list is set', async () => {
    m.settings.mockResolvedValue(jit({ 'external_idp.jit_allowed_provider_ids': 'other, prov-2' }));
    const error = await failure(run());
    expect(error.message).toBe('This provider is not allowed for automatic account creation.');
    expect(error.details).toEqual({ providerName: 'Corp', providerId: 'prov-1' });
    m.settings.mockResolvedValue(jit({ 'external_idp.jit_allowed_provider_ids': 'other, prov-1' }));
    await expect(run()).resolves.toMatchObject({ status: 'pending' });
    m.settings.mockResolvedValue(jit({ 'external_idp.jit_allowed_provider_ids': ',' }));
    expect((await failure(run())).code).toBe(ExternalIdPErrorCode.JIT_PROVISIONING_DISABLED);
  });
});

describe('invitations and re-registration', () => {
  const invited = (email: string | null, requireVerifiedEmail: boolean) => ({
    invitedEmail: email,
    requireVerifiedEmail,
  });

  it('creates no account for another email than the invitation names', async () => {
    const error = await failure(run({ invitation: invited('someone@else.example', false) }));
    expect(error.code).toBe(ExternalIdPErrorCode.INVITATION_EMAIL_MISMATCH);
    expect(error.message).toBe('This invitation is for another email address.');
    expect(error.details).toEqual({ providerName: 'Corp' });
  });

  it('asks for a provider-verified email when the tenant requires one for the invitation', async () => {
    const error = await failure(
      run(
        {
          invitation: invited('person@example.com', true),
          userInfo: userInfo({ email_verified: false }),
          provider: provider({ requireEmailVerified: false }),
        },
        makeEnv({ ENABLE_IDENTITY_STITCHING_REQUIRE_VERIFIED_EMAIL: 'false' })
      )
    );
    expect(error.code).toBe(ExternalIdPErrorCode.EMAIL_NOT_VERIFIED);
    expect(error.message).toBe('This invitation needs an email your provider has verified.');
  });

  it('accepts the invited email in any case', async () => {
    await expect(run({ invitation: invited('PERSON@example.com', true) })).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it('checks the address against the deleted-account retention', async () => {
    await run();
    expect(m.registration).toHaveBeenCalledWith(ENV, {
      tenantId: 'tenant-a',
      email: 'Person@Example.com',
    });
    m.registration.mockResolvedValue('blocked');
    const error = await failure(run());
    expect(error.code).toBe(ExternalIdPErrorCode.POLICY_ACCESS_DENIED);
    expect(error.message).toBe('Access denied by policy.');
    m.registration.mockResolvedValue('unavailable');
    await expect(run()).rejects.toThrow('external_idp_reregistration_check_unavailable');
    expect(m.provision).toHaveBeenCalledTimes(1);
  });
});

describe('what a policy denial becomes', () => {
  it.each([
    ['interaction_required', ExternalIdPErrorCode.POLICY_INTERACTION_REQUIRED],
    ['login_required', ExternalIdPErrorCode.POLICY_LOGIN_REQUIRED],
    ['access_denied', ExternalIdPErrorCode.POLICY_ACCESS_DENIED],
    ['something_else', ExternalIdPErrorCode.POLICY_ACCESS_DENIED],
  ])('maps the rule denial %s', async (denyCode, code) => {
    m.ruleEvaluate.mockResolvedValue({
      denied: true,
      deny_code: denyCode,
      deny_description: 'Not for you',
      matched_rules: ['r1'],
      roles_to_assign: [],
      orgs_to_join: [],
    });
    const error = await failure(run());
    expect(error.code).toBe(code);
    expect(error.message).toBe('Not for you');
    expect(error.details).toEqual({ providerName: 'Corp', deny_code: denyCode });
    expect(m.provision).not.toHaveBeenCalled();
  });

  it('gives a standard message when the rule gives none', async () => {
    m.ruleEvaluate.mockResolvedValue({
      denied: true,
      deny_code: 'login_required',
      matched_rules: [],
    });
    expect((await failure(run())).message).toBe('Access denied by policy.');
  });

  it('denies a user without an organization when standalone users are not allowed', async () => {
    m.settings.mockResolvedValue(jit({ 'external_idp.jit_allow_user_without_org': false }));
    const error = await failure(run());
    expect(error.code).toBe(ExternalIdPErrorCode.POLICY_ACCESS_DENIED);
    expect(error.message).toBe(
      'No organization found for this user and standalone users are not allowed.'
    );
    expect(error.details).toEqual({ providerName: 'Corp', deny_code: 'access_denied' });
    expect(callArg(m.createRuleEvaluator, 0, 0)).toEqual({ db: 'meta' });
  });
});
