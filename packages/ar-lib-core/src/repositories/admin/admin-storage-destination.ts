import type { DatabaseAdapter } from '../../db/adapter';
import { BaseRepository, type BaseEntity, generateId, getCurrentTimestamp } from '../base';
import { requireTenantId } from '../tenant';

export type AdminResourceScopeType = 'tenant' | 'platform';
export type StorageDestinationProvider = 'r2' | 'aws_s3' | 'sftp' | 'custom';
export type AdminResourceStatus = 'active' | 'disabled';

interface AdminStorageDestinationEntity extends BaseEntity {
  scope_type: AdminResourceScopeType;
  scope_id: string;
  name: string;
  display_name: string;
  description: string | null;
  provider: StorageDestinationProvider;
  config_json: string;
  credential_encrypted: string | null;
  credential_key_version: number | null;
  credential_updated_at: number | null;
  credential_updated_by: string | null;
  status: AdminResourceStatus;
  created_by: string | null;
  updated_by: string | null;
  is_active: boolean | number;
}

interface AdminStorageDestinationUsageEntity extends BaseEntity {
  destination_id: string;
  feature: string;
  resource_type: string;
  resource_id: string;
  tenant_id: string;
  metadata_json: string;
  created_by: string | null;
  is_active: boolean | number;
}

export interface AdminStorageDestination {
  id: string;
  scope_type: AdminResourceScopeType;
  scope_id: string;
  name: string;
  display_name: string;
  description: string | null;
  provider: StorageDestinationProvider;
  config: Record<string, unknown>;
  has_credential: boolean;
  credential_key_version: number | null;
  credential_updated_at: number | null;
  credential_updated_by: string | null;
  status: AdminResourceStatus;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface AdminStorageDestinationWithCredential extends AdminStorageDestination {
  credential_encrypted: string | null;
}

export interface AdminStorageDestinationUsage {
  id: string;
  destination_id: string;
  feature: string;
  resource_type: string;
  resource_id: string;
  tenant_id: string;
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface AdminStorageDestinationUsageInput {
  destination_id: string;
  feature: string;
  resource_type: string;
  resource_id: string;
  tenant_id: string;
  metadata?: Record<string, unknown>;
  created_by?: string | null;
}

export interface AdminStorageDestinationCreateInput {
  scope_type: AdminResourceScopeType;
  scope_id?: string;
  tenant_id?: string;
  name: string;
  display_name?: string;
  description?: string | null;
  provider: StorageDestinationProvider;
  config?: Record<string, unknown>;
  credential_encrypted?: string | null;
  credential_key_version?: number | null;
  credential_updated_by?: string | null;
  status?: AdminResourceStatus;
  created_by?: string | null;
}

export interface AdminStorageDestinationUpdateInput {
  display_name?: string;
  description?: string | null;
  config?: Record<string, unknown>;
  status?: AdminResourceStatus;
  updated_by?: string | null;
}

function normalizeScopeId(input: {
  scope_type: AdminResourceScopeType;
  scope_id?: string;
  tenant_id?: string;
}): string {
  if (input.scope_type === 'platform') {
    return 'platform';
  }
  return requireTenantId(input.scope_id ?? input.tenant_id, 'AdminStorageDestinationRepository');
}

function parseConfig(configJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(configJson) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function entityToDestination(entity: AdminStorageDestinationEntity): AdminStorageDestination {
  return {
    id: entity.id,
    scope_type: entity.scope_type,
    scope_id: entity.scope_id,
    name: entity.name,
    display_name: entity.display_name,
    description: entity.description,
    provider: entity.provider,
    config: parseConfig(entity.config_json),
    has_credential: !!entity.credential_encrypted,
    credential_key_version: entity.credential_key_version,
    credential_updated_at: entity.credential_updated_at,
    credential_updated_by: entity.credential_updated_by,
    status: entity.status,
    created_by: entity.created_by,
    updated_by: entity.updated_by,
    created_at: entity.created_at,
    updated_at: entity.updated_at,
  };
}

function entityToUsage(entity: AdminStorageDestinationUsageEntity): AdminStorageDestinationUsage {
  return {
    id: entity.id,
    destination_id: entity.destination_id,
    feature: entity.feature,
    resource_type: entity.resource_type,
    resource_id: entity.resource_id,
    tenant_id: entity.tenant_id,
    metadata: parseConfig(entity.metadata_json),
    created_by: entity.created_by,
    created_at: entity.created_at,
    updated_at: entity.updated_at,
  };
}

export class AdminStorageDestinationRepository extends BaseRepository<AdminStorageDestinationEntity> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'admin_storage_destinations',
      primaryKey: 'id',
      softDelete: true,
      softDeleteField: 'is_active',
      allowedFields: [
        'scope_type',
        'scope_id',
        'name',
        'display_name',
        'provider',
        'status',
        'created_by',
        'updated_by',
      ],
    });
  }

  async createDestination(
    input: AdminStorageDestinationCreateInput
  ): Promise<AdminStorageDestination> {
    const now = getCurrentTimestamp();
    const scopeId = normalizeScopeId(input);
    const credentialUpdatedAt = input.credential_encrypted ? now : null;

    await this.adapter.execute(
      `INSERT INTO admin_storage_destinations (
         id, scope_type, scope_id, name, display_name, description, provider, config_json,
         credential_encrypted, credential_key_version, credential_updated_at, credential_updated_by,
         status, created_by, updated_by, created_at, updated_at, is_active
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        generateId(),
        input.scope_type,
        scopeId,
        input.name,
        input.display_name ?? input.name,
        input.description ?? null,
        input.provider,
        JSON.stringify(input.config ?? {}),
        input.credential_encrypted ?? null,
        input.credential_key_version ?? null,
        credentialUpdatedAt,
        input.credential_updated_by ?? null,
        input.status ?? 'active',
        input.created_by ?? null,
        input.created_by ?? null,
        now,
        now,
      ]
    );

    const created = await this.findByScopeAndName(input.scope_type, scopeId, input.name);
    if (!created) {
      throw new Error('Failed to create storage destination');
    }
    return created;
  }

  async listByScope(
    scopeType: AdminResourceScopeType,
    scopeId: string
  ): Promise<AdminStorageDestination[]> {
    const rows = await this.adapter.query<AdminStorageDestinationEntity>(
      `SELECT * FROM admin_storage_destinations
        WHERE scope_type = ? AND scope_id = ? AND is_active = 1
        ORDER BY name ASC`,
      [scopeType, scopeId]
    );
    return rows.map(entityToDestination);
  }

  async listUsableForTenant(tenantId: string): Promise<AdminStorageDestination[]> {
    const rows = await this.adapter.query<AdminStorageDestinationEntity>(
      `SELECT * FROM admin_storage_destinations
        WHERE is_active = 1
          AND status = 'active'
          AND (
            (scope_type = 'tenant' AND scope_id = ?)
            OR (scope_type = 'platform' AND scope_id = 'platform')
          )
        ORDER BY scope_type ASC, name ASC`,
      [tenantId]
    );
    return rows.map(entityToDestination);
  }

  async findByScopeAndName(
    scopeType: AdminResourceScopeType,
    scopeId: string,
    name: string
  ): Promise<AdminStorageDestination | null> {
    const row = await this.adapter.queryOne<AdminStorageDestinationEntity>(
      `SELECT * FROM admin_storage_destinations
        WHERE scope_type = ? AND scope_id = ? AND name = ? AND is_active = 1
        LIMIT 1`,
      [scopeType, scopeId, name]
    );
    return row ? entityToDestination(row) : null;
  }

  async getDestination(id: string): Promise<AdminStorageDestination | null> {
    const row = await this.findById(id);
    return row ? entityToDestination(row) : null;
  }

  async getDestinationWithCredential(
    id: string
  ): Promise<AdminStorageDestinationWithCredential | null> {
    const row = await this.findById(id);
    if (!row) {
      return null;
    }
    return {
      ...entityToDestination(row),
      credential_encrypted: row.credential_encrypted,
    };
  }

  async updateDestination(
    id: string,
    input: AdminStorageDestinationUpdateInput
  ): Promise<AdminStorageDestination | null> {
    const updates: string[] = [];
    const values: unknown[] = [];

    if (input.display_name !== undefined) {
      updates.push('display_name = ?');
      values.push(input.display_name);
    }
    if (input.description !== undefined) {
      updates.push('description = ?');
      values.push(input.description);
    }
    if (input.config !== undefined) {
      updates.push('config_json = ?');
      values.push(JSON.stringify(input.config));
    }
    if (input.status !== undefined) {
      updates.push('status = ?');
      values.push(input.status);
    }
    if (input.updated_by !== undefined) {
      updates.push('updated_by = ?');
      values.push(input.updated_by);
    }

    if (updates.length === 0) {
      return this.getDestination(id);
    }

    updates.push('updated_at = ?');
    values.push(getCurrentTimestamp(), id);

    await this.adapter.execute(
      `UPDATE admin_storage_destinations SET ${updates.join(', ')} WHERE id = ? AND is_active = 1`,
      values
    );
    return this.getDestination(id);
  }

  async updateCredential(
    id: string,
    input: { credential_encrypted: string; key_version: number; updated_by?: string | null }
  ): Promise<AdminStorageDestination | null> {
    const now = getCurrentTimestamp();
    await this.adapter.execute(
      `UPDATE admin_storage_destinations
          SET credential_encrypted = ?,
              credential_key_version = ?,
              credential_updated_at = ?,
              credential_updated_by = ?,
              updated_by = ?,
              updated_at = ?
        WHERE id = ? AND is_active = 1`,
      [
        input.credential_encrypted,
        input.key_version,
        now,
        input.updated_by ?? null,
        input.updated_by ?? null,
        now,
        id,
      ]
    );
    return this.getDestination(id);
  }

  async deleteDestination(id: string, updatedBy?: string | null): Promise<boolean> {
    const usageCount = await this.countActiveUsage(id);
    if (usageCount > 0) {
      throw new Error('storage_destination_in_use');
    }
    const result = await this.adapter.execute(
      `UPDATE admin_storage_destinations
          SET is_active = 0, updated_by = ?, updated_at = ?
        WHERE id = ? AND is_active = 1`,
      [updatedBy ?? null, getCurrentTimestamp(), id]
    );
    return result.rowsAffected > 0;
  }

  async recordUsage(
    input: AdminStorageDestinationUsageInput
  ): Promise<AdminStorageDestinationUsage> {
    const now = getCurrentTimestamp();
    const tenantId = requireTenantId(input.tenant_id, 'AdminStorageDestinationRepository usage');
    const id = generateId();
    await this.adapter.execute(
      `INSERT INTO admin_storage_destination_usages (
         id, destination_id, feature, resource_type, resource_id, tenant_id,
         metadata_json, created_by, created_at, updated_at, is_active
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(destination_id, feature, resource_type, resource_id)
       DO UPDATE SET
         tenant_id = excluded.tenant_id,
         metadata_json = excluded.metadata_json,
         created_by = excluded.created_by,
         updated_at = excluded.updated_at,
         is_active = 1`,
      [
        id,
        input.destination_id,
        input.feature,
        input.resource_type,
        input.resource_id,
        tenantId,
        JSON.stringify(input.metadata ?? {}),
        input.created_by ?? null,
        now,
        now,
      ]
    );
    const rows = await this.listUsage(input.destination_id);
    const usage = rows.find(
      (item) =>
        item.feature === input.feature &&
        item.resource_type === input.resource_type &&
        item.resource_id === input.resource_id
    );
    if (!usage) {
      throw new Error('Failed to record storage destination usage');
    }
    return usage;
  }

  async listUsage(destinationId: string): Promise<AdminStorageDestinationUsage[]> {
    const rows = await this.adapter.query<AdminStorageDestinationUsageEntity>(
      `SELECT * FROM admin_storage_destination_usages
        WHERE destination_id = ? AND is_active = 1
        ORDER BY feature ASC, resource_type ASC, resource_id ASC`,
      [destinationId]
    );
    return rows.map(entityToUsage);
  }

  async countActiveUsage(destinationId: string): Promise<number> {
    const row = await this.adapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count
         FROM admin_storage_destination_usages
        WHERE destination_id = ? AND is_active = 1`,
      [destinationId]
    );
    return Number(row?.count ?? 0);
  }
}
