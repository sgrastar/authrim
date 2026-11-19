import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';
import { CloudflareAgentMcpSessionRegistry } from '../platform/cloudflare/mcp-session-registry';

function database(options: { rowsAffected?: number; conflict?: boolean; rows?: unknown[] } = {}) {
  const adapter = {
    query: vi.fn(async (_sql: string, _params?: unknown[]) => options.rows ?? []),
    queryOne: vi.fn(async (_sql: string, _params?: unknown[]) =>
      options.conflict ? { session_id: 'session-1' } : null
    ),
    execute: vi.fn(async (_sql: string, _params?: unknown[]) => ({
      success: true,
      rowsAffected: options.rowsAffected ?? 1,
    })),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn(() => 'test'),
    close: vi.fn(),
  };
  return adapter as typeof adapter & DatabaseAdapter;
}

const registration = {
  sessionId: 'session-1',
  tenantId: 'tenant-1',
  grantId: 'grant-1',
  clientId: 'client-1',
  actorSub: 'client:client-1',
  createdAt: 1_000,
  idleExpiresAt: 2_000,
  absoluteExpiresAt: 3_000,
  maxConcurrentSessions: 5,
};

const touch = {
  sessionId: 'session-1',
  tenantId: 'tenant-1',
  grantId: 'grant-1',
  clientId: 'client-1',
  now: 1_500,
  idleExpiresAt: 2_500,
};

describe('CloudflareAgentMcpSessionRegistry register', () => {
  it('binds every registration field in order and counts only live sessions of the same Grant', async () => {
    const adapter = database();
    await expect(
      new CloudflareAgentMcpSessionRegistry(adapter).register(registration)
    ).resolves.toBe('registered');
    expect(adapter.execute.mock.calls[0]?.[1]).toEqual([
      'session-1',
      'tenant-1',
      'grant-1',
      'client-1',
      'client:client-1',
      1_000,
      1_000,
      2_000,
      3_000,
      'tenant-1',
      'grant-1',
      'client-1',
      1_000,
      5,
    ]);
    expect(adapter.queryOne).not.toHaveBeenCalled();
  });

  it('distinguishes an existing session id (conflict) from a full quota', async () => {
    const conflicting = database({ rowsAffected: 0, conflict: true });
    await expect(
      new CloudflareAgentMcpSessionRegistry(conflicting).register(registration)
    ).resolves.toBe('conflict');
    expect(conflicting.queryOne).toHaveBeenCalledWith(
      'SELECT session_id FROM admin_agent_mcp_sessions WHERE session_id = ?',
      ['session-1']
    );
    const full = database({ rowsAffected: 0 });
    await expect(new CloudflareAgentMcpSessionRegistry(full).register(registration)).resolves.toBe(
      'limit_exceeded'
    );
  });

  it('accepts boundary timestamps: zero creation time and absolute expiry equal to idle expiry', async () => {
    const adapter = database();
    await expect(
      new CloudflareAgentMcpSessionRegistry(adapter).register({
        ...registration,
        createdAt: 0,
        idleExpiresAt: 1,
        absoluteExpiresAt: 1,
        maxConcurrentSessions: 1,
      })
    ).resolves.toBe('registered');
  });

  it.each([
    ['missing session id', { sessionId: '' }],
    ['missing tenant', { tenantId: '' }],
    ['missing Grant', { grantId: '' }],
    ['missing client', { clientId: '' }],
    ['missing actor', { actorSub: '' }],
    ['negative creation time', { createdAt: -1 }],
    ['fractional creation time', { createdAt: 1.5 }],
    ['negative idle expiry', { createdAt: 0, idleExpiresAt: -1 }],
    ['non-integer absolute expiry', { absoluteExpiresAt: Number.NaN }],
    ['idle expiry equal to creation', { idleExpiresAt: 1_000 }],
    ['absolute expiry before idle expiry', { absoluteExpiresAt: 1_999 }],
    ['non-integer session maximum', { maxConcurrentSessions: 1.5 }],
    ['zero session maximum', { maxConcurrentSessions: 0 }],
  ])('rejects a registration with %s before touching the database', async (_name, change) => {
    const adapter = database();
    await expect(
      new CloudflareAgentMcpSessionRegistry(adapter).register({ ...registration, ...change })
    ).rejects.toThrow(new TypeError('Invalid Agent MCP session registration'));
    expect(adapter.execute).not.toHaveBeenCalled();
  });
});

describe('CloudflareAgentMcpSessionRegistry touch', () => {
  it('extends idle expiry only for the same tenant, Grant and client binding', async () => {
    const adapter = database();
    await expect(new CloudflareAgentMcpSessionRegistry(adapter).touch(touch)).resolves.toBe(true);
    expect(adapter.execute.mock.calls[0]?.[1]).toEqual([
      1_500,
      2_500,
      'session-1',
      'tenant-1',
      'grant-1',
      'client-1',
      1_500,
      1_500,
    ]);
  });

  it('reports an expired or unknown session as inactive', async () => {
    await expect(
      new CloudflareAgentMcpSessionRegistry(database({ rowsAffected: 0 })).touch(touch)
    ).resolves.toBe(false);
    await expect(
      new CloudflareAgentMcpSessionRegistry(database({ rowsAffected: 2 })).touch(touch)
    ).resolves.toBe(false);
  });

  it.each([
    ['missing session id', { sessionId: '' }],
    ['missing tenant', { tenantId: '' }],
    ['missing Grant', { grantId: '' }],
    ['missing client', { clientId: '' }],
    ['negative now', { now: -1 }],
    ['fractional idle expiry', { idleExpiresAt: 2_000.5 }],
    ['idle expiry equal to now', { idleExpiresAt: 1_500 }],
  ])('rejects a touch with %s', async (_name, change) => {
    const adapter = database();
    await expect(
      new CloudflareAgentMcpSessionRegistry(adapter).touch({ ...touch, ...change })
    ).rejects.toThrow(new TypeError('Invalid Agent MCP session touch'));
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('accepts a touch at time zero', async () => {
    const adapter = database();
    await expect(
      new CloudflareAgentMcpSessionRegistry(adapter).touch({ ...touch, now: 0, idleExpiresAt: 1 })
    ).resolves.toBe(true);
  });
});

describe('CloudflareAgentMcpSessionRegistry delete and listExpired', () => {
  it('deletes only the session bound to the same Grant and client', async () => {
    const adapter = database();
    await new CloudflareAgentMcpSessionRegistry(adapter).delete(touch);
    expect(adapter.execute.mock.calls[0]?.[0]).toMatch(/^DELETE FROM admin_agent_mcp_sessions/u);
    expect(adapter.execute.mock.calls[0]?.[1]).toEqual([
      'session-1',
      'tenant-1',
      'grant-1',
      'client-1',
    ]);
  });

  it('maps expired rows to session identities and binds the cutoff twice', async () => {
    const adapter = database({
      rows: [{ session_id: 's-1', tenant_id: 't-1', grant_id: 'g-1', client_id: 'c-1' }],
    });
    await expect(
      new CloudflareAgentMcpSessionRegistry(adapter).listExpired(500, 10)
    ).resolves.toEqual([{ sessionId: 's-1', tenantId: 't-1', grantId: 'g-1', clientId: 'c-1' }]);
    expect(adapter.query.mock.calls[0]?.[0]).toMatch(
      /SELECT session_id, tenant_id, grant_id, client_id[\s\S]+expires_at <= \?/u
    );
    expect(adapter.query.mock.calls[0]?.[1]).toEqual([500, 500, 10]);
  });

  it('accepts the limit boundaries 1 and 1000 and a zero cutoff', async () => {
    const registry = new CloudflareAgentMcpSessionRegistry(database());
    await expect(registry.listExpired(0, 1)).resolves.toEqual([]);
    await expect(registry.listExpired(10, 1_000)).resolves.toEqual([]);
  });

  it.each([
    [-1, 10],
    [1.5, 10],
    [10, 0],
    [10, 1_001],
    [10, 2.5],
  ])('rejects an expired-session query with now=%s limit=%s', async (now, limit) => {
    const adapter = database();
    await expect(
      new CloudflareAgentMcpSessionRegistry(adapter).listExpired(now, limit)
    ).rejects.toThrow(new TypeError('Invalid Agent MCP expired-session query'));
    expect(adapter.query).not.toHaveBeenCalled();
  });
});
