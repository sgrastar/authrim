import { describe, expect, it } from 'vitest';
import type {
  DatabaseAdapter,
  ExecuteResult,
  HealthStatus,
  TransactionContext,
} from '../../db/adapter';
import {
  createCIBARequestPersistenceAdapter,
  createGlobalCIBARequestPersistenceAdapter,
  type CIBARequestPersistenceAdapter,
} from '../ciba-request-persistence';
import type { CIBARequestMetadata } from '../../types/oidc';

function createMetadata(overrides: Partial<CIBARequestMetadata> = {}): CIBARequestMetadata {
  return {
    auth_req_id: 'auth_req_123',
    client_id: 'client_123',
    scope: 'openid profile',
    status: 'pending',
    delivery_mode: 'poll',
    created_at: 1_700_000_000_000,
    expires_at: 1_700_000_300_000,
    interval: 5,
    token_issued: false,
    ...overrides,
  };
}

type CIBARow = {
  auth_req_id: string;
  client_id: string;
  scope: string;
  login_hint: string | null;
  login_hint_token: string | null;
  id_token_hint: string | null;
  binding_message: string | null;
  user_code: string | null;
  acr_values: string | null;
  requested_expiry: number | null;
  status: string;
  delivery_mode: 'poll' | 'ping' | 'push';
  client_notification_token: string | null;
  client_notification_endpoint: string | null;
  created_at: number;
  expires_at: number;
  last_poll_at: number | null;
  poll_count: number;
  interval: number;
  user_id: string | null;
  sub: string | null;
  nonce: string | null;
  token_issued: number;
  token_issued_at: number | null;
};

class InMemoryCIBAAdapter implements DatabaseAdapter {
  private rows = new Map<string, CIBARow>();

  seed(rows: CIBARow[]): void {
    for (const row of rows) {
      this.rows.set(row.auth_req_id, { ...row });
    }
  }

  getAll(): CIBARow[] {
    return Array.from(this.rows.values());
  }

  async query<T>(): Promise<T[]> {
    return [];
  }

  async queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
    if (sql.includes('FROM ciba_requests') && sql.includes('WHERE auth_req_id = ?')) {
      const row = this.rows.get(params?.[0] as string);
      return (row ? { ...row } : null) as T | null;
    }

    if (sql.includes('FROM ciba_requests') && sql.includes('WHERE user_code = ?')) {
      const userCode = params?.[0] as string;
      const row = this.getAll().find((candidate) => candidate.user_code === userCode);
      return (row ? { ...row } : null) as T | null;
    }

    if (sql.includes("WHERE login_hint = ? AND client_id = ? AND status = 'pending'")) {
      const loginHint = params?.[0] as string;
      const clientId = params?.[1] as string;
      const row = this.getAll()
        .filter(
          (candidate) =>
            candidate.login_hint === loginHint &&
            candidate.client_id === clientId &&
            candidate.status === 'pending'
        )
        .sort((a, b) => b.created_at - a.created_at)[0];
      return (row ? { ...row } : null) as T | null;
    }

    return null;
  }

  async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    if (sql.startsWith('UPDATE ciba_requests')) {
      const existing = this.rows.get(params?.[params.length - 1] as string);
      if (!existing) {
        return { success: true, rowsAffected: 0 };
      }

      if (sql.includes('SET client_id = ?')) {
        const [
          clientId,
          scope,
          loginHint,
          loginHintToken,
          idTokenHint,
          bindingMessage,
          userCode,
          acrValues,
          requestedExpiry,
          status,
          deliveryMode,
          clientNotificationToken,
          clientNotificationEndpoint,
          createdAt,
          expiresAt,
          lastPollAt,
          pollCount,
          interval,
          userId,
          sub,
          nonce,
          tokenIssued,
          tokenIssuedAt,
        ] = params as [
          string,
          string,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
          number | null,
          string,
          'poll' | 'ping' | 'push',
          string | null,
          string | null,
          number,
          number,
          number | null,
          number,
          number,
          string | null,
          string | null,
          string | null,
          number,
          number | null,
          string,
        ];
        this.rows.set(existing.auth_req_id, {
          auth_req_id: existing.auth_req_id,
          client_id: clientId,
          scope,
          login_hint: loginHint,
          login_hint_token: loginHintToken,
          id_token_hint: idTokenHint,
          binding_message: bindingMessage,
          user_code: userCode,
          acr_values: acrValues,
          requested_expiry: requestedExpiry,
          status,
          delivery_mode: deliveryMode,
          client_notification_token: clientNotificationToken,
          client_notification_endpoint: clientNotificationEndpoint,
          created_at: createdAt,
          expires_at: expiresAt,
          last_poll_at: lastPollAt,
          poll_count: pollCount,
          interval,
          user_id: userId,
          sub,
          nonce,
          token_issued: tokenIssued,
          token_issued_at: tokenIssuedAt,
        });
      } else if (sql.includes('SET status = ?, user_id = ?, sub = ?, nonce = ?')) {
        const [status, userId, sub, nonce] = params as [string, string, string, string | null];
        this.rows.set(existing.auth_req_id, { ...existing, status, user_id: userId, sub, nonce });
      } else if (sql.includes('SET status = ?')) {
        const [status] = params as [string, string];
        this.rows.set(existing.auth_req_id, { ...existing, status });
      } else if (sql.includes('SET last_poll_at = ?, poll_count = ?')) {
        const [lastPollAt, pollCount] = params as [number, number, string];
        this.rows.set(existing.auth_req_id, {
          ...existing,
          last_poll_at: lastPollAt,
          poll_count: pollCount,
        });
      } else if (sql.includes('SET token_issued = ?, token_issued_at = ?')) {
        const [tokenIssued, tokenIssuedAt] = params as [number, number, string];
        this.rows.set(existing.auth_req_id, {
          ...existing,
          token_issued: tokenIssued,
          token_issued_at: tokenIssuedAt,
        });
      }

      return { success: true, rowsAffected: 1 };
    }

    if (sql.startsWith('INSERT INTO ciba_requests')) {
      const [
        authReqId,
        clientId,
        scope,
        loginHint,
        loginHintToken,
        idTokenHint,
        bindingMessage,
        userCode,
        acrValues,
        requestedExpiry,
        status,
        deliveryMode,
        clientNotificationToken,
        clientNotificationEndpoint,
        createdAt,
        expiresAt,
        lastPollAt,
        pollCount,
        interval,
        userId,
        sub,
        nonce,
        tokenIssued,
        tokenIssuedAt,
      ] = params as [
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        number | null,
        string,
        'poll' | 'ping' | 'push',
        string | null,
        string | null,
        number,
        number,
        number | null,
        number,
        number,
        string | null,
        string | null,
        string | null,
        number,
        number | null,
      ];
      this.rows.set(authReqId, {
        auth_req_id: authReqId,
        client_id: clientId,
        scope,
        login_hint: loginHint,
        login_hint_token: loginHintToken,
        id_token_hint: idTokenHint,
        binding_message: bindingMessage,
        user_code: userCode,
        acr_values: acrValues,
        requested_expiry: requestedExpiry,
        status,
        delivery_mode: deliveryMode,
        client_notification_token: clientNotificationToken,
        client_notification_endpoint: clientNotificationEndpoint,
        created_at: createdAt,
        expires_at: expiresAt,
        last_poll_at: lastPollAt,
        poll_count: pollCount,
        interval,
        user_id: userId,
        sub,
        nonce,
        token_issued: tokenIssued,
        token_issued_at: tokenIssuedAt,
      });
      return { success: true, rowsAffected: 1 };
    }

    if (sql.startsWith('DELETE FROM ciba_requests WHERE auth_req_id = ?')) {
      const removed = this.rows.delete(params?.[0] as string);
      return { success: true, rowsAffected: removed ? 1 : 0 };
    }

    if (sql.startsWith('DELETE FROM ciba_requests WHERE expires_at < ?')) {
      const now = params?.[0] as number;
      let removed = 0;
      for (const row of this.getAll()) {
        if (row.expires_at < now) {
          this.rows.delete(row.auth_req_id);
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

describe('ciba-request-persistence', () => {
  it('loads CIBA requests by auth_req_id and maps token flags', async () => {
    const adapter = new InMemoryCIBAAdapter();
    adapter.seed([
      {
        auth_req_id: 'auth_req_123',
        client_id: 'client_123',
        scope: 'openid profile',
        login_hint: 'user@example.com',
        login_hint_token: null,
        id_token_hint: null,
        binding_message: null,
        user_code: '1234',
        acr_values: null,
        requested_expiry: null,
        status: 'approved',
        delivery_mode: 'poll',
        client_notification_token: null,
        client_notification_endpoint: null,
        created_at: 1_700_000_000_000,
        expires_at: 1_700_000_300_000,
        last_poll_at: null,
        poll_count: 2,
        interval: 5,
        user_id: 'user_123',
        sub: 'user_123',
        nonce: 'nonce_123',
        token_issued: 1,
        token_issued_at: 1_700_000_100_000,
      },
    ]);
    const persistence = createGlobalCIBARequestPersistenceAdapter(
      adapter
    ) as CIBARequestPersistenceAdapter;

    const metadata = await persistence.getByAuthReqId('auth_req_123');

    expect(metadata).toEqual({
      auth_req_id: 'auth_req_123',
      client_id: 'client_123',
      scope: 'openid profile',
      login_hint: 'user@example.com',
      login_hint_token: null,
      id_token_hint: null,
      binding_message: null,
      user_code: '1234',
      acr_values: null,
      requested_expiry: null,
      status: 'approved',
      delivery_mode: 'poll',
      client_notification_token: null,
      client_notification_endpoint: null,
      created_at: 1_700_000_000_000,
      expires_at: 1_700_000_300_000,
      last_poll_at: null,
      poll_count: 2,
      interval: 5,
      user_id: 'user_123',
      sub: 'user_123',
      nonce: 'nonce_123',
      token_issued: true,
      token_issued_at: 1_700_000_100_000,
    });
  });

  it('stores and resolves login-hint based requests', async () => {
    const adapter = new InMemoryCIBAAdapter();
    const persistence = createGlobalCIBARequestPersistenceAdapter(
      adapter
    ) as CIBARequestPersistenceAdapter;

    await persistence.storeRequest(
      createMetadata({
        login_hint: 'user@example.com',
        user_code: '1234',
        binding_message: 'Approve sign-in',
      })
    );

    const metadata = await persistence.getByLoginHint('user@example.com', 'client_123');

    expect(metadata?.user_code).toBe('1234');
    expect(metadata?.binding_message).toBe('Approve sign-in');
  });

  it('rejects a mismatched record tenant on tenant-bound stores', async () => {
    const adapter = new InMemoryCIBAAdapter();
    const persistence = createCIBARequestPersistenceAdapter(
      adapter,
      'ciba-request-store',
      'tenant-a'
    );

    await expect(
      persistence!.storeRequest(createMetadata({ tenant_id: 'tenant-b' }))
    ).rejects.toThrow('CIBA request persistence tenant mismatch');
    expect(adapter.getAll()).toEqual([]);
  });

  it('marks token issuance with a timestamp', async () => {
    const adapter = new InMemoryCIBAAdapter();
    adapter.seed([
      {
        auth_req_id: 'auth_req_123',
        client_id: 'client_123',
        scope: 'openid profile',
        login_hint: null,
        login_hint_token: null,
        id_token_hint: null,
        binding_message: null,
        user_code: null,
        acr_values: null,
        requested_expiry: null,
        status: 'approved',
        delivery_mode: 'poll',
        client_notification_token: null,
        client_notification_endpoint: null,
        created_at: 1_700_000_000_000,
        expires_at: 1_700_000_300_000,
        last_poll_at: null,
        poll_count: 0,
        interval: 5,
        user_id: 'user_123',
        sub: 'user_123',
        nonce: null,
        token_issued: 0,
        token_issued_at: null,
      },
    ]);
    const persistence = createGlobalCIBARequestPersistenceAdapter(
      adapter
    ) as CIBARequestPersistenceAdapter;

    await persistence.markTokenIssued('auth_req_123', 1_700_000_200_000);

    expect(adapter.getAll()[0]).toMatchObject({
      status: 'approved',
      token_issued: 1,
      token_issued_at: 1_700_000_200_000,
    });
  });

  it('deletes expired CIBA requests', async () => {
    const adapter = new InMemoryCIBAAdapter();
    adapter.seed([
      {
        auth_req_id: 'auth_req_expired',
        client_id: 'client_123',
        scope: 'openid',
        login_hint: null,
        login_hint_token: null,
        id_token_hint: null,
        binding_message: null,
        user_code: null,
        acr_values: null,
        requested_expiry: null,
        status: 'pending',
        delivery_mode: 'poll',
        client_notification_token: null,
        client_notification_endpoint: null,
        created_at: 1_700_000_000_000,
        expires_at: 100,
        last_poll_at: null,
        poll_count: 0,
        interval: 5,
        user_id: null,
        sub: null,
        nonce: null,
        token_issued: 0,
        token_issued_at: null,
      },
      {
        auth_req_id: 'auth_req_active',
        client_id: 'client_123',
        scope: 'openid',
        login_hint: null,
        login_hint_token: null,
        id_token_hint: null,
        binding_message: null,
        user_code: null,
        acr_values: null,
        requested_expiry: null,
        status: 'pending',
        delivery_mode: 'poll',
        client_notification_token: null,
        client_notification_endpoint: null,
        created_at: 1_700_000_000_000,
        expires_at: 1_700_000_300_000,
        last_poll_at: null,
        poll_count: 0,
        interval: 5,
        user_id: null,
        sub: null,
        nonce: null,
        token_issued: 0,
        token_issued_at: null,
      },
    ]);
    const persistence = createGlobalCIBARequestPersistenceAdapter(
      adapter
    ) as CIBARequestPersistenceAdapter;

    const deleted = await persistence.deleteExpired(1_000);

    expect(deleted).toBe(1);
    expect(adapter.getAll()).toHaveLength(1);
    expect(adapter.getAll()[0].auth_req_id).toBe('auth_req_active');
  });
});
