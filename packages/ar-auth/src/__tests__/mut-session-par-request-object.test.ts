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
import { RequestObjectDecryptionError } from '@authrim/ar-lib-core';

const invalidObject = (description: string, status = 400, error = 'invalid_request_object') => ({
  status,
  body: { error, error_description: description },
});

const allowNone = (env: Record<string, string> = { ENVIRONMENT: 'development' }) => ({
  ...env,
  SETTINGS: platformSettings({ oidc: { allowNoneAlgorithm: true } }),
});

function encrypted(plaintext: string) {
  m.getTokenFormat.mockImplementation((value: string) => {
    if (value === 'encrypted') return 'jwe';
    if (value === 'nested.jwt') return 'jwt';
    return 'unknown';
  });
  m.decryptRequestObject.mockResolvedValue(plaintext);
  return { body: { ...baseBody, request: 'encrypted' } };
}

describe('PAR encrypted request objects', () => {
  const json = JSON.stringify({ client_id: 'client-123', state: 'from-jwe' });

  it('refuses a directly encrypted JSON object in production', async () => {
    for (const env of [{}, { ENVIRONMENT: 'production' }, { NODE_ENV: 'production' }]) {
      const res = await run({ ...encrypted(json), env: { ...allowNone({}), ...env } });
      expect(res).toEqual(invalidObject('Unsigned request objects are not allowed'));
    }
  });

  it('refuses it outside production unless unsigned objects are allowed', async () => {
    const res = await run({ ...encrypted(json), env: { ENVIRONMENT: 'development' } });
    expect(res).toEqual(invalidObject('Unsigned request objects are not allowed'));
  });

  it('accepts it when allowed outside production, as encrypted but not signed', async () => {
    for (const env of [{ ENVIRONMENT: 'development' }, { NODE_ENV: 'test' }] as Array<
      Record<string, string>
    >) {
      m.storeRequestRpc.mockClear();
      const res = await run({ ...encrypted(`  \n${json}`), env: allowNone(env) });
      expect(res.status).toBe(201);
      expect(stored()).toMatchObject({ state: 'from-jwe', request_object_encrypted: true });
      expect(stored()).not.toHaveProperty('request_object_signed');
    }
  });

  it('refuses decrypted content that is neither a JWT nor a JSON object', async () => {
    for (const plaintext of ['not json', 'encrypted', '[1]']) {
      const res = await run({ ...encrypted(plaintext), env: allowNone() });
      expect(res).toEqual(invalidObject('Decrypted request object must be a JWT or JSON object'));
    }
  });

  it('verifies a nested JWT after decryption', async () => {
    m.getClientCached.mockResolvedValue({
      ...PUBLIC_CLIENT,
      jwks: { keys: [{ kty: 'RSA', alg: 'RS256', use: 'sig', n: 'n', e: 'AQAB' }] },
    });
    m.jwtVerify.mockResolvedValue({ payload: { client_id: 'client-123' } });
    const res = await run(encrypted('nested.jwt'));
    expect(res.status).toBe(201);
    expect(m.jwtVerify).toHaveBeenCalledWith('nested.jwt', expect.anything(), expect.anything());
  });

  it('maps decryption failures', async () => {
    const ctx = encrypted(json);
    m.decryptRequestObject.mockRejectedValueOnce(new RequestObjectDecryptionError('unavailable'));
    expect(await run(ctx)).toEqual(
      invalidObject(
        'Request object decryption is temporarily unavailable',
        503,
        'temporarily_unavailable'
      )
    );
    for (const error of [new RequestObjectDecryptionError('failed'), new Error('boom')]) {
      m.decryptRequestObject.mockRejectedValueOnce(error);
      expect(await run(ctx)).toEqual(invalidObject('Failed to decrypt request object'));
    }
  });

  it('refuses a request object of unknown format', async () => {
    m.getTokenFormat.mockReturnValue('unknown');
    expect(await run({ body: { ...baseBody, request: 'garbage' } })).toEqual(
      invalidObject('Invalid request object format')
    );
  });
});

describe('PAR unsigned (alg=none) request objects', () => {
  const body = { ...baseBody, request: 'unsigned' };
  beforeEach(() => {
    m.parseTokenHeader.mockReturnValue({ alg: 'none' });
    m.parseToken.mockReturnValue({ client_id: 'client-123' });
  });

  it('refuses them under FAPI Message Signing', async () => {
    const SETTINGS = platformSettings({
      oidc: { allowNoneAlgorithm: true },
      fapi: { messageSigning: { enabled: true } },
    });
    expect(await run({ body, env: { ENVIRONMENT: 'development', SETTINGS } })).toEqual(
      invalidObject('Unsigned request objects are not allowed for FAPI Message Signing')
    );
  });

  it('refuses them in production, the default environment', async () => {
    for (const env of [{}, { NODE_ENV: 'production' }]) {
      expect(await run({ body, env: { ...allowNone({}), ...env } })).toEqual(
        invalidObject('Unsigned request objects (alg=none) are not permitted in production')
      );
    }
  });

  it('refuses them outside production unless allowed', async () => {
    expect(await run({ body, env: { NODE_ENV: 'development' } })).toEqual(
      invalidObject('Unsigned request objects (alg=none) are not allowed in this environment')
    );
  });

  it('refuses them when a signed request object is required', async () => {
    const SETTINGS = platformSettings({
      oidc: { allowNoneAlgorithm: true },
      fapi: { messageSigning: { requireSignedRequestObject: true } },
    });
    expect(await run({ body, env: { ENVIRONMENT: 'development', SETTINGS } })).toEqual(
      invalidObject('A signed request object is required for this FAPI profile')
    );
  });

  it('keeps form values for claims the request object does not carry', async () => {
    const form = {
      ...baseBody,
      response_type: 'code id_token',
      state: 's',
      nonce: 'n',
      code_challenge: 'c'.repeat(43),
      code_challenge_method: 'S256',
      response_mode: 'form_post',
      prompt: 'login',
      display: 'page',
      max_age: '30',
      ui_locales: 'ja',
      id_token_hint: 'hint',
      login_hint: 'user@example.com',
      acr_values: 'acr',
      claims: '{"id_token":{}}',
      dpop_jkt: 'k'.repeat(43),
      request: 'unsigned',
    };
    const res = await run({ body: form, env: allowNone() });
    expect(res.status).toBe(201);
    const { request: _request, max_age: _maxAge, ...expected } = form;
    expect(stored()).toMatchObject({ ...expected, max_age: 30 });
  });

  it('serialises object-valued claims and authorization_details from the request object', async () => {
    m.parseToken.mockReturnValue({
      client_id: 'client-123',
      claims: { userinfo: { email: null } },
      authorization_details: [{ type: 'payment_initiation' }],
      dpop_jkt: 42,
      error_uri: 7,
    });
    const res = await run({ body, env: { ...allowNone(), ENABLE_RAR: 'true' } });
    expect(res.status).toBe(201);
    expect(stored().claims).toBe('{"userinfo":{"email":null}}');
    expect(m.validateAuthorizationDetails).toHaveBeenCalledWith(
      [{ type: 'payment_initiation' }],
      expect.anything()
    );
    expect(stored().dpop_jkt).toBeUndefined();
    expect(stored().error_uri).toBeUndefined();
  });

  it('keeps a string authorization_details from the request object as given', async () => {
    m.parseToken.mockReturnValue({
      client_id: 'client-123',
      authorization_details: '[{"type":"account_information"}]',
    });
    await run({ body, env: { ...allowNone(), ENABLE_RAR: 'true' } });
    expect(m.validateAuthorizationDetails).toHaveBeenCalledWith(
      [{ type: 'account_information' }],
      expect.anything()
    );
  });

  it('turns an unexpected failure while processing into a generic request object error', async () => {
    m.parseToken.mockImplementation(() => {
      throw new Error('bad payload');
    });
    expect(await run({ body, env: allowNone() })).toEqual(
      invalidObject('Failed to parse or verify request object')
    );
  });
});
