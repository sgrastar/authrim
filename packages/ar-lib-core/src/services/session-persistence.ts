import type { DatabaseAdapter } from '../db/adapter';
import type { DatabaseSource } from '../db/adapter-source';
import { ensureOptionalDatabaseAdapter } from '../db/adapter-source';

export interface SessionPersistenceRecord {
  id: string;
  tenantId?: string;
  userId: string;
  accountId: string;
  expiresAt: number;
  createdAt: number;
}

export interface SessionPersistenceAdapter {
  loadSession(sessionId: string, nowMs: number): Promise<SessionPersistenceRecord | null>;
  saveSession(session: SessionPersistenceRecord): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  batchDeleteSessions(sessionIds: string[]): Promise<void>;
  listUserSessions(userId: string, nowMs: number): Promise<SessionPersistenceRecord[]>;
  getUserSessionsRevokedAfter(userId: string): Promise<number | null>;
  setUserSessionsRevokedAfter(userId: string, revokedAfterMs: number): Promise<void>;
  updateSessionUserId(sessionId: string, newUserId: string): Promise<void>;
  getType(): string;
}

/**
 * Record a tenant-scoped user revocation epoch used by every SessionStore shard.
 * Sessions created at or before this instant are rejected even when their shard
 * cannot be located by a user-to-session index.
 */
export async function recordUserSessionRevocationEpoch(
  db: Pick<DatabaseAdapter, 'queryOne' | 'execute'>,
  tenantId: string,
  userId: string,
  revokedAfterMs = Date.now()
): Promise<number> {
  const normalizedEpoch = Math.floor(revokedAfterMs);
  const updatedAt = Math.floor(normalizedEpoch / 1000);
  const existing = await db.queryOne<{ tenant_id: string }>(
    'SELECT tenant_id FROM session_revocation_epochs WHERE tenant_id = ? AND user_id = ?',
    [tenantId, userId]
  );

  if (existing) {
    await db.execute(
      'UPDATE session_revocation_epochs SET revoked_after_ms = ?, updated_at = ? WHERE tenant_id = ? AND user_id = ?',
      [normalizedEpoch, updatedAt, tenantId, userId]
    );
  } else {
    await db.execute(
      'INSERT INTO session_revocation_epochs (tenant_id, user_id, revoked_after_ms, updated_at) VALUES (?, ?, ?, ?)',
      [tenantId, userId, normalizedEpoch, updatedAt]
    );
  }

  return normalizedEpoch;
}

class DatabaseSessionPersistenceAdapter implements SessionPersistenceAdapter {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly tenantId: string
  ) {}

  private resolveWriteTenantId(recordTenantId: string | undefined): string {
    const normalizedRecordTenantId = recordTenantId?.trim() || undefined;
    if (normalizedRecordTenantId && normalizedRecordTenantId !== this.tenantId) {
      throw new Error('Session persistence tenant mismatch');
    }
    return this.tenantId;
  }

  async loadSession(sessionId: string, nowMs: number): Promise<SessionPersistenceRecord | null> {
    const row = await this.db.queryOne<{
      id: string;
      tenant_id: string;
      user_id: string;
      expires_at: number;
      created_at: number;
    }>(
      `SELECT id, tenant_id, user_id, expires_at, created_at
       FROM sessions
       WHERE id = ? AND tenant_id = ? AND expires_at > ?`,
      [sessionId, this.tenantId, Math.floor(nowMs / 1000)]
    );

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      accountId: `account:${row.user_id}`,
      expiresAt: row.expires_at * 1000,
      createdAt: row.created_at * 1000,
    };
  }

  async saveSession(session: SessionPersistenceRecord): Promise<void> {
    const tenantId = this.resolveWriteTenantId(session.tenantId);
    const expiresAt = Math.floor(session.expiresAt / 1000);
    const createdAt = Math.floor(session.createdAt / 1000);
    const updated = await this.db.execute(
      `UPDATE sessions
       SET tenant_id = ?, user_id = ?, expires_at = ?, created_at = ?
       WHERE id = ? AND tenant_id = ?`,
      [tenantId, session.userId, expiresAt, createdAt, session.id, tenantId]
    );

    if (updated.rowsAffected > 0) {
      return;
    }

    await this.db.execute(
      `INSERT INTO sessions (id, tenant_id, user_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [session.id, tenantId, session.userId, expiresAt, createdAt]
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.db.execute('DELETE FROM sessions WHERE id = ? AND tenant_id = ?', [
      sessionId,
      this.tenantId,
    ]);
  }

  async batchDeleteSessions(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) {
      return;
    }

    const placeholders = sessionIds.map(() => '?').join(',');
    await this.db.execute(`DELETE FROM sessions WHERE tenant_id = ? AND id IN (${placeholders})`, [
      this.tenantId,
      ...sessionIds,
    ]);
  }

  async listUserSessions(userId: string, nowMs: number): Promise<SessionPersistenceRecord[]> {
    const rows = await this.db.query<{
      id: string;
      tenant_id: string;
      user_id: string;
      expires_at: number;
      created_at: number;
    }>(
      `SELECT id, tenant_id, user_id, expires_at, created_at
       FROM sessions
       WHERE tenant_id = ? AND user_id = ? AND expires_at > ?
       ORDER BY created_at DESC`,
      [this.tenantId, userId, Math.floor(nowMs / 1000)]
    );

    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      accountId: `account:${row.user_id}`,
      expiresAt: row.expires_at * 1000,
      createdAt: row.created_at * 1000,
    }));
  }

  async getUserSessionsRevokedAfter(userId: string): Promise<number | null> {
    const row = await this.db.queryOne<{ revoked_after_ms: number }>(
      `SELECT revoked_after_ms
       FROM session_revocation_epochs
       WHERE tenant_id = ? AND user_id = ?`,
      [this.tenantId, userId]
    );

    return row ? row.revoked_after_ms : null;
  }

  async setUserSessionsRevokedAfter(userId: string, revokedAfterMs: number): Promise<void> {
    const updatedAt = Math.floor(Date.now() / 1000);
    const updated = await this.db.execute(
      `UPDATE session_revocation_epochs
       SET revoked_after_ms = ?, updated_at = ?
       WHERE tenant_id = ? AND user_id = ?`,
      [Math.floor(revokedAfterMs), updatedAt, this.tenantId, userId]
    );

    if (updated.rowsAffected > 0) {
      return;
    }

    await this.db.execute(
      `INSERT INTO session_revocation_epochs (tenant_id, user_id, revoked_after_ms, updated_at)
       VALUES (?, ?, ?, ?)`,
      [this.tenantId, userId, Math.floor(revokedAfterMs), updatedAt]
    );
  }

  async updateSessionUserId(sessionId: string, newUserId: string): Promise<void> {
    await this.db.execute('UPDATE sessions SET user_id = ? WHERE id = ? AND tenant_id = ?', [
      newUserId,
      sessionId,
      this.tenantId,
    ]);
  }

  getType(): string {
    return this.db.getType();
  }
}

export function createSessionPersistenceAdapter(
  source: DatabaseSource | null | undefined,
  partition: string,
  tenantId: string
): SessionPersistenceAdapter | null {
  const normalizedTenantId = tenantId.trim();
  if (!normalizedTenantId) {
    throw new Error('Session persistence requires a tenantId');
  }

  const adapter = ensureOptionalDatabaseAdapter(source, partition);
  if (!adapter) {
    return null;
  }
  return new DatabaseSessionPersistenceAdapter(adapter, normalizedTenantId);
}
