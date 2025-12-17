/**
 * Linked Identity Repository
 *
 * Repository for External IdP linking stored in D1_PII.
 *
 * Purpose:
 * - Account linking: Multiple IdPs per user (Google, Microsoft, SAML, etc.)
 * - Session management: Track last used IdP
 * - Attribute synchronization: Store IdP-provided claims
 *
 * Fields:
 * - id: Record ID (UUID)
 * - user_id: Reference to users_core.id (logical FK)
 * - provider_id: External IdP identifier
 * - provider_user_id: User ID from the external IdP
 * - provider_email: Email from external IdP
 * - provider_name: Name from external IdP
 * - raw_attributes: Raw attributes from IdP (JSON)
 * - linked_at: When the link was established
 * - last_used_at: Last authentication via this IdP
 */

import type { DatabaseAdapter } from '../../db/adapter';
import {
  BaseRepository,
  type BaseEntity,
  type PaginationOptions,
  type PaginationResult,
  generateId,
  getCurrentTimestamp,
} from '../base';

/**
 * Linked Identity entity
 */
export interface LinkedIdentity extends BaseEntity {
  user_id: string;
  provider_id: string;
  provider_user_id: string;
  provider_email: string | null;
  provider_name: string | null;
  raw_attributes: string | null;
  linked_at: number;
  last_used_at: number | null;
}

/**
 * Linked Identity create input
 */
export interface CreateLinkedIdentityInput {
  id?: string;
  user_id: string;
  provider_id: string;
  provider_user_id: string;
  provider_email?: string | null;
  provider_name?: string | null;
  raw_attributes?: Record<string, unknown> | null;
}

/**
 * Linked Identity update input
 */
export interface UpdateLinkedIdentityInput {
  provider_email?: string | null;
  provider_name?: string | null;
  raw_attributes?: Record<string, unknown> | null;
  last_used_at?: number | null;
}

/**
 * Linked Identity Repository
 */
export class LinkedIdentityRepository extends BaseRepository<LinkedIdentity> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'linked_identities',
      primaryKey: 'id',
      softDelete: false,
      allowedFields: [
        'user_id',
        'provider_id',
        'provider_user_id',
        'provider_email',
        'provider_name',
        'raw_attributes',
        'linked_at',
        'last_used_at',
      ],
    });
  }

  /**
   * Create a new linked identity
   *
   * @param input - Linked identity data
   * @param adapter - Optional partition-specific adapter
   * @returns Created linked identity
   */
  async createLinkedIdentity(
    input: CreateLinkedIdentityInput,
    adapter?: DatabaseAdapter
  ): Promise<LinkedIdentity> {
    const db = adapter ?? this.adapter;
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();

    const linkedIdentity: LinkedIdentity = {
      id,
      user_id: input.user_id,
      provider_id: input.provider_id,
      provider_user_id: input.provider_user_id,
      provider_email: input.provider_email ?? null,
      provider_name: input.provider_name ?? null,
      raw_attributes: input.raw_attributes ? JSON.stringify(input.raw_attributes) : null,
      linked_at: now,
      last_used_at: null,
      created_at: now,
      updated_at: now,
    };

    const sql = `
      INSERT INTO linked_identities (
        id, user_id, provider_id, provider_user_id, provider_email,
        provider_name, raw_attributes, linked_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await db.execute(sql, [
      linkedIdentity.id,
      linkedIdentity.user_id,
      linkedIdentity.provider_id,
      linkedIdentity.provider_user_id,
      linkedIdentity.provider_email,
      linkedIdentity.provider_name,
      linkedIdentity.raw_attributes,
      linkedIdentity.linked_at,
      linkedIdentity.last_used_at,
    ]);

    return linkedIdentity;
  }

  /**
   * Find linked identity by provider and provider user ID
   *
   * Used for finding local user during IdP callback.
   *
   * @param providerId - External IdP identifier
   * @param providerUserId - User ID from external IdP
   * @param adapter - Optional partition-specific adapter
   * @returns Linked identity or null
   */
  async findByProviderUser(
    providerId: string,
    providerUserId: string,
    adapter?: DatabaseAdapter
  ): Promise<LinkedIdentity | null> {
    const db = adapter ?? this.adapter;
    return db.queryOne<LinkedIdentity>(
      'SELECT * FROM linked_identities WHERE provider_id = ? AND provider_user_id = ?',
      [providerId, providerUserId]
    );
  }

  /**
   * Find all linked identities for a user
   *
   * @param userId - User ID
   * @param adapter - Optional partition-specific adapter
   * @returns All linked identities for the user
   */
  async findByUserId(userId: string, adapter?: DatabaseAdapter): Promise<LinkedIdentity[]> {
    const db = adapter ?? this.adapter;
    return db.query<LinkedIdentity>('SELECT * FROM linked_identities WHERE user_id = ?', [userId]);
  }

  /**
   * Find linked identity by user and provider
   *
   * @param userId - User ID
   * @param providerId - Provider ID
   * @param adapter - Optional partition-specific adapter
   * @returns Linked identity or null
   */
  async findByUserAndProvider(
    userId: string,
    providerId: string,
    adapter?: DatabaseAdapter
  ): Promise<LinkedIdentity | null> {
    const db = adapter ?? this.adapter;
    return db.queryOne<LinkedIdentity>(
      'SELECT * FROM linked_identities WHERE user_id = ? AND provider_id = ?',
      [userId, providerId]
    );
  }

  /**
   * Find linked identities by provider email
   *
   * Used for account matching during registration/linking.
   *
   * @param email - Provider email address
   * @param adapter - Optional partition-specific adapter
   * @returns Matching linked identities
   */
  async findByProviderEmail(email: string, adapter?: DatabaseAdapter): Promise<LinkedIdentity[]> {
    const db = adapter ?? this.adapter;
    return db.query<LinkedIdentity>('SELECT * FROM linked_identities WHERE provider_email = ?', [
      email,
    ]);
  }

  /**
   * Update linked identity
   *
   * @param id - Linked identity ID
   * @param data - Fields to update
   * @param adapter - Optional partition-specific adapter
   * @returns Updated linked identity or null
   */
  async updateLinkedIdentity(
    id: string,
    data: UpdateLinkedIdentityInput,
    adapter?: DatabaseAdapter
  ): Promise<LinkedIdentity | null> {
    const db = adapter ?? this.adapter;

    const updates: string[] = [];
    const values: unknown[] = [];

    if (data.provider_email !== undefined) {
      updates.push('provider_email = ?');
      values.push(data.provider_email);
    }
    if (data.provider_name !== undefined) {
      updates.push('provider_name = ?');
      values.push(data.provider_name);
    }
    if (data.raw_attributes !== undefined) {
      updates.push('raw_attributes = ?');
      values.push(data.raw_attributes ? JSON.stringify(data.raw_attributes) : null);
    }
    if (data.last_used_at !== undefined) {
      updates.push('last_used_at = ?');
      values.push(data.last_used_at);
    }

    if (updates.length === 0) {
      return this.findById(id);
    }

    // Always update updated_at timestamp
    updates.push('updated_at = ?');
    values.push(getCurrentTimestamp());

    values.push(id);
    await db.execute(`UPDATE linked_identities SET ${updates.join(', ')} WHERE id = ?`, values);

    return db.queryOne<LinkedIdentity>('SELECT * FROM linked_identities WHERE id = ?', [id]);
  }

  /**
   * Update last used timestamp
   *
   * Called after successful authentication via IdP.
   *
   * @param id - Linked identity ID
   * @param adapter - Optional partition-specific adapter
   * @returns True if updated
   */
  async updateLastUsed(id: string, adapter?: DatabaseAdapter): Promise<boolean> {
    const db = adapter ?? this.adapter;
    const now = getCurrentTimestamp();
    const result = await db.execute('UPDATE linked_identities SET last_used_at = ? WHERE id = ?', [
      now,
      id,
    ]);
    return result.rowsAffected > 0;
  }

  /**
   * Delete linked identity
   *
   * @param id - Linked identity ID
   * @param adapter - Optional partition-specific adapter
   * @returns True if deleted
   */
  async deleteLinkedIdentity(id: string, adapter?: DatabaseAdapter): Promise<boolean> {
    const db = adapter ?? this.adapter;
    const result = await db.execute('DELETE FROM linked_identities WHERE id = ?', [id]);
    return result.rowsAffected > 0;
  }

  /**
   * Delete all linked identities for a user
   *
   * Used during GDPR user deletion.
   *
   * @param userId - User ID
   * @param adapter - Optional partition-specific adapter
   * @returns Number of deleted records
   */
  async deleteByUserId(userId: string, adapter?: DatabaseAdapter): Promise<number> {
    const db = adapter ?? this.adapter;
    const result = await db.execute('DELETE FROM linked_identities WHERE user_id = ?', [userId]);
    return result.rowsAffected;
  }

  /**
   * Unlink a provider from a user
   *
   * @param userId - User ID
   * @param providerId - Provider ID
   * @param adapter - Optional partition-specific adapter
   * @returns True if unlinked
   */
  async unlink(userId: string, providerId: string, adapter?: DatabaseAdapter): Promise<boolean> {
    const db = adapter ?? this.adapter;
    const result = await db.execute(
      'DELETE FROM linked_identities WHERE user_id = ? AND provider_id = ?',
      [userId, providerId]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Count linked identities per provider
   *
   * @param adapter - Optional partition-specific adapter
   * @returns Map of provider → count
   */
  async getProviderStats(adapter?: DatabaseAdapter): Promise<Map<string, number>> {
    const db = adapter ?? this.adapter;
    const results = await db.query<{ provider_id: string; count: number }>(
      'SELECT provider_id, COUNT(*) as count FROM linked_identities GROUP BY provider_id'
    );

    const stats = new Map<string, number>();
    for (const row of results) {
      stats.set(row.provider_id, row.count);
    }
    return stats;
  }

  /**
   * Get parsed raw attributes
   *
   * @param linkedIdentity - Linked identity with raw_attributes
   * @returns Parsed attributes or null
   */
  getRawAttributes(linkedIdentity: LinkedIdentity): Record<string, unknown> | null {
    if (!linkedIdentity.raw_attributes) {
      return null;
    }
    try {
      return JSON.parse(linkedIdentity.raw_attributes) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
