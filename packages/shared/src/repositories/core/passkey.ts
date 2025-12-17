/**
 * Passkey Repository
 *
 * Repository for WebAuthn passkeys stored in D1_CORE database.
 * Handles passkey registration, authentication, and management.
 *
 * Key features:
 * - Credential ID lookup for WebAuthn authentication
 * - Counter validation to detect cloned authenticators
 * - Device naming for user-friendly management
 * - Last-used tracking for security auditing
 *
 * Note: Does not extend BaseRepository because passkeys table
 * doesn't have updated_at field (uses last_used_at for tracking usage).
 *
 * Table: passkeys
 * Schema:
 *   - id: TEXT PRIMARY KEY (UUID)
 *   - user_id: TEXT NOT NULL (FK to users)
 *   - credential_id: TEXT UNIQUE NOT NULL (base64url encoded)
 *   - public_key: TEXT NOT NULL (base64url encoded COSE key)
 *   - counter: INTEGER DEFAULT 0 (signature counter)
 *   - transports: TEXT (JSON array of transport types)
 *   - device_name: TEXT (user-friendly name)
 *   - created_at: INTEGER NOT NULL (timestamp)
 *   - last_used_at: INTEGER (timestamp)
 */

import { generateId, getCurrentTimestamp } from '../base';
import type { DatabaseAdapter } from '../../db/adapter';

/**
 * WebAuthn transport types
 * @see https://www.w3.org/TR/webauthn-2/#enumdef-authenticatortransport
 */
export type AuthenticatorTransport = 'usb' | 'nfc' | 'ble' | 'internal' | 'hybrid';

/**
 * Passkey entity representing a WebAuthn credential
 */
export interface Passkey {
  /** Unique passkey ID (UUID) */
  id: string;
  /** User ID this passkey belongs to */
  user_id: string;
  /** Credential ID (base64url encoded) */
  credential_id: string;
  /** Public key (base64url encoded COSE key) */
  public_key: string;
  /** Signature counter for clone detection */
  counter: number;
  /** Supported transport types */
  transports: AuthenticatorTransport[];
  /** User-friendly device name */
  device_name: string | null;
  /** Creation timestamp (Unix ms) */
  created_at: number;
  /** Last authentication timestamp (Unix ms) */
  last_used_at: number | null;
}

/**
 * Input for creating a new passkey
 */
export interface CreatePasskeyInput {
  /** Optional passkey ID (auto-generated if not provided) */
  id?: string;
  /** User ID this passkey belongs to */
  user_id: string;
  /** Credential ID (base64url encoded) */
  credential_id: string;
  /** Public key (base64url encoded COSE key) */
  public_key: string;
  /** Initial signature counter (usually 0) */
  counter?: number;
  /** Supported transport types */
  transports?: AuthenticatorTransport[];
  /** User-friendly device name */
  device_name?: string;
}

/**
 * Input for updating a passkey
 *
 * Note: Counter is intentionally excluded from this interface.
 * Counter updates must go through updateCounterAfterAuth() to ensure
 * proper clone detection validation.
 */
export interface UpdatePasskeyInput {
  /** New device name */
  device_name?: string;
  /** Update last used timestamp to now */
  update_last_used?: boolean;
}

/**
 * Filter options for passkey queries
 */
export interface PasskeyFilterOptions {
  /** Filter by user ID */
  user_id?: string;
}

/**
 * Database row type for passkeys table
 */
interface PasskeyRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  device_name: string | null;
  created_at: number;
  last_used_at: number | null;
}

/**
 * Passkey Repository
 *
 * Provides CRUD operations for WebAuthn passkeys with:
 * - Credential ID lookup (critical for authentication)
 * - Counter validation (clone detection)
 * - Device management (naming, listing)
 */
export class PasskeyRepository {
  protected readonly adapter: DatabaseAdapter;

  constructor(adapter: DatabaseAdapter) {
    this.adapter = adapter;
  }

  /**
   * Validate counter value for WebAuthn
   * Counter must be a non-negative integer per WebAuthn spec
   * @param counter - Counter value to validate
   * @returns Validated counter (defaults to 0 if invalid)
   */
  private validateCounter(counter: number | undefined): number {
    if (counter === undefined) {
      return 0;
    }
    // Counter must be a non-negative integer
    if (!Number.isInteger(counter) || counter < 0) {
      return 0;
    }
    return counter;
  }

  /**
   * Create a new passkey
   *
   * @param input - Passkey creation input
   * @returns Created passkey
   * @throws Error if credential_id already exists
   */
  async create(input: CreatePasskeyInput): Promise<Passkey> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();

    // Validate counter (must be non-negative integer per WebAuthn spec)
    const validCounter = this.validateCounter(input.counter);

    // Serialize transports array to JSON
    const transportsJson = input.transports ? JSON.stringify(input.transports) : null;

    const sql = `
      INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, device_name, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `;

    await this.adapter.execute(sql, [
      id,
      input.user_id,
      input.credential_id,
      input.public_key,
      validCounter,
      transportsJson,
      input.device_name ?? null,
      now,
    ]);

    return {
      id,
      user_id: input.user_id,
      credential_id: input.credential_id,
      public_key: input.public_key,
      counter: validCounter,
      transports: input.transports ?? [],
      device_name: input.device_name ?? null,
      created_at: now,
      last_used_at: null,
    };
  }

  /**
   * Find passkey by ID
   *
   * @param id - Passkey ID
   * @returns Passkey or null if not found
   */
  async findById(id: string): Promise<Passkey | null> {
    const sql = 'SELECT * FROM passkeys WHERE id = ?';
    const row = await this.adapter.queryOne<PasskeyRow>(sql, [id]);
    return row ? this.rowToEntity(row) : null;
  }

  /**
   * Find passkey by credential ID (for WebAuthn authentication)
   *
   * @param credentialId - Credential ID (base64url encoded)
   * @returns Passkey or null if not found
   */
  async findByCredentialId(credentialId: string): Promise<Passkey | null> {
    const sql = 'SELECT * FROM passkeys WHERE credential_id = ?';
    const row = await this.adapter.queryOne<PasskeyRow>(sql, [credentialId]);
    return row ? this.rowToEntity(row) : null;
  }

  /**
   * Find all passkeys for a user
   *
   * @param userId - User ID
   * @returns Array of passkeys
   */
  async findByUserId(userId: string): Promise<Passkey[]> {
    const sql = 'SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at DESC';
    const rows = await this.adapter.query<PasskeyRow>(sql, [userId]);
    return rows.map((row) => this.rowToEntity(row));
  }

  /**
   * Update a passkey (device name and last_used_at only)
   *
   * Note: Counter updates are NOT allowed through this method.
   * Use updateCounterAfterAuth() for counter updates to ensure
   * proper clone detection validation.
   *
   * @param id - Passkey ID
   * @param input - Update input (device_name, update_last_used)
   * @returns Updated passkey or null if not found
   */
  async update(id: string, input: UpdatePasskeyInput): Promise<Passkey | null> {
    const existing = await this.findById(id);
    if (!existing) {
      return null;
    }

    const updates: string[] = [];
    const params: unknown[] = [];

    // Counter is intentionally NOT updateable here - use updateCounterAfterAuth()

    if (input.device_name !== undefined) {
      updates.push('device_name = ?');
      params.push(input.device_name);
    }

    if (input.update_last_used) {
      updates.push('last_used_at = ?');
      params.push(getCurrentTimestamp());
    }

    if (updates.length === 0) {
      return existing;
    }

    const sql = `UPDATE passkeys SET ${updates.join(', ')} WHERE id = ?`;
    params.push(id);

    await this.adapter.execute(sql, params);
    return this.findById(id);
  }

  /**
   * Update counter and last_used_at after successful authentication
   * This is critical for clone detection
   *
   * @param id - Passkey ID
   * @param newCounter - New counter value (must be greater than current)
   * @returns Updated passkey or null if not found
   * @throws Error if newCounter is not greater than current counter
   */
  async updateCounterAfterAuth(id: string, newCounter: number): Promise<Passkey | null> {
    const existing = await this.findById(id);
    if (!existing) {
      return null;
    }

    // Counter must be strictly greater than current value
    if (newCounter <= existing.counter) {
      throw new Error(
        `Invalid counter: new counter (${newCounter}) must be greater than current (${existing.counter}). Possible cloned authenticator.`
      );
    }

    const now = getCurrentTimestamp();
    const sql = 'UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?';

    await this.adapter.execute(sql, [newCounter, now, id]);

    return {
      ...existing,
      counter: newCounter,
      last_used_at: now,
    };
  }

  /**
   * Rename a passkey (update device_name)
   *
   * @param id - Passkey ID
   * @param deviceName - New device name
   * @returns Updated passkey or null if not found
   */
  async rename(id: string, deviceName: string): Promise<Passkey | null> {
    return this.update(id, { device_name: deviceName });
  }

  /**
   * Delete a passkey
   *
   * @param id - Passkey ID
   * @returns True if deleted, false if not found
   */
  async delete(id: string): Promise<boolean> {
    const sql = 'DELETE FROM passkeys WHERE id = ?';
    const result = await this.adapter.execute(sql, [id]);
    return result.rowsAffected > 0;
  }

  /**
   * Delete all passkeys for a user
   *
   * @param userId - User ID
   * @returns Number of deleted passkeys
   */
  async deleteByUserId(userId: string): Promise<number> {
    const sql = 'DELETE FROM passkeys WHERE user_id = ?';
    const result = await this.adapter.execute(sql, [userId]);
    return result.rowsAffected;
  }

  /**
   * Check if credential ID exists
   *
   * @param credentialId - Credential ID (base64url encoded)
   * @returns True if exists
   */
  async credentialIdExists(credentialId: string): Promise<boolean> {
    const sql = 'SELECT 1 FROM passkeys WHERE credential_id = ?';
    const result = await this.adapter.queryOne<{ 1: number }>(sql, [credentialId]);
    return result !== null;
  }

  /**
   * Check if user has any passkeys
   *
   * @param userId - User ID
   * @returns True if user has at least one passkey
   */
  async userHasPasskeys(userId: string): Promise<boolean> {
    const sql = 'SELECT 1 FROM passkeys WHERE user_id = ? LIMIT 1';
    const result = await this.adapter.queryOne<{ 1: number }>(sql, [userId]);
    return result !== null;
  }

  /**
   * Count passkeys for a user
   *
   * @param userId - User ID
   * @returns Number of passkeys
   */
  async countByUserId(userId: string): Promise<number> {
    const sql = 'SELECT COUNT(*) as count FROM passkeys WHERE user_id = ?';
    const result = await this.adapter.queryOne<{ count: number }>(sql, [userId]);
    return result?.count ?? 0;
  }

  /**
   * Get passkeys that haven't been used in a long time
   * Useful for security auditing and cleanup suggestions
   *
   * @param userId - User ID
   * @param unusedSinceMs - Time in milliseconds (passkeys not used since)
   * @returns Array of unused passkeys
   */
  async findUnusedPasskeys(userId: string, unusedSinceMs: number): Promise<Passkey[]> {
    const cutoff = getCurrentTimestamp() - unusedSinceMs;
    const sql = `
      SELECT * FROM passkeys
      WHERE user_id = ? AND (last_used_at IS NULL OR last_used_at < ?)
      ORDER BY last_used_at ASC NULLS FIRST
    `;
    const rows = await this.adapter.query<PasskeyRow>(sql, [userId, cutoff]);
    return rows.map((row) => this.rowToEntity(row));
  }

  /**
   * Get passkey statistics for a user
   *
   * @param userId - User ID
   * @returns Passkey statistics
   */
  async getStatsForUser(userId: string): Promise<{
    total: number;
    recentlyUsed: number;
    neverUsed: number;
    avgCounter: number;
  }> {
    const thirtyDaysAgo = getCurrentTimestamp() - 30 * 24 * 60 * 60 * 1000;

    const sql = `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN last_used_at > ? THEN 1 ELSE 0 END) as recently_used,
        SUM(CASE WHEN last_used_at IS NULL THEN 1 ELSE 0 END) as never_used,
        AVG(counter) as avg_counter
      FROM passkeys WHERE user_id = ?
    `;

    const result = await this.adapter.queryOne<{
      total: number;
      recently_used: number;
      never_used: number;
      avg_counter: number;
    }>(sql, [thirtyDaysAgo, userId]);

    return {
      total: result?.total ?? 0,
      recentlyUsed: result?.recently_used ?? 0,
      neverUsed: result?.never_used ?? 0,
      avgCounter: result?.avg_counter ?? 0,
    };
  }

  /**
   * Convert database row to Passkey entity
   */
  private rowToEntity(row: PasskeyRow): Passkey {
    let transports: AuthenticatorTransport[] = [];
    if (row.transports) {
      try {
        transports = JSON.parse(row.transports);
      } catch {
        // Invalid JSON, use empty array
        transports = [];
      }
    }

    return {
      id: row.id,
      user_id: row.user_id,
      credential_id: row.credential_id,
      public_key: row.public_key,
      counter: row.counter,
      transports,
      device_name: row.device_name,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
    };
  }
}
