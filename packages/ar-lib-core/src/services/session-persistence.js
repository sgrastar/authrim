import { ensureOptionalDatabaseAdapter } from '../db/adapter-source';
class DatabaseSessionPersistenceAdapter {
    db;
    constructor(db) {
        this.db = db;
    }
    async loadSession(sessionId, nowMs) {
        const row = await this.db.queryOne('SELECT id, user_id, expires_at, created_at FROM sessions WHERE id = ? AND expires_at > ?', [sessionId, Math.floor(nowMs / 1000)]);
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
    async saveSession(session) {
        const expiresAt = Math.floor(session.expiresAt / 1000);
        const createdAt = Math.floor(session.createdAt / 1000);
        const updated = await this.db.execute('UPDATE sessions SET user_id = ?, expires_at = ?, created_at = ? WHERE id = ?', [session.userId, expiresAt, createdAt, session.id]);
        if (updated.rowsAffected > 0) {
            return;
        }
        await this.db.execute('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', [session.id, session.userId, expiresAt, createdAt]);
    }
    async deleteSession(sessionId) {
        await this.db.execute('DELETE FROM sessions WHERE id = ?', [sessionId]);
    }
    async batchDeleteSessions(sessionIds) {
        if (sessionIds.length === 0) {
            return;
        }
        const placeholders = sessionIds.map(() => '?').join(',');
        await this.db.execute(`DELETE FROM sessions WHERE id IN (${placeholders})`, sessionIds);
    }
    async listUserSessions(userId, nowMs) {
        const rows = await this.db.query('SELECT id, user_id, expires_at, created_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC', [userId, Math.floor(nowMs / 1000)]);
        return rows.map((row) => ({
            id: row.id,
            userId: row.user_id,
            expiresAt: row.expires_at * 1000,
            createdAt: row.created_at * 1000,
        }));
    }
    async updateSessionUserId(sessionId, newUserId) {
        await this.db.execute('UPDATE sessions SET user_id = ? WHERE id = ?', [newUserId, sessionId]);
    }
    getType() {
        return this.db.getType();
    }
}
export function createSessionPersistenceAdapter(source, partition = 'session-store') {
    const adapter = ensureOptionalDatabaseAdapter(source, partition);
    if (!adapter) {
        return null;
    }
    return new DatabaseSessionPersistenceAdapter(adapter);
}
