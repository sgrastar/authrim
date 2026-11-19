/**
 * Token Exchange: requested_token_type and ID-JAG (draft-ietf-oauth-identity-assertion-authz-grant)
 * issuance from an external IdP's subject token.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SERVICE_CLIENT,
  baseClient,
  body,
  exchangeContext,
  expectError,
  issuedClaims,
  keyEnv,
  m,
  resetExchange,
  settingsOverrides,
} from './helpers/mut-exchange-harness';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const h = await import('./helpers/mut-exchange-harness');
  return h.mockCore(await importOriginal());
});
vi.mock('../external-id-jag-verifier', async () =>
  (await import('./helpers/mut-exchange-harness')).mockJagVerifier()
);

import { tokenHandler } from '../token';

const ID_JAG = 'urn:ietf:params:oauth:token-type:id-jag';
const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token';
const IDP = 'https://idp.example';

async function exchange(bodyOverrides: Record<string, unknown> = {}): Promise<Response> {
  return tokenHandler(exchangeContext(bodyOverrides, { env: await keyEnv() }));
}

function useClient(overrides: Record<string, unknown>): void {
  m.getClientCached.mockImplementation(async (_c: unknown, _e: unknown, id: string) =>
    id === SERVICE_CLIENT ? baseClient(overrides) : null
  );
}

const externalPayload = (overrides: Record<string, unknown> = {}) => ({
  iss: IDP,
  sub: 'external-user',
  aud: SERVICE_CLIENT,
  scope: 'openid profile',
  exp: Math.floor(Date.now() / 1000) + 300,
  ...overrides,
});

function enableIdJag(tokens: Record<string, unknown> = {}): void {
  settingsOverrides['feature-flags'] = { 'feature.enable_id_jag': true };
  settingsOverrides.tokens = {
    'tokens.exchange_allowed_subject_token_types': 'access_token,id_token',
    'tokens.id_jag_allowed_issuers': [IDP],
    ...tokens,
  };
}

const idJagRequest = { requested_token_type: ID_JAG, subject_token_type: ID_TOKEN_TYPE };

describe('requested_token_type', () => {
  beforeEach(() => resetExchange());

  it('echoes an explicitly requested access token type', async () => {
    const response = await exchange({
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    });
    expect(response.status).toBe(200);
    expect((await body(response)).issued_token_type).toBe(
      'urn:ietf:params:oauth:token-type:access_token'
    );
  });

  it('refuses an ID-JAG while ID-JAG is not enabled', async () => {
    await expectError(
      await exchange({ requested_token_type: ID_JAG }),
      400,
      'invalid_request',
      'ID-JAG token type is not enabled. Enable it via Admin API.'
    );
  });

  it('refuses any other requested token type', async () => {
    await expectError(
      await exchange({ requested_token_type: 'urn:ietf:params:oauth:token-type:refresh_token' }),
      400,
      'invalid_request',
      'Only access_token and id-jag (when enabled) are supported as requested_token_type'
    );
  });
});

describe('ID-JAG issuance', () => {
  beforeEach(() => {
    resetExchange();
    enableIdJag();
    m.parseToken.mockReturnValue(externalPayload());
    m.verifyExternalIdJag.mockResolvedValue(
      externalPayload({ acr: 'urn:example:acr:mfa', amr: ['pwd', 'otp'] })
    );
  });

  it('issues an ID-JAG carrying the original issuer and authentication context', async () => {
    enableIdJag({ 'tokens.id_jag_max_token_lifetime': 300 });
    useClient({ allowed_subject_token_clients: [SERVICE_CLIENT, 'partner-app'] });
    const response = await exchange(idJagRequest);
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({
      issued_token_type: ID_JAG,
      expires_in: 300,
      scope: 'openid profile',
    });
    expect(m.verifyExternalIdJag).toHaveBeenCalledWith({
      token: 'subject-token',
      issuer: IDP,
      audiences: [SERVICE_CLIENT, 'partner-app'],
    });
    expect(issuedClaims()).toMatchObject({
      sub: 'external-user',
      original_issuer: IDP,
      authrim_subject_issuer: IDP,
      tenant: 'default',
      acr: 'urn:example:acr:mfa',
      amr: ['pwd', 'otp'],
    });
    expect(m.createAccessToken.mock.calls[0][3]).toBe(300);
    // An external subject token is not verified against Authrim's own keys.
    expect(m.verifyToken).not.toHaveBeenCalled();
  });

  it('keeps the shorter access token lifetime and leaves out what is not set', async () => {
    enableIdJag({
      'tokens.id_jag_max_token_lifetime': 7200,
      'tokens.id_jag_include_tenant_claim': false,
    });
    m.verifyExternalIdJag.mockResolvedValue(externalPayload());
    const response = await exchange(idJagRequest);
    expect((await body(response)).expires_in).toBe(3600);
    const claims = issuedClaims();
    expect(claims).not.toHaveProperty('tenant');
    expect(claims).not.toHaveProperty('acr');
    expect(claims).not.toHaveProperty('amr');
    expect(m.verifyExternalIdJag).toHaveBeenCalledWith(
      expect.objectContaining({ audiences: [SERVICE_CLIENT] })
    );
  });

  it('puts no ID-JAG claims on an ordinary exchange', async () => {
    m.parseToken.mockReturnValue({
      ...externalPayload({ acr: 'acr', amr: ['pwd'] }),
      iss: 'https://auth.example.com',
      sub: `client:${SERVICE_CLIENT}`,
      client_id: SERVICE_CLIENT,
      token_use: 'access',
      jti: 'subject-jti',
      aud: [SERVICE_CLIENT],
    });
    const response = await exchange();
    expect(response.status).toBe(200);
    const claims = issuedClaims();
    for (const claim of ['original_issuer', 'tenant', 'acr', 'amr']) {
      expect(claims).not.toHaveProperty(claim);
    }
  });

  it('refuses a client that uses pairwise subject identifiers', async () => {
    useClient({ subject_type: 'pairwise' });
    await expectError(
      await exchange(idJagRequest),
      400,
      'invalid_request',
      'ID-JAG is not available to a client that uses pairwise subject identifiers'
    );
  });

  it('requires an identity subject token type', async () => {
    const type = 'urn:ietf:params:oauth:token-type:access_token';
    await expectError(
      await exchange({ requested_token_type: ID_JAG }),
      400,
      'invalid_request',
      `ID-JAG requires subject_token_type to be id_token, jwt, or saml2. Got: ${type}`
    );
  });

  it('requires an issuer on the subject token', async () => {
    m.parseToken.mockReturnValue(externalPayload({ iss: undefined }));
    await expectError(
      await exchange(idJagRequest),
      400,
      'invalid_grant',
      'Subject token is missing issuer (iss) claim'
    );
  });

  it('refuses every issuer while none is configured', async () => {
    enableIdJag({ 'tokens.id_jag_allowed_issuers': [] });
    await expectError(
      await exchange(idJagRequest),
      400,
      'invalid_grant',
      'ID-JAG is enabled but no allowed issuers are configured. Configure allowedIssuers via Admin API.'
    );
  });

  it('refuses an issuer that is not allowed', async () => {
    m.parseToken.mockReturnValue(externalPayload({ iss: 'https://evil.example' }));
    await expectError(
      await exchange(idJagRequest),
      400,
      'invalid_grant',
      "Subject token issuer 'https://evil.example' is not in the allowed issuers list"
    );
    expect(m.verifyExternalIdJag).not.toHaveBeenCalled();
  });

  it('refuses a subject token the external issuer does not verify', async () => {
    m.verifyExternalIdJag.mockRejectedValue(new Error('signature'));
    await expectError(
      await exchange(idJagRequest),
      400,
      'invalid_grant',
      'Subject token verification failed'
    );
  });
});
