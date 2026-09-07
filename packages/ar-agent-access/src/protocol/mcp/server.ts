import {
  AGENT_DISCOVERY_PROFILE_CONTROL_TOOL_ID,
  agentGrantPinsToolContract,
  buildAgentToolResourceContext,
  canonicalizeJson,
  resolveAgentDiscoveryProfiles,
  sha256Base64Url,
} from '../../core';
import type {
  AgentActorContext,
  AgentAuthorizationDecision,
  AgentGrantContract,
  AgentResourceRequestContext,
  AgentToolCatalog,
  AgentToolDefinition,
  JsonObject,
  JsonValue,
} from '../../core';
import type {
  AgentAuditPort,
  AgentAuthorizationPort,
  AgentBulkPlanPort,
  AgentClockPort,
  AgentConfigurationPlanPort,
  AgentDiscoveryProfileStorePort,
  AgentElevationPort,
  AgentElevationCompletion,
  AgentJsonSchemaValidatorPort,
  AgentRateLimiterPort,
  AgentRuntimeDiagnosticsPort,
  AgentSettingsPort,
  ManagementApiPort,
} from '../../platform/ports';

export interface AgentAccessMcpRequestContext {
  actor: AgentActorContext;
  grant: AgentGrantContract;
  resource: AgentResourceRequestContext;
  /** Public Resource Server origin whose issuer was verified during request admission. */
  issuerOrigin: string;
  correlationId: string;
}

export interface AgentAccessMcpToolResult {
  structuredContent?: JsonObject;
  content: readonly { type: 'text'; text: string }[];
  isError?: boolean;
  /** Client-visible provenance and handling labels; never an authorization input. */
  metadata?: JsonObject;
  /** Internal SDK bridge signal; never serialized as a Tool result field. */
  toolListChanged?: boolean;
  urlElicitation?: {
    elicitationId: string;
    url: string;
    message: string;
  };
}

export interface AgentAccessMcpCallMetadata {
  idempotencyKey?: string;
  elevationChallengeId?: string;
}

export interface AgentAccessMcpResourceDefinition {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  /** Internal authorization contract. This field is never exposed over MCP. */
  authorizationTool: AgentToolDefinition;
  read(context: AgentAccessMcpRequestContext, uri: string): Promise<AgentAccessMcpResourceContents>;
}

export interface AgentAccessMcpResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  metadata?: JsonObject;
}

export interface AgentAccessMcpResourceTemplateDefinition {
  uriTemplate: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  /** Internal authorization contract. This field is never exposed over MCP. */
  authorizationTool: AgentToolDefinition;
  /** Parses only server-defined URI shapes and returns the concrete authorization resource. */
  match(context: AgentAccessMcpRequestContext, uri: string): AgentResourceRequestContext | null;
  read(context: AgentAccessMcpRequestContext, uri: string): Promise<AgentAccessMcpResourceContents>;
}

export interface AgentAccessMcpPromptDefinition {
  name: string;
  title: string;
  description: string;
  arguments?: readonly { name: string; description: string; required: boolean }[];
  /** Internal authorization contract. Prompts are guidance, never authorization evidence. */
  authorizationTool: AgentToolDefinition;
  get(
    context: AgentAccessMcpRequestContext,
    arguments_: Readonly<Record<string, string>>
  ): Promise<AgentAccessMcpPromptResult>;
}

export interface AgentAccessMcpPromptResult {
  description?: string;
  metadata?: JsonObject;
  messages: readonly {
    role: 'user' | 'assistant';
    content: { type: 'text'; text: string };
  }[];
}

export interface AgentAccessMcpServerDependencies {
  toolCatalog: AgentToolCatalog;
  authorization: AgentAuthorizationPort;
  managementApi: ManagementApiPort;
  rateLimiter: AgentRateLimiterPort;
  settings: AgentSettingsPort;
  audit: AgentAuditPort;
  clock: AgentClockPort;
  schemaValidator: AgentJsonSchemaValidatorPort;
  elevation?: AgentElevationPort;
  configurationPlans?: AgentConfigurationPlanPort;
  bulkPlans?: AgentBulkPlanPort;
  runtimeDiagnostics?: AgentRuntimeDiagnosticsPort;
  discoveryProfiles?: AgentDiscoveryProfileStorePort;
  resources?: readonly AgentAccessMcpResourceDefinition[];
  resourceTemplates?: readonly AgentAccessMcpResourceTemplateDefinition[];
  prompts?: readonly AgentAccessMcpPromptDefinition[];
}

function grantSupportsDiscoveryProfiles(
  dependencies: AgentAccessMcpServerDependencies,
  context: AgentAccessMcpRequestContext
): boolean {
  if (!dependencies.discoveryProfiles) return false;
  const control = dependencies.toolCatalog
    .list()
    .find((tool) => tool.id === AGENT_DISCOVERY_PROFILE_CONTROL_TOOL_ID);
  return Boolean(control && agentGrantPinsToolContract(context.grant, control));
}

async function readDiscoveryProfileIds(
  dependencies: AgentAccessMcpServerDependencies
): Promise<{ profileIds?: readonly string[]; readFailed: boolean }> {
  try {
    return {
      profileIds: (await dependencies.discoveryProfiles?.get())?.profileIds,
      readFailed: false,
    };
  } catch {
    return { readFailed: true };
  }
}

async function resolveStoredDiscoveryProfiles(
  dependencies: AgentAccessMcpServerDependencies,
  context: AgentAccessMcpRequestContext,
  grantedToolIds: readonly string[]
): Promise<ReturnType<typeof resolveAgentDiscoveryProfiles>> {
  const fallback = resolveAgentDiscoveryProfiles({ grantedToolIds });
  const stored = await readDiscoveryProfileIds(dependencies);
  if (stored.readFailed) {
    try {
      await writeToolAudit(dependencies, context, 'agent.mcp.discovery_profile.reset', 'failed', {
        reason: 'state_read_failed',
        selected_profile_ids: [...fallback.selectedProfileIds],
      });
    } catch {
      // Discovery state is not an authorization boundary. Keep the minimal fallback even when
      // best-effort recovery telemetry is unavailable.
    }
    return fallback;
  }
  if (!stored.profileIds) return fallback;
  try {
    return resolveAgentDiscoveryProfiles({
      grantedToolIds,
      selectedProfileIds: stored.profileIds,
    });
  } catch {
    let resetPersisted = false;
    try {
      await dependencies.discoveryProfiles?.put({
        profileIds: [...fallback.selectedProfileIds],
        updatedAt: dependencies.clock.now(),
      });
      resetPersisted = true;
    } catch {
      // The current request still uses the minimal fallback. A later request retries repair.
    }
    try {
      await writeToolAudit(
        dependencies,
        context,
        'agent.mcp.discovery_profile.reset',
        resetPersisted ? 'success' : 'failed',
        {
          reason: 'invalid_persisted_selection',
          selected_profile_ids: [...fallback.selectedProfileIds],
          reset_persisted: resetPersisted,
        }
      );
    } catch {
      // Recovery remains fail-safe even when non-authoritative telemetry cannot be written.
    }
    return fallback;
  }
}

async function toolIsActiveInDiscoveryProfile(
  dependencies: AgentAccessMcpServerDependencies,
  context: AgentAccessMcpRequestContext,
  tool: AgentToolDefinition
): Promise<boolean> {
  if (!grantSupportsDiscoveryProfiles(dependencies, context)) return true;
  if (tool.id === AGENT_DISCOVERY_PROFILE_CONTROL_TOOL_ID) return true;
  const resolved = await resolveStoredDiscoveryProfiles(
    dependencies,
    context,
    context.grant.resolvedTools?.map((item) => item.toolId) ?? []
  );
  return resolved.visibleToolIds.has(tool.id);
}

export interface AgentAccessMcpServer {
  readonly protocolRevision: '2025-11-25';
  listTools(context: AgentAccessMcpRequestContext): Promise<ReturnType<AgentToolCatalog['list']>>;
  callTool(
    context: AgentAccessMcpRequestContext,
    name: string,
    input: JsonObject,
    metadata?: AgentAccessMcpCallMetadata
  ): Promise<AgentAccessMcpToolResult>;
  listResources(
    context: AgentAccessMcpRequestContext
  ): Promise<readonly AgentAccessMcpResourceDefinition[]>;
  listResourceTemplates(
    context: AgentAccessMcpRequestContext
  ): Promise<readonly AgentAccessMcpResourceTemplateDefinition[]>;
  readResource(
    context: AgentAccessMcpRequestContext,
    uri: string
  ): Promise<AgentAccessMcpResourceContents>;
  listPrompts(
    context: AgentAccessMcpRequestContext
  ): Promise<readonly AgentAccessMcpPromptDefinition[]>;
  getPrompt(
    context: AgentAccessMcpRequestContext,
    name: string,
    arguments_?: Readonly<Record<string, string>>
  ): Promise<AgentAccessMcpPromptResult>;
}

function toStructuredContent(value: JsonValue): JsonObject {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
  return { result: value };
}

async function publicClientStandardIdempotencyKey(
  context: AgentAccessMcpRequestContext,
  tool: AgentToolDefinition,
  input: JsonObject
): Promise<string> {
  const digest = await sha256Base64Url(
    canonicalizeJson({
      purpose: 'authrim-public-client-standard-write-v1',
      tenant_id: context.grant.tenantId,
      grant_id: context.grant.grantId,
      grant_generation: context.grant.generation,
      actor_sub: context.actor.sub,
      tool_id: tool.id,
      input,
    })
  );
  return `agent-mode-a:${digest}`;
}

async function writeToolAudit(
  dependencies: AgentAccessMcpServerDependencies,
  context: AgentAccessMcpRequestContext,
  eventType: string,
  outcome: 'success' | 'denied' | 'failed' | 'indeterminate',
  details: JsonObject
): Promise<void> {
  const toolId = typeof details.tool_id === 'string' ? details.tool_id : undefined;
  const tool = toolId
    ? dependencies.toolCatalog.list().find((candidate) => candidate.id === toolId)
    : undefined;
  const principalId = context.actor.machinePrincipalId ?? context.grant.machinePrincipalId;
  await dependencies.audit.write({
    eventType,
    tenantId: context.grant.tenantId,
    occurredAt: dependencies.clock.now(),
    correlationId: context.correlationId,
    actor: {
      actorSub: context.actor.sub,
      actorMode: context.actor.mode,
      actorAssurance: context.actor.assurance,
      tokenBinding: context.actor.tokenBinding,
      clientId: context.actor.clientId,
      ...(principalId === undefined ? {} : { principalId }),
      delegatorId: context.grant.delegatorId,
      grantId: context.grant.grantId,
    },
    outcome,
    details: {
      catalog_version: dependencies.toolCatalog.version,
      grant_generation: context.grant.generation,
      consent_version: context.grant.consentVersion,
      task_set_id: context.grant.taskSetId ?? null,
      task_set_version: context.grant.taskSetVersion ?? null,
      access_snapshot_hash: context.grant.accessSnapshotHash ?? null,
      tool_contract_digest: tool?.schemaDigest ?? null,
      ...details,
    },
  });
}

function dataProvenance(
  dependencies: AgentAccessMcpServerDependencies,
  context: AgentAccessMcpRequestContext,
  source: 'management_api' | 'resource' | 'server_prompt',
  toolId: string,
  sensitivity: 'configuration' | 'personal_data' | 'guidance'
): JsonObject {
  return {
    'com.authrim/dataProvenance': {
      source,
      trust_level: source === 'server_prompt' ? 'server_authored' : 'tenant_data_untrusted',
      sensitivity,
      tenant_id: context.grant.tenantId,
      grant_id: context.grant.grantId,
      tool_id: toolId,
      correlation_id: context.correlationId,
      observed_at: dependencies.clock.now(),
    },
  };
}

async function completeElevationSafely(
  dependencies: AgentAccessMcpServerDependencies,
  completion: AgentElevationCompletion
): Promise<boolean> {
  if (!dependencies.elevation) return false;
  try {
    return await dependencies.elevation.complete(completion);
  } catch {
    return false;
  }
}

/**
 * Builds the platform-neutral MCP application definition. A platform adapter registers this
 * definition with its transport/runtime (for example Cloudflare McpAgent) instead of defining
 * tools directly inside a runtime class.
 */
export function createAgentAccessMcpServer(
  dependencies: AgentAccessMcpServerDependencies
): AgentAccessMcpServer {
  const resources = Object.freeze([...(dependencies.resources ?? [])]);
  const resourceTemplates = Object.freeze([...(dependencies.resourceTemplates ?? [])]);
  const prompts = Object.freeze([...(dependencies.prompts ?? [])]);

  async function listAuthorizedTools(context: AgentAccessMcpRequestContext) {
    const visible = [];
    for (const tool of dependencies.toolCatalog.list()) {
      const resource = buildAgentToolResourceContext({
        base: context.resource,
        toolId: tool.id,
        arguments: {},
      });
      const decision = await dependencies.authorization.authorize({
        actor: context.actor,
        grant: context.grant,
        tool,
        resource,
      });
      if (decision.allowed || decision.requiresElevation) visible.push(tool);
    }
    return visible;
  }

  async function listProfiledTools(context: AgentAccessMcpRequestContext) {
    const authorized = await listAuthorizedTools(context);
    if (!grantSupportsDiscoveryProfiles(dependencies, context)) return authorized;
    const resolved = await resolveStoredDiscoveryProfiles(
      dependencies,
      context,
      authorized.map((tool) => tool.id)
    );
    return authorized.filter((tool) => resolved.visibleToolIds.has(tool.id));
  }

  return {
    protocolRevision: '2025-11-25',
    async listTools(context) {
      return listProfiledTools(context);
    },
    async callTool(context, name, input, metadata = {}) {
      const tool = dependencies.toolCatalog.get(name);
      if (!tool) {
        await writeToolAudit(dependencies, context, 'agent.mcp.tool.denied', 'denied', {
          reason: 'unknown_tool',
        });
        return { content: [{ type: 'text', text: 'Unknown tool' }], isError: true };
      }
      const inputValidation = dependencies.schemaValidator.validate(tool.inputSchema, input);
      if (!inputValidation.valid) {
        await writeToolAudit(dependencies, context, 'agent.mcp.tool.denied', 'denied', {
          tool_id: tool.id,
          denied_axis: 'input_schema',
          code: 'AGENT_INVALID_TOOL_ARGUMENTS',
        });
        return {
          content: [{ type: 'text', text: 'Invalid tool arguments' }],
          isError: true,
        };
      }
      if (!(await toolIsActiveInDiscoveryProfile(dependencies, context, tool))) {
        await writeToolAudit(dependencies, context, 'agent.mcp.tool.denied', 'denied', {
          tool_id: tool.id,
          denied_axis: 'discovery_profile',
          code: 'AGENT_TOOL_PROFILE_INACTIVE',
        });
        return {
          content: [
            {
              type: 'text',
              text: 'AGENT_TOOL_PROFILE_INACTIVE: Tool is outside the active discovery profiles. Use set_active_tool_profiles first.',
            },
          ],
          isError: true,
        };
      }
      const requestDigest = await sha256Base64Url(
        canonicalizeJson({
          purpose: 'authrim-agent-tool-request-v1',
          tenant_id: context.grant.tenantId,
          grant_id: context.grant.grantId,
          grant_generation: context.grant.generation,
          actor_sub: context.actor.sub,
          tool_id: tool.id,
          tool_contract_digest: tool.schemaDigest,
          input,
        })
      );
      const resource = buildAgentToolResourceContext({
        base: context.resource,
        toolId: tool.id,
        arguments: input,
      });
      let decision = await dependencies.authorization.authorize({
        actor: context.actor,
        grant: context.grant,
        tool,
        resource,
      });
      let elevatedExecution:
        | {
            challengeId: string;
            executionAttempt: number;
            executionFence: number;
            executionToken: string;
            idempotencyKey: string;
          }
        | undefined;
      if (!decision.allowed && !decision.requiresElevation) {
        await writeToolAudit(dependencies, context, 'agent.mcp.tool.denied', 'denied', {
          tool_id: tool.id,
          denied_axis: decision.deniedAxis ?? 'unknown',
          code: decision.code ?? 'AGENT_ACCESS_DENIED',
        });
        return {
          content: [{ type: 'text', text: decision.code ?? 'Access denied' }],
          isError: true,
        };
      }
      let settings;
      try {
        settings = await dependencies.settings.get(context.grant.tenantId);
      } catch {
        await writeToolAudit(dependencies, context, 'agent.mcp.tool.denied', 'denied', {
          tool_id: tool.id,
          denied_axis: 'settings',
          code: 'AGENT_SETTINGS_UNAVAILABLE',
        });
        return { content: [{ type: 'text', text: 'Agent settings unavailable' }], isError: true };
      }
      if (!settings.enabled) {
        await writeToolAudit(dependencies, context, 'agent.mcp.tool.denied', 'denied', {
          tool_id: tool.id,
          denied_axis: 'feature_flag',
          code: 'AGENT_MCP_DISABLED',
        });
        return { content: [{ type: 'text', text: 'Agent access disabled' }], isError: true };
      }
      const publicClientStandardCall =
        context.actor.assurance === 'public_client_transaction' &&
        tool.riskLevel === 'standard' &&
        (settings.publicClientStandardToolIds ?? []).includes(tool.id);
      let rate;
      try {
        rate = await dependencies.rateLimiter.consume({
          key: `${context.grant.tenantId}:${context.grant.grantId}:${tool.id}`,
          limit: publicClientStandardCall
            ? Math.min(
                settings.rateLimitPerMinute,
                settings.publicClientStandardRateLimitPerMinute ?? 10
              )
            : settings.rateLimitPerMinute,
          windowSeconds: 60,
        });
      } catch {
        await writeToolAudit(dependencies, context, 'agent.mcp.tool.failed', 'failed', {
          tool_id: tool.id,
          code: 'AGENT_RATE_LIMIT_UNAVAILABLE',
        });
        return { content: [{ type: 'text', text: 'Rate limit unavailable' }], isError: true };
      }
      if (!rate.allowed) {
        await writeToolAudit(dependencies, context, 'agent.mcp.tool.rate_limited', 'denied', {
          tool_id: tool.id,
          reset_at: rate.resetAt,
        });
        return { content: [{ type: 'text', text: 'Rate limit exceeded' }], isError: true };
      }
      if (tool.executionTarget === 'access_introspection') {
        const decisions: Array<{
          tool: AgentToolDefinition;
          decision: AgentAuthorizationDecision;
        }> = [];
        for (const candidate of dependencies.toolCatalog.list()) {
          if (!agentGrantPinsToolContract(context.grant, candidate)) {
            decisions.push({
              tool: candidate,
              decision: {
                allowed: false,
                requiresElevation: false,
                deniedAxis: 'grant',
                code: 'AGENT_TOOL_NOT_IN_TASK_SET',
              },
            });
            continue;
          }
          const candidateResource = buildAgentToolResourceContext({
            base: context.resource,
            toolId: candidate.id,
            arguments: {},
          });
          const candidateDecision = await dependencies.authorization.authorize({
            actor: context.actor,
            grant: context.grant,
            tool: candidate,
            resource: candidateResource,
          });
          decisions.push({ tool: candidate, decision: candidateDecision });
        }
        const toolSummary = (entry: (typeof decisions)[number]): JsonObject => ({
          id: entry.tool.id,
          name: entry.tool.name,
          required_scope: entry.tool.requiredScope,
          required_permissions: [...entry.tool.requiredPermissions],
          risk_level: entry.tool.riskLevel,
        });
        const allowed = decisions.filter((entry) => entry.decision.allowed);
        const elevationRequired = decisions.filter(
          (entry) => !entry.decision.allowed && entry.decision.requiresElevation
        );
        const denied = decisions.filter(
          (entry) => !entry.decision.allowed && !entry.decision.requiresElevation
        );
        const deniedByAxis: JsonObject = {};
        for (const entry of denied) {
          const axis = entry.decision.deniedAxis ?? 'unknown';
          const current = deniedByAxis[axis];
          deniedByAxis[axis] = typeof current === 'number' ? current + 1 : 1;
        }
        const includeDenied = input.include_denied === true;
        const body: JsonObject = {
          subject: {
            current_agent_only: true,
            tenant_id: context.grant.tenantId,
            grant_id: context.grant.grantId,
            client_id: context.grant.clientId,
            machine_principal_id: context.grant.machinePrincipalId ?? null,
            actor_mode: context.actor.mode,
            actor_assurance: context.actor.assurance,
            token_binding: context.actor.tokenBinding,
            grant_status: context.grant.status,
            expires_at: context.grant.expiresAt ?? null,
            scopes: [...context.grant.scopes],
            permissions: [...context.grant.permissions],
            task_set: {
              id: context.grant.taskSetId ?? null,
              version: context.grant.taskSetVersion ?? null,
            },
            scope_policy: {
              id: context.grant.scopePolicyId ?? null,
              version: context.grant.scopePolicyVersion ?? null,
            },
          },
          summary: {
            authority_source: 'live_agent_grant_evaluation',
            oauth_client_scope_is_not_effective_authority: true,
            catalog_tool_count: decisions.length,
            configured_tool_count: context.grant.resolvedTools?.length ?? 0,
            allowed_tool_count: allowed.length,
            elevation_required_tool_count: elevationRequired.length,
            denied_tool_count: denied.length,
          },
          allowed_tools: allowed.map(toolSummary),
          elevation_required_tools: elevationRequired.map((entry) => ({
            ...toolSummary(entry),
            denied_axis: entry.decision.deniedAxis ?? 'risk',
            code: entry.decision.code ?? 'AGENT_ELEVATION_REQUIRED',
          })),
          denied_by_axis: deniedByAxis,
          denied_tools: includeDenied
            ? denied.map((entry) => ({
                ...toolSummary(entry),
                denied_axis: entry.decision.deniedAxis ?? 'unknown',
                code: entry.decision.code ?? 'AGENT_ACCESS_DENIED',
              }))
            : [],
        };
        await writeToolAudit(dependencies, context, 'agent.mcp.tool.executed', 'success', {
          tool_id: tool.id,
          include_denied: includeDenied,
          allowed_tool_count: allowed.length,
          elevation_required_tool_count: elevationRequired.length,
          denied_tool_count: denied.length,
        });
        return {
          structuredContent: body,
          content: [{ type: 'text', text: JSON.stringify(body) }],
        };
      }
      if (tool.executionTarget === 'session_control') {
        if (!dependencies.discoveryProfiles) {
          await writeToolAudit(dependencies, context, 'agent.mcp.tool.failed', 'failed', {
            tool_id: tool.id,
            code: 'AGENT_DISCOVERY_PROFILE_STATE_UNAVAILABLE',
          });
          return {
            content: [
              {
                type: 'text',
                text: 'AGENT_DISCOVERY_PROFILE_STATE_UNAVAILABLE: Discovery profile state unavailable',
              },
            ],
            isError: true,
          };
        }
        const profileIds = Array.isArray(input.profile_ids)
          ? input.profile_ids.filter((value): value is string => typeof value === 'string')
          : [];
        let resolved;
        try {
          const authorizedTools = await listAuthorizedTools(context);
          resolved = resolveAgentDiscoveryProfiles({
            grantedToolIds: authorizedTools.map((item) => item.id),
            selectedProfileIds: profileIds,
          });
        } catch {
          await writeToolAudit(dependencies, context, 'agent.mcp.tool.denied', 'denied', {
            tool_id: tool.id,
            denied_axis: 'discovery_profile',
            code: 'AGENT_DISCOVERY_PROFILE_INVALID_SELECTION',
            requested_profile_ids: profileIds,
          });
          return {
            content: [
              {
                type: 'text',
                text: 'AGENT_DISCOVERY_PROFILE_INVALID_SELECTION: Invalid discovery profile selection',
              },
            ],
            isError: true,
          };
        }
        const availableIds = new Set(resolved.availableProfiles.map((profile) => profile.id));
        if (profileIds.some((profileId) => !availableIds.has(profileId))) {
          await writeToolAudit(dependencies, context, 'agent.mcp.tool.denied', 'denied', {
            tool_id: tool.id,
            denied_axis: 'grant',
            code: 'AGENT_DISCOVERY_PROFILE_NOT_GRANTED',
            requested_profile_ids: profileIds,
          });
          return {
            content: [
              {
                type: 'text',
                text: 'AGENT_DISCOVERY_PROFILE_NOT_GRANTED: One or more discovery profiles contain no granted tools',
              },
            ],
            isError: true,
          };
        }
        try {
          await dependencies.discoveryProfiles.put({
            profileIds: [...resolved.selectedProfileIds],
            updatedAt: dependencies.clock.now(),
          });
        } catch {
          await writeToolAudit(dependencies, context, 'agent.mcp.tool.failed', 'failed', {
            tool_id: tool.id,
            code: 'AGENT_DISCOVERY_PROFILE_STATE_UNAVAILABLE',
          });
          return {
            content: [
              {
                type: 'text',
                text: 'AGENT_DISCOVERY_PROFILE_STATE_UNAVAILABLE: Discovery profile state unavailable',
              },
            ],
            isError: true,
          };
        }
        const body: JsonObject = {
          selected_profile_ids: [...resolved.selectedProfileIds],
          visible_tool_count: resolved.visibleToolIds.size,
          available_profiles: resolved.availableProfiles.map((profile) => ({
            id: profile.id,
            title: profile.title,
            description: profile.description,
            granted_tool_count: profile.grantedToolCount,
          })),
        };
        await writeToolAudit(
          dependencies,
          context,
          'agent.mcp.discovery_profile.changed',
          'success',
          {
            tool_id: tool.id,
            selected_profile_ids: [...resolved.selectedProfileIds],
            visible_tool_count: resolved.visibleToolIds.size,
          }
        );
        return {
          structuredContent: body,
          content: [{ type: 'text', text: JSON.stringify(body) }],
          toolListChanged: true,
        };
      }
      if (!decision.allowed && decision.requiresElevation) {
        if (!dependencies.elevation) {
          await writeToolAudit(dependencies, context, 'agent.mcp.tool.denied', 'denied', {
            tool_id: tool.id,
            denied_axis: 'risk',
            code: 'AGENT_ELEVATION_UNAVAILABLE',
          });
          return { content: [{ type: 'text', text: 'Elevation unavailable' }], isError: true };
        }
        let elevation;
        try {
          elevation = await dependencies.elevation.resolve({
            actor: context.actor,
            grant: context.grant,
            tool,
            resource,
            input,
            challengeId: metadata.elevationChallengeId,
            issuerOrigin: context.issuerOrigin,
            correlationId: context.correlationId,
          });
        } catch {
          await writeToolAudit(dependencies, context, 'agent.mcp.tool.denied', 'denied', {
            tool_id: tool.id,
            denied_axis: 'risk',
            code: 'AGENT_ELEVATION_STATE_UNAVAILABLE',
          });
          return {
            content: [{ type: 'text', text: 'Elevation state unavailable' }],
            isError: true,
          };
        }
        if (elevation.status === 'required') {
          await writeToolAudit(dependencies, context, 'agent.elevation.requested', 'success', {
            tool_id: tool.id,
            elevation_id: elevation.challengeId,
            expires_at: elevation.expiresAt,
          });
          return {
            content: [{ type: 'text', text: 'Human approval is required' }],
            isError: true,
            urlElicitation: {
              elicitationId: elevation.challengeId,
              url: elevation.url,
              message: elevation.message,
            },
          };
        }
        elevatedExecution = elevation;
        decision = await dependencies.authorization.authorize({
          actor: context.actor,
          grant: context.grant,
          tool,
          resource,
          elevationCapabilityValid: true,
        });
        if (!decision.allowed) {
          const completed = await completeElevationSafely(dependencies, {
            tenantId: context.grant.tenantId,
            challengeId: elevatedExecution.challengeId,
            executionAttempt: elevatedExecution.executionAttempt,
            executionFence: elevatedExecution.executionFence,
            executionToken: elevatedExecution.executionToken,
            status: 'failed',
            correlationId: context.correlationId,
          });
          await writeToolAudit(
            dependencies,
            context,
            completed ? 'agent.mcp.tool.denied' : 'agent.elevation.indeterminate',
            completed ? 'denied' : 'indeterminate',
            {
              tool_id: tool.id,
              elevation_id: elevatedExecution.challengeId,
              denied_axis: decision.deniedAxis ?? 'unknown',
              code: decision.code ?? 'AGENT_ACCESS_DENIED',
            }
          );
          return {
            content: [
              {
                type: 'text',
                text: completed
                  ? (decision.code ?? 'Access denied')
                  : 'Operation result is indeterminate',
              },
            ],
            isError: true,
          };
        }
      }
      let result;
      try {
        const idempotencyKey = elevatedExecution?.idempotencyKey
          ? elevatedExecution.idempotencyKey
          : publicClientStandardCall
            ? await publicClientStandardIdempotencyKey(context, tool, input)
            : metadata.idempotencyKey;
        const operationRequest = {
          operation: tool.id,
          actor: context.actor,
          grant: context.grant,
          issuerOrigin: context.issuerOrigin,
          correlationId: context.correlationId,
          input,
        };
        result =
          dependencies.configurationPlans && tool.executionTarget === 'configuration_plan'
            ? await dependencies.configurationPlans.execute(operationRequest)
            : dependencies.bulkPlans && tool.executionTarget === 'bulk_plan'
              ? await dependencies.bulkPlans.execute(operationRequest)
              : dependencies.runtimeDiagnostics && tool.executionTarget === 'runtime_diagnostics'
                ? await dependencies.runtimeDiagnostics.inspect(operationRequest)
                : await dependencies.managementApi.execute({
                    operation: tool.id,
                    tenantId: context.grant.tenantId,
                    authorization: {
                      actor: context.actor,
                      grantId: context.grant.grantId,
                      grantGeneration: context.grant.generation,
                      delegatorId: context.grant.delegatorId,
                      consentVersion: context.grant.consentVersion,
                      effectivePermissions: tool.requiredPermissions,
                      audience: 'authrim:admin-api',
                      issuerOrigin: context.issuerOrigin,
                      correlationId: context.correlationId,
                    },
                    idempotencyKey,
                    input,
                  });
      } catch {
        if (elevatedExecution) {
          const completed = await completeElevationSafely(dependencies, {
            tenantId: context.grant.tenantId,
            challengeId: elevatedExecution.challengeId,
            executionAttempt: elevatedExecution.executionAttempt,
            executionFence: elevatedExecution.executionFence,
            executionToken: elevatedExecution.executionToken,
            status: 'indeterminate',
            correlationId: context.correlationId,
          });
          await writeToolAudit(
            dependencies,
            context,
            'agent.elevation.indeterminate',
            'indeterminate',
            {
              tool_id: tool.id,
              elevation_id: elevatedExecution.challengeId,
              reason: completed
                ? 'owner_transport_outcome_unknown'
                : 'owner_transport_and_terminal_state_unknown',
            }
          );
          return {
            content: [{ type: 'text', text: 'Operation result is indeterminate' }],
            isError: true,
          };
        }
        await writeToolAudit(dependencies, context, 'agent.mcp.tool.failed', 'failed', {
          tool_id: tool.id,
          code: 'AGENT_MANAGEMENT_API_UNAVAILABLE',
        });
        return { content: [{ type: 'text', text: 'Management API unavailable' }], isError: true };
      }
      if ('urlElicitation' in result && result.urlElicitation) {
        return {
          content: [{ type: 'text', text: result.urlElicitation.message }],
          isError: true,
          urlElicitation: result.urlElicitation,
        };
      }
      if (elevatedExecution) {
        const elevationTerminalStatus =
          result.executionStatus === 'indeterminate'
            ? 'indeterminate'
            : result.status >= 200 && result.status < 300
              ? 'consumed'
              : 'failed';
        const completed = await completeElevationSafely(dependencies, {
          tenantId: context.grant.tenantId,
          challengeId: elevatedExecution.challengeId,
          executionAttempt: elevatedExecution.executionAttempt,
          executionFence: elevatedExecution.executionFence,
          executionToken: elevatedExecution.executionToken,
          status: elevationTerminalStatus,
          result: result.body,
          correlationId: context.correlationId,
        });
        if (!completed) {
          await writeToolAudit(
            dependencies,
            context,
            'agent.elevation.indeterminate',
            'indeterminate',
            {
              tool_id: tool.id,
              elevation_id: elevatedExecution.challengeId,
              reason: 'terminal_state_not_persisted',
            }
          );
          return {
            content: [{ type: 'text', text: 'Operation result is indeterminate' }],
            isError: true,
          };
        }
        if (elevationTerminalStatus === 'indeterminate') {
          await writeToolAudit(
            dependencies,
            context,
            'agent.elevation.indeterminate',
            'indeterminate',
            {
              tool_id: tool.id,
              elevation_id: elevatedExecution.challengeId,
              reason: 'owner_execution_indeterminate',
            }
          );
          return {
            content: [{ type: 'text', text: 'Operation result is indeterminate' }],
            isError: true,
          };
        }
        await writeToolAudit(
          dependencies,
          context,
          elevationTerminalStatus === 'consumed'
            ? 'agent.elevation.consumed'
            : 'agent.elevation.failed',
          elevationTerminalStatus === 'consumed' ? 'success' : 'failed',
          {
            tool_id: tool.id,
            elevation_id: elevatedExecution.challengeId,
            management_status: result.status,
          }
        );
      }
      if (result.status >= 200 && result.status < 300 && tool.outputSchema) {
        const outputValidation = dependencies.schemaValidator.validate(
          tool.outputSchema,
          result.body
        );
        if (!outputValidation.valid) {
          await writeToolAudit(dependencies, context, 'agent.mcp.tool.failed', 'failed', {
            tool_id: tool.id,
            code: 'AGENT_INVALID_OWNER_RESPONSE',
          });
          return {
            content: [{ type: 'text', text: 'Owner API returned an invalid response' }],
            isError: true,
          };
        }
      }
      await writeToolAudit(
        dependencies,
        context,
        'agent.mcp.tool.executed',
        result.status >= 200 && result.status < 300 ? 'success' : 'failed',
        { tool_id: tool.id, request_digest: requestDigest, management_status: result.status }
      );
      return {
        structuredContent: toStructuredContent(result.body),
        content: [{ type: 'text', text: JSON.stringify(result.body) }],
        isError: result.status < 200 || result.status >= 300,
        metadata: dataProvenance(
          dependencies,
          context,
          'management_api',
          tool.id,
          tool.requiredScope === 'agent:user-data:read' ? 'personal_data' : 'configuration'
        ),
      };
    },
    async listResources(context) {
      const visible = [];
      for (const resource of resources) {
        const decision = await dependencies.authorization.authorize({
          actor: context.actor,
          grant: context.grant,
          tool: resource.authorizationTool,
          resource: context.resource,
        });
        if (decision.allowed) visible.push(resource);
      }
      return visible;
    },
    async readResource(context, uri) {
      const definition = resources.find((resource) => resource.uri === uri);
      const template = definition
        ? undefined
        : resourceTemplates
            .map((candidate) => ({ candidate, resource: candidate.match(context, uri) }))
            .find((candidate) => candidate.resource !== null);
      if (!definition && !template) {
        await writeToolAudit(dependencies, context, 'agent.mcp.resource.denied', 'denied', {
          reason: 'unknown_resource',
        });
        throw new TypeError('Unknown MCP resource');
      }
      const selected = definition ?? template!.candidate;
      const decision = await dependencies.authorization.authorize({
        actor: context.actor,
        grant: context.grant,
        tool: selected.authorizationTool,
        resource: template?.resource ?? context.resource,
      });
      if (!decision.allowed) {
        await writeToolAudit(dependencies, context, 'agent.mcp.resource.denied', 'denied', {
          tool_id: selected.authorizationTool.id,
          resource_name: selected.name,
          denied_axis: decision.deniedAxis ?? 'unknown',
        });
        throw new TypeError('MCP resource access denied');
      }
      let contents: AgentAccessMcpResourceContents;
      try {
        contents = await selected.read(context, uri);
      } catch {
        await writeToolAudit(dependencies, context, 'agent.mcp.resource.failed', 'failed', {
          tool_id: selected.authorizationTool.id,
          resource_name: selected.name,
        });
        throw new TypeError('MCP resource unavailable');
      }
      await writeToolAudit(dependencies, context, 'agent.mcp.resource.read', 'success', {
        tool_id: selected.authorizationTool.id,
        resource_name: selected.name,
      });
      return {
        ...contents,
        metadata: dataProvenance(
          dependencies,
          context,
          'resource',
          selected.authorizationTool.id,
          'configuration'
        ),
      };
    },
    async listResourceTemplates(context) {
      const visible = [];
      for (const template of resourceTemplates) {
        const decision = await dependencies.authorization.authorize({
          actor: context.actor,
          grant: context.grant,
          tool: template.authorizationTool,
          resource: context.resource,
        });
        if (decision.allowed) visible.push(template);
      }
      return visible;
    },
    async listPrompts(context) {
      const visible = [];
      for (const prompt of prompts) {
        const decision = await dependencies.authorization.authorize({
          actor: context.actor,
          grant: context.grant,
          tool: prompt.authorizationTool,
          resource: context.resource,
        });
        if (decision.allowed) visible.push(prompt);
      }
      return visible;
    },
    async getPrompt(context, name, arguments_ = {}) {
      const definition = prompts.find((prompt) => prompt.name === name);
      if (!definition) {
        await writeToolAudit(dependencies, context, 'agent.mcp.prompt.denied', 'denied', {
          reason: 'unknown_prompt',
        });
        throw new TypeError('Unknown MCP prompt');
      }
      const decision = await dependencies.authorization.authorize({
        actor: context.actor,
        grant: context.grant,
        tool: definition.authorizationTool,
        resource: context.resource,
      });
      if (!decision.allowed) {
        await writeToolAudit(dependencies, context, 'agent.mcp.prompt.denied', 'denied', {
          tool_id: definition.authorizationTool.id,
          prompt_name: definition.name,
          denied_axis: decision.deniedAxis ?? 'unknown',
        });
        throw new TypeError('MCP prompt access denied');
      }
      let result: AgentAccessMcpPromptResult;
      try {
        result = await definition.get(context, arguments_);
      } catch {
        await writeToolAudit(dependencies, context, 'agent.mcp.prompt.failed', 'failed', {
          tool_id: definition.authorizationTool.id,
          prompt_name: definition.name,
        });
        throw new TypeError('MCP prompt unavailable');
      }
      await writeToolAudit(dependencies, context, 'agent.mcp.prompt.get', 'success', {
        tool_id: definition.authorizationTool.id,
        prompt_name: definition.name,
      });
      return {
        ...result,
        metadata: dataProvenance(
          dependencies,
          context,
          'server_prompt',
          definition.authorizationTool.id,
          'guidance'
        ),
      };
    },
  };
}
