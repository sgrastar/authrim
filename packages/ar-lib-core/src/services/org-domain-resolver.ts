/**
 * Organization Domain Resolver Service
 *
 * Resolves organizations from email domain hashes and handles
 * organization membership management for JIT Provisioning.
 *
 * Features:
 * - Domain hash to organization resolution
 * - Multiple organization matching with priority
 * - Organization membership creation
 * - Respect for JIT Provisioning configuration
 */

import type { DatabaseSource } from '../db';
import { ensureDatabaseAdapter } from '../db';
import type { OrgDomainMapping, OrgDomainMappingRow } from '../types/policy-rules';
import type { JITProvisioningConfig } from '../types/jit-config';
import { createLogger } from '../utils/logger';

const log = createLogger().module('ORG-DOMAIN-RESOLVER');

// =============================================================================
// Types
// =============================================================================

/**
 * Resolved organization information
 */
export interface ResolvedOrganization {
  org_id: string;
  auto_join_enabled: boolean;
  auto_assign_role_id: string | null;
  membership_type: 'member' | 'admin' | 'owner';
  verified: boolean;
  priority: number;
}

/**
 * Organization join result
 */
export interface OrgJoinResult {
  success: boolean;
  org_id: string;
  membership_id?: string;
  role_assignment_id?: string;
  error?: string;
}

/**
 * Organization membership type (re-exported from types/policy-rules)
 */
type MembershipType = 'member' | 'admin' | 'owner';

function getAdapter(db: DatabaseSource) {
  return ensureDatabaseAdapter(db, 'org-domain-resolver');
}

// =============================================================================
// Domain Resolution
// =============================================================================

/**
 * Resolve organization by domain hash
 *
 * Selection rules (ORDER BY):
 * 1. verified DESC (verified domains first)
 * 2. priority DESC (higher priority first)
 * 3. created_at ASC (older mappings first for tie-breaking)
 *
 * @param db - Database source
 * @param domainHash - HMAC-SHA256 hash of email domain
 * @param tenantId - Tenant ID for isolation
 * @param config - JIT Provisioning configuration
 * @returns First matching organization or null
 */
export async function resolveOrgByDomainHash(
  db: DatabaseSource,
  domainHash: string,
  tenantId: string,
  config: JITProvisioningConfig
): Promise<ResolvedOrganization | null> {
  const orgs = await resolveAllOrgsByDomainHash(db, domainHash, tenantId, config);
  return orgs.length > 0 ? orgs[0] : null;
}

/**
 * Resolve all matching organizations by domain hash
 *
 * @param db - Database source
 * @param domainHash - HMAC-SHA256 hash of email domain
 * @param tenantId - Tenant ID for isolation
 * @param config - JIT Provisioning configuration (optional)
 * @returns Array of matching organizations (sorted by priority)
 */
export async function resolveAllOrgsByDomainHash(
  db: DatabaseSource,
  domainHash: string,
  tenantId: string,
  config?: JITProvisioningConfig
): Promise<ResolvedOrganization[]> {
  const adapter = getAdapter(db);
  // Build query with optional verified filter
  let query = `
    SELECT
      id, tenant_id, domain_hash, domain_hash_version,
      org_id, auto_join_enabled, membership_type,
      auto_assign_role_id, verified, priority, is_active,
      created_at, updated_at
    FROM org_domain_mappings
    WHERE tenant_id = ?
      AND domain_hash = ?
      AND is_active = 1
      AND auto_join_enabled = 1
  `;

  // Require verified mappings unless explicitly allowed
  if (config && !config.allow_unverified_domain_mappings) {
    query += ' AND verified = 1';
  }

  query += `
    ORDER BY
      verified DESC,
      priority DESC,
      created_at ASC
  `;

  const rows = await adapter.query<OrgDomainMappingRow>(query, [tenantId, domainHash]);

  return rows.map(rowToResolvedOrg);
}

/**
 * Resolve organizations by domain hash with version support
 * Used during key rotation when checking multiple hash versions
 *
 * @param db - Database source
 * @param hashes - Array of hashes with their versions
 * @param tenantId - Tenant ID for isolation
 * @param config - JIT Provisioning configuration
 * @returns Array of matching organizations
 */
export async function resolveOrgsByDomainHashMultiVersion(
  db: DatabaseSource,
  hashes: Array<{ hash: string; version: number }>,
  tenantId: string,
  config?: JITProvisioningConfig
): Promise<ResolvedOrganization[]> {
  const adapter = getAdapter(db);
  if (hashes.length === 0) {
    return [];
  }

  // Build OR conditions for each hash/version pair
  const conditions: string[] = [];
  const values: unknown[] = [tenantId];

  for (const { hash, version } of hashes) {
    conditions.push('(domain_hash = ? AND domain_hash_version = ?)');
    values.push(hash, version);
  }

  let query = `
    SELECT
      id, tenant_id, domain_hash, domain_hash_version,
      org_id, auto_join_enabled, membership_type,
      auto_assign_role_id, verified, priority, is_active,
      created_at, updated_at
    FROM org_domain_mappings
    WHERE tenant_id = ?
      AND (${conditions.join(' OR ')})
      AND is_active = 1
      AND auto_join_enabled = 1
  `;

  if (config && !config.allow_unverified_domain_mappings) {
    query += ' AND verified = 1';
  }

  query += `
    ORDER BY
      verified DESC,
      priority DESC,
      created_at ASC
  `;

  const rows = await adapter.query<OrgDomainMappingRow>(query, values);

  return rows.map(rowToResolvedOrg);
}

/**
 * Convert database row to ResolvedOrganization
 */
function rowToResolvedOrg(row: OrgDomainMappingRow): ResolvedOrganization {
  return {
    org_id: row.org_id,
    auto_join_enabled: row.auto_join_enabled === 1,
    auto_assign_role_id: row.auto_assign_role_id,
    membership_type: row.membership_type as MembershipType,
    verified: row.verified === 1,
    priority: row.priority,
  };
}

// =============================================================================
// Organization Membership
// =============================================================================

/**
 * Join a user to an organization
 *
 * @param db - Database source
 * @param userId - User ID to add
 * @param orgId - Organization ID to join
 * @param tenantId - Tenant ID for isolation
 * @param membershipType - Membership type (default: 'member')
 * @returns Join result
 */
export async function joinOrganization(
  db: DatabaseSource,
  userId: string,
  orgId: string,
  tenantId: string,
  membershipType: MembershipType = 'member'
): Promise<OrgJoinResult> {
  const adapter = getAdapter(db);
  const membershipId = `mem_${crypto.randomUUID().replace(/-/g, '')}`;
  const now = Math.floor(Date.now() / 1000);

  try {
    // Check if organization exists
    const orgCheck = await adapter.queryOne<{ id: string }>(
      'SELECT id FROM organizations WHERE id = ? AND tenant_id = ?',
      [orgId, tenantId]
    );

    if (!orgCheck) {
      return {
        success: false,
        org_id: orgId,
        // SECURITY: Do not expose org ID to prevent enumeration
        error: 'Organization not found',
      };
    }

    // Check if already a member
    const existingMember = await adapter.queryOne<{ id: string }>(
      'SELECT id FROM org_memberships WHERE user_id = ? AND org_id = ? AND tenant_id = ?',
      [userId, orgId, tenantId]
    );

    if (existingMember) {
      return {
        success: true,
        org_id: orgId,
        membership_id: existingMember.id,
        error: 'Already a member',
      };
    }

    // Create membership
    await adapter.execute(
      `INSERT INTO org_memberships (id, tenant_id, user_id, org_id, membership_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [membershipId, tenantId, userId, orgId, membershipType, now, now]
    );

    return {
      success: true,
      org_id: orgId,
      membership_id: membershipId,
    };
  } catch (error) {
    log.error('Database error in joinOrganization', { orgId, userId }, error as Error);
    return {
      success: false,
      org_id: orgId,
      // SECURITY: Do not expose internal error details
      error: 'Failed to join organization',
    };
  }
}

/**
 * Join a user to multiple organizations
 *
 * @param db - Database source
 * @param userId - User ID to add
 * @param orgs - Array of organizations to join
 * @param tenantId - Tenant ID for isolation
 * @returns Array of join results
 */
export async function joinOrganizations(
  db: DatabaseSource,
  userId: string,
  orgs: ResolvedOrganization[],
  tenantId: string
): Promise<OrgJoinResult[]> {
  const results: OrgJoinResult[] = [];

  for (const org of orgs) {
    const result = await joinOrganization(db, userId, org.org_id, tenantId, org.membership_type);
    results.push(result);
  }

  return results;
}

/**
 * Assign role to user after joining organization
 *
 * @param db - D1 database instance
 * @param userId - User ID
 * @param roleId - Role ID to assign
 * @param orgId - Organization ID (for scope)
 * @param tenantId - Tenant ID
 * @returns Assignment result
 */
export async function assignRoleToUser(
  db: DatabaseSource,
  userId: string,
  roleId: string,
  orgId: string,
  tenantId: string
): Promise<{ success: boolean; assignment_id?: string; error?: string }> {
  const adapter = getAdapter(db);
  const assignmentId = `ra_${crypto.randomUUID().replace(/-/g, '')}`;
  const now = Math.floor(Date.now() / 1000);

  try {
    // Check if role exists
    const roleCheck = await adapter.queryOne<{ id: string }>(
      'SELECT id FROM roles WHERE id = ? AND tenant_id = ?',
      [roleId, tenantId]
    );

    if (!roleCheck) {
      return {
        success: false,
        // SECURITY: Do not expose role ID to prevent enumeration
        error: 'Role not found',
      };
    }

    // Check if already assigned
    const existing = await adapter.queryOne<{ id: string }>(
      `SELECT id FROM role_assignments
       WHERE user_id = ? AND role_id = ? AND scope_type = 'org' AND scope_target = ? AND tenant_id = ?`,
      [userId, roleId, `org:${orgId}`, tenantId]
    );

    if (existing) {
      return {
        success: true,
        assignment_id: existing.id,
        error: 'Already assigned',
      };
    }

    // Create assignment
    await adapter.execute(
      `INSERT INTO role_assignments (id, tenant_id, user_id, role_id, scope_type, scope_target, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'org', ?, ?, ?)`,
      [assignmentId, tenantId, userId, roleId, `org:${orgId}`, now, now]
    );

    return {
      success: true,
      assignment_id: assignmentId,
    };
  } catch (error) {
    log.error('Database error in assignRoleToUser', { roleId, userId, orgId }, error as Error);
    return {
      success: false,
      // SECURITY: Do not expose internal error details
      error: 'Failed to assign role',
    };
  }
}

// =============================================================================
// Domain Mapping CRUD (for Admin API)
// =============================================================================

/**
 * Get domain mapping by ID
 */
export async function getDomainMappingById(
  db: DatabaseSource,
  id: string,
  tenantId: string
): Promise<OrgDomainMapping | null> {
  const adapter = getAdapter(db);
  const row = await adapter.queryOne<OrgDomainMappingRow>(
    'SELECT * FROM org_domain_mappings WHERE id = ? AND tenant_id = ?',
    [id, tenantId]
  );

  return row ? rowToOrgDomainMapping(row) : null;
}

/**
 * List domain mappings for a tenant
 */
export async function listDomainMappings(
  db: DatabaseSource,
  tenantId: string,
  options?: {
    orgId?: string;
    verified?: boolean;
    isActive?: boolean;
    limit?: number;
    offset?: number;
  }
): Promise<{ mappings: OrgDomainMapping[]; total: number }> {
  const adapter = getAdapter(db);
  let whereClause = 'WHERE tenant_id = ?';
  const values: unknown[] = [tenantId];

  if (options?.orgId) {
    whereClause += ' AND org_id = ?';
    values.push(options.orgId);
  }

  if (options?.verified !== undefined) {
    whereClause += ' AND verified = ?';
    values.push(options.verified ? 1 : 0);
  }

  if (options?.isActive !== undefined) {
    whereClause += ' AND is_active = ?';
    values.push(options.isActive ? 1 : 0);
  }

  // Get total count
  const countResult = await adapter.queryOne<{ count: number }>(
    `SELECT COUNT(*) as count FROM org_domain_mappings ${whereClause}`,
    values
  );

  const total = countResult?.count ?? 0;

  // Get mappings with pagination
  let query = `SELECT * FROM org_domain_mappings ${whereClause} ORDER BY priority DESC, created_at DESC`;
  const queryValues = [...values];

  if (options?.limit) {
    query += ' LIMIT ?';
    queryValues.push(options.limit);
    if (options.offset !== undefined) {
      query += ' OFFSET ?';
      queryValues.push(options.offset);
    }
  }

  const rows = await adapter.query<OrgDomainMappingRow>(query, queryValues);

  return {
    mappings: rows.map(rowToOrgDomainMapping),
    total,
  };
}

/**
 * Create a new domain mapping
 */
export async function createDomainMapping(
  db: DatabaseSource,
  tenantId: string,
  domainHash: string,
  domainHashVersion: number,
  orgId: string,
  options?: {
    autoJoinEnabled?: boolean;
    membershipType?: MembershipType;
    autoAssignRoleId?: string;
    verified?: boolean;
    priority?: number;
    isActive?: boolean;
  }
): Promise<OrgDomainMapping> {
  const adapter = getAdapter(db);
  const id = `odm_${crypto.randomUUID().replace(/-/g, '')}`;
  const now = Math.floor(Date.now() / 1000);

  await adapter.execute(
    `INSERT INTO org_domain_mappings (
      id, tenant_id, domain_hash, domain_hash_version, org_id,
      auto_join_enabled, membership_type, auto_assign_role_id,
      verified, priority, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      tenantId,
      domainHash,
      domainHashVersion,
      orgId,
      options?.autoJoinEnabled !== false ? 1 : 0,
      options?.membershipType ?? 'member',
      options?.autoAssignRoleId ?? null,
      options?.verified ? 1 : 0,
      options?.priority ?? 0,
      options?.isActive !== false ? 1 : 0,
      now,
      now,
    ]
  );

  return {
    id,
    tenant_id: tenantId,
    domain_hash: domainHash,
    domain_hash_version: domainHashVersion,
    org_id: orgId,
    auto_join_enabled: options?.autoJoinEnabled !== false,
    membership_type: options?.membershipType ?? 'member',
    auto_assign_role_id: options?.autoAssignRoleId,
    verified: options?.verified ?? false,
    priority: options?.priority ?? 0,
    is_active: options?.isActive !== false,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Update a domain mapping
 */
export async function updateDomainMapping(
  db: DatabaseSource,
  id: string,
  tenantId: string,
  updates: Partial<{
    autoJoinEnabled: boolean;
    membershipType: MembershipType;
    autoAssignRoleId: string | null;
    verified: boolean;
    priority: number;
    isActive: boolean;
  }>
): Promise<OrgDomainMapping | null> {
  const adapter = getAdapter(db);
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (updates.autoJoinEnabled !== undefined) {
    setClauses.push('auto_join_enabled = ?');
    values.push(updates.autoJoinEnabled ? 1 : 0);
  }

  if (updates.membershipType !== undefined) {
    setClauses.push('membership_type = ?');
    values.push(updates.membershipType);
  }

  if (updates.autoAssignRoleId !== undefined) {
    setClauses.push('auto_assign_role_id = ?');
    values.push(updates.autoAssignRoleId);
  }

  if (updates.verified !== undefined) {
    setClauses.push('verified = ?');
    values.push(updates.verified ? 1 : 0);
  }

  if (updates.priority !== undefined) {
    setClauses.push('priority = ?');
    values.push(updates.priority);
  }

  if (updates.isActive !== undefined) {
    setClauses.push('is_active = ?');
    values.push(updates.isActive ? 1 : 0);
  }

  if (setClauses.length === 0) {
    return getDomainMappingById(db, id, tenantId);
  }

  const now = Math.floor(Date.now() / 1000);
  setClauses.push('updated_at = ?');
  values.push(now, id, tenantId);

  await adapter.execute(
    `UPDATE org_domain_mappings SET ${setClauses.join(', ')} WHERE id = ? AND tenant_id = ?`,
    values
  );

  return getDomainMappingById(db, id, tenantId);
}

/**
 * Delete a domain mapping
 */
export async function deleteDomainMapping(
  db: DatabaseSource,
  id: string,
  tenantId: string
): Promise<boolean> {
  const adapter = getAdapter(db);
  const result = await adapter.execute(
    'DELETE FROM org_domain_mappings WHERE id = ? AND tenant_id = ?',
    [id, tenantId]
  );

  return result.rowsAffected > 0;
}

/**
 * Convert database row to OrgDomainMapping
 */
function rowToOrgDomainMapping(row: OrgDomainMappingRow): OrgDomainMapping {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    domain_hash: row.domain_hash,
    domain_hash_version: row.domain_hash_version,
    org_id: row.org_id,
    auto_join_enabled: row.auto_join_enabled === 1,
    membership_type: row.membership_type as MembershipType,
    auto_assign_role_id: row.auto_assign_role_id ?? undefined,
    verified: row.verified === 1,
    priority: row.priority,
    is_active: row.is_active === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// =============================================================================
// Key Rotation Helpers
// =============================================================================

/**
 * Update domain mapping hash version after key rotation
 *
 * @param db - D1 database instance
 * @param id - Mapping ID
 * @param newHash - New domain hash
 * @param newVersion - New hash version
 * @param tenantId - Tenant ID
 */
export async function updateDomainMappingHash(
  db: DatabaseSource,
  id: string,
  newHash: string,
  newVersion: number,
  tenantId: string
): Promise<void> {
  const adapter = getAdapter(db);
  const now = Math.floor(Date.now() / 1000);

  await adapter.execute(
    `UPDATE org_domain_mappings
     SET domain_hash = ?, domain_hash_version = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ?`,
    [newHash, newVersion, now, id, tenantId]
  );
}

/**
 * Get count of mappings by hash version
 * Used for key rotation status reporting
 */
export async function getMappingCountByVersion(
  db: DatabaseSource,
  tenantId: string
): Promise<Record<number, number>> {
  const adapter = getAdapter(db);
  const rows = await adapter.query<{ domain_hash_version: number; count: number }>(
    `SELECT domain_hash_version, COUNT(*) as count
     FROM org_domain_mappings
     WHERE tenant_id = ?
     GROUP BY domain_hash_version`,
    [tenantId]
  );

  const counts: Record<number, number> = {};
  for (const row of rows) {
    counts[row.domain_hash_version] = row.count;
  }

  return counts;
}
