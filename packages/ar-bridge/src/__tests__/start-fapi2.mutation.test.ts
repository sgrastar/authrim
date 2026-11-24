/**
 * External start: FAPI 2.0 pushed authorization request and diagnostics.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mocks, setupStartMocks } from './helpers/start-mocks';
import { argRec, rec } from './helpers/mock-args';
import {
  FIXED_STATE,
  SIGN_IN,
  baseProvider,
  makeEnv,
  makeKv,
  must,
  start,
} from './helpers/start-harness';

const env = (extra: Record<string, unknown> = {}) => makeEnv(makeKv(), extra);
const stateArg = () => argRec(mocks.storeAuthState, 0, 1);

beforeEach(setupStartMocks);

describe('FAPI 2.0 pushed authorization request', () => {
  const metadata = {
    issuer: 'https://idp.example.com',
    authorization_endpoint: 'https://idp.example.com/authorize',
    pushed_authorization_request_endpoint: 'https://idp.example.com/par',
  };
  const config = (overrides: Record<string, unknown> = {}) => ({
    profile: 'plain_oauth',
    requestObjectSigning: false,
    jarm: false,
    clientAssertionPrivateJwk: { kty: 'EC', d: 'a' },
    dpopPrivateJwk: { kty: 'EC', d: 'b' },
    ...overrides,
  });
  const fapiProvider = { ...baseProvider, scopes: 'openid profile' };

  beforeEach(() => {
    mocks.isFapi2.mockReturnValue(true);
    mocks.discover.mockResolvedValue(metadata);
    mocks.loadFapi2Config.mockResolvedValue(config());
    mocks.push.mockResolvedValue({ request_uri: 'urn:par:abc' });
    mocks.createRequestObject.mockResolvedValue('request.object.jwt');
    mocks.getProvider.mockResolvedValue(fapiProvider);
  });

  it('pushes the form parameters and redirects to the authorization endpoint with the request uri', async () => {
    const response = await start(SIGN_IN, env());
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(
      'https://idp.example.com/authorize?client_id=upstream-client&request_uri=urn%3Apar%3Aabc'
    );
    expect(mocks.loadFapi2Config).toHaveBeenCalledWith(fapiProvider, 'encryption-key');
    expect(mocks.validateFapi2).toHaveBeenCalledWith(metadata, 'plain_oauth', config());
    expect(mocks.fapiCtor).toHaveBeenCalledWith({
      issuer: 'https://idp.example.com',
      clientId: 'upstream-client',
      redirectUri: 'https://auth.example.com/auth/external/corp/callback',
      clientAssertionPrivateJwk: { kty: 'EC', d: 'a' },
      dpopPrivateJwk: { kty: 'EC', d: 'b' },
    });
    expect(mocks.push).toHaveBeenCalledWith('https://idp.example.com/par', {
      client_id: 'upstream-client',
      redirect_uri: 'https://auth.example.com/auth/external/corp/callback',
      response_type: 'code',
      scope: 'openid profile',
      state: FIXED_STATE,
      code_challenge: 'ext-challenge',
      code_challenge_method: 'S256',
    });
    expect(mocks.createRequestObject).not.toHaveBeenCalled();
    expect(mocks.createAuthorizationUrl).not.toHaveBeenCalled();
    const cookie = must(response.headers.get('Set-Cookie'));
    expect(cookie).toContain(`=${FIXED_STATE}`);
    expect(cookie).toContain('Path=/auth/external/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=None');
    expect(cookie).toContain('Max-Age=600');
  });

  it('adds the nonce for the oidc profile and response_mode=jwt for JARM', async () => {
    mocks.loadFapi2Config.mockResolvedValue(config({ profile: 'oidc', jarm: true }));
    await start(SIGN_IN, env());
    expect(mocks.push.mock.calls[0]?.[1]).toMatchObject({
      nonce: 'fixed-nonce-value',
      response_mode: 'jwt',
    });
  });

  it('signs the parameters into a request object when configured', async () => {
    mocks.loadFapi2Config.mockResolvedValue(config({ requestObjectSigning: true }));
    await start(SIGN_IN, env());
    expect(mocks.createRequestObject).toHaveBeenCalledWith({
      client_id: 'upstream-client',
      redirect_uri: 'https://auth.example.com/auth/external/corp/callback',
      response_type: 'code',
      scope: 'openid profile',
      state: FIXED_STATE,
      code_challenge: 'ext-challenge',
      code_challenge_method: 'S256',
    });
    expect(mocks.push).toHaveBeenCalledWith('https://idp.example.com/par', {
      request: 'request.object.jwt',
    });
  });

  it('asks for a new login: max_age is a number in a request object and a string in a form', async () => {
    mocks.challengeKind.mockResolvedValue('reauth');
    mocks.reauthPolicy.mockResolvedValue({ reauthEnabled: true });
    await start(`${SIGN_IN}&authorization_challenge_id=re-1`, env());
    expect(mocks.push.mock.calls[0]?.[1]).toMatchObject({ prompt: 'login', max_age: '0' });

    mocks.loadFapi2Config.mockResolvedValue(config({ requestObjectSigning: true }));
    await start(`${SIGN_IN}&authorization_challenge_id=re-1`, env());
    expect(mocks.createRequestObject.mock.calls[0]?.[0]).toMatchObject({
      prompt: 'login',
      max_age: 0,
    });
  });

  it('does not add prompt or max_age without a re-authentication', async () => {
    await start(SIGN_IN, env());
    expect(mocks.push.mock.calls[0]?.[1]).not.toHaveProperty('prompt');
    expect(mocks.push.mock.calls[0]?.[1]).not.toHaveProperty('max_age');
  });

  it('fails without an encryption key before discovery', async () => {
    mocks.getEncryptionKey.mockReturnValueOnce('encryption-key'); // the client secret
    mocks.getEncryptionKey.mockReturnValueOnce(undefined);
    const response = await start(SIGN_IN, env({ ENABLE_CONFORMANCE_MODE: 'true' }));
    expect(response.status).toBe(500);
    expect(rec(await response.json()).error_description).toBe(
      'Failed to start external login: RP_TOKEN_ENCRYPTION_KEY is not configured'
    );
    expect(mocks.discover).not.toHaveBeenCalled();
  });

  it('fails when metadata validation fails, without pushing', async () => {
    mocks.validateFapi2.mockImplementation(() => {
      throw new Error('bad metadata');
    });
    const response = await start(SIGN_IN, env());
    expect(response.status).toBe(500);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('records the pushed request in the diagnostics and cleans up', async () => {
    mocks.createDiag.mockResolvedValue({
      logAuthDecision: mocks.diagLog,
      cleanup: mocks.diagCleanup,
    });
    const response = await start(SIGN_IN, env());
    expect(response.status).toBe(302);
    expect(mocks.createDiag).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'default',
      clientId: 'upstream-client',
    });
    expect(mocks.diagLog).toHaveBeenCalledTimes(1);
    expect(mocks.diagLog).toHaveBeenCalledWith({
      diagnosticSessionId: 'diag-session',
      decision: 'allow',
      reason: 'fapi2_pushed_authorization_request',
      flow: 'external_idp',
      flowId: stateArg().flowId,
      context: {
        provider: 'corp',
        client_id: 'upstream-client',
        authrim_client_id: 'client-a',
        authorization_endpoint: 'https://idp.example.com/authorize',
        pushed_authorization_request_endpoint: 'https://idp.example.com/par',
        redirect_uri: 'https://auth.example.com/auth/external/corp/callback',
        response_type: 'code',
        scope: 'openid profile',
        state_present: true,
        nonce_present: true,
        code_challenge_present: true,
        code_challenge_method: 'S256',
      },
    });
    expect(mocks.diagCleanup).toHaveBeenCalledTimes(1);
  });
});

describe('diagnostics', () => {
  const diagnostics = () => ({ logAuthDecision: mocks.diagLog, cleanup: mocks.diagCleanup });

  it('records an allowed authorization request without leaking secrets', async () => {
    mocks.createDiag.mockResolvedValue(diagnostics());
    mocks.createAuthorizationUrl.mockResolvedValue(
      'https://idp.example.com/authorize?code_challenge=c&code_challenge_method=S256&request_uri=urn%3Ax&state=s'
    );
    mocks.getProvider.mockResolvedValue({
      ...baseProvider,
      requestObjectSigningAlg: 'ES256',
    });
    const response = await start(
      `${SIGN_IN}&login_hint=h&max_age=20&acr_values=a&prompt=login`,
      env()
    );
    expect(response.status).toBe(302);
    expect(mocks.diagLog).toHaveBeenCalledWith({
      diagnosticSessionId: 'diag-session',
      decision: 'allow',
      reason: 'authorization_request',
      flow: 'external_idp',
      flowId: stateArg().flowId,
      context: {
        provider: 'corp',
        client_id: 'upstream-client',
        authrim_client_id: 'client-a',
        authorization_endpoint: 'https://idp.example.com/authorize',
        redirect_uri: 'https://auth.example.com/auth/external/corp/callback',
        response_type: 'code',
        scope: 'openid email',
        state_present: true,
        nonce_present: true,
        code_challenge_present: true,
        code_challenge_method: 'S256',
        request_uri_present: true,
        request_object_by_reference: true,
        request_object_signing_alg: 'ES256',
        response_mode: undefined,
        prompt_present: true,
        login_hint_present: true,
        max_age: 20,
        acr_values: 'a',
      },
    });
    expect(mocks.diagCleanup).toHaveBeenCalledTimes(1);
  });

  it('reports absent optional request details as false', async () => {
    mocks.createDiag.mockResolvedValue(diagnostics());
    await start(SIGN_IN, env());
    const context = argRec(mocks.diagLog, 0, 0).context;
    expect(context).toMatchObject({
      code_challenge_present: false,
      code_challenge_method: null,
      request_uri_present: false,
      request_object_by_reference: false,
      prompt_present: false,
      login_hint_present: false,
    });
  });

  it.each([
    ['discovery failed', 'discovery_validation_failed'],
    ['bad ISSUER', 'discovery_validation_failed'],
    ['jwks fetch', 'discovery_validation_failed'],
    ['boom', 'authorization_request_failed'],
  ])('records a denial for "%s" as %s', async (message, reason) => {
    mocks.createDiag.mockResolvedValue(diagnostics());
    mocks.createAuthorizationUrl.mockRejectedValue(new Error(message));
    const response = await start(SIGN_IN, env());
    expect(response.status).toBe(500);
    expect(mocks.diagLog).toHaveBeenCalledTimes(1);
    expect(mocks.diagLog).toHaveBeenCalledWith({
      diagnosticSessionId: 'diag-session',
      flowId: stateArg().flowId,
      decision: 'deny',
      reason,
      flow: 'external_idp',
      context: { provider: 'corp', error_name: 'Error', error_message: message },
    });
    expect(mocks.diagCleanup).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenCalledWith(
      'External start error',
      expect.objectContaining({ errorName: 'Error', errorMessage: message, provider: 'corp' }),
      expect.any(Error)
    );
  });

  it('survives a failing diagnostic write and a failing cleanup', async () => {
    mocks.createDiag.mockResolvedValue(diagnostics());
    mocks.createAuthorizationUrl.mockRejectedValue(new Error('boom'));
    mocks.diagLog.mockRejectedValue(new Error('diag down'));
    mocks.diagCleanup.mockRejectedValue(new Error('cleanup down'));
    const response = await start(SIGN_IN, env());
    expect(response.status).toBe(500);
    expect(mocks.warn).toHaveBeenCalledWith(
      'Failed to record external start rejection diagnostic',
      {
        error: 'diag down',
      }
    );
    mocks.warn.mockClear();
    mocks.diagLog.mockRejectedValue('text failure');
    await start(SIGN_IN, env());
    expect(mocks.warn).toHaveBeenCalledWith(
      'Failed to record external start rejection diagnostic',
      {
        error: 'text failure',
      }
    );
  });
});
