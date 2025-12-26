/**
 * Contract Change Log Types
 *
 * Types for tracking changes to contracts and supporting rollback functionality.
 * Provides audit trail and recovery capabilities.
 */

// =============================================================================
// Change Log Entry
// =============================================================================

/**
 * Change log entry recording a contract modification.
 */
export interface ContractChangeLog {
  /** Unique change log ID */
  id: string;
  /** Type of contract (tenant or client) */
  contractType: 'tenant' | 'client';
  /** Contract ID (tenantId or clientId) */
  contractId: string;
  /** Version before change */
  fromVersion: number;
  /** Version after change */
  toVersion: number;
  /** List of field changes */
  changes: FieldChange[];
  /** Who made the change */
  changedBy: string;
  /** When the change was made (ISO 8601) */
  changedAt: string;
  /** Optional reason for change */
  reason?: string;
  /** Source of change */
  source: ChangeSource;
  /** Rollback information (if this was a rollback) */
  rollbackInfo?: RollbackInfo;
  /** Whether this change has been rolled back */
  wasRolledBack?: boolean;
  /** ID of the rollback change log (if rolled back) */
  rolledBackBy?: string;
}

/**
 * Source of the change.
 */
export type ChangeSource =
  | 'admin_ui' // Changed via admin panel
  | 'admin_api' // Changed via Admin API
  | 'preset_apply' // Preset was applied
  | 'migration' // Automated migration
  | 'rollback' // Rollback operation
  | 'system'; // System-initiated change

// =============================================================================
// Field Change
// =============================================================================

/**
 * Individual field change within a contract update.
 */
export interface FieldChange {
  /** Field path (e.g., 'oauth.maxAccessTokenExpiry') */
  path: string;
  /** Previous value */
  oldValue: unknown;
  /** New value */
  newValue: unknown;
  /** Type of change */
  changeType: FieldChangeType;
  /** Impact level of this change */
  impact: FieldChangeImpact;
  /** Human-readable description */
  description?: string;
}

/**
 * Type of field change.
 */
export type FieldChangeType =
  | 'added' // New field added
  | 'removed' // Field removed
  | 'modified'; // Field value changed

/**
 * Impact level of a field change.
 */
export type FieldChangeImpact =
  | 'minor' // No breaking changes
  | 'major' // Significant change, but backwards compatible
  | 'breaking'; // Breaking change, may affect existing clients

// =============================================================================
// Rollback Types
// =============================================================================

/**
 * Information about a rollback operation.
 */
export interface RollbackInfo {
  /** When the rollback was performed (ISO 8601) */
  rolledBackAt: string;
  /** Who performed the rollback */
  rolledBackBy: string;
  /** Reason for rollback */
  reason: string;
  /** Target version that was restored */
  targetVersion: number;
  /** Original change log ID that was rolled back */
  originalChangeLogId: string;
}

/**
 * Request to rollback a contract to a previous version.
 */
export interface RollbackRequest {
  /** Type of contract */
  contractType: 'tenant' | 'client';
  /** Contract ID */
  contractId: string;
  /** Version to restore */
  targetVersion: number;
  /** Reason for rollback */
  reason: string;
  /** Dry run mode (preview only) */
  dryRun?: boolean;
}

/**
 * Result of a rollback operation.
 */
export interface RollbackResult {
  /** Whether rollback succeeded */
  success: boolean;
  /** Version before rollback */
  previousVersion: number;
  /** Version after rollback (restored version) */
  restoredVersion: number;
  /** ID of the change log entry for this rollback */
  changeLogId: string;
  /** Error message if failed */
  error?: string;
  /** Changes that would be applied (for dry run) */
  previewChanges?: FieldChange[];
  /** Affected clients (for tenant rollback) */
  affectedClients?: string[];
}

// =============================================================================
// Change Log Query
// =============================================================================

/**
 * Query parameters for retrieving change logs.
 */
export interface ChangeLogQuery {
  /** Filter by contract type */
  contractType?: 'tenant' | 'client';
  /** Filter by contract ID */
  contractId?: string;
  /** Filter by date range (from) */
  fromDate?: string;
  /** Filter by date range (to) */
  toDate?: string;
  /** Filter by user who made the change */
  changedBy?: string;
  /** Filter by change source */
  source?: ChangeSource;
  /** Filter by impact level */
  impact?: FieldChangeImpact;
  /** Include rollbacks */
  includeRollbacks?: boolean;
  /** Exclude rolled-back changes */
  excludeRolledBack?: boolean;
  /** Maximum number of results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Sort order */
  sortOrder?: 'asc' | 'desc';
}

/**
 * Result of a change log query.
 */
export interface ChangeLogQueryResult {
  /** Change log entries */
  entries: ContractChangeLog[];
  /** Total count (for pagination) */
  totalCount: number;
  /** Whether there are more results */
  hasMore: boolean;
}

// =============================================================================
// Version History
// =============================================================================

/**
 * Summary of a contract version.
 */
export interface VersionSummary {
  /** Version number */
  version: number;
  /** When this version was created (ISO 8601) */
  createdAt: string;
  /** Who created this version */
  createdBy: string;
  /** Summary of changes in this version */
  changesSummary: string;
  /** Number of field changes */
  changeCount: number;
  /** Maximum impact level in this version */
  maxImpact: FieldChangeImpact;
  /** Whether this version is the current active version */
  isCurrent: boolean;
  /** Whether this version can be rolled back to */
  canRollbackTo: boolean;
}

/**
 * Version history for a contract.
 */
export interface VersionHistory {
  /** Contract type */
  contractType: 'tenant' | 'client';
  /** Contract ID */
  contractId: string;
  /** Current version */
  currentVersion: number;
  /** Version summaries (newest first) */
  versions: VersionSummary[];
  /** Oldest available version (for retention) */
  oldestVersion: number;
}

// =============================================================================
// Change Comparison
// =============================================================================

/**
 * Comparison between two contract versions.
 */
export interface VersionComparison {
  /** Contract type */
  contractType: 'tenant' | 'client';
  /** Contract ID */
  contractId: string;
  /** From version */
  fromVersion: number;
  /** To version */
  toVersion: number;
  /** All changes between versions */
  changes: FieldChange[];
  /** Overall impact */
  overallImpact: FieldChangeImpact;
  /** Number of versions between from and to */
  versionSpan: number;
}

/**
 * Request to compare two versions.
 */
export interface VersionCompareRequest {
  /** Contract type */
  contractType: 'tenant' | 'client';
  /** Contract ID */
  contractId: string;
  /** From version (older) */
  fromVersion: number;
  /** To version (newer) */
  toVersion: number;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Calculate the overall impact from a list of field changes.
 */
export function calculateOverallImpact(changes: FieldChange[]): FieldChangeImpact {
  if (changes.some((c) => c.impact === 'breaking')) return 'breaking';
  if (changes.some((c) => c.impact === 'major')) return 'major';
  return 'minor';
}

/**
 * Generate a human-readable summary of changes.
 */
export function generateChangesSummary(changes: FieldChange[]): string {
  const added = changes.filter((c) => c.changeType === 'added').length;
  const modified = changes.filter((c) => c.changeType === 'modified').length;
  const removed = changes.filter((c) => c.changeType === 'removed').length;

  const parts: string[] = [];
  if (added > 0) parts.push(`${added} added`);
  if (modified > 0) parts.push(`${modified} modified`);
  if (removed > 0) parts.push(`${removed} removed`);

  return parts.join(', ') || 'No changes';
}
