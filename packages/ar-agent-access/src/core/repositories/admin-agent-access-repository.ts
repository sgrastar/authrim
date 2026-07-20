import type { DatabaseAdapter, PreparedStatement } from '@authrim/ar-lib-core/db/adapter';
import type { AdminAgentAuditWrite } from '../audit';
import { hasCompleteAgentConfigurationSnapshot } from '../authorization';
import { canonicalizeJson, sha256Base64Url } from '../canonical-json';
import type { AgentScopePolicyDefinition, ResolvedAgentTaskSetVersion } from '../configuration';
import {
  normalizeSelfServiceAgentAuthorizationDetails,
  selfServiceRevocationOutboxId,
} from '../self-service';
import {
  hasCurrentAgentConsent,
  type AgentConsentContract,
  type AgentConsentType,
} from '../consent';
import type {
  AgentElevationStatus,
  AgentManagementIdempotencyLookup,
  AgentManagementIdempotencyStatus,
} from '../elevation';
import type {
  AgentDelegationMode,
  AgentGrantContract,
  AgentGrantStatus,
  AgentScope,
  AgentScopeConstraints,
  JsonObject,
  JsonValue,
} from '../types';

interface AgentGrantRow {
  id: string;
  tenant_id: string;
  client_id: string;
  machine_principal_id: string | null;
  grantor_id: string;
  delegator_id: string;
  permissions: string;
  scopes: string;
  authorization_details?: string | null;
  resolved_scope_constraints: string;
  consent_version: number;
  generation: number;
  status: AgentGrantStatus;
  delegation_mode: AgentDelegationMode;
  expires_at: number | null;
  task_set_id: string | null;
  task_set_version: number | null;
  scope_policy_id: string | null;
  scope_policy_version: number | null;
  resolved_tools: string | null;
  access_snapshot_hash: string | null;
}

interface AdminAgentGrantRecordRow extends AgentGrantRow {
  authorization_details: string | null;
  purpose: string | null;
  management_mode: 'managed' | 'system_managed';
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
}

interface AgentConsentRow {
  id: string;
  tenant_id: string;
  consent_type: AgentConsentType;
  grant_id: string;
  user_id: string;
  client_id: string;
  consent_version: number;
  scopes: string;
  granted_at: number;
  revoked_at: number | null;
  revoked_reason: AgentConsentContract['revokedReason'] | null;
}

interface AgentConsentWithGrantRow extends AgentConsentRow {
  grant_status: AgentGrantStatus;
  grant_generation: number;
}

interface AgentElevationRow {
  id: string;
  tenant_id: string;
  grant_id: string;
  status: AgentElevationStatus;
  execution_attempt: number;
  execution_fence: number;
  execution_owner_id: string | null;
  execution_lease_expires_at: number | null;
  retry_count: number;
}

interface AgentTokenRevocationOutboxRow {
  id: string;
  tenant_id: string;
  grant_id: string | null;
  grant_generation: number | null;
  client_id: string;
  event_type: 'revoke_grant_families' | 'revoke_client_families';
  payload: string;
  status: 'pending' | 'processing' | 'completed' | 'dead_letter';
  attempt_count: number;
  processing_fence: number;
  processing_owner_id: string | null;
  processing_lease_expires_at: number | null;
}

interface AgentManagementExecutionRow {
  operation: string;
  request_digest: string;
  status: 'in_progress' | 'succeeded' | 'failed';
  lease_expires_at: number;
  result_envelope: string | null;
  result_digest: string | null;
}

interface AdminPermissionRow {
  permissions_json: string;
}

export interface CreateAdminAgentGrantInput extends AgentGrantContract {
  createdAt: number;
  purpose?: string;
  authorizationDetails?: JsonObject[];
  managementMode?: 'managed' | 'system_managed';
}

export interface CreateAdminAgentGrantWithAuditInput {
  grant: CreateAdminAgentGrantInput;
  audit: AdminAgentAuditWrite;
}

export interface CreateAdminAgentGrantWithPreauthorizationInput extends CreateAdminAgentGrantWithAuditInput {
  delegationConsent: UpsertAgentConsentInput;
  oauthClientConsent: UpsertAgentConsentInput;
  consentAudit: AdminAgentAuditWrite;
}

export interface SelfServiceAgentConfigurationInput {
  taskSet: {
    id: string;
    version: number;
    digest: string;
    resolved: ResolvedAgentTaskSetVersion;
  };
  scopePolicy: {
    id: string;
    version: number;
    digest: string;
    definition: AgentScopePolicyDefinition;
    selectorCatalogVersion: string;
  };
}

export interface CreateSelfServiceAgentAuthorizationInput
  extends CreateAdminAgentGrantWithPreauthorizationInput, SelfServiceAgentConfigurationInput {}

export interface ReplaceSelfServiceAgentAuthorizationInput extends SelfServiceAgentConfigurationInput {
  grant: CreateAdminAgentGrantInput;
  expectedGeneration: number;
  delegationConsent: UpsertAgentConsentInput;
  oauthClientConsent: UpsertAgentConsentInput;
  transitionId: string;
  outboxId: string;
  grantAudit: AdminAgentAuditWrite;
  consentAudit: AdminAgentAuditWrite;
}

export interface SuspendAgentClientMetadataChangeInput {
  tenantId: string;
  clientId: string;
  oldHash: string;
  newHash: string;
  transitionId: string;
  outboxId: string;
  now: number;
}

export type AdminAgentLoginHandoffStatus = 'pending' | 'issued' | 'consumed';

export interface AdminAgentLoginHandoffRecord {
  id: string;
  targetTenantId: string;
  targetOrigin: string;
  authorizationPath: string;
  status: AdminAgentLoginHandoffStatus;
  browserBindingHash: string;
  sourceSessionId?: string;
  sourceSessionHash?: string;
  adminUserId?: string;
  codeHash?: string;
  lastTransitionId: string;
  createdAt: number;
  expiresAt: number;
  issuedAt?: number;
  consumedAt?: number;
}

interface AdminAgentLoginHandoffRow {
  id: string;
  target_tenant_id: string;
  target_origin: string;
  authorization_path: string;
  status: AdminAgentLoginHandoffStatus;
  browser_binding_hash: string;
  source_session_id: string | null;
  source_session_hash: string | null;
  admin_user_id: string | null;
  code_hash: string | null;
  last_transition_id: string;
  created_at: number;
  expires_at: number;
  issued_at: number | null;
  consumed_at: number | null;
}

export interface CreateAdminAgentLoginHandoffInput {
  id: string;
  targetTenantId: string;
  targetOrigin: string;
  authorizationPath: string;
  browserBindingHash: string;
  transitionId: string;
  createdAt: number;
  expiresAt: number;
  audit: AdminAgentAuditWrite;
}

export interface IssueAdminAgentLoginHandoffInput {
  id: string;
  targetTenantId: string;
  sourceSessionId: string;
  sourceSessionHash: string;
  adminUserId: string;
  codeHash: string;
  transitionId: string;
  issuedAt: number;
  expiresAt: number;
  audit: AdminAgentAuditWrite;
}

export interface ConsumeAdminAgentLoginHandoffInput {
  id: string;
  targetTenantId: string;
  codeHash: string;
  transitionId: string;
  consumedAt: number;
  targetSession: {
    id: string;
    tenantId: string;
    adminUserId: string;
    parentSessionId: string;
    parentSessionHash: string;
    ipAddress?: string;
    userAgent?: string;
    createdAt: number;
    expiresAt: number;
    mfaVerifiedAt: number;
  };
  audit: AdminAgentAuditWrite;
}

async function assertSelfServiceAuthorizationConsistency(
  input: {
    grant: CreateAdminAgentGrantInput;
    delegationConsent: UpsertAgentConsentInput;
    oauthClientConsent: UpsertAgentConsentInput;
  } & SelfServiceAgentConfigurationInput
): Promise<void> {
  const { grant, taskSet, scopePolicy, delegationConsent, oauthClientConsent } = input;
  if (!hasCompleteAgentConfigurationSnapshot(grant)) {
    throw new TypeError('Self-service authorization requires a complete configuration snapshot');
  }
  parseScopeConstraints(JSON.stringify(grant.resolvedScopeConstraints), grant.tenantId);
  const exactJson = (left: unknown, right: unknown) =>
    canonicalizeJson(left as JsonValue) === canonicalizeJson(right as JsonValue);
  if (
    grant.delegationMode !== 'user_consent' ||
    grant.purpose !== 'interactive_self_service' ||
    grant.managementMode !== 'system_managed' ||
    grant.machinePrincipalId ||
    grant.grantorId !== grant.delegatorId ||
    grant.expiresAt === undefined ||
    !Number.isSafeInteger(grant.expiresAt) ||
    grant.expiresAt <= grant.createdAt ||
    taskSet.id !== grant.taskSetId ||
    taskSet.version !== grant.taskSetVersion ||
    scopePolicy.id !== grant.scopePolicyId ||
    scopePolicy.version !== grant.scopePolicyVersion ||
    taskSet.digest !== taskSet.resolved.digest ||
    delegationConsent.type !== 'delegation' ||
    oauthClientConsent.type !== 'oauth_client' ||
    delegationConsent.tenantId !== grant.tenantId ||
    oauthClientConsent.tenantId !== grant.tenantId ||
    delegationConsent.grantId !== grant.grantId ||
    oauthClientConsent.grantId !== grant.grantId ||
    delegationConsent.userId !== grant.delegatorId ||
    oauthClientConsent.userId !== grant.delegatorId ||
    delegationConsent.clientId !== grant.clientId ||
    oauthClientConsent.clientId !== grant.clientId ||
    delegationConsent.consentVersion !== grant.consentVersion ||
    oauthClientConsent.consentVersion !== grant.consentVersion ||
    !exactJson(delegationConsent.scopes, grant.scopes) ||
    !exactJson(oauthClientConsent.scopes, grant.scopes) ||
    !exactJson(taskSet.resolved.permissions, grant.permissions) ||
    !exactJson(taskSet.resolved.tools, grant.resolvedTools) ||
    !exactJson(scopePolicy.definition.tenantIds, [grant.tenantId]) ||
    scopePolicy.definition.piiMode !== 'masked' ||
    !exactJson(grant.resolvedScopeConstraints.tenantIds, [grant.tenantId]) ||
    grant.resolvedScopeConstraints.piiMode !== 'masked' ||
    grant.resolvedScopeConstraints.maxPerCall !== scopePolicy.definition.maxPerCall ||
    grant.resolvedScopeConstraints.maxPerPlan !== scopePolicy.definition.maxPlanOperations ||
    grant.resolvedScopeConstraints.maxPerBulkPlan !== scopePolicy.definition.maxBulkTenants
  ) {
    throw new TypeError('Self-service authorization inputs are inconsistent');
  }
  const normalizedAuthorizationDetails = normalizeSelfServiceAgentAuthorizationDetails(
    grant.authorizationDetails
  );
  if (
    !exactJson(
      normalizedAuthorizationDetails.authorizationDetails ?? [],
      grant.authorizationDetails ?? []
    ) ||
    normalizedAuthorizationDetails.maxSubjectsPerCall !== grant.resolvedScopeConstraints.maxPerCall
  ) {
    throw new TypeError('Self-service authorization RAR constraints are inconsistent');
  }
  const taskDigest = await sha256Base64Url(
    canonicalizeJson({
      catalogVersion: taskSet.resolved.catalogVersion,
      tools: taskSet.resolved.tools,
      permissions: taskSet.resolved.permissions,
    } as unknown as JsonValue)
  );
  const scopeDigest = await sha256Base64Url(
    canonicalizeJson(scopePolicy.definition as unknown as JsonValue)
  );
  const snapshotHash = await sha256Base64Url(
    canonicalizeJson({
      purpose: 'authrim-agent-self-service-snapshot-v1',
      tenant_id: grant.tenantId,
      admin_user_id: grant.delegatorId,
      client_id: grant.clientId,
      grant_id: grant.grantId,
      expires_at: grant.expiresAt,
      scopes: grant.scopes,
      task_set: { id: taskSet.id, version: taskSet.version, digest: taskSet.digest },
      scope_policy: {
        id: scopePolicy.id,
        version: scopePolicy.version,
        digest: scopePolicy.digest,
      },
      tools: grant.resolvedTools,
    } as unknown as JsonValue)
  );
  if (
    taskDigest !== taskSet.digest ||
    scopeDigest !== scopePolicy.digest ||
    snapshotHash !== grant.accessSnapshotHash
  ) {
    throw new TypeError('Self-service authorization digest is invalid');
  }
}

export interface AdminAgentGrantRecord extends AgentGrantContract {
  purpose?: string;
  managementMode: 'managed' | 'system_managed';
  lastUsedAt?: number;
  createdAt: number;
  updatedAt: number;
  revokedAt?: number;
  revokedBy?: string;
}

export interface ListAdminAgentGrantsInput {
  tenantId: string;
  delegatorId?: string;
  machinePrincipalId?: string;
  status?: AgentGrantStatus;
  limit?: number;
  offset?: number;
}

export interface AdminAgentGrantAuditRecord {
  id: string;
  action: string;
  result: string;
  severity: string;
  actorType?: string;
  actorSub?: string;
  metadata: JsonObject;
  createdAt: number;
}

export interface UpsertAgentConsentInput extends AgentConsentContract {}

export interface GrantAgentConsentPairInput {
  delegation: UpsertAgentConsentInput;
  oauthClient: UpsertAgentConsentInput;
  audit: AdminAgentAuditWrite;
}

export interface AgentConsentWithGrant extends AgentConsentContract {
  grantStatus: AgentGrantStatus;
  grantGeneration: number;
}

export interface RevokeOauthClientConsentInput {
  consentId: string;
  tenantId: string;
  userId: string;
  grantId: string;
  clientId: string;
  grantGeneration: number;
  outboxId: string;
  now: number;
  audit: AdminAgentAuditWrite;
}

export interface CreateAgentElevationInput {
  id: string;
  tenantId: string;
  grantId: string;
  userId: string;
  actorSub: string;
  clientId: string;
  toolName: string;
  toolSchemaVersion: string;
  argsEnvelope: string;
  argsHash: string;
  confirmSummaryRedacted: string;
  payloadKeyVersion: string;
  payloadPurgeAt: number;
  createdAt: number;
  expiresAt: number;
}

export interface DecideAgentElevationInput {
  tenantId: string;
  challengeId: string;
  decision: 'approved' | 'denied';
  approverType: 'self_reauth' | 'approval';
  approverId: string;
  now: number;
  audit: AdminAgentAuditWrite;
}

export interface ReconcileIndeterminateAgentElevationInput {
  tenantId: string;
  challengeId: string;
  reconciledBy: string;
  outcome: 'executed' | 'not_executed' | 'unresolved';
  evidenceEnvelope: string;
  evidenceDigest: string;
  reconciledAt: number;
  audit: AdminAgentAuditWrite;
}

export interface ClaimedAgentElevation {
  id: string;
  attempt: number;
  fence: number;
  ownerId: string;
  leaseExpiresAt: number;
}

export interface AgentElevationChallengeRecord {
  id: string;
  tenantId: string;
  grantId: string;
  userId: string;
  actorSub: string;
  clientId: string;
  toolName: string;
  toolSchemaVersion: string;
  argsHash: string;
  confirmSummaryRedacted: string;
  status: AgentElevationStatus;
  executionAttempt: number;
  executionFence: number;
  executionOwnerId?: string;
  executionLeaseExpiresAt?: number;
  approvalRequestId?: string;
  approvalArtifactId?: string;
  createdAt: number;
  expiresAt: number;
}

export interface AgentElevationApprovalDecision {
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
  approverId?: string;
}

export interface StaleAgentElevation {
  id: string;
  tenantId: string;
  grantId: string;
  attempt: number;
  fence: number;
  ownerId: string | null;
  leaseExpiresAt: number;
  retryCount: number;
}

export interface BeginAgentManagementExecutionInput extends AgentManagementIdempotencyLookup {
  operation: string;
  requestDigest: string;
  leaseExpiresAt: number;
  createdAt: number;
}

export interface CompleteAgentManagementExecutionInput extends AgentManagementIdempotencyLookup {
  status: 'succeeded' | 'failed';
  resultEnvelope?: string;
  resultDigest: string;
  completedAt: number;
}

export interface CreatePendingAgentTokenFamilyInput {
  familyId: string;
  familyJti: string;
  tenantId: string;
  grantId: string;
  grantGeneration: number;
  adminUserId: string;
  clientId: string;
  consentVersion: number;
  finalizationNonce: string;
  expiresAt: number;
  createdAt: number;
}

export interface CreateAgentTokenRevocationOutboxInput {
  id: string;
  tenantId: string;
  grantId?: string;
  grantGeneration?: number;
  clientId: string;
  eventType: 'revoke_grant_families' | 'revoke_client_families';
  familyIds: readonly string[];
  familyJtis: readonly string[];
  reason: string;
  nextAttemptAt: number;
  createdAt: number;
}

export interface ClaimedAgentTokenRevocation {
  id: string;
  tenantId: string;
  grantId?: string;
  grantGeneration?: number;
  clientId: string;
  eventType: 'revoke_grant_families' | 'revoke_client_families';
  familyIds: string[];
  familyJtis: string[];
  reason: string;
  attempt: number;
  fence: number;
  ownerId: string;
  leaseExpiresAt: number;
}

export interface InvalidateAgentGrantInput {
  tenantId: string;
  grantId: string;
  clientId: string;
  expectedGeneration: number;
  status: 'suspended' | 'revoked';
  reason: 'user' | 'grant_updated' | 'grant_revoked' | 'admin';
  outboxId: string;
  now: number;
  audit: AdminAgentAuditWrite;
}

export interface UpdateAdminAgentGrantInput {
  tenantId: string;
  grantId: string;
  clientId: string;
  expectedGeneration: number;
  permissions: readonly string[];
  scopes: readonly AgentScope[];
  authorizationDetails?: readonly JsonObject[];
  resolvedScopeConstraints: AgentScopeConstraints;
  purpose?: string;
  expiresAt?: number;
  outboxId: string;
  now: number;
  audit: AdminAgentAuditWrite;
}

export interface ResumeAdminAgentGrantInput {
  tenantId: string;
  grantId: string;
  clientId: string;
  expectedGeneration: number;
  transitionId: string;
  now: number;
  audit: AdminAgentAuditWrite;
}

export class AgentAccessConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentAccessConflictError';
  }
}

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new TypeError('Stored Agent access array is invalid');
  }
  return parsed;
}

function parseJsonObjectArray(value: string | null): JsonObject[] | undefined {
  if (value === null) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => item === null || typeof item !== 'object' || Array.isArray(item))
  ) {
    throw new TypeError('Stored Agent authorization details are invalid');
  }
  return parsed as JsonObject[];
}

function parseJsonObject(value: string): JsonObject {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('Stored Agent JSON object is invalid');
  }
  return parsed as JsonObject;
}

function parseAgentScopes(value: string): AgentScope[] {
  const scopes = parseStringArray(value);
  const allowed = new Set<AgentScope>([
    'agent:read',
    'agent:user-data:read',
    'agent:write',
    'agent:execute',
    'agent:admin',
  ]);
  if (scopes.some((scope) => !allowed.has(scope as AgentScope))) {
    throw new TypeError('Stored Agent scope is invalid');
  }
  return scopes as AgentScope[];
}

function parseStringList(value: unknown, field: string, allowEmpty = true): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    throw new TypeError(`Stored Agent scope constraint ${field} is invalid`);
  }
  return value as string[];
}

function parseOptionalLimit(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`Stored Agent scope constraint ${field} is invalid`);
  }
  return value as number;
}

function parseScopeConstraints(value: string, grantTenantId: string): AgentScopeConstraints {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('Stored Agent scope constraints are invalid');
  }
  const constraints = parsed as Record<string, unknown>;
  const allowedFields = new Set([
    'tenantIds',
    'environmentIds',
    'domains',
    'resourceSelector',
    'allowedFields',
    'piiMode',
    'maxPerCall',
    'maxPerPlan',
    'maxPerBulkPlan',
  ]);
  if (Object.keys(constraints).some((field) => !allowedFields.has(field))) {
    throw new TypeError('Stored Agent scope constraints contain an unknown field');
  }
  const tenantIds = parseStringList(constraints.tenantIds, 'tenantIds', false);
  if (tenantIds?.length !== 1 || tenantIds[0] !== grantTenantId) {
    throw new TypeError('Stored Agent scope constraints must identify only the Grant tenant');
  }
  const environmentIds = parseStringList(constraints.environmentIds, 'environmentIds');
  const domains = parseStringList(constraints.domains, 'domains');
  const constrainedFields = parseStringList(constraints.allowedFields, 'allowedFields');
  let resourceSelector: AgentScopeConstraints['resourceSelector'];
  if (constraints.resourceSelector !== undefined) {
    if (
      !constraints.resourceSelector ||
      typeof constraints.resourceSelector !== 'object' ||
      Array.isArray(constraints.resourceSelector)
    ) {
      throw new TypeError('Stored Agent resource selector is invalid');
    }
    const selector = constraints.resourceSelector as Record<string, unknown>;
    if (selector.kind === 'ids') {
      const ids = parseStringList(selector.ids, 'resourceSelector.ids', false);
      if (Object.keys(selector).some((field) => field !== 'kind' && field !== 'ids')) {
        throw new TypeError('Stored Agent resource selector contains an unknown field');
      }
      resourceSelector = { kind: 'ids', ids: ids! };
    } else if (
      selector.kind === 'catalog' &&
      typeof selector.selectorId === 'string' &&
      selector.selectorId.length > 0 &&
      Number.isSafeInteger(selector.version) &&
      (selector.version as number) > 0 &&
      Object.keys(selector).every((field) => ['kind', 'selectorId', 'version'].includes(field))
    ) {
      resourceSelector = {
        kind: 'catalog',
        selectorId: selector.selectorId,
        version: selector.version as number,
      };
    } else {
      throw new TypeError('Stored Agent resource selector is invalid');
    }
  }
  if (
    constraints.piiMode !== undefined &&
    constraints.piiMode !== 'masked' &&
    constraints.piiMode !== 'unmasked'
  ) {
    throw new TypeError('Stored Agent scope constraint piiMode is invalid');
  }
  return {
    tenantIds,
    ...(environmentIds ? { environmentIds } : {}),
    ...(domains ? { domains } : {}),
    ...(resourceSelector ? { resourceSelector } : {}),
    ...(constrainedFields ? { allowedFields: constrainedFields } : {}),
    ...(constraints.piiMode ? { piiMode: constraints.piiMode } : {}),
    ...(constraints.maxPerCall !== undefined
      ? { maxPerCall: parseOptionalLimit(constraints.maxPerCall, 'maxPerCall')! }
      : {}),
    ...(constraints.maxPerPlan !== undefined
      ? { maxPerPlan: parseOptionalLimit(constraints.maxPerPlan, 'maxPerPlan')! }
      : {}),
    ...(constraints.maxPerBulkPlan !== undefined
      ? { maxPerBulkPlan: parseOptionalLimit(constraints.maxPerBulkPlan, 'maxPerBulkPlan')! }
      : {}),
  };
}

function parseRevocationPayload(value: string): {
  familyIds: string[];
  familyJtis: string[];
  reason: string;
} {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('Stored Agent token revocation payload is invalid');
  }
  const record = parsed as Record<string, unknown>;
  if (
    !Array.isArray(record.family_ids) ||
    record.family_ids.some((item) => typeof item !== 'string' || item.length === 0) ||
    !Array.isArray(record.family_jtis) ||
    record.family_jtis.some((item) => typeof item !== 'string' || item.length === 0) ||
    record.family_ids.length !== record.family_jtis.length ||
    typeof record.reason !== 'string' ||
    record.reason.length === 0
  ) {
    throw new TypeError('Stored Agent token revocation payload is invalid');
  }
  return {
    familyIds: record.family_ids as string[],
    familyJtis: record.family_jtis as string[],
    reason: record.reason,
  };
}

function toGrant(row: AgentGrantRow): AgentGrantContract {
  return {
    grantId: row.id,
    tenantId: row.tenant_id,
    clientId: row.client_id,
    machinePrincipalId: row.machine_principal_id ?? undefined,
    grantorId: row.grantor_id,
    delegatorId: row.delegator_id,
    permissions: parseStringArray(row.permissions),
    scopes: parseAgentScopes(row.scopes),
    authorizationDetails: parseJsonObjectArray(row.authorization_details ?? null),
    resolvedScopeConstraints: parseScopeConstraints(row.resolved_scope_constraints, row.tenant_id),
    consentVersion: row.consent_version,
    generation: row.generation,
    status: row.status,
    delegationMode: row.delegation_mode,
    taskSetId: row.task_set_id ?? undefined,
    taskSetVersion: row.task_set_version ?? undefined,
    scopePolicyId: row.scope_policy_id ?? undefined,
    scopePolicyVersion: row.scope_policy_version ?? undefined,
    resolvedTools: row.resolved_tools
      ? (JSON.parse(row.resolved_tools) as AgentGrantContract['resolvedTools'])
      : undefined,
    accessSnapshotHash: row.access_snapshot_hash ?? undefined,
    expiresAt: row.expires_at ?? undefined,
  };
}

function toConsent(row: AgentConsentRow): AgentConsentContract {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    grantId: row.grant_id,
    userId: row.user_id,
    clientId: row.client_id,
    type: row.consent_type,
    consentVersion: row.consent_version,
    scopes: parseAgentScopes(row.scopes),
    grantedAt: row.granted_at,
    revokedAt: row.revoked_at ?? undefined,
    revokedReason: row.revoked_reason ?? undefined,
  };
}

interface AuditStatementGuard {
  readonly from: string;
  readonly where: string;
  readonly params: readonly unknown[];
}

function adminAgentAuditStatement(
  audit: AdminAgentAuditWrite,
  guard?: AuditStatementGuard
): PreparedStatement {
  const values = [
    audit.id,
    audit.tenantId,
    audit.adminUserId ?? null,
    audit.action,
    audit.resourceType,
    audit.resourceId,
    audit.result ?? 'success',
    audit.severity,
    audit.requestId ?? null,
    JSON.stringify(audit.metadata),
    audit.createdAt,
    audit.actorType,
    audit.actorSub,
    audit.actorMode ?? null,
    audit.actorAssurance ?? null,
    audit.tokenBinding ?? null,
    audit.actClientId ?? null,
    audit.actPrincipalId ?? null,
    audit.grantId ?? null,
    audit.elevationId ?? null,
    audit.mcpTool ?? null,
  ];
  const valuePlaceholders = values.map(() => '?').join(', ');
  const replayMatches = [
    'tenant_id',
    'admin_user_id',
    'action',
    'resource_type',
    'resource_id',
    'result',
    'severity',
    'request_id',
    'metadata_json',
    'created_at',
    'actor_type',
    'actor_sub',
    'actor_mode',
    'actor_assurance',
    'token_binding',
    'act_client_id',
    'act_principal_id',
    'grant_id',
    'elevation_id',
    'mcp_tool',
  ]
    .map((column) => `admin_audit_log.${column} IS excluded.${column}`)
    .join(' AND ');
  return {
    sql: `INSERT INTO admin_audit_log (
      id, tenant_id, admin_user_id, action, resource_type, resource_id,
      result, severity, request_id, metadata_json, created_at,
      actor_type, actor_sub, actor_mode, actor_assurance, token_binding,
      act_client_id, act_principal_id, grant_id, elevation_id, mcp_tool
    ) ${guard ? `SELECT ${valuePlaceholders} FROM ${guard.from} WHERE ${guard.where}` : `VALUES (${valuePlaceholders})`}
    ON CONFLICT(id) DO UPDATE SET tenant_id = CASE
      WHEN ${replayMatches} THEN admin_audit_log.tenant_id
      ELSE NULL
    END`,
    params: guard ? [...values, ...guard.params] : values,
  };
}

function upsertAgentConsentStatement(
  input: UpsertAgentConsentInput,
  guard?: { from: string; where: string; params: readonly unknown[] }
): PreparedStatement {
  const values = [
    input.id,
    input.tenantId,
    input.type,
    input.grantId,
    input.userId,
    input.clientId,
    input.consentVersion,
    JSON.stringify(input.scopes),
    input.grantedAt,
  ];
  return {
    sql: `INSERT INTO agent_consents (
      id, tenant_id, consent_type, grant_id, user_id, client_id,
      consent_version, scopes, granted_at, revoked_at, revoked_reason
    ) ${guard ? `SELECT ${values.map(() => '?').join(', ')}, NULL, NULL FROM ${guard.from} WHERE ${guard.where}` : `VALUES (${values.map(() => '?').join(', ')}, NULL, NULL)`}
    ON CONFLICT(grant_id, client_id, consent_type) DO UPDATE SET
      tenant_id = excluded.tenant_id,
      user_id = excluded.user_id,
      consent_version = excluded.consent_version,
      scopes = excluded.scopes,
      granted_at = excluded.granted_at,
      revoked_at = NULL,
      revoked_reason = NULL`,
    params: guard ? [...values, ...guard.params] : values,
  };
}

function createExactSelfServiceConsentStatement(
  input: UpsertAgentConsentInput,
  mutationId: string
): PreparedStatement {
  const values = [
    input.id,
    input.tenantId,
    input.type,
    input.grantId,
    input.userId,
    input.clientId,
    input.consentVersion,
    JSON.stringify(input.scopes),
    input.grantedAt,
  ];
  return {
    sql: `INSERT INTO agent_consents (
      id, tenant_id, consent_type, grant_id, user_id, client_id,
      consent_version, scopes, granted_at, revoked_at, revoked_reason, last_mutation_id
    ) VALUES (${values.map(() => '?').join(', ')}, NULL, NULL, ?)
    ON CONFLICT(grant_id, client_id, consent_type) DO UPDATE SET
      tenant_id = CASE WHEN
        agent_consents.id IS excluded.id AND
        agent_consents.tenant_id IS excluded.tenant_id AND
        agent_consents.user_id IS excluded.user_id AND
        agent_consents.consent_version IS excluded.consent_version AND
        agent_consents.scopes IS excluded.scopes AND
        agent_consents.granted_at IS excluded.granted_at AND
        agent_consents.revoked_at IS excluded.revoked_at AND
        agent_consents.revoked_reason IS excluded.revoked_reason AND
        agent_consents.last_mutation_id IS excluded.last_mutation_id
        THEN agent_consents.tenant_id ELSE NULL END`,
    params: [...values, mutationId],
  };
}

function replaceSelfServiceConsentStatement(
  input: UpsertAgentConsentInput,
  mutationId: string,
  guard: AuditStatementGuard
): PreparedStatement {
  const values = [
    input.id,
    input.tenantId,
    input.type,
    input.grantId,
    input.userId,
    input.clientId,
    input.consentVersion,
    JSON.stringify(input.scopes),
    input.grantedAt,
  ];
  return {
    sql: `INSERT INTO agent_consents (
      id, tenant_id, consent_type, grant_id, user_id, client_id,
      consent_version, scopes, granted_at, revoked_at, revoked_reason, last_mutation_id
    ) SELECT ${values.map(() => '?').join(', ')}, NULL, NULL, ?
      FROM ${guard.from} WHERE ${guard.where}
    ON CONFLICT(grant_id, client_id, consent_type) DO UPDATE SET
      tenant_id = CASE
        WHEN agent_consents.last_mutation_id IS excluded.last_mutation_id THEN
          CASE WHEN
            agent_consents.tenant_id IS excluded.tenant_id AND
            agent_consents.user_id IS excluded.user_id AND
            agent_consents.consent_version IS excluded.consent_version AND
            agent_consents.scopes IS excluded.scopes AND
            agent_consents.granted_at IS excluded.granted_at AND
            agent_consents.revoked_at IS excluded.revoked_at AND
            agent_consents.revoked_reason IS excluded.revoked_reason
            THEN agent_consents.tenant_id ELSE NULL END
        ELSE excluded.tenant_id
      END,
      user_id = excluded.user_id,
      consent_version = excluded.consent_version,
      scopes = excluded.scopes,
      granted_at = excluded.granted_at,
      revoked_at = NULL,
      revoked_reason = NULL,
      last_mutation_id = excluded.last_mutation_id`,
    params: [...values, mutationId, ...guard.params],
  };
}

function createAdminAgentGrantStatement(input: CreateAdminAgentGrantInput): PreparedStatement {
  if (!hasCompleteAgentConfigurationSnapshot(input)) {
    throw new TypeError('Agent Grant requires a complete versioned configuration snapshot');
  }
  parseScopeConstraints(JSON.stringify(input.resolvedScopeConstraints), input.tenantId);
  return {
    sql: `INSERT INTO admin_agent_grants (
      id, tenant_id, client_id, machine_principal_id, grantor_id, delegator_id,
      permissions, scopes, authorization_details, resolved_scope_constraints, purpose,
      management_mode,
      task_set_id, task_set_version, scope_policy_id, scope_policy_version,
      resolved_tools, access_snapshot_hash,
      delegation_mode, generation, consent_version, status, active_uniqueness_key,
      expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET tenant_id = CASE WHEN
      admin_agent_grants.tenant_id IS excluded.tenant_id AND
      admin_agent_grants.client_id IS excluded.client_id AND
      admin_agent_grants.machine_principal_id IS excluded.machine_principal_id AND
      admin_agent_grants.grantor_id IS excluded.grantor_id AND
      admin_agent_grants.delegator_id IS excluded.delegator_id AND
      admin_agent_grants.permissions IS excluded.permissions AND
      admin_agent_grants.scopes IS excluded.scopes AND
      admin_agent_grants.authorization_details IS excluded.authorization_details AND
      admin_agent_grants.resolved_scope_constraints IS excluded.resolved_scope_constraints AND
      admin_agent_grants.purpose IS excluded.purpose AND
      admin_agent_grants.management_mode IS excluded.management_mode AND
      admin_agent_grants.task_set_id IS excluded.task_set_id AND
      admin_agent_grants.task_set_version IS excluded.task_set_version AND
      admin_agent_grants.scope_policy_id IS excluded.scope_policy_id AND
      admin_agent_grants.scope_policy_version IS excluded.scope_policy_version AND
      admin_agent_grants.resolved_tools IS excluded.resolved_tools AND
      admin_agent_grants.access_snapshot_hash IS excluded.access_snapshot_hash AND
      admin_agent_grants.delegation_mode IS excluded.delegation_mode AND
      admin_agent_grants.generation IS excluded.generation AND
      admin_agent_grants.consent_version IS excluded.consent_version AND
      admin_agent_grants.status IS excluded.status AND
      admin_agent_grants.active_uniqueness_key IS excluded.active_uniqueness_key AND
      admin_agent_grants.expires_at IS excluded.expires_at AND
      admin_agent_grants.created_at IS excluded.created_at AND
      admin_agent_grants.updated_at IS excluded.updated_at
      THEN admin_agent_grants.tenant_id ELSE NULL END`,
    params: [
      input.grantId,
      input.tenantId,
      input.clientId,
      input.machinePrincipalId ?? null,
      input.grantorId,
      input.delegatorId,
      JSON.stringify(input.permissions),
      JSON.stringify(input.scopes),
      input.authorizationDetails ? JSON.stringify(input.authorizationDetails) : null,
      JSON.stringify(input.resolvedScopeConstraints),
      input.purpose ?? null,
      input.managementMode ?? 'managed',
      input.taskSetId ?? null,
      input.taskSetVersion ?? null,
      input.scopePolicyId ?? null,
      input.scopePolicyVersion ?? null,
      input.resolvedTools ? JSON.stringify(input.resolvedTools) : null,
      input.accessSnapshotHash ?? null,
      input.delegationMode,
      input.generation,
      input.consentVersion,
      input.status,
      input.status === 'active' ? 'active' : input.grantId,
      input.expiresAt ?? null,
      input.createdAt,
      input.createdAt,
    ],
  };
}

function toAdminAgentGrantRecord(row: AdminAgentGrantRecordRow): AdminAgentGrantRecord {
  return {
    ...toGrant(row),
    authorizationDetails: parseJsonObjectArray(row.authorization_details),
    purpose: row.purpose ?? undefined,
    managementMode: row.management_mode,
    lastUsedAt: row.last_used_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at ?? undefined,
    revokedBy: row.revoked_by ?? undefined,
  };
}

function toAdminAgentLoginHandoffRecord(
  row: AdminAgentLoginHandoffRow
): AdminAgentLoginHandoffRecord {
  return {
    id: row.id,
    targetTenantId: row.target_tenant_id,
    targetOrigin: row.target_origin,
    authorizationPath: row.authorization_path,
    status: row.status,
    browserBindingHash: row.browser_binding_hash,
    sourceSessionId: row.source_session_id ?? undefined,
    sourceSessionHash: row.source_session_hash ?? undefined,
    adminUserId: row.admin_user_id ?? undefined,
    codeHash: row.code_hash ?? undefined,
    lastTransitionId: row.last_transition_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    issuedAt: row.issued_at ?? undefined,
    consumedAt: row.consumed_at ?? undefined,
  };
}

/** Platform-neutral DB_ADMIN persistence using Authrim's existing database abstraction. */
export class AdminAgentAccessRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async createLoginHandoff(input: CreateAdminAgentLoginHandoffInput): Promise<void> {
    let targetOrigin: string;
    let authorizationContinuation: URL;
    try {
      targetOrigin = new URL(input.targetOrigin).origin;
      authorizationContinuation = new URL(input.authorizationPath, targetOrigin);
    } catch {
      throw new TypeError('Invalid Admin Agent login handoff');
    }
    if (
      !input.targetTenantId.trim() ||
      targetOrigin !== input.targetOrigin ||
      !targetOrigin.startsWith('https://') ||
      authorizationContinuation.origin !== targetOrigin ||
      authorizationContinuation.pathname !== '/oauth/admin-agent/authorize' ||
      authorizationContinuation.hash ||
      input.expiresAt <= input.createdAt
    ) {
      throw new TypeError('Invalid Admin Agent login handoff');
    }
    await this.adapter.batch([
      {
        sql: `INSERT INTO admin_agent_login_handoffs (
          id, target_tenant_id, target_origin, authorization_path, status,
          browser_binding_hash, last_transition_id, created_at, expires_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        params: [
          input.id,
          input.targetTenantId,
          input.targetOrigin,
          input.authorizationPath,
          input.browserBindingHash,
          input.transitionId,
          input.createdAt,
          input.expiresAt,
        ],
      },
      adminAgentAuditStatement(input.audit, {
        from: 'admin_agent_login_handoffs',
        where: "id = ? AND last_transition_id = ? AND status = 'pending'",
        params: [input.id, input.transitionId],
      }),
    ]);
  }

  async getLoginHandoffById(id: string): Promise<AdminAgentLoginHandoffRecord | null> {
    const row = await this.adapter.queryOne<AdminAgentLoginHandoffRow>(
      'SELECT * FROM admin_agent_login_handoffs WHERE id = ?',
      [id]
    );
    return row ? toAdminAgentLoginHandoffRecord(row) : null;
  }

  async getLoginHandoffByCodeHash(codeHash: string): Promise<AdminAgentLoginHandoffRecord | null> {
    const row = await this.adapter.queryOne<AdminAgentLoginHandoffRow>(
      'SELECT * FROM admin_agent_login_handoffs WHERE code_hash = ?',
      [codeHash]
    );
    return row ? toAdminAgentLoginHandoffRecord(row) : null;
  }

  async issueLoginHandoff(input: IssueAdminAgentLoginHandoffInput): Promise<boolean> {
    if (input.expiresAt <= input.issuedAt) {
      throw new TypeError('Issued Admin Agent login handoff must expire in the future');
    }
    const results = await this.adapter.batch([
      {
        sql: `UPDATE admin_agent_login_handoffs
          SET status = 'issued', source_session_id = ?, source_session_hash = ?,
              admin_user_id = ?, code_hash = ?, last_transition_id = ?,
              issued_at = ?, expires_at = ?
          WHERE id = ? AND target_tenant_id = ? AND status = 'pending' AND expires_at > ?`,
        params: [
          input.sourceSessionId,
          input.sourceSessionHash,
          input.adminUserId,
          input.codeHash,
          input.transitionId,
          input.issuedAt,
          input.expiresAt,
          input.id,
          input.targetTenantId,
          input.issuedAt,
        ],
      },
      adminAgentAuditStatement(input.audit, {
        from: 'admin_agent_login_handoffs',
        where: "id = ? AND target_tenant_id = ? AND last_transition_id = ? AND status = 'issued'",
        params: [input.id, input.targetTenantId, input.transitionId],
      }),
    ]);
    return (results[0]?.rowsAffected ?? 0) === 1;
  }

  async consumeLoginHandoff(input: ConsumeAdminAgentLoginHandoffInput): Promise<boolean> {
    if (
      input.targetSession.expiresAt <= input.consumedAt ||
      input.targetSession.parentSessionId.trim() === '' ||
      input.targetSession.parentSessionHash.trim() === '' ||
      input.targetSession.id === input.targetSession.parentSessionId ||
      input.targetSession.adminUserId.trim() === '' ||
      input.targetSession.tenantId.trim() === '' ||
      input.targetSession.createdAt > input.consumedAt ||
      input.targetSession.mfaVerifiedAt > input.consumedAt
    ) {
      throw new TypeError('Invalid derived Admin session for login handoff');
    }
    const results = await this.adapter.batch([
      {
        sql: `UPDATE admin_agent_login_handoffs
          SET status = 'consumed', source_session_id = NULL, last_transition_id = ?,
              consumed_at = ?
          WHERE id = ? AND target_tenant_id = ? AND code_hash = ?
            AND admin_user_id = ? AND source_session_hash = ?
            AND status = 'issued' AND expires_at > ?`,
        params: [
          input.transitionId,
          input.consumedAt,
          input.id,
          input.targetTenantId,
          input.codeHash,
          input.targetSession.adminUserId,
          input.targetSession.parentSessionHash,
          input.consumedAt,
        ],
      },
      {
        sql: `INSERT INTO admin_sessions (
          id, tenant_id, admin_user_id, ip_address, user_agent,
          created_at, expires_at, last_activity_at, mfa_verified, mfa_verified_at,
          parent_session_id, derived_target_tenant_id
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?
          FROM admin_agent_login_handoffs
          WHERE id = ? AND target_tenant_id = ? AND last_transition_id = ?
            AND status = 'consumed'`,
        params: [
          input.targetSession.id,
          input.targetSession.tenantId,
          input.targetSession.adminUserId,
          input.targetSession.ipAddress ?? null,
          input.targetSession.userAgent ?? null,
          input.targetSession.createdAt,
          input.targetSession.expiresAt,
          input.consumedAt,
          input.targetSession.mfaVerifiedAt,
          input.targetSession.parentSessionId,
          input.targetTenantId,
          input.id,
          input.targetTenantId,
          input.transitionId,
        ],
      },
      adminAgentAuditStatement(input.audit, {
        from: 'admin_agent_login_handoffs',
        where: "id = ? AND target_tenant_id = ? AND last_transition_id = ? AND status = 'consumed'",
        params: [input.id, input.targetTenantId, input.transitionId],
      }),
    ]);
    return (results[0]?.rowsAffected ?? 0) === 1;
  }

  async purgeLoginHandoffs(olderThan: number): Promise<number> {
    const result = await this.adapter.execute(
      `DELETE FROM admin_agent_login_handoffs
       WHERE (status = 'consumed' AND consumed_at < ?)
          OR (status IN ('pending', 'issued') AND expires_at < ?)`,
      [olderThan, olderThan]
    );
    return result.rowsAffected;
  }

  async writeAudit(audit: AdminAgentAuditWrite): Promise<void> {
    const statement = adminAgentAuditStatement(audit);
    await this.adapter.execute(statement.sql, statement.params);
  }

  async createGrant(input: CreateAdminAgentGrantInput): Promise<void> {
    const statement = createAdminAgentGrantStatement(input);
    await this.adapter.execute(statement.sql, statement.params);
  }

  async createGrantWithAudit(input: CreateAdminAgentGrantWithAuditInput): Promise<void> {
    await this.adapter.batch([
      createAdminAgentGrantStatement(input.grant),
      adminAgentAuditStatement(input.audit),
    ]);
  }

  /** Atomically creates an enterprise-preauthorized Grant and both authorization records. */
  async createGrantWithPreauthorization(
    input: CreateAdminAgentGrantWithPreauthorizationInput
  ): Promise<void> {
    if (
      input.grant.delegationMode !== 'admin_pre_authorized' ||
      !input.grant.machinePrincipalId ||
      input.delegationConsent.type !== 'delegation' ||
      input.oauthClientConsent.type !== 'oauth_client' ||
      input.delegationConsent.grantId !== input.grant.grantId ||
      input.oauthClientConsent.grantId !== input.grant.grantId ||
      input.delegationConsent.userId !== input.grant.delegatorId ||
      input.oauthClientConsent.userId !== input.grant.delegatorId ||
      input.delegationConsent.clientId !== input.grant.clientId ||
      input.oauthClientConsent.clientId !== input.grant.clientId ||
      input.delegationConsent.consentVersion !== input.grant.consentVersion ||
      input.oauthClientConsent.consentVersion !== input.grant.consentVersion
    ) {
      throw new TypeError('Agent preauthorization must match one Mode B Grant');
    }
    await this.adapter.batch([
      createAdminAgentGrantStatement(input.grant),
      createExactSelfServiceConsentStatement(input.delegationConsent, input.audit.id),
      createExactSelfServiceConsentStatement(input.oauthClientConsent, input.audit.id),
      adminAgentAuditStatement(input.audit),
      adminAgentAuditStatement(input.consentAudit),
    ]);
  }

  /**
   * Atomically creates the internal control plane for one interactive self-service connection.
   * The generated Task Set and Scope Policy are immutable implementation details, not a setup
   * prerequisite exposed to the operator.
   */
  async createSelfServiceAuthorization(
    input: CreateSelfServiceAgentAuthorizationInput
  ): Promise<void> {
    await assertSelfServiceAuthorizationConsistency(input);
    await this.adapter.batch([
      {
        sql: `INSERT INTO agent_task_sets (
          id, tenant_id, name, description, kind, status, current_version,
          management_mode, created_by, last_transition_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'custom', 'active', ?, 'system_managed', ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = CASE WHEN
          agent_task_sets.tenant_id IS excluded.tenant_id AND
          agent_task_sets.name IS excluded.name AND
          agent_task_sets.description IS excluded.description AND
          agent_task_sets.kind IS excluded.kind AND
          agent_task_sets.status IS excluded.status AND
          agent_task_sets.current_version IS excluded.current_version AND
          agent_task_sets.management_mode IS excluded.management_mode AND
          agent_task_sets.created_by IS excluded.created_by AND
          agent_task_sets.last_transition_id IS excluded.last_transition_id AND
          agent_task_sets.created_at IS excluded.created_at AND
          agent_task_sets.updated_at IS excluded.updated_at
          THEN agent_task_sets.name ELSE NULL END`,
        params: [
          input.taskSet.id,
          input.grant.tenantId,
          `System-managed connection ${input.grant.grantId}`,
          'Generated from scopes approved during interactive Agent consent.',
          input.taskSet.version,
          input.grant.delegatorId,
          input.audit.id,
          input.grant.createdAt,
          input.grant.createdAt,
        ],
      },
      {
        sql: `INSERT INTO agent_task_set_versions (
          task_set_id, version, tool_entries_json, resolved_permissions_json,
          definition_digest, catalog_version, status, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT(task_set_id, version) DO UPDATE SET definition_digest = CASE WHEN
          agent_task_set_versions.tool_entries_json IS excluded.tool_entries_json AND
          agent_task_set_versions.resolved_permissions_json IS excluded.resolved_permissions_json AND
          agent_task_set_versions.definition_digest IS excluded.definition_digest AND
          agent_task_set_versions.catalog_version IS excluded.catalog_version AND
          agent_task_set_versions.status IS excluded.status AND
          agent_task_set_versions.created_by IS excluded.created_by AND
          agent_task_set_versions.created_at IS excluded.created_at
          THEN agent_task_set_versions.definition_digest ELSE NULL END`,
        params: [
          input.taskSet.id,
          input.taskSet.version,
          JSON.stringify(input.taskSet.resolved.tools),
          JSON.stringify(input.taskSet.resolved.permissions),
          input.taskSet.digest,
          input.taskSet.resolved.catalogVersion,
          input.grant.delegatorId,
          input.grant.createdAt,
        ],
      },
      {
        sql: `INSERT INTO agent_scope_policies (
          id, tenant_id, name, description, kind, status, current_version,
          management_mode, created_by, last_transition_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'custom', 'active', ?, 'system_managed', ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = CASE WHEN
          agent_scope_policies.tenant_id IS excluded.tenant_id AND
          agent_scope_policies.name IS excluded.name AND
          agent_scope_policies.description IS excluded.description AND
          agent_scope_policies.kind IS excluded.kind AND
          agent_scope_policies.status IS excluded.status AND
          agent_scope_policies.current_version IS excluded.current_version AND
          agent_scope_policies.management_mode IS excluded.management_mode AND
          agent_scope_policies.created_by IS excluded.created_by AND
          agent_scope_policies.last_transition_id IS excluded.last_transition_id AND
          agent_scope_policies.created_at IS excluded.created_at AND
          agent_scope_policies.updated_at IS excluded.updated_at
          THEN agent_scope_policies.name ELSE NULL END`,
        params: [
          input.scopePolicy.id,
          input.grant.tenantId,
          `System-managed connection ${input.grant.grantId}`,
          'Generated masked, single-tenant limits approved during interactive Agent consent.',
          input.scopePolicy.version,
          input.grant.delegatorId,
          input.audit.id,
          input.grant.createdAt,
          input.grant.createdAt,
        ],
      },
      {
        sql: `INSERT INTO agent_scope_policy_versions (
          scope_policy_id, version, definition_json, definition_digest,
          selector_catalog_version, status, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT(scope_policy_id, version) DO UPDATE SET definition_digest = CASE WHEN
          agent_scope_policy_versions.definition_json IS excluded.definition_json AND
          agent_scope_policy_versions.definition_digest IS excluded.definition_digest AND
          agent_scope_policy_versions.selector_catalog_version IS excluded.selector_catalog_version AND
          agent_scope_policy_versions.status IS excluded.status AND
          agent_scope_policy_versions.created_by IS excluded.created_by AND
          agent_scope_policy_versions.created_at IS excluded.created_at
          THEN agent_scope_policy_versions.definition_digest ELSE NULL END`,
        params: [
          input.scopePolicy.id,
          input.scopePolicy.version,
          JSON.stringify(input.scopePolicy.definition),
          input.scopePolicy.digest,
          input.scopePolicy.selectorCatalogVersion,
          input.grant.delegatorId,
          input.grant.createdAt,
        ],
      },
      createAdminAgentGrantStatement(input.grant),
      createExactSelfServiceConsentStatement(input.delegationConsent, input.audit.id),
      createExactSelfServiceConsentStatement(input.oauthClientConsent, input.audit.id),
      adminAgentAuditStatement(input.audit),
      adminAgentAuditStatement(input.consentAudit),
    ]);
  }

  /** Atomically replaces the immutable snapshot and consent version of a self-service Grant. */
  async replaceSelfServiceAuthorization(
    input: ReplaceSelfServiceAgentAuthorizationInput
  ): Promise<{ familyCount: number }> {
    if (input.grant.generation !== input.expectedGeneration + 1) {
      throw new TypeError('Self-service replacement inputs are inconsistent');
    }
    if (input.outboxId !== selfServiceRevocationOutboxId(input.transitionId)) {
      throw new TypeError('Self-service replacement outbox must be transition-bound');
    }
    await assertSelfServiceAuthorizationConsistency(input);
    if (!hasCompleteAgentConfigurationSnapshot(input.grant)) {
      throw new TypeError('Self-service replacement requires a complete configuration snapshot');
    }
    parseScopeConstraints(
      JSON.stringify(input.grant.resolvedScopeConstraints),
      input.grant.tenantId
    );
    const guard = {
      from: 'admin_agent_grants',
      where: 'tenant_id = ? AND id = ? AND last_mutation_id = ?',
      params: [input.grant.tenantId, input.grant.grantId, input.transitionId],
    } as const;
    const results = await this.adapter.batch([
      {
        sql: `UPDATE admin_agent_grants SET
          permissions = ?, scopes = ?, authorization_details = ?, resolved_scope_constraints = ?, purpose = ?,
          task_set_id = ?, task_set_version = ?, scope_policy_id = ?, scope_policy_version = ?,
          resolved_tools = ?, access_snapshot_hash = ?, generation = ?, consent_version = ?,
          expires_at = ?, updated_at = ?, last_mutation_id = ?
        WHERE tenant_id = ? AND id = ? AND client_id = ? AND delegator_id = ?
          AND status = 'active' AND purpose = 'interactive_self_service' AND generation = ?`,
        params: [
          JSON.stringify(input.grant.permissions),
          JSON.stringify(input.grant.scopes),
          input.grant.authorizationDetails
            ? JSON.stringify(input.grant.authorizationDetails)
            : null,
          JSON.stringify(input.grant.resolvedScopeConstraints),
          input.grant.purpose,
          input.taskSet.id,
          input.taskSet.version,
          input.scopePolicy.id,
          input.scopePolicy.version,
          JSON.stringify(input.grant.resolvedTools),
          input.grant.accessSnapshotHash,
          input.grant.generation,
          input.grant.consentVersion,
          input.grant.expiresAt ?? null,
          input.grant.createdAt,
          input.transitionId,
          input.grant.tenantId,
          input.grant.grantId,
          input.grant.clientId,
          input.grant.delegatorId,
          input.expectedGeneration,
        ],
      },
      {
        sql: `INSERT INTO agent_task_sets (
          id, tenant_id, name, description, kind, status, current_version,
          management_mode, created_by, last_transition_id, created_at, updated_at
        ) SELECT ?, ?, ?, ?, 'custom', 'active', ?, 'system_managed', ?, ?, ?, ? FROM ${guard.from}
          WHERE ${guard.where}
        ON CONFLICT(id) DO UPDATE SET name = CASE WHEN
          agent_task_sets.tenant_id IS excluded.tenant_id AND
          agent_task_sets.name IS excluded.name AND
          agent_task_sets.description IS excluded.description AND
          agent_task_sets.kind IS excluded.kind AND
          agent_task_sets.status IS excluded.status AND
          agent_task_sets.current_version IS excluded.current_version AND
          agent_task_sets.management_mode IS excluded.management_mode AND
          agent_task_sets.created_by IS excluded.created_by AND
          agent_task_sets.last_transition_id IS excluded.last_transition_id AND
          agent_task_sets.created_at IS excluded.created_at AND
          agent_task_sets.updated_at IS excluded.updated_at
          THEN agent_task_sets.name ELSE NULL END`,
        params: [
          input.taskSet.id,
          input.grant.tenantId,
          `System-managed connection ${input.grant.grantId} v${input.grant.consentVersion}`,
          'Regenerated from the approved interactive Agent scope set.',
          input.taskSet.version,
          input.grant.delegatorId,
          input.transitionId,
          input.grant.createdAt,
          input.grant.createdAt,
          ...guard.params,
        ],
      },
      {
        sql: `INSERT INTO agent_task_set_versions (
          task_set_id, version, tool_entries_json, resolved_permissions_json,
          definition_digest, catalog_version, status, created_by, created_at
        ) SELECT ?, ?, ?, ?, ?, ?, 'active', ?, ? FROM ${guard.from} WHERE ${guard.where}
        ON CONFLICT(task_set_id, version) DO UPDATE SET definition_digest = CASE WHEN
          agent_task_set_versions.tool_entries_json IS excluded.tool_entries_json AND
          agent_task_set_versions.resolved_permissions_json IS excluded.resolved_permissions_json AND
          agent_task_set_versions.definition_digest IS excluded.definition_digest AND
          agent_task_set_versions.catalog_version IS excluded.catalog_version AND
          agent_task_set_versions.status IS excluded.status AND
          agent_task_set_versions.created_by IS excluded.created_by AND
          agent_task_set_versions.created_at IS excluded.created_at
          THEN agent_task_set_versions.definition_digest ELSE NULL END`,
        params: [
          input.taskSet.id,
          input.taskSet.version,
          JSON.stringify(input.taskSet.resolved.tools),
          JSON.stringify(input.taskSet.resolved.permissions),
          input.taskSet.digest,
          input.taskSet.resolved.catalogVersion,
          input.grant.delegatorId,
          input.grant.createdAt,
          ...guard.params,
        ],
      },
      {
        sql: `INSERT INTO agent_scope_policies (
          id, tenant_id, name, description, kind, status, current_version,
          management_mode, created_by, last_transition_id, created_at, updated_at
        ) SELECT ?, ?, ?, ?, 'custom', 'active', ?, 'system_managed', ?, ?, ?, ? FROM ${guard.from}
          WHERE ${guard.where}
        ON CONFLICT(id) DO UPDATE SET name = CASE WHEN
          agent_scope_policies.tenant_id IS excluded.tenant_id AND
          agent_scope_policies.name IS excluded.name AND
          agent_scope_policies.description IS excluded.description AND
          agent_scope_policies.kind IS excluded.kind AND
          agent_scope_policies.status IS excluded.status AND
          agent_scope_policies.current_version IS excluded.current_version AND
          agent_scope_policies.management_mode IS excluded.management_mode AND
          agent_scope_policies.created_by IS excluded.created_by AND
          agent_scope_policies.last_transition_id IS excluded.last_transition_id AND
          agent_scope_policies.created_at IS excluded.created_at AND
          agent_scope_policies.updated_at IS excluded.updated_at
          THEN agent_scope_policies.name ELSE NULL END`,
        params: [
          input.scopePolicy.id,
          input.grant.tenantId,
          `System-managed connection ${input.grant.grantId} v${input.grant.consentVersion}`,
          'Regenerated masked single-tenant limits for interactive Agent consent.',
          input.scopePolicy.version,
          input.grant.delegatorId,
          input.transitionId,
          input.grant.createdAt,
          input.grant.createdAt,
          ...guard.params,
        ],
      },
      {
        sql: `INSERT INTO agent_scope_policy_versions (
          scope_policy_id, version, definition_json, definition_digest,
          selector_catalog_version, status, created_by, created_at
        ) SELECT ?, ?, ?, ?, ?, 'active', ?, ? FROM ${guard.from} WHERE ${guard.where}
        ON CONFLICT(scope_policy_id, version) DO UPDATE SET definition_digest = CASE WHEN
          agent_scope_policy_versions.definition_json IS excluded.definition_json AND
          agent_scope_policy_versions.definition_digest IS excluded.definition_digest AND
          agent_scope_policy_versions.selector_catalog_version IS excluded.selector_catalog_version AND
          agent_scope_policy_versions.status IS excluded.status AND
          agent_scope_policy_versions.created_by IS excluded.created_by AND
          agent_scope_policy_versions.created_at IS excluded.created_at
          THEN agent_scope_policy_versions.definition_digest ELSE NULL END`,
        params: [
          input.scopePolicy.id,
          input.scopePolicy.version,
          JSON.stringify(input.scopePolicy.definition),
          input.scopePolicy.digest,
          input.scopePolicy.selectorCatalogVersion,
          input.grant.delegatorId,
          input.grant.createdAt,
          ...guard.params,
        ],
      },
      replaceSelfServiceConsentStatement(input.delegationConsent, input.transitionId, guard),
      replaceSelfServiceConsentStatement(input.oauthClientConsent, input.transitionId, guard),
      {
        sql: `UPDATE admin_agent_token_families
          SET status = 'revocation_pending', updated_at = ?, revocation_outbox_id = ?
          WHERE tenant_id = ? AND grant_id = ? AND grant_generation = ?
            AND status IN ('pending_finalization', 'active', 'revocation_pending')
            AND EXISTS (SELECT 1 FROM ${guard.from} WHERE ${guard.where})`,
        params: [
          input.grant.createdAt,
          input.outboxId,
          input.grant.tenantId,
          input.grant.grantId,
          input.expectedGeneration,
          ...guard.params,
        ],
      },
      {
        sql: `INSERT INTO admin_agent_token_revocation_outbox (
          id, tenant_id, grant_id, grant_generation, client_id, event_type, payload,
          status, attempt_count, processing_fence, next_attempt_at, created_at
        ) SELECT ?, ?, ?, ?, ?, 'revoke_grant_families',
          json_object(
            'family_ids', json(COALESCE((SELECT json_group_array(family_id) FROM (
              SELECT family_id FROM admin_agent_token_families
              WHERE tenant_id = ? AND revocation_outbox_id = ? ORDER BY family_id
            )), '[]')),
            'family_jtis', json(COALESCE((SELECT json_group_array(family_jti) FROM (
              SELECT family_jti FROM admin_agent_token_families
              WHERE tenant_id = ? AND revocation_outbox_id = ? ORDER BY family_id
            )), '[]')),
            'reason', 'self_service_scope_changed'
          ), 'pending', 0, 0, ?, ? FROM ${guard.from} WHERE ${guard.where}
        ON CONFLICT(id) DO UPDATE SET payload = CASE WHEN
          admin_agent_token_revocation_outbox.tenant_id IS excluded.tenant_id AND
          admin_agent_token_revocation_outbox.grant_id IS excluded.grant_id AND
          admin_agent_token_revocation_outbox.grant_generation IS excluded.grant_generation AND
          admin_agent_token_revocation_outbox.client_id IS excluded.client_id AND
          admin_agent_token_revocation_outbox.event_type IS excluded.event_type AND
          admin_agent_token_revocation_outbox.payload IS excluded.payload AND
          admin_agent_token_revocation_outbox.created_at IS excluded.created_at
          THEN admin_agent_token_revocation_outbox.payload ELSE NULL END`,
        params: [
          input.outboxId,
          input.grant.tenantId,
          input.grant.grantId,
          input.expectedGeneration,
          input.grant.clientId,
          input.grant.tenantId,
          input.outboxId,
          input.grant.tenantId,
          input.outboxId,
          input.grant.createdAt,
          input.grant.createdAt,
          ...guard.params,
        ],
      },
      adminAgentAuditStatement(input.grantAudit, guard),
      adminAgentAuditStatement(input.consentAudit, guard),
    ]);
    if (results[0]?.rowsAffected !== 1) {
      const replay = await this.adapter.queryOne<{
        machine_principal_id: string | null;
        grantor_id: string;
        permissions: string;
        scopes: string;
        authorization_details: string | null;
        resolved_scope_constraints: string;
        purpose: string | null;
        management_mode: 'managed' | 'system_managed';
        task_set_id: string | null;
        task_set_version: number | null;
        scope_policy_id: string | null;
        scope_policy_version: number | null;
        resolved_tools: string | null;
        access_snapshot_hash: string | null;
        generation: number;
        consent_version: number;
        status: AgentGrantStatus;
        delegation_mode: AgentDelegationMode;
        expires_at: number | null;
        updated_at: number;
        last_mutation_id: string | null;
      }>(
        `SELECT machine_principal_id, grantor_id, permissions, scopes, authorization_details,
          resolved_scope_constraints, purpose, management_mode, task_set_id, task_set_version,
          scope_policy_id, scope_policy_version, resolved_tools, access_snapshot_hash, generation,
          consent_version, status, delegation_mode, expires_at, updated_at, last_mutation_id
         FROM admin_agent_grants
         WHERE tenant_id = ? AND id = ? AND client_id = ? AND delegator_id = ?`,
        [input.grant.tenantId, input.grant.grantId, input.grant.clientId, input.grant.delegatorId]
      );
      if (
        !replay ||
        replay.machine_principal_id !== (input.grant.machinePrincipalId ?? null) ||
        replay.grantor_id !== input.grant.grantorId ||
        replay.permissions !== JSON.stringify(input.grant.permissions) ||
        replay.scopes !== JSON.stringify(input.grant.scopes) ||
        replay.authorization_details !==
          (input.grant.authorizationDetails
            ? JSON.stringify(input.grant.authorizationDetails)
            : null) ||
        replay.resolved_scope_constraints !==
          JSON.stringify(input.grant.resolvedScopeConstraints) ||
        replay.purpose !== (input.grant.purpose ?? null) ||
        replay.management_mode !== (input.grant.managementMode ?? 'managed') ||
        replay.task_set_id !== (input.grant.taskSetId ?? null) ||
        replay.task_set_version !== (input.grant.taskSetVersion ?? null) ||
        replay.scope_policy_id !== (input.grant.scopePolicyId ?? null) ||
        replay.scope_policy_version !== (input.grant.scopePolicyVersion ?? null) ||
        replay.resolved_tools !==
          (input.grant.resolvedTools ? JSON.stringify(input.grant.resolvedTools) : null) ||
        replay.access_snapshot_hash !== (input.grant.accessSnapshotHash ?? null) ||
        replay.generation !== input.grant.generation ||
        replay.consent_version !== input.grant.consentVersion ||
        replay.status !== input.grant.status ||
        replay.delegation_mode !== input.grant.delegationMode ||
        replay.expires_at !== (input.grant.expiresAt ?? null) ||
        replay.updated_at !== input.grant.createdAt ||
        replay.last_mutation_id !== input.transitionId
      ) {
        throw new AgentAccessConflictError('Self-service Agent Grant changed during consent');
      }
    }
    const outbox = await this.adapter.queryOne<{ payload: string }>(
      `SELECT payload FROM admin_agent_token_revocation_outbox
       WHERE id = ? AND tenant_id = ? AND grant_id = ?`,
      [input.outboxId, input.grant.tenantId, input.grant.grantId]
    );
    if (!outbox) throw new AgentAccessConflictError('Self-service revocation outbox is missing');
    return { familyCount: parseRevocationPayload(outbox.payload).familyIds.length };
  }

  /** Suspends every active Grant for a changed CIMD identity before the new metadata is trusted. */
  async suspendForClientMetadataChange(
    input: SuspendAgentClientMetadataChangeInput
  ): Promise<{ suspendedGrantCount: number }> {
    const existing = await this.adapter.queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM admin_agent_grants
       WHERE tenant_id = ? AND client_id = ? AND status = 'active'`,
      [input.tenantId, input.clientId]
    );
    const suspendedGrantCount = existing?.total ?? 0;
    if (suspendedGrantCount === 0) return { suspendedGrantCount: 0 };
    await this.adapter.batch([
      {
        sql: `UPDATE admin_agent_grants SET status = 'suspended', active_uniqueness_key = id,
          generation = generation + 1, consent_version = consent_version + 1,
          updated_at = ?, last_mutation_id = ?
        WHERE tenant_id = ? AND client_id = ? AND status = 'active'`,
        params: [input.now, input.transitionId, input.tenantId, input.clientId],
      },
      {
        sql: `UPDATE agent_consents SET revoked_at = ?, revoked_reason = 'grant_updated',
          last_mutation_id = ? WHERE tenant_id = ? AND client_id = ? AND revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM admin_agent_grants g WHERE g.id = agent_consents.grant_id
            AND g.tenant_id = ? AND g.client_id = ? AND g.last_mutation_id = ?)`,
        params: [
          input.now,
          input.transitionId,
          input.tenantId,
          input.clientId,
          input.tenantId,
          input.clientId,
          input.transitionId,
        ],
      },
      {
        sql: `UPDATE admin_agent_token_families SET status = 'revocation_pending',
          updated_at = ?, revocation_outbox_id = ?
        WHERE tenant_id = ? AND client_id = ?
          AND status IN ('pending_finalization', 'active', 'revocation_pending')
          AND EXISTS (SELECT 1 FROM admin_agent_grants g
            WHERE g.id = admin_agent_token_families.grant_id AND g.tenant_id = ?
              AND g.client_id = ? AND g.last_mutation_id = ?)`,
        params: [
          input.now,
          input.outboxId,
          input.tenantId,
          input.clientId,
          input.tenantId,
          input.clientId,
          input.transitionId,
        ],
      },
      {
        sql: `INSERT INTO admin_agent_token_revocation_outbox (
          id, tenant_id, grant_id, grant_generation, client_id, event_type, payload,
          status, attempt_count, processing_fence, next_attempt_at, created_at
        ) SELECT ?, ?, NULL, NULL, ?, 'revoke_client_families',
          json_object(
            'family_ids', json(COALESCE((SELECT json_group_array(family_id) FROM (
              SELECT family_id FROM admin_agent_token_families
              WHERE tenant_id = ? AND revocation_outbox_id = ? ORDER BY family_id
            )), '[]')),
            'family_jtis', json(COALESCE((SELECT json_group_array(family_jti) FROM (
              SELECT family_jti FROM admin_agent_token_families
              WHERE tenant_id = ? AND revocation_outbox_id = ? ORDER BY family_id
            )), '[]')),
            'reason', 'client_metadata_changed'
          ), 'pending', 0, 0, ?, ?
        WHERE EXISTS (SELECT 1 FROM admin_agent_grants
          WHERE tenant_id = ? AND client_id = ? AND last_mutation_id = ?)`,
        params: [
          input.outboxId,
          input.tenantId,
          input.clientId,
          input.tenantId,
          input.outboxId,
          input.tenantId,
          input.outboxId,
          input.now,
          input.now,
          input.tenantId,
          input.clientId,
          input.transitionId,
        ],
      },
      adminAgentAuditStatement(
        {
          id: input.transitionId,
          tenantId: input.tenantId,
          action: 'agent.client_metadata.changed',
          resourceType: 'oauth_client',
          resourceId: input.clientId,
          severity: 'warn',
          actorType: 'system',
          actorSub: 'system:cimd-verifier',
          metadata: {
            client_id: input.clientId,
            old_hash: input.oldHash,
            new_hash: input.newHash,
            suspended_grant_count: suspendedGrantCount,
          },
          createdAt: input.now,
        },
        {
          from: 'admin_agent_grants',
          where: 'tenant_id = ? AND client_id = ? AND last_mutation_id = ?',
          params: [input.tenantId, input.clientId, input.transitionId],
        }
      ),
    ]);
    return { suspendedGrantCount };
  }

  async getGrant(tenantId: string, grantId: string): Promise<AgentGrantContract | null> {
    const row = await this.adapter.queryOne<AgentGrantRow>(
      `SELECT id, tenant_id, client_id, machine_principal_id, grantor_id, delegator_id,
        permissions, scopes, authorization_details, resolved_scope_constraints, consent_version, generation, status,
        delegation_mode, expires_at, task_set_id, task_set_version, scope_policy_id,
        scope_policy_version, resolved_tools, access_snapshot_hash
       FROM admin_agent_grants WHERE tenant_id = ? AND id = ?`,
      [tenantId, grantId]
    );
    return row ? toGrant(row) : null;
  }

  async getGrantRecord(tenantId: string, grantId: string): Promise<AdminAgentGrantRecord | null> {
    const row = await this.adapter.queryOne<AdminAgentGrantRecordRow>(
      `SELECT id, tenant_id, client_id, machine_principal_id, grantor_id, delegator_id,
        permissions, scopes, authorization_details, resolved_scope_constraints, consent_version,
        generation, status, delegation_mode, purpose, management_mode, expires_at, task_set_id, task_set_version,
        scope_policy_id, scope_policy_version, resolved_tools, access_snapshot_hash,
        last_used_at, created_at,
        updated_at, revoked_at, revoked_by
       FROM admin_agent_grants WHERE tenant_id = ? AND id = ?`,
      [tenantId, grantId]
    );
    return row ? toAdminAgentGrantRecord(row) : null;
  }

  async listGrants(
    input: ListAdminAgentGrantsInput
  ): Promise<{ grants: AdminAgentGrantRecord[]; total: number }> {
    const conditions = ['tenant_id = ?'];
    const params: unknown[] = [input.tenantId];
    if (input.delegatorId) {
      conditions.push('delegator_id = ?');
      params.push(input.delegatorId);
    }
    if (input.machinePrincipalId) {
      conditions.push('machine_principal_id = ?');
      params.push(input.machinePrincipalId);
    }
    if (input.status) {
      conditions.push('status = ?');
      params.push(input.status);
    }
    const where = conditions.join(' AND ');
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const offset = Math.max(input.offset ?? 0, 0);
    const [rows, count] = await Promise.all([
      this.adapter.query<AdminAgentGrantRecordRow>(
        `SELECT id, tenant_id, client_id, machine_principal_id, grantor_id, delegator_id,
          permissions, scopes, authorization_details, resolved_scope_constraints, consent_version,
          generation, status, delegation_mode, purpose, management_mode, expires_at, task_set_id, task_set_version,
          scope_policy_id, scope_policy_version, resolved_tools, access_snapshot_hash,
          last_used_at, created_at,
          updated_at, revoked_at, revoked_by
         FROM admin_agent_grants WHERE ${where}
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      ),
      this.adapter.queryOne<{ total: number }>(
        `SELECT COUNT(*) AS total FROM admin_agent_grants WHERE ${where}`,
        params
      ),
    ]);
    return { grants: rows.map(toAdminAgentGrantRecord), total: count?.total ?? 0 };
  }

  async listGrantAudit(
    tenantId: string,
    grantId: string,
    limit: number = 100
  ): Promise<AdminAgentGrantAuditRecord[]> {
    const rows = await this.adapter.query<{
      id: string;
      action: string;
      result: string;
      severity: string;
      actor_type: string | null;
      actor_sub: string | null;
      metadata_json: string;
      created_at: number;
    }>(
      `SELECT id, action, result, severity, actor_type, actor_sub, metadata_json, created_at
       FROM admin_audit_log
       WHERE tenant_id = ? AND grant_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      [tenantId, grantId, Math.min(Math.max(limit, 1), 200)]
    );
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      result: row.result,
      severity: row.severity,
      actorType: row.actor_type ?? undefined,
      actorSub: row.actor_sub ?? undefined,
      metadata: parseJsonObject(row.metadata_json),
      createdAt: row.created_at,
    }));
  }

  async findActiveGrantForDelegatorClient(
    tenantId: string,
    delegatorId: string,
    clientId: string
  ): Promise<AgentGrantContract | null> {
    const row = await this.adapter.queryOne<AgentGrantRow>(
      `SELECT id, tenant_id, client_id, machine_principal_id, grantor_id, delegator_id,
        permissions, scopes, authorization_details, resolved_scope_constraints, consent_version, generation, status,
        delegation_mode, expires_at, task_set_id, task_set_version, scope_policy_id,
        scope_policy_version, resolved_tools, access_snapshot_hash
       FROM admin_agent_grants
       WHERE tenant_id = ? AND delegator_id = ? AND client_id = ?
         AND status = 'active' AND active_uniqueness_key = 'active'`,
      [tenantId, delegatorId, clientId]
    );
    return row ? toGrant(row) : null;
  }

  async getActiveDelegatorPermissions(
    targetTenantId: string,
    delegatorId: string,
    now: number
  ): Promise<string[] | null> {
    // Admin identities and their role assignments belong to the Admin user's home tenant.
    // A global assignment (or an explicitly target-scoped assignment) may authorize a
    // derived Admin session and Agent Grant in another tenant, so targetTenantId must not
    // be used to locate the Admin user itself.
    const user = await this.adapter.queryOne<{ id: string; tenant_id: string }>(
      `SELECT id, tenant_id FROM admin_users
       WHERE id = ? AND is_active = 1 AND status = 'active'`,
      [delegatorId]
    );
    if (!user) return null;
    const homeTenantId = user.tenant_id;

    const roles = await this.adapter.query<AdminPermissionRow>(
      `WITH RECURSIVE effective_roles(id, permissions_json, inherits_from) AS (
         SELECT r.id, r.permissions_json, r.inherits_from
         FROM admin_role_assignments ra
         JOIN admin_roles r ON r.id = ra.admin_role_id
         WHERE ra.admin_user_id = ? AND ra.tenant_id = ?
           AND (r.tenant_id = ? OR (r.tenant_id = 'default' AND r.is_system = 1))
           AND (
             ra.scope_type = 'global'
             OR (
               ra.scope_type = 'tenant'
               AND (
                 ra.scope_id = ?
                 OR (ra.scope_id IS NULL AND ? = ra.tenant_id)
               )
             )
           )
           AND (ra.expires_at IS NULL OR ra.expires_at > ?)
         UNION
         SELECT parent.id, parent.permissions_json, parent.inherits_from
         FROM admin_roles parent
         JOIN effective_roles child ON child.inherits_from = parent.id
         WHERE parent.tenant_id = ? OR (parent.tenant_id = 'default' AND parent.is_system = 1)
       )
       SELECT DISTINCT permissions_json FROM effective_roles`,
      [delegatorId, homeTenantId, homeTenantId, targetTenantId, targetTenantId, now, homeTenantId]
    );
    const permissions = new Set<string>();
    for (const role of roles) {
      for (const permission of parseStringArray(role.permissions_json)) permissions.add(permission);
    }
    return [...permissions];
  }

  async upsertConsent(input: UpsertAgentConsentInput): Promise<void> {
    const statement = upsertAgentConsentStatement(input);
    await this.adapter.execute(statement.sql, statement.params);
  }

  async grantConsentPair(input: GrantAgentConsentPairInput): Promise<void> {
    const { delegation, oauthClient } = input;
    if (
      delegation.type !== 'delegation' ||
      oauthClient.type !== 'oauth_client' ||
      delegation.tenantId !== oauthClient.tenantId ||
      delegation.grantId !== oauthClient.grantId ||
      delegation.userId !== oauthClient.userId ||
      delegation.clientId !== oauthClient.clientId ||
      delegation.consentVersion !== oauthClient.consentVersion
    ) {
      throw new TypeError('Agent consent pair must describe one Grant authorization');
    }
    const previousRows = await this.adapter.query<{
      consent_type: AgentConsentType;
      consent_version: number;
      revoked_at: number | null;
    }>(
      `SELECT consent_type, consent_version, revoked_at FROM agent_consents
       WHERE grant_id = ? AND client_id = ?
         AND consent_type IN ('delegation', 'oauth_client')`,
      [delegation.grantId, delegation.clientId]
    );
    const previousByType = new Map(previousRows.map((row) => [row.consent_type, row]));
    const previousDelegation = previousByType.get('delegation');
    const previousOauthClient = previousByType.get('oauth_client');
    await this.adapter.batch([
      upsertAgentConsentStatement(delegation),
      upsertAgentConsentStatement(oauthClient),
      adminAgentAuditStatement({
        ...input.audit,
        metadata: {
          ...input.audit.metadata,
          previous_delegation_version: previousDelegation?.consent_version ?? null,
          previous_delegation_revoked:
            previousDelegation !== undefined && previousDelegation.revoked_at !== null,
          previous_oauth_client_version: previousOauthClient?.consent_version ?? null,
          previous_oauth_client_revoked:
            previousOauthClient !== undefined && previousOauthClient.revoked_at !== null,
        },
      }),
    ]);
  }

  async hasCurrentConsent(
    tenantId: string,
    grantId: string,
    delegatorId: string,
    clientId: string,
    consentVersion: number
  ): Promise<boolean> {
    const rows = await this.adapter.query<AgentConsentRow>(
      `SELECT id, tenant_id, consent_type, grant_id, user_id, client_id,
        consent_version, scopes, granted_at, revoked_at, revoked_reason
       FROM agent_consents
       WHERE tenant_id = ? AND grant_id = ? AND user_id = ? AND client_id = ?`,
      [tenantId, grantId, delegatorId, clientId]
    );
    return hasCurrentAgentConsent(rows.map(toConsent), consentVersion);
  }

  async listUserConsents(tenantId: string, userId: string): Promise<AgentConsentWithGrant[]> {
    const rows = await this.adapter.query<AgentConsentWithGrantRow>(
      `SELECT c.id, c.tenant_id, c.consent_type, c.grant_id, c.user_id, c.client_id,
        c.consent_version, c.scopes, c.granted_at, c.revoked_at, c.revoked_reason,
        g.status AS grant_status, g.generation AS grant_generation
       FROM agent_consents c
       JOIN admin_agent_grants g ON g.id = c.grant_id AND g.tenant_id = c.tenant_id
       WHERE c.tenant_id = ? AND c.user_id = ?
       ORDER BY c.granted_at DESC, c.id DESC`,
      [tenantId, userId]
    );
    return rows.map((row) => ({
      ...toConsent(row),
      grantStatus: row.grant_status,
      grantGeneration: row.grant_generation,
    }));
  }

  async revokeOauthClientConsentAndQueueTokenRevocation(
    input: RevokeOauthClientConsentInput
  ): Promise<{ familyCount: number }> {
    if (
      input.audit.id !== input.outboxId ||
      input.audit.tenantId !== input.tenantId ||
      input.audit.resourceId !== input.consentId
    ) {
      throw new TypeError('OAuth client consent audit context does not match the revocation');
    }
    const results = await this.adapter.batch([
      {
        sql: `UPDATE agent_consents
         SET revoked_at = ?, revoked_reason = 'user', last_mutation_id = ?
         WHERE id = ? AND tenant_id = ? AND user_id = ? AND grant_id = ? AND client_id = ?
           AND consent_type = 'oauth_client' AND revoked_at IS NULL`,
        params: [
          input.now,
          input.outboxId,
          input.consentId,
          input.tenantId,
          input.userId,
          input.grantId,
          input.clientId,
        ],
      },
      {
        sql: `UPDATE admin_agent_token_families
         SET status = 'revocation_pending', updated_at = ?, revocation_outbox_id = ?
         WHERE tenant_id = ? AND grant_id = ? AND grant_generation = ? AND client_id = ?
           AND status IN ('pending_finalization', 'active', 'revocation_pending')
           AND EXISTS (
             SELECT 1 FROM agent_consents c
             WHERE c.id = ? AND c.tenant_id = ? AND c.last_mutation_id = ?
           )`,
        params: [
          input.now,
          input.outboxId,
          input.tenantId,
          input.grantId,
          input.grantGeneration,
          input.clientId,
          input.consentId,
          input.tenantId,
          input.outboxId,
        ],
      },
      {
        sql: `INSERT INTO admin_agent_token_revocation_outbox (
          id, tenant_id, grant_id, grant_generation, client_id, event_type, payload,
          status, attempt_count, processing_fence, next_attempt_at, created_at
        )
        SELECT ?, ?, ?, ?, ?, 'revoke_grant_families',
          json_object(
            'family_ids', json(COALESCE((
              SELECT json_group_array(family_id) FROM (
                SELECT family_id FROM admin_agent_token_families
                WHERE tenant_id = ? AND revocation_outbox_id = ? ORDER BY family_id
              )
            ), '[]')),
            'family_jtis', json(COALESCE((
              SELECT json_group_array(family_jti) FROM (
                SELECT family_jti FROM admin_agent_token_families
                WHERE tenant_id = ? AND revocation_outbox_id = ? ORDER BY family_id
              )
            ), '[]')),
            'reason', 'oauth_client_consent_revoked'
          ), 'pending', 0, 0, ?, ?
        FROM agent_consents c
        WHERE c.id = ? AND c.tenant_id = ? AND c.last_mutation_id = ?
        ON CONFLICT(id) DO UPDATE SET tenant_id = CASE
          WHEN admin_agent_token_revocation_outbox.tenant_id IS excluded.tenant_id
            AND admin_agent_token_revocation_outbox.grant_id IS excluded.grant_id
            AND admin_agent_token_revocation_outbox.grant_generation IS excluded.grant_generation
            AND admin_agent_token_revocation_outbox.client_id IS excluded.client_id
            AND admin_agent_token_revocation_outbox.payload IS excluded.payload
            AND admin_agent_token_revocation_outbox.created_at IS excluded.created_at
          THEN admin_agent_token_revocation_outbox.tenant_id ELSE NULL END`,
        params: [
          input.outboxId,
          input.tenantId,
          input.grantId,
          input.grantGeneration,
          input.clientId,
          input.tenantId,
          input.outboxId,
          input.tenantId,
          input.outboxId,
          input.now,
          input.now,
          input.consentId,
          input.tenantId,
          input.outboxId,
        ],
      },
      adminAgentAuditStatement(
        { ...input.audit, grantId: input.grantId },
        {
          from: 'agent_consents',
          where: 'id = ? AND tenant_id = ? AND last_mutation_id = ?',
          params: [input.consentId, input.tenantId, input.outboxId],
        }
      ),
    ]);
    if (results[0]?.rowsAffected !== 1) {
      const replay = await this.adapter.queryOne<{ last_mutation_id: string }>(
        `SELECT last_mutation_id FROM agent_consents
         WHERE id = ? AND tenant_id = ? AND user_id = ? AND consent_type = 'oauth_client'
           AND revoked_at IS NOT NULL AND last_mutation_id = ?`,
        [input.consentId, input.tenantId, input.userId, input.outboxId]
      );
      if (replay?.last_mutation_id !== input.outboxId) {
        throw new AgentAccessConflictError('Agent consent changed before revocation');
      }
    }
    const outbox = await this.adapter.queryOne<{ payload: string }>(
      `SELECT payload FROM admin_agent_token_revocation_outbox
       WHERE id = ? AND tenant_id = ? AND grant_id = ?`,
      [input.outboxId, input.tenantId, input.grantId]
    );
    if (!outbox) throw new AgentAccessConflictError('Agent consent revocation outbox is missing');
    return { familyCount: parseRevocationPayload(outbox.payload).familyIds.length };
  }

  async createElevation(input: CreateAgentElevationInput): Promise<void> {
    await this.adapter.execute(
      `INSERT INTO agent_elevation_challenges (
        id, tenant_id, grant_id, user_id, actor_sub, client_id, tool_name,
        tool_schema_version, args_envelope, args_hash, confirm_summary_redacted,
        status, active_args_key, retry_count, execution_attempt, execution_fence,
        payload_key_version, payload_purge_at, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'active', 0, 0, 0, ?, ?, ?, ?)`,
      [
        input.id,
        input.tenantId,
        input.grantId,
        input.userId,
        input.actorSub,
        input.clientId,
        input.toolName,
        input.toolSchemaVersion,
        input.argsEnvelope,
        input.argsHash,
        input.confirmSummaryRedacted,
        input.payloadKeyVersion,
        input.payloadPurgeAt,
        input.createdAt,
        input.expiresAt,
      ]
    );
  }

  async getElevationChallenge(
    tenantId: string,
    challengeId: string
  ): Promise<AgentElevationChallengeRecord | null> {
    const row = await this.adapter.queryOne<{
      id: string;
      tenant_id: string;
      grant_id: string;
      user_id: string;
      actor_sub: string;
      client_id: string;
      tool_name: string;
      tool_schema_version: string;
      args_hash: string;
      confirm_summary_redacted: string;
      status: AgentElevationStatus;
      execution_attempt: number;
      execution_fence: number;
      execution_owner_id: string | null;
      execution_lease_expires_at: number | null;
      approval_request_id: string | null;
      approval_artifact_id: string | null;
      created_at: number;
      expires_at: number;
    }>(
      `SELECT id, tenant_id, grant_id, user_id, actor_sub, client_id, tool_name,
        tool_schema_version, args_hash, confirm_summary_redacted, status,
        execution_attempt, execution_fence, execution_owner_id,
        execution_lease_expires_at, approval_request_id, approval_artifact_id,
        created_at, expires_at
       FROM agent_elevation_challenges WHERE tenant_id = ? AND id = ?`,
      [tenantId, challengeId]
    );
    if (!row) return null;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      grantId: row.grant_id,
      userId: row.user_id,
      actorSub: row.actor_sub,
      clientId: row.client_id,
      toolName: row.tool_name,
      toolSchemaVersion: row.tool_schema_version,
      argsHash: row.args_hash,
      confirmSummaryRedacted: row.confirm_summary_redacted,
      status: row.status,
      executionAttempt: row.execution_attempt,
      executionFence: row.execution_fence,
      ...(row.execution_owner_id === null ? {} : { executionOwnerId: row.execution_owner_id }),
      ...(row.execution_lease_expires_at === null
        ? {}
        : { executionLeaseExpiresAt: row.execution_lease_expires_at }),
      ...(row.approval_request_id === null ? {} : { approvalRequestId: row.approval_request_id }),
      ...(row.approval_artifact_id === null
        ? {}
        : { approvalArtifactId: row.approval_artifact_id }),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  async linkElevationApprovalRequest(input: {
    tenantId: string;
    challengeId: string;
    approvalRequestId: string;
    approvalArtifactId: string;
    now: number;
  }): Promise<boolean> {
    const result = await this.adapter.execute(
      `UPDATE agent_elevation_challenges
       SET approval_request_id = ?, approval_artifact_id = ?
       WHERE tenant_id = ? AND id = ? AND status = 'pending'
         AND expires_at > ? AND approval_request_id IS NULL`,
      [
        input.approvalRequestId,
        input.approvalArtifactId,
        input.tenantId,
        input.challengeId,
        input.now,
      ]
    );
    return result.rowsAffected === 1;
  }

  async getElevationApprovalDecision(
    tenantId: string,
    challengeId: string
  ): Promise<AgentElevationApprovalDecision | null> {
    const row = await this.adapter.queryOne<{
      request_status: string;
      approval_status: string;
      approver_id: string | null;
    }>(
      `SELECT r.status AS request_status, a.status AS approval_status,
              COALESCE(a.subject_id, '') AS approver_id
       FROM agent_elevation_challenges e
       JOIN approval_requests r ON r.id = e.approval_request_id AND r.tenant_id = e.tenant_id
       JOIN approval_request_approvals a ON a.approval_request_id = r.id
       WHERE e.tenant_id = ? AND e.id = ? AND e.status = 'pending'
         AND r.request_surface = 'agent_mcp'
         AND r.target_subject_type = 'tenant_resource'
         AND r.target_subject_id = e.id
         AND r.requested_action = e.tool_name
         AND json_extract(r.scope_json, '$.attributes.elevation_id') = e.id
         AND json_extract(r.scope_json, '$.attributes.grant_id') = e.grant_id
         AND json_extract(r.scope_json, '$.attributes.tool_id') = e.tool_name
         AND json_extract(r.scope_json, '$.attributes.tool_schema_version') = e.tool_schema_version
         AND json_extract(r.scope_json, '$.attributes.args_hash') = e.args_hash
         AND a.step_key = 'agent-mcp-elevation'
       ORDER BY a.created_at ASC LIMIT 1`,
      [tenantId, challengeId]
    );
    if (!row) return null;
    if (row.request_status === 'approved' && row.approval_status === 'approved') {
      return {
        status: 'approved',
        ...(row.approver_id ? { approverId: row.approver_id } : {}),
      };
    }
    if (row.request_status === 'denied' || row.approval_status === 'denied') {
      return {
        status: 'denied',
        ...(row.approver_id ? { approverId: row.approver_id } : {}),
      };
    }
    if (row.request_status === 'expired' || row.approval_status === 'expired') {
      return { status: 'expired' };
    }
    if (row.request_status === 'cancelled' || row.approval_status === 'cancelled') {
      return { status: 'cancelled' };
    }
    return { status: 'pending' };
  }

  async findActiveElevationChallenge(input: {
    tenantId: string;
    grantId: string;
    actorSub: string;
    toolName: string;
    argsHash: string;
  }): Promise<AgentElevationChallengeRecord | null> {
    const row = await this.adapter.queryOne<{ id: string }>(
      `SELECT id FROM agent_elevation_challenges
       WHERE tenant_id = ? AND grant_id = ? AND actor_sub = ? AND tool_name = ?
         AND args_hash = ? AND active_args_key = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      [input.tenantId, input.grantId, input.actorSub, input.toolName, input.argsHash]
    );
    return row ? this.getElevationChallenge(input.tenantId, row.id) : null;
  }

  /** Atomically retires an unclaimed challenge whose operation-bound TTL has elapsed. */
  async expireUnclaimedElevation(input: {
    tenantId: string;
    challengeId: string;
    expiredAt: number;
    audit: AdminAgentAuditWrite;
  }): Promise<boolean> {
    if (
      input.audit.tenantId !== input.tenantId ||
      input.audit.elevationId !== input.challengeId ||
      input.audit.resourceId !== input.challengeId
    ) {
      throw new TypeError('Elevation expiration audit does not match the expired challenge');
    }
    const results = await this.adapter.batch([
      {
        sql: `UPDATE agent_elevation_challenges
              SET status = 'expired', active_args_key = id, terminal_at = ?,
                  terminal_transition_id = ?
              WHERE tenant_id = ? AND id = ? AND status IN ('pending', 'approved')
                AND expires_at <= ?`,
        params: [
          input.expiredAt,
          input.audit.id,
          input.tenantId,
          input.challengeId,
          input.expiredAt,
        ],
      },
      adminAgentAuditStatement(input.audit, {
        from: 'agent_elevation_challenges',
        where: 'tenant_id = ? AND id = ? AND terminal_transition_id = ?',
        params: [input.tenantId, input.challengeId, input.audit.id],
      }),
    ]);
    if (results[0]?.rowsAffected === 1 && results[1]?.rowsAffected === 1) return true;
    const replay = await this.adapter.queryOne<{ terminal_transition_id: string }>(
      `SELECT terminal_transition_id FROM agent_elevation_challenges
       WHERE tenant_id = ? AND id = ? AND status = 'expired' AND terminal_transition_id = ?`,
      [input.tenantId, input.challengeId, input.audit.id]
    );
    return replay?.terminal_transition_id === input.audit.id;
  }

  /** Atomically records a human decision and its audit evidence. */
  async decideElevation(input: DecideAgentElevationInput): Promise<boolean> {
    const results = await this.adapter.batch([
      {
        sql: `UPDATE agent_elevation_challenges
              SET status = ?, approver_type = ?, approver_id = ?,
                  active_args_key = CASE WHEN ? = 'denied' THEN NULL ELSE active_args_key END
              WHERE tenant_id = ? AND id = ? AND status = 'pending' AND expires_at > ?`,
        params: [
          input.decision,
          input.approverType,
          input.approverId,
          input.decision,
          input.tenantId,
          input.challengeId,
          input.now,
        ],
      },
      adminAgentAuditStatement(input.audit, {
        from: 'agent_elevation_challenges',
        where: 'tenant_id = ? AND id = ? AND status = ? AND approver_id = ?',
        params: [input.tenantId, input.challengeId, input.decision, input.approverId],
      }),
    ]);
    return results[0]?.rowsAffected === 1 && results[1]?.rowsAffected === 1;
  }

  async reconcileIndeterminateElevation(
    input: ReconcileIndeterminateAgentElevationInput
  ): Promise<boolean> {
    const results = await this.adapter.batch([
      {
        sql: `UPDATE agent_elevation_challenges
              SET reconciled_by = ?, reconciled_outcome = ?,
                  reconciliation_evidence_envelope = ?, reconciliation_evidence_digest = ?,
                  reconciled_at = ?
              WHERE tenant_id = ? AND id = ? AND status = 'indeterminate'
                AND (reconciled_outcome IS NULL OR reconciled_outcome = 'unresolved')`,
        params: [
          input.reconciledBy,
          input.outcome,
          input.evidenceEnvelope,
          input.evidenceDigest,
          input.reconciledAt,
          input.tenantId,
          input.challengeId,
        ],
      },
      adminAgentAuditStatement(input.audit, {
        from: 'agent_elevation_challenges',
        where: 'tenant_id = ? AND id = ? AND reconciled_by = ? AND reconciled_outcome = ?',
        params: [input.tenantId, input.challengeId, input.reconciledBy, input.outcome],
      }),
    ]);
    return results[0]?.rowsAffected === 1 && results[1]?.rowsAffected === 1;
  }

  async claimElevationExecution(
    tenantId: string,
    challengeId: string,
    ownerId: string,
    now: number,
    leaseExpiresAt: number
  ): Promise<ClaimedAgentElevation | null> {
    const claimed = await this.adapter.execute(
      `UPDATE agent_elevation_challenges
         SET status = 'executing', executing_at = ?, execution_owner_id = ?,
             execution_lease_expires_at = ?, execution_attempt = execution_attempt + 1,
             execution_fence = execution_fence + 1
         WHERE tenant_id = ? AND id = ? AND status = 'approved' AND expires_at > ?`,
      [now, ownerId, leaseExpiresAt, tenantId, challengeId, now]
    );
    if (claimed.rowsAffected !== 1) return null;
    const row = await this.adapter.queryOne<AgentElevationRow>(
      `SELECT id, tenant_id, grant_id, status, execution_attempt, execution_fence,
          execution_owner_id, execution_lease_expires_at, retry_count
         FROM agent_elevation_challenges WHERE tenant_id = ? AND id = ?`,
      [tenantId, challengeId]
    );
    if (!row || row.status !== 'executing' || row.execution_owner_id !== ownerId) return null;
    return {
      id: row.id,
      attempt: row.execution_attempt,
      fence: row.execution_fence,
      ownerId,
      leaseExpiresAt: row.execution_lease_expires_at ?? leaseExpiresAt,
    };
  }

  async completeElevationExecution(input: {
    tenantId: string;
    challengeId: string;
    ownerId: string;
    attempt: number;
    fence: number;
    status: 'consumed' | 'failed' | 'indeterminate';
    resultEnvelope?: string;
    resultDigest?: string;
    completedAt: number;
  }): Promise<boolean> {
    const result = await this.adapter.execute(
      `UPDATE agent_elevation_challenges
       SET status = ?, active_args_key = id, execution_result_envelope = ?,
           execution_result_digest = ?,
           consumed_at = CASE WHEN ? = 'consumed' THEN ? ELSE NULL END,
           terminal_at = ?, execution_lease_expires_at = NULL
       WHERE tenant_id = ? AND id = ? AND status = 'executing'
         AND execution_owner_id = ? AND execution_attempt = ? AND execution_fence = ?`,
      [
        input.status,
        input.resultEnvelope ?? null,
        input.resultDigest ?? null,
        input.status,
        input.completedAt,
        input.completedAt,
        input.tenantId,
        input.challengeId,
        input.ownerId,
        input.attempt,
        input.fence,
      ]
    );
    return result.rowsAffected === 1;
  }

  async listStaleElevationExecutions(
    now: number,
    limit: number = 100
  ): Promise<StaleAgentElevation[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = await this.adapter.query<AgentElevationRow>(
      `SELECT id, tenant_id, grant_id, status, execution_attempt, execution_fence,
        execution_owner_id, execution_lease_expires_at, retry_count
       FROM agent_elevation_challenges
       WHERE status = 'executing' AND execution_lease_expires_at < ?
       ORDER BY execution_lease_expires_at ASC LIMIT ?`,
      [now, safeLimit]
    );
    return rows.flatMap((row) =>
      row.execution_lease_expires_at === null
        ? []
        : [
            {
              id: row.id,
              tenantId: row.tenant_id,
              grantId: row.grant_id,
              attempt: row.execution_attempt,
              fence: row.execution_fence,
              ownerId: row.execution_owner_id,
              leaseExpiresAt: row.execution_lease_expires_at,
              retryCount: row.retry_count,
            },
          ]
    );
  }

  /** Crypto-erases retained Agent payloads while preserving hashes and audit linkage. */
  async purgeExpiredElevationPayloads(now: number): Promise<number> {
    const result = await this.adapter.execute(
      `UPDATE agent_elevation_challenges
       SET args_envelope = NULL, execution_result_envelope = NULL,
           reconciliation_evidence_envelope = NULL, payload_purged_at = ?
       WHERE payload_purge_at <= ? AND payload_purged_at IS NULL
         AND status IN ('consumed', 'failed', 'indeterminate', 'expired', 'denied')`,
      [now, now]
    );
    return result.rowsAffected;
  }

  async reconcileStaleElevation(input: {
    tenantId: string;
    challengeId: string;
    expectedAttempt: number;
    expectedFence: number;
    staleBefore: number;
    status: 'consumed' | 'failed' | 'indeterminate';
    resultEnvelope?: string;
    resultDigest?: string;
    reconciledAt: number;
    audit: AdminAgentAuditWrite;
  }): Promise<boolean> {
    if (
      input.audit.tenantId !== input.tenantId ||
      input.audit.elevationId !== input.challengeId ||
      input.audit.grantId === undefined
    ) {
      throw new TypeError('Elevation reconciliation audit does not match the recovered row');
    }
    const results = await this.adapter.batch([
      {
        sql: `UPDATE agent_elevation_challenges
         SET status = ?, active_args_key = id, execution_result_envelope = ?,
             execution_result_digest = ?,
             consumed_at = CASE WHEN ? = 'consumed' THEN ? ELSE NULL END,
             terminal_at = ?, execution_lease_expires_at = NULL,
             terminal_transition_id = ?
         WHERE tenant_id = ? AND id = ? AND status = 'executing'
           AND execution_lease_expires_at < ?
           AND execution_attempt = ? AND execution_fence = ?`,
        params: [
          input.status,
          input.resultEnvelope ?? null,
          input.resultDigest ?? null,
          input.status,
          input.reconciledAt,
          input.reconciledAt,
          input.audit.id,
          input.tenantId,
          input.challengeId,
          input.staleBefore,
          input.expectedAttempt,
          input.expectedFence,
        ],
      },
      adminAgentAuditStatement(input.audit, {
        from: 'agent_elevation_challenges',
        where: 'tenant_id = ? AND id = ? AND terminal_transition_id = ?',
        params: [input.tenantId, input.challengeId, input.audit.id],
      }),
    ]);
    if (results[0]?.rowsAffected === 1) return true;
    const replay = await this.adapter.queryOne<{ terminal_transition_id: string }>(
      `SELECT terminal_transition_id FROM agent_elevation_challenges
       WHERE tenant_id = ? AND id = ? AND status = ? AND terminal_transition_id = ?`,
      [input.tenantId, input.challengeId, input.status, input.audit.id]
    );
    return replay?.terminal_transition_id === input.audit.id;
  }

  async deferStaleElevation(input: {
    tenantId: string;
    challengeId: string;
    expectedAttempt: number;
    expectedFence: number;
    staleBefore: number;
    leaseExpiresAt: number;
  }): Promise<boolean> {
    const result = await this.adapter.execute(
      `UPDATE agent_elevation_challenges
       SET execution_lease_expires_at = ?
       WHERE tenant_id = ? AND id = ? AND status = 'executing'
         AND execution_lease_expires_at < ?
         AND execution_attempt = ? AND execution_fence = ?`,
      [
        input.leaseExpiresAt,
        input.tenantId,
        input.challengeId,
        input.staleBefore,
        input.expectedAttempt,
        input.expectedFence,
      ]
    );
    return result.rowsAffected === 1;
  }

  async claimStaleElevationRetry(input: {
    tenantId: string;
    challengeId: string;
    expectedAttempt: number;
    expectedFence: number;
    staleBefore: number;
    now: number;
    ownerId: string;
    leaseExpiresAt: number;
  }): Promise<ClaimedAgentElevation | null> {
    const result = await this.adapter.execute(
      `UPDATE agent_elevation_challenges
         SET retry_count = retry_count + 1,
             execution_attempt = execution_attempt + 1,
             execution_fence = execution_fence + 1,
             execution_owner_id = ?, execution_lease_expires_at = ?, executing_at = ?
         WHERE tenant_id = ? AND id = ? AND status = 'executing'
           AND execution_lease_expires_at < ? AND retry_count = 0
           AND execution_attempt = ? AND execution_fence = ?`,
      [
        input.ownerId,
        input.leaseExpiresAt,
        input.now,
        input.tenantId,
        input.challengeId,
        input.staleBefore,
        input.expectedAttempt,
        input.expectedFence,
      ]
    );
    if (result.rowsAffected !== 1) return null;
    const row = await this.adapter.queryOne<AgentElevationRow>(
      `SELECT id, tenant_id, grant_id, status, execution_attempt, execution_fence,
          execution_owner_id, execution_lease_expires_at, retry_count
         FROM agent_elevation_challenges WHERE tenant_id = ? AND id = ?`,
      [input.tenantId, input.challengeId]
    );
    if (
      !row ||
      row.status !== 'executing' ||
      row.execution_owner_id !== input.ownerId ||
      row.retry_count !== 1
    ) {
      throw new AgentAccessConflictError('Elevation retry claim could not be verified');
    }
    return {
      id: row.id,
      attempt: row.execution_attempt,
      fence: row.execution_fence,
      ownerId: input.ownerId,
      leaseExpiresAt: row.execution_lease_expires_at ?? input.leaseExpiresAt,
    };
  }

  /**
   * Creates the target-side execution fence before invoking a Management mutation.
   * A duplicate exact fence is not overwritten; callers must inspect lookupManagementExecution.
   */
  async beginManagementExecution(input: BeginAgentManagementExecutionInput): Promise<boolean> {
    const result = await this.adapter.execute(
      `INSERT OR IGNORE INTO agent_management_executions (
        tenant_id, idempotency_key, execution_attempt, execution_fence,
        operation, request_digest, status, lease_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?)`,
      [
        input.tenantId,
        input.idempotencyKey,
        input.executionAttempt,
        input.executionFence,
        input.operation,
        input.requestDigest,
        input.leaseExpiresAt,
        input.createdAt,
        input.createdAt,
      ]
    );
    return result.rowsAffected === 1;
  }

  /** Completes only the exact active attempt/fence and never rewrites a terminal result. */
  async completeManagementExecution(
    input: CompleteAgentManagementExecutionInput
  ): Promise<boolean> {
    const result = await this.adapter.execute(
      `UPDATE agent_management_executions
       SET status = ?, result_envelope = ?, result_digest = ?, updated_at = ?
       WHERE tenant_id = ? AND idempotency_key = ?
         AND execution_attempt = ? AND execution_fence = ? AND status = 'in_progress'`,
      [
        input.status,
        input.resultEnvelope ?? null,
        input.resultDigest,
        input.completedAt,
        input.tenantId,
        input.idempotencyKey,
        input.executionAttempt,
        input.executionFence,
      ]
    );
    return result.rowsAffected === 1;
  }

  async lookupManagementExecution(
    input: AgentManagementIdempotencyLookup
  ): Promise<AgentManagementIdempotencyStatus> {
    const row = await this.adapter.queryOne<AgentManagementExecutionRow>(
      `SELECT operation, request_digest, status, lease_expires_at, result_envelope, result_digest
       FROM agent_management_executions
       WHERE tenant_id = ? AND idempotency_key = ?
         AND execution_attempt = ? AND execution_fence = ?`,
      [input.tenantId, input.idempotencyKey, input.executionAttempt, input.executionFence]
    );
    if (!row) return { status: 'not_found' };
    if (row.status === 'in_progress') {
      return {
        status: 'in_progress',
        operation: row.operation,
        requestDigest: row.request_digest,
        leaseExpiresAt: row.lease_expires_at,
      };
    }
    return {
      status: row.status,
      operation: row.operation,
      requestDigest: row.request_digest,
      ...(row.result_envelope === null ? {} : { resultEnvelope: row.result_envelope }),
      ...(row.result_digest === null ? {} : { resultDigest: row.result_digest }),
    };
  }

  async createPendingTokenFamily(input: CreatePendingAgentTokenFamilyInput): Promise<void> {
    if (input.expiresAt <= input.createdAt) {
      throw new TypeError('Agent token family expiry must be after creation');
    }
    await this.adapter.execute(
      `INSERT INTO admin_agent_token_families (
        family_id, family_jti, tenant_id, grant_id, grant_generation,
        admin_user_id, client_id, consent_version, status, finalization_nonce,
        expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_finalization', ?, ?, ?, ?)`,
      [
        input.familyId,
        input.familyJti,
        input.tenantId,
        input.grantId,
        input.grantGeneration,
        input.adminUserId,
        input.clientId,
        input.consentVersion,
        input.finalizationNonce,
        input.expiresAt,
        input.createdAt,
        input.createdAt,
      ]
    );
  }

  async consumeModeBDelegationJti(input: {
    jti: string;
    tenantId: string;
    grantId: string;
    machinePrincipalId: string;
    expiresAt: number;
    consumedAt: number;
  }): Promise<boolean> {
    if (input.expiresAt <= input.consumedAt) return false;
    const result = await this.adapter.execute(
      `INSERT OR IGNORE INTO admin_agent_delegation_jtis (
         jti, tenant_id, grant_id, machine_principal_id, expires_at, consumed_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.jti,
        input.tenantId,
        input.grantId,
        input.machinePrincipalId,
        input.expiresAt,
        input.consumedAt,
      ]
    );
    return result.rowsAffected === 1;
  }

  async finalizeTokenFamily(input: {
    familyId: string;
    finalizationNonce: string;
    tenantId: string;
    grantId: string;
    grantGeneration: number;
    adminUserId: string;
    clientId: string;
    consentVersion: number;
    now: number;
  }): Promise<boolean> {
    const result = await this.adapter.execute(
      `UPDATE admin_agent_token_families AS f
       SET status = 'active', finalized_at = ?, updated_at = ?
       WHERE f.family_id = ? AND f.finalization_nonce = ?
         AND f.tenant_id = ? AND f.grant_id = ? AND f.grant_generation = ?
         AND f.admin_user_id = ? AND f.client_id = ? AND f.consent_version = ?
         AND f.status = 'pending_finalization' AND f.expires_at > ?
         AND EXISTS (
           SELECT 1 FROM admin_agent_grants g
           WHERE g.id = f.grant_id AND g.tenant_id = f.tenant_id
             AND g.generation = f.grant_generation AND g.delegator_id = f.admin_user_id
             AND g.client_id = f.client_id AND g.consent_version = f.consent_version
             AND g.status = 'active' AND (g.expires_at IS NULL OR g.expires_at > ?)
         )
         AND EXISTS (
           SELECT 1 FROM agent_consents c
           WHERE c.grant_id = f.grant_id AND c.tenant_id = f.tenant_id
             AND c.user_id = f.admin_user_id AND c.client_id = f.client_id
             AND c.consent_type = 'delegation' AND c.consent_version = f.consent_version
             AND c.revoked_at IS NULL
         )
         AND EXISTS (
           SELECT 1 FROM agent_consents c
           WHERE c.grant_id = f.grant_id AND c.tenant_id = f.tenant_id
             AND c.user_id = f.admin_user_id AND c.client_id = f.client_id
             AND c.consent_type = 'oauth_client' AND c.revoked_at IS NULL
         )`,
      [
        input.now,
        input.now,
        input.familyId,
        input.finalizationNonce,
        input.tenantId,
        input.grantId,
        input.grantGeneration,
        input.adminUserId,
        input.clientId,
        input.consentVersion,
        input.now,
        input.now,
      ]
    );
    return result.rowsAffected === 1;
  }

  async isTokenFamilyUsable(input: {
    familyId: string;
    tenantId: string;
    grantId: string;
    grantGeneration: number;
    adminUserId: string;
    clientId: string;
    consentVersion: number;
    now: number;
  }): Promise<boolean> {
    const row = await this.adapter.queryOne<{ usable: number }>(
      `SELECT 1 AS usable
       FROM admin_agent_token_families f
       JOIN admin_agent_grants g
         ON g.id = f.grant_id AND g.tenant_id = f.tenant_id
       WHERE f.family_id = ? AND f.tenant_id = ? AND f.grant_id = ?
         AND f.grant_generation = ? AND f.admin_user_id = ? AND f.client_id = ?
         AND f.consent_version = ? AND f.status = 'active' AND f.expires_at > ?
         AND g.generation = f.grant_generation AND g.delegator_id = f.admin_user_id
         AND g.client_id = f.client_id AND g.consent_version = f.consent_version
         AND g.status = 'active' AND (g.expires_at IS NULL OR g.expires_at > ?)
         AND EXISTS (
           SELECT 1 FROM agent_consents c
           WHERE c.grant_id = f.grant_id AND c.tenant_id = f.tenant_id
             AND c.user_id = f.admin_user_id AND c.client_id = f.client_id
             AND c.consent_type = 'delegation' AND c.consent_version = f.consent_version
             AND c.revoked_at IS NULL
         )
         AND EXISTS (
           SELECT 1 FROM agent_consents c
           WHERE c.grant_id = f.grant_id AND c.tenant_id = f.tenant_id
             AND c.user_id = f.admin_user_id AND c.client_id = f.client_id
             AND c.consent_type = 'oauth_client' AND c.revoked_at IS NULL
         )`,
      [
        input.familyId,
        input.tenantId,
        input.grantId,
        input.grantGeneration,
        input.adminUserId,
        input.clientId,
        input.consentVersion,
        input.now,
        input.now,
      ]
    );
    return row?.usable === 1;
  }

  async invalidateGrantAndQueueTokenRevocation(
    input: InvalidateAgentGrantInput
  ): Promise<{ familyCount: number; nextGeneration: number }> {
    if (
      input.audit.tenantId !== input.tenantId ||
      input.audit.resourceId !== input.grantId ||
      (input.audit.grantId !== undefined && input.audit.grantId !== input.grantId)
    ) {
      throw new TypeError('Agent Grant audit context does not match the mutation');
    }
    const audit = {
      ...input.audit,
      grantId: input.grantId,
      metadata: {
        ...input.audit.metadata,
        outbox_id: input.outboxId,
        previous_generation: input.expectedGeneration,
        next_generation: input.expectedGeneration + 1,
        reason: input.reason,
      },
    };
    const results = await this.adapter.batch([
      {
        sql: `UPDATE admin_agent_grants
         SET status = ?, active_uniqueness_key = id, generation = generation + 1,
             consent_version = consent_version + 1, updated_at = ?,
             revoked_at = CASE WHEN ? = 'revoked' THEN ? ELSE revoked_at END,
             revoked_by = CASE WHEN ? = 'revoked' THEN ? ELSE revoked_by END,
             last_mutation_id = ?
         WHERE tenant_id = ? AND id = ? AND client_id = ?
           AND generation = ? AND status = 'active'`,
        params: [
          input.status,
          input.now,
          input.status,
          input.now,
          input.status,
          input.audit.actorSub,
          input.outboxId,
          input.tenantId,
          input.grantId,
          input.clientId,
          input.expectedGeneration,
        ],
      },
      {
        sql: `UPDATE agent_consents
         SET revoked_at = ?, revoked_reason = ?
         WHERE tenant_id = ? AND grant_id = ? AND revoked_at IS NULL
           AND EXISTS (
             SELECT 1 FROM admin_agent_grants g
             WHERE g.tenant_id = ? AND g.id = ? AND g.last_mutation_id = ?
           )`,
        params: [
          input.now,
          input.reason,
          input.tenantId,
          input.grantId,
          input.tenantId,
          input.grantId,
          input.outboxId,
        ],
      },
      {
        sql: `UPDATE admin_agent_token_families
         SET status = 'revocation_pending', updated_at = ?, revocation_outbox_id = ?
         WHERE tenant_id = ? AND grant_id = ? AND grant_generation = ?
           AND client_id = ?
           AND status IN ('pending_finalization', 'active', 'revocation_pending')
           AND EXISTS (
             SELECT 1 FROM admin_agent_grants g
             WHERE g.tenant_id = ? AND g.id = ? AND g.last_mutation_id = ?
           )`,
        params: [
          input.now,
          input.outboxId,
          input.tenantId,
          input.grantId,
          input.expectedGeneration,
          input.clientId,
          input.tenantId,
          input.grantId,
          input.outboxId,
        ],
      },
      {
        sql: `INSERT INTO admin_agent_token_revocation_outbox (
          id, tenant_id, grant_id, grant_generation, client_id, event_type, payload,
          status, attempt_count, processing_fence, next_attempt_at, created_at
        )
        SELECT ?, ?, ?, ?, ?, 'revoke_grant_families',
          json_object(
            'family_ids', json(COALESCE((
              SELECT json_group_array(family_id) FROM (
                SELECT family_id FROM admin_agent_token_families
                WHERE tenant_id = ? AND revocation_outbox_id = ? ORDER BY family_id
              )
            ), '[]')),
            'family_jtis', json(COALESCE((
              SELECT json_group_array(family_jti) FROM (
                SELECT family_jti FROM admin_agent_token_families
                WHERE tenant_id = ? AND revocation_outbox_id = ? ORDER BY family_id
              )
            ), '[]')),
            'reason', ?
          ),
          'pending', 0, 0, ?, ?
        FROM admin_agent_grants g
        WHERE g.tenant_id = ? AND g.id = ? AND g.last_mutation_id = ?
        ON CONFLICT(id) DO UPDATE SET tenant_id = CASE
          WHEN admin_agent_token_revocation_outbox.tenant_id IS excluded.tenant_id
            AND admin_agent_token_revocation_outbox.grant_id IS excluded.grant_id
            AND admin_agent_token_revocation_outbox.grant_generation IS excluded.grant_generation
            AND admin_agent_token_revocation_outbox.client_id IS excluded.client_id
            AND admin_agent_token_revocation_outbox.event_type IS excluded.event_type
            AND admin_agent_token_revocation_outbox.payload IS excluded.payload
            AND admin_agent_token_revocation_outbox.created_at IS excluded.created_at
          THEN admin_agent_token_revocation_outbox.tenant_id
          ELSE NULL
        END`,
        params: [
          input.outboxId,
          input.tenantId,
          input.grantId,
          input.expectedGeneration,
          input.clientId,
          input.tenantId,
          input.outboxId,
          input.tenantId,
          input.outboxId,
          input.reason,
          input.now,
          input.now,
          input.tenantId,
          input.grantId,
          input.outboxId,
        ],
      },
      adminAgentAuditStatement(audit, {
        from: 'admin_agent_grants',
        where: 'tenant_id = ? AND id = ? AND last_mutation_id = ?',
        params: [input.tenantId, input.grantId, input.outboxId],
      }),
    ]);
    if (results[0]?.rowsAffected !== 1) {
      const replay = await this.adapter.queryOne<{ last_mutation_id: string }>(
        `SELECT last_mutation_id FROM admin_agent_grants
         WHERE tenant_id = ? AND id = ? AND client_id = ? AND status = ?
           AND generation = ? AND last_mutation_id = ?`,
        [
          input.tenantId,
          input.grantId,
          input.clientId,
          input.status,
          input.expectedGeneration + 1,
          input.outboxId,
        ]
      );
      if (replay?.last_mutation_id !== input.outboxId) {
        throw new AgentAccessConflictError('Agent Grant changed before invalidation');
      }
    }
    const persistedOutbox = await this.adapter.queryOne<{ payload: string }>(
      `SELECT payload FROM admin_agent_token_revocation_outbox
       WHERE id = ? AND tenant_id = ? AND grant_id = ? AND grant_generation = ?`,
      [input.outboxId, input.tenantId, input.grantId, input.expectedGeneration]
    );
    if (!persistedOutbox) {
      throw new AgentAccessConflictError('Agent Grant invalidation outbox was not persisted');
    }
    const familyCount = parseRevocationPayload(persistedOutbox.payload).familyIds.length;
    return {
      familyCount,
      nextGeneration: input.expectedGeneration + 1,
    };
  }

  async updateGrantAndQueueTokenRevocation(
    input: UpdateAdminAgentGrantInput
  ): Promise<{ familyCount: number; nextGeneration: number; nextConsentVersion: number }> {
    if (
      input.audit.tenantId !== input.tenantId ||
      input.audit.resourceId !== input.grantId ||
      (input.audit.grantId !== undefined && input.audit.grantId !== input.grantId)
    ) {
      throw new TypeError('Agent Grant audit context does not match the update');
    }
    parseScopeConstraints(JSON.stringify(input.resolvedScopeConstraints), input.tenantId);
    const audit = {
      ...input.audit,
      grantId: input.grantId,
      metadata: {
        ...input.audit.metadata,
        outbox_id: input.outboxId,
        previous_generation: input.expectedGeneration,
        next_generation: input.expectedGeneration + 1,
        reason: 'grant_updated',
      },
    };
    const results = await this.adapter.batch([
      {
        sql: `UPDATE admin_agent_grants
         SET permissions = ?, scopes = ?, authorization_details = ?,
             resolved_scope_constraints = ?, purpose = ?, expires_at = ?,
             generation = generation + 1, consent_version = consent_version + 1,
             updated_at = ?, last_mutation_id = ?
         WHERE tenant_id = ? AND id = ? AND client_id = ?
           AND generation = ? AND status = 'active'`,
        params: [
          JSON.stringify(input.permissions),
          JSON.stringify(input.scopes),
          input.authorizationDetails ? JSON.stringify(input.authorizationDetails) : null,
          JSON.stringify(input.resolvedScopeConstraints),
          input.purpose ?? null,
          input.expiresAt ?? null,
          input.now,
          input.outboxId,
          input.tenantId,
          input.grantId,
          input.clientId,
          input.expectedGeneration,
        ],
      },
      {
        sql: `UPDATE agent_consents
         SET revoked_at = ?, revoked_reason = 'grant_updated'
         WHERE tenant_id = ? AND grant_id = ? AND revoked_at IS NULL
           AND EXISTS (
             SELECT 1 FROM admin_agent_grants g
             WHERE g.tenant_id = ? AND g.id = ? AND g.last_mutation_id = ?
           )`,
        params: [
          input.now,
          input.tenantId,
          input.grantId,
          input.tenantId,
          input.grantId,
          input.outboxId,
        ],
      },
      {
        sql: `UPDATE admin_agent_token_families
         SET status = 'revocation_pending', updated_at = ?, revocation_outbox_id = ?
         WHERE tenant_id = ? AND grant_id = ? AND grant_generation = ?
           AND client_id = ?
           AND status IN ('pending_finalization', 'active', 'revocation_pending')
           AND EXISTS (
             SELECT 1 FROM admin_agent_grants g
             WHERE g.tenant_id = ? AND g.id = ? AND g.last_mutation_id = ?
           )`,
        params: [
          input.now,
          input.outboxId,
          input.tenantId,
          input.grantId,
          input.expectedGeneration,
          input.clientId,
          input.tenantId,
          input.grantId,
          input.outboxId,
        ],
      },
      {
        sql: `INSERT INTO admin_agent_token_revocation_outbox (
          id, tenant_id, grant_id, grant_generation, client_id, event_type, payload,
          status, attempt_count, processing_fence, next_attempt_at, created_at
        )
        SELECT ?, ?, ?, ?, ?, 'revoke_grant_families',
          json_object(
            'family_ids', json(COALESCE((
              SELECT json_group_array(family_id) FROM (
                SELECT family_id FROM admin_agent_token_families
                WHERE tenant_id = ? AND revocation_outbox_id = ? ORDER BY family_id
              )
            ), '[]')),
            'family_jtis', json(COALESCE((
              SELECT json_group_array(family_jti) FROM (
                SELECT family_jti FROM admin_agent_token_families
                WHERE tenant_id = ? AND revocation_outbox_id = ? ORDER BY family_id
              )
            ), '[]')),
            'reason', 'grant_updated'
          ),
          'pending', 0, 0, ?, ?
        FROM admin_agent_grants g
        WHERE g.tenant_id = ? AND g.id = ? AND g.last_mutation_id = ?
        ON CONFLICT(id) DO UPDATE SET tenant_id = CASE
          WHEN admin_agent_token_revocation_outbox.tenant_id IS excluded.tenant_id
            AND admin_agent_token_revocation_outbox.grant_id IS excluded.grant_id
            AND admin_agent_token_revocation_outbox.grant_generation IS excluded.grant_generation
            AND admin_agent_token_revocation_outbox.client_id IS excluded.client_id
            AND admin_agent_token_revocation_outbox.event_type IS excluded.event_type
            AND admin_agent_token_revocation_outbox.payload IS excluded.payload
            AND admin_agent_token_revocation_outbox.created_at IS excluded.created_at
          THEN admin_agent_token_revocation_outbox.tenant_id
          ELSE NULL
        END`,
        params: [
          input.outboxId,
          input.tenantId,
          input.grantId,
          input.expectedGeneration,
          input.clientId,
          input.tenantId,
          input.outboxId,
          input.tenantId,
          input.outboxId,
          input.now,
          input.now,
          input.tenantId,
          input.grantId,
          input.outboxId,
        ],
      },
      adminAgentAuditStatement(audit, {
        from: 'admin_agent_grants',
        where: 'tenant_id = ? AND id = ? AND last_mutation_id = ?',
        params: [input.tenantId, input.grantId, input.outboxId],
      }),
    ]);
    if (results[0]?.rowsAffected !== 1) {
      const replay = await this.adapter.queryOne<{
        last_mutation_id: string;
        generation: number;
        consent_version: number;
      }>(
        `SELECT last_mutation_id, generation, consent_version FROM admin_agent_grants
         WHERE tenant_id = ? AND id = ? AND client_id = ? AND status = 'active'
           AND generation = ? AND last_mutation_id = ?`,
        [
          input.tenantId,
          input.grantId,
          input.clientId,
          input.expectedGeneration + 1,
          input.outboxId,
        ]
      );
      if (replay?.last_mutation_id !== input.outboxId) {
        throw new AgentAccessConflictError('Agent Grant changed before update');
      }
      const persistedOutbox = await this.adapter.queryOne<{ payload: string }>(
        `SELECT payload FROM admin_agent_token_revocation_outbox
         WHERE id = ? AND tenant_id = ? AND grant_id = ? AND grant_generation = ?`,
        [input.outboxId, input.tenantId, input.grantId, input.expectedGeneration]
      );
      if (!persistedOutbox) {
        throw new AgentAccessConflictError('Agent Grant update outbox was not persisted');
      }
      return {
        familyCount: parseRevocationPayload(persistedOutbox.payload).familyIds.length,
        nextGeneration: replay.generation,
        nextConsentVersion: replay.consent_version,
      };
    }
    const current = await this.adapter.queryOne<{ generation: number; consent_version: number }>(
      `SELECT generation, consent_version FROM admin_agent_grants
       WHERE tenant_id = ? AND id = ? AND last_mutation_id = ?`,
      [input.tenantId, input.grantId, input.outboxId]
    );
    if (!current) throw new AgentAccessConflictError('Agent Grant update result is unavailable');
    const persistedOutbox = await this.adapter.queryOne<{ payload: string }>(
      `SELECT payload FROM admin_agent_token_revocation_outbox
       WHERE id = ? AND tenant_id = ? AND grant_id = ? AND grant_generation = ?`,
      [input.outboxId, input.tenantId, input.grantId, input.expectedGeneration]
    );
    if (!persistedOutbox) {
      throw new AgentAccessConflictError('Agent Grant update outbox was not persisted');
    }
    return {
      familyCount: parseRevocationPayload(persistedOutbox.payload).familyIds.length,
      nextGeneration: current.generation,
      nextConsentVersion: current.consent_version,
    };
  }

  async resumeGrantWithAudit(input: ResumeAdminAgentGrantInput): Promise<boolean> {
    if (
      input.audit.id !== input.transitionId ||
      input.audit.tenantId !== input.tenantId ||
      input.audit.resourceId !== input.grantId
    ) {
      throw new TypeError('Agent Grant resume audit context does not match the transition');
    }
    const results = await this.adapter.batch([
      {
        sql: `UPDATE admin_agent_grants
         SET status = 'active', active_uniqueness_key = 'active', updated_at = ?,
             last_mutation_id = ?
         WHERE tenant_id = ? AND id = ? AND client_id = ?
           AND generation = ? AND status = 'suspended'`,
        params: [
          input.now,
          input.transitionId,
          input.tenantId,
          input.grantId,
          input.clientId,
          input.expectedGeneration,
        ],
      },
      adminAgentAuditStatement(
        { ...input.audit, grantId: input.grantId },
        {
          from: 'admin_agent_grants',
          where: 'tenant_id = ? AND id = ? AND last_mutation_id = ?',
          params: [input.tenantId, input.grantId, input.transitionId],
        }
      ),
    ]);
    if (results[0]?.rowsAffected === 1) return true;
    const replay = await this.adapter.queryOne<{ last_mutation_id: string }>(
      `SELECT last_mutation_id FROM admin_agent_grants
       WHERE tenant_id = ? AND id = ? AND client_id = ? AND generation = ?
         AND status = 'active' AND last_mutation_id = ?`,
      [input.tenantId, input.grantId, input.clientId, input.expectedGeneration, input.transitionId]
    );
    return replay?.last_mutation_id === input.transitionId;
  }

  async createTokenRevocationOutbox(input: CreateAgentTokenRevocationOutboxInput): Promise<void> {
    if (input.familyIds.length !== input.familyJtis.length) {
      throw new TypeError('Agent token revocation family ID/JTI counts must match');
    }
    await this.adapter.execute(
      `INSERT INTO admin_agent_token_revocation_outbox (
        id, tenant_id, grant_id, grant_generation, client_id, event_type, payload,
        status, attempt_count, processing_fence, next_attempt_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?)`,
      [
        input.id,
        input.tenantId,
        input.grantId ?? null,
        input.grantGeneration ?? null,
        input.clientId,
        input.eventType,
        JSON.stringify({
          family_ids: input.familyIds,
          family_jtis: input.familyJtis,
          reason: input.reason,
        }),
        input.nextAttemptAt,
        input.createdAt,
      ]
    );
  }

  async listClaimableTokenRevocations(now: number, limit: number = 100): Promise<string[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = await this.adapter.query<{ id: string }>(
      `SELECT id FROM admin_agent_token_revocation_outbox
       WHERE next_attempt_at <= ?
         AND (status = 'pending'
           OR (status = 'processing' AND processing_lease_expires_at < ?))
       ORDER BY next_attempt_at ASC LIMIT ?`,
      [now, now, safeLimit]
    );
    return rows.map((row) => row.id);
  }

  async claimTokenRevocationOutbox(input: {
    outboxId: string;
    ownerId: string;
    now: number;
    leaseExpiresAt: number;
  }): Promise<ClaimedAgentTokenRevocation | null> {
    const result = await this.adapter.execute(
      `UPDATE admin_agent_token_revocation_outbox
         SET status = 'processing', attempt_count = attempt_count + 1,
             processing_fence = processing_fence + 1, processing_owner_id = ?,
             processing_lease_expires_at = ?
         WHERE id = ? AND next_attempt_at <= ?
           AND (status = 'pending'
             OR (status = 'processing' AND processing_lease_expires_at < ?))`,
      [input.ownerId, input.leaseExpiresAt, input.outboxId, input.now, input.now]
    );
    if (result.rowsAffected !== 1) return null;
    const row = await this.adapter.queryOne<AgentTokenRevocationOutboxRow>(
      `SELECT id, tenant_id, grant_id, grant_generation, client_id, event_type,
          payload, status, attempt_count, processing_fence, processing_owner_id,
          processing_lease_expires_at
         FROM admin_agent_token_revocation_outbox WHERE id = ?`,
      [input.outboxId]
    );
    if (
      !row ||
      row.status !== 'processing' ||
      row.processing_owner_id !== input.ownerId ||
      row.processing_lease_expires_at === null
    ) {
      return null;
    }
    const payload = parseRevocationPayload(row.payload);
    return {
      id: row.id,
      tenantId: row.tenant_id,
      grantId: row.grant_id ?? undefined,
      grantGeneration: row.grant_generation ?? undefined,
      clientId: row.client_id,
      eventType: row.event_type,
      familyIds: payload.familyIds,
      familyJtis: payload.familyJtis,
      reason: payload.reason,
      attempt: row.attempt_count,
      fence: row.processing_fence,
      ownerId: input.ownerId,
      leaseExpiresAt: row.processing_lease_expires_at,
    };
  }

  async completeTokenRevocationOutbox(input: {
    outboxId: string;
    tenantId: string;
    ownerId: string;
    fence: number;
    completionId: string;
    familyIds: readonly string[];
    completedAt: number;
  }): Promise<boolean> {
    const results = await this.adapter.batch([
      {
        sql: `UPDATE admin_agent_token_revocation_outbox
         SET status = 'completed', completed_at = ?, processing_lease_expires_at = NULL,
             completion_transition_id = ?
         WHERE id = ? AND tenant_id = ? AND status = 'processing'
           AND processing_owner_id = ? AND processing_fence = ?`,
        params: [
          input.completedAt,
          input.completionId,
          input.outboxId,
          input.tenantId,
          input.ownerId,
          input.fence,
        ],
      },
      ...input.familyIds.map<PreparedStatement>((familyId) => ({
        sql: `UPDATE admin_agent_token_families
           SET status = 'revoked', updated_at = ?
           WHERE family_id = ? AND tenant_id = ?
             AND status IN ('pending_finalization', 'active', 'revocation_pending', 'revoked')
             AND EXISTS (
               SELECT 1 FROM admin_agent_token_revocation_outbox o
               WHERE o.id = ? AND o.tenant_id = ? AND o.status = 'completed'
                 AND o.completion_transition_id = ?
             )`,
        params: [
          input.completedAt,
          familyId,
          input.tenantId,
          input.outboxId,
          input.tenantId,
          input.completionId,
        ],
      })),
    ]);
    if (results[0]?.rowsAffected === 1) return true;
    const replay = await this.adapter.queryOne<{ completion_transition_id: string }>(
      `SELECT completion_transition_id FROM admin_agent_token_revocation_outbox
       WHERE id = ? AND tenant_id = ? AND status = 'completed'
         AND completion_transition_id = ?`,
      [input.outboxId, input.tenantId, input.completionId]
    );
    return replay?.completion_transition_id === input.completionId;
  }

  async failTokenRevocationOutbox(input: {
    outboxId: string;
    tenantId: string;
    ownerId: string;
    fence: number;
    expectedAttempt: number;
    nextAttemptAt: number;
    maxAttempts?: number;
    deadLetterAudit: AdminAgentAuditWrite;
  }): Promise<'retry_scheduled' | 'dead_letter' | null> {
    const maxAttempts = Math.max(1, Math.trunc(input.maxAttempts ?? 8));
    const deadLetter = input.expectedAttempt >= maxAttempts;
    if (
      deadLetter &&
      (input.deadLetterAudit.tenantId !== input.tenantId ||
        input.deadLetterAudit.resourceId !== input.outboxId ||
        input.deadLetterAudit.actorType !== 'system')
    ) {
      throw new TypeError('Token revocation dead-letter audit does not match the outbox row');
    }
    const results = await this.adapter.batch([
      {
        sql: `UPDATE admin_agent_token_revocation_outbox
         SET status = ?, next_attempt_at = ?, processing_owner_id = NULL,
             processing_lease_expires_at = NULL, failure_transition_id = ?
         WHERE id = ? AND tenant_id = ? AND status = 'processing'
           AND processing_owner_id = ? AND processing_fence = ?
           AND attempt_count = ?`,
        params: [
          deadLetter ? 'dead_letter' : 'pending',
          input.nextAttemptAt,
          input.deadLetterAudit.id,
          input.outboxId,
          input.tenantId,
          input.ownerId,
          input.fence,
          input.expectedAttempt,
        ],
      },
      adminAgentAuditStatement(input.deadLetterAudit, {
        from: 'admin_agent_token_revocation_outbox',
        where: "id = ? AND tenant_id = ? AND status = 'dead_letter' AND failure_transition_id = ?",
        params: [input.outboxId, input.tenantId, input.deadLetterAudit.id],
      }),
    ]);
    if (results[0]?.rowsAffected !== 1) {
      const replay = await this.adapter.queryOne<{
        status: 'pending' | 'dead_letter';
        failure_transition_id: string;
      }>(
        `SELECT status, failure_transition_id FROM admin_agent_token_revocation_outbox
         WHERE id = ? AND tenant_id = ? AND failure_transition_id = ?
           AND status IN ('pending', 'dead_letter')`,
        [input.outboxId, input.tenantId, input.deadLetterAudit.id]
      );
      if (replay?.failure_transition_id !== input.deadLetterAudit.id) return null;
      return replay.status === 'dead_letter' ? 'dead_letter' : 'retry_scheduled';
    }
    return deadLetter ? 'dead_letter' : 'retry_scheduled';
  }
}
