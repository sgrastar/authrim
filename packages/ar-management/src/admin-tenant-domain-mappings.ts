/**
 * Admin Tenant Domain Mappings API Endpoints
 *
 * Platform-level CRUD for tenant domain mappings (system_admin only).
 * Maps email domains (hashed) to specific tenants for signup auto-routing.
 *
 * - GET    /api/admin/platform/tenant-domain-mappings          - List mappings
 * - POST   /api/admin/platform/tenant-domain-mappings          - Create mapping
 * - GET    /api/admin/platform/tenant-domain-mappings/:id      - Get mapping
 * - PUT    /api/admin/platform/tenant-domain-mappings/:id      - Update mapping
 * - DELETE /api/admin/platform/tenant-domain-mappings/:id      - Delete mapping
 * - POST   /api/admin/platform/tenant-domain-mappings/verify          - Initiate DNS verification
 * - POST   /api/admin/platform/tenant-domain-mappings/verify/confirm  - Confirm DNS verification
 *
 * @packageDocumentation
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  D1Adapter,
  createErrorResponse,
  AR_ERROR_CODES,
  createAuditLogFromContext,
  getLogger,
  generateEmailDomainHashWithVersion,
  getEmailDomainHashConfig,
  generateVerificationToken,
  getVerificationRecordName,
  getExpectedRecordValue,
  verifyDomainDnsTxt,
  calculateVerificationExpiry,
  isVerificationExpired,
} from '@authrim/ar-lib-core';
import { z } from 'zod';

// =============================================================================
// Constants
// =============================================================================

/** Domain format validation regex (RFC 1035 compliant) */
const DOMAIN_REGEX = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const MAX_DOMAIN_LENGTH = 253;

// =============================================================================
// Types
// =============================================================================

interface TenantDomainMappingRow {
  id: string;
  domain_hash: string;
  hash_version: number;
  tenant_id: string;
  priority: number;
  is_active: number;
  verified: number;
  verification_token: string | null;
  verification_expires_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

// =============================================================================
// Validation
// =============================================================================

function validateDomain(domain: string): { valid: boolean; error?: string } {
  if (!domain?.trim()) return { valid: false, error: 'domain is required' };
  const normalized = domain.toLowerCase().trim();
  if (normalized.length > MAX_DOMAIN_LENGTH)
    return {
      valid: false,
      error: `domain exceeds maximum length of ${MAX_DOMAIN_LENGTH} characters`,
    };
  if (!DOMAIN_REGEX.test(normalized))
    return {
      valid: false,
      error:
        'invalid domain format. Must be lowercase letters, numbers, hyphens, and dots. Labels cannot start or end with hyphens.',
    };
  return { valid: true };
}

const CreateSchema = z.object({
  domain: z.string().min(1).max(MAX_DOMAIN_LENGTH),
  tenant_id: z.string().min(1).max(63),
  priority: z.number().int().min(0).max(1000).optional().default(0),
  is_active: z.boolean().optional().default(true),
  verified: z.boolean().optional().default(false),
});

const UpdateSchema = z.object({
  priority: z.number().int().min(0).max(1000).optional(),
  is_active: z.boolean().optional(),
});

// =============================================================================
// Helpers
// =============================================================================

function formatMapping(row: TenantDomainMappingRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    hash_version: row.hash_version,
    priority: row.priority,
    is_active: row.is_active === 1,
    verified: row.verified === 1,
    verification_expires_at: row.verification_expires_at,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    // domain_hash is intentionally omitted from responses (security)
  };
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * GET /api/admin/platform/tenant-domain-mappings
 * List all tenant domain mappings
 */
export async function listTenantDomainMappingsHandler(c: Context<{ Bindings: Env }>) {
  const tenantIdFilter = c.req.query('tenant_id');
  const verified = c.req.query('verified');
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  try {
    const adapter = new D1Adapter({ db: c.env.DB });

    let query = `SELECT * FROM tenant_domain_mappings WHERE 1=1`;
    const params: unknown[] = [];

    if (tenantIdFilter) {
      query += ` AND tenant_id = ?`;
      params.push(tenantIdFilter);
    }
    if (verified !== undefined) {
      query += ` AND verified = ?`;
      params.push(verified === 'true' ? 1 : 0);
    }

    const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as count');
    const countRow = await adapter.queryOne<{ count: number }>(countQuery, params);
    const total = countRow?.count ?? 0;

    query += ` ORDER BY priority DESC, created_at ASC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = await adapter.query<TenantDomainMappingRow>(query, params);

    return c.json({
      mappings: rows.map(formatMapping),
      total,
      limit,
      offset,
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-TENANT-DOMAIN-MAPPINGS');
    log.error('Failed to list tenant domain mappings', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/platform/tenant-domain-mappings
 * Create a new tenant domain mapping
 */
export async function createTenantDomainMappingHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN-TENANT-DOMAIN-MAPPINGS');

  try {
    const body = await c.req.json<unknown>();
    const parseResult = CreateSchema.safeParse(body);

    if (!parseResult.success) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'body',
          reason: parseResult.error.issues.map((i) => i.message).join(', '),
        },
      });
    }

    const { domain, tenant_id, priority, is_active, verified } = parseResult.data;

    const domainValidation = validateDomain(domain);
    if (!domainValidation.valid) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'domain', reason: domainValidation.error! },
      });
    }

    const adapter = new D1Adapter({ db: c.env.DB });

    // Verify tenant exists
    const tenant = await adapter.queryOne<{ id: string }>('SELECT id FROM tenants WHERE id = ?', [
      tenant_id,
    ]);
    if (!tenant) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'tenant' },
      });
    }

    // Generate domain hash
    const hashConfig = await getEmailDomainHashConfig(c.env);
    const hashResult = await generateEmailDomainHashWithVersion(
      `user@${domain.toLowerCase()}`,
      hashConfig
    );

    // Check for duplicate (active mappings)
    const existing = await adapter.queryOne<{ id: string }>(
      'SELECT id FROM tenant_domain_mappings WHERE domain_hash = ? AND is_active = 1',
      [hashResult.hash]
    );
    if (existing) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'domain', reason: 'An active mapping for this domain already exists' },
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const createdBy = (c as any).get('adminAuth')?.adminId as string | undefined;
    const nowTs = Math.floor(Date.now() / 1000);
    const id = crypto.randomUUID();

    await adapter.execute(
      `INSERT INTO tenant_domain_mappings
        (id, domain_hash, hash_version, tenant_id, priority, is_active, verified,
         created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        hashResult.hash,
        hashResult.version,
        tenant_id,
        priority,
        is_active ? 1 : 0,
        verified ? 1 : 0,
        createdBy ?? null,
        nowTs,
        nowTs,
      ]
    );

    const created = await adapter.queryOne<TenantDomainMappingRow>(
      'SELECT * FROM tenant_domain_mappings WHERE id = ?',
      [id]
    );

    await createAuditLogFromContext(
      c,
      'tenant_domain_mapping.created',
      'tenant_domain_mapping',
      id,
      {
        tenant_id,
        priority,
      }
    );

    return c.json(formatMapping(created!), 201);
  } catch (error) {
    log.error('Failed to create tenant domain mapping', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * GET /api/admin/platform/tenant-domain-mappings/:id
 * Get a single tenant domain mapping
 */
export async function getTenantDomainMappingHandler(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')!;

  try {
    const adapter = new D1Adapter({ db: c.env.DB });
    const row = await adapter.queryOne<TenantDomainMappingRow>(
      'SELECT * FROM tenant_domain_mappings WHERE id = ?',
      [id]
    );

    if (!row) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'tenant_domain_mapping' },
      });
    }

    return c.json(formatMapping(row));
  } catch (error) {
    const log = getLogger(c).module('ADMIN-TENANT-DOMAIN-MAPPINGS');
    log.error('Failed to get tenant domain mapping', { id }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * PUT /api/admin/platform/tenant-domain-mappings/:id
 * Update a tenant domain mapping (priority and is_active only; domain cannot change)
 */
export async function updateTenantDomainMappingHandler(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')!;

  try {
    const body = await c.req.json<unknown>();
    const parseResult = UpdateSchema.safeParse(body);

    if (!parseResult.success) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'body',
          reason: parseResult.error.issues.map((i) => i.message).join(', '),
        },
      });
    }

    const updates = parseResult.data;
    const adapter = new D1Adapter({ db: c.env.DB });

    const existing = await adapter.queryOne<TenantDomainMappingRow>(
      'SELECT * FROM tenant_domain_mappings WHERE id = ?',
      [id]
    );

    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'tenant_domain_mapping' },
      });
    }

    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.priority !== undefined) {
      fields.push('priority = ?');
      values.push(updates.priority);
    }
    if (updates.is_active !== undefined) {
      fields.push('is_active = ?');
      values.push(updates.is_active ? 1 : 0);
    }

    if (fields.length === 0) {
      return c.json(formatMapping(existing));
    }

    const nowTs = Math.floor(Date.now() / 1000);
    fields.push('updated_at = ?');
    values.push(nowTs);
    values.push(id);

    await adapter.execute(
      `UPDATE tenant_domain_mappings SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    const updated = await adapter.queryOne<TenantDomainMappingRow>(
      'SELECT * FROM tenant_domain_mappings WHERE id = ?',
      [id]
    );

    await createAuditLogFromContext(
      c,
      'tenant_domain_mapping.updated',
      'tenant_domain_mapping',
      id,
      {
        changes: updates,
      }
    );

    return c.json(formatMapping(updated!));
  } catch (error) {
    const log = getLogger(c).module('ADMIN-TENANT-DOMAIN-MAPPINGS');
    log.error('Failed to update tenant domain mapping', { id }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * DELETE /api/admin/platform/tenant-domain-mappings/:id
 * Delete a tenant domain mapping
 */
export async function deleteTenantDomainMappingHandler(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')!;

  try {
    const adapter = new D1Adapter({ db: c.env.DB });

    const existing = await adapter.queryOne<{ id: string }>(
      'SELECT id FROM tenant_domain_mappings WHERE id = ?',
      [id]
    );

    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'tenant_domain_mapping' },
      });
    }

    await adapter.execute('DELETE FROM tenant_domain_mappings WHERE id = ?', [id]);

    await createAuditLogFromContext(
      c,
      'tenant_domain_mapping.deleted',
      'tenant_domain_mapping',
      id,
      {}
    );

    return c.json({ success: true });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-TENANT-DOMAIN-MAPPINGS');
    log.error('Failed to delete tenant domain mapping', { id }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/platform/tenant-domain-mappings/verify
 * Initiate DNS TXT verification for a mapping
 */
export async function initiateTenantDomainVerificationHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN-TENANT-DOMAIN-MAPPINGS');

  try {
    const body = await c.req.json<{ id: string; domain: string }>();

    if (!body.id || !body.domain) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'id, domain' },
      });
    }

    const adapter = new D1Adapter({ db: c.env.DB });
    const existing = await adapter.queryOne<TenantDomainMappingRow>(
      'SELECT * FROM tenant_domain_mappings WHERE id = ?',
      [body.id]
    );

    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'tenant_domain_mapping' },
      });
    }

    const token = await generateVerificationToken();
    const expiresAt = calculateVerificationExpiry();
    const nowTs = Math.floor(Date.now() / 1000);

    await adapter.execute(
      'UPDATE tenant_domain_mappings SET verification_token = ?, verification_expires_at = ?, verified = 0, updated_at = ? WHERE id = ?',
      [token, expiresAt, nowTs, body.id]
    );

    const domain = body.domain.toLowerCase().trim();

    return c.json({
      id: body.id,
      dns_record_name: getVerificationRecordName(domain),
      dns_record_value: getExpectedRecordValue(token),
      dns_record_type: 'TXT',
      expires_at: expiresAt,
    });
  } catch (error) {
    log.error('Failed to initiate tenant domain verification', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/platform/tenant-domain-mappings/verify/confirm
 * Confirm DNS TXT verification for a mapping
 */
export async function confirmTenantDomainVerificationHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN-TENANT-DOMAIN-MAPPINGS');

  try {
    const body = await c.req.json<{ id: string; domain: string }>();

    if (!body.id || !body.domain) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'id, domain' },
      });
    }

    const adapter = new D1Adapter({ db: c.env.DB });
    const existing = await adapter.queryOne<TenantDomainMappingRow>(
      'SELECT * FROM tenant_domain_mappings WHERE id = ?',
      [body.id]
    );

    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'tenant_domain_mapping' },
      });
    }

    if (!existing.verification_token) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'id', reason: 'Verification not initiated. Call /verify first.' },
      });
    }

    if (isVerificationExpired(existing.verification_expires_at ?? 0)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'id',
          reason: 'Verification token has expired. Re-initiate verification.',
        },
      });
    }

    const domain = body.domain.toLowerCase().trim();
    const verified = await verifyDomainDnsTxt(domain, existing.verification_token);

    if (!verified) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'domain',
          reason: `DNS TXT record not found or does not match. Add TXT record: ${getVerificationRecordName(domain)} = ${getExpectedRecordValue(existing.verification_token)}`,
        },
      });
    }

    const nowTs = Math.floor(Date.now() / 1000);
    await adapter.execute(
      'UPDATE tenant_domain_mappings SET verified = 1, verification_token = NULL, verification_expires_at = NULL, updated_at = ? WHERE id = ?',
      [nowTs, body.id]
    );

    const updated = await adapter.queryOne<TenantDomainMappingRow>(
      'SELECT * FROM tenant_domain_mappings WHERE id = ?',
      [body.id]
    );

    await createAuditLogFromContext(
      c,
      'tenant_domain_mapping.verified',
      'tenant_domain_mapping',
      body.id,
      { domain }
    );

    return c.json(formatMapping(updated!));
  } catch (error) {
    log.error('Failed to confirm tenant domain verification', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
