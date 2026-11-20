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
  codeStoreEnv,
  ISSUER,
  managedGrant,
  parRecord,
  REQUEST_URI,
  resetAgentOAuthFixture,
} from './helpers/mut-admin-agent-oauth-fixture';

const app = agentApp(fx, { par: adminAgentParHandler, authorize: adminAgentAuthorizeHandler });

beforeEach(() => resetAgentOAuthFixture(fx));
import { createAdminToolCatalog } from '@authrim/ar-agent-access/protocol/mcp';
import { SELF_SERVICE_GRANT_TTL_MS } from '@authrim/ar-agent-access/core';
import { snapshot } from './helpers/mut-admin-agent-oauth-fixture';

const env = { ENABLE_AGENT_MCP: 'true', DB_ADMIN: {} };
const RAR = '[{"type":"authrim_admin_agent","max_subjects_per_call":10}]';

async function approve(fields: Record<string, string> = {}) {
  const response = await app.fetch(
    new Request(`${ISSUER}/oauth/admin-agent/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-request-id': 'req-9' },
      body: new URLSearchParams({
        request_uri: REQUEST_URI,
        client_id: 'mcp-client',
        decision: 'approve',
        ...fields,
      }),
    }),
    { ...env, AUTH_CODE_STORE: codeStoreEnv(fx) }
  );
  const text = await response.text();
  return {
    status: response.status,
    location: response.headers.get('location'),
    body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
  };
}

function selfServiceGrant(overrides: Record<string, unknown> = {}) {
  return managedGrant({
    scopes: ['agent:read'],
    expiresAt: Date.now() + 60_000,
    taskSetId: 'ts-old',
    taskSetVersion: 1,
    ...overrides,
  });
}

beforeEach(() => {
  fx.getRequestRpc.mockResolvedValue(
    parRecord({ scope: 'agent:read agent:user-data:read agent:write' })
  );
  fx.consumeRequestRpc.mockResolvedValue(
    parRecord({ scope: 'agent:read agent:user-data:read agent:write', authorization_details: RAR })
  );
});

describe('new self-service grant', () => {
  it('grants only the scopes the admin ticked', async () => {
    const before = Date.now();
    const result = await approve({
      scope_write: 'agent:write',
      scope_user_data_read: 'wrong-value',
    });
    expect(result.status).toBe(302);
    const snapshotInput = fx.resolveSnapshot.mock.calls[0][0];
    expect(snapshotInput).toMatchObject({
      tenantId: 'tenant-1',
      adminUserId: 'admin-1',
      clientId: 'mcp-client',
      approvedScopes: ['agent:read', 'agent:write'],
      authorizationDetails: [{ type: 'authrim_admin_agent', max_subjects_per_call: 10 }],
      adminPermissions: ['admin:*'],
    });
    expect(snapshotInput.grantId).toMatch(/^aag_/);
    expect(snapshotInput.expiresAt - before).toBeGreaterThanOrEqual(SELF_SERVICE_GRANT_TTL_MS);
    expect(snapshotInput.catalog.version).toBe(createAdminToolCatalog().version);

    const input = fx.createSelfServiceAuthorization.mock.calls[0][0];
    const s = snapshot();
    expect(input.grant).toMatchObject({
      grantId: snapshotInput.grantId,
      tenantId: 'tenant-1',
      clientId: 'mcp-client',
      grantorId: 'admin-1',
      delegatorId: 'admin-1',
      permissions: s.permissions,
      scopes: ['agent:read', 'agent:write'],
      authorizationDetails: [{ type: 'authrim_admin_agent', max_subjects_per_call: 10 }],
      resolvedScopeConstraints: s.resolvedScopeConstraints,
      consentVersion: 1,
      generation: 1,
      status: 'active',
      delegationMode: 'user_consent',
      taskSetId: 'ts-1',
      scopePolicyId: 'sp-1',
      accessSnapshotHash: 'snap-hash',
      expiresAt: snapshotInput.expiresAt,
      purpose: 'interactive_self_service',
      managementMode: 'system_managed',
    });
    expect(input.taskSet).toEqual({
      id: 'ts-1',
      version: 1,
      digest: 'ts-digest',
      resolved: s.taskSetResolved,
    });
    expect(input.scopePolicy).toEqual({
      id: 'sp-1',
      version: 1,
      digest: 'sp-digest',
      definition: s.scopePolicyDefinition,
      selectorCatalogVersion: 'agent-scope-selectors-v1',
    });
    expect(input.delegationConsent).toMatchObject({
      type: 'delegation',
      consentVersion: 1,
      userId: 'admin-1',
      scopes: ['agent:read', 'agent:write'],
    });
    expect(input.oauthClientConsent).toMatchObject({ type: 'oauth_client', consentVersion: 1 });
    expect(input.delegationConsent.id).not.toBe(input.oauthClientConsent.id);
    expect(input.audit).toMatchObject({
      action: 'agent.grant.created',
      resourceType: 'admin_agent_grant',
      resourceId: snapshotInput.grantId,
      requestId: 'req-9',
      actorType: 'admin_user',
      actorSub: 'admin_user:admin-1',
      metadata: {
        grant_id: snapshotInput.grantId,
        client_id: 'mcp-client',
        management_mode: 'system_managed',
        scopes: ['agent:read', 'agent:write'],
        max_subjects_per_call: 10,
      },
    });
    expect(input.consentAudit).toMatchObject({
      action: 'agent.consent.granted',
      metadata: { grant_id: snapshotInput.grantId, consent_version: 1, max_subjects_per_call: 10 },
    });
    expect(fx.storeCodeRpc.mock.calls[0][0]).toMatchObject({
      scope: 'agent:read agent:write',
      authorizationDetails: RAR,
      agentGrantId: snapshotInput.grantId,
      agentGrantGeneration: 1,
      agentConsentVersion: 1,
    });
  });

  it('adds user-data access only with the exact checkbox value', async () => {
    await approve({ scope_user_data_read: 'agent:user-data:read' });
    expect(fx.resolveSnapshot.mock.calls[0][0].approvedScopes).toEqual([
      'agent:read',
      'agent:user-data:read',
    ]);
  });

  it('ignores ticked scopes that were not requested', async () => {
    fx.consumeRequestRpc.mockResolvedValue(parRecord({ scope: 'agent:read' }));
    await approve({ scope_write: 'agent:write', scope_user_data_read: 'agent:user-data:read' });
    expect(fx.resolveSnapshot.mock.calls[0][0]).toMatchObject({
      approvedScopes: ['agent:read'],
      authorizationDetails: undefined,
    });
    expect(
      fx.createSelfServiceAuthorization.mock.calls[0][0].audit.metadata.max_subjects_per_call
    ).toBe(50);
  });

  it.each([
    [
      new Error('No Agent Tools are available for this admin'),
      'No Agent Tools are available for this admin',
    ],
    ['not an error', 'No Agent Tools are available'],
  ])('denies when no access snapshot can be built (%s)', async (thrown, description) => {
    fx.resolveSnapshot.mockRejectedValue(thrown);
    expect(await approve()).toMatchObject({
      status: 403,
      body: { error: 'access_denied', error_description: description },
    });
    expect(fx.createSelfServiceAuthorization).not.toHaveBeenCalled();
  });
});

describe('existing self-service grant', () => {
  beforeEach(() => {
    fx.getGrantRecord.mockResolvedValue({
      purpose: 'interactive_self_service',
      authorizationDetails: [{ type: 'authrim_admin_agent', max_subjects_per_call: 10 }],
    });
    fx.getSystemManagedTaskSetCatalogVersion.mockResolvedValue(createAdminToolCatalog().version);
  });

  it('reuses an unchanged, current grant with a fresh consent pair', async () => {
    fx.findActiveGrantForDelegatorClient.mockResolvedValue(selfServiceGrant());
    expect((await approve()).status).toBe(302);
    expect(fx.replaceSelfServiceAuthorization).not.toHaveBeenCalled();
    expect(fx.grantConsentPair).toHaveBeenCalledTimes(1);
    expect(fx.storeCodeRpc.mock.calls[0][0]).toMatchObject({
      agentGrantId: 'grant-1',
      agentGrantGeneration: 3,
      agentConsentVersion: 2,
    });
  });

  it.each([
    ['the scopes changed', { scopes: ['agent:read', 'agent:write'] }, {}, null],
    ['the RAR changed', {}, {}, [{ type: 'authrim_admin_agent', max_subjects_per_call: 20 }]],
    ['the grant expired', { expiresAt: Date.now() - 1 }, {}, null],
    ['the grant has no expiry', { expiresAt: undefined }, {}, null],
    ['the catalog is stale', {}, { stale: true }, null],
  ])('replaces the grant when %s', async (_label, grantOverrides, opts, recordDetails) => {
    fx.findActiveGrantForDelegatorClient.mockResolvedValue(selfServiceGrant(grantOverrides));
    if (recordDetails) {
      fx.getGrantRecord.mockResolvedValue({
        purpose: 'interactive_self_service',
        authorizationDetails: recordDetails,
      });
    }
    if ('stale' in opts) fx.getSystemManagedTaskSetCatalogVersion.mockResolvedValue('catalog-old');
    const result = await approve();
    expect(result.status).toBe(302);
    const snapshotInput = fx.resolveSnapshot.mock.calls[0][0];
    expect(snapshotInput).toMatchObject({
      grantId: 'grant-1',
      taskSetId: 'system_agent_task_set_grant-1_cv3',
      taskSetVersion: 1,
      scopePolicyId: 'system_agent_scope_policy_grant-1_cv3',
      scopePolicyVersion: 1,
      approvedScopes: ['agent:read'],
    });
    const input = fx.replaceSelfServiceAuthorization.mock.calls[0][0];
    expect(input.expectedGeneration).toBe(3);
    expect(input.outboxId).toBe(`outbox_${input.transitionId}`);
    expect(input.grant).toMatchObject({
      grantId: 'grant-1',
      scopes: ['agent:read'],
      consentVersion: 3,
      generation: 4,
      taskSetId: 'ts-1',
      purpose: 'interactive_self_service',
      managementMode: 'system_managed',
    });
    expect(input.grantAudit).toMatchObject({
      id: input.transitionId,
      action: 'agent.grant.updated',
      requestId: 'req-9',
      metadata: {
        grant_id: 'grant-1',
        client_id: 'mcp-client',
        scopes: ['agent:read'],
        max_subjects_per_call: 10,
        previous_generation: 3,
        previous_catalog_version:
          'stale' in opts ? 'catalog-old' : createAdminToolCatalog().version,
        catalog_version: createAdminToolCatalog().version,
      },
    });
    expect(input.consentAudit.metadata).toMatchObject({ consent_version: 3 });
    expect(input.delegationConsent).toMatchObject({ type: 'delegation', consentVersion: 3 });
    expect(fx.grantConsentPair).not.toHaveBeenCalled();
    expect(fx.storeCodeRpc.mock.calls[0][0]).toMatchObject({
      agentGrantGeneration: 4,
      agentConsentVersion: 3,
    });
  });

  it('records a null previous catalog version when none was resolved', async () => {
    fx.findActiveGrantForDelegatorClient.mockResolvedValue(
      selfServiceGrant({ taskSetId: undefined })
    );
    await approve();
    expect(
      fx.replaceSelfServiceAuthorization.mock.calls[0][0].grantAudit.metadata
        .previous_catalog_version
    ).toBeNull();
  });

  it('denies a replacement whose access snapshot cannot be built', async () => {
    fx.findActiveGrantForDelegatorClient.mockResolvedValue(selfServiceGrant({ expiresAt: 1 }));
    fx.resolveSnapshot.mockRejectedValue(new Error('RBAC ceiling'));
    expect(await approve()).toMatchObject({
      status: 403,
      body: { error: 'access_denied', error_description: 'RBAC ceiling' },
    });
    fx.resolveSnapshot.mockRejectedValue(42);
    expect((await approve()).body).toMatchObject({
      error_description: 'No Agent Tools are available',
    });
    expect(fx.replaceSelfServiceAuthorization).not.toHaveBeenCalled();
  });
});
