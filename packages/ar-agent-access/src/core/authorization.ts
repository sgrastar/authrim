import { hasAdminPermission } from '@authrim/ar-lib-core/types/admin-user';
import type {
  AgentAuthorizationDecision,
  AgentAuthorizationInput,
  AgentGrantValidationInput,
  AgentGrantValidationResult,
  AgentPrincipalTenantScope,
  AgentResourceRequestContext,
  AgentRiskLevel,
  AgentScope,
  AgentScopeConstraints,
} from './types';

const ACCESS_SNAPSHOT_HASH = /^[A-Za-z0-9_-]{43}$/u;

type CompleteAgentConfigurationSnapshot = Required<
  Pick<
    AgentAuthorizationInput['grant'],
    | 'taskSetId'
    | 'taskSetVersion'
    | 'scopePolicyId'
    | 'scopePolicyVersion'
    | 'resolvedTools'
    | 'accessSnapshotHash'
  >
>;

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value) => right.includes(value)) &&
    right.every((value) => left.includes(value))
  );
}

/**
 * Phase 2 Grants are always bound to one immutable Task Set and Scope Policy snapshot.
 * Optional storage fields remain representable so legacy/corrupt rows can be read and denied.
 */
export function hasCompleteAgentConfigurationSnapshot(
  grant: Pick<
    AgentAuthorizationInput['grant'],
    | 'taskSetId'
    | 'taskSetVersion'
    | 'scopePolicyId'
    | 'scopePolicyVersion'
    | 'resolvedTools'
    | 'accessSnapshotHash'
  >
): grant is typeof grant & CompleteAgentConfigurationSnapshot {
  return Boolean(
    grant.taskSetId &&
    grant.taskSetVersion !== undefined &&
    Number.isSafeInteger(grant.taskSetVersion) &&
    grant.taskSetVersion >= 1 &&
    grant.scopePolicyId &&
    grant.scopePolicyVersion !== undefined &&
    Number.isSafeInteger(grant.scopePolicyVersion) &&
    grant.scopePolicyVersion >= 1 &&
    grant.resolvedTools &&
    grant.resolvedTools.length > 0 &&
    grant.accessSnapshotHash &&
    ACCESS_SNAPSHOT_HASH.test(grant.accessSnapshotHash)
  );
}

export function agentGrantPinsToolContract(
  grant: AgentAuthorizationInput['grant'],
  tool: AgentAuthorizationInput['tool']
): boolean {
  return Boolean(
    grant.resolvedTools?.some(
      (pinned) =>
        pinned.toolId === tool.id &&
        pinned.toolName === tool.name &&
        pinned.contractVersion === tool.contractVersion &&
        pinned.schemaDigest === tool.schemaDigest &&
        sameStringSet(pinned.permissions, tool.requiredPermissions) &&
        pinned.requiredScope === tool.requiredScope &&
        pinned.riskLevel === tool.riskLevel &&
        pinned.requiresElevation === (tool.riskLevel === 'high')
    )
  );
}

function permissionsCover(available: string[], required: readonly string[]): boolean {
  return required.every((permission) => hasAdminPermission(available, permission));
}

export function principalExplicitlyAllowsTenant(
  scopes: AgentPrincipalTenantScope[],
  tenantId: string
): boolean {
  if (scopes.some((scope) => scope.scopeMode === 'all')) {
    return false;
  }
  return scopes.some((scope) => scope.scopeMode === 'allow' && scope.tenantId === tenantId);
}

export function validateAgentTenantBoundary(
  input: AgentGrantValidationInput['tenantBoundary']
): boolean {
  if (
    input.clientTenantId !== input.tenantId ||
    input.grantorTenantId !== input.tenantId ||
    input.delegatorTenantId !== input.tenantId
  ) {
    return false;
  }

  if (input.principalTenantScopes) {
    return principalExplicitlyAllowsTenant(input.principalTenantScopes, input.tenantId);
  }

  return true;
}

export function validateAgentGrantPermissions(
  input: AgentGrantValidationInput
): AgentGrantValidationResult {
  if (input.machinePrincipalId && !input.tenantBoundary.principalTenantScopes) {
    return { valid: false, code: 'AGENT_GRANT_TENANT_BOUNDARY' };
  }
  if (!validateAgentTenantBoundary(input.tenantBoundary)) {
    return { valid: false, code: 'AGENT_GRANT_TENANT_BOUNDARY' };
  }

  for (const permission of input.requestedPermissions) {
    if (!hasAdminPermission(input.grantorPermissions, permission)) {
      return { valid: false, code: 'AGENT_GRANT_PERMISSION_EXCEEDS_GRANTOR', permission };
    }
    if (!hasAdminPermission(input.delegatorPermissions, permission)) {
      return { valid: false, code: 'AGENT_GRANT_PERMISSION_EXCEEDS_DELEGATOR', permission };
    }
    if (
      input.machinePrincipalId &&
      (!input.principalPermissions || !hasAdminPermission(input.principalPermissions, permission))
    ) {
      return { valid: false, code: 'AGENT_GRANT_PERMISSION_EXCEEDS_PRINCIPAL', permission };
    }
  }

  return { valid: true };
}

function scopeAllows(scopes: AgentScope[], required: AgentScope): boolean {
  return scopes.includes(required);
}

function riskRank(risk: AgentRiskLevel): number {
  return risk === 'low' ? 0 : risk === 'standard' ? 1 : 2;
}

export function agentResourceConstraintsAllow(
  constraints: AgentScopeConstraints,
  resource: AgentResourceRequestContext
): boolean {
  if (!constraints.tenantIds.includes(resource.tenantId)) return false;
  if (
    constraints.environmentIds &&
    (!resource.environmentId || !constraints.environmentIds.includes(resource.environmentId))
  )
    return false;
  if (constraints.domains && (!resource.domain || !constraints.domains.includes(resource.domain))) {
    return false;
  }
  if (constraints.resourceSelector) {
    if (constraints.resourceSelector.kind === 'ids') {
      if (!resource.resourceId || !constraints.resourceSelector.ids.includes(resource.resourceId)) {
        return false;
      }
    } else if (resource.catalogSelectorMatched !== true) {
      return false;
    }
  }
  if (
    constraints.allowedFields &&
    resource.requestedFields?.some((field) => !constraints.allowedFields?.includes(field))
  )
    return false;
  if (resource.requestsUnmaskedPii && constraints.piiMode !== 'unmasked') return false;
  if (
    constraints.maxPerCall !== undefined &&
    resource.quantity !== undefined &&
    resource.quantity > constraints.maxPerCall
  )
    return false;
  return true;
}

export function evaluateAgentAuthorization(
  input: AgentAuthorizationInput
): AgentAuthorizationDecision {
  if (!input.featureEnabled) {
    return {
      allowed: false,
      requiresElevation: false,
      deniedAxis: 'feature_flag',
      code: 'AGENT_MCP_DISABLED',
    };
  }
  if (input.actor.clientId !== input.grant.clientId) {
    return {
      allowed: false,
      requiresElevation: false,
      deniedAxis: 'identity',
      code: 'AGENT_ACTOR_MISMATCH',
    };
  }
  if (
    input.actor.mode === 'mode_a' &&
    (input.actor.assurance === 'machine_key' || input.actor.machinePrincipalId !== undefined)
  ) {
    return {
      allowed: false,
      requiresElevation: false,
      deniedAxis: 'identity',
      code: 'AGENT_CLIENT_ACTOR_INVALID',
    };
  }
  if (input.actor.mode === 'mode_b') {
    if (
      input.actor.assurance !== 'machine_key' ||
      !input.actor.machinePrincipalId ||
      input.actor.machinePrincipalId !== input.grant.machinePrincipalId
    ) {
      return {
        allowed: false,
        requiresElevation: false,
        deniedAxis: 'identity',
        code: 'AGENT_MACHINE_ACTOR_INVALID',
      };
    }
    if (input.riskPolicy.dpopRequiredForModeB && input.actor.tokenBinding !== 'dpop') {
      return {
        allowed: false,
        requiresElevation: false,
        deniedAxis: 'identity',
        code: 'AGENT_DPOP_REQUIRED',
      };
    }
  }
  if (
    input.grant.status !== 'active' ||
    input.grant.expiresAt === undefined ||
    input.grant.expiresAt <= input.now
  ) {
    return {
      allowed: false,
      requiresElevation: false,
      deniedAxis: 'grant',
      code: 'AGENT_GRANT_INACTIVE',
    };
  }
  if (!hasCompleteAgentConfigurationSnapshot(input.grant)) {
    return {
      allowed: false,
      requiresElevation: false,
      deniedAxis: 'grant',
      code: 'AGENT_CONFIGURATION_SNAPSHOT_UNAVAILABLE',
    };
  }
  if (!agentGrantPinsToolContract(input.grant, input.tool)) {
    return {
      allowed: false,
      requiresElevation: false,
      deniedAxis: 'grant',
      code: 'AGENT_TOOL_NOT_IN_TASK_SET',
    };
  }
  if (input.grant.tenantId !== input.resource.tenantId) {
    return {
      allowed: false,
      requiresElevation: false,
      deniedAxis: 'resource',
      code: 'AGENT_GRANT_TENANT_BOUNDARY',
    };
  }
  if (
    !permissionsCover(input.grant.permissions, input.tool.requiredPermissions) ||
    !permissionsCover(input.delegatorCurrentPermissions, input.tool.requiredPermissions) ||
    (input.grant.machinePrincipalId !== undefined &&
      (!input.principalPermissionLimit ||
        !permissionsCover(input.principalPermissionLimit, input.tool.requiredPermissions)))
  ) {
    return {
      allowed: false,
      requiresElevation: false,
      deniedAxis: 'permission',
      code: 'AGENT_INSUFFICIENT_PERMISSION',
    };
  }
  if (!scopeAllows(input.grant.scopes, input.tool.requiredScope)) {
    return {
      allowed: false,
      requiresElevation: false,
      deniedAxis: 'scope',
      code: 'AGENT_INSUFFICIENT_SCOPE',
    };
  }
  if (!agentResourceConstraintsAllow(input.constraints, input.resource)) {
    return {
      allowed: false,
      requiresElevation: false,
      deniedAxis: 'resource',
      code: 'AGENT_RESOURCE_CONSTRAINT',
    };
  }

  const effectiveRisk: AgentRiskLevel = input.tool.requiredPermissions.some((permission) =>
    input.riskPolicy.highRiskPermissionsAdditional?.includes(permission)
  )
    ? 'high'
    : input.tool.riskLevel;
  if (
    effectiveRisk === 'high' &&
    input.riskPolicy.highRiskRequiresElevation &&
    input.elevationCapabilityValid !== true
  ) {
    return {
      allowed: false,
      requiresElevation: true,
      deniedAxis: 'risk',
      code: 'AGENT_ELEVATION_REQUIRED',
    };
  }
  const allowedRisks = input.riskPolicy.allowedRiskByAssurance[input.actor.assurance];
  const publicClientStandardOptIn =
    input.actor.assurance === 'public_client_transaction' &&
    effectiveRisk === 'standard' &&
    input.riskPolicy.publicClientStandardToolIds?.includes(input.tool.id) === true;
  if (
    publicClientStandardOptIn &&
    (input.resource.quantity === undefined || input.resource.quantity !== 1)
  ) {
    return {
      allowed: false,
      requiresElevation: false,
      deniedAxis: 'resource',
      code: 'AGENT_PUBLIC_CLIENT_SINGLE_SUBJECT_REQUIRED',
    };
  }
  const approvedHighRisk =
    effectiveRisk === 'high' &&
    input.riskPolicy.highRiskRequiresElevation &&
    input.elevationCapabilityValid === true;
  if (
    !approvedHighRisk &&
    !publicClientStandardOptIn &&
    !allowedRisks.some((risk) => riskRank(risk) >= riskRank(effectiveRisk))
  ) {
    return {
      allowed: false,
      requiresElevation: false,
      deniedAxis: 'risk',
      code: 'AGENT_RISK_POLICY_DENIED',
    };
  }
  return { allowed: true, requiresElevation: false };
}
