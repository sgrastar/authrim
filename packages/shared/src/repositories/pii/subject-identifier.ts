/**
 * Subject Identifier Repository
 *
 * Repository for OIDC Pairwise Subject Identifiers stored in D1_PII.
 *
 * Purpose:
 * - Privacy protection: Generates different `sub` claim per client/sector
 * - OIDC compliance: RFC 8693 pairwise identifier support
 * - Prevents client-side user correlation
 *
 * Fields:
 * - id: Record ID (UUID)
 * - user_id: Reference to users_core.id (logical FK)
 * - client_id: Client that requested this subject
 * - sector_identifier: Domain for pairwise calculation
 * - subject: The pairwise subject value
 * - created_at: Creation timestamp
 */

import type { DatabaseAdapter } from '../../db/adapter';
import { BaseRepository, type BaseEntity, generateId, getCurrentTimestamp } from '../base';

/**
 * Subject Identifier entity
 */
export interface SubjectIdentifier extends BaseEntity {
  user_id: string;
  client_id: string;
  sector_identifier: string;
  subject: string;
}

/**
 * Subject Identifier create input
 */
export interface CreateSubjectIdentifierInput {
  id?: string;
  user_id: string;
  client_id: string;
  sector_identifier: string;
  subject: string;
}

/**
 * Subject Identifier Repository
 */
export class SubjectIdentifierRepository extends BaseRepository<SubjectIdentifier> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'subject_identifiers',
      primaryKey: 'id',
      softDelete: false,
      allowedFields: ['user_id', 'client_id', 'sector_identifier', 'subject'],
    });
  }

  /**
   * Create a new subject identifier
   *
   * @param input - Subject identifier data
   * @param adapter - Optional partition-specific adapter
   * @returns Created subject identifier
   */
  async createSubjectIdentifier(
    input: CreateSubjectIdentifierInput,
    adapter?: DatabaseAdapter
  ): Promise<SubjectIdentifier> {
    const db = adapter ?? this.adapter;
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();

    const subjectId: SubjectIdentifier = {
      id,
      user_id: input.user_id,
      client_id: input.client_id,
      sector_identifier: input.sector_identifier,
      subject: input.subject,
      created_at: now,
      updated_at: now,
    };

    const sql = `
      INSERT INTO subject_identifiers (id, user_id, client_id, sector_identifier, subject, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    await db.execute(sql, [
      subjectId.id,
      subjectId.user_id,
      subjectId.client_id,
      subjectId.sector_identifier,
      subjectId.subject,
      subjectId.created_at,
    ]);

    return subjectId;
  }

  /**
   * Find subject identifier by user and sector
   *
   * Returns the pairwise subject for a user in a specific sector.
   *
   * @param userId - User ID
   * @param sectorIdentifier - Sector identifier (domain)
   * @param adapter - Optional partition-specific adapter
   * @returns Subject identifier or null
   */
  async findByUserAndSector(
    userId: string,
    sectorIdentifier: string,
    adapter?: DatabaseAdapter
  ): Promise<SubjectIdentifier | null> {
    const db = adapter ?? this.adapter;
    return db.queryOne<SubjectIdentifier>(
      'SELECT * FROM subject_identifiers WHERE user_id = ? AND sector_identifier = ?',
      [userId, sectorIdentifier]
    );
  }

  /**
   * Find subject identifier by subject value
   *
   * Reverse lookup: find user by their pairwise subject.
   *
   * @param subject - Pairwise subject value
   * @param adapter - Optional partition-specific adapter
   * @returns Subject identifier or null
   */
  async findBySubject(
    subject: string,
    adapter?: DatabaseAdapter
  ): Promise<SubjectIdentifier | null> {
    const db = adapter ?? this.adapter;
    return db.queryOne<SubjectIdentifier>('SELECT * FROM subject_identifiers WHERE subject = ?', [
      subject,
    ]);
  }

  /**
   * Find all subject identifiers for a user
   *
   * @param userId - User ID
   * @param adapter - Optional partition-specific adapter
   * @returns All subject identifiers for the user
   */
  async findByUserId(userId: string, adapter?: DatabaseAdapter): Promise<SubjectIdentifier[]> {
    const db = adapter ?? this.adapter;
    return db.query<SubjectIdentifier>('SELECT * FROM subject_identifiers WHERE user_id = ?', [
      userId,
    ]);
  }

  /**
   * Find all subject identifiers for a client
   *
   * @param clientId - Client ID
   * @param adapter - Optional partition-specific adapter
   * @returns All subject identifiers for the client
   */
  async findByClientId(clientId: string, adapter?: DatabaseAdapter): Promise<SubjectIdentifier[]> {
    const db = adapter ?? this.adapter;
    return db.query<SubjectIdentifier>('SELECT * FROM subject_identifiers WHERE client_id = ?', [
      clientId,
    ]);
  }

  /**
   * Get or create subject identifier
   *
   * Returns existing identifier if found, creates new one if not.
   * Handles race conditions where concurrent requests may try to create
   * the same identifier simultaneously.
   *
   * @param userId - User ID
   * @param clientId - Client ID
   * @param sectorIdentifier - Sector identifier
   * @param generateSubject - Function to generate pairwise subject
   * @param adapter - Optional partition-specific adapter
   * @returns Existing or newly created subject identifier
   */
  async getOrCreate(
    userId: string,
    clientId: string,
    sectorIdentifier: string,
    generateSubject: () => string,
    adapter?: DatabaseAdapter
  ): Promise<SubjectIdentifier> {
    // First, try to find existing identifier
    const existing = await this.findByUserAndSector(userId, sectorIdentifier, adapter);
    if (existing) {
      return existing;
    }

    // Try to create new identifier
    // Handle race condition: if another request created it first, we'll get UNIQUE constraint error
    try {
      return await this.createSubjectIdentifier(
        {
          user_id: userId,
          client_id: clientId,
          sector_identifier: sectorIdentifier,
          subject: generateSubject(),
        },
        adapter
      );
    } catch (error) {
      // Check if this is a UNIQUE constraint violation (race condition)
      if (error instanceof Error && error.message.includes('UNIQUE constraint')) {
        // Another request created the identifier, fetch and return it
        const retried = await this.findByUserAndSector(userId, sectorIdentifier, adapter);
        if (retried) {
          return retried;
        }
      }
      // Re-throw if it's a different error or retry failed
      throw error;
    }
  }

  /**
   * Delete all subject identifiers for a user
   *
   * Used during GDPR user deletion.
   *
   * @param userId - User ID
   * @param adapter - Optional partition-specific adapter
   * @returns Number of deleted records
   */
  async deleteByUserId(userId: string, adapter?: DatabaseAdapter): Promise<number> {
    const db = adapter ?? this.adapter;
    const result = await db.execute('DELETE FROM subject_identifiers WHERE user_id = ?', [userId]);
    return result.rowsAffected;
  }

  /**
   * Delete all subject identifiers for a client
   *
   * Used during client deletion.
   *
   * @param clientId - Client ID
   * @param adapter - Optional partition-specific adapter
   * @returns Number of deleted records
   */
  async deleteByClientId(clientId: string, adapter?: DatabaseAdapter): Promise<number> {
    const db = adapter ?? this.adapter;
    const result = await db.execute('DELETE FROM subject_identifiers WHERE client_id = ?', [
      clientId,
    ]);
    return result.rowsAffected;
  }
}
