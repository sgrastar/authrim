/**
 * Status List Repository (D1 Implementation)
 *
 * Repository for managing Bitstring Status List records.
 * Implements the StatusListRepository interface for D1 database.
 */

import type { DatabaseAdapter } from '../../db/adapter';
import type {
  StatusListRepository as IStatusListRepository,
  StatusListRecord,
  StatusListPurpose,
  StatusListState,
} from '../../vc/status-list-manager';

/**
 * D1 Status List Repository Implementation
 *
 * Named D1StatusListRepository to avoid conflict with the interface from status-list-manager.
 */
export class D1StatusListRepository implements IStatusListRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  /**
   * Find active status list for tenant/purpose
   */
  async findActiveList(
    tenantId: string,
    purpose: StatusListPurpose
  ): Promise<StatusListRecord | null> {
    return this.adapter.queryOne<StatusListRecord>(
      `SELECT * FROM status_lists
       WHERE tenant_id = ? AND purpose = ? AND state = 'active'
       ORDER BY created_at DESC
       LIMIT 1`,
      [tenantId, purpose]
    );
  }

  /**
   * Find status list by ID
   */
  async findById(listId: string): Promise<StatusListRecord | null> {
    return this.adapter.queryOne<StatusListRecord>('SELECT * FROM status_lists WHERE id = ?', [
      listId,
    ]);
  }

  /**
   * Create new status list
   */
  async create(record: Omit<StatusListRecord, 'created_at' | 'updated_at'>): Promise<void> {
    const now = new Date().toISOString();
    const sql = `
      INSERT INTO status_lists (
        id, tenant_id, purpose, encoded_list, current_index,
        capacity, used_count, state, sealed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.adapter.execute(sql, [
      record.id,
      record.tenant_id,
      record.purpose,
      record.encoded_list,
      record.current_index,
      record.capacity,
      record.used_count,
      record.state,
      record.sealed_at,
      now,
      now,
    ]);
  }

  /**
   * Update status list
   */
  async update(
    listId: string,
    updates: Partial<Pick<StatusListRecord, 'encoded_list' | 'used_count' | 'state' | 'sealed_at'>>
  ): Promise<void> {
    const now = new Date().toISOString();
    const setClauses: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (updates.encoded_list !== undefined) {
      setClauses.push('encoded_list = ?');
      values.push(updates.encoded_list);
    }
    if (updates.used_count !== undefined) {
      setClauses.push('used_count = ?');
      values.push(updates.used_count);
    }
    if (updates.state !== undefined) {
      setClauses.push('state = ?');
      values.push(updates.state);
    }
    if (updates.sealed_at !== undefined) {
      setClauses.push('sealed_at = ?');
      values.push(updates.sealed_at);
    }

    values.push(listId);

    const sql = `UPDATE status_lists SET ${setClauses.join(', ')} WHERE id = ?`;
    await this.adapter.execute(sql, values);
  }

  /**
   * Increment used_count and return new count (atomic)
   */
  async incrementUsedCount(listId: string): Promise<number> {
    const now = new Date().toISOString();

    // D1 doesn't support RETURNING, so we need two queries
    await this.adapter.execute(
      'UPDATE status_lists SET used_count = used_count + 1, updated_at = ? WHERE id = ?',
      [now, listId]
    );

    const result = await this.adapter.queryOne<{ used_count: number }>(
      'SELECT used_count FROM status_lists WHERE id = ?',
      [listId]
    );

    if (!result) {
      throw new Error(`Status list not found: ${listId}`);
    }

    return result.used_count;
  }

  /**
   * List all status lists for tenant
   */
  async listByTenant(
    tenantId: string,
    options?: { purpose?: StatusListPurpose; state?: StatusListState }
  ): Promise<StatusListRecord[]> {
    const conditions: string[] = ['tenant_id = ?'];
    const values: unknown[] = [tenantId];

    if (options?.purpose) {
      conditions.push('purpose = ?');
      values.push(options.purpose);
    }
    if (options?.state) {
      conditions.push('state = ?');
      values.push(options.state);
    }

    const sql = `SELECT * FROM status_lists WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`;
    return this.adapter.query<StatusListRecord>(sql, values);
  }

  /**
   * Archive old sealed lists
   */
  async archiveSealedLists(tenantId: string, olderThanDays: number = 365): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
    const cutoffIso = cutoffDate.toISOString();

    const result = await this.adapter.execute(
      `UPDATE status_lists SET state = 'archived', updated_at = ?
       WHERE tenant_id = ? AND state = 'sealed' AND sealed_at < ?`,
      [new Date().toISOString(), tenantId, cutoffIso]
    );

    return result.rowsAffected;
  }

  /**
   * Get statistics for tenant
   */
  async getStats(tenantId: string): Promise<{
    total: number;
    active: number;
    sealed: number;
    archived: number;
    totalCapacity: number;
    totalUsed: number;
  }> {
    const results = await this.adapter.query<{
      state: StatusListState;
      count: number;
      total_capacity: number;
      total_used: number;
    }>(
      `SELECT state, COUNT(*) as count,
              SUM(capacity) as total_capacity,
              SUM(used_count) as total_used
       FROM status_lists
       WHERE tenant_id = ?
       GROUP BY state`,
      [tenantId]
    );

    const stats = {
      total: 0,
      active: 0,
      sealed: 0,
      archived: 0,
      totalCapacity: 0,
      totalUsed: 0,
    };

    for (const row of results) {
      const count = row.count;
      stats.total += count;
      stats.totalCapacity += row.total_capacity || 0;
      stats.totalUsed += row.total_used || 0;

      if (row.state === 'active') stats.active = count;
      else if (row.state === 'sealed') stats.sealed = count;
      else if (row.state === 'archived') stats.archived = count;
    }

    return stats;
  }
}
