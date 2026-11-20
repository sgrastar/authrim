import { beforeEach, describe, expect, it, vi } from 'vitest';

const fx = await vi.hoisted(async () =>
  (await import('./helpers/mut-admin-agent-oauth-fixture')).createAgentOAuthFixture()
);

vi.mock('@authrim/ar-agent-access/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-agent-access/core')>();
  return {
    ...actual,
    resolveSelfServiceAgentAccessSnapshot: fx.resolveSnapshot,
    AdminAgentAccessRepository: class {
      findActiveGrantForDelegatorClient = fx.findActiveGrantForDelegatorClient;
      getGrantRecord = fx.getGrantRecord;
      getSystemManagedTaskSetCatalogVersion = fx.getSystemManagedTaskSetCatalogVersion;
      grantConsentPair = fx.grantConsentPair;
      createSelfServiceAuthorization = fx.createSelfServiceAuthorization;
      replaceSelfServiceAuthorization = fx.replaceSelfServiceAuthorization;
      suspendForClientMetadataChange = fx.suspendForClientMetadataChange;
    },
  };
});
vi.mock('@authrim/ar-agent-access/platform/cloudflare/admin-agent-audit-writer', () => ({
  createCloudflareAdminAgentAuditWriter: vi.fn(() => ({})),
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getClientCached: fx.getClientCached,
    getPARRequestStoreByUri: fx.getPARRequestStoreByUri,
    getPARRequestStoreForNewRequest: fx.getPARRequestStoreForNewRequest,
    getTenantIdFromContext: vi.fn(() => 'tenant-1'),
    safeFetchJson: fx.safeFetchJson,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: { execute: fx.coreExecute } })),
    ClientRepository: class {
      create = fx.clientCreate;
    },
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({})),
    authenticateConfidentialOAuthClient: fx.authenticateConfidentialOAuthClient,
    resolvePlatformSettingsWithSources: fx.resolvePlatformSettingsWithSources,
  };
});
vi.mock('../issuer', () => ({ getRequestIssuer: vi.fn(() => fx.issuer) }));

import { adminAgentAuthorizeHandler, adminAgentParHandler } from '../admin-agent-oauth';
import {
  agentApp,
  CHALLENGE,
  codeStoreEnv,
  ISSUER,
  managedGrant,
  parRecord,
  REQUEST_URI,
  RESOURCE,
  resetAgentOAuthFixture,
} from './helpers/mut-admin-agent-oauth-fixture';

const app = agentApp(fx, { par: adminAgentParHandler, authorize: adminAgentAuthorizeHandler });

beforeEach(() => resetAgentOAuthFixture(fx));

const env = { ENABLE_AGENT_MCP: 'true', DB_ADMIN: {} };

async function consent(headers: Record<string, string> = {}) {
  const qs = new URLSearchParams({ request_uri: REQUEST_URI, client_id: 'mcp-client' });
  const response = await app.fetch(
    new Request(`${ISSUER}/oauth/admin-agent/authorize?${qs.toString()}`, { headers }),
    env
  );
  const type = response.headers.get('content-type') ?? '';
  return {
    status: response.status,
    headers: response.headers,
    body: type.includes('json') ? JSON.stringify(await response.json()) : await response.text(),
  };
}

function scopeInput(html: string, name: string): string | undefined {
  return new RegExp(`<input class="scope-checkbox"[^>]*name="${name}"[^>]*>`, 'u').exec(html)?.[0];
}

describe('consent page', () => {
  it('renders self-service scopes with only agent:read required and escapes the client name', async () => {
    fx.getRequestRpc.mockResolvedValue(
      parRecord({ scope: 'agent:read agent:user-data:read agent:write' })
    );
    const { status, headers, body } = await consent();
    expect(status).toBe(200);
    expect(body).toContain('MCP &lt;Client&gt; is requesting permission');
    expect(body).not.toContain('MCP <Client>');
    expect(scopeInput(body, 'scope_read')).toContain('checked disabled');
    expect(scopeInput(body, 'scope_user_data_read')).not.toContain('checked');
    expect(scopeInput(body, 'scope_write')).not.toContain('checked');
    expect(body).toContain('<input type="hidden" name="scope_read" value="agent:read">');
    expect(body).not.toContain('<input type="hidden" name="scope_write"');
    expect(body).toContain('<span class="scope-status">Optional</span>');
    expect(body).toContain('id="agent-scope-2"');
    expect(body).toContain('aria-describedby="agent-scope-1-description"');
    expect(body).toContain(`<input type="hidden" name="request_uri" value="${REQUEST_URI}">`);
    expect(body).toContain('<dd>tenant-1</dd>');
    expect(body).toContain('50 resources');
    expect(headers.get('cache-control')).toBe('no-store');
    expect(headers.get('content-security-policy')).toMatch(
      /^default-src 'none'; style-src 'nonce-[A-Za-z0-9_-]{32}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'$/u
    );
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('strict-transport-security')).toBe(
      'max-age=63072000; includeSubDomains; preload'
    );
    expect(headers.get('cross-origin-opener-policy')).toBe('same-origin');
  });

  it('uses the client_id when the client has no name', async () => {
    fx.getClientCached.mockResolvedValue({
      client_id: 'mcp-client',
      redirect_uris: ['https://client.example.com/callback'],
      requestable_scopes: ['agent:read'],
    });
    expect((await consent()).body).toContain('mcp-client is requesting permission');
  });

  it('marks every managed scope as required, including advanced ones', async () => {
    fx.getRequestRpc.mockResolvedValue(
      parRecord({ scope: 'agent:read agent:execute agent:admin agent:write' })
    );
    fx.findActiveGrantForDelegatorClient.mockResolvedValue(
      managedGrant({ scopes: ['agent:read', 'agent:execute', 'agent:admin', 'agent:write'] })
    );
    fx.getClientCached.mockResolvedValue({
      client_id: 'mcp-client',
      redirect_uris: ['https://client.example.com/callback'],
      requestable_scopes: ['agent:read', 'agent:execute', 'agent:admin', 'agent:write'],
    });
    const { body } = await consent();
    for (const name of ['scope_read', 'scope_execute', 'scope_admin', 'scope_write']) {
      expect(scopeInput(body, name)).toContain('checked disabled');
    }
    expect(body).toContain(
      'An advanced Agent scope assigned to this connection by an administrator.'
    );
    expect(body).toContain('<strong>agent:admin</strong>');
    expect(body).toContain('20 resources');
  });

  it('reports invalid self-service scopes', async () => {
    fx.findActiveGrantForDelegatorClient.mockResolvedValue(
      managedGrant({ scopes: ['agent:write'] })
    );
    fx.getGrantRecord.mockResolvedValue({ purpose: 'interactive_self_service' });
    fx.getRequestRpc.mockResolvedValue(parRecord({ scope: 'agent:write' }));
    expect(JSON.parse((await consent()).body)).toEqual({
      error: 'invalid_scope',
      error_description: 'Agent scopes are invalid',
    });
  });

  it('reports stored authorization_details outside the contract', async () => {
    fx.getRequestRpc.mockResolvedValue(parRecord({ authorization_details: '[{"type":"x"}]' }));
    expect(JSON.parse((await consent()).body)).toEqual({
      error: 'invalid_authorization_details',
      error_description: 'Stored authorization_details is outside the Admin Agent contract',
    });
  });

  it.each([
    [
      'request only',
      '[{"type":"authrim_admin_agent","max_subjects_per_call":7}]',
      undefined,
      '7 resources',
    ],
    [
      'the narrower grant',
      '[{"type":"authrim_admin_agent","max_subjects_per_call":30}]',
      20,
      '20 resources',
    ],
    [
      'the narrower request',
      '[{"type":"authrim_admin_agent","max_subjects_per_call":5}]',
      20,
      '5 resources',
    ],
  ])('shows the per-call maximum from %s', async (_label, details, grantMax, expected) => {
    fx.getRequestRpc.mockResolvedValue(parRecord({ authorization_details: details }));
    if (grantMax !== undefined) {
      fx.findActiveGrantForDelegatorClient.mockResolvedValue(
        managedGrant({ resolvedScopeConstraints: { maxPerCall: grantMax } })
      );
    }
    expect((await consent()).body).toContain(expected);
  });

  it('omits the maximum for a managed grant without one', async () => {
    fx.findActiveGrantForDelegatorClient.mockResolvedValue(
      managedGrant({ resolvedScopeConstraints: {} })
    );
    expect((await consent()).body).not.toContain('Per-operation limit');
  });

  it.each([
    [undefined, 'en'],
    ['ja', 'ja'],
    ['en-GB;q=0.5, ja-JP;q=0.9', 'ja'],
    ['ja;q=0, en;q=0.1', 'en'],
    ['ja;q=abc, en', 'en'],
    ['fr, de', 'en'],
    ['fr;q=1, ja;q=0.5, en;q=0.5', 'ja'],
  ])('negotiates Accept-Language %s as %s', async (acceptLanguage, locale) => {
    const result = await consent(
      acceptLanguage === undefined ? {} : { 'accept-language': acceptLanguage }
    );
    expect(result.headers.get('content-language')).toBe(locale);
    expect(result.body).toContain(`<html lang="${locale}">`);
  });
});

describe('consent decision', () => {
  async function decide(fields: Record<string, string>, e: Record<string, unknown> = env) {
    const response = await app.fetch(
      new Request(`${ISSUER}/oauth/admin-agent/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-request-id': 'req-1' },
        body: new URLSearchParams({ request_uri: REQUEST_URI, client_id: 'mcp-client', ...fields }),
      }),
      e
    );
    const text = await response.text();
    return {
      status: response.status,
      location: response.headers.get('location'),
      body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
    };
  }

  it.each([[{}], [{ decision: 'maybe' }]])('requires a valid decision %j', async (fields) => {
    expect((await decide(fields)).body).toEqual({
      error: 'invalid_request',
      error_description: 'A valid consent decision is required',
    });
    expect(fx.consumeRequestRpc).not.toHaveBeenCalled();
  });

  it('rejects a request that cannot be consumed', async () => {
    fx.consumeRequestRpc.mockRejectedValue(new Error('consumed'));
    expect((await decide({ decision: 'approve' })).body).toEqual({
      error: 'invalid_request_uri',
      error_description: 'Invalid or expired request_uri',
    });
  });

  it('redirects a denial with iss and state after consuming it', async () => {
    const result = await decide({ decision: 'deny' });
    const location = new URL(result.location!);
    expect(`${location.origin}${location.pathname}`).toBe('https://client.example.com/callback');
    expect(Object.fromEntries(location.searchParams)).toEqual({
      error: 'access_denied',
      iss: `${ISSUER}/oauth/admin-agent`,
      state: 'opaque-state',
    });
    expect(fx.consumeRequestRpc).toHaveBeenCalledWith({
      requestUri: REQUEST_URI,
      tenant_id: 'tenant-1',
      client_id: 'mcp-client',
      expected_authorization_server: 'admin_agent',
      expected_resource: RESOURCE,
    });
  });

  it('omits state from the redirect when the request had none', async () => {
    fx.getRequestRpc.mockResolvedValue(parRecord({ state: undefined }));
    const result = await decide({ decision: 'deny' });
    expect(new URL(result.location!).searchParams.has('state')).toBe(false);
  });

  it('reports invalid managed scopes and stored RAR on approval', async () => {
    fx.findActiveGrantForDelegatorClient.mockResolvedValue(managedGrant());
    fx.consumeRequestRpc.mockResolvedValueOnce(parRecord({ scope: 'openid' }));
    expect((await decide({ decision: 'approve' })).body).toEqual({
      error: 'invalid_scope',
      error_description: 'Approved Agent scopes are invalid',
    });
    fx.consumeRequestRpc.mockResolvedValueOnce(parRecord({ scope: '' }));
    expect((await decide({ decision: 'approve' })).body).toMatchObject({ error: 'invalid_scope' });
    fx.consumeRequestRpc.mockResolvedValueOnce(parRecord({ authorization_details: 'nope' }));
    expect((await decide({ decision: 'approve' })).body).toEqual({
      error: 'invalid_authorization_details',
      error_description: 'Stored authorization_details is outside the Admin Agent contract',
    });
  });

  it('refuses managed scopes that exceed the grant', async () => {
    fx.findActiveGrantForDelegatorClient.mockResolvedValue(managedGrant());
    fx.consumeRequestRpc.mockResolvedValueOnce(parRecord({ scope: 'agent:read agent:write' }));
    expect((await decide({ decision: 'approve' })).body).toEqual({
      error: 'invalid_scope',
      error_description: 'Approved scopes exceed the active Agent Grant',
    });
    expect(fx.grantConsentPair).not.toHaveBeenCalled();
  });

  it('records the consent pair for a managed grant and issues a bound code', async () => {
    fx.findActiveGrantForDelegatorClient.mockResolvedValue(managedGrant());
    fx.resolvePlatformSettingsWithSources.mockResolvedValue({
      values: { 'oauth.auth_code_ttl': 90, 'oauth.max_codes_per_user': '5' },
    });
    const codeStore = codeStoreEnv(fx);
    const result = await decide({ decision: 'approve' }, { ...env, AUTH_CODE_STORE: codeStore });
    expect(result.status).toBe(302);
    const location = new URL(result.location!);
    const code = location.searchParams.get('code')!;
    expect(code).toMatch(/^aac_[A-Za-z0-9_-]{64}$/u);
    expect(location.searchParams.get('iss')).toBe(`${ISSUER}/oauth/admin-agent`);
    expect(codeStore.idFromName.mock.calls[0][0]).toContain('admin-agent-auth-code');
    expect(codeStore.idFromName.mock.calls[0][0]).toContain('tenant-1');
    expect(fx.grantConsentPair.mock.calls[0][0]).toMatchObject({
      delegation: {
        type: 'delegation',
        tenantId: 'tenant-1',
        grantId: 'grant-1',
        userId: 'admin-1',
        clientId: 'mcp-client',
        consentVersion: 2,
        scopes: ['agent:read'],
      },
      oauthClient: { type: 'oauth_client', consentVersion: 2 },
      audit: {
        tenantId: 'tenant-1',
        adminUserId: 'admin-1',
        action: 'agent.consent.granted',
        resourceType: 'admin_agent_grant',
        resourceId: 'grant-1',
        severity: 'info',
        requestId: 'req-1',
        actorType: 'admin_user',
        actorSub: 'admin_user:admin-1',
        grantId: 'grant-1',
        metadata: {
          grant_id: 'grant-1',
          client_id: 'mcp-client',
          consent_version: 2,
          scopes: ['agent:read'],
        },
      },
    });
    expect(fx.storeCodeRpc).toHaveBeenCalledWith({
      code,
      tenantId: 'tenant-1',
      clientId: 'mcp-client',
      ttlSeconds: 90,
      maxCodesPerUser: undefined,
      redirectUri: 'https://client.example.com/callback',
      userId: 'admin_user:admin-1',
      scope: 'agent:read',
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
      state: 'opaque-state',
      authorizationDetails: undefined,
      authorizationServer: 'admin_agent',
      subjectType: 'admin_user',
      resource: RESOURCE,
      agentGrantId: 'grant-1',
      agentGrantGeneration: 3,
      agentConsentVersion: 2,
    });
    expect(fx.resolvePlatformSettingsWithSources.mock.calls[0].slice(1)).toEqual(['oauth', {}]);
  });

  it('reports a code store failure', async () => {
    fx.findActiveGrantForDelegatorClient.mockResolvedValue(managedGrant());
    fx.storeCodeRpc.mockRejectedValue(new Error('do'));
    const result = await decide(
      { decision: 'approve' },
      { ...env, AUTH_CODE_STORE: codeStoreEnv(fx) }
    );
    expect(result).toMatchObject({
      status: 500,
      body: { error: 'server_error', error_description: 'Failed to issue authorization code' },
    });
  });
});
