/**
 * Admin IP Allowlist Repository
 *
 * Repository for IP-based access control stored in DB_ADMIN.
 * When the table is empty, all IPs are allowed (default behavior).
 * When entries exist, only matching IPs can access Admin panel.
 */

import type { DatabaseAdapter } from '../../db/adapter';
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
      tenant_id: input.tenant_id ?? 'default',
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
   * Check if an IP matches an allowlist entry
   *
   * @param ip - IP address to check
   * @param entry - Allowlist entry
   * @returns True if IP matches
   */
  private ipMatchesEntry(ip: string, entry: AdminIpAllowlistEntry): boolean {
    const ipRange = entry.ip_range;

    // Check for CIDR notation
    if (ipRange.includes('/')) {
      return this.ipMatchesCidr(ip, ipRange);
    }

    // Exact match
    return ip === ipRange;
  }

  /**
   * Check if an IP matches a CIDR range
   *
   * @param ip - IP address to check
   * @param cidr - CIDR notation (e.g., 192.168.1.0/24)
   * @returns True if IP is in CIDR range
   */
  private ipMatchesCidr(ip: string, cidr: string): boolean {
    const [rangeIp, prefixLengthStr] = cidr.split('/');
    const prefixLength = parseInt(prefixLengthStr, 10);

    // IPv4 handling
    if (!ip.includes(':') && !rangeIp.includes(':')) {
      return this.ipv4MatchesCidr(ip, rangeIp, prefixLength);
    }

    // IPv6 handling
    if (ip.includes(':') && rangeIp.includes(':')) {
      return this.ipv6MatchesCidr(ip, rangeIp, prefixLength);
    }

    // IP version mismatch
    return false;
  }

  /**
   * Check if IPv4 matches CIDR
   */
  private ipv4MatchesCidr(ip: string, rangeIp: string, prefixLength: number): boolean {
    const ipBinary = this.ipv4ToBinary(ip);
    const rangeBinary = this.ipv4ToBinary(rangeIp);

    if (!ipBinary || !rangeBinary) {
      return false;
    }

    // Compare prefix bits
    const mask = (-1 << (32 - prefixLength)) >>> 0;
    return (ipBinary & mask) === (rangeBinary & mask);
  }

  /**
   * Convert IPv4 address to 32-bit integer
   */
  private ipv4ToBinary(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) {
      return null;
    }

    let result = 0;
    for (const part of parts) {
      const num = parseInt(part, 10);
      if (isNaN(num) || num < 0 || num > 255) {
        return null;
      }
      result = (result << 8) | num;
    }

    return result >>> 0; // Convert to unsigned
  }

  /**
   * Check if IPv6 matches CIDR (simplified)
   */
  private ipv6MatchesCidr(ip: string, rangeIp: string, prefixLength: number): boolean {
    // Expand IPv6 addresses to full form
    const expandedIp = this.expandIpv6(ip);
    const expandedRange = this.expandIpv6(rangeIp);

    if (!expandedIp || !expandedRange) {
      return false;
    }

    // Convert to hexadecimal string and compare prefix
    const ipHex = expandedIp.replace(/:/g, '');
    const rangeHex = expandedRange.replace(/:/g, '');

    // Calculate number of hex characters to compare
    const hexChars = Math.ceil(prefixLength / 4);
    const remainingBits = prefixLength % 4;

    // Compare full hex characters
    if (
      ipHex.substring(0, hexChars - (remainingBits > 0 ? 1 : 0)) !==
      rangeHex.substring(0, hexChars - (remainingBits > 0 ? 1 : 0))
    ) {
      return false;
    }

    // Compare remaining bits if any
    if (remainingBits > 0) {
      const ipNibble = parseInt(ipHex[hexChars - 1], 16);
      const rangeNibble = parseInt(rangeHex[hexChars - 1], 16);
      const mask = (0xf << (4 - remainingBits)) & 0xf;
      if ((ipNibble & mask) !== (rangeNibble & mask)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Expand IPv6 address to full form
   */
  private expandIpv6(ip: string): string | null {
    // Handle :: expansion
    if (ip.includes('::')) {
      const parts = ip.split('::');
      if (parts.length > 2) {
        return null;
      }

      const leftParts = parts[0] ? parts[0].split(':') : [];
      const rightParts = parts[1] ? parts[1].split(':') : [];
      const missingParts = 8 - leftParts.length - rightParts.length;

      const allParts = [...leftParts, ...Array(missingParts).fill('0'), ...rightParts];

      if (allParts.length !== 8) {
        return null;
      }

      return allParts.map((p) => p.padStart(4, '0')).join(':');
    }

    // Already in full form
    const parts = ip.split(':');
    if (parts.length !== 8) {
      return null;
    }

    return parts.map((p) => p.padStart(4, '0')).join(':');
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
