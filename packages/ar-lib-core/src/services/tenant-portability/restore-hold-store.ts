import type { DatabaseAdapter } from '../../db/adapter';
import { decryptValue, encryptValue } from '../../utils/pii-encryption';

type Database = Pick<DatabaseAdapter, 'execute' | 'query' | 'queryOne'>;
const MAX_ROW_BYTES = 1024 * 1024;
const MAX_PAGE_SIZE = 100;

interface HoldRow {
  reason: string;
  source_row_sha256: string;
  payload_encrypted: string;
  payload_key_version: number;
}

export interface TenantBackupRestoreHoldSummary {
  datasetId: string;
  reason: string;
  count: number;
}

function identifier(value: string, max = 256): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > max)
    throw new Error('backup_restore_hold_invalid');
}

function installedIdentifier(value: string): void {
  identifier(value);
  if (!/^[A-Za-z0-9_.:-]+$/.test(value)) throw new Error('backup_restore_hold_invalid');
}

function reason(value: string): void {
  if (!/^[a-z0-9][a-z0-9_.:-]{0,127}$/.test(value)) throw new Error('backup_restore_hold_invalid');
}

function rowInput(recordId: string, rowJson: string): void {
  if (typeof recordId !== 'string' || recordId.length < 1 || recordId.length > 4096)
    throw new Error('backup_restore_hold_invalid');
  try {
    JSON.parse(recordId);
    JSON.parse(rowJson);
  } catch {
    throw new Error('backup_restore_hold_invalid');
  }
  if (!rowJson || new TextEncoder().encode(rowJson).length > MAX_ROW_BYTES)
    throw new Error('backup_restore_hold_row_too_large');
}

function keyInput(key: string, keyVersion: number): void {
  if (!/^[a-fA-F0-9]{64}$/.test(key) || !Number.isSafeInteger(keyVersion) || keyVersion < 1)
    throw new Error('backup_restore_hold_key_invalid');
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Encrypted, immutable quarantine for source work that must never enter a live target queue. */
export class TenantBackupRestoreHoldStore {
  constructor(private readonly database: Database) {}

  private async assertStored(input: {
    tenantId: string;
    operationId: string;
    datasetId: string;
    recordId: string;
    reason: string;
    rowJson: string;
    encryptionKey: string;
    keyVersion: number;
  }): Promise<void> {
    const row = await this.database.queryOne<HoldRow>(
      `SELECT reason,source_row_sha256,payload_encrypted,payload_key_version
       FROM tenant_backup_restored_holds
       WHERE operation_id=? AND tenant_id=? AND dataset_id=? AND record_id=?`,
      [input.operationId, input.tenantId, input.datasetId, input.recordId]
    );
    const expectedDigest = await sha256(input.rowJson);
    if (
      !row ||
      row.reason !== input.reason ||
      row.source_row_sha256 !== expectedDigest ||
      row.payload_key_version !== input.keyVersion ||
      typeof row.payload_encrypted !== 'string'
    )
      throw new Error('backup_restore_hold_conflict');
    const decrypted = await decryptValue(row.payload_encrypted, input.encryptionKey);
    if (
      !decrypted.wasEncrypted ||
      decrypted.keyVersion !== input.keyVersion ||
      decrypted.decrypted !== input.rowJson
    )
      throw new Error('backup_restore_hold_conflict');
  }

  async write(input: {
    tenantId: string;
    operationId: string;
    datasetId: string;
    recordId: string;
    reason: string;
    rowJson: string;
    encryptionKey: string;
    keyVersion: number;
    now: number;
  }): Promise<void> {
    for (const value of [input.tenantId, input.operationId]) installedIdentifier(value);
    installedIdentifier(input.datasetId);
    reason(input.reason);
    rowInput(input.recordId, input.rowJson);
    keyInput(input.encryptionKey, input.keyVersion);
    if (!Number.isSafeInteger(input.now) || input.now < 0)
      throw new Error('backup_restore_hold_invalid');
    const rowDigest = await sha256(input.rowJson);
    const encrypted = await encryptValue(
      input.rowJson,
      input.encryptionKey,
      'AES-256-GCM',
      input.keyVersion
    );
    const result = await this.database.execute(
      `INSERT INTO tenant_backup_restored_holds
       (operation_id,tenant_id,dataset_id,record_id,reason,source_row_sha256,
        payload_encrypted,payload_key_version,created_at)
       VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id,dataset_id,record_id) DO NOTHING`,
      [
        input.operationId,
        input.tenantId,
        input.datasetId,
        input.recordId,
        input.reason,
        rowDigest,
        encrypted.encrypted,
        input.keyVersion,
        input.now,
      ]
    );
    if (!result.success) throw new Error('backup_restore_hold_write_failed');
    await this.assertStored(input);
  }

  async verify(input: Omit<Parameters<TenantBackupRestoreHoldStore['write']>[0], 'now'>) {
    for (const value of [input.tenantId, input.operationId]) installedIdentifier(value);
    installedIdentifier(input.datasetId);
    reason(input.reason);
    rowInput(input.recordId, input.rowJson);
    keyInput(input.encryptionKey, input.keyVersion);
    await this.assertStored(input);
  }

  async summaries(
    tenantId: string,
    operationId: string
  ): Promise<TenantBackupRestoreHoldSummary[]> {
    installedIdentifier(tenantId);
    installedIdentifier(operationId);
    const rows = await this.database.query<{
      dataset_id: string;
      reason: string;
      item_count: number;
    }>(
      `SELECT dataset_id,reason,count(*) AS item_count
       FROM tenant_backup_restored_holds WHERE tenant_id=? AND operation_id=?
       GROUP BY dataset_id,reason ORDER BY dataset_id,reason LIMIT ?`,
      [tenantId, operationId, MAX_PAGE_SIZE]
    );
    if (
      rows.length > MAX_PAGE_SIZE ||
      rows.some(
        (row) =>
          !/^[A-Za-z0-9_.:-]{1,256}$/.test(row.dataset_id) ||
          !/^[a-z0-9][a-z0-9_.:-]{0,127}$/.test(row.reason) ||
          !Number.isSafeInteger(row.item_count) ||
          row.item_count < 1
      )
    )
      throw new Error('backup_restore_hold_invalid');
    return rows.map((row) => ({
      datasetId: row.dataset_id,
      reason: row.reason,
      count: row.item_count,
    }));
  }
}
