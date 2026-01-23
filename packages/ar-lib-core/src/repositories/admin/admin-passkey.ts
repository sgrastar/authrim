/**
 * Admin Passkey Repository
 *
 * Repository for Admin WebAuthn/Passkey credentials stored in DB_ADMIN.
 * Enables passwordless authentication for admin accounts.
 */

import type { DatabaseAdapter } from '../../db/adapter';
import { BaseRepository, type BaseEntity, generateId, getCurrentTimestamp } from '../base';
import type { AdminPasskey, AdminPasskeyCreateInput } from '../../types/admin-user';

/**
 * Admin passkey entity (extends BaseEntity for repository compatibility)
 */
interface AdminPasskeyEntity extends BaseEntity {
  admin_user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  device_name: string | null;
  transports_json: string | null;
  attestation_type: string | null;
  aaguid: string | null;
  last_used_at: number | null;
}

/**
 * Admin Passkey Repository
 */
export class AdminPasskeyRepository extends BaseRepository<AdminPasskeyEntity> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'admin_passkeys',
      primaryKey: 'id',
      softDelete: false, // Passkeys are hard deleted
      allowedFields: [
        'admin_user_id',
        'credential_id',
        'public_key',
        'counter',
        'device_name',
        'transports_json',
        'attestation_type',
        'aaguid',
        'last_used_at',
      ],
    });
  }

  /**
   * Create a new Admin passkey
   *
   * @param input - Passkey creation input
   * @returns Created passkey
   */
  async createPasskey(input: AdminPasskeyCreateInput): Promise<AdminPasskey> {
    const id = generateId();
    const now = getCurrentTimestamp();

    const passkey: AdminPasskeyEntity = {
      id,
      admin_user_id: input.admin_user_id,
      credential_id: input.credential_id,
      public_key: input.public_key,
      counter: input.counter ?? 0,
      device_name: input.device_name ?? null,
      transports_json: input.transports ? JSON.stringify(input.transports) : null,
      attestation_type: input.attestation_type ?? null,
      aaguid: input.aaguid ?? null,
      created_at: now,
      updated_at: now,
      last_used_at: null,
    };

    const sql = `
      INSERT INTO admin_passkeys (
        id, admin_user_id, credential_id, public_key, counter,
        device_name, transports_json, attestation_type, aaguid,
        created_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.adapter.execute(sql, [
      passkey.id,
      passkey.admin_user_id,
      passkey.credential_id,
      passkey.public_key,
      passkey.counter,
      passkey.device_name,
      passkey.transports_json,
      passkey.attestation_type,
      passkey.aaguid,
      passkey.created_at,
      passkey.last_used_at,
    ]);

    return this.entityToPasskey(passkey);
  }

  /**
   * Find passkey by credential ID (for authentication)
   *
   * @param credentialId - Base64url-encoded credential ID
   * @returns Passkey or null
   */
  async findByCredentialId(credentialId: string): Promise<AdminPasskey | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM admin_passkeys WHERE credential_id = ?',
      [credentialId]
    );
    return row ? this.rowToPasskey(row) : null;
  }

  /**
   * Get passkey by ID
   *
   * @param id - Passkey ID
   * @returns Passkey or null
   */
  async getPasskey(id: string): Promise<AdminPasskey | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM admin_passkeys WHERE id = ?',
      [id]
    );
    return row ? this.rowToPasskey(row) : null;
  }

  /**
   * Get all passkeys for an Admin user
   *
   * @param adminUserId - Admin user ID
   * @returns List of passkeys
   */
  async getPasskeysByUser(adminUserId: string): Promise<AdminPasskey[]> {
    const rows = await this.adapter.query<Record<string, unknown>>(
      'SELECT * FROM admin_passkeys WHERE admin_user_id = ? ORDER BY created_at DESC',
      [adminUserId]
    );
    return rows.map((row) => this.rowToPasskey(row));
  }

  /**
   * Update passkey counter (after successful authentication)
   *
   * @param id - Passkey ID
   * @param newCounter - New counter value (must be greater than previous)
   * @returns True if updated
   */
  async updateCounter(id: string, newCounter: number): Promise<boolean> {
    const now = getCurrentTimestamp();
    const result = await this.adapter.execute(
      'UPDATE admin_passkeys SET counter = ?, last_used_at = ? WHERE id = ? AND counter < ?',
      [newCounter, now, id, newCounter]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Update passkey device name
   *
   * @param id - Passkey ID
   * @param deviceName - New device name
   * @returns True if updated
   */
  async updateDeviceName(id: string, deviceName: string): Promise<boolean> {
    const result = await this.adapter.execute(
      'UPDATE admin_passkeys SET device_name = ? WHERE id = ?',
      [deviceName, id]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Delete a passkey
   *
   * @param id - Passkey ID
   * @returns True if deleted
   */
  async deletePasskey(id: string): Promise<boolean> {
    const result = await this.adapter.execute('DELETE FROM admin_passkeys WHERE id = ?', [id]);
    return result.rowsAffected > 0;
  }

  /**
   * Delete all passkeys for an Admin user
   *
   * @param adminUserId - Admin user ID
   * @returns Number of deleted passkeys
   */
  async deleteAllByUser(adminUserId: string): Promise<number> {
    const result = await this.adapter.execute(
      'DELETE FROM admin_passkeys WHERE admin_user_id = ?',
      [adminUserId]
    );
    return result.rowsAffected;
  }

  /**
   * Count passkeys for an Admin user
   *
   * @param adminUserId - Admin user ID
   * @returns Number of passkeys
   */
  async countByUser(adminUserId: string): Promise<number> {
    const result = await this.adapter.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM admin_passkeys WHERE admin_user_id = ?',
      [adminUserId]
    );
    return result?.count ?? 0;
  }

  /**
   * Check if passkey credential ID already exists
   *
   * @param credentialId - Credential ID to check
   * @returns True if exists
   */
  async credentialExists(credentialId: string): Promise<boolean> {
    const result = await this.adapter.queryOne<{ id: string }>(
      'SELECT id FROM admin_passkeys WHERE credential_id = ? LIMIT 1',
      [credentialId]
    );
    return result !== null;
  }

  /**
   * Map database row to AdminPasskey
   */
  private rowToPasskey(row: Record<string, unknown>): AdminPasskey {
    let transports: string[] | null = null;
    if (row.transports_json) {
      try {
        transports = JSON.parse(row.transports_json as string);
      } catch {
        transports = null;
      }
    }

    return {
      id: row.id as string,
      admin_user_id: row.admin_user_id as string,
      credential_id: row.credential_id as string,
      public_key: row.public_key as string,
      counter: (row.counter as number) ?? 0,
      device_name: row.device_name as string | null,
      transports,
      attestation_type: row.attestation_type as string | null,
      aaguid: row.aaguid as string | null,
      created_at: row.created_at as number,
      last_used_at: row.last_used_at as number | null,
    };
  }

  /**
   * Convert entity to AdminPasskey type
   */
  private entityToPasskey(entity: AdminPasskeyEntity): AdminPasskey {
    let transports: string[] | null = null;
    if (entity.transports_json) {
      try {
        transports = JSON.parse(entity.transports_json);
      } catch {
        transports = null;
      }
    }

    return {
      id: entity.id,
      admin_user_id: entity.admin_user_id,
      credential_id: entity.credential_id,
      public_key: entity.public_key,
      counter: entity.counter,
      device_name: entity.device_name,
      transports,
      attestation_type: entity.attestation_type,
      aaguid: entity.aaguid,
      created_at: entity.created_at,
      last_used_at: entity.last_used_at,
    };
  }
}
