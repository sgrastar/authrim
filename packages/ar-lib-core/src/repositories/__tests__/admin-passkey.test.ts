import { describe, expect, it, vi } from 'vitest';
import { AdminPasskeyRepository } from '../admin/admin-passkey';
import type { DatabaseAdapter, ExecuteResult, TransactionContext } from '../../db/adapter';

function createAdapter(rowsAffected: number): DatabaseAdapter & {
  execute: ReturnType<typeof vi.fn>;
} {
  const executeResult: ExecuteResult = { rowsAffected, success: true };
  return {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn().mockResolvedValue(executeResult),
    transaction: vi.fn(async <T>(fn: (tx: TransactionContext) => Promise<T>) =>
      fn({ query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() })
    ),
    batch: vi.fn(),
    healthCheck: vi.fn(),
  } as unknown as DatabaseAdapter & { execute: ReturnType<typeof vi.fn> };
}

describe('AdminPasskeyRepository', () => {
  it('deletes a passkey with an atomic last-key guard', async () => {
    const adapter = createAdapter(1);
    const repository = new AdminPasskeyRepository(adapter);

    await expect(
      repository.deletePasskeyIfUserHasAnother('passkey-a', 'admin-user-a')
    ).resolves.toBe(true);

    expect(adapter.execute).toHaveBeenCalledWith(expect.stringContaining('EXISTS'), [
      'passkey-a',
      'admin-user-a',
      'admin-user-a',
      'passkey-a',
    ]);
    expect(adapter.execute.mock.calls[0][0]).toContain('id <> ?');
  });

  it('returns false when the conditional delete affects no rows', async () => {
    const adapter = createAdapter(0);
    const repository = new AdminPasskeyRepository(adapter);

    await expect(
      repository.deletePasskeyIfUserHasAnother('passkey-a', 'admin-user-a')
    ).resolves.toBe(false);
  });
});
