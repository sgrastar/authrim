/**
 * Organization Store Implementation
 *
 * Manages organizations and subject-organization memberships in D1.
 * Part of RBAC Phase 1 implementation.
 */

import type { IStorageAdapter } from '../interfaces';
import type {
  Organization,
  OrganizationRow,
  SubjectOrgMembership,
  SubjectOrgMembershipRow,
  IOrganizationStore,
} from '../interfaces';

/**
 * Convert D1 row to Organization entity
 */
function rowToOrganization(row: OrganizationRow): Organization {
  return {
    ...row,
    is_active: row.is_active === 1,
    metadata_json: row.metadata_json ?? undefined,
    display_name: row.display_name ?? undefined,
    description: row.description ?? undefined,
    parent_org_id: row.parent_org_id ?? undefined,
  };
}

/**
 * Convert D1 row to SubjectOrgMembership entity
 */
function rowToMembership(row: SubjectOrgMembershipRow): SubjectOrgMembership {
  return {
    ...row,
    is_primary: row.is_primary === 1,
  };
}

/**
 * OrganizationStore implementation (D1-based)
 */
export class OrganizationStore implements IOrganizationStore {
  constructor(private adapter: IStorageAdapter) {}

  // ==========================================================================
  // Organization CRUD
  // ==========================================================================

  async getOrganization(orgId: string): Promise<Organization | null> {
    const results = await this.adapter.query<OrganizationRow>(
      'SELECT * FROM organizations WHERE id = ?',
      [orgId]
    );
    return results[0] ? rowToOrganization(results[0]) : null;
  }

  async getOrganizationByName(tenantId: string, name: string): Promise<Organization | null> {
    const results = await this.adapter.query<OrganizationRow>(
      'SELECT * FROM organizations WHERE tenant_id = ? AND name = ?',
      [tenantId, name]
    );
    return results[0] ? rowToOrganization(results[0]) : null;
  }

  async createOrganization(
    org: Omit<Organization, 'id' | 'created_at' | 'updated_at'>
  ): Promise<Organization> {
    const id = `org_${crypto.randomUUID().replace(/-/g, '')}`;
    const now = Math.floor(Date.now() / 1000); // UNIX seconds

    const newOrg: Organization = {
      id,
      tenant_id: org.tenant_id,
      name: org.name,
      display_name: org.display_name,
      description: org.description,
      org_type: org.org_type,
      parent_org_id: org.parent_org_id,
      plan: org.plan,
      is_active: org.is_active,
      metadata_json: org.metadata_json,
      created_at: now,
      updated_at: now,
    };

    await this.adapter.execute(
      `INSERT INTO organizations (
        id, tenant_id, name, display_name, description, org_type,
        parent_org_id, plan, is_active, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newOrg.id,
        newOrg.tenant_id,
        newOrg.name,
        newOrg.display_name ?? null,
        newOrg.description ?? null,
        newOrg.org_type,
        newOrg.parent_org_id ?? null,
        newOrg.plan,
        newOrg.is_active ? 1 : 0,
        newOrg.metadata_json ?? null,
        newOrg.created_at,
        newOrg.updated_at,
      ]
    );

    return newOrg;
  }

  async updateOrganization(orgId: string, updates: Partial<Organization>): Promise<Organization> {
    const existing = await this.getOrganization(orgId);
    if (!existing) {
      throw new Error(`Organization not found: ${orgId}`);
    }

    const now = Math.floor(Date.now() / 1000); // UNIX seconds
    const updated: Organization = {
      ...existing,
      ...updates,
      id: orgId, // Prevent changing ID
      updated_at: now,
    };

    await this.adapter.execute(
      `UPDATE organizations SET
        name = ?, display_name = ?, description = ?, org_type = ?,
        parent_org_id = ?, plan = ?, is_active = ?, metadata_json = ?,
        updated_at = ?
      WHERE id = ?`,
      [
        updated.name,
        updated.display_name ?? null,
        updated.description ?? null,
        updated.org_type,
        updated.parent_org_id ?? null,
        updated.plan,
        updated.is_active ? 1 : 0,
        updated.metadata_json ?? null,
        updated.updated_at,
        orgId,
      ]
    );

    return updated;
  }

  async deleteOrganization(orgId: string): Promise<void> {
    await this.adapter.execute('DELETE FROM organizations WHERE id = ?', [orgId]);
  }

  async listOrganizations(
    tenantId: string,
    options?: { limit?: number; offset?: number; parentOrgId?: string }
  ): Promise<Organization[]> {
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;

    let sql = 'SELECT * FROM organizations WHERE tenant_id = ?';
    const params: unknown[] = [tenantId];

    if (options?.parentOrgId !== undefined) {
      if (options.parentOrgId === null || options.parentOrgId === '') {
        sql += ' AND parent_org_id IS NULL';
      } else {
        sql += ' AND parent_org_id = ?';
        params.push(options.parentOrgId);
      }
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const results = await this.adapter.query<OrganizationRow>(sql, params);
    return results.map(rowToOrganization);
  }

  // ==========================================================================
  // Membership CRUD
  // ==========================================================================

  async getMembership(membershipId: string): Promise<SubjectOrgMembership | null> {
    const results = await this.adapter.query<SubjectOrgMembershipRow>(
      'SELECT * FROM subject_org_membership WHERE id = ?',
      [membershipId]
    );
    return results[0] ? rowToMembership(results[0]) : null;
  }

  async getMembershipBySubjectAndOrg(
    subjectId: string,
    orgId: string
  ): Promise<SubjectOrgMembership | null> {
    const results = await this.adapter.query<SubjectOrgMembershipRow>(
      'SELECT * FROM subject_org_membership WHERE subject_id = ? AND org_id = ?',
      [subjectId, orgId]
    );
    return results[0] ? rowToMembership(results[0]) : null;
  }

  async createMembership(
    membership: Omit<SubjectOrgMembership, 'id' | 'created_at' | 'updated_at'>
  ): Promise<SubjectOrgMembership> {
    const id = `mem_${crypto.randomUUID().replace(/-/g, '')}`;
    const now = Math.floor(Date.now() / 1000); // UNIX seconds

    const newMembership: SubjectOrgMembership = {
      id,
      tenant_id: membership.tenant_id,
      subject_id: membership.subject_id,
      org_id: membership.org_id,
      membership_type: membership.membership_type,
      is_primary: membership.is_primary,
      created_at: now,
      updated_at: now,
    };

    // If this is being set as primary, unset any existing primary
    if (newMembership.is_primary) {
      await this.adapter.execute(
        `UPDATE subject_org_membership SET is_primary = 0, updated_at = ?
         WHERE subject_id = ? AND is_primary = 1`,
        [now, membership.subject_id]
      );
    }

    await this.adapter.execute(
      `INSERT INTO subject_org_membership (
        id, tenant_id, subject_id, org_id, membership_type, is_primary,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newMembership.id,
        newMembership.tenant_id,
        newMembership.subject_id,
        newMembership.org_id,
        newMembership.membership_type,
        newMembership.is_primary ? 1 : 0,
        newMembership.created_at,
        newMembership.updated_at,
      ]
    );

    return newMembership;
  }

  async updateMembership(
    membershipId: string,
    updates: Partial<SubjectOrgMembership>
  ): Promise<SubjectOrgMembership> {
    const existing = await this.getMembership(membershipId);
    if (!existing) {
      throw new Error(`Membership not found: ${membershipId}`);
    }

    const now = Math.floor(Date.now() / 1000); // UNIX seconds
    const updated: SubjectOrgMembership = {
      ...existing,
      ...updates,
      id: membershipId, // Prevent changing ID
      updated_at: now,
    };

    // If setting as primary, unset any existing primary for this subject
    if (updates.is_primary && !existing.is_primary) {
      await this.adapter.execute(
        `UPDATE subject_org_membership SET is_primary = 0, updated_at = ?
         WHERE subject_id = ? AND is_primary = 1 AND id != ?`,
        [now, existing.subject_id, membershipId]
      );
    }

    await this.adapter.execute(
      `UPDATE subject_org_membership SET
        membership_type = ?, is_primary = ?, updated_at = ?
      WHERE id = ?`,
      [updated.membership_type, updated.is_primary ? 1 : 0, updated.updated_at, membershipId]
    );

    return updated;
  }

  async deleteMembership(membershipId: string): Promise<void> {
    await this.adapter.execute('DELETE FROM subject_org_membership WHERE id = ?', [membershipId]);
  }

  // ==========================================================================
  // Membership queries
  // ==========================================================================

  async listMembershipsBySubject(subjectId: string): Promise<SubjectOrgMembership[]> {
    const results = await this.adapter.query<SubjectOrgMembershipRow>(
      'SELECT * FROM subject_org_membership WHERE subject_id = ? ORDER BY is_primary DESC, created_at ASC',
      [subjectId]
    );
    return results.map(rowToMembership);
  }

  async listMembershipsByOrg(
    orgId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<SubjectOrgMembership[]> {
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;

    const results = await this.adapter.query<SubjectOrgMembershipRow>(
      `SELECT * FROM subject_org_membership WHERE org_id = ?
       ORDER BY created_at ASC LIMIT ? OFFSET ?`,
      [orgId, limit, offset]
    );
    return results.map(rowToMembership);
  }

  async getPrimaryOrganization(subjectId: string): Promise<Organization | null> {
    const results = await this.adapter.query<OrganizationRow>(
      `SELECT o.* FROM organizations o
       JOIN subject_org_membership m ON o.id = m.org_id
       WHERE m.subject_id = ? AND m.is_primary = 1`,
      [subjectId]
    );
    return results[0] ? rowToOrganization(results[0]) : null;
  }
}
