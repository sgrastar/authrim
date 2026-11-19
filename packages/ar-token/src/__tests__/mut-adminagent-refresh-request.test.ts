/**
 * Admin Agent refresh_token grant: request shape, client authentication and refresh token
 * verification (src/admin-agent-token.ts handleAdminAgentRefresh).
 */
import {
  anyNumber,
  anything,
  BASE,
  callArg,
  confidentialClient,
  environment,
  expectError,
  ISSUER,
  MCP,
  mocks,
  post,
  refreshForm,
  refreshPayload,
  resetDefaults,
  TOKEN_URL,
} from './helpers/mut-adminagent-setup';
import { beforeEach, describe, expect, it } from 'vitest';

const INVALID_REQUEST = 'Required or supported refresh parameter is invalid';
const CLIENT_FAILED = 'Client authentication failed';
const INVALID_REFRESH = 'Refresh token is invalid or expired';

describe('Admin Agent refresh: request and client authentication', () => {
  beforeEach(() => {
    resetDefaults();
    mocks.verifyToken.mockResolvedValue(refreshPayload());
  });

  it.each([
    ['an unsupported parameter', refreshForm({ unexpected: 'x' })],
    ['a missing refresh_token', refreshForm({ refresh_token: '' })],
    ['a missing client_id', refreshForm({ client_id: '' })],
  ])('rejects %s before loading the client', async (_name, form) => {
    await expectError(await post('token', form), 400, 'invalid_request', INVALID_REQUEST);
    expect(mocks.getClientCached).not.toHaveBeenCalled();
  });

  it('rejects a malformed client identifier', async () => {
    const response = await post('token', refreshForm({ client_id: 'bad client' }));
    await expectError(response, 401, 'invalid_client', CLIENT_FAILED);
    expect(mocks.getClientCached).not.toHaveBeenCalled();
  });

  it('rejects a foreign resource but accepts an omitted one', async () => {
    const foreign = await post('token', refreshForm({ resource: 'https://other.example/mcp' }));
    await expectError(foreign, 400, 'invalid_target', 'resource must identify this MCP endpoint');
    expect(mocks.getClientCached).not.toHaveBeenCalled();

    const { resource: _omitted, ...withoutResource } = refreshForm();
    const ok = await post('token', withoutResource);
    expect(ok.status).toBe(200);
  });

  it('normalises a trailing slash on the request issuer', async () => {
    mocks.buildRequestIssuerUrl.mockReturnValue(`${BASE}/`);
    const response = await post('token', refreshForm());
    expect(response.status).toBe(200);
    expect(mocks.verifyToken).toHaveBeenCalledWith('signed-refresh-token', {}, ISSUER, {
      audience: 'mcp-client',
    });
  });

  it('rejects an unknown client', async () => {
    mocks.getClientCached.mockResolvedValue(null);
    await expectError(await post('token', refreshForm()), 401, 'invalid_client', CLIENT_FAILED);
  });

  it('rejects an expired self-service client but accepts an unexpired one', async () => {
    mocks.getClientCached.mockResolvedValue({
      ...confidentialClient(),
      token_endpoint_auth_method: 'none',
      agent_access_registration_mode: 'self_service',
      agent_access_expires_at: Date.now() - 1,
    });
    await expectError(await post('token', refreshForm()), 401, 'invalid_client', CLIENT_FAILED);
    expect(mocks.verifyToken).not.toHaveBeenCalled();

    mocks.getClientCached.mockResolvedValue({
      ...confidentialClient(),
      token_endpoint_auth_method: 'none',
      agent_access_registration_mode: 'self_service',
      agent_access_expires_at: Date.now() + 60_000,
    });
    expect((await post('token', refreshForm())).status).toBe(200);
    expect(mocks.coreExecute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE oauth_clients'),
      [anyNumber(), anyNumber(), 'tenant-1', 'mcp-client']
    );
  });

  it('rejects a self-service client without an expiry', async () => {
    mocks.getClientCached.mockResolvedValue({
      ...confidentialClient(),
      token_endpoint_auth_method: 'none',
      agent_access_registration_mode: 'self_service',
    });
    await expectError(await post('token', refreshForm()), 401, 'invalid_client', CLIENT_FAILED);
  });

  it('returns the client authentication parse error for a malformed Basic header', async () => {
    const response = await post('token', refreshForm(), { authorization: 'Basic !!!' });
    await expectError(response, 401, 'invalid_client', 'Invalid Authorization header format');
  });

  it('rejects a public client that presents client credentials', async () => {
    const response = await post('token', refreshForm({ client_secret: 'secret' }));
    await expectError(response, 401, 'invalid_client', CLIENT_FAILED);
    expect(mocks.authenticateConfidentialOAuthClient).not.toHaveBeenCalled();
  });

  it('authenticates a confidential client against the Admin Agent token endpoint', async () => {
    mocks.getClientCached.mockResolvedValue(confidentialClient());
    const response = await post('token', refreshForm({ client_secret: 'secret' }));
    expect(response.status).toBe(200);
    expect(mocks.authenticateConfidentialOAuthClient).toHaveBeenCalledWith(
      expect.objectContaining({ client_id: 'mcp-client' }),
      TOKEN_URL,
      expect.objectContaining({ clientId: 'mcp-client', clientSecret: 'secret' }),
      { replayProtection: { env: anything(), tenantId: 'tenant-1' } }
    );
  });

  it('accepts a private_key_jwt assertion pair as refresh parameters', async () => {
    mocks.getClientCached.mockResolvedValue({
      ...confidentialClient(),
      token_endpoint_auth_method: 'private_key_jwt',
    });
    const response = await post(
      'token',
      refreshForm({
        client_assertion: 'header.payload.signature',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        scope: 'agent:read',
      })
    );
    expect(response.status).toBe(200);
    expect(mocks.authenticateConfidentialOAuthClient).toHaveBeenCalledWith(
      anything(),
      TOKEN_URL,
      expect.objectContaining({ clientAssertion: 'header.payload.signature' }),
      anything()
    );
  });

  it('propagates the confidential authentication error', async () => {
    mocks.getClientCached.mockResolvedValue(confidentialClient());
    mocks.authenticateConfidentialOAuthClient.mockResolvedValue({
      ok: false,
      error: 'invalid_client',
      errorDescription: 'Client secret mismatch',
    });
    const response = await post('token', refreshForm({ client_secret: 'wrong' }));
    await expectError(response, 401, 'invalid_client', 'Client secret mismatch');
    expect(mocks.verifyToken).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-RS256 algorithm', { alg: 'HS256', typ: 'JWT', kid: 'kid-1' }],
    ['a non-JWT type', { alg: 'RS256', typ: 'at+jwt', kid: 'kid-1' }],
    ['a missing key id', { alg: 'RS256', typ: 'JWT' }],
  ])('rejects a refresh token header with %s', async (_name, header) => {
    mocks.parseTokenHeader.mockReturnValue(header);
    await expectError(await post('token', refreshForm()), 400, 'invalid_grant', INVALID_REFRESH);
    expect(mocks.getPublicKeyByKid).not.toHaveBeenCalled();
  });

  it('rejects a refresh token whose signing key is unavailable', async () => {
    mocks.getPublicKeyByKid.mockResolvedValue(null);
    await expectError(await post('token', refreshForm()), 400, 'invalid_grant', INVALID_REFRESH);
    expect(mocks.getPublicKeyByKid).toHaveBeenCalledWith(anything(), 'tenant-1', 'kid-1');
    expect(mocks.verifyToken).not.toHaveBeenCalled();
  });

  it('rejects verified claims that are not an object', async () => {
    mocks.verifyToken.mockResolvedValue('claims');
    await expectError(await post('token', refreshForm()), 400, 'invalid_grant', INVALID_REFRESH);
  });

  it('rejects a refresh token that fails verification', async () => {
    mocks.verifyToken.mockRejectedValue(new Error('expired'));
    await expectError(await post('token', refreshForm()), 400, 'invalid_grant', INVALID_REFRESH);
  });

  const BINDING = 'Refresh token binding is invalid';
  it.each([
    ['a non-admin subject', { sub: 'user:admin-1' }],
    ['a missing family', { agent_family_id: undefined }],
    ['an empty family', { agent_family_id: '' }],
    ['a missing grant', { grant_id: undefined }],
    ['another client', { client_id: 'other-client' }],
    ['another tenant', { tenant_id: 'tenant-2' }],
    ['another resource', { resource_aud: 'https://other.example/mcp' }],
    ['a missing scope', { scope: undefined }],
    ['a missing jti', { jti: undefined }],
    ['a non-integer generation', { grant_generation: '3' }],
    ['a non-integer consent version', { consent_version: 2.5 }],
    ['a non-integer rotation version', { rtv: undefined }],
  ])('rejects a refresh token with %s', async (_name, overrides) => {
    mocks.verifyToken.mockResolvedValue(refreshPayload(overrides));
    await expectError(await post('token', refreshForm()), 400, 'invalid_grant', BINDING);
    expect(mocks.getGrant).not.toHaveBeenCalled();
  });

  it('defaults a missing tenant claim to the request tenant', async () => {
    mocks.verifyToken.mockResolvedValue(refreshPayload({ tenant_id: undefined }));
    expect((await post('token', refreshForm())).status).toBe(200);
  });

  it('rejects malformed authorization_details in the refresh token', async () => {
    mocks.verifyToken.mockResolvedValue(
      refreshPayload({ authorization_details: [{ type: 'other' }] })
    );
    await expectError(
      await post('token', refreshForm()),
      400,
      'invalid_grant',
      'Refresh token authorization_details is invalid'
    );
  });

  it('accepts authorization_details serialized as a JSON string', async () => {
    const details = [{ type: 'authrim_admin_agent', max_subjects_per_call: 3 }];
    mocks.verifyToken.mockResolvedValue(
      refreshPayload({ authorization_details: JSON.stringify(details) })
    );
    const response = await post('token', refreshForm());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ authorization_details: details });
  });

  it('rejects a requested scope outside the original grant', async () => {
    mocks.verifyToken.mockResolvedValue(refreshPayload({ scope: 'agent:read' }));
    const response = await post('token', refreshForm({ scope: 'agent:read agent:write' }));
    await expectError(response, 400, 'invalid_scope', 'Requested scope exceeds the original grant');
    expect(mocks.getGrant).not.toHaveBeenCalled();
  });

  it('narrows the scope when a subset is requested', async () => {
    const response = await post('token', refreshForm({ scope: '  agent:read  ' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scope: '  agent:read  ' });
    expect(mocks.rotateRpc).toHaveBeenCalledWith(
      expect.objectContaining({ requestedScope: '  agent:read  ' })
    );
    expect(callArg<unknown>(mocks.createAccessToken, 0)).toMatchObject({ aud: MCP });
  });

  it('uses the configured Agent settings binding for the token lifetime', async () => {
    const settings = {
      get: async () =>
        JSON.stringify({ 'agent.mcp.enabled': true, 'agent.mcp.max_token_ttl_seconds': 120 }),
    };
    const response = await post(
      'token',
      refreshForm(),
      {},
      environment({ SETTINGS: settings as never })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ expires_in: 120 });
  });
});
