/**
 * Custom Claim Schemas Admin API Endpoints
 *
 * Management endpoints for custom claim schema definitions:
 * - List, create, update, delete custom claim schemas
 * - Rename field_key (2-phase with read consistency)
 * - Retry failed operations
 * - Reserved OIDC claim names
 * - Statistics with KV caching
 *
 * All endpoints require admin authentication via adminAuthMiddleware()
 */

import { Context } from 'hono';
import type { Env, AdminAuthContext } from '@authrim/ar-lib-core';
import {
  createAuthContextFromHono,
  getTenantIdFromContext,
  type DatabaseAdapter,
  ensureDatabaseAdapter,
  createErrorResponse,
  AR_ERROR_CODES,
  generateId,
  getLogger,
  createAuditLogFromContext,
  SchemaLoader,
  CustomClaimSchemaHistoryManager,
  listCustomClaimSchemas,
  getCustomClaimSchemaById,
  findActiveCustomClaimSchemaByFieldKey,
  insertCustomClaimSchema,
  updateCustomClaimSchemaFields,
  deleteCustomClaimSchemaById,
  getRequiredCustomClaimViolationStatuses,
  countUsersWithNonPiiCustomClaimData,
  countUsersWithPiiCustomClaimData,
  listNonPiiFieldUsage,
  countUsersWithNonPiiFieldData,
  deleteStoredCustomClaimData,
  renameStoredCustomClaimData,
  resolveCustomClaimRuntimeSourcesFromEnv,
  CanonicalRuntimeUserStore,
} from '@authrim/ar-lib-core';
import { seedDefaultClaimsForTenant } from './admin-tenants';

/**
 * Hono context type with admin auth variable
 */
type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

/**
 * Base context type for utility functions
 */
type BaseContext = Context<{ Bindings: Env }>;

/**
 * Cast AdminContext to BaseContext
 */
function asBaseContext(c: AdminContext): BaseContext {
  return c as unknown as BaseContext;
}

/**
 * Create database adapter from context.
 * The route still receives raw Worker bindings, but the custom-claims layer
 * now normalizes them through DatabaseAdapter instead of depending on D1 APIs.
 */
function createAdapterFromContext(c: AdminContext): DatabaseAdapter {
  const tenantId = getTenantIdFromContext(asBaseContext(c));
  return createAuthContextFromHono(asBaseContext(c), tenantId).coreAdapter;
}

function createHistoryManagerFromContext(c: AdminContext): CustomClaimSchemaHistoryManager {
  return new CustomClaimSchemaHistoryManager(createAdapterFromContext(c));
}

async function resolveCustomClaimStorageSources(c: AdminContext, tenantId: string) {
  return resolveCustomClaimRuntimeSourcesFromEnv(c.env, tenantId);
}

// =============================================================================
// Constants
// =============================================================================

/** Reserved OIDC claim names that cannot be used as field_key */
const RESERVED_CLAIM_NAMES = new Set([
  'sub',
  'iss',
  'aud',
  'exp',
  'iat',
  'jti',
  'nbf',
  'auth_time',
  'nonce',
  'at_hash',
  'c_hash',
  'acr',
  'amr',
  'azp',
  // Standard OIDC claims
  'name',
  'given_name',
  'family_name',
  'middle_name',
  'nickname',
  'preferred_username',
  'profile',
  'picture',
  'website',
  'email',
  'email_verified',
  'gender',
  'birthdate',
  'zoneinfo',
  'locale',
  'phone_number',
  'phone_number_verified',
  'address',
  'updated_at',
  // Address sub-field system claims (stored as individual columns, not JSON)
  'address_formatted',
  'address_street_address',
  'address_locality',
  'address_region',
  'address_postal_code',
  'address_country',
]);

/** Valid field types */
const VALID_FIELD_TYPES = ['string', 'number', 'boolean', 'date', 'enum'] as const;
type FieldType = (typeof VALID_FIELD_TYPES)[number];

/** field_key pattern: snake_case, starts with letter, max 64 chars */
const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** Stats KV cache key prefix */
const STATS_CACHE_PREFIX = 'custom_claim_stats:';

/** Stats cache TTL in seconds */
const STATS_CACHE_TTL = 300; // 5 minutes

/** Valid operation statuses for filtering */
const VALID_OPERATION_STATUSES = new Set(['active', 'deleting', 'renaming', 'error']);

/** Batch size for PII user data operations */
const PII_BATCH_SIZE = 500;

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Check if a regex pattern is safe from ReDoS.
 * Rejects nested quantifiers and other potentially catastrophic patterns.
 */
function isSafeRegex(pattern: string): boolean {
  if (pattern.length > 128) return false;
  // Detect nested quantifiers in capturing groups: (a+)+, (a*)*
  if (/\([^)]*[+*][^)]*\)[+*?{]/.test(pattern)) return false;
  // Detect nested quantifiers in non-capturing groups: (?:a+)+
  if (/\(\?:[^)]*[+*][^)]*\)[+*?{]/.test(pattern)) return false;
  // Detect overlapping alternation with quantifiers: (a|a)+
  if (/\([^)]*\|[^)]*\)[+*{]/.test(pattern)) return false;
  // Detect adjacent quantifiers: a**,  a++, a+*
  // Note: ] is excluded because it ends a character class (e.g. [a-z]+)
  if (/[+*?}]\s*[+*{]/.test(pattern)) return false;
  // Try to compile the regex
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate validation_rules based on field_type
 */
function validateValidationRules(
  fieldType: FieldType,
  rules: unknown
): { valid: boolean; error?: string } {
  if (rules === null || rules === undefined) return { valid: true };
  if (typeof rules !== 'object' || Array.isArray(rules)) {
    return { valid: false, error: 'validation_rules must be an object' };
  }
  const r = rules as Record<string, unknown>;

  switch (fieldType) {
    case 'string': {
      const allowed = new Set(['min_length', 'max_length', 'pattern']);
      for (const key of Object.keys(r)) {
        if (!allowed.has(key))
          return { valid: false, error: `Unknown string validation key: ${key}` };
      }
      if (r.min_length !== undefined && (typeof r.min_length !== 'number' || r.min_length < 0))
        return { valid: false, error: 'min_length must be a non-negative number' };
      if (r.max_length !== undefined && (typeof r.max_length !== 'number' || r.max_length < 1))
        return { valid: false, error: 'max_length must be a positive number' };
      if (
        r.min_length !== undefined &&
        r.max_length !== undefined &&
        (r.min_length as number) > (r.max_length as number)
      )
        return { valid: false, error: 'min_length cannot exceed max_length' };
      if (r.pattern !== undefined) {
        if (typeof r.pattern !== 'string')
          return { valid: false, error: 'pattern must be a string' };
        if (!isSafeRegex(r.pattern))
          return {
            valid: false,
            error:
              'pattern is invalid or potentially unsafe (max 128 chars, no nested quantifiers)',
          };
      }
      return { valid: true };
    }
    case 'number': {
      const allowed = new Set(['min', 'max']);
      for (const key of Object.keys(r)) {
        if (!allowed.has(key))
          return { valid: false, error: `Unknown number validation key: ${key}` };
      }
      if (r.min !== undefined && typeof r.min !== 'number')
        return { valid: false, error: 'min must be a number' };
      if (r.max !== undefined && typeof r.max !== 'number')
        return { valid: false, error: 'max must be a number' };
      if (r.min !== undefined && r.max !== undefined && (r.min as number) > (r.max as number))
        return { valid: false, error: 'min cannot exceed max' };
      return { valid: true };
    }
    case 'enum': {
      const allowed = new Set(['enum_values']);
      for (const key of Object.keys(r)) {
        if (!allowed.has(key))
          return { valid: false, error: `Unknown enum validation key: ${key}` };
      }
      if (!Array.isArray(r.enum_values) || r.enum_values.length === 0)
        return { valid: false, error: 'enum_values must be a non-empty array' };
      if (r.enum_values.length > 100)
        return { valid: false, error: 'enum_values must have at most 100 items' };
      if (!r.enum_values.every((v: unknown) => typeof v === 'string'))
        return { valid: false, error: 'enum_values must contain only strings' };
      return { valid: true };
    }
    case 'date': {
      const allowed = new Set(['min_date', 'max_date']);
      for (const key of Object.keys(r)) {
        if (!allowed.has(key))
          return { valid: false, error: `Unknown date validation key: ${key}` };
      }
      if (r.min_date !== undefined && typeof r.min_date !== 'string')
        return { valid: false, error: 'min_date must be a string (ISO 8601)' };
      if (r.max_date !== undefined && typeof r.max_date !== 'string')
        return { valid: false, error: 'max_date must be a string (ISO 8601)' };
      return { valid: true };
    }
    case 'boolean':
      if (Object.keys(r).length > 0)
        return { valid: false, error: 'boolean type does not support validation rules' };
      return { valid: true };
    default:
      return { valid: false, error: `Unknown field type: ${fieldType}` };
  }
}

/**
 * Normalize claim_namespace: validate URL scheme, ensure trailing '/', remove double slashes
 */
function normalizeNamespace(
  ns: string | null | undefined
): { valid: true; value: string | null } | { valid: false; error: string } {
  if (!ns) return { valid: true, value: null };
  let result = ns.trim();
  if (!result) return { valid: true, value: null };
  if (result.length > 255) {
    return { valid: false, error: 'claim_namespace must be at most 255 characters' };
  }
  // Must start with http:// or https://
  if (!/^https?:\/\//.test(result)) {
    return { valid: false, error: 'claim_namespace must start with http:// or https://' };
  }
  // Remove trailing double slashes, then ensure single trailing slash
  result = result.replace(/\/+$/, '') + '/';
  return { valid: true, value: result };
}

/**
 * Invalidate stats cache for a tenant
 */
async function invalidateStatsCache(c: AdminContext, tenantId: string): Promise<void> {
  try {
    const kv = c.env.SETTINGS || c.env.AUTHRIM_CONFIG;
    if (kv) {
      await kv.delete(`${STATS_CACHE_PREFIX}${tenantId}`);
    }
  } catch {
    // Cache invalidation failure is non-critical
  }
}

/**
 * Invalidate the schema resolver KV cache after CUD operations
 */
async function invalidateSchemaCache(c: AdminContext, tenantId: string): Promise<void> {
  try {
    const kv = c.env.AUTHRIM_CONFIG || null;
    if (kv) {
      const loader = new SchemaLoader(createAdapterFromContext(c), kv);
      await loader.invalidateCache(tenantId);
    }
  } catch {
    // Cache invalidation failure is non-critical
  }
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * GET /api/admin/custom-claims
 * List custom claim schemas with filtering and pagination
 */
export async function adminCustomClaimsListHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const page = parseInt(c.req.query('page') || '1');
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
    const offset = (page - 1) * limit;

    // Filter parameters
    const search = c.req.query('search');
    const fieldType = c.req.query('field_type');
    const isPii = c.req.query('is_pii');
    const isActive = c.req.query('is_active');
    const isSystem = c.req.query('is_system');
    const operationStatus = c.req.query('operation_status');
    const hasFilters = Boolean(
      search || fieldType || isPii || isActive || isSystem || operationStatus
    );

    let { schemas, total } = await listCustomClaimSchemas(adapter, {
      tenantId,
      search,
      fieldType: fieldType && VALID_FIELD_TYPES.includes(fieldType as FieldType) ? fieldType : null,
      isPii: isPii === '0' || isPii === '1' ? parseInt(isPii, 10) : null,
      isActive: isActive === '0' || isActive === '1' ? parseInt(isActive, 10) : null,
      isSystem: isSystem === '0' || isSystem === '1' ? parseInt(isSystem, 10) : null,
      operationStatus:
        operationStatus && VALID_OPERATION_STATUSES.has(operationStatus) ? operationStatus : null,
      limit,
      offset,
    });

    if (!hasFilters && total === 0) {
      await seedDefaultClaimsForTenant(tenantId, adapter, getLogger(asBaseContext(c)), {
        throwOnError: true,
      });
      const seededResult = await listCustomClaimSchemas(adapter, {
        tenantId,
        limit,
        offset,
      });
      schemas = seededResult.schemas;
      total = seededResult.total;
    }

    return c.json({
      schemas,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Failed to list custom claim schemas:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/custom-claims
 * Create a new custom claim schema
 */
export async function adminCustomClaimCreateHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const body = await c.req.json();
    const showOnRegistration = !!body.show_on_registration;
    const registrationRequired = showOnRegistration && !!body.registration_required;

    // Validate required fields
    const { field_key, display_label, field_type = 'string' } = body;

    if (!field_key || typeof field_key !== 'string') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: { field: 'field_key', reason: 'field_key is required' },
      });
    }

    if (!FIELD_KEY_PATTERN.test(field_key)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: {
          field: 'field_key',
          reason: 'Must be snake_case, start with a letter, and be at most 64 characters',
        },
      });
    }

    if (RESERVED_CLAIM_NAMES.has(field_key)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: {
          field: 'field_key',
          reason: `'${field_key}' is a reserved OIDC claim name`,
        },
      });
    }

    // Block creating system claims via admin API
    if (body.is_system) {
      return c.json(
        {
          error: 'forbidden',
          error_description: 'System claims can only be created via migration',
        },
        403
      );
    }

    if (!display_label || typeof display_label !== 'string') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: { field: 'display_label', reason: 'display_label is required' },
      });
    }

    if (display_label.length > 255) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: {
          field: 'display_label',
          reason: 'display_label must be at most 255 characters',
        },
      });
    }

    if (body.description !== undefined && body.description !== null) {
      if (typeof body.description !== 'string' || body.description.length > 2000) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
          variables: {
            field: 'description',
            reason: 'description must be a string of at most 2000 characters',
          },
        });
      }
    }

    if (!VALID_FIELD_TYPES.includes(field_type as FieldType)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: {
          field: 'field_type',
          reason: `Must be one of: ${VALID_FIELD_TYPES.join(', ')}`,
        },
      });
    }

    // Validate validation_rules (pre-serialize for size check + reuse)
    let validationRulesJson: string | null = null;
    if (body.validation_rules !== undefined && body.validation_rules !== null) {
      validationRulesJson = JSON.stringify(body.validation_rules);
      if (validationRulesJson.length > 4096) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
          variables: {
            field: 'validation_rules',
            reason: 'validation_rules JSON must be at most 4KB',
          },
        });
      }
      const rulesCheck = validateValidationRules(field_type, body.validation_rules);
      if (!rulesCheck.valid) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
          variables: { field: 'validation_rules', reason: rulesCheck.error! },
        });
      }
    }

    // Validate required_scopes
    let requiredScopesJson: string | null = null;
    if (body.required_scopes !== undefined && body.required_scopes !== null) {
      if (!Array.isArray(body.required_scopes)) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
          variables: { field: 'required_scopes', reason: 'Must be an array of strings' },
        });
      }
      if (body.required_scopes.length > 50) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
          variables: {
            field: 'required_scopes',
            reason: 'required_scopes must have at most 50 items',
          },
        });
      }
      if (!body.required_scopes.every((s: unknown) => typeof s === 'string' && s.length > 0)) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
          variables: {
            field: 'required_scopes',
            reason: 'Each scope must be a non-empty string',
          },
        });
      }
      requiredScopesJson = JSON.stringify(body.required_scopes);
    }

    // Validate scope_mode
    const scopeMode = body.scope_mode || 'any';
    if (scopeMode !== 'all' && scopeMode !== 'any') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: { field: 'scope_mode', reason: "Must be 'all' or 'any'" },
      });
    }

    // Validate claim_namespace
    let claimNamespaceValue: string | null = null;
    if (body.claim_namespace !== undefined && body.claim_namespace !== null) {
      const nsResult = normalizeNamespace(body.claim_namespace);
      if (!nsResult.valid) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
          variables: { field: 'claim_namespace', reason: nsResult.error },
        });
      }
      claimNamespaceValue = nsResult.value;
    }

    // Check for duplicate active field_key
    const existing = await findActiveCustomClaimSchemaByFieldKey(adapter, tenantId, field_key);
    if (existing) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: {
          field: 'field_key',
          reason: `An active schema with field_key '${field_key}' already exists`,
        },
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const id = generateId();
    const adminAuth = c.get('adminAuth');
    const createdBy = adminAuth?.userId || null;

    await insertCustomClaimSchema(adapter, {
      id,
      tenant_id: tenantId,
      field_key,
      display_label,
      field_type,
      is_pii: body.is_pii ? 1 : 0,
      is_required: body.is_required ? 1 : 0,
      is_active: 1,
      validation_rules: validationRulesJson,
      include_in_id_token: body.include_in_id_token ? 1 : 0,
      include_in_userinfo: body.include_in_userinfo ? 1 : 0,
      include_in_introspection: body.include_in_introspection ? 1 : 0,
      required_scopes: requiredScopesJson,
      scope_mode: scopeMode,
      is_searchable: body.is_searchable !== false ? 1 : 0,
      is_exportable: body.is_exportable !== false ? 1 : 0,
      is_vc_claim: body.is_vc_claim ? 1 : 0,
      claim_namespace: claimNamespaceValue,
      description: body.description || null,
      display_order: body.display_order ?? 100,
      schema_version: 1,
      operation_status: 'active',
      created_by: createdBy,
      created_at: now,
      updated_at: now,
      show_on_registration: showOnRegistration ? 1 : 0,
      registration_required: registrationRequired ? 1 : 0,
      registration_order: body.registration_order || 0,
      registration_placeholder: body.registration_placeholder || null,
    });

    // Fetch created schema
    const created = await getCustomClaimSchemaById(adapter, tenantId, id);

    await createAuditLogFromContext(asBaseContext(c), 'create', 'custom_claim_schema', id, {
      field_key,
      field_type,
      is_pii: body.is_pii ? 1 : 0,
    });

    // Record history
    try {
      const historyManager = createHistoryManagerFromContext(c);
      const adminAuth = c.get('adminAuth');
      await historyManager.recordChange({
        schemaId: id,
        tenantId,
        operation: 'create',
        previousSnapshot: null,
        newSnapshot: created as Record<string, unknown>,
        actorId: adminAuth?.userId,
        actorType: 'admin',
        changeSource: 'admin_api',
      });
    } catch {
      // History recording failure is non-critical
    }

    await invalidateStatsCache(c, tenantId);
    await invalidateSchemaCache(c, tenantId);

    return c.json({ schema: created }, 201);
  } catch (error) {
    console.error('Failed to create custom claim schema:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * GET /api/admin/custom-claims/reserved-names
 * Return list of reserved OIDC claim names
 */
export async function adminCustomClaimsReservedNamesHandler(c: AdminContext) {
  return c.json({
    reserved_names: Array.from(RESERVED_CLAIM_NAMES).sort(),
  });
}

/**
 * GET /api/admin/custom-claims/stats
 * Custom claims statistics with KV caching
 */
export async function adminCustomClaimsStatsHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const storageSources = await resolveCustomClaimStorageSources(c, tenantId);

    // Check KV cache
    const kv = c.env.SETTINGS || c.env.AUTHRIM_CONFIG;
    if (kv) {
      const cached = await kv.get(`${STATS_CACHE_PREFIX}${tenantId}`);
      if (cached) {
        try {
          return c.json(JSON.parse(cached));
        } catch {
          // Corrupted cache - delete and regenerate
          await kv.delete(`${STATS_CACHE_PREFIX}${tenantId}`);
        }
      }
    }

    // Total schemas
    const totalResult = await adapter.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM custom_claim_schemas WHERE tenant_id = ?',
      [tenantId]
    );

    // Non-PII count
    const nonPiiResult = await adapter.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM custom_claim_schemas WHERE tenant_id = ? AND is_pii = 0 AND is_active = 1',
      [tenantId]
    );

    // PII count
    const piiResult = await adapter.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM custom_claim_schemas WHERE tenant_id = ? AND is_pii = 1 AND is_active = 1',
      [tenantId]
    );

    // Non-PII user data count (from user_custom_fields)
    const nonPiiUserCount = await countUsersWithNonPiiCustomClaimData(
      storageSources.nonPiiDb,
      tenantId
    );

    // PII approximate count (users with any custom PII data)
    let piiUserCount = 0;
    try {
      piiUserCount = storageSources.piiDb
        ? await countUsersWithPiiCustomClaimData(storageSources.piiDb, tenantId)
        : 0;
    } catch {
      // PII DB may not be accessible
      piiUserCount = -1;
    }

    // Per-field usage for non-PII
    const fieldUsage = await listNonPiiFieldUsage(storageSources.nonPiiDb, tenantId);

    // Error state count
    const errorResult = await adapter.query<{ count: number }>(
      "SELECT COUNT(*) as count FROM custom_claim_schemas WHERE tenant_id = ? AND operation_status = 'error'",
      [tenantId]
    );

    const stats = {
      total: totalResult[0]?.count || 0,
      active_non_pii: nonPiiResult[0]?.count || 0,
      active_pii: piiResult[0]?.count || 0,
      non_pii_users_with_data: nonPiiUserCount,
      pii_users_with_data: piiUserCount,
      pii_users_approximate: true,
      field_usage: fieldUsage.map((row: { fieldName: string; count: number }) => ({
        field_name: row.fieldName,
        count: row.count,
      })),
      error_count: errorResult[0]?.count || 0,
    };

    // Cache in KV
    if (kv) {
      try {
        await kv.put(`${STATS_CACHE_PREFIX}${tenantId}`, JSON.stringify(stats), {
          expirationTtl: STATS_CACHE_TTL,
        });
      } catch {
        // Cache write failure is non-critical
      }
    }

    return c.json(stats);
  } catch (error) {
    console.error('Failed to get custom claim stats:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/custom-claims/required-violations/detect
 * Re-scan active users for required custom-claim violations and refresh lifecycle_state.
 *
 * This is intentionally server-side because required fields may span Core + PII storage.
 * Admin UI should call this action, then use users list filtering on lifecycle_state=incomplete.
 */
export async function adminCustomClaimRequiredViolationsDetectHandler(c: AdminContext) {
  try {
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const adapter = createAdapterFromContext(c);
    const storageSources = await resolveCustomClaimStorageSources(c, tenantId);
    const previewLimit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')));
    const userRows = await adapter.query<{
      id: string;
    }>(
      `SELECT legacy_user_id as id
       FROM identity_accounts
       WHERE tenant_id = ?
         AND lifecycle_state = 'active'
         AND legacy_user_id IS NOT NULL
       ORDER BY created_at DESC`,
      [tenantId]
    );

    if (userRows.length === 0) {
      return c.json({
        summary: {
          scanned_users: 0,
          violating_users: 0,
          required_schema_count: 0,
          preview_limit: previewLimit,
        },
        violations: [],
        truncated: false,
      });
    }

    const violationStatuses = await getRequiredCustomClaimViolationStatuses({
      db: storageSources.nonPiiDb,
      schemaDb: adapter,
      stateDb: adapter,
      dbPii: storageSources.piiDb,
      cache: c.env.SETTINGS || c.env.AUTHRIM_CONFIG || null,
      tenantId,
      userIds: userRows.map((row) => row.id),
      syncLifecycleState: true,
    });

    const violatingUsers = violationStatuses.users.filter(
      (user) => user.missingRequiredFields.length > 0
    );
    const previewUsers = violatingUsers.slice(0, previewLimit);
    const previewPiiMap = new Map<string, { email: string | null; name: string | null }>();

    if (previewUsers.length > 0 && storageSources.piiDb) {
      const runtimeUsers = new CanonicalRuntimeUserStore({
        coreAdapter: adapter,
        piiAdapter: ensureDatabaseAdapter(
          storageSources.piiDb,
          'custom-claims-required-violations-preview-pii'
        ),
        tenantId,
      });
      await Promise.all(
        previewUsers.map(async (user) => {
          const runtimeUser = await runtimeUsers.findById(user.userId, { includeInactive: true });
          if (runtimeUser) {
            previewPiiMap.set(user.userId, {
              email: runtimeUser.email,
              name: runtimeUser.name,
            });
          }
        })
      );
    }

    return c.json({
      summary: {
        scanned_users: userRows.length,
        violating_users: violatingUsers.length,
        required_schema_count: violationStatuses.requiredSchemaCount,
        preview_limit: previewLimit,
      },
      violations: previewUsers.map((user) => ({
        user_id: user.userId,
        email: previewPiiMap.get(user.userId)?.email ?? null,
        name: previewPiiMap.get(user.userId)?.name ?? null,
        lifecycle_state: user.lifecycleState,
        missing_required_fields: user.missingRequiredFields.map((field) => ({
          field_key: field.fieldKey,
          label: field.label,
          field_type: field.fieldType,
        })),
      })),
      truncated: violatingUsers.length > previewLimit,
    });
  } catch (error) {
    console.error('Failed to detect required custom-claim violations:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * GET /api/admin/custom-claims/:id
 * Get a single custom claim schema
 */
export async function adminCustomClaimGetHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const id = c.req.param('id')!;
    const storageSources = await resolveCustomClaimStorageSources(c, tenantId);

    const schema = await getCustomClaimSchemaById(adapter, tenantId, id);

    if (!schema) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Get user count for this field
    let userCount = 0;

    if (schema.is_pii) {
      // PII: approximate count
      try {
        userCount = storageSources.piiDb
          ? await countUsersWithPiiCustomClaimData(storageSources.piiDb, tenantId)
          : 0;
      } catch {
        userCount = -1;
      }
    } else {
      userCount = await countUsersWithNonPiiFieldData(
        storageSources.nonPiiDb,
        tenantId,
        schema.field_key as string
      );
    }

    return c.json({
      schema,
      user_count: userCount,
      user_count_approximate: !!schema.is_pii,
    });
  } catch (error) {
    console.error('Failed to get custom claim schema:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * PUT /api/admin/custom-claims/:id
 * Update a custom claim schema (is_pii and field_key are immutable)
 */
export async function adminCustomClaimUpdateHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const id = c.req.param('id')!;
    const body = await c.req.json();

    // Fetch existing
    const schema = await getCustomClaimSchemaById<Record<string, unknown>>(adapter, tenantId, id);

    if (!schema) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Block updates during operations
    if (schema.operation_status !== 'active') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: {
          field: 'operation_status',
          reason: 'Schema is currently being modified. Wait for the operation to complete.',
        },
      });
    }

    // Block protected field changes for system claims
    if (schema.is_system === 1) {
      const protectedFields = ['field_key', 'field_type', 'is_pii'];
      for (const f of protectedFields) {
        if (body[f] !== undefined && body[f] !== schema[f]) {
          return c.json(
            { error: 'forbidden', error_description: `Cannot modify ${f} on system claims` },
            403
          );
        }
      }
    }

    // Block changing is_system via admin API
    if (body.is_system !== undefined) {
      return c.json(
        { error: 'forbidden', error_description: 'is_system flag cannot be changed via admin API' },
        403
      );
    }

    // Reject is_pii changes
    if (body.is_pii !== undefined && (body.is_pii ? 1 : 0) !== schema.is_pii) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: {
          field: 'is_pii',
          reason:
            'PII classification cannot be changed after creation. Delete and recreate the schema.',
        },
      });
    }

    // Reject field_key changes (use rename endpoint instead)
    if (body.field_key !== undefined && body.field_key !== schema.field_key) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: {
          field: 'field_key',
          reason: 'Use PATCH /api/admin/custom-claims/:id/rename to change the field_key',
        },
      });
    }

    // Validate display_label length
    if (body.display_label !== undefined) {
      if (typeof body.display_label !== 'string' || body.display_label.length === 0) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
          variables: { field: 'display_label', reason: 'display_label must be a non-empty string' },
        });
      }
      if (body.display_label.length > 255) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
          variables: {
            field: 'display_label',
            reason: 'display_label must be at most 255 characters',
          },
        });
      }
    }

    // Validate description length
    if (body.description !== undefined && body.description !== null) {
      if (typeof body.description !== 'string' || body.description.length > 2000) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
          variables: {
            field: 'description',
            reason: 'description must be a string of at most 2000 characters',
          },
        });
      }
    }

    // Validate field_type if changed
    const fieldType = body.field_type || (schema.field_type as string);
    if (body.field_type && !VALID_FIELD_TYPES.includes(body.field_type as FieldType)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: {
          field: 'field_type',
          reason: `Must be one of: ${VALID_FIELD_TYPES.join(', ')}`,
        },
      });
    }

    // Validate validation_rules (pre-serialize for size check + reuse)
    const validationRules = body.validation_rules !== undefined ? body.validation_rules : undefined;
    let validationRulesJson: string | null | undefined;
    if (validationRules !== undefined && validationRules !== null) {
      validationRulesJson = JSON.stringify(validationRules);
      if (validationRulesJson.length > 4096) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
          variables: {
            field: 'validation_rules',
            reason: 'validation_rules JSON must be at most 4KB',
          },
        });
      }
      const rulesCheck = validateValidationRules(fieldType as FieldType, validationRules);
      if (!rulesCheck.valid) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
          variables: { field: 'validation_rules', reason: rulesCheck.error! },
        });
      }
    } else if (validationRules === null) {
      validationRulesJson = null;
    }

    // Validate required_scopes (pre-serialize for reuse)
    let requiredScopesJson: string | null | undefined;
    if (body.required_scopes !== undefined && body.required_scopes !== null) {
      if (!Array.isArray(body.required_scopes)) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
          variables: { field: 'required_scopes', reason: 'Must be an array of strings' },
        });
      }
      if (body.required_scopes.length > 50) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
          variables: {
            field: 'required_scopes',
            reason: 'required_scopes must have at most 50 items',
          },
        });
      }
      if (!body.required_scopes.every((s: unknown) => typeof s === 'string' && s.length > 0)) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
          variables: {
            field: 'required_scopes',
            reason: 'Each scope must be a non-empty string',
          },
        });
      }
      requiredScopesJson = JSON.stringify(body.required_scopes);
    } else if (body.required_scopes === null) {
      requiredScopesJson = null;
    }

    // Validate scope_mode
    if (body.scope_mode !== undefined && body.scope_mode !== 'all' && body.scope_mode !== 'any') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: { field: 'scope_mode', reason: "Must be 'all' or 'any'" },
      });
    }

    const effectiveShowOnRegistration =
      body.show_on_registration !== undefined
        ? !!body.show_on_registration
        : schema.show_on_registration === 1;
    if (
      (body.show_on_registration !== undefined || body.registration_required !== undefined) &&
      !effectiveShowOnRegistration
    ) {
      body.registration_required = false;
    }

    const now = Math.floor(Date.now() / 1000);

    // Build update fields
    const updates: string[] = [];
    const updateParams: unknown[] = [];

    const updateableFields: Record<string, (v: unknown) => unknown> = {
      display_label: (v) => v,
      field_type: (v) => v,
      is_required: (v) => (v ? 1 : 0),
      is_active: (v) => (v ? 1 : 0),
      include_in_id_token: (v) => (v ? 1 : 0),
      include_in_userinfo: (v) => (v ? 1 : 0),
      include_in_introspection: (v) => (v ? 1 : 0),
      scope_mode: (v) => v,
      is_searchable: (v) => (v ? 1 : 0),
      is_exportable: (v) => (v ? 1 : 0),
      is_vc_claim: (v) => (v ? 1 : 0),
      description: (v) => v || null,
      display_order: (v) => v,
      // Registration form fields (migration 060)
      show_on_registration: (v) => (v ? 1 : 0),
      registration_required: (v) => (v ? 1 : 0),
      registration_order: (v) => v,
      registration_placeholder: (v) => v || null,
    };

    for (const [key, transform] of Object.entries(updateableFields)) {
      if (body[key] !== undefined) {
        updates.push(`${key} = ?`);
        updateParams.push(transform(body[key]));
      }
    }

    // Handle JSON fields separately (reuse pre-serialized values)
    if (validationRulesJson !== undefined) {
      updates.push('validation_rules = ?');
      updateParams.push(validationRulesJson);
    }

    if (requiredScopesJson !== undefined) {
      updates.push('required_scopes = ?');
      updateParams.push(requiredScopesJson);
    }

    if (body.claim_namespace !== undefined) {
      const nsResult = normalizeNamespace(body.claim_namespace);
      if (!nsResult.valid) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
          variables: { field: 'claim_namespace', reason: nsResult.error },
        });
      }
      updates.push('claim_namespace = ?');
      updateParams.push(nsResult.value);
    }

    if (updates.length === 0) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: { field: 'body', reason: 'No valid fields to update' },
      });
    }

    updates.push('updated_at = ?');
    updateParams.push(now);

    await updateCustomClaimSchemaFields({
      db: adapter,
      tenantId,
      schemaId: id,
      updates: Object.fromEntries(
        updates.map((clause, index) => [clause.replace(' = ?', ''), updateParams[index]])
      ),
    });

    // Fetch updated schema
    const updated = await getCustomClaimSchemaById(adapter, tenantId, id);

    await createAuditLogFromContext(asBaseContext(c), 'update', 'custom_claim_schema', id, {
      changes: Object.keys(body).filter((k) => k !== 'is_pii' && k !== 'field_key'),
    });

    // Record history
    try {
      const historyManager = createHistoryManagerFromContext(c);
      const adminAuth = c.get('adminAuth');
      await historyManager.recordChange({
        schemaId: id,
        tenantId,
        operation: 'update',
        previousSnapshot: schema,
        newSnapshot: updated as Record<string, unknown>,
        actorId: adminAuth?.userId,
        actorType: 'admin',
        changeSource: 'admin_api',
      });
    } catch {
      // History recording failure is non-critical
    }

    await invalidateStatsCache(c, tenantId);
    await invalidateSchemaCache(c, tenantId);

    return c.json({ schema: updated });
  } catch (error) {
    console.error('Failed to update custom claim schema:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * DELETE /api/admin/custom-claims/:id
 * Delete a custom claim schema with cascade (2-phase)
 */
export async function adminCustomClaimDeleteHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const id = c.req.param('id')!;
    const storageSources = await resolveCustomClaimStorageSources(c, tenantId);

    // Fetch existing
    const schema = await getCustomClaimSchemaById<Record<string, unknown>>(adapter, tenantId, id);

    if (!schema) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Block deletion of system claims
    if (schema.is_system === 1) {
      return c.json(
        { error: 'forbidden', error_description: 'System claims cannot be deleted' },
        403
      );
    }

    // Block if already in operation
    if (schema.operation_status !== 'active' && schema.operation_status !== 'error') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: {
          field: 'operation_status',
          reason: 'Schema is currently being modified',
        },
      });
    }

    const fieldKey = schema.field_key as string;
    const isPii = schema.is_pii as number;

    // Phase 1: Mark as deleting (CAS: only if still active/error)
    const casRows = await updateCustomClaimSchemaFields({
      db: adapter,
      tenantId,
      schemaId: id,
      updates: {
        operation_status: 'deleting',
        updated_at: Math.floor(Date.now() / 1000),
      },
      allowedCurrentStatuses: ['active', 'error'],
    });
    if (!casRows) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: {
          field: 'operation_status',
          reason: 'Schema state changed concurrently. Please retry.',
        },
      });
    }

    try {
      // Phase 2: Delete user data
      if (isPii) {
        const deleteResult = await deleteStoredCustomClaimData({
          db: storageSources.nonPiiDb,
          dbPii: storageSources.piiDb,
          tenantId,
          fieldKey,
          isPii: true,
          piiBatchSize: PII_BATCH_SIZE,
        });

        if (deleteResult.failedUsers > 0) {
          console.warn(
            `PII delete: ${deleteResult.failedUsers} user(s) failed out of ${deleteResult.processedUsers}`
          );
          // Partial failure - transition to error state instead of deleting schema
          await updateCustomClaimSchemaFields({
            db: adapter,
            tenantId,
            schemaId: id,
            updates: {
              operation_status: 'error',
              operation_detail: JSON.stringify({
                operation: 'delete',
                field_key: fieldKey,
                error: `Partial deletion: ${deleteResult.failedUsers} user(s) failed out of ${deleteResult.processedUsers}`,
                failed_users: deleteResult.failedUsers,
                total_processed: deleteResult.processedUsers,
              }),
              updated_at: Math.floor(Date.now() / 1000),
            },
          });
          await invalidateStatsCache(c, tenantId);
          await invalidateSchemaCache(c, tenantId);
          return c.json(
            {
              success: false,
              error: `Partial deletion: ${deleteResult.failedUsers} user(s) failed. Schema marked as error state for retry.`,
            },
            500
          );
        }
      } else {
        await deleteStoredCustomClaimData({
          db: storageSources.nonPiiDb,
          tenantId,
          fieldKey,
          isPii: false,
        });
      }

      // Phase 3: Delete schema record (only reached on full success)
      await deleteCustomClaimSchemaById(adapter, tenantId, id);

      await createAuditLogFromContext(asBaseContext(c), 'delete', 'custom_claim_schema', id, {
        field_key: fieldKey,
        is_pii: isPii,
      });

      // Record history
      try {
        const historyManager = createHistoryManagerFromContext(c);
        const adminAuth = c.get('adminAuth');
        await historyManager.recordChange({
          schemaId: id,
          tenantId,
          operation: 'delete',
          previousSnapshot: schema as Record<string, unknown>,
          newSnapshot: { deleted: true, field_key: fieldKey },
          actorId: adminAuth?.userId,
          actorType: 'admin',
          changeSource: 'admin_api',
        });
      } catch {
        // History recording failure is non-critical
      }

      await invalidateStatsCache(c, tenantId);
      await invalidateSchemaCache(c, tenantId);

      return c.json({ success: true, deleted_id: id });
    } catch (error) {
      // Operation failed - mark as error
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      await updateCustomClaimSchemaFields({
        db: adapter,
        tenantId,
        schemaId: id,
        updates: {
          operation_status: 'error',
          operation_detail: JSON.stringify({
            operation: 'delete',
            field_key: fieldKey,
            error: errorMsg,
          }),
          updated_at: Math.floor(Date.now() / 1000),
        },
      });
      await invalidateStatsCache(c, tenantId);
      await invalidateSchemaCache(c, tenantId);
      console.error('Failed to cascade delete custom claim schema:', error);
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
  } catch (error) {
    console.error('Failed to delete custom claim schema:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * PATCH /api/admin/custom-claims/:id/rename
 * Rename field_key (2-phase with read consistency)
 */
export async function adminCustomClaimRenameHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const id = c.req.param('id')!;
    const body = await c.req.json();
    const storageSources = await resolveCustomClaimStorageSources(c, tenantId);

    const newKey = body.new_field_key;

    if (!newKey || typeof newKey !== 'string') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: { field: 'new_field_key', reason: 'new_field_key is required' },
      });
    }

    if (!FIELD_KEY_PATTERN.test(newKey)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: {
          field: 'new_field_key',
          reason: 'Must be snake_case, start with a letter, and be at most 64 characters',
        },
      });
    }

    if (RESERVED_CLAIM_NAMES.has(newKey)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: {
          field: 'new_field_key',
          reason: `'${newKey}' is a reserved OIDC claim name`,
        },
      });
    }

    // Fetch existing
    const schema = await getCustomClaimSchemaById<Record<string, unknown>>(adapter, tenantId, id);

    if (!schema) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Block renaming of system claims
    if (schema.is_system === 1) {
      return c.json(
        { error: 'forbidden', error_description: 'System claims cannot be renamed' },
        403
      );
    }

    if (schema.operation_status !== 'active') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: {
          field: 'operation_status',
          reason: 'Schema is currently being modified',
        },
      });
    }

    const oldKey = schema.field_key as string;

    if (oldKey === newKey) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: {
          field: 'new_field_key',
          reason: 'New field_key is the same as current',
        },
      });
    }

    // Check new key doesn't conflict with existing active schemas
    const conflict = await findActiveCustomClaimSchemaByFieldKey(adapter, tenantId, newKey, {
      excludeSchemaId: id,
    });
    if (conflict) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: {
          field: 'new_field_key',
          reason: `An active schema with field_key '${newKey}' already exists`,
        },
      });
    }

    const isPii = schema.is_pii as number;
    const now = Math.floor(Date.now() / 1000);

    // Phase 1: Mark as renaming (CAS: only if still active)
    const casRows = await updateCustomClaimSchemaFields({
      db: adapter,
      tenantId,
      schemaId: id,
      updates: {
        operation_status: 'renaming',
        operation_detail: JSON.stringify({ old_key: oldKey, new_key: newKey }),
        updated_at: now,
      },
      allowedCurrentStatuses: ['active'],
    });
    if (!casRows) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: {
          field: 'operation_status',
          reason: 'Schema state changed concurrently. Please retry.',
        },
      });
    }

    try {
      // Phase 2: Migrate user data
      let affectedUsers = 0;
      let failedPiiUsers = 0;

      if (isPii) {
        const renameResult = await renameStoredCustomClaimData({
          db: storageSources.nonPiiDb,
          dbPii: storageSources.piiDb,
          tenantId,
          oldKey,
          newKey,
          isPii: true,
          updatedAt: now,
          piiBatchSize: PII_BATCH_SIZE,
        });
        affectedUsers = renameResult.affectedUsers;
        failedPiiUsers = renameResult.failedUsers;

        if (failedPiiUsers > 0) {
          console.warn(`PII rename: ${failedPiiUsers} user(s) failed`);
          // Partial failure - transition to error state, keep old field_key for consistency
          await updateCustomClaimSchemaFields({
            db: adapter,
            tenantId,
            schemaId: id,
            updates: {
              operation_status: 'error',
              operation_detail: JSON.stringify({
                operation: 'rename',
                old_key: oldKey,
                new_key: newKey,
                error: `Partial rename: ${failedPiiUsers} user(s) failed`,
              }),
              updated_at: Math.floor(Date.now() / 1000),
            },
          });
          await invalidateStatsCache(c, tenantId);
          await invalidateSchemaCache(c, tenantId);
          return c.json(
            {
              success: false,
              error: `Partial rename: ${failedPiiUsers} user(s) failed. Schema marked as error state for retry.`,
            },
            500
          );
        }
      } else {
        const renameResult = await renameStoredCustomClaimData({
          db: storageSources.nonPiiDb,
          tenantId,
          oldKey,
          newKey,
          isPii: false,
        });
        affectedUsers = renameResult.affectedUsers;
      }

      // Phase 3: Atomic update - switch field_key, increment version, restore status (only on full success)
      await updateCustomClaimSchemaFields({
        db: adapter,
        tenantId,
        schemaId: id,
        updates: {
          field_key: newKey,
          operation_status: 'active',
          operation_detail: null,
          updated_at: Math.floor(Date.now() / 1000),
        },
        allowedCurrentStatuses: ['renaming'],
        incrementSchemaVersion: true,
      });

      await createAuditLogFromContext(asBaseContext(c), 'update', 'custom_claim_schema', id, {
        action: 'rename',
        old_key: oldKey,
        new_key: newKey,
        affected_users: affectedUsers,
      });

      await invalidateStatsCache(c, tenantId);
      await invalidateSchemaCache(c, tenantId);

      // Fetch updated schema
      const updated = await getCustomClaimSchemaById(adapter, tenantId, id);

      // Record history
      try {
        const historyManager = createHistoryManagerFromContext(c);
        const adminAuth = c.get('adminAuth');
        await historyManager.recordChange({
          schemaId: id,
          tenantId,
          operation: 'rename',
          previousSnapshot: schema as Record<string, unknown>,
          newSnapshot: updated as Record<string, unknown>,
          actorId: adminAuth?.userId,
          actorType: 'admin',
          changeSource: 'admin_api',
        });
      } catch {
        // History recording failure is non-critical
      }

      return c.json({
        schema: updated,
        affected_users: affectedUsers,
        old_key: oldKey,
        new_key: newKey,
      });
    } catch (error) {
      // Operation failed - mark as error (field_key remains old_key for read consistency)
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      await updateCustomClaimSchemaFields({
        db: adapter,
        tenantId,
        schemaId: id,
        updates: {
          operation_status: 'error',
          operation_detail: JSON.stringify({
            operation: 'rename',
            old_key: oldKey,
            new_key: newKey,
            error: errorMsg,
          }),
          updated_at: Math.floor(Date.now() / 1000),
        },
      });
      await invalidateStatsCache(c, tenantId);
      await invalidateSchemaCache(c, tenantId);
      console.error('Failed to rename custom claim schema:', error);
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
  } catch (error) {
    console.error('Failed to rename custom claim schema:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/custom-claims/:id/retry
 * Retry a failed operation (error state recovery)
 */
export async function adminCustomClaimRetryHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const id = c.req.param('id')!;
    const storageSources = await resolveCustomClaimStorageSources(c, tenantId);

    // Fetch existing
    const schema = await getCustomClaimSchemaById<Record<string, unknown>>(adapter, tenantId, id);

    if (!schema) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    if (schema.operation_status !== 'error') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: {
          field: 'operation_status',
          reason: 'Only schemas in error state can be retried',
        },
      });
    }

    // Parse operation detail
    let detail: Record<string, unknown> = {};
    try {
      detail = JSON.parse(schema.operation_detail as string);
    } catch {
      // If detail is unparseable, reset to active
      await updateCustomClaimSchemaFields({
        db: adapter,
        tenantId,
        schemaId: id,
        updates: {
          operation_status: 'active',
          operation_detail: null,
          updated_at: Math.floor(Date.now() / 1000),
        },
      });
      await invalidateStatsCache(c, tenantId);
      await invalidateSchemaCache(c, tenantId);
      return c.json({ success: true, action: 'reset_to_active' });
    }

    const operation = detail.operation as string;

    if (operation === 'delete') {
      // Re-run delete by calling the delete handler logic
      // First reset to active, then the user can retry delete
      await updateCustomClaimSchemaFields({
        db: adapter,
        tenantId,
        schemaId: id,
        updates: {
          operation_status: 'active',
          operation_detail: null,
          updated_at: Math.floor(Date.now() / 1000),
        },
      });

      await createAuditLogFromContext(asBaseContext(c), 'update', 'custom_claim_schema', id, {
        action: 'retry_reset',
        original_operation: 'delete',
      });
      await invalidateStatsCache(c, tenantId);
      await invalidateSchemaCache(c, tenantId);

      return c.json({
        success: true,
        action: 'reset_to_active',
        message: 'Schema reset to active state. You can now retry the delete operation.',
      });
    }

    if (operation === 'rename') {
      const oldKey = detail.old_key as string;
      const newKey = detail.new_key as string;

      if (!oldKey || !newKey) {
        await updateCustomClaimSchemaFields({
          db: adapter,
          tenantId,
          schemaId: id,
          updates: {
            operation_status: 'active',
            operation_detail: null,
            updated_at: Math.floor(Date.now() / 1000),
          },
        });
        await invalidateStatsCache(c, tenantId);
        await invalidateSchemaCache(c, tenantId);
        return c.json({ success: true, action: 'reset_to_active' });
      }

      // Re-attempt rename
      const isPii = schema.is_pii as number;
      const now = Math.floor(Date.now() / 1000);

      const retryRows = await updateCustomClaimSchemaFields({
        db: adapter,
        tenantId,
        schemaId: id,
        updates: {
          operation_status: 'renaming',
          updated_at: now,
        },
        allowedCurrentStatuses: ['error'],
      });
      if (!retryRows) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
          variables: {
            field: 'operation_status',
            reason: 'Schema state changed concurrently. Please retry.',
          },
        });
      }

      try {
        let affectedUsers = 0;

        if (isPii) {
          const renameResult = await renameStoredCustomClaimData({
            db: storageSources.nonPiiDb,
            dbPii: storageSources.piiDb,
            tenantId,
            oldKey,
            newKey,
            isPii: true,
            updatedAt: now,
            piiBatchSize: PII_BATCH_SIZE,
          });
          affectedUsers = renameResult.affectedUsers;
          const failedRetryUsers = renameResult.failedUsers;

          if (failedRetryUsers > 0) {
            console.warn(`PII rename retry: ${failedRetryUsers} user(s) failed`);
            // Partial failure - keep error state
            await updateCustomClaimSchemaFields({
              db: adapter,
              tenantId,
              schemaId: id,
              updates: {
                operation_status: 'error',
                operation_detail: JSON.stringify({
                  operation: 'rename',
                  old_key: oldKey,
                  new_key: newKey,
                  error: `Retry partial failure: ${failedRetryUsers} user(s) failed`,
                  retry_failed: true,
                }),
                updated_at: Math.floor(Date.now() / 1000),
              },
            });
            await invalidateStatsCache(c, tenantId);
            await invalidateSchemaCache(c, tenantId);
            return c.json(
              {
                success: false,
                error: `Retry partial failure: ${failedRetryUsers} user(s) failed. Schema remains in error state.`,
              },
              500
            );
          }
        } else {
          // Non-PII: Check remaining records to distinguish "all migrated" from "nothing to do"
          const remainingCount = await countUsersWithNonPiiFieldData(
            storageSources.nonPiiDb,
            tenantId,
            oldKey
          );

          if (remainingCount > 0) {
            const renameResult = await renameStoredCustomClaimData({
              db: storageSources.nonPiiDb,
              tenantId,
              oldKey,
              newKey,
              isPii: false,
              updatedAt: now,
            });
            affectedUsers = renameResult.affectedUsers;
          }
          // remainingCount === 0 means already fully migrated (idempotent success)
        }

        // Atomic update
        await updateCustomClaimSchemaFields({
          db: adapter,
          tenantId,
          schemaId: id,
          updates: {
            field_key: newKey,
            operation_status: 'active',
            operation_detail: null,
            updated_at: Math.floor(Date.now() / 1000),
          },
          allowedCurrentStatuses: ['renaming'],
          incrementSchemaVersion: true,
        });

        await createAuditLogFromContext(asBaseContext(c), 'update', 'custom_claim_schema', id, {
          action: 'retry_rename_success',
          old_key: oldKey,
          new_key: newKey,
          affected_users: affectedUsers,
        });

        await invalidateStatsCache(c, tenantId);
        await invalidateSchemaCache(c, tenantId);

        const updated = await getCustomClaimSchemaById(adapter, tenantId, id);

        try {
          const historyManager = createHistoryManagerFromContext(c);
          const adminAuth = c.get('adminAuth');
          await historyManager.recordChange({
            schemaId: id,
            tenantId,
            operation: 'rename',
            previousSnapshot: schema as Record<string, unknown>,
            newSnapshot: updated as Record<string, unknown>,
            actorId: adminAuth?.userId,
            actorType: 'admin',
            changeSource: 'admin_api',
          });
        } catch {
          // History recording failure is non-critical
        }

        return c.json({
          success: true,
          action: 'rename_completed',
          schema: updated,
          affected_users: affectedUsers,
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        await updateCustomClaimSchemaFields({
          db: adapter,
          tenantId,
          schemaId: id,
          updates: {
            operation_status: 'error',
            operation_detail: JSON.stringify({
              operation: 'rename',
              old_key: oldKey,
              new_key: newKey,
              error: errorMsg,
              retry_failed: true,
            }),
            updated_at: Math.floor(Date.now() / 1000),
          },
        });
        await invalidateStatsCache(c, tenantId);
        await invalidateSchemaCache(c, tenantId);
        console.error('Retry rename failed:', error);
        return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
      }
    }

    // Unknown operation - reset to active
    await updateCustomClaimSchemaFields({
      db: adapter,
      tenantId,
      schemaId: id,
      updates: {
        operation_status: 'active',
        operation_detail: null,
        updated_at: Math.floor(Date.now() / 1000),
      },
    });
    await invalidateStatsCache(c, tenantId);
    await invalidateSchemaCache(c, tenantId);

    return c.json({ success: true, action: 'reset_to_active' });
  } catch (error) {
    console.error('Failed to retry custom claim operation:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// =============================================================================
// History Endpoints
// =============================================================================

/**
 * GET /api/admin/custom-claims/:schemaId/history
 * List version history for a schema
 */
export async function adminCustomClaimHistoryListHandler(c: AdminContext) {
  try {
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const schemaId = c.req.param('schemaId')!;
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
    const offset = parseInt(c.req.query('offset') || '0', 10);

    const historyManager = createHistoryManagerFromContext(c);
    const result = await historyManager.listVersions(tenantId, schemaId, limit, offset);

    return c.json(result);
  } catch (error) {
    console.error('Failed to list schema history:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * GET /api/admin/custom-claims/:schemaId/history/:version
 * Get specific version details
 */
export async function adminCustomClaimHistoryVersionHandler(c: AdminContext) {
  try {
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const schemaId = c.req.param('schemaId')!;
    const version = parseInt(c.req.param('version')!, 10);

    if (!Number.isFinite(version) || version < 1) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: { field: 'version', reason: 'Must be a positive integer' },
      });
    }

    const historyManager = createHistoryManagerFromContext(c);
    const entry = await historyManager.getVersion(tenantId, schemaId, version);

    if (!entry) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    return c.json({ history: entry });
  } catch (error) {
    console.error('Failed to get schema history version:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
