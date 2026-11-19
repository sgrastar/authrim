/**
 * Token Exchange (RFC 8693): request parameters, client authentication and sender constraints
 * as handleTokenExchangeGrant reads them, before the subject token is looked at.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AT_TYPE,
  SERVICE_CLIENT,
  TARGET,
  baseClient,
  body,
  exchangeContext,
  expectError,
  issuedClaims,
  keyEnv,
  m,
  resetExchange,
  settingsOverrides,
  userSubject,
} from './helpers/mut-exchange-harness';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const h = await import('./helpers/mut-exchange-harness');
  return h.mockCore(await importOriginal());
});
vi.mock('../external-id-jag-verifier', async () =>
  (await import('./helpers/mut-exchange-harness')).mockJagVerifier()
);

import { tokenHandler } from '../token';

const DEVICE_SECRET_TYPE = 'urn:openid:params:token-type:device-secret';
const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token';
const JWT_TYPE = 'urn:ietf:params:oauth:token-type:jwt';

async function exchange(
  bodyOverrides: Record<string, unknown> = {},
  options: Parameters<typeof exchangeContext>[1] = {}
): Promise<Response> {
  const env = { ...(await keyEnv()), ...options.env };
  return tokenHandler(exchangeContext(bodyOverrides, { ...options, env }));
}

function useClient(overrides: Record<string, unknown>): void {
  m.getClientCached.mockImplementation(async (_c: unknown, _e: unknown, id: string) =>
    id === SERVICE_CLIENT ? baseClient(overrides) : null
  );
}

describe('token exchange request parameters', () => {
  beforeEach(() => resetExchange());

  it('issues a token for the requested audience', async () => {
    const response = await exchange();
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({
      access_token: 'exchanged-access-token',
      issued_token_type: AT_TYPE,
      token_type: 'Bearer',
    });
    expect(issuedClaims()).toMatchObject({ aud: TARGET, client_id: SERVICE_CLIENT });
  });

  it('ignores audience values that are not strings', async () => {
    const response = await exchange({ audience: [TARGET, 42] });
    expect(response.status).toBe(200);
    expect(issuedClaims().aud).toBe(TARGET);
  });

  it('falls back to the client default resource when audience is not a string', async () => {
    useClient({ default_resource: TARGET });
    const response = await exchange({ audience: 42 });
    expect(response.status).toBe(200);
    expect(issuedClaims().aud).toBe(TARGET);
  });

  it('accepts exactly the configured number of resource and audience parameters', async () => {
    settingsOverrides.limits = {
      'limits.token_exchange_max_resource_params': 2,
      'limits.token_exchange_max_audience_params': 2,
    };
    const both = [TARGET, 'https://other.example.com'];
    const response = await exchange({ audience: both, resource: both });
    expect(response.status).toBe(200);
    expect(issuedClaims()).toMatchObject({ aud: [...both, ...both], resource: both });
  });

  it('refuses a Native SSO exchange without its device secret', async () => {
    const response = await exchange({
      subject_token_type: ID_TOKEN_TYPE,
      actor_token_type: DEVICE_SECRET_TYPE,
    });
    expect(response.status).toBe(400);
    expect(await body(response)).toMatchObject({
      error: 'invalid_request',
      error_description: 'actor_token is required for Native SSO token exchange',
      error_details: { code: 'device_secret_missing' },
    });
  });

  it('maps the jwt short name to its token type URN', async () => {
    settingsOverrides.tokens = { 'tokens.exchange_allowed_subject_token_types': 'jwt' };
    const response = await exchange({ subject_token_type: JWT_TYPE });
    expect(response.status).toBe(200);
  });

  it('lists every allowed type when refusing a subject token type', async () => {
    settingsOverrides.tokens = {
      'tokens.exchange_allowed_subject_token_types': 'access_token, jwt',
    };
    await expectError(
      await exchange({ subject_token_type: ID_TOKEN_TYPE }),
      400,
      'invalid_request',
      `subject_token_type '${ID_TOKEN_TYPE}' is not allowed. Allowed types: access_token, jwt`
    );
  });
});

describe('token exchange client authentication', () => {
  beforeEach(() => resetExchange());

  const assertionType = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

  function assertionClient(): void {
    useClient({ client_secret_hash: undefined, token_endpoint_auth_method: 'private_key_jwt' });
  }

  it('takes the client id from a client assertion and validates it for the token endpoint', async () => {
    assertionClient();
    m.parseToken.mockReturnValueOnce({ sub: SERVICE_CLIENT });
    const response = await exchange({
      client_id: undefined,
      client_secret: undefined,
      client_assertion: 'assertion-jwt',
      client_assertion_type: assertionType,
    });
    expect(response.status).toBe(200);
    expect(m.validateClientAssertion).toHaveBeenCalledTimes(1);
    const [token, audience, client, options] = m.validateClientAssertion.mock.calls[0] as [
      string,
      string,
      { client_id: string },
      { replayProtection: { env: unknown; tenantId: string } },
    ];
    expect([token, audience, client.client_id]).toEqual([
      'assertion-jwt',
      'https://auth.example.com/token',
      SERVICE_CLIENT,
    ]);
    expect(Object.keys(options)).toEqual(['replayProtection']);
    expect(options.replayProtection.tenantId).toBe('default');
    expect(options.replayProtection.env).toBeDefined();
    expect(issuedClaims().client_id).toBe(SERVICE_CLIENT);
  });

  it('looks up the explicit client id, then refuses an assertion naming another client', async () => {
    assertionClient();
    m.parseToken.mockReturnValueOnce({ sub: 'someone-else' });
    const MISMATCH = 'Client assertion iss and sub must be the client_id';
    const REFUSED = 'Client assertion validation failed';
    m.validateClientAssertion.mockResolvedValue({
      valid: false,
      error: 'invalid_client',
      error_description: MISMATCH,
    });
    const response = await exchange({
      client_secret: undefined,
      client_assertion: 'assertion-jwt',
      client_assertion_type: assertionType,
    });
    await expectError(response, 401, 'invalid_client', REFUSED);
    expect(m.getClientCached).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.anything(),
      SERVICE_CLIENT
    );
  });

  it('refuses an unparseable client assertion', async () => {
    assertionClient();
    m.parseToken.mockImplementationOnce(() => {
      throw new Error('bad jwt');
    });
    await expectError(
      await exchange({
        client_secret: undefined,
        client_assertion: 'garbage',
        client_assertion_type: assertionType,
      }),
      401,
      'invalid_client',
      'Invalid client_assertion format'
    );
  });

  it('refuses a client assertion that fails validation', async () => {
    assertionClient();
    m.parseToken.mockReturnValueOnce({ sub: SERVICE_CLIENT });
    m.validateClientAssertion.mockResolvedValueOnce({ valid: false, error_description: 'exp' });
    await expectError(
      await exchange({
        client_secret: undefined,
        client_assertion: 'assertion-jwt',
        client_assertion_type: assertionType,
      }),
      401,
      'invalid_client',
      'Client assertion validation failed'
    );
  });

  it('authenticates by secret when only an assertion type is sent', async () => {
    // Only the subject token parses: an attempt to read a missing assertion would fail.
    m.parseToken.mockImplementation((token: string) => {
      if (token !== 'subject-token') throw new Error('not a JWT');
      return userSubject();
    });
    const response = await exchange({ client_assertion_type: assertionType });
    expect(response.status).toBe(200);
    expect(m.validateClientAssertion).not.toHaveBeenCalled();
    expect(m.verifyClientSecretHash).toHaveBeenCalledWith('top-secret', 'hashed-secret');
  });

  const basic = (user: string, secret: string) => ({
    Authorization: `Basic ${btoa(`${user}:${secret}`)}`,
  });

  it('takes client credentials from HTTP Basic', async () => {
    useClient({ token_endpoint_auth_method: 'client_secret_basic' });
    const response = await exchange(
      { client_id: undefined, client_secret: undefined },
      { headers: basic(SERVICE_CLIENT, 'basic-secret') }
    );
    expect(response.status).toBe(200);
    expect(m.verifyClientSecretHash).toHaveBeenCalledWith('basic-secret', 'hashed-secret');
  });

  it('keeps a body client id over the HTTP Basic user name', async () => {
    useClient({ token_endpoint_auth_method: 'client_secret_basic' });
    const response = await exchange(
      { client_secret: undefined },
      { headers: basic('other-client', 'basic-secret') }
    );
    expect(response.status).toBe(200);
    expect(m.getClientCached).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.anything(),
      SERVICE_CLIENT
    );
    expect(m.verifyClientSecretHash).toHaveBeenCalledWith('basic-secret', 'hashed-secret');
  });

  it('refuses an Authorization header that does not decode', async () => {
    await expectError(
      await exchange({}, { headers: { Authorization: 'Basic %%%not-base64%%%' } }),
      401,
      'invalid_client',
      'Invalid Authorization header format'
    );
  });
});

describe('token exchange sender constraints', () => {
  beforeEach(() => resetExchange());

  it('requires a DPoP proof when assurance requires one (FAL2)', async () => {
    settingsOverrides.assurance = {
      'assurance.enabled': true,
      'assurance.default_fal': 'FAL2',
      'assurance.fal2_requires_dpop': true,
    };
    await expectError(await exchange(), 400, 'invalid_request', 'A DPoP proof is required (FAL2)');
    m.extractDPoPProof.mockReturnValue('dpop-proof');
    expect((await exchange()).status).toBe(200);
  });

  it('requires a DPoP proof when the tenant binds access tokens to DPoP', async () => {
    m.resolveAppSecurityRequirements.mockResolvedValue({ dpopBoundAccessTokens: true });
    await expectError(
      await exchange(),
      400,
      'invalid_request',
      'DPoP proof is required for this request'
    );
    m.extractDPoPProof.mockReturnValue('dpop-proof');
    const response = await exchange();
    expect(response.status).toBe(200);
    expect((await body(response)).token_type).toBe('DPoP');
    expect(issuedClaims().cnf).toEqual({ jkt: 'dpop-jkt' });
  });

  it('refuses an mTLS-bound client without a valid certificate', async () => {
    useClient({ tls_client_certificate_bound_access_tokens: true });
    await expectError(
      await exchange(),
      401,
      'invalid_client',
      'Client certificate authentication failed'
    );
    m.validateClientCertificateBinding.mockResolvedValue({ valid: true });
    await expectError(
      await exchange(),
      401,
      'invalid_client',
      'Client certificate authentication failed'
    );
    m.validateClientCertificateBinding.mockResolvedValue({ valid: false, thumbprint: 'tp' });
    await expectError(
      await exchange(),
      401,
      'invalid_client',
      'Client certificate authentication failed'
    );
  });

  it('binds the exchanged token to an mTLS-bound client certificate', async () => {
    useClient({ tls_client_certificate_bound_access_tokens: true });
    m.validateClientCertificateBinding.mockResolvedValue({ valid: true, thumbprint: 'cert-tp' });
    const response = await exchange();
    expect(response.status).toBe(200);
    expect(issuedClaims().cnf).toEqual({ 'x5t#S256': 'cert-tp' });
    expect(m.getPresentedClientCertificateThumbprint).not.toHaveBeenCalled();
  });

  it('answers a DPoP proof failure with the fallback description', async () => {
    m.extractDPoPProof.mockReturnValue('dpop-proof');
    m.validateDPoPProof.mockResolvedValue({ valid: false });
    await expectError(await exchange(), 400, 'invalid_dpop_proof', 'DPoP validation failed');
  });
});
