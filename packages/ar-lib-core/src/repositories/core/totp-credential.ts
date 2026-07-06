import { generateId, getCurrentTimestamp } from '../base';
import type { DatabaseAdapter } from '../../db/adapter';
import type { TotpAlgorithm } from '../../utils/totp';

export type TotpCredentialStatus = 'pending' | 'active' | 'disabled';

export interface TotpCredential {
  id: string;
  tenant_id: string;
  user_id: string;
  secret_encrypted: string;
  secret_key_version: number;
  label: string | null;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
  window: number;
  status: TotpCredentialStatus;
  last_used_time_step: number | null;
  created_at: number;
  activated_at: number | null;
  last_used_at: number | null;
}

export interface CreateTotpCredentialInput {
  id?: string;
  user_id: string;
  secret_encrypted: string;
  secret_key_version?: number;
  label?: string | null;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
  window: number;
  status?: TotpCredentialStatus;
}

export interface TotpBackupCode {
  id: string;
  tenant_id: string;
  user_id: string;
  credential_id: string | null;
  code_hash: string;
  code_prefix: string;
  created_at: number;
  used_at: number | null;
}

export interface CreateTotpBackupCodeInput {
  id?: string;
  user_id: string;
  credential_id?: string | null;
  code_hash: string;
  code_prefix: string;
}

interface TotpCredentialRow extends TotpCredential {}
interface TotpBackupCodeRow extends TotpBackupCode {}

function requireTenantId(tenantId: string, context: string): string {
  const normalized = tenantId.trim();
  if (!normalized) {
    throw new Error(`${context} requires tenantId`);
  }
  return normalized;
}

function normalizeStatus(value: string): TotpCredentialStatus {
  return value === 'active' || value === 'disabled' ? value : 'pending';
}

function normalizeAlgorithm(value: string): TotpAlgorithm {
  return value === 'SHA256' ? 'SHA256' : 'SHA1';
}

export class TotpCredentialRepository {
  protected readonly adapter: DatabaseAdapter;
  protected readonly tenantId: string;

  constructor(adapter: DatabaseAdapter, tenantId: string) {
    this.adapter = adapter;
    this.tenantId = requireTenantId(tenantId, 'TotpCredentialRepository');
  }

  async create(input: CreateTotpCredentialInput): Promise<TotpCredential> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();
    const status = input.status ?? 'pending';
    await this.adapter.execute(
      `INSERT INTO totp_credentials (
        id, tenant_id, user_id, secret_encrypted, secret_key_version, label,
        algorithm, digits, period, window, status, last_used_time_step,
        created_at, activated_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL)`,
      [
        id,
        this.tenantId,
        input.user_id,
        input.secret_encrypted,
        input.secret_key_version ?? 1,
        input.label ?? null,
        input.algorithm,
        input.digits,
        input.period,
        input.window,
        status,
        now,
      ]
    );
    return {
      id,
      tenant_id: this.tenantId,
      user_id: input.user_id,
      secret_encrypted: input.secret_encrypted,
      secret_key_version: input.secret_key_version ?? 1,
      label: input.label ?? null,
      algorithm: input.algorithm,
      digits: input.digits,
      period: input.period,
      window: input.window,
      status,
      last_used_time_step: null,
      created_at: now,
      activated_at: null,
      last_used_at: null,
    };
  }

  async findById(id: string): Promise<TotpCredential | null> {
    const row = await this.adapter.queryOne<TotpCredentialRow>(
      'SELECT * FROM totp_credentials WHERE tenant_id = ? AND id = ?',
      [this.tenantId, id]
    );
    return row ? this.rowToCredential(row) : null;
  }

  async findByUserId(userId: string): Promise<TotpCredential[]> {
    const rows = await this.adapter.query<TotpCredentialRow>(
      'SELECT * FROM totp_credentials WHERE tenant_id = ? AND user_id = ? ORDER BY created_at DESC',
      [this.tenantId, userId]
    );
    return rows.map((row) => this.rowToCredential(row));
  }

  async findActiveByUserId(userId: string): Promise<TotpCredential[]> {
    const rows = await this.adapter.query<TotpCredentialRow>(
      `SELECT * FROM totp_credentials
       WHERE tenant_id = ? AND user_id = ? AND status = 'active'
       ORDER BY created_at DESC`,
      [this.tenantId, userId]
    );
    return rows.map((row) => this.rowToCredential(row));
  }

  async activate(id: string, userId: string, timeStep: number): Promise<TotpCredential | null> {
    const now = getCurrentTimestamp();
    await this.adapter.execute(
      `UPDATE totp_credentials
       SET status = 'active', activated_at = ?, last_used_at = ?, last_used_time_step = ?
       WHERE tenant_id = ? AND id = ? AND user_id = ? AND status = 'pending'`,
      [now, now, timeStep, this.tenantId, id, userId]
    );
    return this.findById(id);
  }

  async markUsed(id: string, userId: string, timeStep: number): Promise<boolean> {
    const now = getCurrentTimestamp();
    const result = await this.adapter.execute(
      `UPDATE totp_credentials
       SET last_used_at = ?, last_used_time_step = ?
       WHERE tenant_id = ? AND id = ? AND user_id = ? AND status = 'active'
         AND (last_used_time_step IS NULL OR last_used_time_step < ?)`,
      [now, timeStep, this.tenantId, id, userId, timeStep]
    );
    return result.rowsAffected > 0;
  }

  async rename(id: string, userId: string, label: string | null): Promise<TotpCredential | null> {
    await this.adapter.execute(
      'UPDATE totp_credentials SET label = ? WHERE tenant_id = ? AND id = ? AND user_id = ?',
      [label, this.tenantId, id, userId]
    );
    return this.findById(id);
  }

  async delete(id: string, userId: string): Promise<boolean> {
    await this.adapter.execute(
      'DELETE FROM totp_backup_codes WHERE tenant_id = ? AND credential_id = ? AND user_id = ?',
      [this.tenantId, id, userId]
    );
    const result = await this.adapter.execute(
      'DELETE FROM totp_credentials WHERE tenant_id = ? AND id = ? AND user_id = ?',
      [this.tenantId, id, userId]
    );
    return result.rowsAffected > 0;
  }

  async deleteByUserId(userId: string): Promise<number> {
    await this.adapter.execute('DELETE FROM totp_backup_codes WHERE tenant_id = ? AND user_id = ?', [
      this.tenantId,
      userId,
    ]);
    const result = await this.adapter.execute(
      'DELETE FROM totp_credentials WHERE tenant_id = ? AND user_id = ?',
      [this.tenantId, userId]
    );
    return result.rowsAffected;
  }

  async replaceBackupCodes(
    userId: string,
    credentialId: string | null,
    codes: CreateTotpBackupCodeInput[]
  ): Promise<TotpBackupCode[]> {
    return this.adapter.transaction(async (tx) => {
      await tx.execute('DELETE FROM totp_backup_codes WHERE tenant_id = ? AND user_id = ?', [
        this.tenantId,
        userId,
      ]);
      const created: TotpBackupCode[] = [];
      for (const code of codes) {
        const id = code.id ?? generateId();
        const now = getCurrentTimestamp();
        await tx.execute(
          `INSERT INTO totp_backup_codes (
            id, tenant_id, user_id, credential_id, code_hash, code_prefix, created_at, used_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
          [
            id,
            this.tenantId,
            userId,
            credentialId ?? code.credential_id ?? null,
            code.code_hash,
            code.code_prefix,
            now,
          ]
        );
        created.push({
          id,
          tenant_id: this.tenantId,
          user_id: userId,
          credential_id: credentialId ?? code.credential_id ?? null,
          code_hash: code.code_hash,
          code_prefix: code.code_prefix,
          created_at: now,
          used_at: null,
        });
      }
      return created;
    });
  }

  async listBackupCodes(userId: string): Promise<TotpBackupCode[]> {
    const rows = await this.adapter.query<TotpBackupCodeRow>(
      'SELECT * FROM totp_backup_codes WHERE tenant_id = ? AND user_id = ? ORDER BY created_at ASC',
      [this.tenantId, userId]
    );
    return rows.map((row) => this.rowToBackupCode(row));
  }

  async consumeBackupCode(userId: string, codeHash: string): Promise<TotpBackupCode | null> {
    const existing = await this.adapter.queryOne<TotpBackupCodeRow>(
      `SELECT * FROM totp_backup_codes
       WHERE tenant_id = ? AND user_id = ? AND code_hash = ? AND used_at IS NULL`,
      [this.tenantId, userId, codeHash]
    );
    if (!existing) return null;
    const now = getCurrentTimestamp();
    const result = await this.adapter.execute(
      `UPDATE totp_backup_codes
       SET used_at = ?
       WHERE tenant_id = ? AND id = ? AND used_at IS NULL`,
      [now, this.tenantId, existing.id]
    );
    return result.rowsAffected > 0 ? { ...this.rowToBackupCode(existing), used_at: now } : null;
  }

  private rowToCredential(row: TotpCredentialRow): TotpCredential {
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      user_id: row.user_id,
      secret_encrypted: row.secret_encrypted,
      secret_key_version: Number(row.secret_key_version ?? 1),
      label: row.label ?? null,
      algorithm: normalizeAlgorithm(row.algorithm),
      digits: Number(row.digits),
      period: Number(row.period),
      window: Number(row.window),
      status: normalizeStatus(row.status),
      last_used_time_step:
        row.last_used_time_step === null || row.last_used_time_step === undefined
          ? null
          : Number(row.last_used_time_step),
      created_at: Number(row.created_at),
      activated_at:
        row.activated_at === null || row.activated_at === undefined ? null : Number(row.activated_at),
      last_used_at:
        row.last_used_at === null || row.last_used_at === undefined ? null : Number(row.last_used_at),
    };
  }

  private rowToBackupCode(row: TotpBackupCodeRow): TotpBackupCode {
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      user_id: row.user_id,
      credential_id: row.credential_id ?? null,
      code_hash: row.code_hash,
      code_prefix: row.code_prefix,
      created_at: Number(row.created_at),
      used_at: row.used_at === null || row.used_at === undefined ? null : Number(row.used_at),
    };
  }
}
