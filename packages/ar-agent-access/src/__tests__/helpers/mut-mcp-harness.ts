import { vi } from 'vitest';
import {
  AGENT_ACCESS_SETTINGS_DEFAULTS,
  createAgentToolCatalog,
  sealAgentToolDefinitions,
  type AgentAccessSettings,
  type AgentAuditEvent,
  type AgentAuthorizationDecision,
  type AgentGrantContract,
  type AgentResolvedToolContract,
  type AgentToolCatalog,
  type AgentToolDefinition,
  type AgentToolDefinitionSource,
} from '../../core';
import type {
  AgentAuthorizationPort,
  AgentDiscoveryProfileSelection,
  AgentElevationPort,
  ManagementOperationRequest,
  ManagementOperationResult,
} from '../../platform/ports';
import { McpSdkJsonSchemaValidator } from '../../protocol/mcp/json-schema-validator';
import {
  createAgentAccessMcpServer,
  type AgentAccessMcpRequestContext,
  type AgentAccessMcpServerDependencies,
} from '../../protocol/mcp/server';

export const LOW_TOOL: AgentToolDefinitionSource = {
  id: 'users.get',
  name: 'get_user',
  title: 'Get user',
  description: 'Returns a masked user.',
  contractVersion: '1',
  requiredPermissions: ['admin:users:read'],
  riskLevel: 'low',
  requiredScope: 'agent:read',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { user_id: { type: 'string' } },
  },
};

export const SECOND_TOOL: AgentToolDefinitionSource = {
  ...LOW_TOOL,
  id: 'clients.get',
  name: 'get_client',
  title: 'Get client',
  description: 'Returns one client.',
  requiredPermissions: ['admin:clients:read'],
};

export function makeCatalog(
  definitions: readonly AgentToolDefinitionSource[] = [LOW_TOOL, SECOND_TOOL],
  version = 'catalog-7'
): AgentToolCatalog {
  return createAgentToolCatalog(version, sealAgentToolDefinitions(definitions));
}

export function pinnedTool(tool: AgentToolDefinition): AgentResolvedToolContract {
  return {
    toolId: tool.id,
    toolName: tool.name,
    contractVersion: tool.contractVersion,
    schemaDigest: tool.schemaDigest,
    permissions: [...tool.requiredPermissions],
    requiredScope: tool.requiredScope,
    riskLevel: tool.riskLevel,
    requiresElevation: tool.riskLevel === 'high',
  };
}

export const BASE_GRANT: AgentGrantContract = {
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

export function makeContext(
  overrides: {
    grant?: Partial<AgentGrantContract>;
    actor?: Partial<AgentAccessMcpRequestContext['actor']>;
  } = {}
): AgentAccessMcpRequestContext {
  return {
    actor: {
      mode: 'mode_a',
      sub: 'client:client-1',
      assurance: 'public_client_transaction',
      tokenBinding: 'bearer',
      clientId: 'client-1',
      ...overrides.actor,
    },
    grant: { ...BASE_GRANT, ...overrides.grant },
    resource: { tenantId: 'tenant-1' },
    issuerOrigin: 'https://tenant-1.authrim.example',
    correlationId: 'correlation-1',
  };
}

export const ALLOW: AgentAuthorizationDecision = { allowed: true, requiresElevation: false };
export const ELEVATE: AgentAuthorizationDecision = {
  allowed: false,
  requiresElevation: true,
  deniedAxis: 'risk',
  code: 'AGENT_ELEVATION_REQUIRED',
};

export interface HarnessOptions {
  catalog?: AgentToolCatalog;
  authorize?: AgentAuthorizationPort['authorize'];
  settings?: Partial<AgentAccessSettings>;
  settingsGet?: () => Promise<AgentAccessSettings>;
  consume?: AgentAccessMcpServerDependencies['rateLimiter']['consume'];
  execute?: (request: ManagementOperationRequest) => Promise<ManagementOperationResult>;
  elevation?: AgentElevationPort;
  discoveryProfiles?: AgentAccessMcpServerDependencies['discoveryProfiles'];
  extra?: Partial<AgentAccessMcpServerDependencies>;
  auditFails?: (event: AgentAuditEvent) => boolean;
}

export function createHarness(options: HarnessOptions = {}) {
  const events: AgentAuditEvent[] = [];
  const audit = vi.fn(async (event: AgentAuditEvent) => {
    if (options.auditFails?.(event)) throw new Error('audit unavailable');
    events.push(event);
  });
  const execute = vi.fn<
    (request: ManagementOperationRequest) => Promise<ManagementOperationResult>
  >(options.execute ?? (async () => ({ status: 200, body: { id: 'user-1' } })));
  const consume = vi.fn(
    options.consume ?? (async () => ({ allowed: true, remaining: 9, resetAt: 160 }))
  );
  const authorize = vi.fn(options.authorize ?? (async () => ALLOW));
  const settingsGet = vi.fn(
    options.settingsGet ??
      (async () => ({ ...AGENT_ACCESS_SETTINGS_DEFAULTS, enabled: true, ...options.settings }))
  );
  const catalog = options.catalog ?? makeCatalog();
  const server = createAgentAccessMcpServer({
    toolCatalog: catalog,
    authorization: { authorize },
    managementApi: { execute },
    rateLimiter: { consume },
    settings: { get: settingsGet },
    audit: { write: audit },
    clock: { now: () => 1234 },
    schemaValidator: new McpSdkJsonSchemaValidator(),
    ...(options.elevation ? { elevation: options.elevation } : {}),
    ...(options.discoveryProfiles ? { discoveryProfiles: options.discoveryProfiles } : {}),
    ...options.extra,
  });
  return {
    server,
    catalog,
    events,
    audit,
    execute,
    consume,
    authorize,
    settingsGet,
    lastEvent: () => events[events.length - 1],
  };
}

export function memoryProfileStore(initial: AgentDiscoveryProfileSelection | null = null) {
  const state: { selection: AgentDiscoveryProfileSelection | null } = { selection: initial };
  return {
    state,
    store: {
      get: vi.fn(async () => state.selection),
      put: vi.fn(async (next: AgentDiscoveryProfileSelection) => {
        state.selection = next;
      }),
    },
  };
}
