/**
 * Organization Domain Mappings Admin API
 *
 * CRUD operations for organization domain mappings used in JIT Provisioning.
 *
 * POST   /api/admin/org-domain-mappings              - Create mapping
 * GET    /api/admin/org-domain-mappings              - List mappings
 * GET    /api/admin/org-domain-mappings/:id          - Get mapping
 * PUT    /api/admin/org-domain-mappings/:id          - Update mapping
 * DELETE /api/admin/org-domain-mappings/:id          - Delete mapping
 * GET    /api/admin/organizations/:org_id/domain-mappings - List by org
 */

import type { Context } from 'hono';
import {
  D1Adapter,
  getLogger,
  type DatabaseAdapter,
  type OrgDomainMapping,
  type OrgDomainMappingRow,
  type OrgDomainMappingInput,
  generateEmailDomainHashWithVersion,
  getEmailDomainHashConfig,
  listDomainMappings,
  createDomainMapping,
  updateDomainMapping,
  deleteDomainMapping,
  getDomainMappingById,
  // DNS Verification
  generateVerificationToken,
  getVerificationRecordName,
  getExpectedRecordValue,
  verifyDomainDnsTxt,
  calculateVerificationExpiry,
  isVerificationExpired,
  type VerificationStatus,
  // Event System
  publishEvent,
  DOMAIN_EVENTS,
  type DomainEventData,
} from '@authrim/ar-lib-core';

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_TENANT_ID = 'default';
const MAX_MAPPINGS_PER_PAGE = 100;

/**
 * Domain format validation regex (RFC 1035 compliant)
 *
 * Validates domain names with the following rules:
 * - Labels contain only lowercase letters, numbers, and hyphens
 * - Labels cannot start or end with a hyphen
 * - Each label is 1-63 characters
 * - TLD is at least 2 letters (no numbers only)
 * - Total length is max 253 characters (checked separately)
 *
 * Examples:
 * - Valid: example.com, sub.example.co.jp, a-b.example.org
 * - Invalid: -example.com, example-.com, .example.com, example..com
 */
const DOMAIN_REGEX = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * Maximum domain length per RFC 1035
 */
const MAX_DOMAIN_LENGTH = 253;

/**
 * Validate domain format
 * @param domain Domain string to validate
 * @returns Object with valid flag and optional error message
 */
function validateDomainFormat(domain: string): { valid: boolean; error?: string } {
  // Check for empty or whitespace-only
  if (!domain || domain.trim().length === 0) {
    return { valid: false, error: 'domain is required' };
  }

  // Normalize to lowercase and trim
  const normalized = domain.toLowerCase().trim();

  // Check maximum length
  if (normalized.length > MAX_DOMAIN_LENGTH) {
    return {
      valid: false,
      error: `domain exceeds maximum length of ${MAX_DOMAIN_LENGTH} characters`,
    };
  }

  // Check format against regex
  if (!DOMAIN_REGEX.test(normalized)) {
    return {
      valid: false,
      error:
        'invalid domain format. Domain must contain only lowercase letters, numbers, hyphens, and dots. ' +
        'Labels cannot start or end with hyphens. TLD must be at least 2 letters.',
    };
  }

  return { valid: true };
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * POST /api/admin/org-domain-mappings
 * Create a new domain mapping
 */
export async function createOrgDomainMapping(c: Context) {
  const log = getLogger(c).module('OrgDomainMappingsAPI');
  const body = await c.req.json<OrgDomainMappingInput>();
  const tenantId = DEFAULT_TENANT_ID;

  // Validate domain format (RFC 1035 compliant)
  const domainValidation = validateDomainFormat(body.domain);
  if (!domainValidation.valid) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: domainValidation.error,
      },
      400
    );
  }

  if (!body.org_id || body.org_id.trim().length === 0) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'org_id is required',
      },
      400
    );
  }

  try {
    // Generate domain hash
    const hashConfig = await getEmailDomainHashConfig(c.env);
    const hashResult = await generateEmailDomainHashWithVersion(
      `user@${body.domain.toLowerCase()}`,
      hashConfig
    );

    // Verify org exists
    const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });
    const org = await coreAdapter.queryOne<{ id: string }>(
      'SELECT id FROM organizations WHERE id = ? AND tenant_id = ?',
      [body.org_id, tenantId]
    );

    if (!org) {
      return c.json(
        {
          error: 'not_found',
          error_description: `Organization ${body.org_id} not found`,
        },
        404
      );
    }

    // Check for existing mapping
    const existing = await coreAdapter.queryOne<{ id: string }>(
      `SELECT id FROM org_domain_mappings
       WHERE tenant_id = ? AND domain_hash = ? AND org_id = ?`,
      [tenantId, hashResult.hash, body.org_id]
    );

    if (existing) {
      return c.json(
        {
          error: 'conflict',
          error_description: 'Domain mapping already exists for this org',
        },
        409
      );
    }

    // Create mapping
    const mapping = await createDomainMapping(
      c.env.DB,
      tenantId,
      hashResult.hash,
      hashResult.version,
      body.org_id,
      {
        autoJoinEnabled: body.auto_join_enabled,
        membershipType: body.membership_type,
        autoAssignRoleId: body.auto_assign_role_id,
        verified: body.verified,
        priority: body.priority,
        isActive: body.is_active,
      }
    );

    return c.json(
      {
        ...mapping,
        domain: body.domain.toLowerCase(), // Return domain for reference
      },
      201
    );
  } catch (error) {
    log.error('Create error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create domain mapping',
      },
      500
    );
  }
}

/**
 * GET /api/admin/org-domain-mappings
 * List all domain mappings
 */
export async function listOrgDomainMappings(c: Context) {
  const log = getLogger(c).module('OrgDomainMappingsAPI');
  const tenantId = DEFAULT_TENANT_ID;
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), MAX_MAPPINGS_PER_PAGE);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  const orgId = c.req.query('org_id');
  const verified = c.req.query('verified');
  const isActive = c.req.query('is_active');

  try {
    const result = await listDomainMappings(c.env.DB, tenantId, {
      orgId: orgId || undefined,
      verified: verified !== undefined ? verified === 'true' : undefined,
      isActive: isActive !== undefined ? isActive === 'true' : undefined,
      limit,
      offset,
    });

    return c.json({
      mappings: result.mappings,
      total: result.total,
      limit,
      offset,
    });
  } catch (error) {
    log.error('List error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to list domain mappings',
      },
      500
    );
  }
}

/**
 * GET /api/admin/org-domain-mappings/:id
 * Get a single mapping by ID
 */
export async function getOrgDomainMapping(c: Context) {
  const log = getLogger(c).module('OrgDomainMappingsAPI');
  const id = c.req.param('id');
  const tenantId = DEFAULT_TENANT_ID;

  try {
    const mapping = await getDomainMappingById(c.env.DB, id, tenantId);

    if (!mapping) {
      return c.json(
        {
          error: 'not_found',
          error_description: `Domain mapping ${id} not found`,
        },
        404
      );
    }

    return c.json(mapping);
  } catch (error) {
    log.error('Get error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get domain mapping',
      },
      500
    );
  }
}

/**
 * PUT /api/admin/org-domain-mappings/:id
 * Update a mapping
 */
export async function updateOrgDomainMapping(c: Context) {
  const log = getLogger(c).module('OrgDomainMappingsAPI');
  const id = c.req.param('id');
  const tenantId = DEFAULT_TENANT_ID;
  const body = await c.req.json<Partial<OrgDomainMappingInput>>();

  try {
    // Note: domain cannot be updated. Create a new mapping instead.
    const updated = await updateDomainMapping(c.env.DB, id, tenantId, {
      autoJoinEnabled: body.auto_join_enabled,
      membershipType: body.membership_type,
      autoAssignRoleId: body.auto_assign_role_id,
      verified: body.verified,
      priority: body.priority,
      isActive: body.is_active,
    });

    if (!updated) {
      return c.json(
        {
          error: 'not_found',
          error_description: `Domain mapping ${id} not found`,
        },
        404
      );
    }

    return c.json(updated);
  } catch (error) {
    log.error('Update error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to update domain mapping',
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/org-domain-mappings/:id
 * Delete a mapping
 */
export async function deleteOrgDomainMapping(c: Context) {
  const log = getLogger(c).module('OrgDomainMappingsAPI');
  const id = c.req.param('id');
  const tenantId = DEFAULT_TENANT_ID;

  try {
    const success = await deleteDomainMapping(c.env.DB, id, tenantId);

    if (!success) {
      return c.json(
        {
          error: 'not_found',
          error_description: `Domain mapping ${id} not found`,
        },
        404
      );
    }

    return c.json({ success: true });
  } catch (error) {
    log.error('Delete error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to delete domain mapping',
      },
      500
    );
  }
}

/**
 * GET /api/admin/organizations/:org_id/domain-mappings
 * List domain mappings for a specific organization
 */
export async function listOrgDomainMappingsByOrg(c: Context) {
  const log = getLogger(c).module('OrgDomainMappingsAPI');
  const orgId = c.req.param('org_id');
  const tenantId = DEFAULT_TENANT_ID;
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), MAX_MAPPINGS_PER_PAGE);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  try {
    // Verify org exists
    const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });
    const org = await coreAdapter.queryOne<{ id: string }>(
      'SELECT id FROM organizations WHERE id = ? AND tenant_id = ?',
      [orgId, tenantId]
    );

    if (!org) {
      return c.json(
        {
          error: 'not_found',
          error_description: `Organization ${orgId} not found`,
        },
        404
      );
    }

    const result = await listDomainMappings(c.env.DB, tenantId, {
      orgId,
      limit,
      offset,
    });

    return c.json({
      mappings: result.mappings,
      total: result.total,
      limit,
      offset,
    });
  } catch (error) {
    log.error('List by org error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to list domain mappings',
      },
      500
    );
  }
}

/**
 * POST /api/admin/org-domain-mappings/verify
 * Initiate domain ownership verification via DNS TXT record.
 *
 * Request body:
 * {
 *   "mapping_id": "dm_xxx",
 *   "domain": "example.com",  // Required for generating DNS instructions
 *   "verification_method": "dns_txt"
 * }
 *
 * Response:
 * {
 *   "record_name": "_authrim-verify.example.com",
 *   "record_value": "authrim-domain-verify=<token>",
 *   "expires_at": 1703894400,
 *   "instructions": "..."
 * }
 */
export async function verifyDomainOwnership(c: Context) {
  const log = getLogger(c).module('OrgDomainMappingsAPI');
  const body = await c.req.json<{
    mapping_id: string;
    domain: string;
    verification_method?: string;
  }>();
  const tenantId = DEFAULT_TENANT_ID;

  // Validate input
  if (!body.mapping_id) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'mapping_id is required',
      },
      400
    );
  }

  // Validate domain format (RFC 1035 compliant)
  const domainValidation = validateDomainFormat(body.domain);
  if (!domainValidation.valid) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: domainValidation.error,
      },
      400
    );
  }

  // Only dns_txt method is supported
  const method = body.verification_method || 'dns_txt';
  if (method !== 'dns_txt') {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Only dns_txt verification method is supported',
      },
      400
    );
  }

  const domain = body.domain.toLowerCase().trim();

  try {
    // Get existing mapping
    const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });
    const mapping = await getDomainMappingById(c.env.DB, body.mapping_id, tenantId);

    if (!mapping) {
      return c.json(
        {
          error: 'not_found',
          error_description: `Domain mapping ${body.mapping_id} not found`,
        },
        404
      );
    }

    // Generate verification token and expiry
    const token = await generateVerificationToken();
    const expiresAt = calculateVerificationExpiry();

    // Update mapping with verification details
    await coreAdapter.execute(
      `UPDATE org_domain_mappings SET
        verification_token = ?,
        verification_status = ?,
        verification_expires_at = ?,
        verification_method = ?,
        updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
      [
        token,
        'pending' as VerificationStatus,
        expiresAt,
        method,
        Math.floor(Date.now() / 1000),
        body.mapping_id,
        tenantId,
      ]
    );

    // Generate DNS record instructions
    const recordName = getVerificationRecordName(domain);
    const recordValue = getExpectedRecordValue(token);

    // Publish verification started event
    publishEvent(c, {
      type: DOMAIN_EVENTS.VERIFICATION_STARTED,
      tenantId,
      data: {
        mappingId: body.mapping_id,
        domain: domain.substring(0, 3) + '***', // Mask domain for privacy
        orgId: mapping.org_id,
        verificationMethod: method,
      } satisfies DomainEventData,
    }).catch((err: unknown) => {
      log.warn(
        'Failed to publish event',
        { event: DOMAIN_EVENTS.VERIFICATION_STARTED },
        err as Error
      );
    });

    return c.json({
      mapping_id: body.mapping_id,
      record_name: recordName,
      record_value: recordValue,
      expires_at: expiresAt,
      expires_in_seconds: expiresAt - Math.floor(Date.now() / 1000),
      instructions: `Add a TXT record to your DNS configuration:\n\nName: ${recordName}\nValue: ${recordValue}\n\nAfter adding the record, call POST /api/admin/org-domain-mappings/verify/confirm with mapping_id to complete verification.`,
    });
  } catch (error) {
    log.error('Verify initiate error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to initiate domain verification',
      },
      500
    );
  }
}

/**
 * POST /api/admin/org-domain-mappings/verify/confirm
 * Confirm domain ownership by checking DNS TXT record.
 *
 * Request body:
 * {
 *   "mapping_id": "dm_xxx",
 *   "domain": "example.com"
 * }
 *
 * Response:
 * {
 *   "verified": true,
 *   "mapping": { ... }
 * }
 */
export async function confirmDomainVerification(c: Context) {
  const log = getLogger(c).module('OrgDomainMappingsAPI');
  const body = await c.req.json<{ mapping_id: string; domain: string }>();
  const tenantId = DEFAULT_TENANT_ID;

  // Validate input
  if (!body.mapping_id) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'mapping_id is required',
      },
      400
    );
  }

  // Validate domain format (RFC 1035 compliant)
  const domainValidation = validateDomainFormat(body.domain);
  if (!domainValidation.valid) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: domainValidation.error,
      },
      400
    );
  }

  const domain = body.domain.toLowerCase().trim();

  try {
    const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });

    // Get mapping with verification details
    const row = await coreAdapter.queryOne<{
      id: string;
      org_id: string;
      verification_token: string | null;
      verification_status: string | null;
      verification_expires_at: number | null;
      verification_method: string | null;
    }>(
      `SELECT id, org_id, verification_token, verification_status, verification_expires_at, verification_method
       FROM org_domain_mappings
       WHERE id = ? AND tenant_id = ?`,
      [body.mapping_id, tenantId]
    );

    if (!row) {
      return c.json(
        {
          error: 'not_found',
          error_description: `Domain mapping ${body.mapping_id} not found`,
        },
        404
      );
    }

    // Check if verification is pending
    if (row.verification_status !== 'pending') {
      if (row.verification_status === 'verified') {
        return c.json({
          verified: true,
          message: 'Domain is already verified',
        });
      }
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Verification not initiated. Call POST /verify first.',
        },
        400
      );
    }

    // Check if token has expired
    if (!row.verification_token || !row.verification_expires_at) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Verification token not found. Call POST /verify first.',
        },
        400
      );
    }

    if (isVerificationExpired(row.verification_expires_at)) {
      // Update status to expired
      await coreAdapter.execute(
        'UPDATE org_domain_mappings SET verification_status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
        ['expired' as VerificationStatus, Math.floor(Date.now() / 1000), body.mapping_id, tenantId]
      );

      // Publish failed event
      publishEvent(c, {
        type: DOMAIN_EVENTS.VERIFICATION_FAILED,
        tenantId,
        data: {
          mappingId: body.mapping_id,
          orgId: row.org_id,
          verificationMethod: row.verification_method || 'dns_txt',
          errorMessage: 'Verification token has expired',
        } satisfies DomainEventData,
      }).catch((err: unknown) => {
        log.warn(
          'Failed to publish event',
          { event: DOMAIN_EVENTS.VERIFICATION_FAILED },
          err as Error
        );
      });

      return c.json(
        {
          error: 'verification_expired',
          error_description: 'Verification token has expired. Initiate a new verification.',
        },
        400
      );
    }

    // Perform DNS TXT record lookup
    const result = await verifyDomainDnsTxt(domain, row.verification_token);

    if (result.verified) {
      // Update mapping as verified
      const updated = await updateDomainMapping(c.env.DB, body.mapping_id, tenantId, {
        verified: true,
      });

      // Also update verification_status
      await coreAdapter.execute(
        'UPDATE org_domain_mappings SET verification_status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
        ['verified' as VerificationStatus, Math.floor(Date.now() / 1000), body.mapping_id, tenantId]
      );

      // Publish success event
      publishEvent(c, {
        type: DOMAIN_EVENTS.VERIFICATION_SUCCEEDED,
        tenantId,
        data: {
          mappingId: body.mapping_id,
          domain: domain.substring(0, 3) + '***',
          orgId: row.org_id,
          verificationMethod: row.verification_method || 'dns_txt',
        } satisfies DomainEventData,
      }).catch((err: unknown) => {
        log.warn(
          'Failed to publish event',
          { event: DOMAIN_EVENTS.VERIFICATION_SUCCEEDED },
          err as Error
        );
      });

      log.info('Domain verified', { mappingId: body.mapping_id });

      return c.json({
        verified: true,
        mapping: updated,
      });
    } else {
      // Verification failed
      const errorMessage = result.error || 'DNS TXT record not found or does not match';

      // Publish failed event
      publishEvent(c, {
        type: DOMAIN_EVENTS.VERIFICATION_FAILED,
        tenantId,
        data: {
          mappingId: body.mapping_id,
          orgId: row.org_id,
          verificationMethod: row.verification_method || 'dns_txt',
          errorMessage,
        } satisfies DomainEventData,
      }).catch((err: unknown) => {
        log.warn(
          'Failed to publish event',
          { event: DOMAIN_EVENTS.VERIFICATION_FAILED },
          err as Error
        );
      });

      return c.json(
        {
          verified: false,
          record_found: result.recordFound,
          expected_value: result.expectedValue,
          actual_values: result.actualValues,
          error: errorMessage,
          instructions: `Ensure the DNS TXT record is correctly configured:\n\nName: ${getVerificationRecordName(domain)}\nExpected Value: ${result.expectedValue}\n\nDNS changes can take up to 24-48 hours to propagate.`,
        },
        400
      );
    }
  } catch (error) {
    log.error('Verify confirm error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to confirm domain verification',
      },
      500
    );
  }
}
