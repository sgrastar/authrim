export interface AgentDownscopeExchangeRequest {
  subjectToken: string;
  tenantId: string;
  issuerOrigin: string;
  audience: 'authrim:admin-api';
  permissions: readonly string[];
  grantId: string;
  grantGeneration: number;
  delegatorId: string;
  consentVersion: number;
  actorSub: string;
  actorMode: string;
  actorAssurance: string;
  machinePrincipalId?: string;
  machineCredentialId?: string;
  clientId: string;
  correlationId: string;
}

export interface AgentDownscopeExchangeResult {
  accessToken: string;
  expiresAt: number;
}

export interface AgentBulkChildTokenRequest {
  issuerOrigin: string;
  audience: 'authrim:admin-api';
  controlTenantId: string;
  targetTenantId: string;
  bulkPlanId: string;
  bulkPlanVersion: number;
  executionId: string;
  executionAttempt: number;
  executionFence: number;
  stage: 'validate' | 'apply' | 'verify';
  planDigest: string;
  approvalDigest: string;
  childCapabilityDigest: string;
  correlationId: string;
}

export interface AgentAdminApiDownscopeTokenClaims {
  sub: string;
  jti: string;
  scope: string;
  permissions: string[];
  client_id: string;
  tenant_id: string;
  grant_id: string;
  grant_generation: number;
  consent_version: number;
  actor_type: 'agent';
  actor_mode: 'mode_a' | 'mode_b';
  actor_assurance: 'public_client_transaction' | 'confidential_client' | 'machine_key';
  act: { sub: string };
  act_principal_id?: string;
  act_credential_id?: string;
  source_token_jti: string;
  correlation_id: string;
  bulk?: {
    control_tenant_id: string;
    target_tenant_id: string;
    plan_id: string;
    plan_version: number;
    execution_id: string;
    execution_attempt: number;
    execution_fence: number;
    stage: 'validate' | 'apply' | 'verify';
    plan_digest: string;
    approval_digest: string;
    child_capability_digest: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parses internal Admin API claims only after issuer, audience, signature, and time checks. */
export function parseAgentAdminApiDownscopeTokenClaims(
  value: unknown
): AgentAdminApiDownscopeTokenClaims | null {
  if (!isRecord(value) || !isRecord(value.act)) return null;
  const permissions = value.permissions;
  if (
    typeof value.sub !== 'string' ||
    !value.sub.startsWith('admin_user:') ||
    value.sub.length === 'admin_user:'.length ||
    typeof value.jti !== 'string' ||
    value.jti.length === 0 ||
    typeof value.scope !== 'string' ||
    !Array.isArray(permissions) ||
    permissions.length === 0 ||
    permissions.some((permission) => typeof permission !== 'string' || permission.length === 0) ||
    new Set(permissions).size !== permissions.length ||
    typeof value.client_id !== 'string' ||
    value.client_id.length === 0 ||
    typeof value.tenant_id !== 'string' ||
    value.tenant_id.length === 0 ||
    typeof value.grant_id !== 'string' ||
    value.grant_id.length === 0 ||
    !Number.isSafeInteger(value.grant_generation) ||
    (value.grant_generation as number) < 1 ||
    !Number.isSafeInteger(value.consent_version) ||
    (value.consent_version as number) < 1 ||
    value.actor_type !== 'agent' ||
    (value.actor_mode !== 'mode_a' && value.actor_mode !== 'mode_b') ||
    (value.actor_assurance !== 'public_client_transaction' &&
      value.actor_assurance !== 'confidential_client' &&
      value.actor_assurance !== 'machine_key') ||
    typeof value.act.sub !== 'string' ||
    value.act.sub.length === 0 ||
    typeof value.source_token_jti !== 'string' ||
    value.source_token_jti.length === 0 ||
    typeof value.correlation_id !== 'string' ||
    value.correlation_id.length === 0
  ) {
    return null;
  }
  if (
    value.bulk !== undefined &&
    (!isRecord(value.bulk) ||
      typeof value.bulk.control_tenant_id !== 'string' ||
      typeof value.bulk.target_tenant_id !== 'string' ||
      value.bulk.target_tenant_id !== value.tenant_id ||
      typeof value.bulk.plan_id !== 'string' ||
      !Number.isSafeInteger(value.bulk.plan_version) ||
      (value.bulk.plan_version as number) < 1 ||
      typeof value.bulk.execution_id !== 'string' ||
      !Number.isSafeInteger(value.bulk.execution_attempt) ||
      (value.bulk.execution_attempt as number) < 1 ||
      !Number.isSafeInteger(value.bulk.execution_fence) ||
      (value.bulk.execution_fence as number) < 1 ||
      (value.bulk.stage !== 'validate' &&
        value.bulk.stage !== 'apply' &&
        value.bulk.stage !== 'verify') ||
      typeof value.bulk.plan_digest !== 'string' ||
      typeof value.bulk.approval_digest !== 'string' ||
      typeof value.bulk.child_capability_digest !== 'string')
  ) {
    return null;
  }
  if (
    (value.actor_mode === 'mode_a' && value.actor_assurance === 'machine_key') ||
    (value.actor_mode === 'mode_b' &&
      (value.actor_assurance !== 'machine_key' ||
        typeof value.act_principal_id !== 'string' ||
        value.act_principal_id.length === 0 ||
        typeof value.act_credential_id !== 'string' ||
        value.act_credential_id.length === 0 ||
        value.act.sub !== `machine:${value.act_principal_id}`))
  ) {
    return null;
  }
  if (value.bulk !== undefined && value.actor_mode !== 'mode_b') return null;
  const scopes = value.scope.split(/\s+/u).filter(Boolean);
  if (
    scopes.length !== permissions.length ||
    scopes.some((scope, index) => scope !== permissions[index])
  ) {
    return null;
  }
  return value as unknown as AgentAdminApiDownscopeTokenClaims;
}
