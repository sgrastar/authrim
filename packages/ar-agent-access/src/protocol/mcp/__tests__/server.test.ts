import { describe, expect, it, vi } from 'vitest';
import { createAgentToolCatalog, type AgentGrantContract } from '../../../core';
import type { ManagementOperationRequest } from '../../../platform/ports';
import { McpSdkJsonSchemaValidator } from '../json-schema-validator';
import { createAgentAccessMcpServer } from '../server';

const schemaValidator = new McpSdkJsonSchemaValidator();
const enabledSettings = {
  get: async () => ({
    enabled: true,
    maxTokenTtlSeconds: 900,
    elevationMode: 'self_reauth' as const,
    elevationTtlSeconds: 300,
    rateLimitPerMinute: 60,
    highRiskPermissionsAdditional: [],
    bulkCanaryProtected: false,
  }),
};

const grant: AgentGrantContract = {
  grantId: 'grant-1',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  grantorId: 'admin-1',
  delegatorId: 'admin-2',
  permissions: ['admin:users:read'],
  scopes: ['agent:read'],
  resolvedScopeConstraints: { tenantIds: ['tenant-1'] },
  consentVersion: 3,
  generation: 4,
  status: 'active',
  delegationMode: 'user_consent',
};

const requestContext = {
  actor: {
    mode: 'mode_a' as const,
    sub: 'client:client-1',
    assurance: 'public_client_transaction' as const,
    tokenBinding: 'bearer' as const,
    clientId: 'client-1',
  },
  grant,
  resource: { tenantId: 'tenant-1' },
  issuerOrigin: 'https://tenant-1.authrim.example',
  correlationId: 'correlation-1',
};

const catalog = createAgentToolCatalog('1', [
  {
    id: 'users.get',
    name: 'get_user',
    title: 'Get user',
    description: 'Returns a masked user.',
    contractVersion: '1',
    requiredPermissions: ['admin:users:read'],
    riskLevel: 'low',
    requiredScope: 'agent:read',
    schemaDigest: 'sha256:test',
    inputSchema: { type: 'object' },
  },
]);

describe('createAgentAccessMcpServer', () => {
  it('uses the dedicated public Mode A write limit and a server-derived idempotency key', async () => {
    const execute = vi.fn(async (_request: ManagementOperationRequest) => ({
      status: 200,
      body: { client: { id: 'client-target' } },
    }));
    const consume = vi.fn(async () => ({ allowed: true, remaining: 4, resetAt: 160 }));
    const standardCatalog = createAgentToolCatalog('1', [
      {
        id: 'admin.write.clients.metadata',
        name: 'update_client_metadata',
        title: 'Update client metadata',
        description: 'Update one client.',
        contractVersion: '1',
        requiredPermissions: ['admin:clients:write'],
        riskLevel: 'standard',
        requiredScope: 'agent:write',
        schemaDigest: 'sha256:standard',
        inputSchema: { type: 'object' },
        publicClientStandardOptInEligible: true,
      },
    ]);
    const server = createAgentAccessMcpServer({
      toolCatalog: standardCatalog,
      authorization: { authorize: async () => ({ allowed: true, requiresElevation: false }) },
      managementApi: { execute },
      rateLimiter: { consume },
      settings: {
        get: async () => ({
          enabled: true,
          maxTokenTtlSeconds: 900,
          elevationMode: 'self_reauth',
          elevationTtlSeconds: 300,
          rateLimitPerMinute: 60,
          publicClientStandardRateLimitPerMinute: 5,
          highRiskPermissionsAdditional: [],
          publicClientStandardToolIds: ['admin.write.clients.metadata'],
          bulkCanaryProtected: false,
        }),
      },
      audit: { write: async () => undefined },
      clock: { now: () => 100 },
      schemaValidator,
    });
    const writeGrant: AgentGrantContract = {
      ...grant,
      permissions: ['admin:clients:write'],
      scopes: ['agent:write'],
    };
    const input = {
      client_id: 'client-target',
      resource_version: 'version_123456789',
      description: 'Updated',
    };

    await server.callTool(
      { ...requestContext, grant: writeGrant },
      'update_client_metadata',
      input
    );
    await server.callTool(
      { ...requestContext, grant: writeGrant },
      'update_client_metadata',
      input
    );

    expect(consume).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
    const firstKey = execute.mock.calls[0]?.[0].idempotencyKey;
    const secondKey = execute.mock.calls[1]?.[0].idempotencyKey;
    expect(firstKey).toMatch(/^agent-mode-a:[A-Za-z0-9_-]{43}$/u);
    expect(secondKey).toBe(firstKey);
  });

  it('keeps tool definitions outside a platform runtime and injects typed owner calls', async () => {
    const execute = vi.fn(async (_request: ManagementOperationRequest) => ({
      status: 200,
      body: { id: 'user-1' },
    }));
    const consume = vi.fn(async () => ({ allowed: true, remaining: 22, resetAt: 160 }));
    const server = createAgentAccessMcpServer({
      toolCatalog: catalog,
      authorization: { authorize: async () => ({ allowed: true, requiresElevation: false }) },
      managementApi: { execute },
      rateLimiter: { consume },
      settings: {
        get: async () => ({
          enabled: true,
          maxTokenTtlSeconds: 900,
          elevationMode: 'self_reauth',
          elevationTtlSeconds: 300,
          rateLimitPerMinute: 23,
          highRiskPermissionsAdditional: [],
          bulkCanaryProtected: false,
        }),
      },
      audit: { write: async () => undefined },
      clock: { now: () => 100 },
      schemaValidator,
    });

    const result = await server.callTool(
      {
        actor: {
          mode: 'mode_a',
          sub: 'client:client-1',
          assurance: 'public_client_transaction',
          tokenBinding: 'bearer',
          clientId: 'client-1',
        },
        grant,
        resource: { tenantId: 'tenant-1', resourceId: 'user-1' },
        issuerOrigin: 'https://tenant-1.authrim.example',
        correlationId: 'correlation-1',
      },
      'get_user',
      { user_id: 'user-1' }
    );

    expect(result.isError).toBe(false);
    expect(consume).toHaveBeenCalledWith(expect.objectContaining({ limit: 23, windowSeconds: 60 }));
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'users.get',
        authorization: expect.objectContaining({
          audience: 'authrim:admin-api',
          grantId: 'grant-1',
          grantGeneration: 4,
          consentVersion: 3,
        }),
      })
    );
    expect(execute.mock.calls[0][0]).not.toHaveProperty('authorizationToken');
  });

  it('filters denied tools from tools/list', async () => {
    const write = vi.fn(async () => undefined);
    const server = createAgentAccessMcpServer({
      toolCatalog: catalog,
      authorization: {
        authorize: async () => ({
          allowed: false,
          requiresElevation: false,
          deniedAxis: 'permission',
        }),
      },
      managementApi: { execute: async () => ({ status: 500, body: null }) },
      rateLimiter: { consume: async () => ({ allowed: true, remaining: 1, resetAt: 1 }) },
      settings: {
        get: async () => ({
          enabled: true,
          maxTokenTtlSeconds: 900,
          elevationMode: 'self_reauth',
          elevationTtlSeconds: 300,
          rateLimitPerMinute: 60,
          highRiskPermissionsAdditional: [],
          bulkCanaryProtected: false,
        }),
      },
      audit: { write },
      clock: { now: () => 100 },
      schemaValidator,
    });
    await expect(
      server.listTools({
        actor: {
          mode: 'mode_a',
          sub: 'client:client-1',
          assurance: 'public_client_transaction',
          tokenBinding: 'bearer',
          clientId: 'client-1',
        },
        grant,
        resource: { tenantId: 'tenant-1' },
        issuerOrigin: 'https://tenant-1.authrim.example',
        correlationId: 'correlation-1',
      })
    ).resolves.toEqual([]);
    expect(write).not.toHaveBeenCalled();
  });

  it('derives the server-owned Tool domain before filtering tools/list', async () => {
    const constrainedCatalog = createAgentToolCatalog('domain-constrained', [
      {
        ...catalog.list()[0],
        id: 'admin.read.clients.list',
        name: 'list_clients',
        title: 'List clients',
        requiredPermissions: ['admin:clients:read'],
      },
    ]);
    const authorize = vi.fn(async ({ resource }: { resource: { domain?: string } }) => ({
      allowed: resource.domain === 'clients',
      requiresElevation: false,
    }));
    const server = createAgentAccessMcpServer({
      toolCatalog: constrainedCatalog,
      authorization: { authorize },
      managementApi: { execute: async () => ({ status: 500, body: null }) },
      rateLimiter: { consume: async () => ({ allowed: true, remaining: 1, resetAt: 1 }) },
      settings: enabledSettings,
      audit: { write: async () => undefined },
      clock: { now: () => 100 },
      schemaValidator,
    });

    await expect(
      server.listTools({
        ...requestContext,
        resource: { tenantId: 'tenant-1', domain: 'users' },
      })
    ).resolves.toMatchObject([{ id: 'admin.read.clients.list', name: 'list_clients' }]);
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: expect.objectContaining({
          tenantId: 'tenant-1',
          domain: 'clients',
          quantity: 1,
          requestsUnmaskedPii: false,
        }),
      })
    );
  });

  it('dispatches Bulk tools through the platform Bulk port instead of Management API', async () => {
    const bulkCatalog = createAgentToolCatalog('bulk-1', [
      {
        ...catalog.list()[0],
        id: 'admin.read.bulk.plan.get',
        name: 'get_bulk_plan',
        executionTarget: 'bulk_plan',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            bulk_plan_id: { type: 'string' },
            version: { type: 'integer' },
          },
          required: ['bulk_plan_id', 'version'],
        },
      },
    ]);
    const bulkExecute = vi.fn(async () => ({
      status: 200,
      body: { bulk_plan: { id: 'bulk-1' }, tenant_executions: [] },
    }));
    const managementExecute = vi.fn();
    const server = createAgentAccessMcpServer({
      toolCatalog: bulkCatalog,
      authorization: { authorize: async () => ({ allowed: true, requiresElevation: false }) },
      managementApi: { execute: managementExecute },
      bulkPlans: { execute: bulkExecute },
      rateLimiter: { consume: async () => ({ allowed: true, remaining: 1, resetAt: 1 }) },
      settings: enabledSettings,
      audit: { write: async () => undefined },
      clock: { now: () => 100 },
      schemaValidator,
    });
    const response = await server.callTool(requestContext, 'get_bulk_plan', {
      bulk_plan_id: 'bulk-1',
      version: 1,
    });
    expect(response).toMatchObject({ isError: false });
    expect(bulkExecute).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'admin.read.bulk.plan.get', grant })
    );
    expect(managementExecute).not.toHaveBeenCalled();
  });

  it('audits denied tool calls before returning an error', async () => {
    const write = vi.fn(async () => undefined);
    const server = createAgentAccessMcpServer({
      toolCatalog: catalog,
      authorization: {
        authorize: async () => ({
          allowed: false,
          requiresElevation: false,
          deniedAxis: 'permission',
          code: 'AGENT_INSUFFICIENT_PERMISSION',
        }),
      },
      managementApi: { execute: async () => ({ status: 500, body: null }) },
      rateLimiter: { consume: async () => ({ allowed: true, remaining: 1, resetAt: 1 }) },
      settings: {
        get: async () => ({
          enabled: true,
          maxTokenTtlSeconds: 900,
          elevationMode: 'self_reauth',
          elevationTtlSeconds: 300,
          rateLimitPerMinute: 60,
          highRiskPermissionsAdditional: [],
          bulkCanaryProtected: false,
        }),
      },
      audit: { write },
      clock: { now: () => 100 },
      schemaValidator,
    });
    const result = await server.callTool(
      {
        actor: {
          mode: 'mode_a',
          sub: 'client:client-1',
          assurance: 'public_client_transaction',
          tokenBinding: 'bearer',
          clientId: 'client-1',
        },
        grant,
        resource: { tenantId: 'tenant-1' },
        issuerOrigin: 'https://tenant-1.authrim.example',
        correlationId: 'correlation-1',
      },
      'get_user',
      { user_id: 'user-1' }
    );
    expect(result.isError).toBe(true);
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'agent.mcp.tool.denied',
        outcome: 'denied',
        details: expect.objectContaining({ denied_axis: 'permission' }),
      })
    );
  });

  it('rejects malformed tool input before authorization or Management API execution', async () => {
    const authorize = vi.fn(async () => ({ allowed: true, requiresElevation: false }));
    const execute = vi.fn(async () => ({ status: 200, body: { id: 'user-1' } }));
    const write = vi.fn(async () => undefined);
    const strictCatalog = createAgentToolCatalog('1', [
      {
        ...catalog.list()[0],
        inputSchema: {
          type: 'object',
          properties: { user_id: { type: 'string', minLength: 1 } },
          required: ['user_id'],
          additionalProperties: false,
        },
      },
    ]);
    const server = createAgentAccessMcpServer({
      toolCatalog: strictCatalog,
      authorization: { authorize },
      managementApi: { execute },
      rateLimiter: { consume: async () => ({ allowed: true, remaining: 1, resetAt: 1 }) },
      settings: {
        get: async () => ({
          enabled: true,
          maxTokenTtlSeconds: 900,
          elevationMode: 'self_reauth',
          elevationTtlSeconds: 300,
          rateLimitPerMinute: 60,
          highRiskPermissionsAdditional: [],
          bulkCanaryProtected: false,
        }),
      },
      audit: { write },
      clock: { now: () => 100 },
      schemaValidator,
    });

    const result = await server.callTool(
      {
        actor: {
          mode: 'mode_a',
          sub: 'client:client-1',
          assurance: 'public_client_transaction',
          tokenBinding: 'bearer',
          clientId: 'client-1',
        },
        grant,
        resource: { tenantId: 'tenant-1' },
        issuerOrigin: 'https://tenant-1.authrim.example',
        correlationId: 'correlation-1',
      },
      'get_user',
      { unexpected: true }
    );

    expect(result).toMatchObject({ isError: true });
    expect(authorize).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'agent.mcp.tool.denied',
        details: expect.objectContaining({ denied_axis: 'input_schema' }),
      })
    );
  });

  it('fails closed and audits rate limiter and Management API transport failures', async () => {
    const context = {
      actor: {
        mode: 'mode_a' as const,
        sub: 'client:client-1',
        assurance: 'public_client_transaction' as const,
        tokenBinding: 'bearer' as const,
        clientId: 'client-1',
      },
      grant,
      resource: { tenantId: 'tenant-1' },
      issuerOrigin: 'https://tenant-1.authrim.example',
      correlationId: 'correlation-1',
    };
    const settings = {
      get: async () => ({
        enabled: true,
        maxTokenTtlSeconds: 900,
        elevationMode: 'self_reauth' as const,
        elevationTtlSeconds: 300,
        rateLimitPerMinute: 60,
        highRiskPermissionsAdditional: [],
        bulkCanaryProtected: false,
      }),
    };

    const rateAudit = vi.fn(async () => undefined);
    const rateExecute = vi.fn(async () => ({ status: 200, body: { id: 'user-1' } }));
    const rateFailureServer = createAgentAccessMcpServer({
      toolCatalog: catalog,
      authorization: { authorize: async () => ({ allowed: true, requiresElevation: false }) },
      managementApi: { execute: rateExecute },
      rateLimiter: {
        consume: async () => {
          throw new Error('internal rate limiter detail');
        },
      },
      settings: enabledSettings,
      audit: { write: rateAudit },
      clock: { now: () => 100 },
      schemaValidator,
    });

    await expect(rateFailureServer.callTool(context, 'get_user', {})).resolves.toMatchObject({
      isError: true,
    });
    expect(rateExecute).not.toHaveBeenCalled();
    expect(rateAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'agent.mcp.tool.failed',
        details: { tool_id: 'users.get', code: 'AGENT_RATE_LIMIT_UNAVAILABLE' },
      })
    );

    const managementAudit = vi.fn(async () => undefined);
    const managementFailureServer = createAgentAccessMcpServer({
      toolCatalog: catalog,
      authorization: { authorize: async () => ({ allowed: true, requiresElevation: false }) },
      managementApi: {
        execute: async () => {
          throw new Error('internal service binding detail');
        },
      },
      rateLimiter: { consume: async () => ({ allowed: true, remaining: 1, resetAt: 1 }) },
      settings: enabledSettings,
      audit: { write: managementAudit },
      clock: { now: () => 100 },
      schemaValidator,
    });

    await expect(managementFailureServer.callTool(context, 'get_user', {})).resolves.toMatchObject({
      isError: true,
    });
    expect(managementAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'agent.mcp.tool.failed',
        details: { tool_id: 'users.get', code: 'AGENT_MANAGEMENT_API_UNAVAILABLE' },
      })
    );
    expect(JSON.stringify(managementAudit.mock.calls)).not.toContain(
      'internal service binding detail'
    );
  });

  it('executes an approved high-risk operation with the server-issued idempotency fence', async () => {
    const highRiskCatalog = createAgentToolCatalog('1', [
      {
        ...catalog.list()[0],
        id: 'admin.write.users.suspend',
        name: 'suspend_user',
        requiredScope: 'agent:write',
        riskLevel: 'high',
      },
    ]);
    const authorize = vi.fn(async (input: { elevationCapabilityValid?: boolean }) =>
      input.elevationCapabilityValid
        ? { allowed: true, requiresElevation: false }
        : {
            allowed: false,
            requiresElevation: true,
            deniedAxis: 'risk' as const,
            code: 'AGENT_ELEVATION_REQUIRED',
          }
    );
    const execute = vi.fn(async () => ({ status: 200, body: { status: 'suspended' } }));
    const complete = vi.fn(async () => true);
    const server = createAgentAccessMcpServer({
      toolCatalog: highRiskCatalog,
      authorization: { authorize },
      managementApi: { execute },
      rateLimiter: { consume: async () => ({ allowed: true, remaining: 1, resetAt: 1 }) },
      settings: {
        get: async () => ({
          enabled: true,
          maxTokenTtlSeconds: 900,
          elevationMode: 'self_reauth',
          elevationTtlSeconds: 300,
          rateLimitPerMinute: 60,
          highRiskPermissionsAdditional: [],
          bulkCanaryProtected: false,
        }),
      },
      elevation: {
        resolve: async () => ({
          status: 'authorized',
          challengeId: 'elevation-1',
          executionAttempt: 2,
          executionFence: 7,
          executionToken: 'owner-1',
          idempotencyKey: 'elevation:elevation-1:2:7',
        }),
        complete,
      },
      audit: { write: async () => undefined },
      clock: { now: () => 100 },
      schemaValidator,
    });

    const result = await server.callTool(
      {
        actor: {
          mode: 'mode_a',
          sub: 'client:client-1',
          assurance: 'public_client_transaction',
          tokenBinding: 'bearer',
          clientId: 'client-1',
        },
        grant: { ...grant, scopes: ['agent:write'] },
        resource: { tenantId: 'tenant-1' },
        issuerOrigin: 'https://tenant-1.authrim.example',
        correlationId: 'correlation-1',
      },
      'suspend_user',
      {},
      { elevationChallengeId: 'elevation-1', idempotencyKey: 'client-controlled' }
    );

    expect(result).toMatchObject({ isError: false, structuredContent: { status: 'suspended' } });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'elevation:elevation-1:2:7' })
    );
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        challengeId: 'elevation-1',
        executionAttempt: 2,
        executionFence: 7,
        executionToken: 'owner-1',
        status: 'consumed',
      })
    );
  });

  it('fails closed and audits without leaking an elevation store exception', async () => {
    const highRiskCatalog = createAgentToolCatalog('1', [
      {
        ...catalog.list()[0],
        id: 'admin.write.users.suspend',
        name: 'suspend_user',
        requiredScope: 'agent:write',
        riskLevel: 'high',
      },
    ]);
    const audit = vi.fn(async () => undefined);
    const server = createAgentAccessMcpServer({
      toolCatalog: highRiskCatalog,
      authorization: {
        authorize: async () => ({
          allowed: false,
          requiresElevation: true,
          deniedAxis: 'risk',
        }),
      },
      managementApi: { execute: vi.fn() },
      rateLimiter: { consume: async () => ({ allowed: true, remaining: 1, resetAt: 1 }) },
      settings: enabledSettings,
      elevation: {
        resolve: async () => {
          throw new Error('database location and ciphertext must not leak');
        },
        complete: async () => true,
      },
      audit: { write: audit },
      clock: { now: () => 100 },
      schemaValidator,
    });

    const result = await server.callTool(
      { ...requestContext, grant: { ...grant, scopes: ['agent:write'] } },
      'suspend_user',
      {}
    );
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(audit.mock.calls)).not.toContain('ciphertext');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'agent.mcp.tool.denied',
        details: expect.objectContaining({ code: 'AGENT_ELEVATION_STATE_UNAVAILABLE' }),
      })
    );
  });

  it('returns indeterminate when terminal elevation persistence throws', async () => {
    const highRiskCatalog = createAgentToolCatalog('1', [
      {
        ...catalog.list()[0],
        id: 'admin.write.users.suspend',
        name: 'suspend_user',
        requiredScope: 'agent:write',
        riskLevel: 'high',
      },
    ]);
    const audit = vi.fn(async () => undefined);
    const server = createAgentAccessMcpServer({
      toolCatalog: highRiskCatalog,
      authorization: {
        authorize: async (input) =>
          input.elevationCapabilityValid
            ? { allowed: true, requiresElevation: false }
            : { allowed: false, requiresElevation: true, deniedAxis: 'risk' },
      },
      managementApi: { execute: async () => ({ status: 200, body: { status: 'suspended' } }) },
      rateLimiter: { consume: async () => ({ allowed: true, remaining: 1, resetAt: 1 }) },
      settings: enabledSettings,
      elevation: {
        resolve: async () => ({
          status: 'authorized',
          challengeId: 'elevation-1',
          executionAttempt: 1,
          executionFence: 1,
          executionToken: 'owner-1',
          idempotencyKey: 'agent-elevation:elevation-1:1:1',
        }),
        complete: async () => {
          throw new Error('terminal database unavailable');
        },
      },
      audit: { write: audit },
      clock: { now: () => 100 },
      schemaValidator,
    });

    const result = await server.callTool(
      { ...requestContext, grant: { ...grant, scopes: ['agent:write'] } },
      'suspend_user',
      {},
      { elevationChallengeId: 'elevation-1' }
    );
    expect(result).toMatchObject({ isError: true });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'agent.elevation.indeterminate' })
    );
  });

  it('returns indeterminate when an elevated owner call has an unknown transport outcome', async () => {
    const highRiskCatalog = createAgentToolCatalog('1', [
      {
        ...catalog.list()[0],
        id: 'admin.write.users.suspend',
        name: 'suspend_user',
        requiredScope: 'agent:write',
        riskLevel: 'high',
      },
    ]);
    const audit = vi.fn(async () => undefined);
    const complete = vi.fn(async () => true);
    const server = createAgentAccessMcpServer({
      toolCatalog: highRiskCatalog,
      authorization: {
        authorize: async (input) =>
          input.elevationCapabilityValid
            ? { allowed: true, requiresElevation: false }
            : { allowed: false, requiresElevation: true, deniedAxis: 'risk' },
      },
      managementApi: {
        execute: async () => {
          throw new Error('binding failed after dispatch');
        },
      },
      rateLimiter: { consume: async () => ({ allowed: true, remaining: 1, resetAt: 1 }) },
      settings: enabledSettings,
      elevation: {
        resolve: async () => ({
          status: 'authorized',
          challengeId: 'elevation-transport',
          executionAttempt: 1,
          executionFence: 1,
          executionToken: 'owner-1',
          idempotencyKey: 'agent-elevation:elevation-transport:1:1',
        }),
        complete,
      },
      audit: { write: audit },
      clock: { now: () => 100 },
      schemaValidator,
    });

    const result = await server.callTool(
      { ...requestContext, grant: { ...grant, scopes: ['agent:write'] } },
      'suspend_user',
      {},
      { elevationChallengeId: 'elevation-transport' }
    );

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Operation result is indeterminate' }],
      isError: true,
    });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ status: 'indeterminate' }));
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'agent.elevation.indeterminate',
        outcome: 'indeterminate',
      })
    );
  });
});
