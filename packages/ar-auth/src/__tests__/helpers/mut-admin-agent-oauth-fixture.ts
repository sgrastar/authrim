/**
 * Shared doubles for admin-agent-oauth.ts (mut-admin-agent-* tests). Loaded from vi.hoisted, so
 * it must not import mocked modules.
 */
import { Hono } from 'hono';
import { vi } from 'vitest';
import type {
  AdminAgentAccessRepository,
  resolveSelfServiceAgentAccessSnapshot,
} from '@authrim/ar-agent-access/core';
import type { authenticateConfidentialOAuthClient } from '@authrim/ar-lib-core';

type Repo = AdminAgentAccessRepository;
type Loose = Record<string, unknown>;
type RepoFn<K extends keyof Repo> = (
  ...args: Repo[K] extends (...a: infer A) => unknown ? A : never
) => Promise<unknown>;

export const REQUEST_URI = 'urn:ietf:params:oauth:request_uri:g1:apac:0:par_test';
export const ISSUER = 'https://tenant.example.com';
export const RESOURCE = `${ISSUER}/mcp`;
export const CHALLENGE = 'a'.repeat(43);

export function createAgentOAuthFixture() {
  const m = {
    issuer: `${ISSUER}/`,
    getClientCached: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    getPARRequestStoreForNewRequest: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    getPARRequestStoreByUri: vi.fn<(...args: unknown[]) => unknown>(),
    storeRequestRpc:
      vi.fn<(input: { requestUri: string; ttl: number; data: Loose }) => Promise<void>>(),
    getRequestRpc: vi.fn<(requestUri: string) => Promise<unknown>>(),
    consumeRequestRpc: vi.fn<(input: Loose) => Promise<unknown>>(),
    findActiveGrantForDelegatorClient: vi.fn<RepoFn<'findActiveGrantForDelegatorClient'>>(),
    getGrantRecord: vi.fn<RepoFn<'getGrantRecord'>>(),
    getSystemManagedTaskSetCatalogVersion: vi.fn<RepoFn<'getSystemManagedTaskSetCatalogVersion'>>(),
    grantConsentPair: vi.fn<RepoFn<'grantConsentPair'>>(),
    createSelfServiceAuthorization: vi.fn<RepoFn<'createSelfServiceAuthorization'>>(),
    replaceSelfServiceAuthorization: vi.fn<RepoFn<'replaceSelfServiceAuthorization'>>(),
    suspendForClientMetadataChange: vi.fn<RepoFn<'suspendForClientMetadataChange'>>(),
    safeFetchJson: vi.fn<(url: string, options: Loose) => Promise<unknown>>(),
    clientCreate: vi.fn<(input: Loose) => Promise<unknown>>(),
    coreExecute: vi.fn<(sql: string, params: unknown[]) => Promise<unknown>>(),
    storeCodeRpc: vi.fn<(input: Loose) => Promise<void>>(),
    authenticateConfidentialOAuthClient:
      vi.fn<
        (...args: Parameters<typeof authenticateConfidentialOAuthClient>) => Promise<unknown>
      >(),
    resolvePlatformSettingsWithSources: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    resolveSnapshot:
      vi.fn<
        (input: Parameters<typeof resolveSelfServiceAgentAccessSnapshot>[0]) => Promise<unknown>
      >(),
    adminAuth: {
      userId: 'admin-1',
      authMethod: 'session',
      tenantId: 'tenant-1',
      permissions: ['admin:*'],
    } as Record<string, unknown> | null,
  };
  return m;
}

export type AgentOAuthMocks = ReturnType<typeof createAgentOAuthFixture>;

export function parRecord(overrides: Record<string, unknown> = {}) {
  return {
    authorization_server: 'admin_agent',
    tenant_id: 'tenant-1',
    client_id: 'mcp-client',
    redirect_uri: 'https://client.example.com/callback',
    response_type: 'code',
    scope: 'agent:read',
    state: 'opaque-state',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    resource: RESOURCE,
    consumed: false,
    ...overrides,
  };
}

export function managedGrant(overrides: Record<string, unknown> = {}) {
  return {
    grantId: 'grant-1',
    tenantId: 'tenant-1',
    clientId: 'mcp-client',
    grantorId: 'admin-1',
    delegatorId: 'admin-1',
    permissions: ['admin:users:read'],
    scopes: ['agent:read'],
    resolvedScopeConstraints: { tenantIds: ['tenant-1'], maxPerCall: 20 },
    consentVersion: 2,
    generation: 3,
    status: 'active',
    delegationMode: 'user_consent',
    ...overrides,
  };
}

export function snapshot() {
  return {
    taskSetId: 'ts-1',
    taskSetVersion: 1,
    scopePolicyId: 'sp-1',
    scopePolicyVersion: 1,
    resolvedTools: [],
    permissions: ['admin:users:read'],
    scopes: ['agent:read'],
    resolvedScopeConstraints: { tenantIds: ['tenant-1'], maxPerCall: 50 },
    taskSetDigest: 'ts-digest',
    taskSetResolved: { resolved: true },
    scopePolicyDefinition: { def: true },
    scopePolicyDigest: 'sp-digest',
    accessSnapshotHash: 'snap-hash',
  };
}

export function resetAgentOAuthFixture(m: AgentOAuthMocks) {
  vi.clearAllMocks();
  m.issuer = `${ISSUER}/`;
  m.adminAuth = {
    userId: 'admin-1',
    authMethod: 'session',
    tenantId: 'tenant-1',
    permissions: ['admin:*'],
  };
  m.getClientCached.mockResolvedValue({
    client_id: 'mcp-client',
    client_name: 'MCP <Client>',
    redirect_uris: ['https://client.example.com/callback'],
    token_endpoint_auth_method: 'none',
    requestable_scopes: ['agent:read', 'agent:user-data:read', 'agent:write', 'agent:admin'],
  });
  m.clientCreate.mockResolvedValue({ client_id: 'created', updated_at: 1000 });
  m.coreExecute.mockResolvedValue({ rowsAffected: 1 });
  m.getPARRequestStoreForNewRequest.mockResolvedValue({
    stub: { storeRequestRpc: m.storeRequestRpc },
    requestUri: REQUEST_URI,
  });
  m.getRequestRpc.mockResolvedValue(parRecord());
  m.consumeRequestRpc.mockResolvedValue(parRecord());
  m.getPARRequestStoreByUri.mockReturnValue({
    stub: { getRequestRpc: m.getRequestRpc, consumeRequestRpc: m.consumeRequestRpc },
  });
  m.findActiveGrantForDelegatorClient.mockResolvedValue(null);
  m.getGrantRecord.mockResolvedValue(null);
  m.getSystemManagedTaskSetCatalogVersion.mockResolvedValue('catalog-v1');
  m.authenticateConfidentialOAuthClient.mockResolvedValue({ ok: true });
  m.resolvePlatformSettingsWithSources.mockResolvedValue({ values: {} });
  m.resolveSnapshot.mockResolvedValue(snapshot());
}

export function agentApp(
  m: AgentOAuthMocks,
  handlers: {
    par: (c: never) => Promise<Response>;
    authorize: (c: never) => Promise<Response>;
  }
) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (m.adminAuth) c.set('adminAuth' as never, m.adminAuth as never);
    await next();
  });
  app.post('/oauth/admin-agent/par', (c) => handlers.par(c as never));
  app.get('/oauth/admin-agent/authorize', (c) => handlers.authorize(c as never));
  app.post('/oauth/admin-agent/authorize', (c) => handlers.authorize(c as never));
  return app;
}

export function codeStoreEnv(m: AgentOAuthMocks) {
  return {
    idFromName: vi.fn((name: string) => ({ name })),
    get: vi.fn(() => ({ storeCodeRpc: m.storeCodeRpc })),
  };
}
