import { describe, it, expect } from 'vitest';
import type {
  DatabaseAdapter,
  ExecuteResult,
  HealthStatus,
  TransactionContext,
} from '../../db/adapter';
import {
  createSessionPersistenceAdapter,
  recordUserSessionRevocationEpoch,
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
    { id: string; tenant_id?: string; user_id: string; expires_at: number; created_at: number }
  >();
  private revocationEpochs = new Map<
    string,
    { tenant_id: string; user_id: string; revoked_after_ms: number; updated_at: number }
  >();

  seed(
    rows: Array<{
      id: string;
      tenant_id?: string;
      user_id: string;
      expires_at: number;
      created_at: number;
    }>
  ): void {
    for (const row of rows) {
      this.rows.set(row.id, { ...row });
    }
  }

  getAll(): Array<{
    id: string;
    tenant_id?: string;
    user_id: string;
    expires_at: number;
    created_at: number;
  }> {
    return Array.from(this.rows.values());
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    if (sql.includes('FROM sessions') && sql.includes('user_id = ?')) {
      const tenantScoped = sql.includes('tenant_id = ?');
      const tenantId = tenantScoped ? (params?.[0] as string) : undefined;
      const userId = params?.[tenantScoped ? 1 : 0] as string;
      const expiresAt = params?.[params.length - 1] as number;
      return this.getAll()
        .filter(
          (row) =>
            row.user_id === userId &&
            (!tenantId || row.tenant_id === tenantId) &&
            row.expires_at > expiresAt
        )
        .sort((a, b) => b.created_at - a.created_at) as T[];
    }

    return [];
  }

  async queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
    if (sql.includes('FROM session_revocation_epochs')) {
      const [tenantId, userId] = params as [string, string];
      return (this.revocationEpochs.get(`${tenantId}:${userId}`) as T | undefined) ?? null;
    }

    if (sql.includes('FROM sessions') && sql.includes('WHERE id = ?')) {
      const id = params?.[0] as string;
      const tenantId = sql.includes('tenant_id = ?') ? (params?.[1] as string) : undefined;
      const expiresAt = params?.[params.length - 1] as number;
      const row = this.rows.get(id);
      if (!row || (tenantId && row.tenant_id !== tenantId) || row.expires_at <= expiresAt) {
        return null;
      }
      return row as T;
    }

    return null;
  }

  async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    if (sql.startsWith('UPDATE sessions\n           SET tenant_id = ?')) {
      const [tenantId, userId, expiresAt, createdAt, id, whereTenantId] = params as [
        string,
        string,
        number,
        number,
        string,
        string,
      ];
      const existing = this.rows.get(id);
      if (!existing || existing.tenant_id !== whereTenantId) {
        return { success: true, rowsAffected: 0 };
      }
      this.rows.set(id, {
        id,
        tenant_id: tenantId,
        user_id: userId,
        expires_at: expiresAt,
        created_at: createdAt,
      });
      return { success: true, rowsAffected: 1 };
    }

    if (sql.startsWith('UPDATE sessions SET user_id = ?, expires_at = ?, created_at = ?')) {
      const [userId, expiresAt, createdAt, id] = params as [string, number, number, string];
      const existing = this.rows.get(id);
      if (!existing) {
        return { success: true, rowsAffected: 0 };
      }
      this.rows.set(id, { id, user_id: userId, expires_at: expiresAt, created_at: createdAt });
      return { success: true, rowsAffected: 1 };
    }

    if (sql.startsWith('INSERT INTO sessions (id, tenant_id')) {
      const [id, tenantId, userId, expiresAt, createdAt] = params as [
        string,
        string,
        string,
        number,
        number,
      ];
      this.rows.set(id, {
        id,
        tenant_id: tenantId,
        user_id: userId,
        expires_at: expiresAt,
        created_at: createdAt,
      });
      return { success: true, rowsAffected: 1 };
    }

    if (sql.startsWith('INSERT INTO sessions')) {
      const [id, userId, expiresAt, createdAt] = params as [string, string, number, number];
      this.rows.set(id, { id, user_id: userId, expires_at: expiresAt, created_at: createdAt });
      return { success: true, rowsAffected: 1 };
    }

    if (sql.startsWith('DELETE FROM sessions WHERE tenant_id = ? AND id IN')) {
      const [tenantId, ...ids] = params as string[];
      let deleted = 0;
      for (const id of ids) {
        const existing = this.rows.get(id);
        if (existing?.tenant_id === tenantId && this.rows.delete(id)) {
          deleted++;
        }
      }
      return { success: true, rowsAffected: deleted };
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

    if (sql.startsWith('DELETE FROM sessions WHERE id = ? AND tenant_id = ?')) {
      const [id, tenantId] = params as [string, string];
      const existing = this.rows.get(id);
      const deleted = existing?.tenant_id === tenantId && this.rows.delete(id);
      return { success: true, rowsAffected: deleted ? 1 : 0 };
    }

    if (sql.startsWith('DELETE FROM sessions WHERE id = ?')) {
      const id = params?.[0] as string;
      const deleted = this.rows.delete(id);
      return { success: true, rowsAffected: deleted ? 1 : 0 };
    }

    if (sql.startsWith('UPDATE sessions SET user_id = ? WHERE id = ? AND tenant_id = ?')) {
      const [userId, id, tenantId] = params as [string, string, string];
      const existing = this.rows.get(id);
      if (!existing || existing.tenant_id !== tenantId) {
        return { success: true, rowsAffected: 0 };
      }
      this.rows.set(id, { ...existing, user_id: userId });
      return { success: true, rowsAffected: 1 };
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

    if (sql.startsWith('UPDATE session_revocation_epochs')) {
      const [revokedAfterMs, updatedAt, tenantId, userId] = params as [
        number,
        number,
        string,
        string,
      ];
      const key = `${tenantId}:${userId}`;
      if (!this.revocationEpochs.has(key)) {
        return { success: true, rowsAffected: 0 };
      }
      this.revocationEpochs.set(key, {
        tenant_id: tenantId,
        user_id: userId,
        revoked_after_ms: revokedAfterMs,
        updated_at: updatedAt,
      });
      return { success: true, rowsAffected: 1 };
    }

    if (sql.startsWith('INSERT INTO session_revocation_epochs')) {
      const [tenantId, userId, revokedAfterMs, updatedAt] = params as [
        string,
        string,
        number,
        number,
      ];
      this.revocationEpochs.set(`${tenantId}:${userId}`, {
        tenant_id: tenantId,
        user_id: userId,
        revoked_after_ms: revokedAfterMs,
        updated_at: updatedAt,
      });
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
        tenant_id: 'tenant-a',
        user_id: 'user_123',
        expires_at: 1_800_000_000,
        created_at: 1_700_000_000,
      },
    ]);

    const persistence = createSessionPersistenceAdapter(adapter, 'session-store', 'tenant-a');
    const session = await persistence!.loadSession('sess_123', 1_750_000_000_000);

    expect(session).toEqual({
      id: 'sess_123',
      tenantId: 'tenant-a',
      userId: 'user_123',
      expiresAt: 1_800_000_000_000,
      createdAt: 1_700_000_000_000,
    });
  });

  it('saves a new session when one does not already exist', async () => {
    const adapter = new InMemorySessionAdapter();
    const persistence = createSessionPersistenceAdapter(adapter, 'session-store', 'tenant-a');

    await persistence!.saveSession(createRecord());

    expect(adapter.getAll()).toEqual([
      {
        id: 'sess_123',
        tenant_id: 'tenant-a',
        user_id: 'user_123',
        expires_at: 1_800_000_000,
        created_at: 1_700_000_000,
      },
    ]);
  });

  it('rejects a mismatched record tenant on tenant-bound saves', async () => {
    const adapter = new InMemorySessionAdapter();
    const persistence = createSessionPersistenceAdapter(adapter, 'session-store', 'tenant-a');

    await expect(persistence!.saveSession(createRecord({ tenantId: 'tenant-b' }))).rejects.toThrow(
      'Session persistence tenant mismatch'
    );
    expect(adapter.getAll()).toEqual([]);
  });

  it('lists duplicated user IDs only inside the tenant-bound adapter tenant', async () => {
    const adapter = new InMemorySessionAdapter();
    adapter.seed([
      {
        id: 'sess_a',
        tenant_id: 'tenant-a',
        user_id: 'shared-user',
        expires_at: 1_800_000_000,
        created_at: 1_700_000_000,
      },
      {
        id: 'sess_b',
        tenant_id: 'tenant-b',
        user_id: 'shared-user',
        expires_at: 1_800_000_000,
        created_at: 1_700_000_100,
      },
    ]);
    const persistence = createSessionPersistenceAdapter(adapter, 'session-store', 'tenant-a');

    await expect(persistence!.listUserSessions('shared-user', 1_750_000_000_000)).resolves.toEqual([
      {
        id: 'sess_a',
        tenantId: 'tenant-a',
        userId: 'shared-user',
        expiresAt: 1_800_000_000_000,
        createdAt: 1_700_000_000_000,
      },
    ]);
  });

  it('deletes sessions only inside the tenant-bound adapter tenant', async () => {
    const adapter = new InMemorySessionAdapter();
    adapter.seed([
      {
        id: 'sess_a',
        tenant_id: 'tenant-a',
        user_id: 'shared-user',
        expires_at: 1_800_000_000,
        created_at: 1_700_000_000,
      },
      {
        id: 'sess_b',
        tenant_id: 'tenant-b',
        user_id: 'shared-user',
        expires_at: 1_800_000_000,
        created_at: 1_700_000_100,
      },
    ]);
    const persistence = createSessionPersistenceAdapter(adapter, 'session-store', 'tenant-a');

    await persistence!.batchDeleteSessions(['sess_a', 'sess_b']);

    expect(adapter.getAll()).toEqual([
      {
        id: 'sess_b',
        tenant_id: 'tenant-b',
        user_id: 'shared-user',
        expires_at: 1_800_000_000,
        created_at: 1_700_000_100,
      },
    ]);
  });

  it('updates an existing session instead of inserting a duplicate', async () => {
    const adapter = new InMemorySessionAdapter();
    adapter.seed([
      {
        id: 'sess_123',
        tenant_id: 'tenant-a',
        user_id: 'old_user',
        expires_at: 1_700_000_000,
        created_at: 1_600_000_000,
      },
    ]);
    const persistence = createSessionPersistenceAdapter(adapter, 'session-store', 'tenant-a');

    await persistence!.saveSession(createRecord({ userId: 'new_user' }));

    expect(adapter.getAll()).toEqual([
      {
        id: 'sess_123',
        tenant_id: 'tenant-a',
        user_id: 'new_user',
        expires_at: 1_800_000_000,
        created_at: 1_700_000_000,
      },
    ]);
  });

  it('batch deletes sessions', async () => {
    const adapter = new InMemorySessionAdapter();
    adapter.seed([
      {
        id: 'sess_1',
        tenant_id: 'tenant-a',
        user_id: 'user',
        expires_at: 1_800_000_000,
        created_at: 1_700_000_000,
      },
      {
        id: 'sess_2',
        tenant_id: 'tenant-a',
        user_id: 'user',
        expires_at: 1_800_000_000,
        created_at: 1_700_000_000,
      },
    ]);
    const persistence = createSessionPersistenceAdapter(adapter, 'session-store', 'tenant-a');

    await persistence!.batchDeleteSessions(['sess_1', 'sess_2']);

    expect(adapter.getAll()).toEqual([]);
  });

  it('stores and updates a tenant-bound user session revocation epoch', async () => {
    const adapter = new InMemorySessionAdapter();
    const persistence = createSessionPersistenceAdapter(adapter, 'session-store', 'tenant-a');

    await persistence!.setUserSessionsRevokedAfter('shared-user', 1_750_000_000_123);
    await expect(persistence!.getUserSessionsRevokedAfter('shared-user')).resolves.toBe(
      1_750_000_000_123
    );

    await persistence!.setUserSessionsRevokedAfter('shared-user', 1_750_000_000_456);
    await expect(persistence!.getUserSessionsRevokedAfter('shared-user')).resolves.toBe(
      1_750_000_000_456
    );
  });

  it('records a shared revocation epoch for user-wide logout paths', async () => {
    const adapter = new InMemorySessionAdapter();

    await expect(
      recordUserSessionRevocationEpoch(adapter, 'tenant-a', 'shared-user', 1_750_000_000_123)
    ).resolves.toBe(1_750_000_000_123);

    const persistence = createSessionPersistenceAdapter(adapter, 'session-store', 'tenant-a');
    await expect(persistence!.getUserSessionsRevokedAfter('shared-user')).resolves.toBe(
      1_750_000_000_123
    );
  });

  it('does not share user session revocation epochs across tenants', async () => {
    const adapter = new InMemorySessionAdapter();
    const tenantA = createSessionPersistenceAdapter(adapter, 'session-store', 'tenant-a');
    const tenantB = createSessionPersistenceAdapter(adapter, 'session-store', 'tenant-b');

    await tenantA!.setUserSessionsRevokedAfter('shared-user', 1_750_000_000_123);

    await expect(tenantB!.getUserSessionsRevokedAfter('shared-user')).resolves.toBeNull();
  });
});
