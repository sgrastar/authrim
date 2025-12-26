/**
 * Contract Error Types
 *
 * Error types and codes for Contract resolution, validation, and lifecycle operations.
 * These provide structured error handling for policy-related operations.
 */

// =============================================================================
// Error Codes
// =============================================================================

/**
 * Contract-related error codes.
 * Format: CNTR + 3-digit number
 *
 * Ranges:
 * - 001-009: Version errors
 * - 010-019: Validation errors
 * - 020-029: Resolution errors
 * - 030-039: Lifecycle errors
 * - 040-049: Cache errors
 * - 050-059: Dependency errors
 */
export const CONTRACT_ERROR_CODES = {
  // Version errors (001-009)
  /** Tenant and client versions are incompatible */
  VERSION_MISMATCH: 'CNTR001',
  /** Specified version does not exist */
  VERSION_NOT_FOUND: 'CNTR002',
  /** Version has been superseded */
  VERSION_SUPERSEDED: 'CNTR003',

  // Validation errors (010-019)
  /** General validation failure */
  VALIDATION_FAILED: 'CNTR010',
  /** Client value exceeds tenant maximum */
  EXCEEDS_TENANT_MAX: 'CNTR011',
  /** Client value not in tenant allowed list */
  NOT_IN_TENANT_ALLOWED: 'CNTR012',
  /** Feature is disabled at tenant level */
  TENANT_DISABLED: 'CNTR013',
  /** Feature is required at tenant level but missing in client */
  TENANT_REQUIRED: 'CNTR014',
  /** Invalid combination of settings */
  INVALID_COMBINATION: 'CNTR015',
  /** Scope not allowed by tenant policy */
  SCOPE_NOT_ALLOWED: 'CNTR016',
  /** Auth method not allowed by tenant policy */
  AUTH_METHOD_NOT_ALLOWED: 'CNTR017',

  // Resolution errors (020-029)
  /** General resolution failure */
  RESOLUTION_FAILED: 'CNTR020',
  /** Incompatible settings between tenant and client */
  INCOMPATIBLE_SETTINGS: 'CNTR021',
  /** Circular dependency detected */
  CIRCULAR_DEPENDENCY: 'CNTR022',
  /** Missing required configuration */
  MISSING_REQUIRED_CONFIG: 'CNTR023',

  // Lifecycle errors (030-039)
  /** Invalid status transition requested */
  INVALID_STATUS_TRANSITION: 'CNTR030',
  /** Contract is not in active status */
  CONTRACT_NOT_ACTIVE: 'CNTR031',
  /** Contract is archived and cannot be modified */
  CONTRACT_ARCHIVED: 'CNTR032',
  /** Contract is pending review */
  CONTRACT_PENDING_REVIEW: 'CNTR033',

  // Cache errors (040-049)
  /** Cache miss - policy not found in cache */
  CACHE_MISS: 'CNTR040',
  /** Cache is stale and needs refresh */
  CACHE_STALE: 'CNTR041',
  /** Cache invalidation failed */
  CACHE_INVALIDATION_FAILED: 'CNTR042',

  // Dependency errors (050-059)
  /** Dependent clients would be affected */
  BREAKING_CHANGE: 'CNTR050',
  /** Client depends on deprecated tenant version */
  DEPRECATED_DEPENDENCY: 'CNTR051',
} as const;

export type ContractErrorCode = (typeof CONTRACT_ERROR_CODES)[keyof typeof CONTRACT_ERROR_CODES];

// =============================================================================
// Error Categories
// =============================================================================

/**
 * Error category for grouping and handling.
 */
export type ContractErrorCategory =
  | 'validation'
  | 'resolution'
  | 'lifecycle'
  | 'cache'
  | 'dependency'
  | 'system';

// =============================================================================
// Error Types
// =============================================================================

/**
 * Base contract error interface.
 */
export interface ContractError {
  /** Error code from CONTRACT_ERROR_CODES */
  code: ContractErrorCode;
  /** Human-readable error message */
  message: string;
  /** Error category */
  category: ContractErrorCategory;
  /** Field that caused the error (if applicable) */
  field?: string;
  /** Additional error details */
  details?: Record<string, unknown>;
  /** Suggested action to resolve the error */
  suggestion?: string;
}

/**
 * Policy resolution error with conflict details.
 */
export interface PolicyResolutionError extends ContractError {
  category: 'resolution';
  /** Conflicting settings between tenant and client */
  conflicts?: PolicyConflict[];
}

/**
 * Describes a conflict between tenant and client settings.
 */
export interface PolicyConflict {
  /** Tenant field path (e.g., 'oauth.maxAccessTokenExpiry') */
  tenantField: string;
  /** Client field path (e.g., 'oauth.accessTokenExpiry') */
  clientField: string;
  /** Value from tenant policy */
  tenantValue: unknown;
  /** Value from client profile */
  clientValue: unknown;
  /** Resolution strategy applied */
  resolution: PolicyConflictResolution;
  /** Description of the conflict */
  description?: string;
}

/**
 * How a policy conflict was resolved.
 */
export type PolicyConflictResolution =
  | 'tenant_wins' // Tenant value takes precedence
  | 'client_wins' // Client value takes precedence (if within bounds)
  | 'intersection' // Use intersection of allowed values
  | 'minimum' // Use minimum of two values
  | 'maximum' // Use maximum of two values
  | 'error'; // Could not resolve, error raised

/**
 * Validation error with field-specific details.
 */
export interface ValidationError extends ContractError {
  category: 'validation';
  /** Validation rule that failed */
  rule?: string;
  /** Expected value or constraint */
  expected?: unknown;
  /** Actual value provided */
  actual?: unknown;
}

/**
 * Lifecycle transition error.
 */
export interface LifecycleError extends ContractError {
  category: 'lifecycle';
  /** Current status */
  currentStatus?: string;
  /** Attempted target status */
  targetStatus?: string;
  /** Allowed transitions from current status */
  allowedTransitions?: string[];
}

/**
 * Dependency error for breaking changes.
 */
export interface DependencyError extends ContractError {
  category: 'dependency';
  /** Affected client IDs */
  affectedClients?: string[];
  /** Number of affected clients */
  affectedCount?: number;
}

// =============================================================================
// Warning Types
// =============================================================================

/**
 * Contract warning (non-blocking issue).
 */
export interface ContractWarning {
  /** Warning code */
  code: string;
  /** Warning message */
  message: string;
  /** Field that triggered the warning */
  field?: string;
  /** Suggested action */
  suggestion?: string;
  /** Severity level */
  severity: 'info' | 'warning';
}

// =============================================================================
// Result Types
// =============================================================================

/**
 * Contract operation result with errors and warnings.
 */
export interface ContractOperationResult<T = void> {
  /** Whether the operation succeeded */
  success: boolean;
  /** Result data (if success) */
  data?: T;
  /** Errors (if failure) */
  errors?: ContractError[];
  /** Warnings (always included if any) */
  warnings?: ContractWarning[];
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if an error is a PolicyResolutionError.
 */
export function isPolicyResolutionError(error: ContractError): error is PolicyResolutionError {
  return error.category === 'resolution';
}

/**
 * Check if an error is a ValidationError.
 */
export function isValidationError(error: ContractError): error is ValidationError {
  return error.category === 'validation';
}

/**
 * Check if an error is a LifecycleError.
 */
export function isLifecycleError(error: ContractError): error is LifecycleError {
  return error.category === 'lifecycle';
}

/**
 * Check if an error is a DependencyError.
 */
export function isDependencyError(error: ContractError): error is DependencyError {
  return error.category === 'dependency';
}

// =============================================================================
// Error Factory Functions
// =============================================================================

/**
 * Create a validation error for exceeding tenant maximum.
 */
export function createExceedsTenantMaxError(
  field: string,
  tenantMax: number,
  clientValue: number
): ValidationError {
  return {
    code: CONTRACT_ERROR_CODES.EXCEEDS_TENANT_MAX,
    message: `Client value ${clientValue} exceeds tenant maximum ${tenantMax}`,
    category: 'validation',
    field,
    expected: `<= ${tenantMax}`,
    actual: clientValue,
    suggestion: `Reduce the value to ${tenantMax} or less`,
  };
}

/**
 * Create a validation error for value not in allowed list.
 */
export function createNotInAllowedError(
  field: string,
  allowedValues: unknown[],
  actualValue: unknown
): ValidationError {
  return {
    code: CONTRACT_ERROR_CODES.NOT_IN_TENANT_ALLOWED,
    message: `Value "${actualValue}" is not in the allowed list`,
    category: 'validation',
    field,
    expected: allowedValues,
    actual: actualValue,
    suggestion: `Choose one of: ${allowedValues.join(', ')}`,
  };
}

/**
 * Create a lifecycle transition error.
 */
export function createInvalidTransitionError(
  currentStatus: string,
  targetStatus: string,
  allowedTransitions: string[]
): LifecycleError {
  return {
    code: CONTRACT_ERROR_CODES.INVALID_STATUS_TRANSITION,
    message: `Cannot transition from "${currentStatus}" to "${targetStatus}"`,
    category: 'lifecycle',
    currentStatus,
    targetStatus,
    allowedTransitions,
    suggestion: `Allowed transitions: ${allowedTransitions.join(', ')}`,
  };
}
