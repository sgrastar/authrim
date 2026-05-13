import type { DatabaseAdapter } from '../../db/adapter';
import { BaseRepository, type BaseEntity, generateId, getCurrentTimestamp } from '../base';
import type { AdminResourceStatus } from './admin-storage-destination';

export type DatabaseConnectionProvider = 'd1' | 'hyperdrive' | 'postgres' | 'mysql' | 'custom';

interface AdminDatabaseConnectionEntity extends BaseEntity {
  name: string;
  display_name: string;
  description: string | null;
  provider: DatabaseConnectionProvider;
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

interface AdminDatabaseConnectionUsageEntity extends BaseEntity {
  connection_id: string;
  purpose: string;
  resource_type: string;
  resource_id: string;
  tenant_id: string | null;
  metadata_json: string;
  created_by: string | null;
  is_active: boolean | number;
}

export interface AdminDatabaseConnection {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  provider: DatabaseConnectionProvider;
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

export interface AdminDatabaseConnectionWithCredential extends AdminDatabaseConnection {
  credential_encrypted: string | null;
}

export interface AdminDatabaseConnectionUsage {
  id: string;
  connection_id: string;
  purpose: string;
  resource_type: string;
  resource_id: string;
  tenant_id: string | null;
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface AdminDatabaseConnectionCreateInput {
  name: string;
  display_name?: string;
  description?: string | null;
  provider: DatabaseConnectionProvider;
  config?: Record<string, unknown>;
  credential_encrypted?: string | null;
  credential_key_version?: number | null;
  credential_updated_by?: string | null;
  status?: AdminResourceStatus;
  created_by?: string | null;
}

export interface AdminDatabaseConnectionUpdateInput {
  display_name?: string;
  description?: string | null;
  config?: Record<string, unknown>;
  status?: AdminResourceStatus;
  updated_by?: string | null;
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

function entityToConnection(entity: AdminDatabaseConnectionEntity): AdminDatabaseConnection {
  return {
    id: entity.id,
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

function entityToUsage(entity: AdminDatabaseConnectionUsageEntity): AdminDatabaseConnectionUsage {
  return {
    id: entity.id,
    connection_id: entity.connection_id,
    purpose: entity.purpose,
    resource_type: entity.resource_type,
    resource_id: entity.resource_id,
    tenant_id: entity.tenant_id,
    metadata: parseConfig(entity.metadata_json),
    created_by: entity.created_by,
    created_at: entity.created_at,
    updated_at: entity.updated_at,
  };
}

export class AdminDatabaseConnectionRepository extends BaseRepository<AdminDatabaseConnectionEntity> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'admin_database_connections',
      primaryKey: 'id',
      softDelete: true,
      softDeleteField: 'is_active',
      allowedFields: ['name', 'display_name', 'provider', 'status', 'created_by', 'updated_by'],
    });
  }

  async createConnection(
    input: AdminDatabaseConnectionCreateInput
  ): Promise<AdminDatabaseConnection> {
    const now = getCurrentTimestamp();
    const id = generateId();
    const credentialUpdatedAt = input.credential_encrypted ? now : null;

    await this.adapter.execute(
      `INSERT INTO admin_database_connections (
         id, name, display_name, description, provider, config_json,
         credential_encrypted, credential_key_version, credential_updated_at, credential_updated_by,
         status, created_by, updated_by, created_at, updated_at, is_active
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        id,
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

    const created = await this.getConnection(id);
    if (!created) {
      throw new Error('Failed to create database connection');
    }
    return created;
  }

  async listConnections(): Promise<AdminDatabaseConnection[]> {
    const rows = await this.adapter.query<AdminDatabaseConnectionEntity>(
      `SELECT * FROM admin_database_connections WHERE is_active = 1 ORDER BY name ASC`
    );
    return rows.map(entityToConnection);
  }

  async getConnection(id: string): Promise<AdminDatabaseConnection | null> {
    const row = await this.findById(id);
    return row ? entityToConnection(row) : null;
  }

  async getConnectionWithCredential(
    id: string
  ): Promise<AdminDatabaseConnectionWithCredential | null> {
    const row = await this.findById(id);
    if (!row) {
      return null;
    }
    return {
      ...entityToConnection(row),
      credential_encrypted: row.credential_encrypted,
    };
  }

  async updateConnection(
    id: string,
    input: AdminDatabaseConnectionUpdateInput
  ): Promise<AdminDatabaseConnection | null> {
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
      return this.getConnection(id);
    }

    updates.push('updated_at = ?');
    values.push(getCurrentTimestamp(), id);

    await this.adapter.execute(
      `UPDATE admin_database_connections SET ${updates.join(', ')} WHERE id = ? AND is_active = 1`,
      values
    );
    return this.getConnection(id);
  }

  async updateCredential(
    id: string,
    input: { credential_encrypted: string; key_version: number; updated_by?: string | null }
  ): Promise<AdminDatabaseConnection | null> {
    const now = getCurrentTimestamp();
    await this.adapter.execute(
      `UPDATE admin_database_connections
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
    return this.getConnection(id);
  }

  async deleteConnection(id: string, updatedBy?: string | null): Promise<boolean> {
    const usageCount = await this.countActiveUsage(id);
    if (usageCount > 0) {
      throw new Error('database_connection_in_use');
    }
    const result = await this.adapter.execute(
      `UPDATE admin_database_connections
          SET is_active = 0, updated_by = ?, updated_at = ?
        WHERE id = ? AND is_active = 1`,
      [updatedBy ?? null, getCurrentTimestamp(), id]
    );
    return result.rowsAffected > 0;
  }

  async listUsage(connectionId: string): Promise<AdminDatabaseConnectionUsage[]> {
    const rows = await this.adapter.query<AdminDatabaseConnectionUsageEntity>(
      `SELECT * FROM admin_database_connection_usages
        WHERE connection_id = ? AND is_active = 1
        ORDER BY purpose ASC, resource_type ASC, resource_id ASC`,
      [connectionId]
    );
    return rows.map(entityToUsage);
  }

  async countActiveUsage(connectionId: string): Promise<number> {
    const row = await this.adapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count
         FROM admin_database_connection_usages
        WHERE connection_id = ? AND is_active = 1`,
      [connectionId]
    );
    return Number(row?.count ?? 0);
  }
}
