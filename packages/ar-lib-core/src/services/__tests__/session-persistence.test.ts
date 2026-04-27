import { describe, it, expect } from 'vitest';
import type { DatabaseAdapter, ExecuteResult, HealthStatus, TransactionContext } from '../../db/adapter';
import {
  createSessionPersistenceAdapter,
  type SessionPersistenceRecord,
} from '../session-persistence';

function createRecord(overrides: Partial<SessionPersistenceRecord> = {}): SessionPersistenceRecord {
  return {
    id: 'sess_123',
    userId: 'user_123',
    expiresAt: 1_800_000_000_000,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

class InMemorySessionAdapter implements DatabaseAdapter {
  private rows = new Map<
    string,
    { id: string; user_id: string; expires_at: number; created_at: number }
  >();

  seed(rows: Array<{ id: string; user_id: string; expires_at: number; created_at: number }>): void {
    for (const row of rows) {
      this.rows.set(row.id, { ...row });
    }
  }

  getAll(): Array<{ id: string; user_id: string; expires_at: number; created_at: number }> {
    return Array.from(this.rows.values());
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    if (sql.includes('FROM sessions WHERE user_id = ?')) {
      const userId = params?.[0] as string;
      const expiresAt = params?.[1] as number;
      return this.getAll()
        .filter((row) => row.user_id === userId && row.expires_at > expiresAt)
        .sort((a, b) => b.created_at - a.created_at) as T[];
    }

    return [];
  }

  async queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
    if (sql.includes('FROM sessions WHERE id = ?')) {
      const id = params?.[0] as string;
      const expiresAt = params?.[1] as number;
      const row = this.rows.get(id);
      if (!row || row.expires_at <= expiresAt) {
        return null;
      }
      return row as T;
    }

    return null;
  }

  async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    if (sql.startsWith('UPDATE sessions SET user_id = ?, expires_at = ?, created_at = ?')) {
      const [userId, expiresAt, createdAt, id] = params as [string, number, number, string];
      const existing = this.rows.get(id);
      if (!existing) {
        return { success: true, rowsAffected: 0 };
      }
      this.rows.set(id, { id, user_id: userId, expires_at: expiresAt, created_at: createdAt });
      return { success: true, rowsAffected: 1 };
    }

    if (sql.startsWith('INSERT INTO sessions')) {
      const [id, userId, expiresAt, createdAt] = params as [string, string, number, number];
      this.rows.set(id, { id, user_id: userId, expires_at: expiresAt, created_at: createdAt });
      return { success: true, rowsAffected: 1 };
    }

    if (sql.startsWith('DELETE FROM sessions WHERE id IN')) {
      let deleted = 0;
      for (const id of params as string[]) {
        if (this.rows.delete(id)) {
          deleted++;
        }
      }
      return { success: true, rowsAffected: deleted };
    }

    if (sql.startsWith('DELETE FROM sessions WHERE id = ?')) {
      const id = params?.[0] as string;
      const deleted = this.rows.delete(id);
      return { success: true, rowsAffected: deleted ? 1 : 0 };
    }

    if (sql.startsWith('UPDATE sessions SET user_id = ? WHERE id = ?')) {
      const [userId, id] = params as [string, string];
      const existing = this.rows.get(id);
      if (!existing) {
        return { success: true, rowsAffected: 0 };
      }
      this.rows.set(id, { ...existing, user_id: userId });
      return { success: true, rowsAffected: 1 };
    }

    return { success: true, rowsAffected: 0 };
  }

  async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const tx: TransactionContext = {
      query: this.query.bind(this),
      queryOne: this.queryOne.bind(this),
      execute: this.execute.bind(this),
    };
    return fn(tx);
  }

  async batch(): Promise<ExecuteResult[]> {
    return [];
  }

  async isHealthy(): Promise<HealthStatus> {
    return { healthy: true, latencyMs: 0, type: 'memory' };
  }

  getType(): string {
    return 'memory';
  }

  async close(): Promise<void> {}
}

describe('session-persistence', () => {
  it('loads a session record from the database adapter', async () => {
    const adapter = new InMemorySessionAdapter();
    adapter.seed([
      {
        id: 'sess_123',
        user_id: 'user_123',
        expires_at: 1_800_000_000,
        created_at: 1_700_000_000,
      },
    ]);

    const persistence = createSessionPersistenceAdapter(adapter);
    const session = await persistence!.loadSession('sess_123', 1_750_000_000_000);

    expect(session).toEqual({
      id: 'sess_123',
      userId: 'user_123',
      expiresAt: 1_800_000_000_000,
      createdAt: 1_700_000_000_000,
    });
  });

  it('saves a new session when one does not already exist', async () => {
    const adapter = new InMemorySessionAdapter();
    const persistence = createSessionPersistenceAdapter(adapter);

    await persistence!.saveSession(createRecord());

    expect(adapter.getAll()).toEqual([
      {
        id: 'sess_123',
        user_id: 'user_123',
        expires_at: 1_800_000_000,
        created_at: 1_700_000_000,
      },
    ]);
  });

  it('updates an existing session instead of inserting a duplicate', async () => {
    const adapter = new InMemorySessionAdapter();
    adapter.seed([
      {
        id: 'sess_123',
        user_id: 'old_user',
        expires_at: 1_700_000_000,
        created_at: 1_600_000_000,
      },
    ]);
    const persistence = createSessionPersistenceAdapter(adapter);

    await persistence!.saveSession(createRecord({ userId: 'new_user' }));

    expect(adapter.getAll()).toEqual([
      {
        id: 'sess_123',
        user_id: 'new_user',
        expires_at: 1_800_000_000,
        created_at: 1_700_000_000,
      },
    ]);
  });

  it('batch deletes sessions', async () => {
    const adapter = new InMemorySessionAdapter();
    adapter.seed([
      { id: 'sess_1', user_id: 'user', expires_at: 1_800_000_000, created_at: 1_700_000_000 },
      { id: 'sess_2', user_id: 'user', expires_at: 1_800_000_000, created_at: 1_700_000_000 },
    ]);
    const persistence = createSessionPersistenceAdapter(adapter);

    await persistence!.batchDeleteSessions(['sess_1', 'sess_2']);

    expect(adapter.getAll()).toEqual([]);
  });
});
