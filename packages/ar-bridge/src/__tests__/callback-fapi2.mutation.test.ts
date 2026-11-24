/**
 * External callback: the FAPI 2.0 flow, diagnostics, and the pure helpers (JARM state,
 * failure classification).
 */
import * as jose from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { argRec, entriesOf, rec } from './helpers/mock-args';
import { M, setupCallbackMocks } from './helpers/callback-mocks';
import { ExternalIdPErrorCode } from '../types';
import { classifyFapi2CallbackError, extractUnverifiedJarmState } from '../handlers/callback';
import {
  STATE,
  authState,
  callback,
  oauthProvider,
  oidcProvider,
  paramsOf,
} from './helpers/callback-harness';

beforeEach(setupCallbackMocks);

const metadata = {
  issuer: 'https://idp.example.com',
  token_endpoint: 'https://idp.example.com/token',
  jwks_uri: 'https://idp.example.com/jwks',
  id_token_signing_alg_values_supported: ['ES256'],
};
const config = (overrides: Record<string, unknown> = {}) => ({
  profile: 'plain_oauth',
  jarm: false,
  requestObjectSigning: false,
  authorizationSignedResponseAlg: 'ES256',
  clientAssertionPrivateJwk: { kty: 'EC', d: 'a' },
  dpopPrivateJwk: { kty: 'EC', d: 'b' },
  ...overrides,
});
const Q = `code=upstream-code&state=${STATE}&iss=${encodeURIComponent('https://idp.example.com')}`;
const fapiTokens = { access_token: 'dpop-access', token_type: 'DPoP', expires_in: 300 };

describe('FAPI 2.0 callback', () => {
  beforeEach(() => {
    M.isFapi2.mockReturnValue(true);
    M.getProvider.mockResolvedValue(oidcProvider);
    M.discover.mockResolvedValue(metadata);
    M.loadFapi2Config.mockResolvedValue(config());
    M.fapiExchange.mockResolvedValue(fapiTokens);
    M.fapiResource.mockResolvedValue({ account_id: 'res-1', email: 'r@example.com' });
    M.createDiag.mockResolvedValue({
      logTokenValidation: M.logTokenValidation,
      logAuthDecision: M.logAuthDecision,
      cleanup: M.diagCleanup,
    });
    M.getProvider.mockResolvedValue({
      ...oidcProvider,
      attributeMapping: { sub: 'account_id' },
    });
  });

  const stepsLogged = () => entriesOf(M.logTokenValidation).map((entry) => entry.step);

  it('validates the provider, exchanges the code with DPoP and reads the resource', async () => {
    M.loadFapi2Config.mockResolvedValue(config({ resourceUrl: 'https://idp.example.com/res' }));
    const response = await callback({ query: Q });
    expect(response.status).toBe(302);
    expect(M.loadFapi2Config).toHaveBeenCalledWith(expect.anything(), 'encryption-key');
    expect(M.validateFapi2).toHaveBeenCalledTimes(2);
    expect(M.validateFapi2).toHaveBeenCalledWith(
      metadata,
      'plain_oauth',
      config({ resourceUrl: 'https://idp.example.com/res' })
    );
    expect(M.fapiCtor).toHaveBeenCalledWith({
      issuer: 'https://idp.example.com',
      clientId: 'upstream-client',
      redirectUri: 'https://auth.example.com/auth/external/corp/callback',
      clientAssertionPrivateJwk: { kty: 'EC', d: 'a' },
      dpopPrivateJwk: { kty: 'EC', d: 'b' },
    });
    expect(M.fapiExchange).toHaveBeenCalledWith({
      tokenEndpoint: 'https://idp.example.com/token',
      code: 'upstream-code',
      codeVerifier: 'verifier-a',
    });
    expect(M.exchangeCode).not.toHaveBeenCalled();
    expect(M.fapiResource).toHaveBeenCalledWith({
      resourceUrl: 'https://idp.example.com/res',
      accessToken: 'dpop-access',
    });
    expect(argRec(M.handleIdentity, 0, 1).userInfo).toEqual({
      account_id: 'res-1',
      email: 'r@example.com',
      sub: 'res-1',
    });
  });

  it('logs each validation stage as it passes', async () => {
    M.loadFapi2Config.mockResolvedValue(config({ resourceUrl: 'https://idp.example.com/res' }));
    await callback({ query: Q });
    expect(stepsLogged()).toEqual([
      'fapi2-provider-metadata-validation',
      'fapi2-authorization-response-validation',
      'fapi2-token-response-validation',
      'token-request',
      'token-response',
      'fapi2-resource-response-validation',
    ]);
    const calls = entriesOf(M.logTokenValidation);
    expect(calls[0]).toEqual({
      diagnosticSessionId: undefined,
      flowId: 'flow-a',
      step: 'fapi2-provider-metadata-validation',
      tokenType: 'provider_metadata',
      result: 'pass',
      details: { issuer_valid: true, profile: 'plain_oauth' },
    });
    expect(calls[1]).toMatchObject({
      tokenType: 'authorization_response',
      details: { issuer_valid: true, state_valid: true, signature_valid: undefined },
    });
    expect(calls[2]).toMatchObject({
      tokenType: 'token_response',
      details: { access_token_present: true, token_type_valid: true, expires_in_present: true },
    });
    expect(calls[5]).toMatchObject({
      tokenType: 'resource_response',
      details: { dpop_authorization_scheme_accepted: true },
    });
    expect(M.diagCleanup).toHaveBeenCalledTimes(1);
  });

  it('flags a non-DPoP token type and a missing expiry in the token-response log', async () => {
    M.fapiExchange.mockResolvedValue({ access_token: 'a', token_type: 'Bearer' });
    await callback({ query: Q });
    const entry = entriesOf(M.logTokenValidation).find(
      (e) => e.step === 'fapi2-token-response-validation'
    );
    expect(entry?.details).toEqual({
      access_token_present: true,
      token_type_valid: false,
      expires_in_present: false,
    });
  });

  it('requires the issuer parameter to equal the provider issuer', async () => {
    const missing = await callback({ query: `code=c&state=${STATE}` });
    expect(paramsOf(missing).error).toBe(ExternalIdPErrorCode.CALLBACK_FAILED);
    const wrong = await callback({
      query: `code=c&state=${STATE}&iss=${encodeURIComponent('https://evil.example')}`,
    });
    expect(paramsOf(wrong).error).toBe(ExternalIdPErrorCode.CALLBACK_FAILED);
    expect(M.fapiExchange).not.toHaveBeenCalled();
    const denial = entriesOf(M.logAuthDecision);
    expect(denial[0]).toEqual({
      diagnosticSessionId: undefined,
      flowId: 'flow-a',
      decision: 'deny',
      reason: 'fapi2_callback_rejected',
      flow: 'fapi2',
      context: { validation_stage: 'authorization-response', validation_error: 'missing_issuer' },
    });
    expect(rec(denial[1]?.context).validation_error).toBe('issuer_mismatch');
  });

  it('refuses a provider without an issuer configured', async () => {
    M.getProvider.mockResolvedValue({ ...oidcProvider, issuer: undefined });
    expect(paramsOf(await callback({ query: Q })).error).toBe(ExternalIdPErrorCode.CALLBACK_FAILED);
  });

  it('refuses an unexpected JARM response when the provider does not use JARM', async () => {
    const response = await callback({ query: `${Q}&response=a.b.c` });
    expect(paramsOf(response).error).toBe(ExternalIdPErrorCode.CALLBACK_FAILED);
    expect(M.validateJarm).not.toHaveBeenCalled();
  });

  describe('JARM', () => {
    const jarm = () => M.loadFapi2Config.mockResolvedValue(config({ jarm: true }));
    const jwt = () =>
      `${jose.base64url.encode('{"alg":"none"}')}.${jose.base64url.encode(JSON.stringify({ state: STATE }))}.sig`;
    beforeEach(() => {
      jarm();
      M.safeFetchJson.mockResolvedValue({ keys: [{ kty: 'EC' }] });
      M.validateJarm.mockResolvedValue({
        code: 'jarm-code',
        state: STATE,
        iss: 'https://idp.example.com',
      });
    });

    it('verifies the response against the provider keys and takes code, state and issuer from it', async () => {
      const response = await callback({ query: `response=${jwt()}` });
      expect(response.status).toBe(302);
      expect(M.safeFetchJson).toHaveBeenCalledWith('https://idp.example.com/jwks', {
        timeoutMs: 5_000,
        maxResponseSize: 256 * 1024,
      });
      expect(M.validateJarm).toHaveBeenCalledWith({
        responseJwt: jwt(),
        jwks: { keys: [{ kty: 'EC' }] },
        expectedState: STATE,
        signingAlgorithm: 'ES256',
      });
      expect(argRec(M.fapiExchange, 0, 0).code).toBe('jarm-code');
      const stage = entriesOf(M.logTokenValidation).find(
        (e) => e.step === 'fapi2-authorization-response-validation'
      );
      expect(stage).toMatchObject({
        tokenType: 'jarm',
        details: { issuer_valid: true, state_valid: true, signature_valid: true },
      });
    });

    it('requires a JARM response and a jwks_uri', async () => {
      const missing = await callback({ query: Q });
      expect(paramsOf(missing).error).toBe(ExternalIdPErrorCode.CALLBACK_FAILED);
      M.discover.mockResolvedValue({ ...metadata, jwks_uri: undefined });
      const noJwks = await callback({ query: `response=${jwt()}` });
      expect(paramsOf(noJwks).error).toBe(ExternalIdPErrorCode.CALLBACK_FAILED);
      expect(M.safeFetchJson).not.toHaveBeenCalled();
    });

    it('relays an error carried inside the JARM response', async () => {
      M.validateJarm.mockResolvedValue({
        state: STATE,
        iss: 'https://idp.example.com',
        error: 'access_denied',
        error_description: 'declined',
      });
      const response = await callback({ query: `response=${jwt()}` });
      expect(paramsOf(response)).toEqual({ error: 'access_denied', error_description: 'declined' });
      expect(M.fapiExchange).not.toHaveBeenCalled();
    });

    it('classifies a rejected JARM response in the diagnostics', async () => {
      M.validateJarm.mockRejectedValue(new Error('JARM response state mismatch'));
      const response = await callback({ query: `response=${jwt()}` });
      expect(paramsOf(response).error).toBe(ExternalIdPErrorCode.CALLBACK_FAILED);
      const failure = entriesOf(M.logTokenValidation).find((e) => e.result === 'fail');
      expect(failure).toEqual({
        diagnosticSessionId: undefined,
        flowId: 'flow-a',
        step: 'fapi2-authorization-response-validation',
        tokenType: 'authorization_response',
        result: 'fail',
        errorMessage: 'state_mismatch',
        details: { validation_error: 'state_mismatch' },
      });
      expect(argRec(M.logAuthDecision, M.logAuthDecision.mock.calls.length - 1, 0)).toMatchObject({
        decision: 'deny',
        reason: 'fapi2_callback_rejected',
        flow: 'fapi2',
        context: { validation_stage: 'authorization-response', validation_error: 'state_mismatch' },
      });
    });
  });

  describe('id_token and resource', () => {
    beforeEach(() => {
      M.loadFapi2Config.mockResolvedValue(
        config({ profile: 'oidc', resourceUrl: 'https://idp.example.com/res' })
      );
      M.fapiExchange.mockResolvedValue({ ...fapiTokens, id_token: 'id.token.jwt' });
      M.validateIdToken.mockResolvedValue({ sub: 'ext-sub', email: 'id@example.com' });
      M.fapiResource.mockResolvedValue({ sub: 'ext-sub', name: 'From Resource' });
    });

    it('validates the id_token strictly and merges the resource over it', async () => {
      M.getProvider.mockResolvedValue({ ...oidcProvider });
      await callback({ query: Q });
      expect(M.validateIdToken).toHaveBeenCalledWith(
        'id.token.jwt',
        expect.objectContaining({
          nonce: 'nonce-a',
          accessToken: 'dpop-access',
          requireExactAudience: true,
          expectedSigningAlgorithms: ['ES256'],
        }),
        expect.objectContaining({ flowId: 'flow-a' })
      );
      expect(argRec(M.handleIdentity, 0, 1).userInfo).toEqual({
        sub: 'ext-sub',
        email: 'id@example.com',
        name: 'From Resource',
      });
      expect(
        entriesOf(M.logTokenValidation).find((e) => e.step === 'fapi2-resource-response-validation')
          ?.details
      ).toEqual({ dpop_authorization_scheme_accepted: true, subject_consistent: true });
      expect(M.fetchUserInfo).not.toHaveBeenCalled();
    });

    it('refuses a resource whose subject differs from the id_token', async () => {
      M.getProvider.mockResolvedValue({ ...oidcProvider });
      M.fapiResource.mockResolvedValue({ sub: 'someone-else' });
      const response = await callback({ query: Q });
      expect(paramsOf(response).error).toBe(ExternalIdPErrorCode.CALLBACK_FAILED);
      expect(M.handleIdentity).not.toHaveBeenCalled();
      expect(
        rec(argRec(M.logAuthDecision, M.logAuthDecision.mock.calls.length - 1, 0).context)
          .validation_stage
      ).toBe('resource-response');
    });

    it.each([[5], [null], [{ id: 'x' }], [['ext-sub']]])(
      'refuses a resource subject of another type (%j) instead of letting it replace the verified one',
      async (sub) => {
        M.getProvider.mockResolvedValue({ ...oidcProvider });
        M.fapiResource.mockResolvedValue({ sub });
        const response = await callback({ query: Q });
        expect(paramsOf(response).error).toBe(ExternalIdPErrorCode.CALLBACK_FAILED);
        expect(M.handleIdentity).not.toHaveBeenCalled();
        expect(M.resolveAccount).not.toHaveBeenCalled();
      }
    );

    it('keeps the verified subject for identity resolution and the account lookup', async () => {
      M.getProvider.mockResolvedValue({ ...oidcProvider });
      M.consumeAuthState.mockResolvedValue(authState({ enableSso: true }));
      M.fapiResource.mockResolvedValue({ name: 'From Resource', sub: '' });
      expect((await callback({ query: Q })).status).toBe(302);
      expect(argRec(M.handleIdentity, 0, 1).userInfo).toEqual({
        sub: 'ext-sub',
        email: 'id@example.com',
        name: 'From Resource',
      });
      expect(rec(argRec(M.resolveAccount, 0, 1).identifier)).toEqual({
        issuer: 'provider-a',
        subject: 'ext-sub',
      });
    });

    it('reports an inconsistent subject in the diagnostics before refusing it', async () => {
      M.getProvider.mockResolvedValue({ ...oidcProvider });
      M.fapiResource.mockResolvedValue({ sub: 'someone-else' });
      await callback({ query: Q });
      // The refusal happens before the success entry is written.
      expect(
        entriesOf(M.logTokenValidation).some(
          (e) => e.step === 'fapi2-resource-response-validation' && e.result === 'pass'
        )
      ).toBe(false);
    });
  });

  it('records the stage a failure happened in', async () => {
    M.fapiExchange.mockRejectedValue(new Error('Token response has invalid expires_in'));
    await callback({ query: Q });
    const failure = entriesOf(M.logTokenValidation).find((e) => e.result === 'fail');
    expect(failure).toMatchObject({
      step: 'fapi2-token-response-validation',
      tokenType: 'token_response',
      errorMessage: 'invalid_expires_in',
    });
    M.logTokenValidation.mockClear();
    M.fapiExchange.mockResolvedValue(fapiTokens);
    M.loadFapi2Config.mockResolvedValue(
      config({ profile: 'oidc', resourceUrl: 'https://idp.example.com/res' })
    );
    M.fapiExchange.mockResolvedValue({ ...fapiTokens, id_token: 'x.y.z' });
    M.validateIdToken.mockRejectedValue(new Error('nonce mismatch'));
    M.getProvider.mockResolvedValue({ ...oidcProvider });
    await callback({ query: Q });
    expect(entriesOf(M.logTokenValidation).find((e) => e.result === 'fail')).toMatchObject({
      step: 'fapi2-id-token-validation',
      tokenType: 'id_token',
    });
  });

  it('survives a failing diagnostic write', async () => {
    M.logTokenValidation.mockRejectedValue(new Error('diag down'));
    M.logAuthDecision.mockRejectedValue(new Error('diag down'));
    const response = await callback({ query: Q });
    expect(response.status).toBe(302);
  });

  it('survives a failing diagnostic cleanup', async () => {
    M.diagCleanup.mockRejectedValue(new Error('flush failed'));
    expect((await callback({ query: Q })).status).toBe(302);
  });

  it('fails when the encryption key disappears before the FAPI config is loaded', async () => {
    M.getKey.mockReturnValueOnce('encryption-key');
    M.getKey.mockReturnValue(undefined);
    expect(paramsOf(await callback({ query: Q })).error).toBe(ExternalIdPErrorCode.CALLBACK_FAILED);
    expect(M.loadFapi2Config).not.toHaveBeenCalled();
  });
});

describe('diagnostics of a standard flow', () => {
  beforeEach(() => {
    M.createDiag.mockResolvedValue({
      logTokenValidation: M.logTokenValidation,
      logAuthDecision: M.logAuthDecision,
      cleanup: M.diagCleanup,
    });
  });

  it('records the authorization response, token request/response and userinfo', async () => {
    await callback();
    expect(M.createDiag).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'default',
      clientId: 'upstream-client',
    });
    expect(M.logAuthDecision).toHaveBeenCalledWith({
      diagnosticSessionId: undefined,
      flowId: 'flow-a',
      decision: 'allow',
      reason: 'authorization_response',
      flow: 'external_idp',
      context: {
        provider: 'corp',
        client_id: 'upstream-client',
        authrim_client_id: 'client-a',
        redirect_uri: 'https://auth.example.com/auth/external/corp/callback',
        state_present: true,
        code_present: true,
        state_bound_to_browser: true,
      },
    });
    const entries = entriesOf(M.logTokenValidation);
    expect(entries.map((e) => e.step)).toEqual([
      'token-request',
      'token-response',
      'userinfo-request',
      'userinfo-response',
    ]);
    expect(entries[0]).toEqual({
      diagnosticSessionId: undefined,
      flowId: 'flow-a',
      step: 'token-request',
      tokenType: 'authorization_code',
      result: 'pass',
      details: {
        token_endpoint: 'https://idp.example.com/token',
        auth_method: 'client_secret_basic',
        auth_header_present: true,
        grant_type: 'authorization_code',
        redirect_uri: 'https://auth.example.com/auth/external/corp/callback',
        client_id: 'upstream-client',
        authorization_code_present: true,
        code_verifier_present: true,
      },
    });
    expect(entries[1]).toMatchObject({
      tokenType: 'token',
      token: 'upstream-access',
      details: {
        token_endpoint: 'https://idp.example.com/token',
        token_type: 'Bearer',
        expires_in: 3600,
        access_token: 'upstream-access',
      },
    });
    expect(entries[3]).toMatchObject({
      details: {
        endpoint: 'https://idp.example.com/userinfo',
        claims: { sub: 'ext-sub' },
        signed_response: false,
      },
    });
    expect(M.diagCleanup).toHaveBeenCalledTimes(1);
  });

  it('uses the provider id when the provider has no slug', async () => {
    M.getProvider.mockResolvedValue({ ...oauthProvider, slug: undefined });
    await callback();
    expect(rec(argRec(M.logAuthDecision, 0, 0).context).provider).toBe('provider-a');
  });

  it('treats a failing diagnostics factory as no diagnostics', async () => {
    M.createDiag.mockRejectedValue(new Error('no logger'));
    expect((await callback()).status).toBe(302);
  });

  it('records a denial for an unexpected failure with its classification', async () => {
    M.handleIdentity.mockRejectedValue(new Error('database exploded'));
    await callback();
    expect(M.logAuthDecision).toHaveBeenLastCalledWith({
      diagnosticSessionId: undefined,
      flowId: 'flow-a',
      decision: 'deny',
      reason: 'external_idp_callback_rejected',
      flow: 'external_idp',
      context: { validation_stage: 'callback', validation_error: 'database_error' },
    });
  });

  it.each([
    [new (class extends Error {})('x'), 'callback_processing'],
    ['plain string', ExternalIdPErrorCode.CALLBACK_FAILED],
  ])('records %s with its code', async (error, code) => {
    M.handleIdentity.mockRejectedValue(error);
    await callback();
    expect(
      rec(argRec(M.logAuthDecision, M.logAuthDecision.mock.calls.length - 1, 0).context)
        .validation_error
    ).toBe(code);
  });

  it('records an ExternalIdPError by its own code', async () => {
    const { ExternalIdPError } = await import('../types');
    M.handleIdentity.mockRejectedValue(
      new ExternalIdPError(ExternalIdPErrorCode.NO_ACCOUNT_FOUND, 'x')
    );
    await callback();
    expect(
      rec(argRec(M.logAuthDecision, M.logAuthDecision.mock.calls.length - 1, 0).context)
        .validation_error
    ).toBe(ExternalIdPErrorCode.NO_ACCOUNT_FOUND);
  });

  it.each([
    ['missing_state', 'code=c', {}],
    ['browser_state_binding_failed', undefined, { bound: false }],
  ])('records the rejection %s', async (reason, query, options) => {
    await callback({ ...(query ? { query } : {}), ...options });
    expect(M.logAuthDecision).toHaveBeenCalledWith({
      diagnosticSessionId: undefined,
      flowId: undefined,
      decision: 'deny',
      reason: 'authorization_response_rejected',
      flow: 'external_idp',
      context: { validation_stage: 'authorization-response', validation_error: reason },
    });
  });

  it('records a malformed JARM response and an expired state', async () => {
    await callback({ query: 'response=not-a-jwt' });
    expect(rec(argRec(M.logAuthDecision, 0, 0).context).validation_error).toBe('malformed_jarm');
    M.logAuthDecision.mockClear();
    M.consumeAuthState.mockResolvedValue(null);
    await callback();
    expect(rec(argRec(M.logAuthDecision, 0, 0).context).validation_error).toBe(
      'invalid_or_expired_state'
    );
    M.logAuthDecision.mockClear();
    M.consumeAuthState.mockResolvedValue(authState({ providerId: 'other' }));
    await callback();
    expect(rec(argRec(M.logAuthDecision, 0, 0).context).validation_error).toBe('provider_mismatch');
  });

  it('adds the FAPI 2.0 validation entry to a rejection of a FAPI provider', async () => {
    M.isFapi2.mockReturnValue(true);
    await callback({ query: 'code=c' });
    expect(M.logTokenValidation).toHaveBeenCalledWith({
      diagnosticSessionId: undefined,
      flowId: undefined,
      step: 'fapi2-authorization-response-validation',
      tokenType: 'authorization_response',
      result: 'fail',
      errorMessage: 'missing_state',
      details: { validation_error: 'missing_state' },
    });
    expect(M.logAuthDecision).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'fapi2_callback_rejected', flow: 'fapi2' })
    );
  });
});

describe('extractUnverifiedJarmState', () => {
  const token = (claims: Record<string, unknown>) => new jose.UnsecuredJWT(claims).encode();

  it('returns the state claim without verifying anything', () => {
    expect(extractUnverifiedJarmState(token({ state: 'abc' }))).toBe('abc');
  });

  it('returns undefined when the state is absent or not a string', () => {
    expect(extractUnverifiedJarmState(token({}))).toBeUndefined();
    expect(extractUnverifiedJarmState(token({ state: 5 }))).toBeUndefined();
  });

  it('rejects an undecodable value', () => {
    expect(() => extractUnverifiedJarmState('garbage')).toThrow('Malformed JARM response');
  });
});

describe('classifyFapi2CallbackError', () => {
  const claim = (name: string, reason: string) => ({
    code: 'ERR_JWT_CLAIM_VALIDATION_FAILED',
    claim: name,
    reason,
  });

  it.each([
    ['Malformed JARM response', 'malformed_jarm'],
    ['Missing JARM authorization response', 'missing_jarm_response'],
    ['Unexpected JARM authorization response', 'unexpected_jarm_response'],
    ['FAPI2 authorization response issuer mismatch', 'issuer_mismatch'],
    ['Missing FAPI2 issuer parameter', 'missing_issuer'],
    ['JARM response audience must contain only the client_id', 'audience_mismatch'],
    ['JARM response state mismatch', 'state_mismatch'],
    ['JARM response missing iss', 'missing_issuer'],
    ['JARM response missing state', 'missing_state'],
    ['JARM response has invalid code', 'invalid_code'],
    ['JARM response has invalid error', 'invalid_error'],
    ['JARM response contains neither code nor error', 'missing_code_or_error'],
    ['Token response missing access_token', 'missing_access_token'],
    ['Token response token_type must be DPoP', 'invalid_token_type'],
    ['Token response has invalid expires_in', 'invalid_expires_in'],
  ])('maps the message "%s" to %s', (message, expected) => {
    expect(classifyFapi2CallbackError(new Error(message))).toBe(expected);
  });

  it.each([
    [{ code: 'ERR_JOSE_ALG_NOT_ALLOWED' }, 'unexpected_signing_algorithm'],
    [{ code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' }, 'invalid_signature'],
    [{ code: 'ERR_JWKS_NO_MATCHING_KEY' }, 'signing_key_not_found'],
    [{ code: 'ERR_JWS_INVALID' }, 'malformed_jwt'],
    [{ code: 'ERR_JWT_INVALID' }, 'malformed_jwt'],
    [{ code: 'ERR_JWT_EXPIRED' }, 'expired_expiration'],
    [claim('iss', 'missing'), 'missing_issuer'],
    [claim('iss', 'check_failed'), 'issuer_mismatch'],
    [claim('aud', 'MISSING claim'), 'missing_audience'],
    [claim('aud', 'check_failed'), 'audience_mismatch'],
    [claim('exp', 'missing'), 'missing_expiration'],
    [claim('exp', 'check_failed'), 'invalid_expiration'],
    [claim('nonce', 'missing'), 'missing_nonce'],
    [claim('nonce', 'check_failed'), 'nonce_mismatch'],
    [claim('sub', 'missing'), 'missing_required_claim'],
    [claim('sub', 'check_failed'), 'claim_validation_failed'],
  ])('maps the jose error %j to %s', (error, expected) => {
    expect(classifyFapi2CallbackError(error)).toBe(expected);
  });

  it.each([
    ['the nonce is missing here', 'missing_nonce'],
    ['bad nonce', 'nonce_mismatch'],
    ['wrong audience value', 'audience_mismatch'],
    ['wrong issuer value', 'issuer_mismatch'],
    ['bad signature bytes', 'invalid_signature'],
    ['something else', 'fapi2_validation_failed'],
  ])('falls back on the message "%s" to %s', (message, expected) => {
    expect(classifyFapi2CallbackError(new Error(message))).toBe(expected);
  });

  it('is stable for non-errors', () => {
    expect(classifyFapi2CallbackError('text')).toBe('fapi2_validation_failed');
    expect(classifyFapi2CallbackError(undefined)).toBe('fapi2_validation_failed');
    expect(classifyFapi2CallbackError({ code: 5, claim: 6, reason: 7 })).toBe(
      'fapi2_validation_failed'
    );
  });
});
