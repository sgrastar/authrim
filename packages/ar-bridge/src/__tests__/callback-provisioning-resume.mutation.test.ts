import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalIdPError, ExternalIdPErrorCode } from '../types';
import { argRec, callArg, rec } from './helpers/mock-args';
import {
  NOW,
  TENANT,
  TOKEN,
  runProvisioning,
  type FixtureOptions,
} from './helpers/provisioning-fixture';

const mocks = vi.hoisted(() => ({
  getChallengeStore: vi.fn(),
  schedule: vi.fn(),
  liteMode: vi.fn(),
  getProvider: vi.fn(),
  completeJit: vi.fn(),
  usageGate: vi.fn(),
  applyInvitation: vi.fn(),
  uiConfig: vi.fn(),
  resolveAccount: vi.fn(),
  publishEvent: vi.fn(),
  coreAdapter: { id: 'account-core' },
  moduleNames: [] as string[],
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getChallengeStoreByChallengeId: mocks.getChallengeStore,
  scheduleSignInAttemptFailureRecord: mocks.schedule,
  readLiteModeAuthoritative: mocks.liteMode,
  resolveAccountDataContextByIdentifier: mocks.resolveAccount,
  publishEvent: mocks.publishEvent,
  createAccountAuthContextFromHono: () => ({ coreAdapter: mocks.coreAdapter }),
  getUIConfig: mocks.uiConfig,
  getLogger: () => ({
    module: (name: string) => {
      mocks.moduleNames.push(name);
      return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    },
  }),
}));
vi.mock('../services/identity-stitching', () => ({
  completeExternalIdpJIT: mocks.completeJit,
  handleIdentity: vi.fn(),
}));
vi.mock('../services/signup-invitation', () => ({
  applyExternalSignupInvitation: mocks.applyInvitation,
  externalSignupInvitationRequirement: vi.fn(),
  releaseExternalSignupInvitation: vi.fn(),
}));
vi.mock('../services/provider-store', () => ({ getProviderByIdOrSlug: mocks.getProvider }));
vi.mock('../services/external-usage-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/external-usage-gate')>()),
  assertExternalProviderUsageAllowed: mocks.usageGate,
}));

const PROVIDER = { id: 'provider-a', slug: 'corp', name: 'Provider A' };
const resume = (options: FixtureOptions = {}) =>
  runProvisioning(mocks, { resume: true, status: { status: 'ready' }, ...options });

const attempt: FixtureOptions = {
  mutate: (c) => void (c.authState.attemptInteractionId = 'interaction-1'),
};

function loginError(response: Response): URL {
  expect(response.status).toBe(302);
  return new URL(String(response.headers.get('Location')));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  mocks.moduleNames.length = 0;
  mocks.resolveAccount.mockReset().mockResolvedValue({ accountId: 'account:user-a' });
  mocks.publishEvent.mockReset().mockResolvedValue(undefined);
  mocks.liteMode.mockReset().mockResolvedValue('off');
  mocks.getProvider.mockReset().mockResolvedValue(PROVIDER);
  mocks.usageGate.mockReset().mockResolvedValue(undefined);
  mocks.uiConfig.mockReset().mockResolvedValue({ baseUrl: 'https://login.example.com' });
  mocks.applyInvitation.mockReset().mockResolvedValue(true);
  mocks.completeJit.mockReset().mockResolvedValue({
    linkedIdentityId: 'external-link-a',
    roles_assigned: [{ role_id: 'r' }],
    orgs_joined: ['o1'],
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('resuming a provisioned account', () => {
  it('completes the account and answers with the code the sign-in asked for', async () => {
    const { response, store, consume, digest, cookieName } = await resume();
    const url = loginError(response);
    expect(url.origin + url.pathname).toBe('https://login.example.com/callback');
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.completeJit).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TENANT,
      userId: 'user-a',
      providerId: 'provider-a',
      providerUserId: 'provider-user-a',
    });
    expect(consume).toHaveBeenCalledWith({
      id: `external_idp_provisioning:${digest}`,
      tenantId: TENANT,
      type: 'external_idp_provisioning_resume',
      challenge: digest,
    });
    expect(response.headers.get('Set-Cookie')).toContain(`${cookieName}=;`);
    const stored = argRec(store.storeChallengeRpc);
    expect(stored.type).toBe('direct_auth_code');
    expect(stored.userId).toBe('user-a');
    expect(rec(stored.metadata)).toMatchObject({
      method: 'external_idp',
      provider: 'provider-a',
      provider_id: 'provider-a',
      provider_slug: 'corp',
      client_id: 'client-a',
      is_new_user: true,
      stitched_from_existing: false,
      usage: 'signup',
      upstream_acr: 'urn:mace:incommon:iap:silver',
    });
  });

  it('looks the provider up by the continuation, then holds it to the sign-up switch', async () => {
    await resume();
    expect(mocks.getProvider).toHaveBeenCalledWith(expect.anything(), 'provider-a', TENANT);
    expect(mocks.usageGate).toHaveBeenCalledWith(expect.anything(), TENANT, PROVIDER, 'signup');
    expect(mocks.liteMode).toHaveBeenCalledWith(expect.anything(), TENANT);
    expect(mocks.resolveAccount).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TENANT,
      indexKind: 'external_subject',
      identifier: { issuer: 'provider-a', subject: 'provider-user-a' },
      expectedAccountId: 'account:user-a',
    });
  });

  it('applies the sign-up invitation reserved by the sign-in', async () => {
    await resume({
      mutate: (c) => {
        c.authState.inviteId = 'invite-1';
        c.authState.inviteReservationId = 'inr-1';
      },
    });
    expect(mocks.applyInvitation).toHaveBeenCalledTimes(1);
    expect(callArg(mocks.applyInvitation, 0, 2)).toMatchObject({
      accountCoreAdapter: mocks.coreAdapter,
      inviteId: 'invite-1',
      inviteReservationId: 'inr-1',
      tenantId: TENANT,
      userId: 'user-a',
    });
  });

  it.each([['no token', { token: '' }]])('refuses a request with %s', async () => {
    const { response, getStatus } = await resume({ token: '' });
    expect(loginError(response).searchParams.get('error')).toBe('callback_failed');
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('refuses a request without a tenant, naming nothing', async () => {
    const { response } = await resume({ tenant: '' });
    const url = loginError(response);
    expect(url.pathname).toBe('/login');
    expect(url.searchParams.get('error')).toBe('callback_failed');
    expect(url.searchParams.get('error_description')).toBe(
      'Authentication could not be resumed. Please try again.'
    );
    expect(mocks.getChallengeStore).not.toHaveBeenCalled();
  });

  it('refuses without the browser binding cookie, or the provisioner', async () => {
    for (const options of [
      { cookie: 'none' as const },
      { env: { EXTERNAL_IDP_ACCOUNT_PROVISIONER: undefined } },
    ]) {
      const { response } = await resume(options);
      expect(loginError(response).searchParams.get('error')).toBe('callback_failed');
    }
    expect(mocks.completeJit).not.toHaveBeenCalled();
  });

  it('sends a lite sign-in back to its own return address with the error', async () => {
    const { response } = await resume({
      status: { status: 'pending' },
      mutate: (c) => void (c.authState.flowId = 'lite:abc'),
    });
    expect(response.status).toBe(302);
    const url = new URL(String(response.headers.get('Location')));
    expect(url.origin + url.pathname).toBe('https://login.example.com/callback');
    expect(url.searchParams.get('error')).toBe('callback_failed');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  });
});

describe('an account that is not ready', () => {
  it.each([
    ['pending', { status: 'pending' }],
    ['another operation', { operationId: 'other' }],
    ['another account', { accountId: 'account:other' }],
    ['another user', { userId: 'other' }],
  ])('is not resumed when it is %s, and records no failed attempt', async (_n, status) => {
    const { response, consume } = await resume({ ...attempt, status });
    expect(loginError(response).searchParams.get('error')).toBe('callback_failed');
    expect(consume).not.toHaveBeenCalled();
    expect(mocks.completeJit).not.toHaveBeenCalled();
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('records the failed attempt for a provisioning that failed', async () => {
    const { response, consume } = await resume({ ...attempt, status: { status: 'failed' } });
    expect(loginError(response).searchParams.get('error')).toBe('callback_failed');
    expect(callArg(mocks.schedule, 0, 1)).toEqual({
      tenantId: TENANT,
      interactionId: 'interaction-1',
      method: 'external_idp',
      reasonCode: 'provisioning_failed',
      userId: 'user-a',
      dedupeKey: 'auth-state-a',
    });
    expect(mocks.schedule).toHaveBeenCalledTimes(1);
    expect(consume).not.toHaveBeenCalled();
  });

  it.each([
    ['another operation', { operationId: 'other' }],
    ['another account', { accountId: 'account:other' }],
    ['another user', { userId: 'other' }],
  ])('does not record a failure reported for %s', async (_n, status) => {
    await resume({ ...attempt, status: { status: 'failed', ...status } });
    expect(mocks.schedule).not.toHaveBeenCalled();
  });
});

describe('failures after the account is ready', () => {
  const reason = () => rec(callArg(mocks.schedule, 0, 1)).reasonCode;

  it.each([
    ['no provider', () => mocks.getProvider.mockResolvedValue(null)],
    ['another provider', () => mocks.getProvider.mockResolvedValue({ ...PROVIDER, id: 'other' })],
  ])('record a failed attempt when there is %s', async (_n, arrange) => {
    arrange();
    const { response, consume } = await resume(attempt);
    expect(loginError(response).searchParams.get('error')).toBe('callback_failed');
    expect(reason()).toBe('service_unavailable');
    expect(mocks.schedule).toHaveBeenCalledTimes(1);
    expect(consume).not.toHaveBeenCalled();
  });

  it.each([
    ExternalIdPErrorCode.LOGIN_DISABLED,
    ExternalIdPErrorCode.SIGNUP_DISABLED,
    ExternalIdPErrorCode.SETTINGS_UNAVAILABLE,
  ])('answers a switch error %s with its own code', async (code) => {
    mocks.usageGate.mockRejectedValue(new ExternalIdPError(code, 'refused'));
    const { response } = await resume(attempt);
    const url = loginError(response);
    expect(url.searchParams.get('error')).toBe(code);
    expect(url.searchParams.get('error_description')).toBe(
      'Authentication failed. Please try again.'
    );
    expect(mocks.schedule).toHaveBeenCalledTimes(1);
    expect(mocks.completeJit).not.toHaveBeenCalled();
  });

  it('answers another provider error generically', async () => {
    mocks.usageGate.mockRejectedValue(
      new ExternalIdPError(ExternalIdPErrorCode.EMAIL_NOT_VERIFIED, 'x')
    );
    const { response } = await resume(attempt);
    expect(loginError(response).searchParams.get('error')).toBe('callback_failed');
    expect(reason()).toBe('email_not_verified');
  });

  it('refuses a sign-in that may not create an account', async () => {
    mocks.liteMode.mockResolvedValue('lite');
    const { response } = await resume(attempt);
    expect(loginError(response).searchParams.get('error')).toBe('callback_failed');
    expect(reason()).toBe('signup_disabled');
    expect(mocks.completeJit).not.toHaveBeenCalled();
  });

  it('lets a lite sign-in finish its account in lite mode', async () => {
    mocks.liteMode.mockResolvedValue('lite');
    const { response } = await resume({
      mutate: (c) => void (c.authState.flowId = 'lite:abc'),
    });
    expect(loginError(response).searchParams.get('code')).toBeTruthy();
    expect(mocks.liteMode).not.toHaveBeenCalled();
  });

  it('refuses when the lite mode cannot be read', async () => {
    mocks.liteMode.mockRejectedValue(new Error('kv'));
    const { response } = await resume(attempt);
    expect(loginError(response).searchParams.get('error')).toBe('callback_failed');
    expect(mocks.completeJit).not.toHaveBeenCalled();
  });

  it('records a failed attempt when the account cannot be completed', async () => {
    mocks.completeJit.mockRejectedValue(new Error('pending identity gone'));
    const { response, consume } = await resume(attempt);
    expect(loginError(response).searchParams.get('error')).toBe('callback_failed');
    expect(reason()).toBe('service_unavailable');
    expect(consume).not.toHaveBeenCalled();
  });

  it('treats a continuation consumed by a concurrent resume as a replay, not a failure', async () => {
    const { response } = await resume({ ...attempt, consumed: new Error('already consumed') });
    expect(loginError(response).searchParams.get('error')).toBe('callback_failed');
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('treats a continuation consumed for another user as a replay, not a failure', async () => {
    const { response } = await resume({ ...attempt, consumed: { userId: 'user-b' } });
    expect(loginError(response).searchParams.get('error')).toBe('callback_failed');
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('records a failed attempt when finishing the sign-in fails', async () => {
    mocks.applyInvitation.mockRejectedValue(new Error('invitation store down'));
    const { response } = await resume({
      mutate: (c) => {
        c.authState.attemptInteractionId = 'interaction-1';
        c.authState.inviteId = 'invite-1';
        c.authState.inviteReservationId = 'inr-1';
      },
    });
    expect(loginError(response).searchParams.get('error')).toBe('callback_failed');
    expect(mocks.schedule).toHaveBeenCalledTimes(1);
  });

  it('does not record an attempt for a link', async () => {
    mocks.completeJit.mockRejectedValue(new Error('x'));
    await resume({
      mutate: (c) => {
        c.authState.attemptInteractionId = 'interaction-1';
        c.authState.userId = 'someone';
      },
    });
    expect(mocks.schedule).not.toHaveBeenCalled();
    expect(TOKEN).toHaveLength(43);
  });
});
