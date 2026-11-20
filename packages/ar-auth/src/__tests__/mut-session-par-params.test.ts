import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
  const logger = {
    module: vi.fn().mockReturnThis(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    validateClientId: vi.fn(),
    validateRedirectUri: vi.fn(),
    validateScope: vi.fn(),
    isRedirectUriRegistered: vi.fn(),
    validateClientAssertion: vi.fn(),
    validateDPoPProof: vi.fn(),
    verifyClientSecretHash: vi.fn(),
    getTokenFormat: vi.fn(),
    decryptRequestObject: vi.fn(),
    parseToken: vi.fn(),
    parseTokenHeader: vi.fn(),
    isInternalUrl: vi.fn(),
    safeFetchJson: vi.fn(),
    validateAuthorizationDetails: vi.fn(),
    getClientCached: vi.fn(),
    getPARRequestStoreForNewRequest: vi.fn(),
    storeRequestRpc: vi.fn(),
    logger,
    jwtVerify: vi.fn(),
    importJWK: vi.fn(),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    validateClientId: m.validateClientId,
    validateRedirectUri: m.validateRedirectUri,
    validateScope: m.validateScope,
    isRedirectUriRegistered: m.isRedirectUriRegistered,
    validateClientAssertion: m.validateClientAssertion,
    validateDPoPProof: m.validateDPoPProof,
    verifyClientSecretHash: m.verifyClientSecretHash,
    getTokenFormat: m.getTokenFormat,
    decryptRequestObject: m.decryptRequestObject,
    parseToken: m.parseToken,
    parseTokenHeader: m.parseTokenHeader,
    isInternalUrl: m.isInternalUrl,
    safeFetchJson: m.safeFetchJson,
    validateAuthorizationDetails: m.validateAuthorizationDetails,
    getClientCached: m.getClientCached,
    getPARRequestStoreForNewRequest: m.getPARRequestStoreForNewRequest,
    getLogger: () => m.logger,
  };
});

vi.mock('../issuer', () => ({
  getRequestIssuer: vi.fn().mockReturnValue('https://op.example.com'),
}));

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return { ...actual, jwtVerify: m.jwtVerify, importJWK: m.importJWK };
});

import { parHandler } from '../par';
import {
  CALLBACK,
  JWT_BEARER,
  baseBody,
  createParContext,
  platformSettings,
} from './helpers/mut-session-par-context';

const PUBLIC_CLIENT = {
  client_id: 'client-123',
  redirect_uris: [CALLBACK],
  token_endpoint_auth_method: 'none',
};

beforeEach(() => {
  vi.clearAllMocks();
  m.validateClientId.mockReturnValue({ valid: true });
  m.validateRedirectUri.mockReturnValue({ valid: true });
  m.validateScope.mockReturnValue({ valid: true });
  m.isRedirectUriRegistered.mockReturnValue(true);
  m.validateClientAssertion.mockResolvedValue({ valid: true });
  m.validateDPoPProof.mockResolvedValue({ valid: true, jkt: 'thumbprint' });
  m.verifyClientSecretHash.mockResolvedValue(true);
  m.getTokenFormat.mockReturnValue('jwt');
  m.parseToken.mockReturnValue(null);
  m.parseTokenHeader.mockReturnValue({ alg: 'RS256' });
  m.isInternalUrl.mockReturnValue(false);
  m.validateAuthorizationDetails.mockReturnValue({ valid: true, sanitized: [{ type: 'x' }] });
  m.getClientCached.mockResolvedValue({ ...PUBLIC_CLIENT });
  m.storeRequestRpc.mockResolvedValue(undefined);
  m.getPARRequestStoreForNewRequest.mockResolvedValue({
    requestUri: 'urn:ietf:params:oauth:request_uri:par_test',
    stub: { storeRequestRpc: m.storeRequestRpc },
  });
  m.importJWK.mockResolvedValue({ type: 'public' });
});

async function run(options: Parameters<typeof createParContext>[0]) {
  const response = await parHandler(createParContext(options) as never);
  const body = await response.json<Record<string, unknown>>();
  return { status: response.status, body };
}

function stored(): Record<string, unknown> {
  const first = m.storeRequestRpc.mock.calls[0] as [{ data: Record<string, unknown> }] | undefined;
  return first?.[0].data ?? {};
}

const invalid = (description: string, error = 'invalid_request') => ({
  status: 400,
  body: { error, error_description: description },
});

describe('PAR authorization parameter validation', () => {
  it.each([
    ['response_type', 'response_type is required'],
    ['redirect_uri', 'redirect_uri is required'],
    ['scope', 'scope is required'],
  ])('requires %s', async (name, description) => {
    expect(await run({ body: { ...baseBody, [name]: undefined } })).toEqual(invalid(description));
    expect(m.storeRequestRpc).not.toHaveBeenCalled();
  });

  it('requires a signed request object when the profile says so', async () => {
    const SETTINGS = platformSettings({
      fapi: { messageSigning: { requireSignedRequestObject: true } },
    });
    expect(await run({ env: { SETTINGS } })).toEqual(
      invalid('A signed request object is required for this FAPI profile')
    );
  });

  it('requires both a code_challenge and the S256 method under FAPI', async () => {
    m.getClientCached.mockResolvedValue({
      ...PUBLIC_CLIENT,
      token_endpoint_auth_method: 'private_key_jwt',
    });
    const SETTINGS = platformSettings({ fapi: { enabled: true } });
    const auth = { client_assertion: 'assertion', client_assertion_type: JWT_BEARER };
    for (const pkce of [
      { code_challenge: 'a'.repeat(43), code_challenge_method: 'plain' },
      { code_challenge_method: 'S256' },
    ]) {
      expect(await run({ body: { ...baseBody, ...auth, ...pkce }, env: { SETTINGS } })).toEqual(
        invalid('FAPI 2.0 requires PKCE with S256 method')
      );
    }
    const ok = await run({
      body: { ...baseBody, ...auth, code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' },
      env: { SETTINGS },
    });
    expect(ok.status).toBe(201);
  });

  describe('security.pkce_required', () => {
    const SETTINGS = {
      get: async (key: string) =>
        key === 'settings:tenant:default:security'
          ? JSON.stringify({ 'security.pkce_required': true })
          : null,
    } as unknown as KVNamespace;

    it('refuses a plain code_challenge_method', async () => {
      const res = await run({
        body: { ...baseBody, code_challenge: 'a'.repeat(43), code_challenge_method: 'plain' },
        env: { SETTINGS },
      });
      expect(res).toEqual(invalid('PKCE with S256 is required for this client'));
    });

    it('accepts S256', async () => {
      const res = await run({
        body: { ...baseBody, code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' },
        env: { SETTINGS },
      });
      expect(res.status).toBe(201);
    });

    it('leaves a response_type without code to the response type check', async () => {
      const res = await run({ body: { ...baseBody, response_type: 'token' }, env: { SETTINGS } });
      expect(res.body.error).toBe('unsupported_response_type');
    });
  });

  it('reports redirect_uri validation errors with a default description', async () => {
    m.validateRedirectUri.mockReturnValueOnce({
      valid: false,
      error: 'redirect_uri must use https',
    });
    expect(await run({})).toEqual(invalid('redirect_uri must use https'));
    m.validateRedirectUri.mockReturnValueOnce({ valid: false });
    expect(await run({})).toEqual(invalid('Invalid redirect_uri'));
  });

  it('allows http redirect URIs only for native apps when https is required', async () => {
    await run({});
    expect(m.validateRedirectUri).toHaveBeenLastCalledWith(CALLBACK, false);
    m.getClientCached.mockResolvedValue({ ...PUBLIC_CLIENT, application_type: 'native' });
    await run({});
    expect(m.validateRedirectUri).toHaveBeenLastCalledWith(CALLBACK, true);
  });

  it('accepts error_uri at an allowed origin and ignores non-string origins', async () => {
    m.getClientCached.mockResolvedValue({
      ...PUBLIC_CLIENT,
      allowed_redirect_origins: [42, 'https://errors.example.net'],
    });
    const res = await run({
      body: { ...baseBody, error_uri: 'https://errors.example.net/oops' },
    });
    expect(res.status).toBe(201);
    expect(stored().error_uri).toBe('https://errors.example.net/oops');
  });

  it('rejects redirect extensions at an origin that is not allowed, naming each', async () => {
    m.getClientCached.mockResolvedValue({ ...PUBLIC_CLIENT, allowed_redirect_origins: 'nope' });
    const res = await run({
      body: {
        ...baseBody,
        error_uri: 'https://errors.example.net/oops',
        cancel_uri: 'https://cancel.example.net/x',
      },
    });
    expect(res.status).toBe(400);
    const description = res.body.error_description as string;
    expect(description).toMatch(/^error_uri: .+, cancel_uri: .+$/);
  });

  it('reports scope validation errors with a default description', async () => {
    m.validateScope.mockReturnValueOnce({ valid: false });
    expect(await run({})).toEqual(invalid('Invalid scope', 'invalid_scope'));
    m.validateScope.mockReturnValueOnce({ valid: false, error: 'unknown scope' });
    expect(await run({})).toEqual(invalid('unknown scope', 'invalid_scope'));
  });

  describe('authorization_details', () => {
    const body = {
      ...baseBody,
      authorization_details: JSON.stringify([{ type: 'payment_initiation' }]),
    };

    it('is refused unless RAR is enabled', async () => {
      expect(await run({ body })).toEqual(
        invalid(
          'authorization_details parameter is not supported. Enable RAR feature to use Rich Authorization Requests.'
        )
      );
    });

    it('is enabled by the tenant RAR setting', async () => {
      const SETTINGS = platformSettings({ oidc: { rar: { enabled: true } } });
      const res = await run({ body, env: { SETTINGS } });
      expect(res.status).toBe(201);
      expect(m.validateAuthorizationDetails).toHaveBeenCalledWith(
        [{ type: 'payment_initiation' }],
        { allowedTypes: ['ai_agent_action', 'payment_initiation', 'account_information'] }
      );
      expect(stored().authorization_details).toBe(JSON.stringify([{ type: 'x' }]));
    });

    it('reports the first validation error, or a default', async () => {
      m.validateAuthorizationDetails.mockReturnValueOnce({ valid: false, errors: [] });
      expect(await run({ body, env: { ENABLE_RAR: 'true' } })).toEqual(
        invalid('Invalid authorization_details', 'invalid_authorization_details')
      );
      m.validateAuthorizationDetails.mockReturnValueOnce({ valid: false });
      expect(await run({ body, env: { ENABLE_RAR: 'true' } })).toEqual(
        invalid('Invalid authorization_details', 'invalid_authorization_details')
      );
      m.validateAuthorizationDetails.mockReturnValueOnce({
        valid: false,
        errors: [{ message: 'amount is required' }, { message: 'second' }],
      });
      expect(await run({ body, env: { ENABLE_RAR: 'true' } })).toEqual(
        invalid('amount is required', 'invalid_authorization_details')
      );
    });

    it('describes malformed JSON', async () => {
      expect(
        await run({ body: { ...body, authorization_details: '{' }, env: { ENABLE_RAR: 'true' } })
      ).toEqual(
        invalid('authorization_details must be valid JSON', 'invalid_authorization_details')
      );
    });
  });

  it('lists the supported response types', async () => {
    expect(await run({ body: { ...baseBody, response_type: 'id_token' } })).toEqual(
      invalid(
        'Unsupported response_type. Supported types: code, code id_token, code token, code id_token token',
        'unsupported_response_type'
      )
    );
  });

  it('enforces code_challenge length bounds inclusively', async () => {
    const withChallenge = (length: number) => ({
      body: { ...baseBody, code_challenge: 'a'.repeat(length), code_challenge_method: 'S256' },
    });
    const lengthError = invalid('code_challenge must be between 43 and 128 characters');
    expect(await run(withChallenge(42))).toEqual(lengthError);
    expect(await run(withChallenge(129))).toEqual(lengthError);
    expect((await run(withChallenge(43))).status).toBe(201);
    expect((await run(withChallenge(128))).status).toBe(201);
    expect(await run({ body: { ...baseBody, code_challenge: 'a'.repeat(43) } })).toEqual(
      invalid('code_challenge_method is required when code_challenge is present')
    );
  });

  it('requires dpop_jkt to be exactly a 43-character thumbprint', async () => {
    const error = invalid('dpop_jkt must be a SHA-256 JWK thumbprint');
    for (const jkt of [
      'a'.repeat(42),
      'a'.repeat(44),
      `!${'a'.repeat(43)}`,
      `${'a'.repeat(43)}!`,
    ]) {
      expect(await run({ body: { ...baseBody, dpop_jkt: jkt } })).toEqual(error);
    }
    expect((await run({ body: { ...baseBody, dpop_jkt: 'A-_'.repeat(14) + 'z' } })).status).toBe(
      201
    );
  });

  it('returns DPoP validation errors as given, with defaults', async () => {
    m.validateDPoPProof.mockResolvedValueOnce({ valid: false });
    expect(await run({ headers: { DPoP: 'proof' } })).toEqual(
      invalid('DPoP proof validation failed', 'invalid_dpop_proof')
    );
    m.validateDPoPProof.mockResolvedValueOnce({
      valid: false,
      error: 'use_dpop_nonce',
      error_description: 'nonce required',
    });
    expect(await run({ headers: { DPoP: 'proof' } })).toEqual(
      invalid('nonce required', 'use_dpop_nonce')
    );
    expect(m.validateDPoPProof).toHaveBeenCalledWith(
      'proof',
      'POST',
      'https://op.example.com/par',
      undefined,
      expect.anything(),
      'client-123',
      'default'
    );
  });

  it('describes the FAL3 signed-request requirement', async () => {
    const SETTINGS = {
      get: async (key: string) =>
        key === 'settings:tenant:default:assurance'
          ? JSON.stringify({ 'assurance.enabled': true, 'assurance.default_fal': 'FAL3' })
          : null,
    } as unknown as KVNamespace;
    expect(await run({ env: { SETTINGS } })).toEqual(
      invalid(
        'A request object the client signed, carrying every authorization parameter, is required (FAL3)'
      )
    );
  });

  it('stores a plain request without request-object flags, using the default 600s expiry', async () => {
    const res = await run({});
    expect(res).toEqual({
      status: 201,
      body: { request_uri: 'urn:ietf:params:oauth:request_uri:par_test', expires_in: 600 },
    });
    expect(stored()).not.toHaveProperty('request_object_signed');
    expect(stored()).not.toHaveProperty('request_object_encrypted');
  });
});
