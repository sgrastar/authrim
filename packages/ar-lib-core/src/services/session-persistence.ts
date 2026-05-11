import type { DatabaseAdapter } from '../db/adapter';
import type { DatabaseSource } from '../db/adapter-source';
import { ensureOptionalDatabaseAdapter } from '../db/adapter-source';

export interface SessionPersistenceRecord {
  id: string;
  tenantId?: string;
  userId: string;
  expiresAt: number;
  createdAt: number;
}

export interface SessionPersistenceAdapter {
  loadSession(sessionId: string, nowMs: number): Promise<SessionPersistenceRecord | null>;
  saveSession(session: SessionPersistenceRecord): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  batchDeleteSessions(sessionIds: string[]): Promise<void>;
  listUserSessions(userId: string, nowMs: number): Promise<SessionPersistenceRecord[]>;
  updateSessionUserId(sessionId: string, newUserId: string): Promise<void>;
  getType(): string;
}

class DatabaseSessionPersistenceAdapter implements SessionPersistenceAdapter {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly tenantId?: string
  ) {}

  async loadSession(sessionId: string, nowMs: number): Promise<SessionPersistenceRecord | null> {
    const params: unknown[] = [sessionId];
    const tenantClause = this.tenantId ? ' AND tenant_id = ?' : '';
    if (this.tenantId) {
      params.push(this.tenantId);
    }
    params.push(Math.floor(nowMs / 1000));

    const row = await this.db.queryOne<{
      id: string;
      tenant_id?: string;
      user_id: string;
      expires_at: number;
      created_at: number;
    }>(
      `SELECT id, tenant_id, user_id, expires_at, created_at
       FROM sessions
       WHERE id = ?${tenantClause} AND expires_at > ?`,
      params
    );

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      expiresAt: row.expires_at * 1000,
      createdAt: row.created_at * 1000,
    };
  }

  async saveSession(session: SessionPersistenceRecord): Promise<void> {
    const tenantId = session.tenantId ?? this.tenantId;
    const expiresAt = Math.floor(session.expiresAt / 1000);
    const createdAt = Math.floor(session.createdAt / 1000);
    const updated = tenantId
      ? await this.db.execute(
          `UPDATE sessions
           SET tenant_id = ?, user_id = ?, expires_at = ?, created_at = ?
           WHERE id = ? AND tenant_id = ?`,
          [tenantId, session.userId, expiresAt, createdAt, session.id, tenantId]
        )
      : await this.db.execute(
          'UPDATE sessions SET user_id = ?, expires_at = ?, created_at = ? WHERE id = ?',
          [session.userId, expiresAt, createdAt, session.id]
        );

    if (updated.rowsAffected > 0) {
      return;
    }

    if (tenantId) {
      await this.db.execute(
        `INSERT INTO sessions (id, tenant_id, user_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [session.id, tenantId, session.userId, expiresAt, createdAt]
      );
    } else {
      await this.db.execute(
        'INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
        [session.id, session.userId, expiresAt, createdAt]
      );
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (this.tenantId) {
      await this.db.execute('DELETE FROM sessions WHERE id = ? AND tenant_id = ?', [
        sessionId,
        this.tenantId,
      ]);
      return;
    }
    await this.db.execute('DELETE FROM sessions WHERE id = ?', [sessionId]);
  }

  async batchDeleteSessions(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) {
      return;
    }

    const placeholders = sessionIds.map(() => '?').join(',');
    if (this.tenantId) {
      await this.db.execute(
        `DELETE FROM sessions WHERE tenant_id = ? AND id IN (${placeholders})`,
        [this.tenantId, ...sessionIds]
      );
      return;
    }
    await this.db.execute(`DELETE FROM sessions WHERE id IN (${placeholders})`, sessionIds);
  }

  async listUserSessions(userId: string, nowMs: number): Promise<SessionPersistenceRecord[]> {
    const params: unknown[] = [userId];
    const tenantClause = this.tenantId ? ' AND tenant_id = ?' : '';
    if (this.tenantId) {
      params.push(this.tenantId);
    }
    params.push(Math.floor(nowMs / 1000));

    const rows = await this.db.query<{
      id: string;
      tenant_id?: string;
      user_id: string;
      expires_at: number;
      created_at: number;
    }>(
      `SELECT id, tenant_id, user_id, expires_at, created_at
       FROM sessions
       WHERE user_id = ?${tenantClause} AND expires_at > ?
       ORDER BY created_at DESC`,
      params
    );

    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      expiresAt: row.expires_at * 1000,
      createdAt: row.created_at * 1000,
    }));
  }

  async updateSessionUserId(sessionId: string, newUserId: string): Promise<void> {
    if (this.tenantId) {
      await this.db.execute('UPDATE sessions SET user_id = ? WHERE id = ? AND tenant_id = ?', [
        newUserId,
        sessionId,
        this.tenantId,
      ]);
      return;
    }
    await this.db.execute('UPDATE sessions SET user_id = ? WHERE id = ?', [newUserId, sessionId]);
  }

  getType(): string {
    return this.db.getType();
  }
}

export function createSessionPersistenceAdapter(
  source: DatabaseSource | null | undefined,
  partition: string = 'session-store',
  tenantId?: string
): SessionPersistenceAdapter | null {
  const adapter = ensureOptionalDatabaseAdapter(source, partition);
  if (!adapter) {
    return null;
  }
  return new DatabaseSessionPersistenceAdapter(adapter, tenantId);
}
