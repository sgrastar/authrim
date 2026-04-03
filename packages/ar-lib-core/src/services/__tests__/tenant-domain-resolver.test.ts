import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveTenantCandidatesFromEmailDomain,
  resolveTenantFromEmailDomain,
} from '../tenant-domain-resolver';

vi.mock('../../utils/email-domain-hash', () => ({
  getEmailDomainHashConfig: vi.fn(async () => ({ version: 1, secret: 'test-secret' })),
  generateEmailDomainHashWithVersion: vi.fn(async () => ({ hash: 'hashed-domain', version: 1 })),
}));

describe('tenant-domain-resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns all active candidates in priority order', async () => {
    const all = vi.fn(async () => ({
      results: [
        { tenant_id: 'acme', priority: 20 },
        { tenant_id: 'beta', priority: 10 },
      ],
    }));
    const bind = vi.fn(() => ({ all }));
    const prepare = vi.fn(() => ({ bind }));
    const db = { prepare } as unknown as D1Database;

    const result = await resolveTenantCandidatesFromEmailDomain(
      db,
      'user@example.com',
      {} as never
    );

    expect(result).toEqual([
      { tenant_id: 'acme', priority: 20 },
      { tenant_id: 'beta', priority: 10 },
    ]);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('returns the highest-priority tenant for the single-result helper', async () => {
    const all = vi.fn(async () => ({
      results: [
        { tenant_id: 'acme', priority: 20 },
        { tenant_id: 'beta', priority: 10 },
      ],
    }));
    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({ all })),
      })),
    } as unknown as D1Database;

    const result = await resolveTenantFromEmailDomain(db, 'user@example.com', {} as never);

    expect(result).toBe('acme');
  });

  it('fails open to an empty result on resolver errors', async () => {
    const db = {
      prepare: vi.fn(() => {
        throw new Error('db failed');
      }),
    } as unknown as D1Database;

    await expect(
      resolveTenantCandidatesFromEmailDomain(db, 'user@example.com', {} as never)
    ).resolves.toEqual([]);
    await expect(
      resolveTenantFromEmailDomain(db, 'user@example.com', {} as never)
    ).resolves.toBeNull();
  });
});
