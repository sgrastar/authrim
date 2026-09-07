/**
 * Subject Identifier Repository
 *
 * Repository for tenant-scoped subject identifiers stored in the PII plane.
 */

import type { DatabaseAdapter } from '../../db/adapter';
import { BaseRepository, type BaseEntity, generateId, getCurrentTimestamp } from '../base';
import { requireTenantId } from '../tenant';

export interface SubjectIdentifier extends BaseEntity {
  tenant_id: string;
  subject_id: string;
  identifier_type: string;
  identifier_value: string;
  is_primary: boolean | number;
  verified_at?: number | null;
  verification_method?: string | null;
  destination_type?: string | null;
  destination_id?: string | null;
  identifier_value_hash?: string | null;
  identifier_storage_ref?: string | null;
  lifecycle_state?: string | null;
}

export interface CreateSubjectIdentifierInput {
  id?: string;
  tenant_id: string;
  subject_id: string;
  identifier_type: string;
  identifier_value: string;
  is_primary?: boolean;
  verified_at?: number | null;
  verification_method?: string | null;
}

export interface CreateOutboundSubjectIdentifierInput extends CreateSubjectIdentifierInput {
  destination_type: string;
  destination_id: string;
  identifier_value_hash?: string | null;
  identifier_storage_ref?: string | null;
  lifecycle_state?: string;
}

export class SubjectIdentifierRepository extends BaseRepository<SubjectIdentifier> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'subject_identifiers',
      primaryKey: 'id',
      softDelete: false,
      allowedFields: [
        'tenant_id',
        'subject_id',
        'identifier_type',
        'identifier_value',
        'is_primary',
        'verified_at',
        'verification_method',
        'destination_type',
        'destination_id',
        'identifier_value_hash',
        'identifier_storage_ref',
        'lifecycle_state',
      ],
    });
  }

  async createSubjectIdentifier(
    input: CreateSubjectIdentifierInput,
    adapter?: DatabaseAdapter
  ): Promise<SubjectIdentifier> {
    const db = adapter ?? this.adapter;
    const now = getCurrentTimestamp();
    const tenantId = requireTenantId(input.tenant_id, 'SubjectIdentifierRepository create');
    const identifier: SubjectIdentifier = {
      id: input.id ?? generateId(),
      tenant_id: tenantId,
      subject_id: input.subject_id,
      identifier_type: input.identifier_type,
      identifier_value: input.identifier_value,
      is_primary: input.is_primary === true,
      verified_at: input.verified_at ?? null,
      verification_method: input.verification_method ?? null,
      created_at: now,
      updated_at: now,
    };

    await db.execute(
      `INSERT INTO subject_identifiers (
        id, tenant_id, subject_id, identifier_type, identifier_value,
        is_primary, verified_at, verification_method, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        identifier.id,
        identifier.tenant_id,
        identifier.subject_id,
        identifier.identifier_type,
        identifier.identifier_value,
        identifier.is_primary ? 1 : 0,
        identifier.verified_at,
        identifier.verification_method,
        identifier.created_at,
        identifier.updated_at,
      ]
    );

    return identifier;
  }

  async createOutboundSubjectIdentifier(
    input: CreateOutboundSubjectIdentifierInput,
    adapter?: DatabaseAdapter
  ): Promise<SubjectIdentifier> {
    const db = adapter ?? this.adapter;
    const now = getCurrentTimestamp();
    const tenantId = requireTenantId(input.tenant_id, 'SubjectIdentifierRepository create');
    const identifier: SubjectIdentifier = {
      id: input.id ?? generateId(),
      tenant_id: tenantId,
      subject_id: input.subject_id,
      identifier_type: input.identifier_type,
      identifier_value: input.identifier_value,
      is_primary: input.is_primary === true,
      verified_at: input.verified_at ?? null,
      verification_method: input.verification_method ?? null,
      destination_type: input.destination_type,
      destination_id: input.destination_id,
      identifier_value_hash: input.identifier_value_hash ?? null,
      identifier_storage_ref: input.identifier_storage_ref ?? null,
      lifecycle_state: input.lifecycle_state ?? 'active',
      created_at: now,
      updated_at: now,
    };

    await db.execute(
      `INSERT INTO subject_identifiers (
        id, tenant_id, subject_id, identifier_type, identifier_value,
        is_primary, verified_at, verification_method, destination_type, destination_id,
        identifier_value_hash, identifier_storage_ref, lifecycle_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        identifier.id,
        identifier.tenant_id,
        identifier.subject_id,
        identifier.identifier_type,
        identifier.identifier_value,
        identifier.is_primary ? 1 : 0,
        identifier.verified_at,
        identifier.verification_method,
        identifier.destination_type,
        identifier.destination_id,
        identifier.identifier_value_hash,
        identifier.identifier_storage_ref,
        identifier.lifecycle_state,
        identifier.created_at,
        identifier.updated_at,
      ]
    );

    return identifier;
  }

  async findByIdentifier(
    tenantId: string,
    identifierType: string,
    identifierValue: string,
    adapter?: DatabaseAdapter
  ): Promise<SubjectIdentifier | null> {
    const db = adapter ?? this.adapter;
    const scopedTenantId = requireTenantId(tenantId, 'SubjectIdentifierRepository lookup');
    return db.queryOne<SubjectIdentifier>(
      `SELECT * FROM subject_identifiers
       WHERE tenant_id = ? AND identifier_type = ? AND identifier_value = ?`,
      [scopedTenantId, identifierType, identifierValue]
    );
  }

  async findByDestination(
    tenantId: string,
    subjectId: string,
    destinationType: string,
    destinationId: string,
    identifierType?: string,
    adapter?: DatabaseAdapter
  ): Promise<SubjectIdentifier | null> {
    const db = adapter ?? this.adapter;
    const scopedTenantId = requireTenantId(tenantId, 'SubjectIdentifierRepository lookup');
    const params: unknown[] = [scopedTenantId, subjectId, destinationType, destinationId, 'active'];
    const typeClause = identifierType ? ' AND identifier_type = ?' : '';
    if (identifierType) {
      params.push(identifierType);
    }
    return db.queryOne<SubjectIdentifier>(
      `SELECT * FROM subject_identifiers
       WHERE tenant_id = ? AND subject_id = ? AND destination_type = ? AND destination_id = ? AND lifecycle_state = ?${typeClause}
       ORDER BY is_primary DESC, created_at ASC
       LIMIT 1`,
      params
    );
  }

  async findByIdentifierHash(
    tenantId: string,
    identifierType: string,
    identifierValueHash: string,
    adapter?: DatabaseAdapter
  ): Promise<SubjectIdentifier | null> {
    const db = adapter ?? this.adapter;
    const scopedTenantId = requireTenantId(tenantId, 'SubjectIdentifierRepository lookup');
    return db.queryOne<SubjectIdentifier>(
      `SELECT * FROM subject_identifiers
       WHERE tenant_id = ? AND identifier_type = ? AND identifier_value_hash = ? AND lifecycle_state = ?
       LIMIT 1`,
      [scopedTenantId, identifierType, identifierValueHash, 'active']
    );
  }

  async findBySubjectId(
    tenantId: string,
    subjectId: string,
    adapter?: DatabaseAdapter
  ): Promise<SubjectIdentifier[]> {
    const db = adapter ?? this.adapter;
    const scopedTenantId = requireTenantId(tenantId, 'SubjectIdentifierRepository lookup');
    return db.query<SubjectIdentifier>(
      `SELECT * FROM subject_identifiers
       WHERE tenant_id = ? AND subject_id = ?
       ORDER BY is_primary DESC, created_at ASC`,
      [scopedTenantId, subjectId]
    );
  }

  async findPrimaryBySubjectId(
    tenantId: string,
    subjectId: string,
    identifierType?: string,
    adapter?: DatabaseAdapter
  ): Promise<SubjectIdentifier | null> {
    const db = adapter ?? this.adapter;
    const scopedTenantId = requireTenantId(tenantId, 'SubjectIdentifierRepository lookup');
    const typeClause = identifierType ? ' AND identifier_type = ?' : '';
    const params: unknown[] = [scopedTenantId, subjectId];
    if (identifierType) {
      params.push(identifierType);
    }

    return db.queryOne<SubjectIdentifier>(
      `SELECT * FROM subject_identifiers
       WHERE tenant_id = ? AND subject_id = ? AND is_primary = 1${typeClause}
       ORDER BY created_at ASC
       LIMIT 1`,
      params
    );
  }

  async getOrCreate(
    input: CreateSubjectIdentifierInput,
    adapter?: DatabaseAdapter
  ): Promise<SubjectIdentifier> {
    const existing = await this.findByIdentifier(
      input.tenant_id,
      input.identifier_type,
      input.identifier_value,
      adapter
    );
    if (existing) {
      return existing;
    }

    try {
      return await this.createSubjectIdentifier(input, adapter);
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint')) {
        const retried = await this.findByIdentifier(
          input.tenant_id,
          input.identifier_type,
          input.identifier_value,
          adapter
        );
        if (retried) {
          return retried;
        }
      }
      throw error;
    }
  }

  async deleteByUserId(
    tenantId: string,
    userId: string,
    adapter?: DatabaseAdapter
  ): Promise<number> {
    const db = adapter ?? this.adapter;
    const scopedTenantId = requireTenantId(tenantId, 'SubjectIdentifierRepository delete');
    const result = await db.execute(
      'DELETE FROM subject_identifiers WHERE tenant_id = ? AND subject_id = ?',
      [scopedTenantId, userId]
    );
    return result.rowsAffected;
  }

  async deleteByIdentifier(
    tenantId: string,
    identifierType: string,
    identifierValue: string,
    adapter?: DatabaseAdapter
  ): Promise<number> {
    const db = adapter ?? this.adapter;
    const scopedTenantId = requireTenantId(tenantId, 'SubjectIdentifierRepository delete');
    const result = await db.execute(
      `DELETE FROM subject_identifiers
       WHERE tenant_id = ? AND identifier_type = ? AND identifier_value = ?`,
      [scopedTenantId, identifierType, identifierValue]
    );
    return result.rowsAffected;
  }
}
