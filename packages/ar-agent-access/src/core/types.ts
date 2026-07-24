export type AgentMode = 'mode_a' | 'mode_b';

export type AgentActorAssurance =
  | 'public_client_transaction'
  | 'confidential_client'
  | 'machine_key';

export type AgentTokenBinding = 'bearer' | 'dpop';
export type AgentRiskLevel = 'low' | 'standard' | 'high';
export type AgentGrantStatus = 'active' | 'suspended' | 'revoked';
export type AgentDelegationMode = 'user_consent' | 'admin_pre_authorized' | 'task_approved';
export type AgentScope =
  | 'agent:read'
  | 'agent:user-data:read'
  | 'agent:write'
  | 'agent:execute'
  | 'agent:admin';

export interface AgentActorContext {
  mode: AgentMode;
  sub: string;
  assurance: AgentActorAssurance;
  tokenBinding: AgentTokenBinding;
  clientId: string;
  machinePrincipalId?: string;
  machineCredentialId?: string;
}

export interface AgentGrantContract {
  grantId: string;
  tenantId: string;
  clientId: string;
  machinePrincipalId?: string;
  grantorId: string;
  delegatorId: string;
  permissions: string[];
  scopes: AgentScope[];
  /** RFC 9396 restrictions carried by the Grant; effective limits are pinned below. */
  authorizationDetails?: JsonObject[];
  resolvedScopeConstraints: AgentScopeConstraints;
  consentVersion: number;
  generation: number;
  status: AgentGrantStatus;
  delegationMode: AgentDelegationMode;
  taskSetId?: string;
  taskSetVersion?: number;
  scopePolicyId?: string;
  scopePolicyVersion?: number;
  resolvedTools?: AgentResolvedToolContract[];
  accessSnapshotHash?: string;
  expiresAt?: number;
}

/** Immutable Tool contract snapshot pinned when a versioned Task Set is attached to a Grant. */
export interface AgentResolvedToolContract {
  toolId: string;
  toolName: string;
  contractVersion: string;
  schemaDigest: string;
  permissions: string[];
  requiredScope: AgentScope;
  riskLevel: AgentRiskLevel;
  requiresElevation: boolean;
}

export interface AgentToolDefinition {
  id: string;
  name: string;
  title: string;
  description: string;
  contractVersion: string;
  requiredPermissions: readonly string[];
  riskLevel: AgentRiskLevel;
  requiredScope: AgentScope;
  schemaDigest: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  /** MCP annotations are untrusted client hints and are never authorization inputs. */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /**
   * Explicit server-owned eligibility for a tenant to opt a public Mode A client into this
   * standard-risk Tool. Eligibility alone grants nothing: settings, Grant, scope, resource, and
   * live permission checks must all pass.
   */
  publicClientStandardOptInEligible?: boolean;
  /** Phase 0-2 tools execute synchronously; MCP Tasks are deliberately not advertised. */
  taskSupport?: 'forbidden';
  /** Internal execution owner. This value is not emitted as MCP Tool metadata. */
  executionTarget?:
    | 'management_api'
    | 'configuration_plan'
    | 'bulk_plan'
    | 'runtime_diagnostics'
    | 'access_introspection'
    | 'session_control';
  /** Public protocol metadata only. Security decisions must use the fields above. */
  protocolMetadata?: JsonObject;
}

/** Unsealed Tool declaration. The catalog derives schemaDigest from the complete contract. */
export type AgentToolDefinitionSource = Omit<AgentToolDefinition, 'schemaDigest'> & {
  /** Legacy declarations may carry this field, but sealing always recomputes and replaces it. */
  schemaDigest?: string;
};

export interface AgentCatalogSelector {
  kind: 'catalog';
  selectorId: string;
  version: number;
}

export interface AgentExplicitIdSelector {
  kind: 'ids';
  ids: string[];
}

export type AgentResourceSelector = AgentCatalogSelector | AgentExplicitIdSelector;

export interface AgentScopeConstraints {
  tenantIds: string[];
  environmentIds?: string[];
  domains?: string[];
  resourceSelector?: AgentResourceSelector;
  allowedFields?: string[];
  piiMode?: 'masked' | 'unmasked';
  maxPerCall?: number;
  maxPerPlan?: number;
  maxPerBulkPlan?: number;
}

export interface AgentResourceRequestContext {
  tenantId: string;
  environmentId?: string;
  domain?: string;
  resourceId?: string;
  requestedFields?: string[];
  requestsUnmaskedPii?: boolean;
  quantity?: number;
  /** Result of the schema-versioned, allowlisted selector evaluated by its owner. */
  catalogSelectorMatched?: boolean;
}

export interface AgentRiskPolicy {
  allowedRiskByAssurance: Record<AgentActorAssurance, AgentRiskLevel[]>;
  highRiskRequiresElevation: boolean;
  dpopRequiredForModeB: boolean;
  /** Tenant-wide permission overrides that can only raise an operation to high risk. */
  highRiskPermissionsAdditional?: string[];
  /** Stable Tool IDs explicitly enabled for low-assurance public Mode A clients. */
  publicClientStandardToolIds?: string[];
}

export interface AgentPrincipalTenantScope {
  scopeMode: 'none' | 'all' | 'allow';
  tenantId: string | null;
}

export interface AgentTenantBoundaryInput {
  tenantId: string;
  clientTenantId: string;
  grantorTenantId: string;
  delegatorTenantId: string;
  principalTenantScopes?: AgentPrincipalTenantScope[];
}

export interface AgentAuthorizationInput {
  featureEnabled: boolean;
  now: number;
  actor: AgentActorContext;
  grant: AgentGrantContract;
  tool: AgentToolDefinition;
  delegatorCurrentPermissions: string[];
  principalPermissionLimit?: string[];
  constraints: AgentScopeConstraints;
  resource: AgentResourceRequestContext;
  riskPolicy: AgentRiskPolicy;
  elevationCapabilityValid?: boolean;
}

export type AgentAuthorizationAxis =
  | 'feature_flag'
  | 'identity'
  | 'grant'
  | 'permission'
  | 'scope'
  | 'resource'
  | 'risk';

export interface AgentAuthorizationDecision {
  allowed: boolean;
  requiresElevation: boolean;
  deniedAxis?: AgentAuthorizationAxis;
  code?: string;
}

export interface AgentGrantValidationInput {
  tenantBoundary: AgentTenantBoundaryInput;
  requestedPermissions: string[];
  grantorPermissions: string[];
  delegatorPermissions: string[];
  machinePrincipalId?: string;
  principalPermissions?: string[];
}

export interface AgentGrantValidationResult {
  valid: boolean;
  code?: string;
  permission?: string;
}

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface AgentElevationHashContext {
  purpose: 'authrim-mcp-elevation-v1';
  tenant_id: string;
  grant_id: string;
  delegator_id: string;
  actor_sub: string;
  client_id: string;
  tool_name: string;
  tool_schema_version: string;
  args: JsonValue;
}
