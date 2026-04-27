import { describe, expect, it } from 'vitest';
import type { DatabaseAdapter, ExecuteResult, HealthStatus, TransactionContext } from '../../db/adapter';
import {
  createDeviceCodePersistenceAdapter,
  type DeviceCodePersistenceAdapter,
} from '../device-code-persistence';
import type { DeviceCodeMetadata } from '../../types/oidc';

function createMetadata(overrides: Partial<DeviceCodeMetadata> = {}): DeviceCodeMetadata {
  return {
    device_code: 'dev_123',
    user_code: 'ABCD-EFGH',
    client_id: 'client_123',
    scope: 'openid profile',
    status: 'pending',
    created_at: 1_700_000_000_000,
    expires_at: 1_700_000_300_000,
    poll_count: 0,
    token_issued: false,
    ...overrides,
  };
}

type DeviceRow = {
  device_code: string;
  user_code: string;
  client_id: string;
  scope: string;
  status: string;
  user_id: string | null;
  sub: string | null;
  created_at: number;
  expires_at: number;
  last_poll_at: number | null;
  poll_count: number;
  token_issued: number;
  token_issued_at: number | null;
};

class InMemoryDeviceCodeAdapter implements DatabaseAdapter {
  private rows = new Map<string, DeviceRow>();

  seed(rows: DeviceRow[]): void {
    for (const row of rows) {
      this.rows.set(row.device_code, { ...row });
    }
  }

  getAll(): DeviceRow[] {
    return Array.from(this.rows.values());
  }

  async query<T>(): Promise<T[]> {
    return [];
  }

  async queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
    if (sql.includes('FROM device_codes') && sql.includes('WHERE device_code = ?')) {
      const row = this.rows.get(params?.[0] as string);
      return (row ? { ...row } : null) as T | null;
    }

    if (sql.includes('FROM device_codes') && sql.includes('WHERE user_code = ?')) {
      const userCode = params?.[0] as string;
      const row = this.getAll().find((candidate) => candidate.user_code === userCode);
      return (row ? { ...row } : null) as T | null;
    }

    return null;
  }

  async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    if (sql.startsWith('UPDATE device_codes')) {
      const existing = this.rows.get(params?.[params.length - 1] as string);
      if (!existing) {
        return { success: true, rowsAffected: 0 };
      }

      if (sql.includes('SET user_code = ?')) {
        const [
          userCode,
          clientId,
          scope,
          status,
          userId,
          sub,
          createdAt,
          expiresAt,
          lastPollAt,
          pollCount,
          tokenIssued,
          tokenIssuedAt,
        ] = params as [
          string,
          string,
          string,
          string,
          string | null,
          string | null,
          number,
          number,
          number | null,
          number,
          number,
          number | null,
          string,
        ];
        this.rows.set(existing.device_code, {
          device_code: existing.device_code,
          user_code: userCode,
          client_id: clientId,
          scope,
          status,
          user_id: userId,
          sub,
          created_at: createdAt,
          expires_at: expiresAt,
          last_poll_at: lastPollAt,
          poll_count: pollCount,
          token_issued: tokenIssued,
          token_issued_at: tokenIssuedAt,
        });
      } else if (sql.includes('SET status = ?, user_id = ?, sub = ?')) {
        const [status, userId, sub] = params as [string, string, string, string];
        this.rows.set(existing.device_code, { ...existing, status, user_id: userId, sub });
      } else if (sql.includes('SET status = ?')) {
        const [status] = params as [string, string];
        this.rows.set(existing.device_code, { ...existing, status });
      } else if (sql.includes('SET last_poll_at = ?, poll_count = ?')) {
        const [lastPollAt, pollCount] = params as [number, number, string];
        this.rows.set(existing.device_code, {
          ...existing,
          last_poll_at: lastPollAt,
          poll_count: pollCount,
        });
      } else if (sql.includes('SET token_issued = ?, token_issued_at = ?')) {
        const [tokenIssued, tokenIssuedAt] = params as [number, number, string];
        this.rows.set(existing.device_code, {
          ...existing,
          token_issued: tokenIssued,
          token_issued_at: tokenIssuedAt,
        });
      }

      return { success: true, rowsAffected: 1 };
    }

    if (sql.startsWith('INSERT INTO device_codes')) {
      const [
        deviceCode,
        userCode,
        clientId,
        scope,
        status,
        userId,
        sub,
        createdAt,
        expiresAt,
        lastPollAt,
        pollCount,
        tokenIssued,
        tokenIssuedAt,
      ] = params as [
        string,
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        number,
        number,
        number | null,
        number,
        number,
        number | null,
      ];
      this.rows.set(deviceCode, {
        device_code: deviceCode,
        user_code: userCode,
        client_id: clientId,
        scope,
        status,
        user_id: userId,
        sub,
        created_at: createdAt,
        expires_at: expiresAt,
        last_poll_at: lastPollAt,
        poll_count: pollCount,
        token_issued: tokenIssued,
        token_issued_at: tokenIssuedAt,
      });
      return { success: true, rowsAffected: 1 };
    }

    if (sql.startsWith('DELETE FROM device_codes WHERE device_code = ?')) {
      const removed = this.rows.delete(params?.[0] as string);
      return { success: true, rowsAffected: removed ? 1 : 0 };
    }

    if (sql.startsWith('DELETE FROM device_codes WHERE expires_at < ?')) {
      const now = params?.[0] as number;
      let removed = 0;
      for (const row of this.getAll()) {
        if (row.expires_at < now) {
          this.rows.delete(row.device_code);
          removed++;
        }
      }
      return { success: true, rowsAffected: removed };
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

describe('device-code-persistence', () => {
  it('loads device codes by device code and maps token flags', async () => {
    const adapter = new InMemoryDeviceCodeAdapter();
    adapter.seed([
      {
        device_code: 'dev_123',
        user_code: 'ABCD-EFGH',
        client_id: 'client_123',
        scope: 'openid profile',
        status: 'approved',
        user_id: 'user_123',
        sub: 'user_123',
        created_at: 1_700_000_000_000,
        expires_at: 1_700_000_300_000,
        last_poll_at: null,
        poll_count: 3,
        token_issued: 1,
        token_issued_at: 1_700_000_100_000,
      },
    ]);

    const persistence = createDeviceCodePersistenceAdapter(adapter) as DeviceCodePersistenceAdapter;
    const metadata = await persistence.getByDeviceCode('dev_123');

    expect(metadata).toEqual({
      device_code: 'dev_123',
      user_code: 'ABCD-EFGH',
      client_id: 'client_123',
      scope: 'openid profile',
      status: 'approved',
      user_id: 'user_123',
      sub: 'user_123',
      created_at: 1_700_000_000_000,
      expires_at: 1_700_000_300_000,
      last_poll_at: null,
      poll_count: 3,
      token_issued: true,
      token_issued_at: 1_700_000_100_000,
    });
  });

  it('stores new device codes through the adapter', async () => {
    const adapter = new InMemoryDeviceCodeAdapter();
    const persistence = createDeviceCodePersistenceAdapter(adapter) as DeviceCodePersistenceAdapter;

    await persistence.storeDeviceCode(createMetadata());

    expect(adapter.getAll()).toEqual([
      {
        device_code: 'dev_123',
        user_code: 'ABCD-EFGH',
        client_id: 'client_123',
        scope: 'openid profile',
        status: 'pending',
        user_id: null,
        sub: null,
        created_at: 1_700_000_000_000,
        expires_at: 1_700_000_300_000,
        last_poll_at: null,
        poll_count: 0,
        token_issued: 0,
        token_issued_at: null,
      },
    ]);
  });

  it('marks token issuance without changing the device status', async () => {
    const adapter = new InMemoryDeviceCodeAdapter();
    adapter.seed([
      {
        device_code: 'dev_123',
        user_code: 'ABCD-EFGH',
        client_id: 'client_123',
        scope: 'openid profile',
        status: 'approved',
        user_id: 'user_123',
        sub: 'user_123',
        created_at: 1_700_000_000_000,
        expires_at: 1_700_000_300_000,
        last_poll_at: null,
        poll_count: 1,
        token_issued: 0,
        token_issued_at: null,
      },
    ]);
    const persistence = createDeviceCodePersistenceAdapter(adapter) as DeviceCodePersistenceAdapter;

    await persistence.markTokenIssued('dev_123', 1_700_000_200_000);

    expect(adapter.getAll()[0]).toMatchObject({
      status: 'approved',
      token_issued: 1,
      token_issued_at: 1_700_000_200_000,
    });
  });

  it('deletes expired device codes', async () => {
    const adapter = new InMemoryDeviceCodeAdapter();
    adapter.seed([
      {
        device_code: 'dev_expired',
        user_code: 'AAAA-BBBB',
        client_id: 'client_123',
        scope: 'openid',
        status: 'pending',
        user_id: null,
        sub: null,
        created_at: 1_700_000_000_000,
        expires_at: 100,
        last_poll_at: null,
        poll_count: 0,
        token_issued: 0,
        token_issued_at: null,
      },
      {
        device_code: 'dev_active',
        user_code: 'CCCC-DDDD',
        client_id: 'client_123',
        scope: 'openid',
        status: 'pending',
        user_id: null,
        sub: null,
        created_at: 1_700_000_000_000,
        expires_at: 1_700_000_300_000,
        last_poll_at: null,
        poll_count: 0,
        token_issued: 0,
        token_issued_at: null,
      },
    ]);
    const persistence = createDeviceCodePersistenceAdapter(adapter) as DeviceCodePersistenceAdapter;

    const deleted = await persistence.deleteExpired(1_000);

    expect(deleted).toBe(1);
    expect(adapter.getAll()).toHaveLength(1);
    expect(adapter.getAll()[0].device_code).toBe('dev_active');
  });
});
