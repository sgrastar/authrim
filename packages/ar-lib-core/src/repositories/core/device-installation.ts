/**
 * Canonical Native SSO Device Installation Repository
 *
 * The Phase 1 public device inventory unit is a server-assigned installation,
 * not the device_secret row. This repository stores that canonical record while
 * keeping legacy device_secret-backed installations migratable on first use.
 */

import { BaseRepository, generateId, getCurrentTimestamp } from '../base';
import type { DatabaseAdapter } from '../../db/adapter';
import type {
  CreateDeviceInstallationInput,
  DeviceInstallation,
  DeviceSecret,
} from '../../types/oidc';
import { getDeviceSecretInstallationId } from '../../utils/native-sso-installation';
import { createLogger } from '../../utils/logger';

const log = createLogger().module('DeviceInstallation');

interface DeviceInstallationRow {
  id: string;
  tenant_id: string;
  user_id: string;
  client_id?: string | null;
  trust_group_id?: string | null;
  source_installation_id?: string | null;
  source_client_id?: string | null;
  linked_device_secret_id?: string | null;
  session_id?: string | null;
  display_name?: string | null;
  device_platform?: string | null;
  created_at: number;
  updated_at: number;
  last_seen_at?: number | null;
  revoked_at?: number | null;
  revoke_reason?: string | null;
  is_active: number;
}

export type FindDeviceInstallationsOptions = {
  validOnly?: boolean;
  trustGroupId?: string;
  clientId?: string;
};

function isMissingDeviceInstallationsTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('device_installations') ||
    message.includes('no such table') ||
    message.includes('relation "device_installations" does not exist')
  );
}

function isDuplicateDeviceInstallationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('UNIQUE constraint failed') ||
    message.includes('duplicate key') ||
    message.includes('Duplicate entry')
  );
}

function normalizeDisplayName(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.length > 0 ? normalized : undefined;
}

function requireTenantId(tenantId: string | undefined, context: string): string {
  const normalized = tenantId?.trim();
  if (!normalized) {
    throw new Error(`${context} requires tenantId`);
  }
  return normalized;
}

export class DeviceInstallationRepository extends BaseRepository<DeviceInstallation> {
  private readonly tenantId: string;

  constructor(adapter: DatabaseAdapter, tenantId: string) {
    super(adapter, {
      tableName: 'device_installations',
      softDelete: true,
      softDeleteField: 'is_active',
      allowedFields: [
        'tenant_id',
        'user_id',
        'client_id',
        'trust_group_id',
        'source_installation_id',
        'source_client_id',
        'linked_device_secret_id',
        'session_id',
        'display_name',
        'device_platform',
        'last_seen_at',
        'revoked_at',
        'revoke_reason',
        'is_active',
      ],
    });
    this.tenantId = requireTenantId(tenantId, 'DeviceInstallationRepository');
  }

  async createInstallation(
    input: CreateDeviceInstallationInput
  ): Promise<DeviceInstallation | null> {
    const now = getCurrentTimestamp();
    const tenantId = requireTenantId(
      input.tenant_id ?? this.tenantId,
      'DeviceInstallationRepository.createInstallation'
    );
    const entity: DeviceInstallation = {
      id: input.id ?? `inst_${generateId()}`,
      tenant_id: tenantId,
      user_id: input.user_id,
      client_id: input.client_id,
      trust_group_id: input.trust_group_id,
      source_installation_id: input.source_installation_id,
      source_client_id: input.source_client_id,
      linked_device_secret_id: input.linked_device_secret_id,
      session_id: input.session_id,
      display_name: normalizeDisplayName(input.display_name),
      device_platform: input.device_platform,
      created_at: now,
      updated_at: now,
      last_seen_at: input.last_seen_at,
      revoked_at: undefined,
      revoke_reason: undefined,
      is_active: 1,
    };

    try {
      await this.adapter.execute(
        `
          INSERT INTO device_installations (
            id, tenant_id, user_id, client_id, trust_group_id,
            source_installation_id, source_client_id, linked_device_secret_id,
            session_id, display_name, device_platform, created_at, updated_at,
            last_seen_at, revoked_at, revoke_reason, is_active
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          entity.id,
          entity.tenant_id,
          entity.user_id,
          entity.client_id ?? null,
          entity.trust_group_id ?? null,
          entity.source_installation_id ?? null,
          entity.source_client_id ?? null,
          entity.linked_device_secret_id ?? null,
          entity.session_id ?? null,
          entity.display_name ?? null,
          entity.device_platform ?? null,
          entity.created_at,
          entity.updated_at,
          entity.last_seen_at ?? null,
          entity.revoked_at ?? null,
          entity.revoke_reason ?? null,
          entity.is_active,
        ]
      );
      return entity;
    } catch (error) {
      if (isMissingDeviceInstallationsTableError(error)) {
        log.warn('device_installations table missing; using device_secret-backed fallback', {
          action: 'NativeSSO',
        });
        return null;
      }
      if (isDuplicateDeviceInstallationError(error)) {
        return this.findById(entity.id, entity.tenant_id);
      }
      throw error;
    }
  }

  override async findById(
    id: string,
    tenantId: string = this.tenantId
  ): Promise<DeviceInstallation | null> {
    const normalizedTenantId = requireTenantId(tenantId, 'DeviceInstallationRepository.findById');
    try {
      const row = await this.adapter.queryOne<DeviceInstallationRow>(
        `
          SELECT * FROM device_installations
          WHERE id = ? AND tenant_id = ?
          LIMIT 1
        `,
        [id, normalizedTenantId]
      );
      return row ? this.rowToEntity(row) : null;
    } catch (error) {
      if (isMissingDeviceInstallationsTableError(error)) {
        return null;
      }
      throw error;
    }
  }

  async findByUserId(
    userId: string,
    tenantId: string = this.tenantId,
    options: FindDeviceInstallationsOptions = {}
  ): Promise<DeviceInstallation[]> {
    const normalizedTenantId = requireTenantId(
      tenantId,
      'DeviceInstallationRepository.findByUserId'
    );
    let sql = `
      SELECT * FROM device_installations
      WHERE tenant_id = ? AND user_id = ? AND is_active = 1
    `;
    const params: unknown[] = [normalizedTenantId, userId];

    if (options.validOnly) {
      sql += ' AND revoked_at IS NULL';
    }
    if (options.trustGroupId) {
      sql += ' AND trust_group_id = ?';
      params.push(options.trustGroupId);
    } else if (options.clientId) {
      sql += ' AND client_id = ?';
      params.push(options.clientId);
    }

    sql += ' ORDER BY COALESCE(last_seen_at, updated_at, created_at) DESC';

    try {
      const rows = await this.adapter.query<DeviceInstallationRow>(sql, params);
      return rows.map((row) => this.rowToEntity(row));
    } catch (error) {
      if (isMissingDeviceInstallationsTableError(error)) {
        return [];
      }
      throw error;
    }
  }

  async findActiveDerivedInstallation(input: {
    tenantId?: string;
    userId: string;
    clientId: string;
    sourceInstallationId: string;
  }): Promise<DeviceInstallation | null> {
    const tenantId = requireTenantId(
      input.tenantId ?? this.tenantId,
      'DeviceInstallationRepository.findActiveDerivedInstallation'
    );
    try {
      const row = await this.adapter.queryOne<DeviceInstallationRow>(
        `
          SELECT * FROM device_installations
          WHERE tenant_id = ?
            AND user_id = ?
            AND client_id = ?
            AND source_installation_id = ?
            AND is_active = 1
            AND revoked_at IS NULL
          ORDER BY updated_at DESC
          LIMIT 1
        `,
        [tenantId, input.userId, input.clientId, input.sourceInstallationId]
      );
      return row ? this.rowToEntity(row) : null;
    } catch (error) {
      if (isMissingDeviceInstallationsTableError(error)) {
        return null;
      }
      throw error;
    }
  }

  async ensureForDeviceSecret(deviceSecret: DeviceSecret): Promise<DeviceInstallation | null> {
    const installationId = getDeviceSecretInstallationId(deviceSecret);
    const existing = await this.findById(installationId, deviceSecret.tenant_id);
    if (existing) {
      await this.updateFromDeviceSecret(existing.id, deviceSecret);
      return this.findById(existing.id, existing.tenant_id);
    }

    return this.createInstallation({
      id: installationId,
      tenant_id: deviceSecret.tenant_id,
      user_id: deviceSecret.user_id,
      client_id: deviceSecret.client_id,
      trust_group_id: deviceSecret.trust_group_id,
      source_installation_id: deviceSecret.source_installation_id,
      source_client_id: deviceSecret.source_client_id,
      linked_device_secret_id: deviceSecret.id,
      session_id: deviceSecret.session_id,
      display_name: deviceSecret.device_name,
      device_platform: deviceSecret.device_platform,
      last_seen_at: deviceSecret.last_used_at ?? deviceSecret.updated_at ?? deviceSecret.created_at,
    });
  }

  async ensureForNativeSSOTokenExchange(input: {
    sourceDeviceSecret: DeviceSecret;
    targetClientId: string;
    targetTrustGroupId?: string;
    sourceClientId?: string;
    sameClient: boolean;
    lastSeenAt: number;
  }): Promise<DeviceInstallation | null> {
    if (input.sameClient) {
      const sourceInstallation = await this.ensureForDeviceSecret(input.sourceDeviceSecret);
      if (sourceInstallation) {
        await this.markSeen(sourceInstallation.id, sourceInstallation.tenant_id, input.lastSeenAt);
        return this.findById(sourceInstallation.id, sourceInstallation.tenant_id);
      }
      return null;
    }

    const sourceInstallationId = getDeviceSecretInstallationId(input.sourceDeviceSecret);
    const existing = await this.findActiveDerivedInstallation({
      tenantId: input.sourceDeviceSecret.tenant_id,
      userId: input.sourceDeviceSecret.user_id,
      clientId: input.targetClientId,
      sourceInstallationId,
    });

    if (existing) {
      await this.updateInstallation(existing.id, existing.tenant_id, {
        trust_group_id: input.targetTrustGroupId,
        source_client_id: input.sourceClientId ?? input.sourceDeviceSecret.client_id,
        session_id: input.sourceDeviceSecret.session_id,
        device_platform: input.sourceDeviceSecret.device_platform,
        last_seen_at: input.lastSeenAt,
      });
      return this.findById(existing.id, existing.tenant_id);
    }

    return this.createInstallation({
      tenant_id: input.sourceDeviceSecret.tenant_id,
      user_id: input.sourceDeviceSecret.user_id,
      client_id: input.targetClientId,
      trust_group_id: input.targetTrustGroupId,
      source_installation_id: sourceInstallationId,
      source_client_id: input.sourceClientId ?? input.sourceDeviceSecret.client_id,
      session_id: input.sourceDeviceSecret.session_id,
      display_name: input.sourceDeviceSecret.device_name,
      device_platform: input.sourceDeviceSecret.device_platform,
      last_seen_at: input.lastSeenAt,
    });
  }

  async updateDisplayName(
    id: string,
    tenantId: string,
    displayName: string
  ): Promise<DeviceInstallation | null> {
    await this.updateInstallation(id, tenantId, {
      display_name: normalizeDisplayName(displayName),
    });
    return this.findById(id, tenantId);
  }

  async markSeen(id: string, tenantId: string, lastSeenAt: number): Promise<boolean> {
    const now = getCurrentTimestamp();
    try {
      const result = await this.adapter.execute(
        `
          UPDATE device_installations
          SET last_seen_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND is_active = 1
        `,
        [lastSeenAt, now, id, tenantId]
      );
      return result.rowsAffected > 0;
    } catch (error) {
      if (isMissingDeviceInstallationsTableError(error)) {
        return false;
      }
      throw error;
    }
  }

  async revoke(id: string, tenantId: string, reason?: string): Promise<boolean> {
    const now = getCurrentTimestamp();
    try {
      const result = await this.adapter.execute(
        `
          UPDATE device_installations
          SET revoked_at = ?, revoke_reason = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND is_active = 1 AND revoked_at IS NULL
        `,
        [now, reason ?? null, now, id, tenantId]
      );
      return result.rowsAffected > 0;
    } catch (error) {
      if (isMissingDeviceInstallationsTableError(error)) {
        return false;
      }
      throw error;
    }
  }

  private async updateFromDeviceSecret(id: string, deviceSecret: DeviceSecret): Promise<boolean> {
    return this.updateInstallation(id, deviceSecret.tenant_id, {
      client_id: deviceSecret.client_id,
      trust_group_id: deviceSecret.trust_group_id,
      source_installation_id: deviceSecret.source_installation_id,
      source_client_id: deviceSecret.source_client_id,
      linked_device_secret_id: deviceSecret.id,
      session_id: deviceSecret.session_id,
      device_platform: deviceSecret.device_platform,
      last_seen_at: deviceSecret.last_used_at ?? deviceSecret.updated_at ?? deviceSecret.created_at,
    });
  }

  private async updateInstallation(
    id: string,
    tenantId: string,
    input: Partial<
      Pick<
        DeviceInstallation,
        | 'client_id'
        | 'trust_group_id'
        | 'source_installation_id'
        | 'source_client_id'
        | 'linked_device_secret_id'
        | 'session_id'
        | 'display_name'
        | 'device_platform'
        | 'last_seen_at'
      >
    >
  ): Promise<boolean> {
    const updates: string[] = [];
    const params: unknown[] = [];

    for (const [field, value] of Object.entries(input)) {
      if (value === undefined) {
        continue;
      }
      updates.push(`${field} = ?`);
      params.push(value);
    }

    if (updates.length === 0) {
      return false;
    }

    const now = getCurrentTimestamp();
    updates.push('updated_at = ?');
    params.push(now, id, tenantId);

    try {
      const result = await this.adapter.execute(
        `
          UPDATE device_installations
          SET ${updates.join(', ')}
          WHERE id = ? AND tenant_id = ?
        `,
        params
      );
      return result.rowsAffected > 0;
    } catch (error) {
      if (isMissingDeviceInstallationsTableError(error)) {
        return false;
      }
      throw error;
    }
  }

  private rowToEntity(row: DeviceInstallationRow): DeviceInstallation {
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      user_id: row.user_id,
      client_id: row.client_id ?? undefined,
      trust_group_id: row.trust_group_id ?? undefined,
      source_installation_id: row.source_installation_id ?? undefined,
      source_client_id: row.source_client_id ?? undefined,
      linked_device_secret_id: row.linked_device_secret_id ?? undefined,
      session_id: row.session_id ?? undefined,
      display_name: row.display_name ?? undefined,
      device_platform: row.device_platform
        ? (row.device_platform as DeviceInstallation['device_platform'])
        : undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_seen_at: row.last_seen_at ?? undefined,
      revoked_at: row.revoked_at ?? undefined,
      revoke_reason: row.revoke_reason ?? undefined,
      is_active: row.is_active,
    };
  }
}
