import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  coreCalls,
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

describe('auth worker rate limiting per route', () => {
  it.each([
    [
      'POST',
      '/authorize',
      'authorizeHandler',
      'moderate',
      { endpoints: ['/authorize'], requireAtomic: true },
    ],
    [
      'GET',
      '/authorize',
      'authorizeHandler',
      'moderate',
      { endpoints: ['/authorize'], requireAtomic: true },
    ],
    ['POST', '/par', 'parHandler', 'strict', { endpoints: ['/par'], requireAtomic: true }],
    [
      'POST',
      '/oauth/admin-agent/par',
      'adminAgentParHandler',
      'strict',
      { endpoints: ['/oauth/admin-agent/par'], requireAtomic: true },
    ],
    [
      'GET',
      '/oauth/admin-agent/authorize',
      'adminAgentAuthorizeHandler',
      'moderate',
      { endpoints: ['/oauth/admin-agent/authorize'], requireAtomic: true },
    ],
    [
      'GET',
      '/oauth/admin-agent/login-handoff/consume',
      'adminAgentLoginHandoffConsumeHandler',
      'strict',
      { endpoints: ['/oauth/admin-agent/login-handoff/consume'], requireAtomic: true },
    ],
    [
      'GET',
      '/api/v1/consent-statements/terms',
      'publicConsentStatementHandler',
      'moderate',
      {
        endpoints: ['/api/v1/consent-statements/*'],
        endpointClass: 'public_consent_statement',
        nonBlockingRead: true,
      },
    ],
    [
      'POST',
      '/api/auth/guest/login',
      'guestLoginHandler',
      'strict',
      { endpoints: ['/api/auth/guest/login'] },
    ],
    [
      'POST',
      '/api/auth/passkeys/register/options',
      'passkeyRegisterOptionsHandler',
      'moderate',
      {
        endpoints: ['/api/auth/passkeys/register/options'],
        endpointClass: 'legacy_passkey_register_options',
      },
    ],
    [
      'POST',
      '/api/auth/email-codes/send',
      'emailCodeSendHandler',
      'strict',
      { endpoints: ['/api/auth/email-codes/send'], endpointClass: 'legacy_email_code_send' },
    ],
    [
      'POST',
      '/api/auth/dids/challenge',
      'didAuthChallengeHandler',
      'moderate',
      { endpoints: ['/api/auth/dids/challenge'], endpointClass: 'did_auth_challenge' },
    ],
    [
      'POST',
      '/api/auth/totp/signup/options',
      'totpSignupOptionsHandler',
      'moderate',
      { endpoints: ['/api/auth/totp/signup/options'], endpointClass: 'totp_signup_options' },
    ],
    [
      'POST',
      '/api/auth/directory-password/login',
      'directoryPasswordLoginHandler',
      'strict',
      { endpoints: ['/api/auth/directory-password/login'] },
    ],
    [
      'POST',
      '/api/auth/directory-password/migration/passkey/options',
      'directoryMigrationPasskeyOptionsHandler',
      'strict',
      { endpoints: ['/api/auth/directory-password/migration/passkey'] },
    ],
    [
      'GET',
      '/api/auth/directory-relay/connect/t1/c1',
      'directoryRelayConnectHandler',
      'strict',
      { endpoints: ['/api/auth/directory-relay/connect'] },
    ],
    [
      'POST',
      '/api/v1/invitations/email-verification/send',
      'sendInvitationEmailCodeHandler',
      'strict',
      { endpoints: ['/api/v1/invitations/email-verification'] },
    ],
    [
      'POST',
      '/api/auth/directory-connectors/heartbeat/t1/c1',
      'directoryConnectorHeartbeatHandler',
      'strict',
      { endpoints: ['/api/auth/directory-connectors/heartbeat'] },
    ],
    [
      'POST',
      '/api/v1/auth/direct/email-code/send',
      'directEmailCodeSendHandler',
      'strict',
      { endpoints: ['/api/v1/auth/direct/email-code/send'] },
    ],
    [
      'POST',
      '/api/v1/auth/direct/token',
      'directTokenHandler',
      'moderate',
      { endpoints: ['/api/v1/auth/direct'] },
    ],
    [
      'POST',
      '/api/v1/login/interactions/start',
      'loginRuntimeInteractionStartHandler',
      'loginStart',
      { endpoints: ['/api/v1/login/interactions/start'], endpointClass: 'loginStart' },
    ],
    [
      'POST',
      '/api/v1/login/interactions/i-1/submit',
      'loginRuntimeInteractionSubmitHandler',
      'moderate',
      { endpoints: ['/api/v1/login/interactions'], endpointClass: 'loginInteraction' },
    ],
  ] as const)(
    '%s %s spends exactly one limiter before %s',
    async (method, path, handler, profile, options) => {
      const response = await send(method, path);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ handled: handler, path });
      expect(coreCalls.rateLimitOptions).toEqual([
        { maxRequests: 7, windowSeconds: 30, profile, ...options },
      ]);
      expect(coreCalls.getRateLimitProfileAsync).toHaveBeenCalledTimes(1);
      expect(coreCalls.getRateLimitProfileAsync.mock.calls[0][1]).toBe(profile);
    }
  );

  it('builds the admin invitation limiter globally scoped and atomic', async () => {
    await send('POST', '/api/admin/invitations/anything');
    expect(coreCalls.rateLimitOptions).toEqual([
      {
        maxRequests: 7,
        windowSeconds: 30,
        profile: 'strict',
        endpoints: ['/api/admin/invitations'],
        keyScope: 'global',
        requireAtomic: true,
      },
    ]);
  });

  it('passes the execution context to the login interaction profiles', async () => {
    await send('POST', '/api/v1/login/interactions/start');
    await send('POST', '/api/v1/login/interactions/i-1/back');
    expect(coreCalls.getRateLimitProfileAsync.mock.calls.map((call: unknown[]) => call[2])).toEqual(
      [executionCtx, executionCtx]
    );
  });

  it.each([
    ['POST', '/authorize', 'authorizeHandler'],
    ['POST', '/par', 'parHandler'],
    ['POST', '/api/auth/guest/login', 'guestLoginHandler'],
    ['POST', '/api/v1/auth/direct/email-code/send', 'directEmailCodeSendHandler'],
    ['POST', '/api/v1/auth/direct/session', 'directSessionCreateHandler'],
    ['POST', '/api/v1/login/interactions/start', 'loginRuntimeInteractionStartHandler'],
    ['POST', '/api/v1/login/interactions/i-1/cancel', 'loginRuntimeInteractionCancelHandler'],
  ] as const)('%s %s never reaches %s when the limiter refuses', async (method, path, handler) => {
    coreCalls.rateLimitBlock.value = true;
    const response = await send(method, path);
    expect(response.status).toBe(429);
    expect(stubHandler(handler)).not.toHaveBeenCalled();
  });

  it('leaves the session and consent reads unlimited', async () => {
    for (const [method, path] of [
      ['GET', '/api/sessions/status'],
      ['GET', '/auth/consent'],
      ['GET', '/api/auth/login-challenges'],
      ['GET', '/api/v1/registration-fields'],
    ] as const) {
      expect((await send(method, path)).status).toBe(200);
    }
    expect(coreCalls.rateLimitOptions).toEqual([]);
  });
});
