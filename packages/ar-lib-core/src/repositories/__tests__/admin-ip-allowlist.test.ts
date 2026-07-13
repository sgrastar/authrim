import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { AdminIpAllowlistRepository } from '../admin/admin-ip-allowlist';

function adapter(rows: Record<string, unknown>[] = []): DatabaseAdapter {
  return {
    query: vi.fn(async () => rows),
    queryOne: vi.fn(async () => null),
    execute: vi.fn(async () => ({ success: true, rowsAffected: 1 })),
    batch: vi.fn(),
    transaction: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn(() => 'd1'),
    close: vi.fn(),
  } as unknown as DatabaseAdapter;
}

function row(ip_range: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'entry-1',
    tenant_id: 'tenant-a',
    ip_range,
    ip_version: ip_range.includes(':') ? 6 : 4,
    description: null,
    enabled: 1,
    created_by: 'admin-1',
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe('AdminIpAllowlistRepository', () => {
  beforeEach(() => vi.useFakeTimers());

  it('creates IPv4/IPv6 entries with safe defaults and explicit values', async () => {
    const db = adapter();
    const repository = new AdminIpAllowlistRepository(db);
    await expect(
      repository.createEntry({ tenant_id: 'tenant-a', ip_range: '192.0.2.1' })
    ).resolves.toMatchObject({ ip_version: 4, enabled: true, description: null });
    await expect(
      repository.createEntry({
        tenant_id: 'tenant-a',
        ip_range: '2001:db8::/32',
        ip_version: 6,
        enabled: false,
        description: 'office',
        created_by: 'admin-1',
      })
    ).resolves.toMatchObject({ ip_version: 6, enabled: false, description: 'office' });
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it('rejects creation without tenant context', async () => {
    await expect(
      new AdminIpAllowlistRepository(adapter()).createEntry({
        tenant_id: ' ',
        ip_range: '127.0.0.1',
      })
    ).rejects.toThrow('requires tenantId');
  });

  it.each([
    [[], '203.0.113.1', true],
    [[row('203.0.113.1')], '203.0.113.1', true],
    [[row('203.0.113.1')], '203.0.113.2', false],
    [[row('192.168.1.0/24')], '192.168.1.200', true],
    [[row('192.168.1.0/24')], '192.168.2.1', false],
    [[row('192.168.1.0/24')], 'invalid', false],
    [[row('invalid/24')], '192.168.1.1', false],
    [[row('192.168.1.0/24')], '2001:db8::1', false],
    [[row('2001:db8::/32')], '2001:db8:abcd::1', true],
    [[row('2001:db8::/33')], '2001:db8:8000::1', false],
    [[row('2001:db8::/32')], '2001:db9::1', false],
    [[row('2001:db8::/32')], 'not-ipv6', false],
    [[row('2001:db8::bad::/32')], '2001:db8::1', false],
    [[row('2001:db8:0:0:0:0:0:0/64')], '2001:db8:0:0:1:0:0:0', true],
    [[row('2001:db8:0:0:0:0:0/64')], '2001:db8::1', false],
  ])('evaluates allowlist %# for %s', async (rows, ip, allowed) => {
    await expect(
      new AdminIpAllowlistRepository(adapter(rows)).isIpAllowed('tenant-a', ip)
    ).resolves.toBe(allowed);
  });

  it('maps list rows and preserves tenant-scoped query parameters', async () => {
    const db = adapter([row('192.0.2.1'), row('2001:db8::1', { id: 'entry-2', enabled: 0 })]);
    const repository = new AdminIpAllowlistRepository(db);
    await expect(repository.getEnabledEntries('tenant-a')).resolves.toEqual([
      expect.objectContaining({ id: 'entry-1', enabled: true }),
      expect.objectContaining({ id: 'entry-2', enabled: false }),
    ]);
    await repository.getAllEntries('tenant-a');
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('tenant_id = ?'), ['tenant-a']);
  });

  it('reports existence, counts, deletion, and enable/disable outcomes', async () => {
    const db = adapter();
    vi.mocked(db.queryOne)
      .mockResolvedValueOnce({ id: 'entry-1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce(null);
    vi.mocked(db.execute)
      .mockResolvedValueOnce({ success: true, rowsAffected: 2 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 1 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 0 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 1 });
    const repository = new AdminIpAllowlistRepository(db);
    await expect(repository.entryExists('tenant-a', '192.0.2.1')).resolves.toBe(true);
    await expect(repository.entryExists('tenant-a', '192.0.2.2')).resolves.toBe(false);
    await expect(repository.countEntries('tenant-a')).resolves.toBe(2);
    await expect(repository.countEntries('tenant-b')).resolves.toBe(0);
    await expect(repository.deleteAllByTenant('tenant-a')).resolves.toBe(2);
    await expect(repository.enableEntry('entry-1')).resolves.toBe(true);
    await expect(repository.disableEntry('missing')).resolves.toBe(false);
    await expect(repository.deleteEntry('entry-1')).resolves.toBe(true);
  });
});
