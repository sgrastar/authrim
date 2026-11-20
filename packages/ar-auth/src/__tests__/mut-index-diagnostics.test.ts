import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import {
  coreCalls,
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

const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;
const operatorEnv = {
  ISSUER_URL: 'https://op.example.com',
  AUTHRIM_DIAGNOSTIC_TIMING_ENABLED: 'true',
};

const post = (path: string, sessionId?: string, env: Record<string, unknown> = operatorEnv) =>
  app.request(
    `https://op.example.com${path}`,
    {
      method: 'POST',
      headers: sessionId === undefined ? {} : { 'X-Diagnostic-Session-Id': sessionId },
    },
    env,
    executionCtx
  );

function serverTiming(response: Response): Array<{ name: string; dur: number }> {
  const header = response.headers.get('Server-Timing') ?? '';
  return header
    .split(', ')
    .filter(Boolean)
    .map((entry) => {
      const match = /^([a-z_]+);dur=(\d+\.\d)$/u.exec(entry);
      if (!match) throw new Error(`malformed Server-Timing entry ${entry}`);
      return { name: match[1], dur: Number(match[2]) };
    });
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  resetCoreCalls();
  resetStubHandlers();
  let now = 0;
  // Every clock read advances 1.26 ms, so unrounded or misrounded durations are visible.
  vi.spyOn(performance, 'now').mockImplementation(() => (now += 1.26));
});
afterEach(() => vi.restoreAllMocks());

describe('auth request diagnostic timing', () => {
  it('times each middleware stage of /authorize in order', async () => {
    const response = await post('/authorize', 'operator-session');

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Authrim-Diagnostic-Session-Id')).toBe('operator-session');
    const spans = serverTiming(response);
    expect(spans.map((span) => span.name)).toEqual([
      'auth_redirect_https',
      'auth_request_context',
      'auth_body_limit',
      'auth_diagnostic_logging',
      'auth_secure_headers',
      'auth_cors',
      'auth_rate_limit_profile',
      'auth_rate_limit',
      'auth_handler_downstream',
      'auth_total',
    ]);
    for (const span of spans) {
      expect(span.dur).toBeGreaterThan(0);
      expect(span.dur).toBeLessThan(100);
      expect(Math.abs(span.dur * 10 - Math.round(span.dur * 10))).toBeLessThan(1e-9);
    }
    const total = spans[spans.length - 1].dur;
    expect(spans.slice(0, -1).every((span) => span.dur < total)).toBe(true);
  });

  it('logs the stage timings with the request outcome', async () => {
    stubHandler('authorizeHandler').mockImplementation((c: Context) => c.json({}, 400));
    await post('/authorize', 'operator-session');

    expect(coreCalls.logModules).toContain('AUTH-REQUEST-TIMING');
    expect(coreCalls.logInfo).toHaveBeenCalledTimes(1);
    const [message, fields] = coreCalls.logInfo.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe('Auth request middleware diagnostics');
    expect(fields).toMatchObject({
      diagnosticSessionId: 'operator-session',
      method: 'POST',
      path: '/authorize',
      status: 400,
    });
    const timing = fields.timingMs as Record<string, number>;
    expect(Object.keys(timing)).toContain('auth_total');
    expect(timing.auth_total).toBeGreaterThan(timing.auth_cors);
  });

  it('appends to a Server-Timing header the handler already set', async () => {
    stubHandler('authorizeHandler').mockImplementation((c: Context) => {
      c.header('Server-Timing', 'app;dur=2.0');
      return c.json({});
    });
    const response = await post('/authorize', 'operator-session');
    const header = response.headers.get('Server-Timing') ?? '';
    expect(header.startsWith('app;dur=2.0, auth_redirect_https;dur=')).toBe(true);
  });

  it.each([
    [
      '/api/v1/login/interactions/start',
      ['auth_cors', 'auth_csrf', 'auth_rate_limit_profile', 'auth_rate_limit'],
    ],
    ['/api/auth/email-codes/verify', ['auth_cors', 'auth_csrf']],
    ['/api/auth/totp/login/start', ['auth_cors', 'auth_handler_downstream']],
    ['/api/auth/totp/login/verify', ['auth_cors', 'auth_handler_downstream']],
  ])('times %s', async (path, expected) => {
    const response = await post(path, 'operator-session');
    const names = serverTiming(response).map((span) => span.name);
    expect(names.slice(0, 5)).toEqual([
      'auth_redirect_https',
      'auth_request_context',
      'auth_body_limit',
      'auth_diagnostic_logging',
      'auth_secure_headers',
    ]);
    const from = names.indexOf('auth_cors');
    expect(names.slice(from, from + expected.length)).toEqual(expected);
    expect(names.at(-1)).toBe('auth_total');
  });

  it('does not time a path outside the diagnostic set', async () => {
    const response = await post('/par', 'operator-session');
    expect(response.headers.get('Server-Timing')).toBeNull();
    expect(response.headers.get('X-Authrim-Diagnostic-Session-Id')).toBeNull();
    expect(coreCalls.logInfo).not.toHaveBeenCalled();
  });

  it('replaces unsafe characters in the session id and caps its length', async () => {
    const unsafe = await post('/authorize', '  run id/<x>;1  ');
    expect(unsafe.headers.get('X-Authrim-Diagnostic-Session-Id')).toBe('run_id__x__1');

    const kept = await post('/authorize', 'Az09._:-');
    expect(kept.headers.get('X-Authrim-Diagnostic-Session-Id')).toBe('Az09._:-');

    const long = await post('/authorize', 'a'.repeat(200));
    expect(long.headers.get('X-Authrim-Diagnostic-Session-Id')).toBe('a'.repeat(128));
  });

  it.each([undefined, '', '   '])('stays off without a usable session id (%j)', async (id) => {
    const response = await post('/authorize', id);
    expect(response.headers.get('Server-Timing')).toBeNull();
    expect(response.headers.get('X-Authrim-Diagnostic-Session-Id')).toBeNull();
  });

  it.each(['true', '1', 'yes', ' YES ', 'True'])(
    'turns on for the operator flag %j',
    async (flag) => {
      const response = await post('/authorize', 'operator-session', {
        ISSUER_URL: 'https://op.example.com',
        AUTHRIM_DIAGNOSTIC_TIMING_ENABLED: flag,
      });
      expect(response.headers.get('X-Authrim-Diagnostic-Session-Id')).toBe('operator-session');
    }
  );

  it.each(['false', '0', 'no', 'on', ''])('stays off for the operator flag %j', async (flag) => {
    const response = await post('/authorize', 'operator-session', {
      ISSUER_URL: 'https://op.example.com',
      AUTHRIM_DIAGNOSTIC_TIMING_ENABLED: flag,
    });
    expect(response.headers.get('X-Authrim-Diagnostic-Session-Id')).toBeNull();
  });

  it('turns on for a Phase 0c run id in a test environment without the flag', async () => {
    const env = { ISSUER_URL: 'https://op.example.com', AUTHRIM_ENVIRONMENT_NAME: 'test' };
    const runId = 'phase0c-mail-20260731102030-abcdef';
    const response = await post('/authorize', runId, env);
    expect(response.headers.get('X-Authrim-Diagnostic-Session-Id')).toBe(runId);
    const unnamed = await post('/authorize', runId, { ISSUER_URL: 'https://op.example.com' });
    expect(unnamed.headers.get('X-Authrim-Diagnostic-Session-Id')).toBeNull();
  });
});
