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
  getLogger,
} from '@authrim/ar-lib-core';
import { z } from 'zod';

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
// Handlers
// =============================================================================

/**
 * GET /api/admin/tenants
 * List all tenants
 */
export async function adminTenantsListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const adapter = createAdapter(c);
    const rows = await adapter.query<TenantRow>(
      'SELECT id, name, description, is_active, is_default, created_at, updated_at FROM tenants ORDER BY is_default DESC, name ASC',
      []
    );

    return c.json({
      tenants: rows.map(formatTenant),
      total: rows.length,
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
  const id = c.req.param('id');

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
  const id = c.req.param('id');

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
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'is_active', reason: 'Cannot deactivate the default tenant' },
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
  const id = c.req.param('id');

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
  const id = c.req.param('id');

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
