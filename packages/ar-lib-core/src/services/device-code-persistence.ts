import type { DatabaseAdapter } from '../db/adapter';
import type { DatabaseSource } from '../db/adapter-source';
import { ensureOptionalDatabaseAdapter } from '../db/adapter-source';
import type { DeviceCodeMetadata } from '../types/oidc';

interface DeviceCodeRow extends Omit<DeviceCodeMetadata, 'token_issued'> {
  token_issued?: number | null;
}

export interface DeviceCodePersistenceAdapter {
  storeDeviceCode(metadata: DeviceCodeMetadata): Promise<void>;
  getByDeviceCode(deviceCode: string): Promise<DeviceCodeMetadata | null>;
  getByUserCode(userCode: string): Promise<DeviceCodeMetadata | null>;
  approveDeviceCode(deviceCode: string, userId: string, sub: string): Promise<void>;
  denyDeviceCode(deviceCode: string): Promise<void>;
  updatePoll(deviceCode: string, lastPollAt: number, pollCount: number): Promise<void>;
  markTokenIssued(deviceCode: string, tokenIssuedAt: number): Promise<void>;
  deleteDeviceCode(deviceCode: string): Promise<void>;
  deleteExpired(nowMs: number): Promise<number>;
  getType(): string;
}

function mapDeviceCodeRow(row: DeviceCodeRow | null): DeviceCodeMetadata | null {
  if (!row) {
    return null;
  }

  return {
    ...row,
    token_issued: row.token_issued === 1,
  };
}

class DatabaseDeviceCodePersistenceAdapter implements DeviceCodePersistenceAdapter {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly tenantId?: string
  ) {}

  private resolveWriteTenantId(recordTenantId: string | undefined): string | undefined {
    const normalizedRecordTenantId = recordTenantId?.trim() || undefined;
    if (!this.tenantId) {
      return normalizedRecordTenantId;
    }
    if (normalizedRecordTenantId && normalizedRecordTenantId !== this.tenantId) {
      throw new Error('Device code persistence tenant mismatch');
    }
    return this.tenantId;
  }

  async storeDeviceCode(metadata: DeviceCodeMetadata): Promise<void> {
    const tenantId = this.resolveWriteTenantId(metadata.tenant_id);

    if (tenantId) {
      const updated = await this.db.execute(
        `UPDATE device_codes
         SET user_code = ?, client_id = ?, scope = ?, status = ?, user_id = ?, sub = ?,
             created_at = ?, expires_at = ?, last_poll_at = ?, poll_count = ?, token_issued = ?, token_issued_at = ?,
             tenant_id = ?
         WHERE device_code = ?
           AND tenant_id = ?`,
        [
          metadata.user_code,
          metadata.client_id,
          metadata.scope,
          metadata.status,
          metadata.user_id ?? null,
          metadata.sub ?? null,
          metadata.created_at,
          metadata.expires_at,
          metadata.last_poll_at ?? null,
          metadata.poll_count ?? 0,
          metadata.token_issued ? 1 : 0,
          metadata.token_issued_at ?? null,
          tenantId,
          metadata.device_code,
          tenantId,
        ]
      );

      if (updated.rowsAffected > 0) {
        return;
      }

      await this.db.execute(
        `INSERT INTO device_codes (
           device_code, user_code, client_id, scope, status, user_id, sub,
           created_at, expires_at, last_poll_at, poll_count, token_issued, token_issued_at, tenant_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          metadata.device_code,
          metadata.user_code,
          metadata.client_id,
          metadata.scope,
          metadata.status,
          metadata.user_id ?? null,
          metadata.sub ?? null,
          metadata.created_at,
          metadata.expires_at,
          metadata.last_poll_at ?? null,
          metadata.poll_count ?? 0,
          metadata.token_issued ? 1 : 0,
          metadata.token_issued_at ?? null,
          tenantId,
        ]
      );
      return;
    }

    const updated = await this.db.execute(
      `UPDATE device_codes
       SET user_code = ?, client_id = ?, scope = ?, status = ?, user_id = ?, sub = ?,
           created_at = ?, expires_at = ?, last_poll_at = ?, poll_count = ?, token_issued = ?, token_issued_at = ?
       WHERE device_code = ?`,
      [
        metadata.user_code,
        metadata.client_id,
        metadata.scope,
        metadata.status,
        metadata.user_id ?? null,
        metadata.sub ?? null,
        metadata.created_at,
        metadata.expires_at,
        metadata.last_poll_at ?? null,
        metadata.poll_count ?? 0,
        metadata.token_issued ? 1 : 0,
        metadata.token_issued_at ?? null,
        metadata.device_code,
      ]
    );

    if (updated.rowsAffected > 0) {
      return;
    }

    await this.db.execute(
      `INSERT INTO device_codes (
         device_code, user_code, client_id, scope, status, user_id, sub,
         created_at, expires_at, last_poll_at, poll_count, token_issued, token_issued_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        metadata.device_code,
        metadata.user_code,
        metadata.client_id,
        metadata.scope,
        metadata.status,
        metadata.user_id ?? null,
        metadata.sub ?? null,
        metadata.created_at,
        metadata.expires_at,
        metadata.last_poll_at ?? null,
        metadata.poll_count ?? 0,
        metadata.token_issued ? 1 : 0,
        metadata.token_issued_at ?? null,
      ]
    );
  }

  async getByDeviceCode(deviceCode: string): Promise<DeviceCodeMetadata | null> {
    if (this.tenantId) {
      const row = await this.db.queryOne<DeviceCodeRow>(
        `SELECT tenant_id, device_code, user_code, client_id, scope, status, user_id, sub,
                created_at, expires_at, last_poll_at, poll_count, token_issued, token_issued_at
           FROM device_codes
          WHERE tenant_id = ?
            AND device_code = ?`,
        [this.tenantId, deviceCode]
      );

      return mapDeviceCodeRow(row);
    }

    const row = await this.db.queryOne<DeviceCodeRow>(
      `SELECT device_code, user_code, client_id, scope, status, user_id, sub,
              created_at, expires_at, last_poll_at, poll_count, token_issued, token_issued_at
         FROM device_codes
        WHERE device_code = ?`,
      [deviceCode]
    );

    return mapDeviceCodeRow(row);
  }

  async getByUserCode(userCode: string): Promise<DeviceCodeMetadata | null> {
    if (this.tenantId) {
      const row = await this.db.queryOne<DeviceCodeRow>(
        `SELECT tenant_id, device_code, user_code, client_id, scope, status, user_id, sub,
                created_at, expires_at, last_poll_at, poll_count, token_issued, token_issued_at
           FROM device_codes
          WHERE tenant_id = ?
            AND user_code = ?`,
        [this.tenantId, userCode]
      );

      return mapDeviceCodeRow(row);
    }

    const row = await this.db.queryOne<DeviceCodeRow>(
      `SELECT device_code, user_code, client_id, scope, status, user_id, sub,
              created_at, expires_at, last_poll_at, poll_count, token_issued, token_issued_at
         FROM device_codes
        WHERE user_code = ?`,
      [userCode]
    );

    return mapDeviceCodeRow(row);
  }

  async approveDeviceCode(deviceCode: string, userId: string, sub: string): Promise<void> {
    if (this.tenantId) {
      await this.db.execute(
        'UPDATE device_codes SET status = ?, user_id = ?, sub = ? WHERE tenant_id = ? AND device_code = ?',
        ['approved', userId, sub, this.tenantId, deviceCode]
      );
      return;
    }

    await this.db.execute(
      'UPDATE device_codes SET status = ?, user_id = ?, sub = ? WHERE device_code = ?',
      ['approved', userId, sub, deviceCode]
    );
  }

  async denyDeviceCode(deviceCode: string): Promise<void> {
    if (this.tenantId) {
      await this.db.execute(
        'UPDATE device_codes SET status = ? WHERE tenant_id = ? AND device_code = ?',
        ['denied', this.tenantId, deviceCode]
      );
      return;
    }

    await this.db.execute('UPDATE device_codes SET status = ? WHERE device_code = ?', [
      'denied',
      deviceCode,
    ]);
  }

  async updatePoll(deviceCode: string, lastPollAt: number, pollCount: number): Promise<void> {
    if (this.tenantId) {
      await this.db.execute(
        'UPDATE device_codes SET last_poll_at = ?, poll_count = ? WHERE tenant_id = ? AND device_code = ?',
        [lastPollAt, pollCount, this.tenantId, deviceCode]
      );
      return;
    }

    await this.db.execute(
      'UPDATE device_codes SET last_poll_at = ?, poll_count = ? WHERE device_code = ?',
      [lastPollAt, pollCount, deviceCode]
    );
  }

  async markTokenIssued(deviceCode: string, tokenIssuedAt: number): Promise<void> {
    if (this.tenantId) {
      await this.db.execute(
        'UPDATE device_codes SET token_issued = ?, token_issued_at = ? WHERE tenant_id = ? AND device_code = ?',
        [1, tokenIssuedAt, this.tenantId, deviceCode]
      );
      return;
    }

    await this.db.execute(
      'UPDATE device_codes SET token_issued = ?, token_issued_at = ? WHERE device_code = ?',
      [1, tokenIssuedAt, deviceCode]
    );
  }

  async deleteDeviceCode(deviceCode: string): Promise<void> {
    if (this.tenantId) {
      await this.db.execute('DELETE FROM device_codes WHERE tenant_id = ? AND device_code = ?', [
        this.tenantId,
        deviceCode,
      ]);
      return;
    }

    await this.db.execute('DELETE FROM device_codes WHERE device_code = ?', [deviceCode]);
  }

  async deleteExpired(nowMs: number): Promise<number> {
    if (this.tenantId) {
      const result = await this.db.execute(
        'DELETE FROM device_codes WHERE tenant_id = ? AND expires_at < ?',
        [this.tenantId, nowMs]
      );
      return result.rowsAffected;
    }

    const result = await this.db.execute('DELETE FROM device_codes WHERE expires_at < ?', [nowMs]);
    return result.rowsAffected;
  }

  getType(): string {
    return this.db.getType();
  }
}

export function createDeviceCodePersistenceAdapter(
  source: DatabaseSource | null | undefined,
  partition: string,
  tenantId: string
): DeviceCodePersistenceAdapter | null {
  const normalizedTenantId = tenantId.trim();
  if (!normalizedTenantId) {
    throw new Error('Device code persistence requires a tenantId');
  }

  const adapter = ensureOptionalDatabaseAdapter(source, partition);
  if (!adapter) {
    return null;
  }

  return new DatabaseDeviceCodePersistenceAdapter(adapter, normalizedTenantId);
}

export function createGlobalDeviceCodePersistenceAdapter(
  source: DatabaseSource | null | undefined,
  partition: string = 'device-code-store-system'
): DeviceCodePersistenceAdapter | null {
  const adapter = ensureOptionalDatabaseAdapter(source, partition);
  if (!adapter) {
    return null;
  }

  return new DatabaseDeviceCodePersistenceAdapter(adapter);
}
