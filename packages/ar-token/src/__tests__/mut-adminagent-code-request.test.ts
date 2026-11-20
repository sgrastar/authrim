/**
 * Admin Agent authorization_code grant: settings gate, request shape, client authentication,
 * DPoP and code consumption / replay (src/admin-agent-token.ts adminAgentTokenHandler).
 */
import {
  anyString,
  anything,
  codeData,
  codeForm,
  confidentialClient,
  environment,
  expectError,
  MCP,
  mocks,
  post,
  publicClient,
  resetDefaults,
  TOKEN_URL,
} from './helpers/mut-adminagent-setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MISSING = 'Required token parameter is missing';
const CLIENT_FAILED = 'Client authentication failed';
const settingsEnv = (raw: string | null, flag = 'false') => {
  const get = vi.fn(async () => raw);
  return { get, env: environment({ ENABLE_AGENT_MCP: flag, SETTINGS: { get } as never }) };
};

describe('Admin Agent token endpoint: settings gate', () => {
  beforeEach(resetDefaults);

  it('reads the tenant Agent settings record and honours its enablement', async () => {
    const { get, env } = settingsEnv(JSON.stringify({ 'agent.mcp.enabled': true }));
    expect((await post('token', codeForm(), {}, env)).status).toBe(200);
    expect(get).toHaveBeenCalledWith('settings:tenant:tenant-1:agent-access');
  });

  it('falls back to the environment flag when no tenant record exists', async () => {
    const { env } = settingsEnv(null, 'true');
    expect((await post('token', codeForm(), {}, env)).status).toBe(200);
  });

  it.each([
    ['a scalar false tenant value', 'false'],
    ['an array tenant value', '[]'],
    ['an object that disables Agent access', JSON.stringify({ 'agent.mcp.enabled': false })],
  ])('returns not_found for %s even when the environment enables it', async (_name, raw) => {
    const { env } = settingsEnv(raw, 'true');
    const response = await post('token', codeForm(), {}, env);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    expect(mocks.consumeCodeRpc).not.toHaveBeenCalled();
  });

  it('enables Agent access from a scalar true tenant value', async () => {
    const { env } = settingsEnv('true', 'false');
    expect((await post('token', codeForm(), {}, env)).status).toBe(200);
  });

  it('requires form encoding', async () => {
    const response = await post('token', codeForm(), { 'content-type': 'text/plain' });
    await expectError(
      response,
      400,
      'invalid_request',
      'Content-Type must be application/x-www-form-urlencoded'
    );
  });
});

describe('Admin Agent token endpoint: authorization code request', () => {
  beforeEach(resetDefaults);
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects unsupported parameters and grant types with exact errors', async () => {
    await expectError(
      await post('token', codeForm({ extra: 'x' })),
      400,
      'invalid_request',
      'Unsupported token parameter'
    );
    await expectError(
      await post('token', codeForm({ grant_type: 'password' })),
      400,
      'unsupported_grant_type',
      'Only authorization_code, refresh_token, and token exchange are implemented'
    );
  });

  it.each(['code', 'redirect_uri', 'client_id', 'code_verifier', 'resource'])(
    'rejects a request without %s',
    async (field) => {
      const form: Record<string, string> = codeForm();
      delete form[field];
      await expectError(await post('token', form), 400, 'invalid_request', MISSING);
      expect(mocks.getClientCached).not.toHaveBeenCalled();
    }
  );

  it('rejects a malformed client id and a foreign resource with exact errors', async () => {
    await expectError(
      await post('token', codeForm({ client_id: 'bad client' })),
      401,
      'invalid_client',
      CLIENT_FAILED
    );
    await expectError(
      await post('token', codeForm({ resource: 'https://other.example/mcp' })),
      400,
      'invalid_target',
      'resource must identify this MCP endpoint'
    );
    expect(mocks.getClientCached).not.toHaveBeenCalled();
  });

  it('rejects an unknown client and a self-service client expiring right now', async () => {
    mocks.getClientCached.mockResolvedValueOnce(null);
    await expectError(await post('token', codeForm()), 401, 'invalid_client', CLIENT_FAILED);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
    mocks.getClientCached.mockResolvedValueOnce({
      ...publicClient(),
      agent_access_registration_mode: 'self_service',
      agent_access_expires_at: 1_800_000_000_000,
    });
    await expectError(await post('token', codeForm()), 401, 'invalid_client', CLIENT_FAILED);
    expect(mocks.consumeCodeRpc).not.toHaveBeenCalled();
  });

  it('returns the parse error for a malformed Basic header', async () => {
    await expectError(
      await post('token', codeForm(), { authorization: 'Basic !!!' }),
      401,
      'invalid_client',
      'Invalid Authorization header format'
    );
  });

  it('rejects a public client presenting a secret', async () => {
    await expectError(
      await post('token', codeForm({ client_secret: 's' })),
      401,
      'invalid_client',
      CLIENT_FAILED
    );
    expect(mocks.authenticateConfidentialOAuthClient).not.toHaveBeenCalled();
  });

  it('authenticates a confidential client at the Admin Agent token endpoint', async () => {
    mocks.getClientCached.mockResolvedValue(confidentialClient());
    expect((await post('token', codeForm({ client_secret: 's' }))).status).toBe(200);
    expect(mocks.authenticateConfidentialOAuthClient).toHaveBeenCalledWith(
      expect.objectContaining({ client_id: 'mcp-client' }),
      TOKEN_URL,
      expect.objectContaining({ clientSecret: 's' }),
      { replayProtection: { env: anything(), tenantId: 'tenant-1' } }
    );
  });

  it('accepts a private_key_jwt client assertion', async () => {
    mocks.getClientCached.mockResolvedValue({
      ...confidentialClient(),
      token_endpoint_auth_method: 'private_key_jwt',
    });
    const response = await post(
      'token',
      codeForm({
        client_assertion: 'a.b.c',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      })
    );
    expect(response.status).toBe(200);
  });

  it('returns the confidential authentication failure', async () => {
    mocks.getClientCached.mockResolvedValue(confidentialClient());
    mocks.authenticateConfidentialOAuthClient.mockResolvedValue({
      ok: false,
      error: 'invalid_client',
      errorDescription: 'bad secret',
    });
    await expectError(
      await post('token', codeForm({ client_secret: 's' })),
      401,
      'invalid_client',
      'bad secret'
    );
    expect(mocks.consumeCodeRpc).not.toHaveBeenCalled();
  });
});

describe('Admin Agent token endpoint: DPoP and code consumption', () => {
  beforeEach(resetDefaults);

  it('passes the DPoP validator error through', async () => {
    mocks.validateDPoPProof.mockResolvedValue({
      valid: false,
      error: 'use_dpop_nonce',
      error_description: 'nonce required',
    });
    await expectError(
      await post('token', codeForm(), { dpop: 'proof' }),
      400,
      'use_dpop_nonce',
      'nonce required'
    );
    expect(mocks.consumeCodeRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['an invalid proof', { valid: false }],
    ['a proof without a thumbprint', { valid: true }],
  ])('rejects %s with the default DPoP error', async (_name, result) => {
    mocks.validateDPoPProof.mockResolvedValue(result);
    await expectError(
      await post('token', codeForm(), { dpop: 'proof' }),
      400,
      'invalid_dpop_proof',
      'DPoP proof validation failed'
    );
  });

  it('requires DPoP for an opted-in client', async () => {
    mocks.getClientCached.mockResolvedValue({ ...publicClient(), dpop_bound_access_tokens: true });
    await expectError(
      await post('token', codeForm()),
      400,
      'invalid_dpop_proof',
      'DPoP proof is required for this client'
    );
  });

  it('consumes the code with the full expected binding', async () => {
    mocks.validateDPoPProof.mockResolvedValue({ valid: true, jkt: 'jkt-1' });
    mocks.consumeCodeRpc.mockResolvedValue(codeData({ dpopJkt: 'jkt-1' }));
    expect((await post('token', codeForm(), { dpop: 'proof' })).status).toBe(200);
    expect(mocks.validateDPoPProof).toHaveBeenCalledWith(
      'proof',
      'POST',
      TOKEN_URL,
      undefined,
      anything(),
      'mcp-client',
      'tenant-1'
    );
    expect(mocks.consumeCodeRpc).toHaveBeenCalledWith({
      code: 'aac_valid-code',
      tenantId: 'tenant-1',
      clientId: 'mcp-client',
      codeVerifier: 'v'.repeat(43),
      expectedAuthorizationServer: 'admin_agent',
      expectedSubjectType: 'admin_user',
      expectedResource: MCP,
      expectedRedirectUri: 'https://client.example.com/callback',
      enforceDpopBinding: true,
      expectedDpopJkt: 'jkt-1',
      accessTokenJti: anyString(),
    });
  });

  it('reports a failed code consumption as invalid_grant', async () => {
    mocks.consumeCodeRpc.mockRejectedValue(new Error('expired'));
    await expectError(
      await post('token', codeForm()),
      400,
      'invalid_grant',
      'Authorization code is invalid or expired'
    );
  });

  it('revokes both tokens issued from a replayed code', async () => {
    mocks.consumeCodeRpc.mockResolvedValue({
      replayAttack: { accessTokenJti: 'at-1', refreshTokenJti: 'rt-1' },
    });
    await expectError(
      await post('token', codeForm()),
      400,
      'invalid_grant',
      'Authorization code replay detected'
    );
    expect(mocks.revokeToken).toHaveBeenCalledWith(
      anything(),
      'at-1',
      900,
      'Admin Agent authorization code replay',
      'tenant-1'
    );
    expect(mocks.getRefreshTokenRotatorStubByJti).toHaveBeenCalledWith(
      anything(),
      'mcp-client',
      'rt-1',
      'tenant-1'
    );
    expect(mocks.revokeByJtiRpc).toHaveBeenCalledWith(
      'rt-1',
      'Admin Agent authorization code replay'
    );
    expect(mocks.createAccessToken).not.toHaveBeenCalled();
  });

  it('still rejects a replay when revocation fails or nothing was issued', async () => {
    mocks.revokeToken.mockRejectedValue(new Error('down'));
    mocks.revokeByJtiRpc.mockRejectedValue(new Error('down'));
    mocks.consumeCodeRpc.mockResolvedValueOnce({
      replayAttack: { accessTokenJti: 'at-1', refreshTokenJti: 'rt-1' },
    });
    await expectError(await post('token', codeForm()), 400, 'invalid_grant');

    mocks.revokeToken.mockClear();
    mocks.revokeByJtiRpc.mockClear();
    mocks.consumeCodeRpc.mockResolvedValueOnce({ replayAttack: {} });
    await expectError(await post('token', codeForm()), 400, 'invalid_grant');
    expect(mocks.revokeToken).not.toHaveBeenCalled();
    expect(mocks.revokeByJtiRpc).not.toHaveBeenCalled();
  });

  const BINDING = 'Authorization code binding is invalid';
  it.each([
    ['another redirect URI', { redirectUri: 'https://evil.example/cb' }],
    ['a DPoP binding without a proof', { dpopJkt: 'jkt-1' }],
    ['a non-admin subject', { userId: 'user:admin-1' }],
    ['no Agent Grant', { agentGrantId: undefined }],
    ['no Grant generation', { agentGrantGeneration: undefined }],
    ['no consent version', { agentConsentVersion: undefined }],
  ])('rejects a code with %s', async (_name, overrides) => {
    mocks.consumeCodeRpc.mockResolvedValue(codeData(overrides));
    await expectError(await post('token', codeForm()), 400, 'invalid_grant', BINDING);
    expect(mocks.getGrant).not.toHaveBeenCalled();
  });

  it('rejects a DPoP-bound code redeemed with another key', async () => {
    mocks.validateDPoPProof.mockResolvedValue({ valid: true, jkt: 'jkt-2' });
    mocks.consumeCodeRpc.mockResolvedValue(codeData({ dpopJkt: 'jkt-1' }));
    await expectError(
      await post('token', codeForm(), { dpop: 'p' }),
      400,
      'invalid_grant',
      BINDING
    );
  });
});
