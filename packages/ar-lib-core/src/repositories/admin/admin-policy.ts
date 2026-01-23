/**
 * Admin Policy Repository
 *
 * Repository for Admin policies stored in DB_ADMIN.
 * Manages combined RBAC/ABAC/ReBAC policies for Admin access control.
 */

import type { DatabaseAdapter } from '../../db/adapter';
import { BaseRepository, type BaseEntity, generateId, getCurrentTimestamp } from '../base';

/**
 * Admin policy entity
 */
export interface AdminPolicyEntity extends BaseEntity {
  tenant_id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  effect: string;
  priority: number;
  resource_pattern: string;
  actions_json: string;
  conditions_json: string;
  is_active: boolean;
  is_system: boolean;
}

/**
 * Policy conditions structure
 */
export interface AdminPolicyConditions {
  roles?: string[];
  attributes?: Record<
    string,
    {
      equals?: string | number | boolean;
      not_equals?: string | number | boolean;
      contains?: string;
      in?: (string | number)[];
      gte?: number;
      lte?: number;
      gt?: number;
      lt?: number;
    }
  >;
  relationships?: Record<
    string,
    {
      target_type?: string;
      permission_level?: string;
    }
  >;
  condition_type?: 'all' | 'any';
}

/**
 * Admin policy (API model)
 */
export interface AdminPolicy {
  id: string;
  tenant_id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  effect: 'allow' | 'deny';
  priority: number;
  resource_pattern: string;
  actions: string[];
  conditions: AdminPolicyConditions;
  is_active: boolean;
  is_system: boolean;
  created_at: number;
  updated_at: number;
}

/**
 * Admin policy create input
 */
export interface AdminPolicyCreateInput {
  tenant_id?: string;
  name: string;
  display_name?: string;
  description?: string;
  effect?: 'allow' | 'deny';
  priority?: number;
  resource_pattern: string;
  actions?: string[];
  conditions?: AdminPolicyConditions;
}

/**
 * Admin Policy Repository
 */
export class AdminPolicyRepository extends BaseRepository<AdminPolicyEntity> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'admin_policies',
      primaryKey: 'id',
      softDelete: false,
      allowedFields: [
        'tenant_id',
        'name',
        'display_name',
        'description',
        'effect',
        'priority',
        'resource_pattern',
        'actions_json',
        'conditions_json',
        'is_active',
        'is_system',
      ],
    });
  }

  /**
   * Create a new Admin policy
   */
  async createPolicy(input: AdminPolicyCreateInput): Promise<AdminPolicy> {
    const id = generateId();
    const now = getCurrentTimestamp();

    const entity: AdminPolicyEntity = {
      id,
      tenant_id: input.tenant_id ?? 'default',
      name: input.name,
      display_name: input.display_name ?? null,
      description: input.description ?? null,
      effect: input.effect ?? 'allow',
      priority: input.priority ?? 0,
      resource_pattern: input.resource_pattern,
      actions_json: JSON.stringify(input.actions ?? ['*']),
      conditions_json: JSON.stringify(input.conditions ?? {}),
      is_active: true,
      is_system: false,
      created_at: now,
      updated_at: now,
    };

    const sql = `
      INSERT INTO admin_policies (
        id, tenant_id, name, display_name, description,
        effect, priority, resource_pattern, actions_json, conditions_json,
        is_active, is_system, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.adapter.execute(sql, [
      entity.id,
      entity.tenant_id,
      entity.name,
      entity.display_name,
      entity.description,
      entity.effect,
      entity.priority,
      entity.resource_pattern,
      entity.actions_json,
      entity.conditions_json,
      entity.is_active ? 1 : 0,
      entity.is_system ? 1 : 0,
      entity.created_at,
      entity.updated_at,
    ]);

    return this.entityToPolicy(entity);
  }

  /**
   * Get policy by ID
   */
  async getPolicy(id: string): Promise<AdminPolicy | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM admin_policies WHERE id = ?',
      [id]
    );
    return row ? this.rowToPolicy(row) : null;
  }

  /**
   * Get policy by name
   */
  async getPolicyByName(tenantId: string, name: string): Promise<AdminPolicy | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM admin_policies WHERE tenant_id = ? AND name = ?',
      [tenantId, name]
    );
    return row ? this.rowToPolicy(row) : null;
  }

  /**
   * List all policies for a tenant
   */
  async listPolicies(
    tenantId: string,
    options?: {
      activeOnly?: boolean;
      resourcePattern?: string;
      limit?: number;
      offset?: number;
    }
  ): Promise<{ policies: AdminPolicy[]; total: number }> {
    let countSql = 'SELECT COUNT(*) as count FROM admin_policies WHERE tenant_id = ?';
    let sql = 'SELECT * FROM admin_policies WHERE tenant_id = ?';
    const params: unknown[] = [tenantId];

    if (options?.activeOnly) {
      countSql += ' AND is_active = 1';
      sql += ' AND is_active = 1';
    }

    if (options?.resourcePattern) {
      countSql += ' AND resource_pattern LIKE ?';
      sql += ' AND resource_pattern LIKE ?';
      params.push(`${options.resourcePattern}%`);
    }

    sql += ' ORDER BY priority DESC, created_at DESC';

    const countResult = await this.adapter.queryOne<{ count: number }>(
      countSql,
      params.slice(0, params.length)
    );
    const total = countResult?.count ?? 0;

    if (options?.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }
    if (options?.offset) {
      sql += ' OFFSET ?';
      params.push(options.offset);
    }

    const rows = await this.adapter.query<Record<string, unknown>>(sql, params);
    const policies = rows.map((row) => this.rowToPolicy(row));

    return { policies, total };
  }

  /**
   * Get policies matching a resource
   */
  async getPoliciesForResource(
    tenantId: string,
    resource: string,
    action: string
  ): Promise<AdminPolicy[]> {
    // Get all active policies and filter in memory
    // (More complex pattern matching would require SQL GLOB or LIKE)
    const rows = await this.adapter.query<Record<string, unknown>>(
      `SELECT * FROM admin_policies
       WHERE tenant_id = ? AND is_active = 1
       ORDER BY priority DESC`,
      [tenantId]
    );

    const policies = rows.map((row) => this.rowToPolicy(row));

    // Filter policies that match the resource and action
    return policies.filter((policy) => {
      const resourceMatch = this.matchPattern(resource, policy.resource_pattern);
      const actionMatch = policy.actions.includes('*') || policy.actions.includes(action);
      return resourceMatch && actionMatch;
    });
  }

  /**
   * Update policy
   */
  async updatePolicy(
    id: string,
    updates: Partial<Omit<AdminPolicyCreateInput, 'tenant_id' | 'name'>>
  ): Promise<AdminPolicy | null> {
    const existing = await this.getPolicy(id);
    if (!existing || existing.is_system) {
      return null;
    }

    const now = getCurrentTimestamp();
    const setClauses: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    if (updates.display_name !== undefined) {
      setClauses.push('display_name = ?');
      params.push(updates.display_name);
    }
    if (updates.description !== undefined) {
      setClauses.push('description = ?');
      params.push(updates.description);
    }
    if (updates.effect !== undefined) {
      setClauses.push('effect = ?');
      params.push(updates.effect);
    }
    if (updates.priority !== undefined) {
      setClauses.push('priority = ?');
      params.push(updates.priority);
    }
    if (updates.resource_pattern !== undefined) {
      setClauses.push('resource_pattern = ?');
      params.push(updates.resource_pattern);
    }
    if (updates.actions !== undefined) {
      setClauses.push('actions_json = ?');
      params.push(JSON.stringify(updates.actions));
    }
    if (updates.conditions !== undefined) {
      setClauses.push('conditions_json = ?');
      params.push(JSON.stringify(updates.conditions));
    }

    params.push(id);

    await this.adapter.execute(
      `UPDATE admin_policies SET ${setClauses.join(', ')} WHERE id = ?`,
      params
    );

    return this.getPolicy(id);
  }

  /**
   * Activate/deactivate policy
   */
  async setActive(id: string, isActive: boolean): Promise<boolean> {
    const now = getCurrentTimestamp();
    const result = await this.adapter.execute(
      'UPDATE admin_policies SET is_active = ?, updated_at = ? WHERE id = ? AND is_system = 0',
      [isActive ? 1 : 0, now, id]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Delete policy
   */
  async deletePolicy(id: string): Promise<boolean> {
    const result = await this.adapter.execute(
      'DELETE FROM admin_policies WHERE id = ? AND is_system = 0',
      [id]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Match resource against pattern
   * Supports: * (wildcard), exact match
   */
  private matchPattern(resource: string, pattern: string): boolean {
    if (pattern === '*') return true;

    // Convert pattern to regex
    const regexPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');

    return new RegExp(`^${regexPattern}$`).test(resource);
  }

  /**
   * Convert database row to AdminPolicy
   */
  private rowToPolicy(row: Record<string, unknown>): AdminPolicy {
    let actions: string[] = ['*'];
    let conditions: AdminPolicyConditions = {};

    try {
      actions = JSON.parse(row.actions_json as string);
    } catch {
      actions = ['*'];
    }

    try {
      conditions = JSON.parse(row.conditions_json as string);
    } catch {
      conditions = {};
    }

    return {
      id: row.id as string,
      tenant_id: row.tenant_id as string,
      name: row.name as string,
      display_name: row.display_name as string | null,
      description: row.description as string | null,
      effect: row.effect as 'allow' | 'deny',
      priority: row.priority as number,
      resource_pattern: row.resource_pattern as string,
      actions,
      conditions,
      is_active: Boolean(row.is_active),
      is_system: Boolean(row.is_system),
      created_at: row.created_at as number,
      updated_at: row.updated_at as number,
    };
  }

  /**
   * Convert entity to AdminPolicy
   */
  private entityToPolicy(entity: AdminPolicyEntity): AdminPolicy {
    let actions: string[] = ['*'];
    let conditions: AdminPolicyConditions = {};

    try {
      actions = JSON.parse(entity.actions_json);
    } catch {
      actions = ['*'];
    }

    try {
      conditions = JSON.parse(entity.conditions_json);
    } catch {
      conditions = {};
    }

    return {
      id: entity.id,
      tenant_id: entity.tenant_id,
      name: entity.name,
      display_name: entity.display_name,
      description: entity.description,
      effect: entity.effect as 'allow' | 'deny',
      priority: entity.priority,
      resource_pattern: entity.resource_pattern,
      actions,
      conditions,
      is_active: entity.is_active,
      is_system: entity.is_system,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
    };
  }
}
