import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../../db';
import { cleanupExpiredEventLogs, cleanupExpiredPIILogs } from '../queue-consumer';

function createMockAdapter(rowsAffected: number): DatabaseAdapter {
  return {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn().mockResolvedValue({
      success: true,
      rowsAffected,
    }),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn(),
  };
}

describe('audit queue consumer cleanup helpers', () => {
  it('accepts a DatabaseAdapter source for event log cleanup', async () => {
    const adapter = createMockAdapter(3);

    const deleted = await cleanupExpiredEventLogs(adapter, 'tenant-1', 25);

    expect(deleted).toBe(3);
    expect(adapter.execute).toHaveBeenCalledWith(
      'DELETE FROM event_log WHERE retention_until < ? AND tenant_id = ? LIMIT ?',
      [expect.any(Number), 'tenant-1', 25]
    );
  });

  it('accepts a DatabaseAdapter source for pii log cleanup', async () => {
    const adapter = createMockAdapter(7);

    const deleted = await cleanupExpiredPIILogs(adapter, undefined, 50);

    expect(deleted).toBe(7);
    expect(adapter.execute).toHaveBeenCalledWith(
      'DELETE FROM pii_log WHERE retention_until < ? LIMIT ?',
      [expect.any(Number), 50]
    );
  });
});
