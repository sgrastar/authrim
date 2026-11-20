import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AR_ERROR_CODES } from '@authrim/ar-lib-core';
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

const baseEnv = { ISSUER_URL: 'https://op.example.com' };
const call = (path: string, init: RequestInit = {}, env: Record<string, unknown> = baseEnv) =>
  app.request(path.startsWith('http') ? path : `https://op.example.com${path}`, init, env);

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  resetCoreCalls();
  resetStubHandlers();
});

describe('auth worker fixed responses', () => {
  it('reports health with the short code version and deploy time', async () => {
    const response = await call(
      '/api/auth/health',
      {},
      {
        ...baseEnv,
        CODE_VERSION_UUID: '0123456789abcdef',
        DEPLOY_TIME_UTC: '2026-11-19T00:00:00Z',
      }
    );
    const body = await response.json<Record<string, string>>();
    expect(body).toMatchObject({
      status: 'ok',
      service: 'ar-auth',
      version: '0.1.0',
      codeVersion: '01234567',
      deployTime: '2026-11-19T00:00:00Z',
    });
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it('reports not-set when the deployment metadata is absent', async () => {
    const body = await (await call('/api/auth/health')).json<Record<string, string>>();
    expect(body.codeVersion).toBe('not-set');
    expect(body.deployTime).toBe('not-set');
  });

  it('rejects GET /par as a method error without reaching the PAR handler', async () => {
    const response = await call('/par');
    expect(response.status).toBe(405);
    expect(await response.json()).toMatchObject({
      error: 'invalid_request',
      error_code: AR_ERROR_CODES.VALIDATION_METHOD_NOT_ALLOWED,
    });
    expect(stubHandler('parHandler')).not.toHaveBeenCalled();
  });

  it.each([
    ['/logged-out', 'https://ui.example.com/bye'],
    ['/logout-error?error=bad_hint', 'https://ui.example.com/oops?error=bad_hint'],
    ['/logout-error', 'https://ui.example.com/oops?error=unknown_error'],
  ])('redirects %s to the configured UI page', async (path, location) => {
    coreCalls.getUIConfig.mockResolvedValue({
      baseUrl: 'https://ui.example.com',
      paths: { loggedOut: '/bye', error: '/oops' },
    });
    const response = await call(path);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(location);
    expect(coreCalls.getUIConfig).toHaveBeenCalledWith(expect.anything(), 'default');
  });

  it.each(['/logged-out', '/logout-error'])(
    'answers %s with a configuration error when no UI is configured',
    async (path) => {
      for (const config of [null, { baseUrl: '' }]) {
        coreCalls.getUIConfig.mockResolvedValue(config);
        const response = await call(path);
        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({ error: 'configuration_error' });
      }
    }
  );

  it('answers unknown routes with the not-found error', async () => {
    const response = await call('/definitely-not-a-route');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error_code: AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND,
    });
  });

  it('hides unhandled errors behind server_error and logs them', async () => {
    const failure = new Error('db exploded');
    stubHandler('consentGetHandler').mockRejectedValue(failure);
    const response = await call('/auth/consent');
    expect(response.status).toBe(500);
    const body = await response.json<Record<string, string>>();
    expect(body).toMatchObject({
      error: 'server_error',
      error_code: AR_ERROR_CODES.INTERNAL_ERROR,
    });
    expect(JSON.stringify(body)).not.toContain('db exploded');
    expect(coreCalls.writeFence).toHaveBeenCalledWith(expect.anything(), failure);
    expect(coreCalls.logModules).toContain('AR-AUTH');
    expect(coreCalls.logError).toHaveBeenCalledWith(
      'Unhandled error',
      { action: 'error_handler' },
      failure
    );
  });

  it('returns the placement write-fence response instead of server_error', async () => {
    stubHandler('consentGetHandler').mockRejectedValue(new Error('fenced'));
    coreCalls.writeFence.mockReturnValue(new Response('fenced', { status: 409 }));
    const response = await call('/auth/consent');
    expect(response.status).toBe(409);
    expect(await response.text()).toBe('fenced');
    expect(coreCalls.logError).not.toHaveBeenCalled();
  });

  it('refuses bodies over 100 KiB with payload_too_large before the handler', async () => {
    const response = await call('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'x'.repeat(100 * 1024 + 1),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: 'payload_too_large',
      error_description: 'Request body exceeds maximum allowed size',
    });
    expect(stubHandler('issueSessionTokenHandler')).not.toHaveBeenCalled();
    const atLimit = await call('/api/sessions', { method: 'POST', body: 'x'.repeat(100 * 1024) });
    expect(atLimit.status).toBe(200);
  });

  it('excludes only health and setup paths from diagnostic logging', () => {
    const [{ excludePatterns }] = coreCalls.diagnosticLoggingOptions;
    const excluded = (path: string) => excludePatterns.some((pattern) => pattern.test(path));
    expect(excluded('/api/health')).toBe(true);
    expect(excluded('/health/live')).toBe(true);
    expect(excluded('/admin-init-setup/x')).toBe(true);
    expect(excluded('/authorize')).toBe(false);
    expect(excluded('/x/api/health')).toBe(false);
  });
});

describe('auth worker security headers', () => {
  it('applies the strict header set to ordinary responses', async () => {
    const response = await call('/api/auth/login-challenges');
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: https:; connect-src 'self'; font-src 'self'; object-src 'none'; " +
        "media-src 'self'; frame-src 'none'"
    );
    expect(response.headers.get('strict-transport-security')).toBe(
      'max-age=63072000; includeSubDomains; preload'
    );
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('permissions-policy')).toBe(
      'camera=(), microphone=(), geolocation=(), payment=()'
    );
  });

  it.each(['/session/check', '/logout', '/admin-init-setup/anything'])(
    'leaves %s free to set its own framing headers',
    async (path) => {
      const response = await call(path);
      expect(response.headers.get('x-frame-options')).toBeNull();
      expect(response.headers.get('content-security-policy')).toBeNull();
    }
  );

  it('still frames-denies /logout/backchannel', async () => {
    const response = await call('/logout/backchannel', { method: 'POST' });
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });
});

describe('auth worker CORS', () => {
  const preflight = (origin: string, env: Record<string, unknown> = baseEnv) =>
    call(
      '/api/sessions/status',
      {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
      },
      env
    );

  it('reads the tenant allowlist leniently from tenant settings', async () => {
    await preflight('https://rp.example.com');
    expect(coreCalls.getTenantSettingsDocument).toHaveBeenCalledWith(
      expect.anything(),
      'default',
      'tenant',
      { onUnreadable: 'empty' }
    );
  });

  it('allows the issuer origin when nothing else is configured', async () => {
    const response = await preflight('https://op.example.com');
    expect(response.headers.get('access-control-allow-origin')).toBe('https://op.example.com');
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('access-control-max-age')).toBe('86400');
    expect(response.headers.get('access-control-allow-methods')).toBe('GET,POST,OPTIONS');
  });

  it('rejects an origin outside the allowlist', async () => {
    const response = await preflight('https://evil.example.com');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('uses the tenant allowlist when the environment sets none', async () => {
    coreCalls.getTenantSettingsDocument.mockResolvedValue({
      'tenant.allowed_origins': 'https://rp.example.com',
    });
    const response = await preflight('https://rp.example.com');
    expect(response.headers.get('access-control-allow-origin')).toBe('https://rp.example.com');
  });

  it('ignores a tenant allowlist that is not a string', async () => {
    coreCalls.getTenantSettingsDocument.mockResolvedValue({
      'tenant.allowed_origins': ['https://rp.example.com'],
    });
    const response = await preflight('https://rp.example.com');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('lets the environment allowlist override the tenant allowlist', async () => {
    coreCalls.getTenantSettingsDocument.mockResolvedValue({
      'tenant.allowed_origins': 'https://rp.example.com',
    });
    const env = { ...baseEnv, ALLOWED_ORIGINS: 'https://admin.example.com' };
    expect(
      (await preflight('https://rp.example.com', env)).headers.get('access-control-allow-origin')
    ).toBeNull();
    expect(
      (await preflight('https://admin.example.com', env)).headers.get('access-control-allow-origin')
    ).toBe('https://admin.example.com');
  });

  it('answers a request without Origin with the request issuer', async () => {
    const response = await call('/api/sessions/status');
    expect(response.headers.get('access-control-allow-origin')).toBe('https://op.example.com');
  });
});

describe('auth worker HTTPS redirect', () => {
  it.each([['http://localhost/api/sessions/status'], ['http://127.0.0.1/api/sessions/status']])(
    'serves loopback HTTP %s without redirecting',
    async (url) => {
      const response = await call(url);
      expect(response.status).toBe(200);
    }
  );

  it('redirects a request forwarded over HTTP to HTTPS', async () => {
    const response = await call('/api/sessions/status?a=1', {
      headers: { 'X-Forwarded-Proto': 'HTTP' },
    });
    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe('https://op.example.com/api/sessions/status?a=1');
  });

  it('does not redirect a request forwarded over HTTPS', async () => {
    const response = await call('/api/sessions/status', {
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    expect(response.status).toBe(200);
  });
});
