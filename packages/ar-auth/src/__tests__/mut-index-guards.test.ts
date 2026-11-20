import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  coreCalls,
  liteBudgetOptions,
  liteGuardCalls,
  resetCoreCalls,
  resetStubHandlers,
  stubHandler,
} from './helpers/mut-index-stubs';

vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./helpers/mut-index-stubs')).coreMock(await importOriginal())
);
const stub = vi.hoisted(
  () => (names: string[]) => async () =>
    (await import('./helpers/mut-index-stubs')).stubModule(names)
);
vi.mock('../authorize', stub(['authorizeHandler']));
vi.mock('../par', stub(['parHandler']));
vi.mock('../admin-agent-oauth', stub(['adminAgentAuthorizeHandler', 'adminAgentParHandler']));
vi.mock(
  '../admin-agent-login-handoff',
  stub(['adminAgentLoginHandoffConsumeHandler', 'createAdminAgentLoginHandoff'])
);
vi.mock(
  '../passkey',
  stub([
    'passkeyRegisterOptionsHandler',
    'passkeyRegisterVerifyHandler',
    'passkeyLoginOptionsHandler',
    'passkeyLoginVerifyHandler',
  ])
);
vi.mock('../email-code', stub(['emailCodeSendHandler', 'emailCodeVerifyHandler']));
vi.mock('../account-provisioning', stub(['accountProvisioningStatusHandler']));
vi.mock(
  '../totp',
  stub([
    'totpLoginStartHandler',
    'totpLoginVerifyHandler',
    'totpSignupActivateHandler',
    'totpSignupOptionsHandler',
  ])
);
vi.mock(
  '../directory-password-login',
  stub([
    'directoryPasswordLoginHandler',
    'directoryMigrationEmailCodeSendHandler',
    'directoryMigrationEmailCodeVerifyHandler',
    'directoryMigrationPasskeyOptionsHandler',
    'directoryMigrationPasskeyVerifyHandler',
  ])
);
vi.mock('../directory-connector-heartbeat', stub(['directoryConnectorHeartbeatHandler']));
vi.mock('../directory-relay-route', stub(['directoryRelayConnectHandler']));
vi.mock('../consent', stub(['consentGetHandler', 'consentPostHandler']));
vi.mock('../login-challenge', stub(['loginChallengeGetHandler']));
vi.mock(
  '../session-management',
  stub([
    'issueSessionTokenHandler',
    'verifySessionTokenHandler',
    'sessionStatusHandler',
    'refreshSessionHandler',
    'checkSessionIframeHandler',
  ])
);
vi.mock('../logout', stub(['frontChannelLogoutHandler', 'backChannelLogoutHandler']));
vi.mock('../did-auth', stub(['didAuthChallengeHandler', 'didAuthVerifyHandler']));
vi.mock(
  '../did-link',
  stub([
    'didRegisterChallengeHandler',
    'didRegisterVerifyHandler',
    'didListHandler',
    'didUnlinkHandler',
  ])
);
vi.mock('../guest-login', stub(['guestLoginHandler']));
vi.mock('../lite-mode', async () => (await import('./helpers/mut-index-stubs')).liteModeStub());
vi.mock('../setup', async () => ({
  setupApp: (await import('./helpers/mut-index-stubs')).emptySubApp(),
}));
vi.mock('../admin-setup-api', async () => ({
  adminSetupApiApp: (await import('./helpers/mut-index-stubs')).emptySubApp(),
}));
vi.mock('../admin-invitation-enrollment', async () => ({
  adminInvitationEnrollmentApp: (await import('./helpers/mut-index-stubs')).emptySubApp(),
}));
vi.mock('../flow-engine', async () => ({
  flowApi: (await import('./helpers/mut-index-stubs')).emptySubApp(),
}));
vi.mock(
  '../direct-auth',
  stub([
    'directPasskeyLoginStartHandler',
    'directPasskeyLoginFinishHandler',
    'directPasskeySignupStartHandler',
    'directPasskeySignupFinishHandler',
    'directPasskeyRegisterStartHandler',
    'directPasskeyRegisterFinishHandler',
    'directEmailCodeSendHandler',
    'directEmailCodeVerifyHandler',
    'directSessionCreateHandler',
    'directTokenHandler',
    'directSessionHandler',
    'directLogoutHandler',
  ])
);
vi.mock(
  '../invitation-handlers',
  stub([
    'sendInvitationEmailCodeHandler',
    'validateInvitationHandler',
    'verifyInvitationEmailCodeHandler',
  ])
);
vi.mock('../registration-fields', stub(['registrationFieldsHandler']));
vi.mock('../public-consent-statements', stub(['publicConsentStatementHandler']));
vi.mock(
  '../login-runtime-flow',
  stub([
    'loginRuntimeEmailVerificationChallengeHandler',
    'loginRuntimeInteractionStartHandler',
    'loginRuntimeInteractionSubmitHandler',
    'loginRuntimeInteractionBackHandler',
    'loginRuntimeInteractionCancelHandler',
  ])
);

import app from '../index';

const env = { ISSUER_URL: 'https://op.example.com' };
const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;
const send = (method: string, path: string) =>
  app.request(`https://op.example.com${path}`, { method }, env, executionCtx);

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  resetCoreCalls();
  resetStubHandlers();
  liteGuardCalls.length = 0;
});

describe('auth worker CSRF and admin gating', () => {
  it('builds the API CSRF guard with the connector heartbeat excluded', () => {
    expect(coreCalls.csrfOptions).toContainEqual({
      excludePaths: ['/api/auth/directory-connectors/heartbeat'],
    });
  });

  it.each([
    '/api/auth/email-codes/verify',
    '/api/sessions/verify',
    '/api/v1/auth/direct/logout',
    '/api/v1/login/interactions/i-1/submit',
    '/auth/consent',
    '/api/v1/invitations/email-verification/verify',
    '/oauth/admin-agent/authorize',
  ])('runs a CSRF guard on POST %s', async (path) => {
    await send('POST', path);
    expect(coreCalls.csrfRuns.map((run) => run.path)).toContain(path);
  });

  it.each(['/authorize', '/par', '/logout/backchannel'])(
    'does not run a CSRF guard on %s',
    async (path) => {
      await send('POST', path);
      expect(coreCalls.csrfRuns).toEqual([]);
    }
  );

  it('gates the admin agent authorize endpoint with a session-only tenant admin check', async () => {
    const [options] = coreCalls.adminAuthOptions;
    expect(options).toMatchObject({ plane: 'tenant', sessionOnly: true });
    await send('GET', '/oauth/admin-agent/authorize');
    await send('POST', '/oauth/admin-agent/par');
    expect(coreCalls.adminAuthRuns).toEqual(['/oauth/admin-agent/authorize']);
  });

  it('only hands a GET without a session over to the login handoff', async () => {
    const [options] = coreCalls.adminAuthOptions;
    const redirect = options.unauthenticatedRedirect as (c: unknown) => Promise<unknown>;
    const handoff = stubHandler('createAdminAgentLoginHandoff');
    handoff.mockReset().mockResolvedValue('https://ui.example/login?handoff=1');
    const getContext = { req: { method: 'GET' } };

    await expect(redirect({ req: { method: 'POST' } })).resolves.toBeUndefined();
    expect(handoff).not.toHaveBeenCalled();
    await expect(redirect(getContext)).resolves.toBe('https://ui.example/login?handoff=1');
    expect(handoff).toHaveBeenCalledWith(getContext);
  });
});

describe('auth worker lite-mode guards', () => {
  it('builds the atomic lite budgets with their limits', () => {
    expect(liteBudgetOptions).toEqual(
      expect.arrayContaining([
        { name: 'liteFlowStart', budget: { perIpPerMinute: 30, perTenantPerMinute: 3000 } },
        {
          name: 'liteFlowEmailChallenge',
          budget: { perIpPerMinute: 30, perTenantPerMinute: 3000 },
        },
        { name: 'litePasskeyOptions', budget: { perIpPerMinute: 20, perTenantPerMinute: 2000 } },
      ])
    );
  });

  it.each([
    '/api/auth/passkeys/register/options',
    '/api/auth/passkeys/register/verify',
    '/api/auth/email-codes/send',
    '/api/auth/email-codes/verify',
    '/api/auth/directory-password/login',
    '/api/auth/dids/challenge',
    '/api/auth/dids/verify',
  ])('refuses %s for a lite tenant before the handler', async (path) => {
    await send('POST', path);
    expect(liteGuardCalls).toContainEqual({ kind: 'refuse', path });
  });

  it('counts lite flow starts and passkey options against their budgets', async () => {
    await send('POST', '/api/v1/login/interactions/start');
    await send('POST', '/api/v1/login/interactions/i-1/email-verification/challenge');
    await send('POST', '/api/auth/passkeys/login/options');
    expect(liteGuardCalls).toEqual([
      { kind: 'budget', name: 'liteFlowStart', path: '/api/v1/login/interactions/start' },
      {
        kind: 'budget',
        name: 'liteFlowEmailChallenge',
        path: '/api/v1/login/interactions/i-1/email-verification/challenge',
      },
      { kind: 'budget', name: 'litePasskeyOptions', path: '/api/auth/passkeys/login/options' },
    ]);
  });
});
