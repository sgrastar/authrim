import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_PERMISSIONS, type AdminAuthContext, type Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  auth: {} as AdminAuthContext,
  enabled: vi.fn(),
  createTaskSet: vi.fn(),
  createScopePolicy: vi.fn(),
  suspendTaskSetVersion: vi.fn(),
  suspendScopePolicyVersion: vi.fn(),
  createSecretRef: vi.fn(),
  revokeSecretRef: vi.fn(),
  enrollProviderSecret: vi.fn(),
  getPlan: vi.fn(),
  getGrant: vi.fn(),
  confirmPlan: vi.fn(),
  cancelPlan: vi.fn(),
}));

vi.mock('../agent-downscope-auth', () => ({ isAgentMcpEnabled: mocks.enabled }));

vi.mock('@authrim/ar-agent-access/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-agent-access/core')>();
  return {
    ...actual,
    AgentConfigurationRepository: class {
      createTaskSet = mocks.createTaskSet;
      createScopePolicy = mocks.createScopePolicy;
      suspendTaskSetVersion = mocks.suspendTaskSetVersion;
      suspendScopePolicyVersion = mocks.suspendScopePolicyVersion;
      createSecretRef = mocks.createSecretRef;
      revokeSecretRef = mocks.revokeSecretRef;
      getPlan = mocks.getPlan;
      confirmPlan = mocks.confirmPlan;
      cancelPlan = mocks.cancelPlan;
    },
    AdminAgentAccessRepository: class {
      getGrant = mocks.getGrant;
    },
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    adminAuthMiddleware:
      () =>
      async (
        c: { set(key: 'adminAuth', value: AdminAuthContext): void },
        next: () => Promise<void>
      ) => {
        c.set('adminAuth', mocks.auth);
        await next();
      },
    requireDedicatedAdminDatabaseAdapter: () => ({}),
  };
});

import {
  agentConfigurationPlansRouter,
  agentScopePoliciesRouter,
  agentSecretRefsRouter,
  agentTaskSetsRouter,
} from '../routes/admin-management/agent-configuration';

function app() {
  const result = new Hono<{ Bindings: Env }>();
  result.route('/api/admin/agent-task-sets', agentTaskSetsRouter as never);
  result.route('/api/admin/agent-scope-policies', agentScopePoliciesRouter as never);
  result.route('/api/admin/agent-config-plans', agentConfigurationPlansRouter as never);
  result.route('/api/admin/agent-secret-refs', agentSecretRefsRouter as never);
  return result;
}

const env = {
  ENABLE_AGENT_MCP: 'true',
  DB_ADMIN: {},
  KEY_MANAGER: {
    idFromName: vi.fn().mockReturnValue({}),
    get: vi.fn().mockReturnValue({ getOrCreateSecretRpc: mocks.enrollProviderSecret }),
  },
} as unknown as Env;

describe('Agent Configuration management routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth = {
      userId: 'admin-1',
      tenantId: 'tenant-1',
      roles: [],
      authMethod: 'session',
      actorType: 'human',
      permissions: [
        ADMIN_PERMISSIONS.AGENT_TASK_SETS_WRITE,
        ADMIN_PERMISSIONS.AGENT_SCOPE_POLICIES_WRITE,
        ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_CREATE,
        ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_APPLY,
        ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_CANCEL,
        ADMIN_PERMISSIONS.CLIENTS_READ,
      ],
    };
    mocks.enabled.mockResolvedValue(true);
    mocks.createTaskSet.mockResolvedValue(undefined);
    mocks.createScopePolicy.mockResolvedValue(undefined);
    mocks.suspendTaskSetVersion.mockResolvedValue(true);
    mocks.suspendScopePolicyVersion.mockResolvedValue(true);
    mocks.createSecretRef.mockResolvedValue(undefined);
    mocks.revokeSecretRef.mockResolvedValue(true);
    mocks.enrollProviderSecret.mockResolvedValue({ active: { value: 'never-returned-secret' } });
    mocks.confirmPlan.mockResolvedValue(true);
    mocks.cancelPlan.mockResolvedValue(true);
    mocks.getPlan.mockResolvedValue({
      id: 'acp-1',
      version: 1,
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      actorSub: 'client:client-1',
      clientId: 'client-1',
      definitionDigest: 'digest-1',
      status: 'ready',
    });
    mocks.getGrant.mockResolvedValue({ status: 'active', delegatorId: 'admin-1' });
  });

  it('marks only server-reviewed standard Tools as eligible for public Mode A opt-in', async () => {
    mocks.auth = { ...mocks.auth, permissions: ['*'] };
    const response = await app().request('/api/admin/agent-task-sets/catalog', {}, env);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as {
      tools: Array<{
        name: string;
        public_client_standard_opt_in_eligible: boolean;
      }>;
    };
    const byName = new Map(body.tools.map((tool) => [tool.name, tool]));
    expect(byName.get('update_client_metadata')?.public_client_standard_opt_in_eligible).toBe(true);
    expect(byName.get('create_bulk_plan')?.public_client_standard_opt_in_eligible).toBe(false);
    expect(byName.get('suspend_user')?.public_client_standard_opt_in_eligible).toBe(false);
  });

  it('cancels a non-terminal Plan idempotently through a human session', async () => {
    const first = await app().request(
      '/api/admin/agent-config-plans/acp-1/1/cancel',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'Operator stopped rollout' }),
      },
      env
    );
    expect(first.status, await first.clone().text()).toBe(200);
    expect(mocks.cancelPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        id: 'acp-1',
        version: 1,
        cancelledBy: 'admin-1',
        reason: 'Operator stopped rollout',
        audit: expect.objectContaining({ action: 'agent.configuration.plan.cancelled' }),
      })
    );

    mocks.getPlan.mockResolvedValueOnce({
      id: 'acp-1',
      version: 1,
      tenantId: 'tenant-1',
      status: 'ready',
      cancelledAt: 1234,
    });
    const repeated = await app().request(
      '/api/admin/agent-config-plans/acp-1/1/cancel',
      { method: 'POST' },
      env
    );
    expect(repeated.status).toBe(200);
    expect(mocks.cancelPlan).toHaveBeenCalledTimes(1);
  });

  it('creates a flat Task Set only from catalogued Tools within creator permissions', async () => {
    const response = await app().request(
      '/api/admin/agent-task-sets',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Client inspector', tool_ids: ['admin.read.clients.list'] }),
      },
      env
    );
    expect(response.status, await response.clone().text()).toBe(201);
    expect(mocks.createTaskSet).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'custom',
        resolved: expect.objectContaining({ permissions: [ADMIN_PERMISSIONS.CLIENTS_READ] }),
        audit: expect.objectContaining({ action: 'agent.task_set.created' }),
      })
    );

    const invalid = await app().request(
      '/api/admin/agent-task-sets',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Unsafe', tool_ids: ['admin.*'] }),
      },
      env
    );
    expect(invalid.status).toBe(400);
  });

  it('rejects a Scope Policy that targets another tenant', async () => {
    const response = await app().request(
      '/api/admin/agent-scope-policies',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Cross tenant',
          definition: {
            tenantIds: ['tenant-2'],
            environmentIds: [],
            domains: [],
            resourceIds: [],
            selectors: [],
            allowedFields: [],
            piiMode: 'masked',
            maxPerCall: 10,
            maxPlanOperations: 10,
            maxBulkTenants: 10,
          },
        }),
      },
      env
    );
    expect(response.status).toBe(400);
    expect(mocks.createScopePolicy).not.toHaveBeenCalled();
  });

  it('rejects Agent bearer contexts from human confirmation and secret enrollment', async () => {
    mocks.auth = { ...mocks.auth, actorType: 'agent', authMethod: 'bearer' };
    const confirmation = await app().request(
      '/api/admin/agent-config-plans/acp-1/1/confirm',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmation_id: 'apc-1', plan_digest: 'digest-1' }),
      },
      env
    );
    expect(confirmation.status).toBe(403);
    const secret = await app().request(
      '/api/admin/agent-secret-refs',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resource_type: 'oidc_client',
          purpose: 'client authentication',
          provider_key: 'secrets/tenant-1/client-1',
        }),
      },
      env
    );
    expect(secret.status).toBe(403);
    expect(mocks.createSecretRef).not.toHaveBeenCalled();
  });

  it('enrolls only tenant-bound provider keys and never returns provider secrets', async () => {
    const rejected = await app().request(
      '/api/admin/agent-secret-refs',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resource_type: 'oidc_client',
          purpose: 'client authentication',
          provider_key: 'tenant:tenant-2:agent:client-1',
        }),
      },
      env
    );
    expect(rejected.status).toBe(400);
    expect(mocks.enrollProviderSecret).not.toHaveBeenCalled();

    const response = await app().request(
      '/api/admin/agent-secret-refs',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resource_type: 'oidc_client',
          purpose: 'client authentication',
          provider_key: 'tenant:tenant-1:agent:client-1',
        }),
      },
      env
    );
    expect(response.status, await response.clone().text()).toBe(201);
    expect(mocks.enrollProviderSecret).toHaveBeenCalledWith('tenant:tenant-1:agent:client-1');
    expect(await response.text()).not.toContain('never-returned-secret');
    expect(mocks.createSecretRef).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        providerKey: 'tenant:tenant-1:agent:client-1',
      })
    );
  });

  it('fails closed when the tenant secret provider is unavailable', async () => {
    mocks.enrollProviderSecret.mockRejectedValueOnce(new Error('provider unavailable'));
    const response = await app().request(
      '/api/admin/agent-secret-refs',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resource_type: 'oidc_client',
          purpose: 'client authentication',
          provider_key: 'tenant:tenant-1:agent:client-1',
        }),
      },
      env
    );
    expect(response.status).toBe(503);
    expect(mocks.createSecretRef).not.toHaveBeenCalled();
  });

  it('revokes a tenant-scoped secret reference with synchronous audit intent', async () => {
    const response = await app().request(
      '/api/admin/agent-secret-refs/asr_1234567890abcdef/revoke',
      { method: 'POST' },
      env
    );
    expect(response.status).toBe(200);
    expect(mocks.revokeSecretRef).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        id: 'asr_1234567890abcdef',
        revokedBy: 'admin-1',
        audit: expect.objectContaining({ action: 'agent.secret_ref.revoked' }),
      })
    );
  });

  it('binds Plan confirmation to the owning delegator and immutable digest', async () => {
    const response = await app().request(
      '/api/admin/agent-config-plans/acp-1/1/confirm',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmation_id: 'apc-1', plan_digest: 'digest-1' }),
      },
      env
    );
    expect(response.status).toBe(200);
    expect(mocks.confirmPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmedBy: 'admin-1',
        planDigest: 'digest-1',
        audit: expect.objectContaining({ action: 'agent.configuration.plan.confirmed' }),
      })
    );
    mocks.getGrant.mockResolvedValue({ status: 'active', delegatorId: 'admin-other' });
    const denied = await app().request(
      '/api/admin/agent-config-plans/acp-1/1/confirm',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmation_id: 'apc-2', plan_digest: 'digest-1' }),
      },
      env
    );
    expect(denied.status).toBe(403);
  });

  it('suspends configuration versions with an auditable security transition', async () => {
    const task = await app().request(
      '/api/admin/agent-task-sets/ats-1/versions/2/suspend',
      { method: 'POST' },
      env
    );
    expect(task.status).toBe(200);
    expect(mocks.suspendTaskSetVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        id: 'ats-1',
        version: 2,
        audit: expect.objectContaining({ action: 'agent.task_set.version_suspended' }),
      })
    );

    const scope = await app().request(
      '/api/admin/agent-scope-policies/asp-1/versions/3/suspend',
      { method: 'POST' },
      env
    );
    expect(scope.status).toBe(200);
    expect(mocks.suspendScopePolicyVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        id: 'asp-1',
        version: 3,
        audit: expect.objectContaining({ action: 'agent.scope_policy.version_suspended' }),
      })
    );
  });
});
