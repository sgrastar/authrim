/**
 * Admin Settings Metadata API Endpoints
 *
 * Settings introspection and comparison:
 * - GET  /api/admin/settings/diff     - Compare settings between versions
 * - GET  /api/admin/settings/schema   - Get settings schema definition
 * - POST /api/admin/settings/validate - Validate settings before applying (Phase 3)
 * - POST /api/admin/tenants/:id/clone - Clone tenant settings (Phase 3)
 *
 * Security:
 * - RBAC: tenant_admin or higher required
 * - Rate limit: moderate profile
 * - Tenant isolation: All queries filtered by tenant_id
 *
 * @packageDocumentation
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  D1Adapter,
  type DatabaseAdapter,
  createErrorResponse,
  AR_ERROR_CODES,
  getTenantIdFromContext,
  createAuditLogFromContext,
  getLogger,
} from '@authrim/ar-lib-core';
import { z } from 'zod';

// =============================================================================
// Constants
// =============================================================================

/**
 * Settings categories
 */
const SETTINGS_CATEGORIES = [
  'oauth',
  'security',
  'session',
  'tokens',
  'federation',
  'mfa',
  'ui',
  'rate_limit',
  'logging',
  'compliance',
] as const;
type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

/**
 * Settings schema definition types
 */
type SettingType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'enum';

interface SettingDefinition {
  name: string;
  type: SettingType;
  description: string;
  default: unknown;
  required: boolean;
  enum_values?: string[];
  min?: number;
  max?: number;
  pattern?: string;
  sensitive?: boolean;
}

interface CategorySchema {
  category: SettingsCategory;
  description: string;
  settings: SettingDefinition[];
}

// =============================================================================
// Settings Schema Definitions
// =============================================================================

/**
 * Complete settings schema definition
 * This defines the structure and validation rules for all settings
 */
const SETTINGS_SCHEMA: CategorySchema[] = [
  {
    category: 'oauth',
    description: 'OAuth 2.0 / OpenID Connect configuration',
    settings: [
      {
        name: 'issuer',
        type: 'string',
        description: 'OIDC Issuer URL',
        default: null,
        required: true,
      },
      {
        name: 'authorization_endpoint',
        type: 'string',
        description: 'Authorization endpoint URL',
        default: '/authorize',
        required: false,
      },
      {
        name: 'token_endpoint',
        type: 'string',
        description: 'Token endpoint URL',
        default: '/token',
        required: false,
      },
      {
        name: 'access_token_lifetime',
        type: 'number',
        description: 'Access token lifetime in seconds',
        default: 3600,
        required: false,
        min: 60,
        max: 86400,
      },
      {
        name: 'refresh_token_lifetime',
        type: 'number',
        description: 'Refresh token lifetime in seconds',
        default: 604800,
        required: false,
        min: 3600,
        max: 31536000,
      },
      {
        name: 'id_token_lifetime',
        type: 'number',
        description: 'ID token lifetime in seconds',
        default: 3600,
        required: false,
        min: 60,
        max: 86400,
      },
      {
        name: 'require_pkce',
        type: 'boolean',
        description: 'Require PKCE for authorization code flow',
        default: true,
        required: false,
      },
      {
        name: 'require_exact_redirect_uri',
        type: 'boolean',
        description: 'Require exact redirect URI match',
        default: true,
        required: false,
      },
      {
        name: 'allow_implicit_flow',
        type: 'boolean',
        description: 'Allow implicit grant flow (not recommended)',
        default: false,
        required: false,
      },
    ],
  },
  {
    category: 'security',
    description: 'Security and access control settings',
    settings: [
      {
        name: 'mfa_enforced',
        type: 'boolean',
        description: 'Enforce MFA for all users',
        default: false,
        required: false,
      },
      {
        name: 'password_min_length',
        type: 'number',
        description: 'Minimum password length',
        default: 8,
        required: false,
        min: 6,
        max: 128,
      },
      {
        name: 'password_require_uppercase',
        type: 'boolean',
        description: 'Require uppercase letter in password',
        default: true,
        required: false,
      },
      {
        name: 'password_require_number',
        type: 'boolean',
        description: 'Require number in password',
        default: true,
        required: false,
      },
      {
        name: 'password_require_special',
        type: 'boolean',
        description: 'Require special character in password',
        default: false,
        required: false,
      },
      {
        name: 'login_attempts_limit',
        type: 'number',
        description: 'Max login attempts before lockout',
        default: 5,
        required: false,
        min: 1,
        max: 20,
      },
      {
        name: 'lockout_duration_seconds',
        type: 'number',
        description: 'Account lockout duration in seconds',
        default: 300,
        required: false,
        min: 60,
        max: 86400,
      },
      {
        name: 'fapi_profile',
        type: 'enum',
        description: 'FAPI security profile level',
        default: 'none',
        required: false,
        enum_values: ['none', 'fapi1_baseline', 'fapi1_advanced', 'fapi2'],
      },
    ],
  },
  {
    category: 'session',
    description: 'Session management settings',
    settings: [
      {
        name: 'session_lifetime',
        type: 'number',
        description: 'Session lifetime in seconds',
        default: 86400,
        required: false,
        min: 300,
        max: 604800,
      },
      {
        name: 'session_idle_timeout',
        type: 'number',
        description: 'Session idle timeout in seconds',
        default: 3600,
        required: false,
        min: 60,
        max: 86400,
      },
      {
        name: 'single_session',
        type: 'boolean',
        description: 'Allow only single session per user',
        default: false,
        required: false,
      },
      {
        name: 'remember_me_lifetime',
        type: 'number',
        description: 'Remember me session lifetime in seconds',
        default: 2592000,
        required: false,
        min: 86400,
        max: 31536000,
      },
    ],
  },
  {
    category: 'tokens',
    description: 'Token configuration settings',
    settings: [
      {
        name: 'token_format',
        type: 'enum',
        description: 'Access token format',
        default: 'opaque',
        required: false,
        enum_values: ['opaque', 'jwt'],
      },
      {
        name: 'refresh_token_rotation',
        type: 'boolean',
        description: 'Enable refresh token rotation',
        default: true,
        required: false,
      },
      {
        name: 'refresh_token_reuse_interval',
        type: 'number',
        description: 'Grace period for refresh token reuse in seconds',
        default: 0,
        required: false,
        min: 0,
        max: 60,
      },
      {
        name: 'introspection_enabled',
        type: 'boolean',
        description: 'Enable token introspection endpoint',
        default: true,
        required: false,
      },
      {
        name: 'revocation_enabled',
        type: 'boolean',
        description: 'Enable token revocation endpoint',
        default: true,
        required: false,
      },
    ],
  },
  {
    category: 'federation',
    description: 'Federation and external IdP settings',
    settings: [
      {
        name: 'jit_provisioning_enabled',
        type: 'boolean',
        description: 'Enable JIT user provisioning',
        default: true,
        required: false,
      },
      {
        name: 'auto_link_accounts',
        type: 'boolean',
        description: 'Auto-link accounts by email',
        default: false,
        required: false,
      },
      {
        name: 'require_verified_email',
        type: 'boolean',
        description: 'Require verified email for federation',
        default: true,
        required: false,
      },
    ],
  },
  {
    category: 'mfa',
    description: 'Multi-factor authentication settings',
    settings: [
      {
        name: 'mfa_methods',
        type: 'array',
        description: 'Enabled MFA methods',
        default: ['totp', 'webauthn'],
        required: false,
      },
      {
        name: 'totp_issuer',
        type: 'string',
        description: 'TOTP issuer name for authenticator apps',
        default: null,
        required: false,
      },
      {
        name: 'backup_codes_count',
        type: 'number',
        description: 'Number of backup codes to generate',
        default: 10,
        required: false,
        min: 5,
        max: 20,
      },
      {
        name: 'sms_provider',
        type: 'enum',
        description: 'SMS provider for OTP',
        default: 'none',
        required: false,
        enum_values: ['none', 'twilio', 'aws_sns', 'nexmo'],
      },
    ],
  },
  {
    category: 'ui',
    description: 'User interface customization',
    settings: [
      {
        name: 'logo_url',
        type: 'string',
        description: 'Logo URL for login pages',
        default: null,
        required: false,
      },
      {
        name: 'primary_color',
        type: 'string',
        description: 'Primary brand color (hex)',
        default: '#0070f3',
        required: false,
        pattern: '^#[0-9A-Fa-f]{6}$',
      },
      {
        name: 'custom_css',
        type: 'string',
        description: 'Custom CSS for login pages',
        default: null,
        required: false,
      },
      {
        name: 'login_page_template',
        type: 'enum',
        description: 'Login page template',
        default: 'default',
        required: false,
        enum_values: ['default', 'centered', 'split'],
      },
    ],
  },
  {
    category: 'rate_limit',
    description: 'Rate limiting configuration',
    settings: [
      {
        name: 'enabled',
        type: 'boolean',
        description: 'Enable rate limiting',
        default: true,
        required: false,
      },
      {
        name: 'default_profile',
        type: 'enum',
        description: 'Default rate limit profile',
        default: 'moderate',
        required: false,
        enum_values: ['lenient', 'moderate', 'strict'],
      },
      {
        name: 'auth_endpoints_limit',
        type: 'number',
        description: 'Rate limit for auth endpoints (requests per minute)',
        default: 60,
        required: false,
        min: 10,
        max: 1000,
      },
    ],
  },
  {
    category: 'logging',
    description: 'Logging and audit configuration',
    settings: [
      {
        name: 'log_level',
        type: 'enum',
        description: 'Minimum log level',
        default: 'info',
        required: false,
        enum_values: ['debug', 'info', 'warn', 'error'],
      },
      {
        name: 'audit_log_enabled',
        type: 'boolean',
        description: 'Enable audit logging',
        default: true,
        required: false,
      },
      {
        name: 'audit_log_retention_days',
        type: 'number',
        description: 'Audit log retention period in days',
        default: 90,
        required: false,
        min: 7,
        max: 365,
      },
      {
        name: 'mask_pii',
        type: 'boolean',
        description: 'Mask PII in logs',
        default: true,
        required: false,
      },
    ],
  },
  {
    category: 'compliance',
    description: 'Compliance and data governance settings',
    settings: [
      {
        name: 'data_retention_enabled',
        type: 'boolean',
        description: 'Enable automatic data retention',
        default: false,
        required: false,
      },
      {
        name: 'data_retention_days',
        type: 'number',
        description: 'Data retention period in days',
        default: 365,
        required: false,
        min: 30,
        max: 3650,
      },
      {
        name: 'gdpr_mode',
        type: 'boolean',
        description: 'Enable GDPR compliance features',
        default: true,
        required: false,
      },
      {
        name: 'consent_required',
        type: 'boolean',
        description: 'Require explicit consent',
        default: true,
        required: false,
      },
    ],
  },
];

// =============================================================================
// Helpers
// =============================================================================

/**
 * Create database adapter from context
 */
function createAdapter(c: Context<{ Bindings: Env }>): DatabaseAdapter {
  return new D1Adapter({ db: c.env.DB });
}

/**
 * Settings history row
 */
interface SettingsHistoryRow {
  id: string;
  tenant_id: string;
  category: string;
  settings: string;
  changed_by: string;
  version: number;
  created_at: number;
}

/**
 * Deep diff two objects
 */
function deepDiff(
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>,
  path = ''
): Array<{
  path: string;
  type: 'added' | 'removed' | 'changed';
  old_value?: unknown;
  new_value?: unknown;
}> {
  const changes: Array<{
    path: string;
    type: 'added' | 'removed' | 'changed';
    old_value?: unknown;
    new_value?: unknown;
  }> = [];

  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);

  for (const key of allKeys) {
    const fullPath = path ? `${path}.${key}` : key;
    const oldValue = oldObj[key];
    const newValue = newObj[key];

    if (!(key in oldObj)) {
      changes.push({
        path: fullPath,
        type: 'added',
        new_value: newValue,
      });
    } else if (!(key in newObj)) {
      changes.push({
        path: fullPath,
        type: 'removed',
        old_value: oldValue,
      });
    } else if (
      typeof oldValue === 'object' &&
      oldValue !== null &&
      typeof newValue === 'object' &&
      newValue !== null &&
      !Array.isArray(oldValue) &&
      !Array.isArray(newValue)
    ) {
      // Recursively diff nested objects
      changes.push(
        ...deepDiff(
          oldValue as Record<string, unknown>,
          newValue as Record<string, unknown>,
          fullPath
        )
      );
    } else if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      changes.push({
        path: fullPath,
        type: 'changed',
        old_value: oldValue,
        new_value: newValue,
      });
    }
  }

  return changes;
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * GET /api/admin/settings/diff
 * Compare settings between two versions
 *
 * Query parameters:
 * - category: Settings category (optional, defaults to all)
 * - from_version: Source version number
 * - to_version: Target version number (optional, defaults to current)
 */
export async function adminSettingsDiffHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const category = c.req.query('category');
  const fromVersionParam = c.req.query('from_version');
  const toVersionParam = c.req.query('to_version');

  // Validate category if provided
  if (category && !SETTINGS_CATEGORIES.includes(category as SettingsCategory)) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: {
        field: 'category',
        reason: `Must be one of: ${SETTINGS_CATEGORIES.join(', ')}`,
      },
    });
  }

  // Validate from_version
  if (!fromVersionParam) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'from_version' },
    });
  }

  const fromVersion = parseInt(fromVersionParam, 10);
  if (isNaN(fromVersion) || fromVersion < 1) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'from_version', reason: 'Must be a positive integer' },
    });
  }

  const toVersion = toVersionParam ? parseInt(toVersionParam, 10) : null;
  if (toVersion !== null && (isNaN(toVersion) || toVersion < 1)) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'to_version', reason: 'Must be a positive integer' },
    });
  }

  try {
    const adapter = createAdapter(c);

    // Build query for source version
    let fromQuery = `
      SELECT id, tenant_id, category, settings, changed_by, version, created_at
      FROM settings_history
      WHERE tenant_id = ? AND version = ?
    `;
    const fromBindings: unknown[] = [tenantId, fromVersion];

    if (category) {
      fromQuery += ' AND category = ?';
      fromBindings.push(category);
    }

    const fromRows = await adapter.query<SettingsHistoryRow>(fromQuery, fromBindings);

    if (fromRows.length === 0) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: `settings version ${fromVersion}` },
      });
    }

    // Get target version (current or specified)
    let toRows: SettingsHistoryRow[];

    if (toVersion) {
      let toQuery = `
        SELECT id, tenant_id, category, settings, changed_by, version, created_at
        FROM settings_history
        WHERE tenant_id = ? AND version = ?
      `;
      const toBindings: unknown[] = [tenantId, toVersion];

      if (category) {
        toQuery += ' AND category = ?';
        toBindings.push(category);
      }

      toRows = await adapter.query<SettingsHistoryRow>(toQuery, toBindings);
    } else {
      // Get current settings from tenant (to_version not specified = compare with current)
      if (category) {
        const currentSettings = await adapter.queryOne<{
          settings: string;
          updated_at: number;
        }>(
          `SELECT json_extract(settings, ?) as settings, updated_at
           FROM tenants WHERE id = ?`,
          [`$.${category}`, tenantId]
        );

        if (currentSettings) {
          toRows = [
            {
              id: 'current',
              tenant_id: tenantId,
              category,
              settings: currentSettings.settings || '{}',
              changed_by: 'current',
              version: 0, // Current
              created_at: currentSettings.updated_at || Math.floor(Date.now() / 1000),
            },
          ];
        } else {
          toRows = [];
        }
      } else {
        // Get all categories from current settings
        const tenant = await adapter.queryOne<{ settings: string; updated_at: number }>(
          'SELECT settings, updated_at FROM tenants WHERE id = ?',
          [tenantId]
        );

        if (tenant && tenant.settings) {
          const settings = JSON.parse(tenant.settings) as Record<string, unknown>;
          toRows = Object.entries(settings).map(([cat, value]) => ({
            id: 'current',
            tenant_id: tenantId,
            category: cat,
            settings: JSON.stringify(value),
            changed_by: 'current',
            version: 0,
            created_at: tenant.updated_at || Math.floor(Date.now() / 1000),
          }));
        } else {
          toRows = [];
        }
      }
    }

    // Build diff for each category
    const diffs: Array<{
      category: string;
      from_version: number;
      to_version: number | 'current';
      changes: Array<{
        path: string;
        type: 'added' | 'removed' | 'changed';
        old_value?: unknown;
        new_value?: unknown;
      }>;
    }> = [];

    // Group rows by category
    const fromByCategory = new Map<string, SettingsHistoryRow>();
    for (const row of fromRows) {
      fromByCategory.set(row.category, row);
    }

    const toByCategory = new Map<string, SettingsHistoryRow>();
    for (const row of toRows) {
      toByCategory.set(row.category, row);
    }

    // All categories to compare
    const allCategories = new Set([...fromByCategory.keys(), ...toByCategory.keys()]);

    for (const cat of allCategories) {
      const fromRow = fromByCategory.get(cat);
      const toRow = toByCategory.get(cat);

      const fromSettings = fromRow ? (JSON.parse(fromRow.settings) as Record<string, unknown>) : {};
      const toSettings = toRow ? (JSON.parse(toRow.settings) as Record<string, unknown>) : {};

      const changes = deepDiff(fromSettings, toSettings);

      if (changes.length > 0 || !fromRow || !toRow) {
        diffs.push({
          category: cat,
          from_version: fromVersion,
          to_version: toVersion ?? 'current',
          changes:
            changes.length > 0
              ? changes
              : !fromRow
                ? [{ path: cat, type: 'added', new_value: toSettings }]
                : [{ path: cat, type: 'removed', old_value: fromSettings }],
        });
      }
    }

    return c.json({
      tenant_id: tenantId,
      from_version: fromVersion,
      to_version: toVersion ?? 'current',
      categories_compared: allCategories.size,
      total_changes: diffs.reduce((sum, d) => sum + d.changes.length, 0),
      diffs,
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-SETTINGS');
    log.error('Failed to diff settings', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * GET /api/admin/settings/schema
 * Get settings schema definition
 *
 * Query parameters:
 * - category: Settings category (optional, returns all if not specified)
 */
export async function adminSettingsSchemaHandler(c: Context<{ Bindings: Env }>) {
  const category = c.req.query('category');

  // Validate category if provided
  if (category && !SETTINGS_CATEGORIES.includes(category as SettingsCategory)) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: {
        field: 'category',
        reason: `Must be one of: ${SETTINGS_CATEGORIES.join(', ')}`,
      },
    });
  }

  try {
    let schemas: CategorySchema[];

    if (category) {
      const found = SETTINGS_SCHEMA.find((s) => s.category === category);
      schemas = found ? [found] : [];
    } else {
      schemas = SETTINGS_SCHEMA;
    }

    return c.json({
      categories: schemas.map((s) => ({
        category: s.category,
        description: s.description,
        settings_count: s.settings.length,
        settings: s.settings.map((setting) => ({
          ...setting,
          // Mask sensitive setting defaults
          default: setting.sensitive ? '[SENSITIVE]' : setting.default,
        })),
      })),
      total_categories: schemas.length,
      total_settings: schemas.reduce((sum, s) => sum + s.settings.length, 0),
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-SETTINGS');
    log.error('Failed to get settings schema', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// =============================================================================
// Phase 3: Settings Validation
// =============================================================================

/**
 * Validation result for a single setting
 */
interface SettingValidationResult {
  path: string;
  valid: boolean;
  error?: string;
  warning?: string;
}

/**
 * Schema for settings validate request
 */
const SettingsValidateRequestSchema = z.object({
  category: z.string().optional(),
  settings: z.record(z.string(), z.unknown()),
});

/**
 * Validate a single setting value against its schema
 */
function validateSettingValue(
  value: unknown,
  definition: SettingDefinition,
  path: string
): SettingValidationResult {
  // Check required
  if (definition.required && (value === undefined || value === null)) {
    return { path, valid: false, error: 'Required field is missing' };
  }

  // Skip validation if not provided and not required
  if (value === undefined || value === null) {
    return { path, valid: true };
  }

  // Type validation
  switch (definition.type) {
    case 'string':
      if (typeof value !== 'string') {
        return { path, valid: false, error: `Expected string, got ${typeof value}` };
      }
      if (definition.pattern) {
        const regex = new RegExp(definition.pattern);
        if (!regex.test(value)) {
          return {
            path,
            valid: false,
            error: `Value does not match pattern ${definition.pattern}`,
          };
        }
      }
      break;

    case 'number':
      if (typeof value !== 'number' || isNaN(value)) {
        return { path, valid: false, error: `Expected number, got ${typeof value}` };
      }
      if (definition.min !== undefined && value < definition.min) {
        return {
          path,
          valid: false,
          error: `Value ${value} is less than minimum ${definition.min}`,
        };
      }
      if (definition.max !== undefined && value > definition.max) {
        return { path, valid: false, error: `Value ${value} exceeds maximum ${definition.max}` };
      }
      break;

    case 'boolean':
      if (typeof value !== 'boolean') {
        return { path, valid: false, error: `Expected boolean, got ${typeof value}` };
      }
      break;

    case 'array':
      if (!Array.isArray(value)) {
        return { path, valid: false, error: `Expected array, got ${typeof value}` };
      }
      break;

    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { path, valid: false, error: `Expected object, got ${typeof value}` };
      }
      break;

    case 'enum':
      if (definition.enum_values && !definition.enum_values.includes(value as string)) {
        return {
          path,
          valid: false,
          error: `Value must be one of: ${definition.enum_values.join(', ')}`,
        };
      }
      break;
  }

  return { path, valid: true };
}

/**
 * POST /api/admin/settings/validate
 * Validate settings before applying
 *
 * Request body:
 * - category?: string - Optional category to validate (validates all if not specified)
 * - settings: object - Settings values to validate
 *
 * Returns validation results including errors and warnings
 */
export async function adminSettingsValidateHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);

  try {
    const body = await c.req.json<unknown>();
    const parseResult = SettingsValidateRequestSchema.safeParse(body);

    if (!parseResult.success) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'body',
          reason: parseResult.error.issues.map((i) => i.message).join(', '),
        },
      });
    }

    const { category, settings } = parseResult.data;

    // Validate category if provided
    if (category && !SETTINGS_CATEGORIES.includes(category as SettingsCategory)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'category',
          reason: `Must be one of: ${SETTINGS_CATEGORIES.join(', ')}`,
        },
      });
    }

    const results: SettingValidationResult[] = [];
    const warnings: string[] = [];

    // Get schemas to validate against
    const schemasToValidate = category
      ? SETTINGS_SCHEMA.filter((s) => s.category === category)
      : SETTINGS_SCHEMA;

    // Validate each setting
    for (const schema of schemasToValidate) {
      const categorySettings = category
        ? settings
        : (settings[schema.category] as Record<string, unknown>) || {};

      if (!categorySettings || typeof categorySettings !== 'object') {
        continue;
      }

      for (const definition of schema.settings) {
        const value = (categorySettings as Record<string, unknown>)[definition.name];
        const path = category ? definition.name : `${schema.category}.${definition.name}`;
        const result = validateSettingValue(value, definition, path);
        results.push(result);
      }

      // Check for unknown settings (warning only)
      const knownSettings = new Set(schema.settings.map((s) => s.name));
      for (const key of Object.keys(categorySettings as Record<string, unknown>)) {
        if (!knownSettings.has(key)) {
          const path = category ? key : `${schema.category}.${key}`;
          warnings.push(`Unknown setting: ${path}`);
        }
      }
    }

    const errors = results.filter((r) => !r.valid);
    const isValid = errors.length === 0;

    // Security checks (additional warnings)
    const securityWarnings: string[] = [];
    const allSettings = category ? { [category]: settings } : settings;

    // Check for insecure configurations
    const oauth = (allSettings as Record<string, Record<string, unknown>>)['oauth'];
    if (oauth) {
      if (oauth['allow_implicit_flow'] === true) {
        securityWarnings.push('Implicit flow is enabled - this is not recommended for security');
      }
      if (oauth['require_pkce'] === false) {
        securityWarnings.push('PKCE is disabled - enabling PKCE is strongly recommended');
      }
    }

    const security = (allSettings as Record<string, Record<string, unknown>>)['security'];
    if (security) {
      const passwordMinLength = security['password_min_length'];
      if (typeof passwordMinLength === 'number' && passwordMinLength < 12) {
        securityWarnings.push('Password minimum length is less than 12 - consider increasing');
      }
    }

    return c.json({
      valid: isValid,
      tenant_id: tenantId,
      errors: errors.map((e) => ({
        path: e.path,
        error: e.error,
      })),
      warnings: [...warnings, ...securityWarnings],
      validated_settings: results.filter((r) => r.valid).length,
      total_settings: results.length,
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-SETTINGS');
    log.error('Failed to validate settings', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// =============================================================================
// Phase 3: Tenant Clone
// =============================================================================

/**
 * Schema for tenant clone request
 */
const TenantCloneRequestSchema = z.object({
  name: z.string().min(1).max(200),
  subdomain: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Invalid subdomain format'),
  include_clients: z.boolean().default(false),
  include_roles: z.boolean().default(true),
  include_webhooks: z.boolean().default(false),
});

/**
 * POST /api/admin/tenants/:id/clone
 * Clone tenant settings to create a new tenant
 *
 * Request body:
 * - name: string - Name for the new tenant
 * - subdomain: string - Subdomain for the new tenant
 * - include_clients: boolean - Whether to clone client configurations
 * - include_roles: boolean - Whether to clone custom roles
 * - include_webhooks: boolean - Whether to clone webhook configurations
 *
 * Returns the new tenant ID and summary of cloned items
 */
export async function adminTenantCloneHandler(c: Context<{ Bindings: Env }>) {
  const sourceTenantId = c.req.param('id');
  // Note: getTenantIdFromContext is called for audit context but cross-tenant cloning
  // is allowed for system_admin/distributor_admin (verified by RBAC middleware)
  void getTenantIdFromContext(c);

  if (!sourceTenantId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  try {
    const body = await c.req.json<unknown>();
    const parseResult = TenantCloneRequestSchema.safeParse(body);

    if (!parseResult.success) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'body',
          reason: parseResult.error.issues.map((i) => i.message).join(', '),
        },
      });
    }

    const { name, subdomain, include_clients, include_roles, include_webhooks } = parseResult.data;
    const adapter = createAdapter(c);

    // Verify source tenant exists and user has access
    // Note: For cross-tenant cloning, user must be system_admin or distributor_admin
    const sourceTenant = await adapter.queryOne<{
      id: string;
      name: string;
      settings: string;
    }>('SELECT id, name, settings FROM tenants WHERE id = ?', [sourceTenantId]);

    if (!sourceTenant) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'source tenant' },
      });
    }

    // Check subdomain availability
    const existingSubdomain = await adapter.queryOne<{ id: string }>(
      'SELECT id FROM tenants WHERE subdomain = ?',
      [subdomain]
    );

    if (existingSubdomain) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'subdomain', reason: 'Subdomain already in use' },
      });
    }

    // Generate new tenant ID
    const newTenantId = crypto.randomUUID();
    const nowTs = Math.floor(Date.now() / 1000);

    // Clone tenant with new name and subdomain
    await adapter.execute(
      `INSERT INTO tenants (id, name, subdomain, settings, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [newTenantId, name, subdomain, sourceTenant.settings, nowTs, nowTs]
    );

    const clonedItems = {
      settings: true,
      clients: 0,
      roles: 0,
      webhooks: 0,
    };

    // Clone clients if requested
    if (include_clients) {
      const clients = await adapter.query<{
        id: string;
        name: string;
        client_type: string;
        redirect_uris: string;
        grant_types: string;
        scopes: string;
        settings: string;
      }>(
        `SELECT id, name, client_type, redirect_uris, grant_types, scopes, settings
         FROM oauth_clients WHERE tenant_id = ?`,
        [sourceTenantId]
      );

      for (const client of clients) {
        const newClientId = crypto.randomUUID();
        await adapter.execute(
          `INSERT INTO oauth_clients (id, tenant_id, name, client_type, redirect_uris, grant_types, scopes, settings, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newClientId,
            newTenantId,
            client.name,
            client.client_type,
            client.redirect_uris,
            client.grant_types,
            client.scopes,
            client.settings,
            nowTs,
            nowTs,
          ]
        );
        clonedItems.clients++;
      }
    }

    // Clone roles if requested
    if (include_roles) {
      const roles = await adapter.query<{
        id: string;
        name: string;
        description: string;
        permissions: string;
        is_system: number;
      }>(
        `SELECT id, name, description, permissions, is_system
         FROM roles WHERE tenant_id = ? AND is_system = 0`,
        [sourceTenantId]
      );

      for (const role of roles) {
        const newRoleId = crypto.randomUUID();
        await adapter.execute(
          `INSERT INTO roles (id, tenant_id, name, description, permissions, is_system, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
          [newRoleId, newTenantId, role.name, role.description, role.permissions, nowTs, nowTs]
        );
        clonedItems.roles++;
      }
    }

    // Clone webhooks if requested
    if (include_webhooks) {
      const webhooks = await adapter.query<{
        name: string;
        url: string;
        events: string;
        headers: string;
        retry_policy: string;
        timeout_ms: number;
      }>(
        `SELECT name, url, events, headers, retry_policy, timeout_ms
         FROM webhooks WHERE tenant_id = ? AND scope = 'tenant'`,
        [sourceTenantId]
      );

      for (const webhook of webhooks) {
        const newWebhookId = crypto.randomUUID();
        await adapter.execute(
          `INSERT INTO webhooks (id, tenant_id, scope, name, url, events, headers, retry_policy, timeout_ms, active, created_at, updated_at)
           VALUES (?, ?, 'tenant', ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [
            newWebhookId,
            newTenantId,
            webhook.name,
            webhook.url,
            webhook.events,
            webhook.headers,
            webhook.retry_policy,
            webhook.timeout_ms,
            nowTs,
            nowTs,
          ]
        );
        clonedItems.webhooks++;
      }
    }

    // Audit log
    await createAuditLogFromContext(c, 'tenant.cloned', 'tenant', newTenantId, {
      source_tenant_id: sourceTenantId,
      source_tenant_name: sourceTenant.name,
      new_tenant_name: name,
      subdomain,
      cloned_items: clonedItems,
    });

    return c.json(
      {
        tenant_id: newTenantId,
        name,
        subdomain,
        source_tenant_id: sourceTenantId,
        source_tenant_name: sourceTenant.name,
        cloned_items: clonedItems,
        created_at: new Date(nowTs * 1000).toISOString(),
      },
      201
    );
  } catch (error) {
    const log = getLogger(c).module('ADMIN-SETTINGS');
    log.error('Failed to clone tenant', { sourceTenantId }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
