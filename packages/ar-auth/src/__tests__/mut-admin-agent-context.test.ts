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
  ISSUER,
  managedGrant,
  parRecord,
  REQUEST_URI,
  resetAgentOAuthFixture,
} from './helpers/mut-admin-agent-oauth-fixture';

const app = agentApp(fx, { par: adminAgentParHandler, authorize: adminAgentAuthorizeHandler });

beforeEach(() => resetAgentOAuthFixture(fx));
import { canonicalizeJson, sha256Base64Url } from '@authrim/ar-agent-access/core';

const CIMD = 'https://client.example.com/cimd.json';
const env = { ENABLE_AGENT_MCP: 'true', PAR_REQUEST_STORE: {}, DB_ADMIN: {} };

async function consent(clientId = 'mcp-client', headers: Record<string, string> = {}) {
  const qs = new URLSearchParams({ request_uri: REQUEST_URI, client_id: clientId });
  const response = await app.fetch(
    new Request(`${ISSUER}/oauth/admin-agent/authorize?${qs.toString()}`, { headers }),
    env
  );
  const type = response.headers.get('content-type') ?? '';
  return {
    status: response.status,
    headers: response.headers,
    body: (type.includes('json') ? await response.json() : await response.text()) as never,
  };
}

const cimdDocument = {
  client_id: CIMD,
  client_name: 'Claude Code',
  redirect_uris: ['http://localhost/callback'],
};
async function cimdHash(): Promise<string> {
  return sha256Base64Url(
    canonicalizeJson({
      ...cimdDocument,
      redirect_uris: [...cimdDocument.redirect_uris],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'agent:read agent:user-data:read agent:write',
      dpop_bound_access_tokens: false,
    })
  );
}

describe('authorization context', () => {
  it('requires request_uri and client_id on POST', async () => {
    const response = await app.fetch(
      new Request(`${ISSUER}/oauth/admin-agent/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ request_uri: REQUEST_URI }),
      }),
      env
    );
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'request_uri and client_id are required',
    });
    const missingClient = await app.fetch(
      new Request(
        `${ISSUER}/oauth/admin-agent/authorize?request_uri=${encodeURIComponent(REQUEST_URI)}`
      ),
      env
    );
    expect(missingClient.status).toBe(400);
  });

  it.each([
    ['no admin session', null],
    [
      'a token-authenticated admin',
      { userId: 'admin-1', authMethod: 'bearer', permissions: ['admin:*'] },
    ],
  ])('requires a human admin session (%s)', async (_label, auth) => {
    fx.adminAuth = auth;
    expect(await consent()).toMatchObject({
      status: 401,
      body: { error: 'access_denied', error_description: 'A human admin session is required' },
    });
    expect(fx.getPARRequestStoreByUri).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a store failure',
      () =>
        fx.getPARRequestStoreByUri.mockImplementation(() => {
          throw new Error('bad uri');
        }),
    ],
    ['a missing request', () => fx.getRequestRpc.mockResolvedValue(null)],
    ['a consumed request', () => fx.getRequestRpc.mockResolvedValue(parRecord({ consumed: true }))],
    [
      'another authorization server',
      () => fx.getRequestRpc.mockResolvedValue(parRecord({ authorization_server: 'oidc' })),
    ],
    [
      'another tenant',
      () => fx.getRequestRpc.mockResolvedValue(parRecord({ tenant_id: 'tenant-2' })),
    ],
    ['another client', () => fx.getRequestRpc.mockResolvedValue(parRecord({ client_id: 'other' }))],
    [
      'another resource',
      () => fx.getRequestRpc.mockResolvedValue(parRecord({ resource: `${ISSUER}/other` })),
    ],
  ])('rejects %s as invalid_request_uri', async (_label, arrange) => {
    arrange();
    expect(await consent()).toMatchObject({
      status: 400,
      body: { error: 'invalid_request_uri', error_description: 'Invalid or expired request_uri' },
    });
  });

  it('looks the request up in the tenant store', async () => {
    await consent();
    expect(fx.getPARRequestStoreByUri.mock.calls[0].slice(1)).toEqual([REQUEST_URI, 'tenant-1']);
    expect(fx.getRequestRpc).toHaveBeenCalledWith(REQUEST_URI);
  });

  it.each([
    ['an unknown client', null],
    [
      'an expired registration',
      {
        redirect_uris: ['https://client.example.com/callback'],
        requestable_scopes: ['agent:read'],
        agent_access_registration_mode: 'manual',
        agent_access_expires_at: Date.now() - 1,
      },
    ],
    [
      'a registration without expiry',
      {
        redirect_uris: ['https://client.example.com/callback'],
        requestable_scopes: ['agent:read'],
        agent_access_registration_mode: 'manual',
      },
    ],
    [
      'an unregistered redirect',
      { redirect_uris: ['https://client.example.com/other'], requestable_scopes: ['agent:read'] },
    ],
    [
      'no requestable scopes',
      { redirect_uris: ['https://client.example.com/callback'], requestable_scopes: [] },
    ],
  ])('rejects %s as unauthorized_client', async (_label, client) => {
    fx.getClientCached.mockResolvedValue(client && { client_id: 'mcp-client', ...client });
    expect(await consent()).toMatchObject({
      status: 400,
      body: {
        error: 'unauthorized_client',
        error_description: 'Client is not authorized for Agent access',
      },
    });
  });

  it('accepts a registration mode with a future expiry', async () => {
    fx.getClientCached.mockResolvedValue({
      client_id: 'mcp-client',
      redirect_uris: ['https://client.example.com/callback'],
      requestable_scopes: ['agent:read'],
      agent_access_registration_mode: 'manual',
      agent_access_expires_at: Date.now() + 60_000,
    });
    expect((await consent()).status).toBe(200);
  });

  it.each([
    ['an inactive grant', { status: 'suspended' }],
    ['an expired grant', { expiresAt: Date.now() - 1 }],
    ['another tenant grant', { tenantId: 'tenant-2' }],
    ['another client grant', { clientId: 'other' }],
    ['another delegator', { delegatorId: 'admin-2' }],
    ['a scope outside the grant', { scopes: ['agent:write'] }],
  ])('refuses %s', async (_label, overrides) => {
    fx.findActiveGrantForDelegatorClient.mockResolvedValue(managedGrant(overrides));
    fx.getGrantRecord.mockResolvedValue({ purpose: 'managed' });
    expect(await consent()).toMatchObject({
      status: 403,
      body: {
        error: 'access_denied',
        error_description: 'No active Agent Grant allows this request',
      },
    });
  });

  it('refuses a managed grant whose permission the admin lost', async () => {
    fx.adminAuth = {
      userId: 'admin-1',
      authMethod: 'session',
      permissions: ['admin:clients:read'],
    };
    fx.findActiveGrantForDelegatorClient.mockResolvedValue(managedGrant());
    expect((await consent()).status).toBe(403);
    fx.adminAuth = { userId: 'admin-1', authMethod: 'session' };
    expect((await consent()).status).toBe(403);
  });

  it('refuses a managed grant scope the client may not request', async () => {
    fx.getClientCached.mockResolvedValue({
      client_id: 'mcp-client',
      redirect_uris: ['https://client.example.com/callback'],
      requestable_scopes: ['agent:write'],
    });
    fx.getRequestRpc.mockResolvedValue(parRecord({ scope: 'agent:read' }));
    fx.findActiveGrantForDelegatorClient.mockResolvedValue(managedGrant());
    expect((await consent()).status).toBe(403);
  });

  it('allows a managed grant with a future expiry', async () => {
    fx.findActiveGrantForDelegatorClient.mockResolvedValue(
      managedGrant({ expiresAt: Date.now() + 60_000 })
    );
    expect((await consent()).status).toBe(200);
    expect(fx.getGrantRecord).toHaveBeenCalledWith('tenant-1', 'grant-1');
    expect(fx.getSystemManagedTaskSetCatalogVersion).not.toHaveBeenCalled();
  });

  it('requires a managed grant for advanced scopes', async () => {
    fx.getRequestRpc.mockResolvedValue(parRecord({ scope: 'agent:read agent:admin' }));
    expect(await consent()).toMatchObject({
      status: 403,
      body: {
        error: 'invalid_scope',
        error_description: 'Advanced Agent scopes require a managed Grant',
      },
    });
  });

  it('reads the catalog version only for a self-service grant with a task set', async () => {
    fx.findActiveGrantForDelegatorClient.mockResolvedValue(
      managedGrant({ taskSetId: 'ts', taskSetVersion: 2 })
    );
    fx.getGrantRecord.mockResolvedValue({ purpose: 'interactive_self_service' });
    expect((await consent()).status).toBe(200);
    expect(fx.getSystemManagedTaskSetCatalogVersion).toHaveBeenCalledWith('tenant-1', 'ts', 2);
    fx.findActiveGrantForDelegatorClient.mockResolvedValue(managedGrant({ taskSetId: 'ts' }));
    fx.getSystemManagedTaskSetCatalogVersion.mockClear();
    await consent();
    expect(fx.getSystemManagedTaskSetCatalogVersion).not.toHaveBeenCalled();
  });
});

describe('existing CIMD registrations', () => {
  beforeEach(() => {
    fx.getRequestRpc.mockResolvedValue(
      parRecord({ client_id: CIMD, redirect_uri: 'http://localhost:4000/callback' })
    );
    fx.safeFetchJson.mockResolvedValue(cimdDocument);
  });

  it('suspends access and records the new hash when the document changed', async () => {
    fx.getClientCached.mockResolvedValue({
      client_id: CIMD,
      agent_access_registration_mode: 'cimd',
      client_metadata_hash: 'old-hash',
      updated_at: 9_999_999_999_999,
      agent_access_expires_at: Date.now() + 60_000,
      redirect_uris: ['http://localhost/callback'],
      requestable_scopes: ['agent:read'],
    });
    const result = await consent(CIMD);
    expect(result.body).toMatchObject({ error: 'unauthorized_client' });
    const hash = await cimdHash();
    expect(fx.suspendForClientMetadataChange).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        clientId: CIMD,
        oldHash: 'old-hash',
        newHash: hash,
      })
    );
    const input = fx.suspendForClientMetadataChange.mock.calls[0][0];
    expect(input.transitionId).toMatch(/^transition_/);
    expect(input.outboxId).toMatch(/^outbox_/);
    const [sql, params] = fx.coreExecute.mock.calls[0];
    expect(sql).toContain('agent_access_expires_at = 0');
    expect(params).toEqual([
      hash,
      input.now,
      10_000_000_000_000,
      'tenant-1',
      CIMD,
      9_999_999_999_999,
    ]);
  });

  it('labels a registration without a stored hash as missing', async () => {
    fx.getClientCached.mockResolvedValue({
      client_id: CIMD,
      agent_access_registration_mode: 'cimd',
      updated_at: 1,
      redirect_uris: [],
    });
    await consent(CIMD);
    expect(fx.suspendForClientMetadataChange.mock.calls[0][0].oldHash).toBe('missing');
    expect(fx.coreExecute.mock.calls[0][1][2]).toBe(fx.coreExecute.mock.calls[0][1][1]);
  });

  it('refuses when the document can no longer be fetched', async () => {
    fx.getClientCached.mockResolvedValue({
      client_id: CIMD,
      agent_access_registration_mode: 'cimd',
    });
    fx.safeFetchJson.mockRejectedValue(new Error('offline'));
    expect((await consent(CIMD)).body).toMatchObject({ error: 'unauthorized_client' });
    expect(fx.suspendForClientMetadataChange).not.toHaveBeenCalled();
  });

  it.each([[undefined], [1]])(
    'reactivates an unchanged registration whose access lapsed (%s)',
    async (expiresAt) => {
      const hash = await cimdHash();
      fx.getClientCached.mockResolvedValue({
        client_id: CIMD,
        agent_access_registration_mode: 'cimd',
        client_metadata_hash: hash,
        agent_access_expires_at: expiresAt,
        redirect_uris: ['http://localhost/callback'],
        requestable_scopes: ['agent:read'],
      });
      expect((await consent(CIMD)).status).toBe(200);
      const [sql, params] = fx.coreExecute.mock.calls[0];
      expect(sql).toContain("agent_access_registration_mode = 'cimd' AND client_metadata_hash = ?");
      expect(Number(params[0]) - Number(params[1])).toBe(30 * 24 * 60 * 60 * 1000);
      expect(params.slice(2)).toEqual(['tenant-1', CIMD, hash]);
      fx.coreExecute.mockResolvedValueOnce({ rowsAffected: 0 });
      expect((await consent(CIMD)).body).toMatchObject({ error: 'unauthorized_client' });
    }
  );

  it('uses an unchanged, active registration as is', async () => {
    fx.getClientCached.mockResolvedValue({
      client_id: CIMD,
      agent_access_registration_mode: 'cimd',
      client_metadata_hash: await cimdHash(),
      agent_access_expires_at: Date.now() + 60_000,
      redirect_uris: ['http://localhost/callback'],
      requestable_scopes: ['agent:read'],
    });
    expect((await consent(CIMD)).status).toBe(200);
    expect(fx.coreExecute).not.toHaveBeenCalled();
  });
});
