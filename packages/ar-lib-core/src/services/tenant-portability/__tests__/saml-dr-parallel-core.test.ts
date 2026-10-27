import { describe, expect, it, vi } from 'vitest';
import { runSamlDrCoveredOperation } from '../saml-dr-writer';
import { retryD1Batch } from '../../../utils/d1-retry';
import { cleanupExpiredDirectoryAuthMaintenance } from '../../directory-auth';
import type { DatabaseAdapter } from '../../../db/adapter';

function fixture() {
  const complete = vi.fn(async () => undefined);
  let finish!: () => void;
  const delayed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    complete,
    delayed,
    finish,
    env: {
      ENABLE_SAML_DR_EXPORT: 'true',
      SAML_DR_MUTATION_CONTROL: {
        acquireEnvironmentBackupMutationPermit: vi.fn(async () => ({ admitted: true })),
        completeEnvironmentBackupMutationPermit: complete,
      },
    },
  };
}

describe('parallel shared source writes retain admission after early failure', () => {
  it('waits for all D1 statements even when the batch retry utility returns an exhausted failure', async () => {
    const f = fixture();
    const failed = {
      run: vi.fn(async () => {
        throw new Error('local_write_failed');
      }),
    };
    const sibling = {
      run: vi.fn(async () => {
        await f.delayed;
        return { success: true };
      }),
    };
    const pending = runSamlDrCoveredOperation(f.env, undefined, () =>
      retryD1Batch([failed, sibling] as unknown as D1PreparedStatement[], 'synthetic-batch', {
        maxRetries: 0,
      })
    );
    const result = expect(pending).resolves.toBeNull();
    await vi.waitFor(() => expect(sibling.run).toHaveBeenCalledOnce());
    expect(f.complete).not.toHaveBeenCalled();
    f.finish();
    await result;
    expect(f.complete).toHaveBeenCalledOnce();
  });
  it('preserves a successful retry while waiting for writes left by the failed attempt', async () => {
    const f = fixture();
    const failed = {
      run: vi
        .fn()
        .mockRejectedValueOnce(new Error('transient_write_failed'))
        .mockResolvedValue({ success: true }),
    };
    const sibling = {
      run: vi
        .fn()
        .mockImplementationOnce(async () => {
          await f.delayed;
          return { success: true };
        })
        .mockResolvedValue({ success: true }),
    };
    const pending = runSamlDrCoveredOperation(f.env, undefined, () =>
      retryD1Batch([failed, sibling] as unknown as D1PreparedStatement[], 'synthetic-retry', {
        maxRetries: 1,
        initialDelayMs: 1,
      })
    );
    const result = expect(pending).resolves.toEqual([{ success: true }, { success: true }]);
    await vi.waitFor(() => expect(sibling.run).toHaveBeenCalledTimes(2));
    expect(f.complete).not.toHaveBeenCalled();
    f.finish();
    await result;
    expect(f.complete).toHaveBeenCalledOnce();
  });
  it('waits for delayed directory-auth maintenance writes after another table update rejects', async () => {
    const f = fixture();
    const execute = vi.fn(async (sql: string) => {
      if (sql.includes('directory_auth_migration_transactions'))
        throw new Error('maintenance_failed');
      if (sql.includes('directory_auth_evidence_exports')) await f.delayed;
      return { success: true, rowsAffected: 1 };
    });
    const pending = runSamlDrCoveredOperation(f.env, undefined, () =>
      cleanupExpiredDirectoryAuthMaintenance(
        { execute } as unknown as DatabaseAdapter,
        'tenant-a',
        100
      )
    );
    const result = expect(pending).rejects.toThrow('maintenance_failed');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    expect(f.complete).not.toHaveBeenCalled();
    f.finish();
    await result;
    expect(f.complete).toHaveBeenCalledOnce();
  });
});
