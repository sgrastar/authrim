import { hasAdminPermission } from '@authrim/ar-lib-core/types/admin-user';
import { BUILTIN_AGENT_TASK_SET_PRESETS } from './builtin-task-sets';
import { canonicalizeJson, sha256Base64Url } from './canonical-json';
import {
  normalizeAgentScopePolicy,
  resolveAgentTaskSetVersion,
  type AgentScopePolicyDefinition,
} from './configuration';
import type { AgentToolCatalog } from './tool-catalog';
import type {
  AgentResolvedToolContract,
  AgentScope,
  AgentScopeConstraints,
  JsonObject,
  JsonValue,
} from './types';

export const SELF_SERVICE_AGENT_SCOPES = [
  'agent:read',
  'agent:user-data:read',
  'agent:write',
] as const satisfies readonly AgentScope[];

export const SELF_SERVICE_GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SELF_SERVICE_MAX_SUBJECTS_PER_CALL = 50;

function containsClientIdDotSegment(clientId: string): boolean {
  const authorityEnd = clientId.indexOf('/', 'https://'.length);
  if (authorityEnd < 0) return false;
  const rawPath = clientId.slice(authorityEnd).split(/[?#]/u, 1)[0];
  return rawPath.split('/').some((segment) => {
    try {
      const decoded = decodeURIComponent(segment);
      return decoded === '.' || decoded === '..';
    } catch {
      return true;
    }
  });
}

/** Strict Client ID Metadata Document identifier accepted across authorize, token, and refresh. */
export function isSelfServiceClientMetadataDocumentId(clientId: string): boolean {
  try {
    const url = new URL(clientId);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.hash === '' &&
      url.pathname !== '/' &&
      !containsClientIdDotSegment(clientId) &&
      clientId.length <= 2048
    );
  } catch {
    return false;
  }
}

export function selfServiceRevocationOutboxId(transitionId: string): string {
  if (!transitionId || transitionId.length > 128) {
    throw new TypeError('Self-service transition ID is invalid');
  }
  return `outbox_${transitionId}`;
}

export interface SelfServiceAgentAuthorizationDetails {
  authorizationDetails?: JsonObject[];
  maxSubjectsPerCall: number;
}

/**
 * Validates the Admin Agent RAR profile and resolves its effective per-call subject ceiling.
 * Repeated details are treated as independent restrictions, so the narrowest ceiling wins.
 */
export function normalizeSelfServiceAgentAuthorizationDetails(
  value: unknown
): SelfServiceAgentAuthorizationDetails {
  if (value === undefined) {
    return { maxSubjectsPerCall: SELF_SERVICE_MAX_SUBJECTS_PER_CALL };
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new TypeError('authorization_details is outside the Admin Agent contract');
  }

  const authorizationDetails: JsonObject[] = [];
  let maxSubjectsPerCall = SELF_SERVICE_MAX_SUBJECTS_PER_CALL;
  for (const detail of value) {
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
      throw new TypeError('authorization_details is outside the Admin Agent contract');
    }
    const record = detail as Record<string, unknown>;
    if (
      record.type !== 'authrim_admin_agent' ||
      Object.keys(record).some((key) => !['type', 'max_subjects_per_call'].includes(key))
    ) {
      throw new TypeError('authorization_details is outside the Admin Agent contract');
    }
    const requestedMaximum = record.max_subjects_per_call;
    if (
      requestedMaximum !== undefined &&
      (!Number.isSafeInteger(requestedMaximum) ||
        (requestedMaximum as number) < 1 ||
        (requestedMaximum as number) > SELF_SERVICE_MAX_SUBJECTS_PER_CALL)
    ) {
      throw new TypeError('authorization_details is outside the Admin Agent contract');
    }
    const normalized: JsonObject = { type: 'authrim_admin_agent' };
    if (typeof requestedMaximum === 'number') {
      normalized.max_subjects_per_call = requestedMaximum;
      maxSubjectsPerCall = Math.min(maxSubjectsPerCall, requestedMaximum);
    }
    authorizationDetails.push(normalized);
  }

  return { authorizationDetails, maxSubjectsPerCall };
}

export interface SelfServiceAgentAccessSnapshot {
  taskSetId: string;
  taskSetVersion: number;
  scopePolicyId: string;
  scopePolicyVersion: number;
  resolvedTools: AgentResolvedToolContract[];
  permissions: string[];
  scopes: AgentScope[];
  resolvedScopeConstraints: AgentScopeConstraints;
  taskSetDigest: string;
  taskSetResolved: Awaited<ReturnType<typeof resolveAgentTaskSetVersion>>;
  scopePolicyDefinition: AgentScopePolicyDefinition;
  scopePolicyDigest: string;
  accessSnapshotHash: string;
}

function presetToolIds(
  name: 'read_only_inspector' | 'user_data_reader' | 'configuration_operator'
) {
  const preset = BUILTIN_AGENT_TASK_SET_PRESETS.find((candidate) => candidate.name === name);
  if (!preset) throw new TypeError(`Required built-in Task Set is unavailable: ${name}`);
  return preset.toolIds;
}

export function normalizeSelfServiceAgentScopes(values: readonly string[]): AgentScope[] {
  const allowed = new Set<string>(SELF_SERVICE_AGENT_SCOPES);
  const scopes = [...new Set(values.filter(Boolean))];
  if (!scopes.includes('agent:read')) {
    throw new TypeError('Self-service Agent access requires agent:read');
  }
  if (scopes.some((scope) => !allowed.has(scope))) {
    throw new TypeError('Self-service Agent access scope is not supported');
  }
  return SELF_SERVICE_AGENT_SCOPES.filter((scope) => scopes.includes(scope));
}

/**
 * Builds the immutable, tenant-bound control-plane snapshot used by an interactive Mode A Grant.
 * Only Tools covered by both an approved OAuth scope and the live Admin RBAC ceiling are pinned.
 */
export async function resolveSelfServiceAgentAccessSnapshot(input: {
  tenantId: string;
  adminUserId: string;
  clientId: string;
  grantId: string;
  taskSetId?: string;
  taskSetVersion?: number;
  scopePolicyId?: string;
  scopePolicyVersion?: number;
  approvedScopes: readonly string[];
  authorizationDetails?: readonly JsonObject[];
  adminPermissions: readonly string[];
  catalog: AgentToolCatalog;
  expiresAt: number;
}): Promise<SelfServiceAgentAccessSnapshot> {
  const scopes = normalizeSelfServiceAgentScopes(input.approvedScopes);
  const { maxSubjectsPerCall } = normalizeSelfServiceAgentAuthorizationDetails(
    input.authorizationDetails
  );
  const candidateIds = new Set<string>(presetToolIds('read_only_inspector'));
  if (scopes.includes('agent:user-data:read')) {
    for (const id of presetToolIds('user_data_reader')) candidateIds.add(id);
  }
  if (scopes.includes('agent:write')) {
    for (const id of presetToolIds('configuration_operator')) candidateIds.add(id);
  }

  const toolsById = new Map(input.catalog.list().map((tool) => [tool.id, tool]));
  const allowedToolIds = [...candidateIds].filter((id) => {
    const tool = toolsById.get(id);
    return Boolean(
      tool &&
      scopes.includes(tool.requiredScope) &&
      tool.requiredPermissions.every((permission) =>
        hasAdminPermission([...input.adminPermissions], permission)
      )
    );
  });
  if (allowedToolIds.length === 0) {
    throw new TypeError('No Agent Tools are available within the current Admin permissions');
  }
  if (
    scopes.includes('agent:user-data:read') &&
    !allowedToolIds.some((id) => id === 'admin.read.users.search' || id === 'admin.read.users.get')
  ) {
    throw new TypeError('agent:user-data:read requires admin:users:read');
  }
  if (
    scopes.includes('agent:write') &&
    !allowedToolIds.some((id) => toolsById.get(id)?.requiredScope === 'agent:write')
  ) {
    throw new TypeError('agent:write is unavailable within the current Admin permissions');
  }

  const resolved = await resolveAgentTaskSetVersion({
    toolIds: allowedToolIds,
    catalog: input.catalog,
    creatorPermissions: input.adminPermissions,
  });
  const scopePolicy = await normalizeAgentScopePolicy(
    {
      tenantIds: [input.tenantId],
      environmentIds: [],
      domains: [],
      resourceIds: [],
      selectors: [],
      allowedFields: [],
      piiMode: 'masked',
      maxPerCall: maxSubjectsPerCall,
      maxPlanOperations: 25,
      maxBulkTenants: 1,
    },
    input.tenantId
  );
  const taskSetId = input.taskSetId ?? `system_agent_task_set_${input.grantId}`;
  const taskSetVersion = input.taskSetVersion ?? 1;
  const scopePolicyId = input.scopePolicyId ?? `system_agent_scope_policy_${input.grantId}`;
  const scopePolicyVersion = input.scopePolicyVersion ?? 1;
  if (
    !Number.isSafeInteger(taskSetVersion) ||
    taskSetVersion < 1 ||
    !Number.isSafeInteger(scopePolicyVersion) ||
    scopePolicyVersion < 1
  ) {
    throw new TypeError('Self-service configuration versions must be positive integers');
  }
  const resolvedTools: AgentResolvedToolContract[] = resolved.tools.map((tool) => ({
    toolId: tool.toolId,
    toolName: tool.toolName,
    contractVersion: tool.contractVersion,
    schemaDigest: tool.schemaDigest,
    permissions: [...tool.permissions],
    requiredScope: tool.requiredScope,
    riskLevel: tool.riskLevel,
    requiresElevation: tool.requiresElevation,
  }));
  const resolvedScopeConstraints: AgentScopeConstraints = {
    tenantIds: [input.tenantId],
    piiMode: 'masked',
    maxPerCall: scopePolicy.definition.maxPerCall,
    maxPerPlan: scopePolicy.definition.maxPlanOperations,
    maxPerBulkPlan: scopePolicy.definition.maxBulkTenants,
  };
  const accessSnapshotHash = await sha256Base64Url(
    canonicalizeJson({
      purpose: 'authrim-agent-self-service-snapshot-v1',
      tenant_id: input.tenantId,
      admin_user_id: input.adminUserId,
      client_id: input.clientId,
      grant_id: input.grantId,
      expires_at: input.expiresAt,
      scopes,
      task_set: { id: taskSetId, version: taskSetVersion, digest: resolved.digest },
      scope_policy: { id: scopePolicyId, version: scopePolicyVersion, digest: scopePolicy.digest },
      tools: resolvedTools,
    } as unknown as JsonValue)
  );

  return {
    taskSetId,
    taskSetVersion,
    scopePolicyId,
    scopePolicyVersion,
    resolvedTools,
    permissions: [...resolved.permissions],
    scopes,
    resolvedScopeConstraints,
    taskSetDigest: resolved.digest,
    taskSetResolved: resolved,
    scopePolicyDefinition: scopePolicy.definition,
    scopePolicyDigest: scopePolicy.digest,
    accessSnapshotHash,
  };
}
