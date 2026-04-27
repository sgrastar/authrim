import type { DatabaseAdapter } from '../db/adapter';
import type { DatabaseSource } from '../db/adapter-source';
import { ensureOptionalDatabaseAdapter } from '../db/adapter-source';

export interface SessionPersistenceRecord {
  id: string;
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
  constructor(private readonly db: DatabaseAdapter) {}

  async loadSession(sessionId: string, nowMs: number): Promise<SessionPersistenceRecord | null> {
    const row = await this.db.queryOne<{
      id: string;
      user_id: string;
      expires_at: number;
      created_at: number;
    }>(
      'SELECT id, user_id, expires_at, created_at FROM sessions WHERE id = ? AND expires_at > ?',
      [sessionId, Math.floor(nowMs / 1000)]
    );

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      userId: row.user_id,
      expiresAt: row.expires_at * 1000,
      createdAt: row.created_at * 1000,
    };
  }

  async saveSession(session: SessionPersistenceRecord): Promise<void> {
    const expiresAt = Math.floor(session.expiresAt / 1000);
    const createdAt = Math.floor(session.createdAt / 1000);
    const updated = await this.db.execute(
      'UPDATE sessions SET user_id = ?, expires_at = ?, created_at = ? WHERE id = ?',
      [session.userId, expiresAt, createdAt, session.id]
    );

    if (updated.rowsAffected > 0) {
      return;
    }

    await this.db.execute(
      'INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
      [session.id, session.userId, expiresAt, createdAt]
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.db.execute('DELETE FROM sessions WHERE id = ?', [sessionId]);
  }

  async batchDeleteSessions(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) {
      return;
    }

    const placeholders = sessionIds.map(() => '?').join(',');
    await this.db.execute(`DELETE FROM sessions WHERE id IN (${placeholders})`, sessionIds);
  }

  async listUserSessions(userId: string, nowMs: number): Promise<SessionPersistenceRecord[]> {
    const rows = await this.db.query<{
      id: string;
      user_id: string;
      expires_at: number;
      created_at: number;
    }>(
      'SELECT id, user_id, expires_at, created_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC',
      [userId, Math.floor(nowMs / 1000)]
    );

    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      expiresAt: row.expires_at * 1000,
      createdAt: row.created_at * 1000,
    }));
  }

  async updateSessionUserId(sessionId: string, newUserId: string): Promise<void> {
    await this.db.execute('UPDATE sessions SET user_id = ? WHERE id = ?', [newUserId, sessionId]);
  }

  getType(): string {
    return this.db.getType();
  }
}

export function createSessionPersistenceAdapter(
  source: DatabaseSource | null | undefined,
  partition: string = 'session-store'
): SessionPersistenceAdapter | null {
  const adapter = ensureOptionalDatabaseAdapter(source, partition);
  if (!adapter) {
    return null;
  }
  return new DatabaseSessionPersistenceAdapter(adapter);
}
