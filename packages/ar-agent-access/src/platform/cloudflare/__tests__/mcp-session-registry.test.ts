import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';
import { CloudflareAgentMcpSessionRegistry } from '../mcp-session-registry';

function database(rowsAffected = 1): DatabaseAdapter {
  return {
    query: vi.fn(async () => []),
    queryOne: vi.fn(async () => null),
    execute: vi.fn(async () => ({ success: true, rowsAffected })),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(async () => ({ healthy: true, latencyMs: 0, type: 'test' })),
    getType: vi.fn(() => 'test'),
    close: vi.fn(async () => undefined),
  } as unknown as DatabaseAdapter;
}

describe('CloudflareAgentMcpSessionRegistry', () => {
  it('performs the active-session count and insert in one SQL statement', async () => {
    const adapter = database();
    const registry = new CloudflareAgentMcpSessionRegistry(adapter);
    await expect(
      registry.register({
        sessionId: 'session-1',
        tenantId: 'tenant-1',
        grantId: 'grant-1',
        clientId: 'client-1',
        actorSub: 'client:client-1',
        createdAt: 1_000,
        idleExpiresAt: 2_000,
        absoluteExpiresAt: 3_000,
        maxConcurrentSessions: 20,
      })
    ).resolves.toBe('registered');
    expect(adapter.execute).toHaveBeenCalledOnce();
    expect(vi.mocked(adapter.execute).mock.calls[0]?.[0]).toMatch(
      /INSERT OR IGNORE INTO admin_agent_mcp_sessions[\s\S]+SELECT COUNT\(\*\)/u
    );
  });

  it('reports a full quota without weakening the configured maximum', async () => {
    const registry = new CloudflareAgentMcpSessionRegistry(database(0));
    await expect(
      registry.register({
        sessionId: 'session-1',
        tenantId: 'tenant-1',
        grantId: 'grant-1',
        clientId: 'client-1',
        actorSub: 'client:client-1',
        createdAt: 1_000,
        idleExpiresAt: 2_000,
        absoluteExpiresAt: 3_000,
        maxConcurrentSessions: 1,
      })
    ).resolves.toBe('limit_exceeded');
  });

  it('distinguishes a session ID collision from a full Grant quota', async () => {
    const adapter = database(0);
    vi.mocked(adapter.queryOne).mockResolvedValue({ session_id: 'session-1' });
    const registry = new CloudflareAgentMcpSessionRegistry(adapter);
    await expect(
      registry.register({
        sessionId: 'session-1',
        tenantId: 'tenant-1',
        grantId: 'grant-1',
        clientId: 'client-1',
        actorSub: 'client:client-1',
        createdAt: 1_000,
        idleExpiresAt: 2_000,
        absoluteExpiresAt: 3_000,
        maxConcurrentSessions: 1,
      })
    ).resolves.toBe('conflict');
  });

  it('touches and deletes only the exact tenant, Grant, client, and session tuple', async () => {
    const adapter = database();
    const registry = new CloudflareAgentMcpSessionRegistry(adapter);
    await expect(
      registry.touch({
        sessionId: 'session-1',
        tenantId: 'tenant-1',
        grantId: 'grant-1',
        clientId: 'client-1',
        now: 1_500,
        idleExpiresAt: 2_500,
      })
    ).resolves.toBe(true);
    await registry.delete({
      sessionId: 'session-1',
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      clientId: 'client-1',
    });
    expect(vi.mocked(adapter.execute).mock.calls[0]?.[0]).toContain(
      'session_id = ? AND tenant_id = ? AND grant_id = ? AND client_id = ?'
    );
    expect(vi.mocked(adapter.execute).mock.calls[1]?.[0]).toContain(
      'session_id = ? AND tenant_id = ? AND grant_id = ? AND client_id = ?'
    );
  });
});
