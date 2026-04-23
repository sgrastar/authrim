import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db';
import {
  resolveTenantCandidatesFromEmailDomain,
  resolveTenantFromEmailDomain,
} from '../tenant-domain-resolver';

vi.mock('../../utils/email-domain-hash', () => ({
  getEmailDomainHashConfig: vi.fn(async () => ({ version: 1, secret: 'test-secret' })),
  generateEmailDomainHashWithVersion: vi.fn(async () => ({ hash: 'hashed-domain', version: 1 })),
}));

describe('tenant-domain-resolver', () => {
  function createMockAdapter(): DatabaseAdapter {
    return {
      query: vi.fn(),
      queryOne: vi.fn(),
      execute: vi.fn(),
      transaction: vi.fn(),
      batch: vi.fn(),
      isHealthy: vi.fn(),
      getType: vi.fn().mockReturnValue('mock'),
      close: vi.fn(),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns all active candidates in priority order', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.query).mockResolvedValueOnce([
        { tenant_id: 'acme', priority: 20 },
        { tenant_id: 'beta', priority: 10 },
    ]);

    const result = await resolveTenantCandidatesFromEmailDomain(
      adapter,
      'user@example.com',
      {} as never
    );

    expect(result).toEqual([
      { tenant_id: 'acme', priority: 20 },
      { tenant_id: 'beta', priority: 10 },
    ]);
    expect(adapter.query).toHaveBeenCalledOnce();
  });

  it('returns the highest-priority tenant for the single-result helper', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.query).mockResolvedValueOnce([
        { tenant_id: 'acme', priority: 20 },
        { tenant_id: 'beta', priority: 10 },
    ]);

    const result = await resolveTenantFromEmailDomain(adapter, 'user@example.com', {} as never);

    expect(result).toBe('acme');
  });

  it('fails open to an empty result on resolver errors', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.query).mockRejectedValue(new Error('db failed'));

    await expect(
      resolveTenantCandidatesFromEmailDomain(adapter, 'user@example.com', {} as never)
    ).resolves.toEqual([]);
    await expect(
      resolveTenantFromEmailDomain(adapter, 'user@example.com', {} as never)
    ).resolves.toBeNull();
  });
});
