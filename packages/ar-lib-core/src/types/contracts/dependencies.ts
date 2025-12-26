/**
 * Contract Dependency Types
 *
 * Types for managing dependencies between TenantContract and ClientContract.
 * Enables impact analysis when tenant policies change.
 */

// =============================================================================
// Dependency Graph
// =============================================================================

/**
 * Dependency graph showing tenant-client relationships.
 */
export interface ContractDependencyGraph {
  /** Tenant ID */
  tenantId: string;
  /** Current tenant version */
  tenantVersion: number;
  /** Dependent clients */
  dependentClients: ClientDependency[];
  /** Total number of dependent clients */
  totalClients: number;
  /** Graph generation time (ISO 8601) */
  generatedAt: string;
}

/**
 * Client dependency on tenant contract.
 */
export interface ClientDependency {
  /** Client ID */
  clientId: string;
  /** Client name (for display) */
  clientName?: string;
  /** Client version */
  clientVersion: number;
  /** Tenant version this client depends on */
  tenantContractVersion: number;
  /** Whether dependency is current */
  isCurrent: boolean;
  /** Fields inherited from tenant */
  inheritedFields: InheritedField[];
  /** Fields overridden by client */
  overriddenFields: OverriddenField[];
  /** Estimated active users for this client */
  estimatedActiveUsers?: number;
  /** Last activity time (ISO 8601) */
  lastActivityAt?: string;
}

/**
 * Field inherited from tenant policy.
 */
export interface InheritedField {
  /** Field path (e.g., 'oauth.maxAccessTokenExpiry') */
  path: string;
  /** Effective value (from tenant) */
  value: unknown;
}

/**
 * Field overridden by client profile.
 */
export interface OverriddenField {
  /** Field path */
  path: string;
  /** Tenant value */
  tenantValue: unknown;
  /** Client override value */
  clientValue: unknown;
  /** Whether override is within tenant bounds */
  withinBounds: boolean;
}

// =============================================================================
// Impact Analysis
// =============================================================================

/**
 * Impact analysis for a tenant policy change.
 */
export interface DependencyImpactAnalysis {
  /** Tenant ID */
  tenantId: string;
  /** Changed fields in tenant policy */
  changedFields: ChangedFieldAnalysis[];
  /** Affected clients */
  affectedClients: AffectedClient[];
  /** Total affected clients */
  totalAffectedClients: number;
  /** Estimated total affected users */
  totalAffectedUsers: number;
  /** Overall impact level */
  overallImpact: ImpactLevel;
  /** Whether change is safe to apply */
  safeToApply: boolean;
  /** Blocking issues (if not safe) */
  blockingIssues?: BlockingIssue[];
  /** Analysis generation time (ISO 8601) */
  analyzedAt: string;
}

/**
 * Analysis of a changed field.
 */
export interface ChangedFieldAnalysis {
  /** Field path */
  path: string;
  /** Old value */
  oldValue: unknown;
  /** New value */
  newValue: unknown;
  /** Change type */
  changeType: 'added' | 'removed' | 'modified';
  /** Impact of this field change */
  impact: FieldImpact;
  /** Clients affected by this specific change */
  affectedClientCount: number;
}

/**
 * Impact classification for a field change.
 */
export interface FieldImpact {
  /** Impact level */
  level: ImpactLevel;
  /** Impact description */
  description: string;
  /** Whether this is a breaking change */
  breaking: boolean;
  /** Migration path (if breaking) */
  migrationPath?: string;
}

/**
 * Impact level classification.
 */
export type ImpactLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

/**
 * Client affected by a tenant policy change.
 */
export interface AffectedClient {
  /** Client ID */
  clientId: string;
  /** Client name */
  clientName?: string;
  /** Impact level for this client */
  impactLevel: ImpactLevel;
  /** Specific affected fields */
  affectedFields: string[];
  /** Whether client needs to update its config */
  requiresUpdate: boolean;
  /** Actions needed to maintain compatibility */
  requiredActions: RequiredAction[];
  /** Estimated affected users */
  estimatedAffectedUsers?: number;
}

/**
 * Action required for a client to maintain compatibility.
 */
export interface RequiredAction {
  /** Action type */
  type: 'update_config' | 'review_setting' | 'regenerate_tokens' | 'notify_users';
  /** Description */
  description: string;
  /** Priority */
  priority: 'low' | 'medium' | 'high';
  /** Field path (if applicable) */
  field?: string;
  /** Suggested new value (if applicable) */
  suggestedValue?: unknown;
}

/**
 * Issue blocking a policy change.
 */
export interface BlockingIssue {
  /** Issue type */
  type: BlockingIssueType;
  /** Affected client (if specific to a client) */
  clientId?: string;
  /** Issue description */
  description: string;
  /** Resolution steps */
  resolution: string;
}

/**
 * Types of blocking issues.
 */
export type BlockingIssueType =
  | 'breaking_change'
  | 'client_out_of_bounds'
  | 'required_field_removed'
  | 'incompatible_setting';

// =============================================================================
// Dependency Validation
// =============================================================================

/**
 * Result of validating dependencies after a change.
 */
export interface DependencyValidationResult {
  /** Whether all dependencies are valid */
  valid: boolean;
  /** Validation errors */
  errors: ClientDependencyError[];
  /** Validation warnings */
  warnings: DependencyWarning[];
}

/**
 * Client dependency error (distinct from ContractError's DependencyError).
 */
export interface ClientDependencyError {
  /** Error type */
  type: DependencyErrorType;
  /** Affected client ID */
  clientId: string;
  /** Field path */
  field: string;
  /** Tenant value */
  tenantValue: unknown;
  /** Client value */
  clientValue: unknown;
  /** Error message */
  message: string;
  /** Suggested fix */
  suggestion?: string;
}

/**
 * Types of dependency errors.
 */
export type DependencyErrorType =
  | 'exceeds_max'
  | 'not_in_allowed'
  | 'feature_disabled'
  | 'required_missing'
  | 'version_mismatch';

/**
 * Dependency warning.
 */
export interface DependencyWarning {
  /** Warning type */
  type: string;
  /** Affected client ID */
  clientId?: string;
  /** Warning message */
  message: string;
  /** Recommendation */
  recommendation?: string;
}

// =============================================================================
// Dependency Update
// =============================================================================

/**
 * Request to update client dependencies after tenant change.
 */
export interface DependencyUpdateRequest {
  /** Tenant ID */
  tenantId: string;
  /** New tenant version */
  newTenantVersion: number;
  /** Strategy for updating clients */
  strategy: DependencyUpdateStrategy;
  /** Specific clients to update (if not all) */
  clientIds?: string[];
  /** Dry run mode */
  dryRun?: boolean;
}

/**
 * Strategy for updating client dependencies.
 */
export type DependencyUpdateStrategy =
  | 'auto_adjust' // Automatically adjust client values to fit new bounds
  | 'notify_only' // Only notify, don't change
  | 'fail_fast'; // Fail if any client is out of bounds

/**
 * Result of a dependency update operation.
 */
export interface DependencyUpdateResult {
  /** Whether update was successful */
  success: boolean;
  /** Clients that were updated */
  updatedClients: UpdatedClient[];
  /** Clients that failed to update */
  failedClients: FailedClient[];
  /** Notifications sent */
  notificationsSent: number;
}

/**
 * Successfully updated client.
 */
export interface UpdatedClient {
  /** Client ID */
  clientId: string;
  /** Old version */
  oldVersion: number;
  /** New version */
  newVersion: number;
  /** Changes made */
  changes: {
    field: string;
    oldValue: unknown;
    newValue: unknown;
  }[];
}

/**
 * Client that failed to update.
 */
export interface FailedClient {
  /** Client ID */
  clientId: string;
  /** Error message */
  error: string;
  /** Action needed */
  actionNeeded: string;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Calculate overall impact from affected clients.
 * Named differently from change-log.ts's calculateOverallImpact to avoid export conflict.
 */
export function calculateClientImpact(clients: AffectedClient[]): ImpactLevel {
  const levels: ImpactLevel[] = ['none', 'low', 'medium', 'high', 'critical'];
  const maxIndex = Math.max(...clients.map((c) => levels.indexOf(c.impactLevel)));
  return levels[maxIndex] || 'none';
}

/**
 * Check if a policy change is safe to apply.
 */
export function isChangeSafe(analysis: DependencyImpactAnalysis): boolean {
  return (
    analysis.overallImpact !== 'critical' &&
    !analysis.affectedClients.some((c) => c.impactLevel === 'critical')
  );
}

/**
 * Get clients that require action.
 */
export function getClientsRequiringAction(analysis: DependencyImpactAnalysis): AffectedClient[] {
  return analysis.affectedClients.filter((c) => c.requiresUpdate);
}
