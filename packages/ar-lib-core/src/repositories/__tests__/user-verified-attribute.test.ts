import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db';
import { UserVerifiedAttributeRepository } from '../vc/user-verified-attribute';

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

describe('UserVerifiedAttributeRepository', () => {
  it('updates an existing attribute without relying on ON CONFLICT', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.queryOne).mockResolvedValueOnce({
      id: 'attr-existing',
      created_at: 100,
    });
    vi.mocked(adapter.execute).mockResolvedValue({ success: true, rowsAffected: 1 });

    const repository = new UserVerifiedAttributeRepository(adapter);
    const result = await repository.upsertAttribute({
      tenant_id: 'tenant-1',
      user_id: 'user-1',
      attribute_name: 'department',
      attribute_value: 'engineering',
      source_type: 'manual',
    });

    expect(result.id).toBe('attr-existing');
    expect(adapter.execute).toHaveBeenCalledTimes(1);
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE user_verified_attributes'),
      expect.arrayContaining(['engineering', 'manual', 'attr-existing'])
    );
  });

  it('handles a unique-race by re-reading and updating the existing attribute', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.queryOne).mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'attr-raced',
      created_at: 200,
    });
    vi.mocked(adapter.execute)
      .mockRejectedValueOnce(new Error('UNIQUE constraint failed'))
      .mockResolvedValueOnce({ success: true, rowsAffected: 1 });

    const repository = new UserVerifiedAttributeRepository(adapter);
    const result = await repository.upsertAttribute({
      tenant_id: 'tenant-1',
      user_id: 'user-1',
      attribute_name: 'department',
      attribute_value: 'security',
      source_type: 'vc',
    });

    expect(result.id).toBe('attr-raced');
    expect(adapter.execute).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('INSERT INTO user_verified_attributes'),
      expect.arrayContaining(['tenant-1', 'user-1', 'department', 'security'])
    );
    expect(adapter.execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('UPDATE user_verified_attributes'),
      expect.arrayContaining(['security', 'vc', 'attr-raced'])
    );
  });
});
