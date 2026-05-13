import { describe, expect, it } from 'vitest';
import type { DatabaseAdapter, ExecuteResult, HealthStatus, TransactionContext } from '../../db';
import {
  countActiveRefreshTokenFamiliesByGeneration,
  deleteRefreshTokenFamiliesByGeneration,
  expireRefreshTokenFamiliesByUser,
  getRefreshTokenFamilyGenerationStats,
  listRefreshTokenFamiliesByUser,
  recordRefreshTokenFamilyIndex,
  revokeRefreshTokenFamiliesByUser,
} from '../refresh-token-family-index';

type FamilyRow = {
  jti: string;
  tenant_id: string;
  user_id: string;
  client_id: string;
  generation: number;
  expires_at: number;
  is_revoked: number;
};

class InMemoryRefreshTokenFamilyIndexAdapter implements DatabaseAdapter {
  private rows = new Map<string, FamilyRow>();

  seed(rows: FamilyRow[]): void {
    for (const row of rows) {
      this.rows.set(row.jti, { ...row });
    }
  }

  all(): FamilyRow[] {
    return Array.from(this.rows.values());
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    if (sql.includes('SELECT jti, client_id, generation FROM user_token_families')) {
      const tenantId = params?.[0] as string;
      const userId = params?.[1] as string;
      const maybeClientId = typeof params?.[2] === 'string' ? (params?.[2] as string) : undefined;
      const maybeNow =
        typeof params?.[2] === 'number'
          ? (params?.[2] as number)
          : (params?.[3] as number | undefined);
      return this.all()
        .filter((row) => row.user_id === userId && row.tenant_id === tenantId)
        .filter((row) =>
          typeof maybeClientId === 'string' ? row.client_id === maybeClientId : true
        )
        .filter((row) =>
          typeof maybeNow === 'number' ? row.is_revoked === 0 && row.expires_at > maybeNow : true
        )
        .map((row) => ({
          jti: row.jti,
          client_id: row.client_id,
          generation: row.generation,
        })) as T[];
    }

    if (sql.includes('GROUP BY generation')) {
      const [nowMs, _nowMs2, tenantId, clientId] = params as [
        number,
        number,
        string,
        string | null,
      ];
      const groups = new Map<number, FamilyRow[]>();

      for (const row of this.all()) {
        if (row.tenant_id !== tenantId) continue;
        if (clientId && row.client_id !== clientId) continue;
        const bucket = groups.get(row.generation) ?? [];
        bucket.push(row);
        groups.set(row.generation, bucket);
      }

      return Array.from(groups.entries())
        .sort((a, b) => b[0] - a[0])
        .map(([generation, rows]) => ({
          generation,
          total: rows.length,
          active: rows.filter((row) => row.is_revoked === 0 && row.expires_at > nowMs).length,
          revoked: rows.filter((row) => row.is_revoked === 1).length,
          expired: rows.filter((row) => row.expires_at <= nowMs).length,
        })) as T[];
    }

    return [];
  }

  async queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
    if (sql.includes('SELECT jti FROM user_token_families WHERE jti = ?')) {
      const jti = params?.[0] as string;
      const row = this.rows.get(jti);
      return row ? ({ jti: row.jti } as T) : null;
    }

    if (sql.includes('SELECT COUNT(*) as count FROM user_token_families')) {
      const [tenantId, generation, nowMs, clientId] = params as [
        string,
        number,
        number,
        string | undefined,
      ];
      const count = this.all().filter((row) => {
        return (
          row.tenant_id === tenantId &&
          row.generation === generation &&
          row.is_revoked === 0 &&
          row.expires_at > nowMs &&
          (typeof clientId === 'string' ? row.client_id === clientId : true)
        );
      }).length;
      return { count } as T;
    }

    return null;
  }

  async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    if (sql.startsWith('INSERT INTO user_token_families')) {
      const [jti, tenantId, userId, clientId, generation, expiresAt] = params as [
        string,
        string,
        string,
        string,
        number,
        number,
      ];
      this.rows.set(jti, {
        jti,
        tenant_id: tenantId,
        user_id: userId,
        client_id: clientId,
        generation,
        expires_at: expiresAt,
        is_revoked: 0,
      });
      return { success: true, rowsAffected: 1 };
    }

    if (sql.includes('SET expires_at = 0')) {
      const [tenantId, userId, clientId] = params as [string, string, string | undefined];
      let updated = 0;
      for (const row of this.rows.values()) {
        if (row.user_id !== userId || row.tenant_id !== tenantId) continue;
        if (typeof clientId === 'string' && row.client_id !== clientId) continue;
        row.expires_at = 0;
        updated++;
      }
      return { success: true, rowsAffected: updated };
    }

    if (sql.includes('SET is_revoked = 1')) {
      const [tenantId, userId, clientId] = params as [string, string, string | undefined];
      let updated = 0;
      for (const row of this.rows.values()) {
        if (row.user_id !== userId || row.tenant_id !== tenantId) continue;
        if (typeof clientId === 'string' && row.client_id !== clientId) continue;
        row.is_revoked = 1;
        updated++;
      }
      return { success: true, rowsAffected: updated };
    }

    if (sql.startsWith('DELETE FROM user_token_families')) {
      const [tenantId, generation, clientId] = params as [string, number, string | undefined];
      let deleted = 0;
      for (const row of this.all()) {
        if (row.tenant_id !== tenantId || row.generation !== generation) continue;
        if (typeof clientId === 'string' && row.client_id !== clientId) continue;
        this.rows.delete(row.jti);
        deleted++;
      }
      return { success: true, rowsAffected: deleted };
    }

    return { success: true, rowsAffected: 0 };
  }

  async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return fn({
      query: this.query.bind(this),
      queryOne: this.queryOne.bind(this),
      execute: this.execute.bind(this),
    });
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

describe('refresh-token-family-index', () => {
  it('records token family rows with the provided tenant id', async () => {
    const adapter = new InMemoryRefreshTokenFamilyIndexAdapter();

    await recordRefreshTokenFamilyIndex(adapter, {
      jti: 'rt_jti_1',
      tenantId: 'tenant_a',
      userId: 'user_1',
      clientId: 'client_1',
      generation: 3,
      expiresAt: 1_800_000_000_000,
    });

    expect(adapter.all()).toEqual([
      {
        jti: 'rt_jti_1',
        tenant_id: 'tenant_a',
        user_id: 'user_1',
        client_id: 'client_1',
        generation: 3,
        expires_at: 1_800_000_000_000,
        is_revoked: 0,
      },
    ]);
  });

  it('lists only active families for the requested tenant and user', async () => {
    const adapter = new InMemoryRefreshTokenFamilyIndexAdapter();
    adapter.seed([
      {
        jti: 'active',
        tenant_id: 'tenant_a',
        user_id: 'user_1',
        client_id: 'client_1',
        generation: 2,
        expires_at: 2_000,
        is_revoked: 0,
      },
      {
        jti: 'revoked',
        tenant_id: 'tenant_a',
        user_id: 'user_1',
        client_id: 'client_1',
        generation: 2,
        expires_at: 2_000,
        is_revoked: 1,
      },
      {
        jti: 'other-tenant',
        tenant_id: 'tenant_b',
        user_id: 'user_1',
        client_id: 'client_1',
        generation: 2,
        expires_at: 2_000,
        is_revoked: 0,
      },
    ]);

    const rows = await listRefreshTokenFamiliesByUser(adapter, {
      tenantId: 'tenant_a',
      userId: 'user_1',
      activeOnly: true,
      nowMs: 1_000,
    });

    expect(rows).toEqual([{ jti: 'active', client_id: 'client_1', generation: 2 }]);
  });

  it('expires and revokes only the requested tenant rows', async () => {
    const adapter = new InMemoryRefreshTokenFamilyIndexAdapter();
    adapter.seed([
      {
        jti: 'tenant-a-1',
        tenant_id: 'tenant_a',
        user_id: 'user_1',
        client_id: 'client_1',
        generation: 1,
        expires_at: 5_000,
        is_revoked: 0,
      },
      {
        jti: 'tenant-b-1',
        tenant_id: 'tenant_b',
        user_id: 'user_1',
        client_id: 'client_1',
        generation: 1,
        expires_at: 5_000,
        is_revoked: 0,
      },
    ]);

    await expireRefreshTokenFamiliesByUser(adapter, {
      tenantId: 'tenant_a',
      userId: 'user_1',
    });
    await revokeRefreshTokenFamiliesByUser(adapter, {
      tenantId: 'tenant_a',
      userId: 'user_1',
    });

    expect(adapter.all()).toEqual([
      expect.objectContaining({
        jti: 'tenant-a-1',
        tenant_id: 'tenant_a',
        expires_at: 0,
        is_revoked: 1,
      }),
      expect.objectContaining({
        jti: 'tenant-b-1',
        tenant_id: 'tenant_b',
        expires_at: 5_000,
        is_revoked: 0,
      }),
    ]);
  });

  it('computes generation stats and cleanup with tenant guards', async () => {
    const adapter = new InMemoryRefreshTokenFamilyIndexAdapter();
    adapter.seed([
      {
        jti: 'a1',
        tenant_id: 'tenant_a',
        user_id: 'user_1',
        client_id: 'client_1',
        generation: 7,
        expires_at: 5_000,
        is_revoked: 0,
      },
      {
        jti: 'a2',
        tenant_id: 'tenant_a',
        user_id: 'user_2',
        client_id: 'client_1',
        generation: 7,
        expires_at: 500,
        is_revoked: 0,
      },
      {
        jti: 'a3',
        tenant_id: 'tenant_a',
        user_id: 'user_3',
        client_id: 'client_1',
        generation: 7,
        expires_at: 5_000,
        is_revoked: 1,
      },
      {
        jti: 'b1',
        tenant_id: 'tenant_b',
        user_id: 'user_4',
        client_id: 'client_1',
        generation: 7,
        expires_at: 5_000,
        is_revoked: 0,
      },
    ]);

    expect(
      await countActiveRefreshTokenFamiliesByGeneration(adapter, {
        tenantId: 'tenant_a',
        generation: 7,
        nowMs: 1_000,
      })
    ).toBe(1);

    expect(
      await getRefreshTokenFamilyGenerationStats(adapter, {
        tenantId: 'tenant_a',
        nowMs: 1_000,
      })
    ).toEqual([{ generation: 7, total: 3, active: 1, revoked: 1, expired: 1 }]);

    expect(
      await deleteRefreshTokenFamiliesByGeneration(adapter, {
        tenantId: 'tenant_a',
        generation: 7,
      })
    ).toBe(3);
    expect(adapter.all()).toEqual([
      expect.objectContaining({
        jti: 'b1',
        tenant_id: 'tenant_b',
      }),
    ]);
  });
});
