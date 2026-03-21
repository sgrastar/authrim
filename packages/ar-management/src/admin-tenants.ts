/**
 * Admin Tenants API Endpoints
 *
 * CRUD management for tenants:
 * - GET    /api/admin/tenants          - List all tenants
 * - POST   /api/admin/tenants          - Create tenant
 * - GET    /api/admin/tenants/:id      - Get tenant
 * - PATCH  /api/admin/tenants/:id      - Update tenant (name, description, is_active)
 * - DELETE /api/admin/tenants/:id      - Delete tenant (default tenant not allowed)
 * - POST   /api/admin/tenants/:id/set-default - Set as default tenant
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
  createAuditLogFromContext,
  generateId,
  getLogger,
  // Contract provisioning
  TENANT_POLICY_PRESETS,
  type TenantContract,
  buildContractKey,
  usesNakedDomainIssuer,
} from '@authrim/ar-lib-core';

/**
 * Invalidate the tenant existence KV cache for a given tenant.
 * Called after create, is_active change, and deactivate to ensure
 * request-context middleware picks up the new state promptly.
 */
async function invalidateTenantExistsCache(
  kv: KVNamespace | undefined,
  tenantId: string
): Promise<void> {
  await kv?.delete(`v1:tenant-exists:${tenantId}`).catch(() => {});
}
import { z } from 'zod';
import {
  createSingleTenantMutationError,
  ensureSupportedTenantId,
  getSingleTenantId,
  isSingleTenantMode,
} from './single-tenant-guard';

// =============================================================================
// Constants
// =============================================================================

/**
 * Tables to delete when removing a tenant.
 * Order matters: child tables first, then parent tables.
 * Exported for reuse in the async delete Cron job.
 */
export const TENANT_TABLES_TO_DELETE = [
  // Tables with explicit FK CASCADE in schema (still delete manually for safety)
  'idempotency_keys',
  'operational_logs',
  'security_alerts',
  // Access management
  'access_review_items',
  'access_reviews',
  // Jobs
  'admin_jobs',
  // AI
  'ai_grants',
  // Attributes
  'attribute_verifications',
  'verified_attributes',
  'user_verified_attributes',
  // Audit
  'audit_log',
  // Branding
  'branding_settings',
  // API keys
  'check_api_keys',
  // Auth flows
  'ciba_requests',
  'device_codes',
  'external_idp_auth_states',
  'flows',
  'password_reset_tokens',
  // Consents
  'client_consent_overrides',
  'consent_history',
  'consent_item_history',
  'consent_policy_versions',
  'consent_statement_localizations',
  'consent_statement_versions',
  'consent_statements',
  'oauth_client_consents',
  'tenant_consent_requirements',
  'user_consent_records',
  // Compliance
  'compliance_reports',
  'data_export_requests',
  // Credentials (VC)
  'credential_configurations',
  'issued_credentials',
  'presentation_definitions',
  'status_lists',
  'trusted_issuers',
  'vp_requests',
  // Identity
  'identity_providers',
  'linked_identities',
  'passkeys',
  'subject_identifiers',
  'upstream_providers',
  // Clients
  'oauth_clients',
  // Organizations
  'org_domain_mappings',
  'subject_org_membership',
  'organizations',
  // Policies
  'permission_change_audit',
  'permission_check_audit',
  'policy_rules',
  'policy_simulations',
  'relation_definitions',
  'relationship_closure',
  'relationships',
  'resource_permissions',
  'role_assignment_rules',
  // Roles
  'role_assignments',
  'user_roles',
  'roles',
  // Security
  'security_threats',
  'suspicious_activities',
  // Sessions
  'sessions',
  // Settings
  'settings_history',
  // Custom claims
  'custom_claim_schema_history',
  'custom_claim_schemas',
  // Token claim rules
  'token_claim_rules',
  // Refresh token sharding
  'refresh_token_shard_configs',
  // Users (tenant-specific user data, not users_core which is shared)
  'user_custom_fields',
  'user_token_families',
  'users',
  // Webhooks
  'webhook_delivery_logs',
  'webhook_configs',
] as const;

// =============================================================================
// Types
// =============================================================================

interface TenantRow {
  id: string;
  name: string;
  description: string | null;
  is_active: number;
  is_default: number;
  created_at: number;
  updated_at: number;
}

// =============================================================================
// Helpers
// =============================================================================

function createAdapter(c: Context<{ Bindings: Env }>): DatabaseAdapter {
  return new D1Adapter({ db: c.env.DB });
}

function formatTenant(row: TenantRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    is_active: row.is_active === 1,
    is_default: row.is_default === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// =============================================================================
// Validation Schemas
// =============================================================================

// DNS label format: starts and ends with alphanumeric, hyphens allowed in the middle
const TENANT_ID_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const CreateTenantSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(63)
    .regex(
      TENANT_ID_REGEX,
      'id must start and end with a lowercase letter or digit (hyphens allowed in between)'
    ),
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
});

const UpdateTenantSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).nullable().optional(),
  is_active: z.boolean().optional(),
});

// =============================================================================
// Default claim seeding
// =============================================================================

/**
 * Default OIDC claim schemas to seed for each new tenant.
 * All claims default to include_in_id_token=0 (OIDC compliant).
 * System claims cannot be deleted or renamed via the admin API.
 *
 * display_order ranges:
 *   1-13  : profile scope claims
 *   20-21 : email scope claims
 *   30-31 : phone scope claims
 *   40-45 : address scope claims (individual fields, not JSON object)
 */
const DEFAULT_CLAIM_SCHEMAS = [
  // Profile scope
  {
    field_key: 'name',
    display_label: 'Full Name',
    field_type: 'string',
    is_pii: 1,
    display_order: 1,
  },
  {
    field_key: 'given_name',
    display_label: 'First Name',
    field_type: 'string',
    is_pii: 1,
    display_order: 2,
  },
  {
    field_key: 'family_name',
    display_label: 'Last Name',
    field_type: 'string',
    is_pii: 1,
    display_order: 3,
  },
  {
    field_key: 'middle_name',
    display_label: 'Middle Name',
    field_type: 'string',
    is_pii: 1,
    display_order: 4,
  },
  {
    field_key: 'nickname',
    display_label: 'Nickname',
    field_type: 'string',
    is_pii: 1,
    display_order: 5,
  },
  {
    field_key: 'preferred_username',
    display_label: 'Preferred Username',
    field_type: 'string',
    is_pii: 0,
    display_order: 6,
  },
  {
    field_key: 'profile',
    display_label: 'Profile URL',
    field_type: 'string',
    is_pii: 0,
    display_order: 7,
  },
  {
    field_key: 'picture',
    display_label: 'Picture URL',
    field_type: 'string',
    is_pii: 1,
    display_order: 8,
  },
  {
    field_key: 'website',
    display_label: 'Website',
    field_type: 'string',
    is_pii: 0,
    display_order: 9,
  },
  {
    field_key: 'birthdate',
    display_label: 'Birthdate',
    field_type: 'date',
    is_pii: 1,
    display_order: 10,
  },
  {
    field_key: 'zoneinfo',
    display_label: 'Time Zone',
    field_type: 'string',
    is_pii: 0,
    display_order: 11,
  },
  {
    field_key: 'locale',
    display_label: 'Locale',
    field_type: 'string',
    is_pii: 0,
    display_order: 12,
  },
  {
    field_key: 'updated_at',
    display_label: 'Last Updated',
    field_type: 'number',
    is_pii: 0,
    display_order: 13,
  },
  // Email scope
  {
    field_key: 'email',
    display_label: 'Email',
    field_type: 'string',
    is_pii: 1,
    display_order: 20,
  },
  {
    field_key: 'email_verified',
    display_label: 'Email Verified',
    field_type: 'boolean',
    is_pii: 0,
    display_order: 21,
  },
  // Phone scope
  {
    field_key: 'phone_number',
    display_label: 'Phone Number',
    field_type: 'string',
    is_pii: 1,
    display_order: 30,
  },
  {
    field_key: 'phone_number_verified',
    display_label: 'Phone Number Verified',
    field_type: 'boolean',
    is_pii: 0,
    display_order: 31,
  },
  // Address scope (individual fields; address_country is non-PII for regulatory flexibility)
  {
    field_key: 'address_formatted',
    display_label: 'Address (Formatted)',
    field_type: 'string',
    is_pii: 1,
    display_order: 40,
  },
  {
    field_key: 'address_street_address',
    display_label: 'Street Address',
    field_type: 'string',
    is_pii: 1,
    display_order: 41,
  },
  {
    field_key: 'address_locality',
    display_label: 'City / Locality',
    field_type: 'string',
    is_pii: 1,
    display_order: 42,
  },
  {
    field_key: 'address_region',
    display_label: 'State / Region',
    field_type: 'string',
    is_pii: 1,
    display_order: 43,
  },
  {
    field_key: 'address_postal_code',
    display_label: 'Postal Code',
    field_type: 'string',
    is_pii: 1,
    display_order: 44,
  },
  {
    field_key: 'address_country',
    display_label: 'Country',
    field_type: 'string',
    is_pii: 0,
    display_order: 45,
  },
] as const;

/**
 * Seeds default OIDC claim schemas for a newly created tenant.
 * Skips any field_key that already exists for the tenant (idempotent).
 *
 * @param throwOnError - When true, per-claim errors are rethrown instead of logged.
 *   Use true during initial provisioning (hard-fail), false for soft-failure mode.
 */
export async function seedDefaultClaimsForTenant(
  tenantId: string,
  adapter: DatabaseAdapter,
  log: ReturnType<typeof getLogger>,
  options: { throwOnError?: boolean } = {}
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const { throwOnError = false } = options;

  for (const claim of DEFAULT_CLAIM_SCHEMAS) {
    try {
      const existing = await adapter.queryOne<{ id: string }>(
        'SELECT id FROM custom_claim_schemas WHERE tenant_id = ? AND field_key = ?',
        [tenantId, claim.field_key]
      );
      if (existing) continue;

      await adapter.execute(
        `INSERT INTO custom_claim_schemas (
          id, tenant_id, field_key, display_label, field_type,
          is_pii, is_required, is_active, is_system,
          is_searchable, is_exportable, is_vc_claim,
          include_in_id_token, include_in_userinfo, include_in_introspection,
          scope_mode, display_order, schema_version, operation_status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 1, 1, ?, ?, 0, 0, 1, 0, 'any', ?, 1, 'active', ?, ?)`,
        [
          generateId(),
          tenantId,
          claim.field_key,
          claim.display_label,
          claim.field_type,
          claim.is_pii,
          // is_searchable: 1 for identifier-like fields, 0 for URL/meta fields
          [
            'name',
            'given_name',
            'family_name',
            'email',
            'preferred_username',
            'phone_number',
          ].includes(claim.field_key)
            ? 1
            : 0,
          // is_exportable: 1 for most fields, 0 for verified-status and meta fields
          ['email_verified', 'phone_number_verified', 'updated_at'].includes(claim.field_key)
            ? 0
            : 1,
          claim.display_order,
          now,
          now,
        ]
      );
    } catch (err) {
      if (throwOnError) throw err;
      log
        .module('ADMIN-TENANTS')
        .error(
          `Failed to seed default claim '${claim.field_key}' for tenant '${tenantId}'`,
          {},
          err as Error
        );
    }
  }
}

// =============================================================================
// Tenant Provisioning Helpers
// =============================================================================

/**
 * Build default allowed origins for a new tenant.
 * Includes tenant subdomain, naked domain (if primary), and UI URLs.
 */
function buildDefaultAllowedOrigins(tenantId: string, env: Env): string {
  const origins: string[] = [];
  if (env.BASE_DOMAIN) {
    origins.push(`https://${tenantId}.${env.BASE_DOMAIN}`);
    // Naked domain only for the primary tenant
    if (usesNakedDomainIssuer(env, tenantId)) {
      origins.push(`https://${env.BASE_DOMAIN}`);
    }
  }
  if (env.UI_URL) origins.push(env.UI_URL);
  if (env.ADMIN_UI_URL) origins.push(env.ADMIN_UI_URL);
  return origins.join(',');
}

/**
 * Build default TenantContract using the b2c-standard preset.
 */
function buildDefaultTenantContract(tenantId: string): TenantContract {
  const preset = TENANT_POLICY_PRESETS.find((p) => p.id === 'b2c-standard')!;
  const now = new Date().toISOString();

  return {
    ...preset.defaults,
    tenantId,
    version: 1,
    preset: 'b2c-standard',
    profile: 'human',
    metadata: {
      createdAt: now,
      updatedAt: now,
      createdBy: 'system',
      status: 'active',
    },
  } as TenantContract;
}

/**
 * Seed default per-tenant settings into KV.
 * Writes to AUTHRIM_CONFIG (tenant settings) and SETTINGS (UI settings).
 */
async function seedTenantDefaultSettings(c: Context<{ Bindings: Env }>, tenantId: string) {
  const env = c.env;
  const allowedOrigins = buildDefaultAllowedOrigins(tenantId, env);

  await Promise.all([
    env.AUTHRIM_CONFIG?.put(
      `settings:tenant:${tenantId}:tenant`,
      JSON.stringify({ 'tenant.allowed_origins': allowedOrigins })
    ),
    env.SETTINGS?.put(
      `settings:tenant:${tenantId}:login-ui`,
      JSON.stringify({ 'login-ui.brand_name': tenantId })
    ),
    env.SETTINGS?.put(
      `settings:tenant:${tenantId}:login-methods`,
      JSON.stringify({})
    ),
  ]);
}

/**
 * Initialize KeyManager DO for a tenant (idempotent).
 * Creates signing keys only if none exist yet.
 */
async function initTenantKeyManager(
  keyManagerBinding: Env['KEY_MANAGER'],
  tenantId: string
): Promise<void> {
  // All tenants (including 'default') use ${tenantId}-v3 as the DO name
  const km = keyManagerBinding.get(keyManagerBinding.idFromName(`${tenantId}-v3`));
  const status = await km.getStatusRpc();
  if (!status.activeKeyId) {
    // No keys yet — generate the initial key
    await km.rotateKeysRpc();
  }
  // If activeKeyId exists (idempotent: same tenant ID re-provisioned), reuse existing keys
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * GET /api/admin/tenants
 * List all tenants
 */
export async function adminTenantsListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const adapter = createAdapter(c);
    const singleTenantMode = isSingleTenantMode(c.env);
    const query = singleTenantMode
      ? 'SELECT id, name, description, is_active, is_default, created_at, updated_at FROM tenants WHERE id = ? ORDER BY is_default DESC, name ASC'
      : 'SELECT id, name, description, is_active, is_default, created_at, updated_at FROM tenants ORDER BY is_default DESC, name ASC';
    const rows = await adapter.query<TenantRow>(
      query,
      singleTenantMode ? [getSingleTenantId(c.env)] : []
    );

    return c.json({
      tenants: rows.map(formatTenant),
      total: rows.length,
      single_tenant_mode: singleTenantMode,
      single_tenant_reason: singleTenantMode
        ? 'API custom domain is not configured. This deployment runs in single-tenant mode.'
        : null,
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-TENANTS');
    log.error('Failed to list tenants', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/tenants
 * Create a new tenant
 */
export async function adminTenantCreateHandler(c: Context<{ Bindings: Env }>) {
  if (isSingleTenantMode(c.env)) {
    return createSingleTenantMutationError(c, 'tenant');
  }

  try {
    const body = await c.req.json<unknown>();
    const parseResult = CreateTenantSchema.safeParse(body);

    if (!parseResult.success) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'body',
          reason: parseResult.error.issues.map((i) => i.message).join(', '),
        },
      });
    }

    const { id, name, description } = parseResult.data;
    const adapter = createAdapter(c);

    // Check id availability
    const existing = await adapter.queryOne<{ id: string }>('SELECT id FROM tenants WHERE id = ?', [
      id,
    ]);

    if (existing) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'id', reason: 'Tenant ID already exists' },
      });
    }

    const nowTs = Math.floor(Date.now() / 1000);

    await adapter.execute(
      `INSERT INTO tenants (id, name, description, is_active, is_default, created_at, updated_at)
       VALUES (?, ?, ?, 1, 0, ?, ?)`,
      [id, name, description ?? null, nowTs, nowTs]
    );

    const created = await adapter.queryOne<TenantRow>(
      'SELECT id, name, description, is_active, is_default, created_at, updated_at FROM tenants WHERE id = ?',
      [id]
    );

    // Provisioning — all-or-nothing (hard-fail with compensation on error)
    const contractKey = buildContractKey(c.env, 'tenant', id);
    try {
      // 1. Seed default OIDC claim schemas (hard-fail: rethrow on any error)
      await seedDefaultClaimsForTenant(id, adapter, getLogger(c), { throwOnError: true });
      // 2. Write TenantContract to KV
      await c.env.AUTHRIM_CONFIG!.put(contractKey, JSON.stringify(buildDefaultTenantContract(id)));
      // 3. Seed per-tenant KV settings (allowed_origins, login-ui, login-methods)
      await seedTenantDefaultSettings(c, id);
      // 4. Initialize KeyManager DO (idempotent — only rotates if no active key yet)
      await initTenantKeyManager(c.env.KEY_MANAGER, id);
      // 5. Invalidate tenant-exists cache so request-context middleware sees the new tenant
      await invalidateTenantExistsCache(c.env.AUTHRIM_CONFIG, id);
    } catch (error) {
      const log = getLogger(c).module('ADMIN-TENANTS');
      log.error('Tenant provisioning failed — rolling back', { tenantId: id }, error as Error);
      // Compensation: best-effort cleanup of all written state
      await Promise.allSettled([
        adapter.execute('DELETE FROM tenants WHERE id = ?', [id]),
        adapter.execute('DELETE FROM custom_claim_schemas WHERE tenant_id = ?', [id]),
        c.env.AUTHRIM_CONFIG?.delete(contractKey),
        c.env.AUTHRIM_CONFIG?.delete(`settings:tenant:${id}:tenant`),
        c.env.AUTHRIM_CONFIG?.delete(`v1:tenant-exists:${id}`),
        c.env.SETTINGS?.delete(`settings:tenant:${id}:login-ui`),
        c.env.SETTINGS?.delete(`settings:tenant:${id}:login-methods`),
        // KeyManager DO cleanup is not possible (no delete/reset RPC) — orphaned DO is harmless
      ]);
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    // Audit log written AFTER successful provisioning
    await createAuditLogFromContext(c, 'tenant.created', 'tenant', id, {
      name,
      description: description ?? null,
    });

    return c.json(formatTenant(created!), 201);
  } catch (error) {
    const log = getLogger(c).module('ADMIN-TENANTS');
    log.error('Failed to create tenant', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * GET /api/admin/tenants/:id
 * Get a single tenant
 */
export async function adminTenantGetHandler(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')!;
  const blocked = await ensureSupportedTenantId(c, id);
  if (blocked) {
    return blocked;
  }

  try {
    const adapter = createAdapter(c);
    const tenant = await adapter.queryOne<TenantRow>(
      'SELECT id, name, description, is_active, is_default, created_at, updated_at FROM tenants WHERE id = ?',
      [id]
    );

    if (!tenant) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'tenant' },
      });
    }

    return c.json(formatTenant(tenant));
  } catch (error) {
    const log = getLogger(c).module('ADMIN-TENANTS');
    log.error('Failed to get tenant', { id }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * PATCH /api/admin/tenants/:id
 * Update tenant (name, description, is_active)
 * Note: id and is_default cannot be changed via this endpoint
 */
export async function adminTenantUpdateHandler(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')!;
  const blocked = await ensureSupportedTenantId(c, id);
  if (blocked) {
    return blocked;
  }

  try {
    const body = await c.req.json<unknown>();
    const parseResult = UpdateTenantSchema.safeParse(body);

    if (!parseResult.success) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'body',
          reason: parseResult.error.issues.map((i) => i.message).join(', '),
        },
      });
    }

    const updates = parseResult.data;
    const adapter = createAdapter(c);

    // Check tenant exists
    const existing = await adapter.queryOne<TenantRow>(
      'SELECT id, name, description, is_active, is_default, created_at, updated_at FROM tenants WHERE id = ?',
      [id]
    );

    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'tenant' },
      });
    }

    // The default tenant cannot be deactivated: doing so would lock out the ability
    // to reassign the default (set-default rejects inactive tenants)
    if (existing.is_default === 1 && updates.is_active === false) {
      const reason = isSingleTenantMode(c.env)
        ? 'The default tenant must remain active in single-tenant mode'
        : 'Cannot deactivate the default tenant';
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'is_active', reason },
      });
    }

    // Build update fields
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if ('description' in updates) {
      fields.push('description = ?');
      values.push(updates.description ?? null);
    }
    if (updates.is_active !== undefined) {
      fields.push('is_active = ?');
      values.push(updates.is_active ? 1 : 0);
    }

    if (fields.length === 0) {
      return c.json(formatTenant(existing));
    }

    const nowTs = Math.floor(Date.now() / 1000);
    fields.push('updated_at = ?');
    values.push(nowTs);
    values.push(id);

    await adapter.execute(`UPDATE tenants SET ${fields.join(', ')} WHERE id = ?`, values);

    // Invalidate cache if is_active changed (tenant may have been activated or deactivated)
    if (updates.is_active !== undefined) {
      await invalidateTenantExistsCache(c.env.AUTHRIM_CONFIG, id);
    }

    const updated = await adapter.queryOne<TenantRow>(
      'SELECT id, name, description, is_active, is_default, created_at, updated_at FROM tenants WHERE id = ?',
      [id]
    );

    await createAuditLogFromContext(c, 'tenant.updated', 'tenant', id, {
      changes: updates,
    });

    return c.json(formatTenant(updated!));
  } catch (error) {
    const log = getLogger(c).module('ADMIN-TENANTS');
    log.error('Failed to update tenant', { id }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * DELETE /api/admin/tenants/:id
 * Schedule a tenant deletion as an async job.
 * The tenant is immediately deactivated; all data is deleted by the Cron job.
 * Returns 202 Accepted with the job ID.
 * The 'default' tenant cannot be deleted.
 */
export async function adminTenantDeleteHandler(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')!;
  const blocked = await ensureSupportedTenantId(c, id);
  if (blocked) {
    return blocked;
  }

  if (id === 'default') {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'id', reason: 'Cannot delete the default tenant' },
    });
  }

  try {
    const adapter = createAdapter(c);

    const existing = await adapter.queryOne<{ id: string; is_default: number }>(
      'SELECT id, is_default FROM tenants WHERE id = ?',
      [id]
    );

    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'tenant' },
      });
    }

    if (existing.is_default === 1) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'id', reason: 'Cannot delete the default tenant' },
      });
    }

    const nowTs = Math.floor(Date.now() / 1000);

    // Immediately deactivate the tenant to block new requests
    await adapter.execute('UPDATE tenants SET is_active = 0, updated_at = ? WHERE id = ?', [
      nowTs,
      id,
    ]);

    // Invalidate cache so subsequent requests to this tenant return 404 immediately
    await invalidateTenantExistsCache(c.env.AUTHRIM_CONFIG, id);

    // Get admin identity for job attribution
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const adminAuth = (c as any).get('adminAuth') as { adminId?: string } | null;
    const createdBy = adminAuth?.adminId ?? 'unknown';

    const jobId = crypto.randomUUID();
    // Estimate completion: max 1 hour (next hourly cron tick)
    const estimatedCompletion = nowTs + 3600;

    await adapter.execute(
      `INSERT INTO admin_jobs (
        id, tenant_id, job_type, status, progress, config,
        created_by, created_at, updated_at, estimated_completion
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jobId,
        'default',
        'tenants/delete',
        'pending',
        JSON.stringify({ stage: 'queued' }),
        JSON.stringify({ tenant_id: id }),
        createdBy,
        nowTs,
        nowTs,
        estimatedCompletion,
      ]
    );

    await createAuditLogFromContext(c, 'tenant.delete_queued', 'tenant', id, {
      tenant_id: id,
      job_id: jobId,
    });

    return c.json(
      {
        job_id: jobId,
        status: 'pending',
        estimated_completion: estimatedCompletion,
      },
      202
    );
  } catch (error) {
    const log = getLogger(c).module('ADMIN-TENANTS');
    log.error('Failed to queue tenant deletion', { id }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/tenants/:id/set-default
 * Set a tenant as the default tenant (atomically, using D1 batch)
 */
export async function adminTenantSetDefaultHandler(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')!;
  const blocked = await ensureSupportedTenantId(c, id);
  if (blocked) {
    return blocked;
  }

  if (isSingleTenantMode(c.env)) {
    return createSingleTenantMutationError(c, 'id');
  }

  try {
    const adapter = createAdapter(c);

    const existing = await adapter.queryOne<{ id: string; is_active: number }>(
      'SELECT id, is_active FROM tenants WHERE id = ?',
      [id]
    );

    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'tenant' },
      });
    }

    if (existing.is_active === 0) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'id', reason: 'Cannot set an inactive tenant as default' },
      });
    }

    const nowTs = Math.floor(Date.now() / 1000);

    // Atomic swap using D1 batch
    await c.env.DB.batch([
      c.env.DB.prepare(
        'UPDATE tenants SET is_default = 0, updated_at = ? WHERE is_default = 1'
      ).bind(nowTs),
      c.env.DB.prepare('UPDATE tenants SET is_default = 1, updated_at = ? WHERE id = ?').bind(
        nowTs,
        id
      ),
    ]);

    const updated = await adapter.queryOne<TenantRow>(
      'SELECT id, name, description, is_active, is_default, created_at, updated_at FROM tenants WHERE id = ?',
      [id]
    );

    await createAuditLogFromContext(c, 'tenant.set_default', 'tenant', id, { tenant_id: id });

    return c.json(formatTenant(updated!));
  } catch (error) {
    const log = getLogger(c).module('ADMIN-TENANTS');
    log.error('Failed to set default tenant', { id }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
