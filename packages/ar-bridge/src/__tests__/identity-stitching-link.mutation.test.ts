import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalIdPError, ExternalIdPErrorCode } from '../types';
import { argRec, callArg, rec } from './helpers/mock-args';
import { anyOf, throwValue } from './helpers/matchers';
import {
  CORE_DB,
  DEFAULT_CORE_DB,
  DEFAULT_PII_DB,
  NOW,
  PII_DB,
  account,
  m,
  makeEnv,
  params,
  provider,
  resetIdentityMocks,
  routes,
  tokens,
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

import {
  getStitchingConfig,
  handleIdentity,
  hasPasskeyCredential,
} from '../services/identity-stitching';

const ENV = makeEnv();

async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(ExternalIdPError);
  return (error as ExternalIdPError).code;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetIdentityMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('getStitchingConfig', () => {
  const kv = (get: () => Promise<string | null>) => makeEnv({ SETTINGS: { get } });

  it('reads the saved document first', async () => {
    const get = vi.fn(async () => JSON.stringify({ enabled: true, requireVerifiedEmail: false }));
    await expect(getStitchingConfig(kv(get))).resolves.toEqual({
      enabled: true,
      requireVerifiedEmail: false,
    });
    expect(get).toHaveBeenCalledWith('identity_stitching');
  });

  it.each([
    ['nothing saved', async () => null],
    ['an unreadable document', async () => '{nope'],
    [
      'a failing store',
      async (): Promise<string | null> => {
        throw new Error('kv');
      },
    ],
  ])('falls back to the environment on %s', async (_n, get) => {
    await expect(
      getStitchingConfig(
        makeEnv({
          SETTINGS: { get },
          ENABLE_IDENTITY_STITCHING: 'true',
          ENABLE_IDENTITY_STITCHING_REQUIRE_VERIFIED_EMAIL: 'false',
        })
      )
    ).resolves.toEqual({ enabled: true, requireVerifiedEmail: false });
  });

  it('is off, requiring a verified email, with nothing configured', async () => {
    await expect(getStitchingConfig(makeEnv({ SETTINGS: undefined }))).resolves.toEqual({
      enabled: false,
      requireVerifiedEmail: true,
    });
    for (const value of ['TRUE', '1', 'yes', undefined]) {
      await expect(
        getStitchingConfig(makeEnv({ SETTINGS: undefined, ENABLE_IDENTITY_STITCHING: value }))
      ).resolves.toMatchObject({ enabled: false });
    }
    for (const value of ['FALSE', '0', 'true', undefined]) {
      await expect(
        getStitchingConfig(
          makeEnv({
            SETTINGS: undefined,
            ENABLE_IDENTITY_STITCHING_REQUIRE_VERIFIED_EMAIL: value,
          })
        )
      ).resolves.toMatchObject({ requireVerifiedEmail: true });
    }
  });
});

describe('explicit linking', () => {
  const link = (extra: Record<string, unknown> = {}) =>
    handleIdentity(ENV, params({ linkingUserId: 'user-a', ...extra }));

  beforeEach(() => {
    m.accountCtx.mockResolvedValue(account());
  });

  it.each([
    [
      'an unverified email at a provider that requires it',
      { requireEmailVerified: true },
      { email_verified: false },
      true,
    ],
    [
      'an unverified email at a provider that does not require it',
      { requireEmailVerified: false },
      { email_verified: false },
      false,
    ],
    ['a verified email', { requireEmailVerified: true }, { email_verified: true }, false],
    [
      'no email',
      { requireEmailVerified: true },
      { email: undefined, email_verified: false },
      false,
    ],
  ])('with %s', async (_n, providerExtra, info, refused) => {
    const run = link({ provider: provider(providerExtra), userInfo: userInfo(info) });
    if (refused) {
      expect(await codeOf(run)).toBe(ExternalIdPErrorCode.EMAIL_NOT_VERIFIED);
      expect(m.accountCtx).not.toHaveBeenCalled();
    } else {
      await expect(run).resolves.toMatchObject({ status: 'ready' });
    }
  });

  it('puts the provider name in the unverified-email error', async () => {
    const error = await link({ userInfo: userInfo({ email_verified: false }) }).catch(
      (e: unknown) => e
    );
    expect((error as ExternalIdPError).details).toEqual({ providerName: 'Corp' });
  });

  it('checks the account the user id names', async () => {
    await link();
    expect(m.accountCtx).toHaveBeenCalledWith(ENV, {
      tenantId: 'tenant-a',
      accountId: 'account:user-a',
    });
    m.accountCtx.mockResolvedValue(account({ legacyUserId: 'user-b' }));
    await expect(link()).rejects.toThrow('external_idp_link_account_mismatch');
  });

  it('asks the directory who owns the external subject', async () => {
    await link();
    expect(callArg(m.byIdentifier, 0, 1)).toEqual({
      tenantId: 'tenant-a',
      indexKind: 'external_subject',
      identifier: { issuer: 'prov-1', subject: 'sub-1' },
    });
  });

  it('refuses a subject owned by another account, and one found linked to another user', async () => {
    routes({ external: [account({ legacyUserId: 'user-b' })] });
    expect(await codeOf(link())).toBe(ExternalIdPErrorCode.ACCOUNT_ALREADY_LINKED);
    expect(m.createLinked).not.toHaveBeenCalled();
    routes({});
    m.findLinked.mockResolvedValue({ id: 'l', userId: 'user-b' });
    expect(await codeOf(link())).toBe(ExternalIdPErrorCode.ACCOUNT_ALREADY_LINKED);
    expect(m.createLinked).not.toHaveBeenCalled();
  });

  it('accepts a subject already routed to the same account', async () => {
    routes({ external: [account()] });
    await expect(link()).resolves.toMatchObject({ status: 'ready' });
  });

  it('does not take a directory failure for no owner', async () => {
    routes({ external: [new Error('directory down')] });
    await expect(link()).rejects.toThrow('directory down');
    routes({ external: ['account_data_route_not_found'] });
    await expect(link()).rejects.toBe('account_data_route_not_found');
  });

  it('reuses the identity the account already has, creating and publishing nothing new for it', async () => {
    m.findLinked.mockResolvedValue({ id: 'existing-link', userId: 'user-a' });
    const result = await link();
    expect(result).toEqual({
      status: 'ready',
      userId: 'user-a',
      isNewUser: false,
      linkedIdentityId: 'existing-link',
      stitchedFromExisting: false,
    });
    expect(m.createLinked).not.toHaveBeenCalled();
    expect(m.findLinked).toHaveBeenCalledWith(ENV, 'tenant-a', 'prov-1', 'sub-1', PII_DB);
  });

  it('creates the link in the account PII database from the provider answer', async () => {
    const upstream = userInfo({ sub: 'sub-1', name: 'From Upstream' });
    const result = await link({ upstreamClaims: upstream });
    expect(result.linkedIdentityId).toBe('new-link');
    expect(m.createLinked).toHaveBeenCalledWith(
      ENV,
      {
        userId: 'user-a',
        providerId: 'prov-1',
        providerUserId: 'sub-1',
        providerEmail: 'Person@Example.com',
        emailVerified: true,
        tokens: tokens(),
        rawClaims: upstream,
        tenantId: 'tenant-a',
      },
      PII_DB
    );
  });

  it('uses the user info as the raw claims when there are no upstream claims', async () => {
    await link();
    expect(argRec(m.createLinked, 0, 1).rawClaims).toEqual(userInfo());
  });

  it('publishes the route with an operation derived from the link', async () => {
    await link();
    const stable = JSON.stringify({
      accountId: 'account:user-a',
      linkedIdentityId: 'new-link',
      providerId: 'prov-1',
      providerUserId: 'sub-1',
      tenantId: 'tenant-a',
      userId: 'user-a',
    });
    const digest = createHash('sha256').update(stable).digest('hex');
    expect(argRec(m.publish)).toEqual({
      schemaVersion: 1,
      operationId: `external-idp-route-${digest.slice(0, 32)}`,
      idempotencyKey: `auth-external-idp-route:${digest}`,
      tenantId: 'tenant-a',
      accountId: 'account:user-a',
      userId: 'user-a',
      linkedIdentityId: 'new-link',
      providerId: 'prov-1',
      providerUserId: 'sub-1',
    });
  });

  it('refuses a publication answer that is not for this operation', async () => {
    for (const override of [
      { operationId: 'other' },
      { accountId: 'other' },
      { status: 200 },
      { status: 500 },
    ]) {
      m.publish.mockImplementation(async (request: { operationId: string; accountId: string }) => ({
        status: 201,
        operationId: request.operationId,
        accountId: request.accountId,
        ...override,
      }));
      await expect(link()).rejects.toThrow('external_idp_route_publication_response_invalid');
    }
    m.publish.mockImplementation(async (request: { operationId: string; accountId: string }) => ({
      status: 202,
      operationId: request.operationId,
      accountId: request.accountId,
    }));
    await expect(link()).resolves.toMatchObject({ status: 'ready' });
  });

  it('cannot publish without the account provisioner', async () => {
    await expect(
      handleIdentity(
        makeEnv({ EXTERNAL_IDP_ACCOUNT_PROVISIONER: undefined }),
        params({ linkingUserId: 'user-a' })
      )
    ).rejects.toThrow('external_idp_account_provisioner_unavailable');
  });

  it('records the link in the audit log, and survives an audit failure', async () => {
    await link();
    expect(m.audit).toHaveBeenCalledWith(ENV, {
      userId: 'user-a',
      tenantId: 'tenant-a',
      action: 'identity_linked',
      resource: 'linked_identity',
      resourceId: 'new-link',
      ipAddress: 'system',
      userAgent: 'identity-stitching',
      metadata: JSON.stringify({ providerId: 'prov-1' }),
      severity: 'info',
    });
    m.audit.mockRejectedValue(new TypeError('audit down'));
    await expect(link()).resolves.toMatchObject({ status: 'ready' });
    expect(m.log.error).toHaveBeenCalledWith('Failed to log audit event', {
      action: 'audit_log',
      errorName: 'TypeError',
    });
    m.audit.mockRejectedValue('text');
    await link();
    expect(m.log.error).toHaveBeenLastCalledWith('Failed to log audit event', {
      action: 'audit_log',
      errorName: 'Unknown error',
    });
  });
});

describe('signing in to a linked account', () => {
  const EXISTING = { id: 'link-1', tenantId: 'tenant-a', userId: 'user-a' };

  beforeEach(() => {
    m.findLinked.mockResolvedValue(EXISTING);
  });

  it.each([
    [undefined, true],
    [false, true],
    [true, false],
  ])(
    'checks the sign-in switch when reauthentication is %s: %s',
    async (reauthentication, checked) => {
      await handleIdentity(ENV, params({ reauthentication }));
      if (checked) {
        expect(m.gate).toHaveBeenCalledWith(ENV, 'tenant-a', provider(), 'login');
      } else {
        expect(m.gate).not.toHaveBeenCalled();
      }
    }
  );

  it('writes nothing when the switch refuses', async () => {
    m.gate.mockRejectedValue(new Error('login off'));
    await expect(handleIdentity(ENV, params())).rejects.toThrow('login off');
    expect(m.updateProfile).not.toHaveBeenCalled();
    expect(m.updateLinked).not.toHaveBeenCalled();
  });

  it('looks the link up in the routed PII database when the directory knows the subject', async () => {
    routes({ external: [account()] });
    const result = await handleIdentity(ENV, params());
    expect(m.findLinked).toHaveBeenCalledWith(ENV, 'tenant-a', 'prov-1', 'sub-1', PII_DB);
    expect(result).toEqual({
      status: 'ready',
      userId: 'user-a',
      isNewUser: false,
      linkedIdentityId: 'link-1',
      stitchedFromExisting: false,
    });
    expect(m.updateLinked).toHaveBeenCalledWith(
      ENV,
      'tenant-a',
      'link-1',
      { tokens: tokens(), lastLoginAt: NOW, rawClaims: userInfo() },
      PII_DB
    );
  });

  it('falls back to the default user store when the directory does not know the subject', async () => {
    await handleIdentity(ENV, params({ upstreamClaims: userInfo({ name: 'Up' }) }));
    expect(m.userSources).toHaveBeenCalledWith(ENV, 'tenant-a');
    expect(m.findLinked).toHaveBeenCalledWith(ENV, 'tenant-a', 'prov-1', 'sub-1', DEFAULT_PII_DB);
    expect(m.updateLinked).toHaveBeenCalledWith(
      ENV,
      'tenant-a',
      'link-1',
      { tokens: tokens(), lastLoginAt: NOW, rawClaims: userInfo({ name: 'Up' }) },
      DEFAULT_PII_DB
    );
  });

  it('does not take a directory failure for an unknown subject', async () => {
    routes({ external: [new Error('directory down')] });
    await expect(handleIdentity(ENV, params())).rejects.toThrow('directory down');
  });

  it('updates the profile from the provider in the routed account stores', async () => {
    routes({ external: [account()] });
    const info = userInfo();
    await handleIdentity(
      ENV,
      params({ userInfo: info, provider: provider({ profileUpdateFields: ['name'] }) })
    );
    expect(m.ensureDb).toHaveBeenCalledWith(CORE_DB, 'identity-stitching-profile-core');
    expect(m.ensureDb).toHaveBeenCalledWith(PII_DB, 'identity-stitching-profile-pii');
    expect(argRec(m.updateProfile)).toEqual({
      env: ENV,
      tenantId: 'tenant-a',
      userId: 'user-a',
      claims: info,
      providerFields: ['name'],
      users: anyOf(Object),
    });
    expect(m.storeOptions).toEqual([
      {
        coreAdapter: { adapterOf: CORE_DB, label: 'identity-stitching-profile-core' },
        piiAdapter: { adapterOf: PII_DB, label: 'identity-stitching-profile-pii' },
        tenantId: 'tenant-a',
      },
    ]);
  });

  it('updates the profile in the default stores without a route', async () => {
    await handleIdentity(ENV, params());
    expect(m.ensureDb).toHaveBeenCalledWith(DEFAULT_CORE_DB, 'identity-stitching-profile-core');
    expect(m.ensureDb).toHaveBeenCalledWith(DEFAULT_PII_DB, 'identity-stitching-profile-pii');
    expect(argRec(m.updateProfile).providerFields).toBeUndefined();
  });

  it('signs in anyway, warning, when the profile stores cannot be opened', async () => {
    m.ensureDb.mockImplementation(() => {
      throw new RangeError('no adapter');
    });
    await expect(handleIdentity(ENV, params())).resolves.toMatchObject({ status: 'ready' });
    expect(m.updateProfile).not.toHaveBeenCalled();
    expect(m.log.warn).toHaveBeenCalledWith('Profile update from the identity provider failed', {
      action: 'profile_update_on_login',
      errorName: 'RangeError',
    });
    m.ensureDb.mockImplementation(() => {
      throwValue('text');
    });
    await handleIdentity(ENV, params());
    expect(m.log.warn).toHaveBeenLastCalledWith(
      'Profile update from the identity provider failed',
      {
        action: 'profile_update_on_login',
        errorName: 'Unknown error',
      }
    );
  });
});

describe('finishing an account an earlier sign-in left pending', () => {
  beforeEach(() => {
    routes({ external: ['notfound', account()] });
    routes({ external: [account()] });
    m.findPending.mockResolvedValue(null);
  });

  it('refuses when the sign-in may not create an account', async () => {
    expect(await codeOf(handleIdentity(ENV, params({ accountCreationAllowed: false })))).toBe(
      ExternalIdPErrorCode.JIT_PROVISIONING_DISABLED
    );
    expect(m.gate).not.toHaveBeenCalled();
  });

  it('is held to the sign-up switch, then returns the identity that was already active', async () => {
    m.findLinked
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'active-1', userId: 'user-a' });
    const result = await handleIdentity(ENV, params({ accountCreationAllowed: true }));
    expect(m.gate).toHaveBeenCalledWith(ENV, 'tenant-a', provider(), 'signup');
    expect(result).toEqual({
      status: 'ready',
      userId: 'user-a',
      isNewUser: false,
      finishedAccountCreation: true,
      linkedIdentityId: 'active-1',
      stitchedFromExisting: false,
      roles_assigned: [],
      orgs_joined: [],
    });
    expect(m.updateLinked).toHaveBeenCalledWith(
      ENV,
      'tenant-a',
      'active-1',
      { tokens: tokens(), lastLoginAt: NOW, rawClaims: userInfo() },
      PII_DB
    );
  });

  it('refuses before finishing when the sign-up policy does not allow it', async () => {
    const loadSignUpPolicy = async () => ({
      policy: { eligibility: 'invite' },
      profileRef: 'default',
    });
    expect(await codeOf(handleIdentity(ENV, params({ loadSignUpPolicy } as never)))).toBe(
      ExternalIdPErrorCode.JIT_PROVISIONING_DISABLED
    );
    expect(m.gate).not.toHaveBeenCalled();
  });
});

describe('stitching by email', () => {
  const stitch = (extra: Record<string, unknown> = {}) =>
    handleIdentity(
      makeEnv({ ENABLE_IDENTITY_STITCHING: 'true', SETTINGS: undefined }),
      params(extra)
    );

  beforeEach(() => {
    m.findByEmail.mockResolvedValue({
      id: 'user-x',
      email: 'person@example.com',
      email_verified: 1,
    });
  });

  it('asks the directory for the email, and does not when there is none', async () => {
    await stitch();
    expect(m.byIdentifier.mock.calls.map((c): unknown => c[1])).toEqual([
      {
        tenantId: 'tenant-a',
        indexKind: 'external_subject',
        identifier: { issuer: 'prov-1', subject: 'sub-1' },
      },
      { tenantId: 'tenant-a', indexKind: 'email_exact', identifier: 'Person@Example.com' },
    ]);
    m.byIdentifier.mockClear();
    m.findByEmail.mockClear();
    m.findByEmail.mockResolvedValue(null);
    await handleIdentity(
      makeEnv({ SETTINGS: undefined }),
      params({
        userInfo: userInfo({ email: undefined }),
        provider: provider({ jitProvisioning: false }),
      })
    ).catch(() => undefined);
    expect(m.byIdentifier.mock.calls.map((c) => rec(c[1]).indexKind)).toEqual(['external_subject']);
    expect(m.findByEmail).not.toHaveBeenCalled();
  });

  it('does not take a directory failure for an unknown email', async () => {
    routes({ email: [new Error('directory down')] });
    await expect(stitch()).rejects.toThrow('directory down');
  });

  it('finds the user by the lower-cased email in the routed stores', async () => {
    routes({ email: [account()] });
    await stitch();
    expect(m.findByEmail).toHaveBeenCalledWith('person@example.com');
    expect(m.ensureDb).toHaveBeenCalledWith(CORE_DB, 'identity-stitching-core');
    expect(m.ensureDb).toHaveBeenCalledWith(PII_DB, 'identity-stitching-pii');
  });

  it('finds the user in the default stores without a route, and nobody without a PII store', async () => {
    await stitch();
    expect(m.ensureDb).toHaveBeenCalledWith(DEFAULT_CORE_DB, 'identity-stitching-core');
    expect(m.ensureDb).toHaveBeenCalledWith(DEFAULT_PII_DB, 'identity-stitching-pii');
    m.userSources.mockResolvedValue({ coreDb: DEFAULT_CORE_DB, piiDb: null });
    m.findByEmail.mockClear();
    m.findByEmail.mockResolvedValue({ id: 'user-x', email: null, email_verified: 1 });
    const jitOff = provider({ jitProvisioning: false });
    await expect(stitch({ provider: jitOff })).rejects.toBeInstanceOf(ExternalIdPError);
    expect(m.findByEmail).not.toHaveBeenCalled();
  });

  it('links the existing user: new identity in the email-routed shard, published and audited', async () => {
    routes({ email: [account({ legacyUserId: 'user-x', accountId: 'account:user-x' })] });
    const result = await stitch();
    expect(result).toEqual({
      status: 'ready',
      userId: 'user-x',
      isNewUser: false,
      linkedIdentityId: 'new-link',
      stitchedFromExisting: true,
    });
    expect(m.gate).toHaveBeenCalledWith(expect.anything(), 'tenant-a', provider(), 'login');
    expect(m.findLinked).toHaveBeenLastCalledWith(
      expect.anything(),
      'tenant-a',
      'prov-1',
      'sub-1',
      PII_DB
    );
    expect(m.createLinked).toHaveBeenCalledWith(
      expect.anything(),
      {
        userId: 'user-x',
        providerId: 'prov-1',
        providerUserId: 'sub-1',
        providerEmail: 'Person@Example.com',
        emailVerified: true,
        tokens: tokens(),
        rawClaims: userInfo(),
        tenantId: 'tenant-a',
      },
      PII_DB
    );
    expect(argRec(m.publish)).toMatchObject({
      userId: 'user-x',
      accountId: 'account:user-x',
      linkedIdentityId: 'new-link',
    });
    expect(m.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'user-x',
        action: 'identity_stitched',
        resource: 'linked_identity',
        resourceId: 'new-link',
        metadata: JSON.stringify({ providerId: 'prov-1', stitchReason: 'email_match' }),
      })
    );
  });

  it('reuses an identity the routed shard already holds for that user', async () => {
    routes({ email: [account({ legacyUserId: 'user-x' })] });
    m.findLinked.mockResolvedValueOnce(null).mockResolvedValue({ id: 'held', userId: 'user-x' });
    await expect(stitch()).resolves.toMatchObject({
      linkedIdentityId: 'held',
      stitchedFromExisting: true,
    });
    expect(m.createLinked).not.toHaveBeenCalled();
  });

  it('refuses when the routed shard holds the identity for another user', async () => {
    routes({ email: [account({ legacyUserId: 'user-x' })] });
    m.findLinked.mockResolvedValueOnce(null).mockResolvedValue({ id: 'held', userId: 'user-y' });
    await expect(stitch()).rejects.toThrow('external_idp_stitch_authority_conflict');
  });

  it('creates in the default shard, publishing nothing, when the email has no route', async () => {
    const result = await stitch();
    expect(result.linkedIdentityId).toBe('new-link');
    expect(m.findLinked).toHaveBeenCalledTimes(1);
    expect(callArg(m.createLinked, 0, 2)).toBe(DEFAULT_PII_DB);
    expect(m.publish).not.toHaveBeenCalled();
  });

  it('refuses when the local email is not verified', async () => {
    m.findByEmail.mockResolvedValue({ id: 'user-x', email: 'p@e.com', email_verified: 0 });
    const error = await stitch().catch((e: unknown) => e);
    expect((error as ExternalIdPError).code).toBe(ExternalIdPErrorCode.LOCAL_EMAIL_NOT_VERIFIED);
    expect((error as ExternalIdPError).details).toEqual({ email: 'Person@Example.com' });
    expect(m.createLinked).not.toHaveBeenCalled();
  });

  it.each([
    ['stitching is off', { env: { ENABLE_IDENTITY_STITCHING: 'false' } }],
    ['the provider does not link by email', { provider: provider({ autoLinkEmail: false }) }],
    [
      'the provider email is not verified',
      {
        userInfo: userInfo({ email_verified: false }),
        provider: provider({ requireEmailVerified: false }),
      },
    ],
  ])('asks for a manual link when %s', async (_n, override) => {
    const { env, ...rest } = override as { env?: Record<string, unknown> };
    const error = await handleIdentity(
      makeEnv({ ENABLE_IDENTITY_STITCHING: 'true', SETTINGS: undefined, ...env }),
      params(rest as never)
    ).catch((e: unknown) => e);
    expect((error as ExternalIdPError).code).toBe(
      ExternalIdPErrorCode.ACCOUNT_EXISTS_LINK_REQUIRED
    );
    expect((error as ExternalIdPError).details).toEqual({
      email: 'Person@Example.com',
      providerName: 'Corp',
    });
    expect(m.createLinked).not.toHaveBeenCalled();
  });

  it('checks the sign-in switch for the existing user unless re-authenticating', async () => {
    await stitch({ reauthentication: true });
    expect(m.gate).not.toHaveBeenCalled();
    m.createLinked.mockClear();
    m.gate.mockRejectedValue(new Error('login off'));
    await expect(stitch()).rejects.toThrow('login off');
    expect(m.createLinked).not.toHaveBeenCalled();
  });
});

describe('hasPasskeyCredential', () => {
  const adapterWith = (count: unknown) => {
    const queryOne = vi.fn(async () => count);
    m.ensureDb.mockImplementation(() => ({ queryOne }));
    return queryOne;
  };

  it('counts the user passkeys in the core store of the tenant', async () => {
    const queryOne = adapterWith({ count: 2 });
    await expect(hasPasskeyCredential(ENV, 'tenant-a', 'user-a')).resolves.toBe(true);
    expect(queryOne).toHaveBeenCalledWith(
      'SELECT COUNT(*) as count FROM passkeys WHERE tenant_id = ? AND user_id = ?',
      ['tenant-a', 'user-a']
    );
    expect(m.ensureDb).toHaveBeenCalledWith(DEFAULT_CORE_DB, 'identity-stitching-core');
  });

  it('uses the account stores when given an account', async () => {
    adapterWith({ count: 1 });
    await hasPasskeyCredential(ENV, 'tenant-a', 'user-a', account() as never);
    expect(m.ensureDb).toHaveBeenCalledWith(CORE_DB, 'identity-stitching-core');
    expect(m.userSources).not.toHaveBeenCalled();
  });

  it.each([
    [{ count: 0 }, false],
    [{ count: 1 }, true],
    [null, false],
    [{}, false],
  ])('answers %j with %s', async (row, expected) => {
    adapterWith(row);
    await expect(hasPasskeyCredential(ENV, 'tenant-a', 'user-a')).resolves.toBe(expected);
  });
});
