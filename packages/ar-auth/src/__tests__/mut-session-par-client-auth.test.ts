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
  basicHeader,
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

describe('PAR client identification and authentication', () => {
  it('rejects a malformed Basic Authorization header', async () => {
    for (const header of ['Basic !!!not-base64', `Basic ${btoa('no-colon')}`]) {
      const res = await run({ headers: { Authorization: header } });
      expect(res).toEqual({
        status: 401,
        body: { error: 'invalid_client', error_description: 'Invalid Authorization header format' },
      });
    }
    expect(m.getClientCached).not.toHaveBeenCalled();
  });

  it('ignores a non-Basic Authorization scheme', async () => {
    const res = await run({ headers: { Authorization: 'Bearer token' } });
    expect(res.status).toBe(201);
  });

  it('rejects Basic credentials whose username differs from the form client_id', async () => {
    const res = await run({ headers: { Authorization: basicHeader('other-client', 's3cret') } });
    expect(res).toEqual({
      status: 401,
      body: { error: 'invalid_client', error_description: 'Client authentication failed' },
    });
    expect(m.getClientCached).not.toHaveBeenCalled();
  });

  it('takes client_id and secret from Basic credentials', async () => {
    m.getClientCached.mockResolvedValue({
      ...PUBLIC_CLIENT,
      token_endpoint_auth_method: 'client_secret_basic',
      client_secret_hash: 'stored-hash',
    });
    const { client_id: _omitted, ...body } = baseBody;
    const res = await run({
      headers: { Authorization: basicHeader('client-123', 's3cret') },
      body,
    });
    expect(res.status).toBe(201);
    expect(m.getClientCached).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'client-123'
    );
    expect(m.verifyClientSecretHash).toHaveBeenCalledWith('s3cret', 'stored-hash');
    expect(stored().client_id).toBe('client-123');
  });

  it('accepts Basic credentials matching the form client_id', async () => {
    m.getClientCached.mockResolvedValue({
      ...PUBLIC_CLIENT,
      token_endpoint_auth_method: 'client_secret_basic',
      client_secret_hash: 'stored-hash',
    });
    const res = await run({ headers: { Authorization: basicHeader('client-123', 'pw') } });
    expect(res.status).toBe(201);
    expect(m.verifyClientSecretHash).toHaveBeenCalledWith('pw', 'stored-hash');
  });

  it('requires a client_id when there is neither a form value nor a usable assertion', async () => {
    const bodies = [
      { ...baseBody, client_id: '' },
      { ...baseBody, client_id: undefined, client_assertion: 'a.b.c' },
      { ...baseBody, client_id: undefined, client_assertion: 'a.b.c', client_assertion_type: 'x' },
      {
        ...baseBody,
        client_id: undefined,
        client_assertion: 'a'.repeat(16 * 1024 + 1),
        client_assertion_type: JWT_BEARER,
      },
    ];
    for (const body of bodies) {
      const res = await run({ body });
      expect(res).toEqual({
        status: 400,
        body: { error: 'invalid_request', error_description: 'client_id is required' },
      });
    }
    expect(m.parseToken).not.toHaveBeenCalled();
  });

  it('derives the client from an assertion at exactly the size limit', async () => {
    m.parseToken.mockReturnValue({ iss: 'client-123', sub: 'client-123' });
    m.getClientCached.mockResolvedValue({
      ...PUBLIC_CLIENT,
      token_endpoint_auth_method: 'private_key_jwt',
    });
    const assertion = 'a'.repeat(16 * 1024);
    const res = await run({
      body: {
        ...baseBody,
        client_id: undefined,
        client_assertion: assertion,
        client_assertion_type: JWT_BEARER,
      },
    });
    expect(res.status).toBe(201);
    expect(m.parseToken).toHaveBeenCalledWith(assertion);
  });

  it('refuses an assertion whose iss and sub are empty', async () => {
    m.parseToken.mockReturnValue({ iss: '', sub: '' });
    const res = await run({
      body: {
        ...baseBody,
        client_id: undefined,
        client_assertion: 'a.b.c',
        client_assertion_type: JWT_BEARER,
      },
    });
    expect(res).toEqual({
      status: 401,
      body: { error: 'invalid_client', error_description: 'Client authentication failed' },
    });
    expect(m.getClientCached).not.toHaveBeenCalled();
  });

  it('reports client_id validation errors, with a default description', async () => {
    m.validateClientId.mockReturnValueOnce({ valid: false, error: 'client_id is too long' });
    expect(await run({})).toEqual({
      status: 401,
      body: { error: 'invalid_client', error_description: 'client_id is too long' },
    });
    m.validateClientId.mockReturnValueOnce({ valid: false });
    expect(await run({})).toEqual({
      status: 401,
      body: { error: 'invalid_client', error_description: 'Invalid client_id' },
    });
    expect(m.getClientCached).not.toHaveBeenCalled();
  });

  it('rejects a client presenting a method other than the registered one', async () => {
    m.getClientCached.mockResolvedValue({
      ...PUBLIC_CLIENT,
      token_endpoint_auth_method: 'client_secret_basic',
      client_secret_hash: 'h',
    });
    const res = await run({ body: { ...baseBody, client_secret: 'pw' } });
    expect(res).toEqual({
      status: 401,
      body: {
        error: 'invalid_client',
        error_description: 'Client must authenticate using client_secret_basic',
      },
    });
    expect(m.verifyClientSecretHash).not.toHaveBeenCalled();
  });

  it('verifies a client_secret_post secret and refuses a wrong one', async () => {
    m.getClientCached.mockResolvedValue({
      ...PUBLIC_CLIENT,
      token_endpoint_auth_method: 'client_secret_post',
      client_secret_hash: 'h',
    });
    m.verifyClientSecretHash.mockResolvedValueOnce(false);
    expect(await run({ body: { ...baseBody, client_secret: 'wrong' } })).toEqual({
      status: 401,
      body: { error: 'invalid_client', error_description: 'Client authentication failed' },
    });
    expect(m.verifyClientSecretHash).toHaveBeenCalledWith('wrong', 'h');
    expect(m.storeRequestRpc).not.toHaveBeenCalled();
  });

  it('validates a private_key_jwt assertion with the endpoint-or-issuer audience by default', async () => {
    m.getClientCached.mockResolvedValue({
      ...PUBLIC_CLIENT,
      token_endpoint_auth_method: 'private_key_jwt',
    });
    const res = await run({
      body: { ...baseBody, client_assertion: 'assertion', client_assertion_type: JWT_BEARER },
    });
    expect(res.status).toBe(201);
    const [assertion, audience, , options] = m.validateClientAssertion.mock.calls[0] as [
      string,
      string,
      unknown,
      Record<string, unknown>,
    ];
    expect(assertion).toBe('assertion');
    expect(audience).toBe('https://op.example.com/par');
    expect(options).toMatchObject({
      audiencePolicy: 'endpoint-or-issuer',
      issuer: 'https://op.example.com',
      additionalAudiences: ['https://op.example.com/token'],
      clockSkewSeconds: 60,
      replayProtection: { tenantId: 'default' },
    });
    expect(options).not.toHaveProperty('allowedAlgorithms');
  });

  it('restricts assertion algorithms when FAPI 2.0 is enabled', async () => {
    m.getClientCached.mockResolvedValue({
      ...PUBLIC_CLIENT,
      token_endpoint_auth_method: 'private_key_jwt',
    });
    await run({
      body: {
        ...baseBody,
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
        client_assertion: 'assertion',
        client_assertion_type: JWT_BEARER,
      },
      env: { SETTINGS: platformSettings({ fapi: { enabled: true } }) },
    });
    const options = (m.validateClientAssertion.mock.calls[0] as unknown[])[3] as {
      allowedAlgorithms: string[];
    };
    expect(options.allowedAlgorithms).toEqual(expect.arrayContaining(['PS256', 'ES256']));
    expect(options.allowedAlgorithms.length).toBeGreaterThan(0);
  });

  it('returns assertion errors as given, with defaults when none is given', async () => {
    m.getClientCached.mockResolvedValue({
      ...PUBLIC_CLIENT,
      token_endpoint_auth_method: 'private_key_jwt',
    });
    const body = { ...baseBody, client_assertion: 'assertion', client_assertion_type: JWT_BEARER };
    m.validateClientAssertion.mockResolvedValueOnce({ valid: false });
    expect(await run({ body })).toEqual({
      status: 401,
      body: { error: 'invalid_client', error_description: 'Client assertion validation failed' },
    });
    m.validateClientAssertion.mockResolvedValueOnce({
      valid: false,
      error: 'invalid_grant',
      error_description: 'assertion replayed',
    });
    expect(await run({ body })).toEqual({
      status: 401,
      body: { error: 'invalid_grant', error_description: 'assertion replayed' },
    });
  });

  it('requires private_key_jwt under FAPI even for a client presenting an assertion', async () => {
    m.getClientCached.mockResolvedValue({
      ...PUBLIC_CLIENT,
      token_endpoint_auth_method: undefined,
    });
    const res = await run({
      body: {
        ...baseBody,
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
        client_assertion: 'assertion',
        client_assertion_type: JWT_BEARER,
      },
      env: { SETTINGS: platformSettings({ fapi: { enabled: true } }) },
    });
    expect(res).toEqual({
      status: 401,
      body: {
        error: 'invalid_client',
        error_description: 'FAPI 2.0 requires private_key_jwt authentication for PAR',
      },
    });
  });

  it('skips assertion validation when the assertion type is not jwt-bearer', async () => {
    m.getClientCached.mockResolvedValue({
      ...PUBLIC_CLIENT,
      token_endpoint_auth_method: undefined,
    });
    const res = await run({
      body: { ...baseBody, client_assertion: 'assertion', client_assertion_type: 'saml' },
    });
    expect(res.status).toBe(201);
    expect(m.validateClientAssertion).not.toHaveBeenCalled();
  });

  it('describes settings and assurance read failures exactly', async () => {
    const failing = {
      get: vi.fn(async () => {
        throw new Error('kv down');
      }),
    } as unknown as KVNamespace;
    expect(await run({ env: { SETTINGS: failing } })).toEqual({
      status: 503,
      body: {
        error: 'temporarily_unavailable',
        error_description: 'Security profile settings are temporarily unavailable',
      },
    });
    const assuranceFailing = {
      get: vi.fn(async (key: string) => {
        if (key === 'settings:tenant:default:assurance') throw new Error('kv down');
        return null;
      }),
    } as unknown as KVNamespace;
    expect(await run({ env: { SETTINGS: assuranceFailing } })).toEqual({
      status: 503,
      body: {
        error: 'temporarily_unavailable',
        error_description: 'Assurance settings are temporarily unavailable',
      },
    });
  });
});
