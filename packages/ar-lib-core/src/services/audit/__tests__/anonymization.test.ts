import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../../db';
import { AnonymizationService } from '../anonymization';

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

describe('AnonymizationService', () => {
  it('returns an existing anonymized ID without inserting', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.queryOne).mockResolvedValueOnce({ anonymized_user_id: 'anon-existing' });

    const service = new AnonymizationService(adapter);
    const result = await service.getAnonymizedUserId('tenant-1', 'user-1');

    expect(result).toBe('anon-existing');
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('treats UNIQUE constraint errors as expected insert races', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.queryOne)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ anonymized_user_id: 'anon-raced' });
    vi.mocked(adapter.execute).mockRejectedValueOnce(new Error('UNIQUE constraint failed'));

    const service = new AnonymizationService(adapter);
    const result = await service.getAnonymizedUserId('tenant-1', 'user-2');

    expect(result).toBe('anon-raced');
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user_anonymization_map'),
      expect.arrayContaining(['tenant-1', 'user-2'])
    );
  });
});
