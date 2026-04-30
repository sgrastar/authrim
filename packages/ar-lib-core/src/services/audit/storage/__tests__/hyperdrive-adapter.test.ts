import { describe, expect, it, vi } from 'vitest';
import type { EventLogEntry } from '../../types';
import { HyperdriveAuditAdapter } from '../hyperdrive-adapter';

function createEventEntry(overrides: Partial<EventLogEntry> = {}): EventLogEntry {
  return {
    id: 'evt-1',
    tenantId: 'tenant-1',
    eventType: 'auth.login',
    eventCategory: 'authentication',
    result: 'success',
    severity: 'info',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('HyperdriveAuditAdapter', () => {
  it('uses the injected client factory for event writes', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const end = vi.fn().mockResolvedValue(undefined);
    const clientFactory = vi.fn().mockResolvedValue({ query, end });

    const adapter = new HyperdriveAuditAdapter({
      id: 'audit-pg',
      hyperdrive: { connectionString: 'postgres://user:pass@example.com:5432/authrim' } as Hyperdrive,
      schema: 'audit',
      isPiiDb: false,
      clientFactory,
    });

    const result = await adapter.writeEventLogBatch([createEventEntry()]);

    expect(result.success).toBe(true);
    expect(result.entriesWritten).toBe(1);
    expect(clientFactory).toHaveBeenCalledWith('postgres://user:pass@example.com:5432/authrim');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('WITH incoming');
    expect(query.mock.calls[0]?.[0]).toContain('INSERT INTO audit.event_log');
    expect(query.mock.calls[0]?.[0]).toContain('WHERE NOT EXISTS');
    expect(query.mock.calls[0]?.[0]).not.toContain('ON CONFLICT');
  });

  it('uses PostgreSQL-safe retention cleanup SQL with tenant scoping', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 7 });
    const adapter = new HyperdriveAuditAdapter({
      id: 'audit-pg',
      hyperdrive: { connectionString: 'postgres://user:pass@example.com:5432/authrim' } as Hyperdrive,
      schema: 'audit',
      isPiiDb: false,
      clientFactory: async () => ({
        query,
        end: async () => undefined,
      }),
    });

    const deleted = await adapter.deleteByRetention('event', 1_700_000_000_000, 'tenant-1', 50);

    expect(deleted).toBe(7);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('WITH doomed AS');
    expect(query.mock.calls[0]?.[0]).toContain('DELETE FROM audit.event_log');
    expect(query.mock.calls[0]?.[0]).toContain('ORDER BY retention_until ASC, created_at ASC, id ASC');
    expect(query.mock.calls[0]?.[0]).toContain('tenant_id = $2');
    expect(query.mock.calls[0]?.[1]).toEqual([1_700_000_000_000, 'tenant-1', 50]);
  });

  it('lists retention candidates in stable oldest-first order', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 'evt-1',
          tenant_id: 'tenant-1',
          event_type: 'auth.login',
          event_category: 'authentication',
          result: 'success',
          severity: 'info',
          error_code: null,
          error_message: null,
          anonymized_user_id: null,
          client_id: null,
          session_id: null,
          request_id: null,
          duration_ms: null,
          details_r2_key: null,
          details_json: null,
          retention_until: 1_690_000_000_000,
          created_at: 1_700_000_000_000,
        },
      ],
      rowCount: 1,
    });
    const adapter = new HyperdriveAuditAdapter({
      id: 'audit-pg',
      hyperdrive: { connectionString: 'postgres://user:pass@example.com:5432/authrim' } as Hyperdrive,
      schema: 'audit',
      isPiiDb: false,
      clientFactory: async () => ({
        query,
        end: async () => undefined,
      }),
    });

    const rows = await adapter.listRetentionCandidates('event', 1_700_000_000_000, 'tenant-1', 25);

    expect(rows).toEqual([expect.objectContaining({ id: 'evt-1' })]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('ORDER BY retention_until ASC, created_at ASC, id ASC');
    expect(query.mock.calls[0]?.[0]).toContain('FROM audit.event_log');
  });

  it('reports healthy when the PostgreSQL client responds', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ value: 1 }], rowCount: 1 });
    const adapter = new HyperdriveAuditAdapter({
      id: 'audit-pg',
      hyperdrive: { connectionString: 'postgres://user:pass@example.com:5432/authrim' } as Hyperdrive,
      schema: 'audit',
      isPiiDb: false,
      clientFactory: async () => ({
        query,
        end: async () => undefined,
      }),
    });

    const health = await adapter.isHealthy();

    expect(health.healthy).toBe(true);
    expect(health.backendType).toBe('HYPERDRIVE');
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });
});
