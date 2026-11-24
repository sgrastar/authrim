/**
 * Admin IP Allowlist Repository
 *
 * Repository for IP-based access control stored in DB_ADMIN.
 * When the table is empty, all IPs are allowed (default behavior).
 * When entries exist, only matching IPs can access Admin panel.
 */

import type { DatabaseAdapter } from '../../db/adapter';
import { requireTenantId } from '../tenant';
import { adminIpMatchesRange } from '../../utils/admin-ip-match';
import { BaseRepository, type BaseEntity, generateId, getCurrentTimestamp } from '../base';
import type {
  AdminIpAllowlistEntry,
  AdminIpAllowlistCreateInput,
  AdminIpAllowlistUpdateInput,
} from '../../types/admin-user';

/**
 * Admin IP allowlist entity (extends BaseEntity for repository compatibility)
 */
interface AdminIpAllowlistEntity extends BaseEntity {
  tenant_id: string;
  ip_range: string;
  ip_version: 4 | 6;
  description: string | null;
  enabled: boolean;
  created_by: string | null;
}

/**
 * Admin IP Allowlist Repository
 */
export class AdminIpAllowlistRepository extends BaseRepository<AdminIpAllowlistEntity> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'admin_ip_allowlist',
      primaryKey: 'id',
      softDelete: false, // IP entries are hard deleted
      allowedFields: [
        'tenant_id',
        'ip_range',
        'ip_version',
        'description',
        'enabled',
        'created_by',
      ],
    });
  }

  /**
   * Create a new IP allowlist entry
   *
   * @param input - Entry creation input
   * @returns Created entry
   */
  async createEntry(input: AdminIpAllowlistCreateInput): Promise<AdminIpAllowlistEntry> {
    const id = generateId();
    const now = getCurrentTimestamp();

    // Detect IP version if not provided
    const ipVersion = input.ip_version ?? this.detectIpVersion(input.ip_range);

    const entry: AdminIpAllowlistEntity = {
      id,
      tenant_id: requireTenantId(input.tenant_id, 'Repository create'),
      ip_range: input.ip_range,
      ip_version: ipVersion,
      description: input.description ?? null,
      enabled: input.enabled ?? true,
      created_by: input.created_by ?? null,
      created_at: now,
      updated_at: now,
    };

    const sql = `
      INSERT INTO admin_ip_allowlist (
        id, tenant_id, ip_range, ip_version, description,
        enabled, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.adapter.execute(sql, [
      entry.id,
      entry.tenant_id,
      entry.ip_range,
      entry.ip_version,
      entry.description,
      entry.enabled ? 1 : 0,
      entry.created_by,
      entry.created_at,
      entry.updated_at,
    ]);

    return this.entityToEntry(entry);
  }

  /**
   * Update an IP allowlist entry
   *
   * @param id - Entry ID
   * @param input - Update input
   * @returns Updated entry or null if not found
   */
  async updateEntry(
    id: string,
    input: AdminIpAllowlistUpdateInput
  ): Promise<AdminIpAllowlistEntry | null> {
    const existing = await this.findById(id);
    if (!existing) {
      return null;
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (input.ip_range !== undefined) {
      updates.push('ip_range = ?');
      values.push(input.ip_range);

      // Update IP version if ip_range changed
      if (input.ip_version === undefined) {
        updates.push('ip_version = ?');
        values.push(this.detectIpVersion(input.ip_range));
      }
    }
    if (input.ip_version !== undefined) {
      updates.push('ip_version = ?');
      values.push(input.ip_version);
    }
    if (input.description !== undefined) {
      updates.push('description = ?');
      values.push(input.description);
    }
    if (input.enabled !== undefined) {
      updates.push('enabled = ?');
      values.push(input.enabled ? 1 : 0);
    }

    if (updates.length === 0) {
      return this.entityToEntry(existing);
    }

    updates.push('updated_at = ?');
    values.push(getCurrentTimestamp());
    values.push(id);

    const sql = `UPDATE admin_ip_allowlist SET ${updates.join(', ')} WHERE id = ?`;
    await this.adapter.execute(sql, values);

    const updated = await this.findById(id);
    return updated ? this.entityToEntry(updated) : null;
  }

  /**
   * Delete an IP allowlist entry
   *
   * @param id - Entry ID
   * @returns True if deleted
   */
  async deleteEntry(id: string): Promise<boolean> {
    const result = await this.adapter.execute('DELETE FROM admin_ip_allowlist WHERE id = ?', [id]);
    return result.rowsAffected > 0;
  }

  /**
   * Get all enabled entries for a tenant
   *
   * @param tenantId - Tenant ID
   * @returns List of enabled entries
   */
  async getEnabledEntries(tenantId: string): Promise<AdminIpAllowlistEntry[]> {
    const rows = await this.adapter.query<Record<string, unknown>>(
      'SELECT * FROM admin_ip_allowlist WHERE tenant_id = ? AND enabled = 1 ORDER BY created_at ASC',
      [tenantId]
    );
    return rows.map((row) => this.rowToEntry(row));
  }

  /**
   * Get all entries for a tenant (including disabled)
   *
   * @param tenantId - Tenant ID
   * @returns List of all entries
   */
  async getAllEntries(tenantId: string): Promise<AdminIpAllowlistEntry[]> {
    const rows = await this.adapter.query<Record<string, unknown>>(
      'SELECT * FROM admin_ip_allowlist WHERE tenant_id = ? ORDER BY created_at ASC',
      [tenantId]
    );
    return rows.map((row) => this.rowToEntry(row));
  }

  /**
   * Get entry by ID
   *
   * @param id - Entry ID
   * @returns Entry or null
   */
  async getEntry(id: string): Promise<AdminIpAllowlistEntry | null> {
    const entity = await this.findById(id);
    return entity ? this.entityToEntry(entity) : null;
  }

  /**
   * Check if an IP is allowed for a tenant
   *
   * @param tenantId - Tenant ID
   * @param ip - IP address to check
   * @returns True if allowed (or if no entries exist)
   */
  async isIpAllowed(tenantId: string, ip: string): Promise<boolean> {
    const entries = await this.getEnabledEntries(tenantId);

    // If no entries exist, allow all IPs (default behavior)
    if (entries.length === 0) {
      return true;
    }

    // Check if IP matches any entry
    for (const entry of entries) {
      if (this.ipMatchesEntry(ip, entry)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if entry already exists for this IP range
   *
   * @param tenantId - Tenant ID
   * @param ipRange - IP range to check
   * @returns True if exists
   */
  async entryExists(tenantId: string, ipRange: string): Promise<boolean> {
    const result = await this.adapter.queryOne<{ id: string }>(
      'SELECT id FROM admin_ip_allowlist WHERE tenant_id = ? AND ip_range = ? LIMIT 1',
      [tenantId, ipRange]
    );
    return result !== null;
  }

  /**
   * Count entries for a tenant
   *
   * @param tenantId - Tenant ID
   * @returns Number of entries
   */
  async countEntries(tenantId: string): Promise<number> {
    const result = await this.adapter.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM admin_ip_allowlist WHERE tenant_id = ?',
      [tenantId]
    );
    return result?.count ?? 0;
  }

  /**
   * Delete all entries for a tenant
   *
   * @param tenantId - Tenant ID
   * @returns Number of deleted entries
   */
  async deleteAllByTenant(tenantId: string): Promise<number> {
    const result = await this.adapter.execute(
      'DELETE FROM admin_ip_allowlist WHERE tenant_id = ?',
      [tenantId]
    );
    return result.rowsAffected;
  }

  /**
   * Enable an entry
   *
   * @param id - Entry ID
   * @returns True if updated
   */
  async enableEntry(id: string): Promise<boolean> {
    const now = getCurrentTimestamp();
    const result = await this.adapter.execute(
      'UPDATE admin_ip_allowlist SET enabled = 1, updated_at = ? WHERE id = ?',
      [now, id]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Disable an entry
   *
   * @param id - Entry ID
   * @returns True if updated
   */
  async disableEntry(id: string): Promise<boolean> {
    const now = getCurrentTimestamp();
    const result = await this.adapter.execute(
      'UPDATE admin_ip_allowlist SET enabled = 0, updated_at = ? WHERE id = ?',
      [now, id]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Detect IP version from IP address or CIDR
   */
  private detectIpVersion(ipRange: string): 4 | 6 {
    // Remove CIDR notation if present
    const ip = ipRange.split('/')[0];

    // Simple detection: IPv6 contains colons
    if (ip.includes(':')) {
      return 6;
    }

    return 4;
  }

  /**
   * Check if an IP matches an allowlist entry, by the rule the admin-auth middleware enforces
   * (a single copy of it, shared), so the check endpoint answers what enforcement would.
   */
  private ipMatchesEntry(ip: string, entry: AdminIpAllowlistEntry): boolean {
    return adminIpMatchesRange(ip, entry.ip_range);
  }

  /**
   * Map database row to entry
   */
  private rowToEntry(row: Record<string, unknown>): AdminIpAllowlistEntry {
    return {
      id: row.id as string,
      tenant_id: row.tenant_id as string,
      ip_range: row.ip_range as string,
      ip_version: row.ip_version as 4 | 6,
      description: row.description as string | null,
      enabled: Boolean(row.enabled),
      created_by: row.created_by as string | null,
      created_at: row.created_at as number,
      updated_at: row.updated_at as number,
    };
  }

  /**
   * Convert entity to AdminIpAllowlistEntry type
   */
  private entityToEntry(entity: AdminIpAllowlistEntity): AdminIpAllowlistEntry {
    return {
      id: entity.id,
      tenant_id: entity.tenant_id,
      ip_range: entity.ip_range,
      ip_version: entity.ip_version,
      description: entity.description,
      enabled: entity.enabled,
      created_by: entity.created_by,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
    };
  }
}
