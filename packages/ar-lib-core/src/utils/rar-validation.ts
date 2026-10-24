/**
 * Rich Authorization Requests (RAR) Validation
 *
 * RFC 9396: OAuth 2.0 Rich Authorization Requests
 * https://datatracker.ietf.org/doc/html/rfc9396
 *
 * This module provides validation for authorization_details parameter
 * with type-specific validation for known types.
 *
 * Validation levels:
 * - Phase 1 (current): JSON structure + type-specific validation
 * - Phase 2 (future): Policy integration + consent UI
 * - Phase 3 (future): ABAC integration + capability contracts
 *
 * @see §16.8 in architecture-decisions.md for RAR design rationale
 */

import type {
  AuthorizationDetails,
  AuthorizationDetailsBase,
  AIAgentActionDetail,
  PaymentInitiationDetail,
  AccountInformationDetail,
  RARValidationResult,
  RARValidationError,
} from '../types/rar';

import { DEFAULT_RAR_MAX_SIZE, DEFAULT_RAR_MAX_ENTRIES } from '../types/rar';

// =============================================================================
// Validation Options
// =============================================================================

/**
 * RAR validation options
 */
export interface RARValidationOptions {
  /** Maximum size of authorization_details JSON in bytes. Default: 16384 (16KB) */
  maxSize?: number;
  /** Maximum number of entries in the array. Default: 10 */
  maxEntries?: number;
  /** Allowed authorization detail types. If empty, all types are allowed */
  allowedTypes?: string[];
  /** Denied authorization detail types (takes precedence over allowedTypes) */
  deniedTypes?: string[];
  /** Whether to validate type-specific fields. Default: true */
  validateTypeSpecific?: boolean;
  /** Whether to sanitize (remove unknown fields) for known types. Default: false */
  sanitize?: boolean;
}

/**
 * Default validation options
 */
export const DEFAULT_RAR_VALIDATION_OPTIONS: Required<RARValidationOptions> = {
  maxSize: DEFAULT_RAR_MAX_SIZE,
  maxEntries: DEFAULT_RAR_MAX_ENTRIES,
  allowedTypes: [],
  deniedTypes: [],
  validateTypeSpecific: true,
  sanitize: false,
};

// =============================================================================
// Main Validation Function
// =============================================================================

/**
 * Validate authorization_details parameter
 *
 * Per RFC 9396:
 * - authorization_details MUST be a JSON array
 * - Each entry MUST have a "type" field
 * - Other fields are type-specific
 *
 * @param input - Raw authorization_details (string or parsed)
 * @param options - Validation options
 * @returns RARValidationResult
 */
export function validateAuthorizationDetails(
  input: unknown,
  options: RARValidationOptions = {}
): RARValidationResult {
  const opts = { ...DEFAULT_RAR_VALIDATION_OPTIONS, ...options };
  const errors: RARValidationError[] = [];
  const warnings: RARValidationError[] = [];

  // Parse if string
  let parsed: unknown;
  if (typeof input === 'string') {
    // Check size before parsing
    if (input.length > opts.maxSize) {
      return {
        valid: false,
        errors: [
          {
            index: -1,
            code: 'size_exceeded',
            message: `authorization_details exceeds maximum size of ${opts.maxSize} bytes`,
          },
        ],
      };
    }

    try {
      parsed = JSON.parse(input);
    } catch {
      return {
        valid: false,
        errors: [
          {
            index: -1,
            code: 'invalid_json',
            message: 'authorization_details is not valid JSON',
          },
        ],
      };
    }
  } else {
    parsed = input;
  }

  // Must be an array
  if (!Array.isArray(parsed)) {
    return {
      valid: false,
      errors: [
        {
          index: -1,
          code: 'not_array',
          message: 'authorization_details must be a JSON array',
        },
      ],
    };
  }

  // Check array length
  if (parsed.length === 0) {
    return {
      valid: false,
      errors: [
        {
          index: -1,
          code: 'empty_array',
          message: 'authorization_details array must not be empty',
        },
      ],
    };
  }

  if (parsed.length > opts.maxEntries) {
    return {
      valid: false,
      errors: [
        {
          index: -1,
          code: 'size_exceeded',
          message: `authorization_details has too many entries (max: ${opts.maxEntries})`,
        },
      ],
    };
  }

  // Validate each entry
  const sanitized: AuthorizationDetails[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    const entryResult = validateAuthorizationDetailEntry(entry, i, opts);

    errors.push(...entryResult.errors);
    if (entryResult.warnings) {
      warnings.push(...entryResult.warnings);
    }

    if (entryResult.sanitized) {
      sanitized.push(entryResult.sanitized);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: warnings.length > 0 ? warnings : undefined,
    sanitized: errors.length === 0 ? sanitized : undefined,
  };
}

// =============================================================================
// Entry Validation
// =============================================================================

interface EntryValidationResult {
  errors: RARValidationError[];
  warnings?: RARValidationError[];
  sanitized?: AuthorizationDetails;
}

/**
 * Validate a single authorization_details entry
 */
function validateAuthorizationDetailEntry(
  entry: unknown,
  index: number,
  options: Required<RARValidationOptions>
): EntryValidationResult {
  const errors: RARValidationError[] = [];
  const warnings: RARValidationError[] = [];

  // Must be an object
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    errors.push({
      index,
      code: 'validation_error',
      message: 'authorization_details entry must be an object',
    });
    return { errors };
  }

  const obj = entry as Record<string, unknown>;

  // Must have 'type' field
  if (!obj.type) {
    errors.push({
      index,
      code: 'missing_type',
      message: 'authorization_details entry must have a "type" field',
      field: 'type',
    });
    return { errors };
  }

  if (typeof obj.type !== 'string') {
    errors.push({
      index,
      code: 'invalid_type',
      message: '"type" field must be a string',
      field: 'type',
    });
    return { errors };
  }

  const type = obj.type;

  // Check denied types
  if (options.deniedTypes.length > 0 && options.deniedTypes.includes(type)) {
    errors.push({
      index,
      type,
      code: 'type_not_allowed',
      message: `authorization_details type "${type}" is not allowed`,
    });
    return { errors };
  }

  // Check allowed types
  if (options.allowedTypes.length > 0 && !options.allowedTypes.includes(type)) {
    errors.push({
      index,
      type,
      code: 'type_not_allowed',
      message: `authorization_details type "${type}" is not in the allowed list`,
    });
    return { errors };
  }

  // Type-specific validation
  if (options.validateTypeSpecific) {
    const typeResult = validateByType(obj, index, type, options.sanitize);
    errors.push(...typeResult.errors);
    if (typeResult.warnings) {
      warnings.push(...typeResult.warnings);
    }
    if (typeResult.sanitized) {
      return {
        errors,
        warnings: warnings.length > 0 ? warnings : undefined,
        sanitized: typeResult.sanitized,
      };
    }
  }

  // Return as-is if no sanitization or unknown type
  return {
    errors,
    warnings: warnings.length > 0 ? warnings : undefined,
    sanitized: obj as AuthorizationDetails,
  };
}

// =============================================================================
// Type-Specific Validation
// =============================================================================

interface TypeValidationResult {
  errors: RARValidationError[];
  warnings?: RARValidationError[];
  sanitized?: AuthorizationDetails;
}

/**
 * Validate by authorization detail type
 */
function validateByType(
  obj: Record<string, unknown>,
  index: number,
  type: string,
  sanitize: boolean
): TypeValidationResult {
  switch (type) {
    case 'ai_agent_action':
      return validateAIAgentAction(obj, index, sanitize);
    case 'payment_initiation':
      return validatePaymentInitiation(obj, index, sanitize);
    case 'account_information':
      return validateAccountInformation(obj, index, sanitize);
    default:
      // Unknown type - validate base fields only
      return validateUnknownType(obj, index, sanitize);
  }
}

/**
 * Validate ai_agent_action type (Authrim-specific)
 */
function validateAIAgentAction(
  obj: Record<string, unknown>,
  index: number,
  sanitize: boolean
): TypeValidationResult {
  const errors: RARValidationError[] = [];
  const type = 'ai_agent_action';

  // Required: agent_id
  if (!obj.agent_id) {
    errors.push({
      index,
      type,
      code: 'missing_required_field',
      message: 'ai_agent_action requires "agent_id" field',
      field: 'agent_id',
    });
  } else if (typeof obj.agent_id !== 'string') {
    errors.push({
      index,
      type,
      code: 'invalid_field_type',
      message: '"agent_id" must be a string',
      field: 'agent_id',
    });
  } else if (obj.agent_id.length === 0) {
    errors.push({
      index,
      type,
      code: 'invalid_field_value',
      message: '"agent_id" cannot be empty',
      field: 'agent_id',
    });
  } else if (obj.agent_id.length > 256) {
    errors.push({
      index,
      type,
      code: 'invalid_field_value',
      message: '"agent_id" exceeds maximum length of 256 characters',
      field: 'agent_id',
    });
  }

  // Required: capabilities
  if (!obj.capabilities) {
    errors.push({
      index,
      type,
      code: 'missing_required_field',
      message: 'ai_agent_action requires "capabilities" field',
      field: 'capabilities',
    });
  } else if (!Array.isArray(obj.capabilities)) {
    errors.push({
      index,
      type,
      code: 'invalid_field_type',
      message: '"capabilities" must be an array',
      field: 'capabilities',
    });
  } else if (obj.capabilities.length === 0) {
    errors.push({
      index,
      type,
      code: 'invalid_field_value',
      message: '"capabilities" array cannot be empty',
      field: 'capabilities',
    });
  } else {
    // Validate each capability
    for (let i = 0; i < obj.capabilities.length; i++) {
      const cap = obj.capabilities[i];
      if (typeof cap !== 'string') {
        errors.push({
          index,
          type,
          code: 'invalid_field_type',
          message: `capabilities[${i}] must be a string`,
          field: `capabilities[${i}]`,
        });
      } else if (cap.length === 0) {
        errors.push({
          index,
          type,
          code: 'invalid_field_value',
          message: `capabilities[${i}] cannot be empty`,
          field: `capabilities[${i}]`,
        });
      }
    }
  }

  // Optional: session_context
  if (obj.session_context !== undefined) {
    if (typeof obj.session_context !== 'object' || obj.session_context === null) {
      errors.push({
        index,
        type,
        code: 'invalid_field_type',
        message: '"session_context" must be an object',
        field: 'session_context',
      });
    }
  }

  // Optional: tools
  if (obj.tools !== undefined) {
    if (typeof obj.tools !== 'object' || obj.tools === null) {
      errors.push({
        index,
        type,
        code: 'invalid_field_type',
        message: '"tools" must be an object',
        field: 'tools',
      });
    } else {
      const tools = obj.tools as Record<string, unknown>;
      if (tools.allowed !== undefined && !Array.isArray(tools.allowed)) {
        errors.push({
          index,
          type,
          code: 'invalid_field_type',
          message: '"tools.allowed" must be an array',
          field: 'tools.allowed',
        });
      }
      if (tools.denied !== undefined && !Array.isArray(tools.denied)) {
        errors.push({
          index,
          type,
          code: 'invalid_field_type',
          message: '"tools.denied" must be an array',
          field: 'tools.denied',
        });
      }
    }
  }

  // Optional: expires_at (ISO 8601)
  if (obj.expires_at !== undefined) {
    if (typeof obj.expires_at !== 'string') {
      errors.push({
        index,
        type,
        code: 'invalid_field_type',
        message: '"expires_at" must be a string (ISO 8601 format)',
        field: 'expires_at',
      });
    } else {
      const date = new Date(obj.expires_at);
      if (isNaN(date.getTime())) {
        errors.push({
          index,
          type,
          code: 'invalid_field_value',
          message: '"expires_at" must be a valid ISO 8601 date',
          field: 'expires_at',
        });
      }
    }
  }

  if (errors.length > 0) {
    return { errors };
  }

  // Sanitize if requested
  if (sanitize) {
    const sanitized: AIAgentActionDetail = {
      type: 'ai_agent_action',
      agent_id: obj.agent_id as string,
      capabilities: obj.capabilities as string[],
    };

    if (obj.session_context) {
      sanitized.session_context = obj.session_context as AIAgentActionDetail['session_context'];
    }
    if (obj.tools) {
      sanitized.tools = obj.tools as AIAgentActionDetail['tools'];
    }
    if (obj.expires_at) {
      sanitized.expires_at = obj.expires_at as string;
    }
    if (obj.scope_restrictions) {
      sanitized.scope_restrictions = obj.scope_restrictions as string[];
    }

    // Copy standard base fields
    copyBaseFields(obj, sanitized);

    return { errors: [], sanitized };
  }

  return { errors: [], sanitized: obj as AIAgentActionDetail };
}

/**
 * Validate payment_initiation type (RFC 9396 example)
 */
function validatePaymentInitiation(
  obj: Record<string, unknown>,
  index: number,
  sanitize: boolean
): TypeValidationResult {
  const errors: RARValidationError[] = [];
  const type = 'payment_initiation';

  // Required: instructedAmount
  if (!obj.instructedAmount) {
    errors.push({
      index,
      type,
      code: 'missing_required_field',
      message: 'payment_initiation requires "instructedAmount" field',
      field: 'instructedAmount',
    });
  } else if (typeof obj.instructedAmount !== 'object' || obj.instructedAmount === null) {
    errors.push({
      index,
      type,
      code: 'invalid_field_type',
      message: '"instructedAmount" must be an object',
      field: 'instructedAmount',
    });
  } else {
    const amount = obj.instructedAmount as Record<string, unknown>;
    if (typeof amount.currency !== 'string' || amount.currency.length !== 3) {
      errors.push({
        index,
        type,
        code: 'invalid_field_value',
        message: '"instructedAmount.currency" must be a 3-letter ISO 4217 code',
        field: 'instructedAmount.currency',
      });
    }
    if (typeof amount.amount !== 'string' || !/^\d+(\.\d{1,2})?$/.test(amount.amount)) {
      errors.push({
        index,
        type,
        code: 'invalid_field_value',
        message: '"instructedAmount.amount" must be a decimal string',
        field: 'instructedAmount.amount',
      });
    }
  }

  // Required: creditorAccount
  if (!obj.creditorAccount) {
    errors.push({
      index,
      type,
      code: 'missing_required_field',
      message: 'payment_initiation requires "creditorAccount" field',
      field: 'creditorAccount',
    });
  } else if (typeof obj.creditorAccount !== 'object' || obj.creditorAccount === null) {
    errors.push({
      index,
      type,
      code: 'invalid_field_type',
      message: '"creditorAccount" must be an object',
      field: 'creditorAccount',
    });
  } else {
    const account = obj.creditorAccount as Record<string, unknown>;
    if (!account.iban && !account.bban) {
      errors.push({
        index,
        type,
        code: 'invalid_field_value',
        message: '"creditorAccount" must have either "iban" or "bban"',
        field: 'creditorAccount',
      });
    }
  }

  if (errors.length > 0) {
    return { errors };
  }

  if (sanitize) {
    const sanitized: PaymentInitiationDetail = {
      type: 'payment_initiation',
      instructedAmount: obj.instructedAmount as PaymentInitiationDetail['instructedAmount'],
      creditorAccount: obj.creditorAccount as PaymentInitiationDetail['creditorAccount'],
    };

    if (obj.creditorName) {
      sanitized.creditorName = obj.creditorName as string;
    }
    if (obj.remittanceInformationUnstructured) {
      sanitized.remittanceInformationUnstructured = obj.remittanceInformationUnstructured as string;
    }

    copyBaseFields(obj, sanitized);

    return { errors: [], sanitized };
  }

  return { errors: [], sanitized: obj as PaymentInitiationDetail };
}

/**
 * Validate account_information type
 */
function validateAccountInformation(
  obj: Record<string, unknown>,
  index: number,
  sanitize: boolean
): TypeValidationResult {
  const errors: RARValidationError[] = [];
  const type = 'account_information';

  // Required: actions
  if (!obj.actions) {
    errors.push({
      index,
      type,
      code: 'missing_required_field',
      message: 'account_information requires "actions" field',
      field: 'actions',
    });
  } else if (!Array.isArray(obj.actions)) {
    errors.push({
      index,
      type,
      code: 'invalid_field_type',
      message: '"actions" must be an array',
      field: 'actions',
    });
  } else if (obj.actions.length === 0) {
    errors.push({
      index,
      type,
      code: 'invalid_field_value',
      message: '"actions" array cannot be empty',
      field: 'actions',
    });
  } else {
    const validActions = ['read', 'write'];
    for (const action of obj.actions) {
      if (!validActions.includes(action as string)) {
        errors.push({
          index,
          type,
          code: 'invalid_field_value',
          message: `Invalid action: "${action}". Must be one of: ${validActions.join(', ')}`,
          field: 'actions',
        });
      }
    }
  }

  if (errors.length > 0) {
    return { errors };
  }

  if (sanitize) {
    const sanitized: AccountInformationDetail = {
      type: 'account_information',
      actions: obj.actions as ('read' | 'write')[],
    };

    if (obj.datatypes) {
      sanitized.datatypes = obj.datatypes as AccountInformationDetail['datatypes'];
    }

    copyBaseFields(obj, sanitized);

    return { errors: [], sanitized };
  }

  return { errors: [], sanitized: obj as AccountInformationDetail };
}

/**
 * Validate unknown type (base validation only)
 */
function validateUnknownType(
  obj: Record<string, unknown>,
  index: number,
  sanitize: boolean
): TypeValidationResult {
  const errors: RARValidationError[] = [];
  const warnings: RARValidationError[] = [];

  // Warn about unknown type
  warnings.push({
    index,
    type: obj.type as string,
    code: 'validation_error',
    message: `Unknown authorization_details type: "${obj.type}". Passing through without type-specific validation.`,
  });

  // Validate standard base fields if present
  if (obj.locations !== undefined && !Array.isArray(obj.locations)) {
    errors.push({
      index,
      type: obj.type as string,
      code: 'invalid_field_type',
      message: '"locations" must be an array',
      field: 'locations',
    });
  }

  if (obj.actions !== undefined && !Array.isArray(obj.actions)) {
    errors.push({
      index,
      type: obj.type as string,
      code: 'invalid_field_type',
      message: '"actions" must be an array',
      field: 'actions',
    });
  }

  if (obj.datatypes !== undefined && !Array.isArray(obj.datatypes)) {
    errors.push({
      index,
      type: obj.type as string,
      code: 'invalid_field_type',
      message: '"datatypes" must be an array',
      field: 'datatypes',
    });
  }

  if (obj.privileges !== undefined && !Array.isArray(obj.privileges)) {
    errors.push({
      index,
      type: obj.type as string,
      code: 'invalid_field_type',
      message: '"privileges" must be an array',
      field: 'privileges',
    });
  }

  if (obj.identifier !== undefined && typeof obj.identifier !== 'string') {
    errors.push({
      index,
      type: obj.type as string,
      code: 'invalid_field_type',
      message: '"identifier" must be a string',
      field: 'identifier',
    });
  }

  if (errors.length > 0) {
    return { errors, warnings };
  }

  // For unknown types, always pass through as-is
  return {
    errors: [],
    warnings,
    sanitized: obj as AuthorizationDetailsBase,
  };
}

/**
 * Copy standard base fields to sanitized object
 */
function copyBaseFields(source: Record<string, unknown>, target: AuthorizationDetailsBase): void {
  if (source.locations) {
    target.locations = source.locations as string[];
  }
  if (source.actions) {
    target.actions = source.actions as string[];
  }
  if (source.datatypes) {
    target.datatypes = source.datatypes as string[];
  }
  if (source.identifier) {
    target.identifier = source.identifier as string;
  }
  if (source.privileges) {
    target.privileges = source.privileges as string[];
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Parse authorization_details from string
 *
 * @param input - JSON string
 * @returns Parsed array or null if invalid
 */
export function parseAuthorizationDetails(input: string): AuthorizationDetails[] | null {
  const result = validateAuthorizationDetails(input);
  return result.valid ? (result.sanitized ?? null) : null;
}

/**
 * Stringify authorization_details for storage
 *
 * @param details - Authorization details array
 * @returns JSON string
 */
export function stringifyAuthorizationDetails(details: AuthorizationDetails[]): string {
  return JSON.stringify(details);
}

/**
 * Check if authorization_details contains a specific type
 *
 * @param details - Authorization details array
 * @param type - Type to check for
 * @returns true if type is present
 */
export function hasAuthorizationDetailsType(
  details: AuthorizationDetails[],
  type: string
): boolean {
  return details.some((d) => d.type === type);
}

/**
 * Extract authorization_details of a specific type
 *
 * @param details - Authorization details array
 * @param type - Type to extract
 * @returns Filtered array
 */
export function getAuthorizationDetailsByType<T extends AuthorizationDetails>(
  details: AuthorizationDetails[],
  type: string
): T[] {
  return details.filter((d) => d.type === type) as T[];
}
