import { describe, expect, it, vi } from 'vitest';
import { createPostgresAuditRuntimePorts } from '../postgres-audit';
import type { PostgresQueryClient } from '../postgres-transient-state';

const entry = {
  id: 'event-1',
  tenantId: 'tenant-a',
  userId: 'user-a',
  action: 'user.login',
  resource: 'session',
  resourceId: 'opaque',
  ipAddress: '203.0.113.7',
  userAgent: 'test',
  metadata: JSON.stringify({
    password: 'never-store',
    email: 'private@example.test',
    nested: { token: 'secret', outcome: 'success' },
  }),
  severity: 'info' as const,
  createdAt: 1_800_000_000_000,
};

describe('AWS durable local audit', () => {
  function setup() {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({
      rows: [{ id: entry.id }],
      rowCount: 1,
    }));
    return {
      query,
      port: createPostgresAuditRuntimePorts({ query } as PostgresQueryClient, ['tenant-a']),
    };
  }
  it('awaits a parameterized, sanitized durable append', async () => {
    const { query, port } = setup();
    await port.append(entry);
    const values = query.mock.calls[0]?.[1] as unknown as unknown[];
    const payload = String(values[4]);
    expect(payload).not.toContain('never-store');
    expect(payload).not.toContain('private@example.test');
    expect(payload).not.toContain('secret');
    expect(payload).toContain('success');
    expect(values.slice(0, 4)).toEqual(['tenant-a', 'event-1', entry.createdAt, 'user.login']);
  });
  it('rejects a different tenant and unsupported fanout before writing', async () => {
    const { query, port } = setup();
    await expect(port.append({ ...entry, tenantId: 'tenant-b' })).rejects.toThrow('tenant_unknown');
    await expect(port.append({ ...entry, requireDurableFanout: true })).rejects.toThrow(
      'fanout_unsupported'
    );
    expect(query).not.toHaveBeenCalled();
  });
  it('rejects conflicting retries and database unavailability', async () => {
    const { query, port } = setup();
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(port.append(entry)).rejects.toThrow('event_conflict');
    query.mockRejectedValueOnce(new Error('unavailable'));
    await expect(port.append(entry)).rejects.toThrow('unavailable');
  });
});
