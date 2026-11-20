/**
 * Token Exchange: DPoP nonce policy (client, resource, tenant, default), DPoP requirement
 * sources (FAPI, tenant, client), FAPI client authentication and the Native SSO public client
 * exception, as the token endpoint applies them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SERVICE_CLIENT,
  TARGET,
  baseClient,
  body,
  exchangeContext,
  expectError,
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

const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

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

/** Protocol settings: `security` for the DPoP nonce read, `fapi` for the others. */
function protocol(input: { security?: unknown; fapi?: unknown; securityThrows?: boolean }) {
  m.protocolSettings.mockImplementation(
    async (_c: unknown, _e: unknown, options: { sections?: string[] }) => {
      if (options?.sections?.includes('security')) {
        if (input.securityThrows) throw new Error('settings unavailable');
        return { security: input.security ?? {} };
      }
      return { fapi: input.fapi ?? {} };
    }
  );
}

describe('DPoP nonce policy on a use_dpop_nonce failure', () => {
  beforeEach(() => {
    resetExchange();
    m.extractDPoPProof.mockReturnValue('dpop-proof');
    m.validateDPoPProof.mockResolvedValue({
      valid: false,
      error: 'use_dpop_nonce',
      error_description: 'A nonce is required',
    });
  });

  async function expectNonceChallenge(response: Response): Promise<void> {
    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({
      error: 'use_dpop_nonce',
      error_description: 'A nonce is required',
    });
    expect(response.headers.get('DPoP-Nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
  }

  async function expectNonceRefused(response: Response): Promise<void> {
    await expectError(response, 400, 'invalid_dpop_proof', 'A nonce is required');
    expect(response.headers.get('DPoP-Nonce')).toBeNull();
  }

  it('asks for a nonce by default, with a fresh one each time', async () => {
    const first = await exchange();
    const second = await exchange();
    await expectNonceChallenge(first);
    expect(second.headers.get('DPoP-Nonce')).not.toBe(first.headers.get('DPoP-Nonce'));
  });

  it('asks for a nonce when the settings cannot be read', async () => {
    protocol({ securityThrows: true });
    await expectNonceChallenge(await exchange());
  });

  it('follows the client dpop_nonce_enabled and dpop_nonce_required settings', async () => {
    useClient({ dpop_nonce_enabled: false });
    await expectNonceRefused(await exchange());
    useClient({ dpop_nonce_required: false });
    await expectNonceRefused(await exchange());
    useClient({ dpop_nonce_enabled: true, dpop_nonce_required: false });
    await expectNonceChallenge(await exchange());
  });

  it('ignores a client setting that is not a boolean', async () => {
    useClient({ dpop_nonce_enabled: 'false' });
    protocol({ security: { dpop_nonce_enabled: false } });
    await expectNonceRefused(await exchange());
    useClient({ dpop_nonce_enabled: 'false' });
    protocol({});
    await expectNonceChallenge(await exchange());
  });

  it('follows a resource override for a requested resource', async () => {
    protocol({
      security: {
        dpop_nonce_enabled: true,
        dpop_nonce_resource_overrides: { 'https://unrelated.example': true, [TARGET]: false },
      },
    });
    await expectNonceRefused(await exchange({ resource: TARGET }));
    // Without the resource parameter the tenant setting applies.
    await expectNonceChallenge(await exchange());
  });

  it('ignores resource overrides that are not an object of booleans', async () => {
    protocol({
      security: { dpop_nonce_enabled: false, dpop_nonce_resource_overrides: [true] },
    });
    await expectNonceRefused(await exchange({ resource: TARGET }));
    protocol({
      security: {
        dpop_nonce_enabled: false,
        dpop_nonce_resource_overrides: { [TARGET]: 'yes' },
      },
    });
    await expectNonceRefused(await exchange({ resource: TARGET }));
    protocol({ security: { dpop_nonce_resource_overrides: { [TARGET]: true } } });
    await expectNonceChallenge(await exchange({ resource: TARGET }));
  });

  it('follows the tenant dpop_nonce_enabled setting', async () => {
    protocol({ security: { dpop_nonce_enabled: false } });
    await expectNonceRefused(await exchange());
  });

  it('answers other DPoP failures with their own error', async () => {
    m.validateDPoPProof.mockResolvedValue({
      valid: false,
      error: 'invalid_dpop_proof',
      error_description: 'Proof htu mismatch',
    });
    await expectError(await exchange(), 400, 'invalid_dpop_proof', 'Proof htu mismatch');
  });
});

describe('where a DPoP proof is required', () => {
  beforeEach(() => resetExchange());

  it('reads the security requirements of the client tenant', async () => {
    useClient({ tenant_id: 'tenant-a' });
    expect((await exchange()).status).toBe(200);
    expect(m.resolveAppSecurityRequirements).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a',
      SERVICE_CLIENT
    );
  });

  it('requires DPoP when FAPI requires it', async () => {
    protocol({ fapi: { requireDpop: true } });
    await expectError(
      await exchange(),
      400,
      'invalid_request',
      'DPoP proof is required for this request'
    );
    protocol({ fapi: { enabled: true } });
    await expectError(
      await exchange(),
      400,
      'invalid_request',
      'DPoP proof is required for this request'
    );
  });

  it.each([{ dpop_mode: 'all' }, { dpop_bound_access_tokens: true }])(
    'requires DPoP when the client asks for it (%j)',
    async (setting) => {
      useClient(setting);
      await expectError(
        await exchange(),
        400,
        'invalid_request',
        'DPoP proof is required for this request'
      );
    }
  );

  it('refuses the request when the FAPI settings cannot be read', async () => {
    m.protocolSettings.mockRejectedValue(new Error('kv down'));
    await expectError(
      await exchange(),
      503,
      'temporarily_unavailable',
      'Security profile settings are temporarily unavailable'
    );
  });
});

describe('FAPI client authentication', () => {
  beforeEach(() => {
    resetExchange();
    // FAPI on, with DPoP explicitly not required, so client authentication decides.
    protocol({ fapi: { enabled: true, requireDpop: false } });
  });

  function privateKeyJwtClient(overrides: Record<string, unknown> = {}): void {
    useClient({
      client_secret_hash: undefined,
      token_endpoint_auth_method: 'private_key_jwt',
      ...overrides,
    });
  }

  const assertion = {
    client_secret: undefined,
    client_assertion: 'jwt',
    client_assertion_type: ASSERTION_TYPE,
  };

  it('refuses client secret authentication', async () => {
    await expectError(
      await exchange(),
      401,
      'invalid_client',
      'The active FAPI profile requires private_key_jwt client authentication'
    );
  });

  it('refuses a private_key_jwt client without an assertion of the jwt-bearer type', async () => {
    privateKeyJwtClient();
    for (const sent of [
      { client_secret: undefined },
      { ...assertion, client_assertion_type: 'urn:example:other' },
    ]) {
      await expectError(
        await exchange(sent),
        401,
        'invalid_client',
        'The active FAPI profile requires private_key_jwt client authentication'
      );
    }
  });

  it('refuses a second authentication method next to the assertion', async () => {
    privateKeyJwtClient();
    m.parseToken.mockReturnValueOnce({ sub: SERVICE_CLIENT });
    await expectError(
      await exchange({ ...assertion, client_secret: 'also-a-secret' }),
      401,
      'invalid_client',
      'Multiple client authentication methods are not allowed'
    );
  });

  it('validates the assertion for the issuer with FAPI algorithms', async () => {
    privateKeyJwtClient();
    m.parseToken.mockReturnValueOnce({ sub: SERVICE_CLIENT });
    expect((await exchange(assertion)).status).toBe(200);
    expect(m.validateClientAssertion).toHaveBeenCalledTimes(1);
    const [token, audience, , options] = m.validateClientAssertion.mock.calls[0] as [
      string,
      string,
      unknown,
      { allowedAlgorithms: string[] },
    ];
    expect([token, audience]).toEqual(['jwt', 'https://auth.example.com/token']);
    expect(options).toMatchObject({
      audiencePolicy: 'issuer-only',
      issuer: 'https://auth.example.com',
      clockSkewSeconds: 60,
    });
    expect(options.allowedAlgorithms).toContain('PS256');
  });

  it.each([['urn:openid:params:grant-type:ciba'], [['urn:openid:params:grant-type:ciba']]])(
    'lets a CIBA client assertion name its endpoint (grant_types %j)',
    async (grantTypes) => {
      privateKeyJwtClient({ grant_types: grantTypes });
      m.parseToken.mockReturnValueOnce({ sub: SERVICE_CLIENT });
      expect((await exchange(assertion)).status).toBe(200);
      expect(m.validateClientAssertion).toHaveBeenCalledWith(
        'jwt',
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ audiencePolicy: 'endpoint-or-issuer' })
      );
    }
  );
});

describe('Native SSO public client exception', () => {
  const nativeRequest = {
    subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
    actor_token: 'device-secret',
    actor_token_type: 'urn:openid:params:token-type:device-secret',
    client_secret: undefined,
  };

  beforeEach(() => {
    resetExchange();
    settingsOverrides.tokens = {
      'tokens.exchange_allowed_subject_token_types': 'access_token,id_token',
    };
    useClient({
      client_secret_hash: undefined,
      token_endpoint_auth_method: 'none',
      application_type: 'native',
    });
  });

  it('requires channel=native', async () => {
    await expectError(
      await exchange(nativeRequest),
      400,
      'invalid_request',
      'Native SSO public client token exchange requires channel=native'
    );
  });

  it('requires a native application', async () => {
    useClient({
      client_secret_hash: undefined,
      token_endpoint_auth_method: 'none',
      application_type: 'web',
    });
    await expectError(
      await exchange({ ...nativeRequest, channel: 'native' }),
      403,
      'unauthorized_client',
      'Client is not eligible for Native SSO public client token exchange'
    );
  });

  it('requires a DPoP proof', async () => {
    const response = await exchange({ ...nativeRequest, channel: 'native' });
    expect(response.status).toBe(400);
    expect(await body(response)).toMatchObject({
      error: 'invalid_request',
      error_description: 'DPoP proof is required for Native SSO token exchange',
      error_details: { code: 'dpop_proof_missing' },
    });
  });

  it('authenticates a confidential client without a secret by its assertion', async () => {
    useClient({ client_secret_hash: undefined, token_endpoint_auth_method: 'private_key_jwt' });
    m.parseToken.mockReturnValueOnce({ sub: SERVICE_CLIENT });
    m.validateClientAssertion.mockResolvedValueOnce({ valid: false });
    await expectError(
      await exchange({
        ...nativeRequest,
        client_assertion: 'jwt',
        client_assertion_type: ASSERTION_TYPE,
      }),
      401,
      'invalid_client',
      'Client assertion validation failed'
    );
  });
});
