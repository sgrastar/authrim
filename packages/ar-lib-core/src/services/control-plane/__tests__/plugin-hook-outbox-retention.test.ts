import type { DatabaseAdapter, ExecuteResult, PreparedStatement } from '../../../db/adapter';
import { describe, expect, it, vi } from 'vitest';
import {
  cleanupExpiredPluginHookOutbox,
  PLUGIN_HOOK_DEAD_LETTER_RETENTION_SECONDS,
  PLUGIN_HOOK_SUCCEEDED_RETENTION_SECONDS,
} from '../plugin-hook-outbox-retention';

function adapterWithCandidates(
  candidates: unknown[],
  results: ExecuteResult[] = candidates.map(() => ({ success: true, rowsAffected: 1 }))
): {
  adapter: DatabaseAdapter;
  query: ReturnType<typeof vi.fn>;
  batch: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async () => candidates);
  const batch = vi.fn(async (_statements: PreparedStatement[]) => results);
  return {
    adapter: { query, batch } as unknown as DatabaseAdapter,
    query,
    batch,
  };
}

describe('plugin hook outbox retention cleanup', () => {
  it('fixes the v1 retention periods at seven and ninety days', () => {
    expect(PLUGIN_HOOK_SUCCEEDED_RETENTION_SECONDS).toBe(604_800);
    expect(PLUGIN_HOOK_DEAD_LETTER_RETENTION_SECONDS).toBe(7_776_000);
  });

  it('deletes only bounded expired terminal candidates with guarded statements', async () => {
    const { adapter, query, batch } = adapterWithCandidates([
      { outbox_id: 'succeeded-1', status: 'succeeded', delete_after: 90 },
      { outbox_id: 'dead-1', status: 'dead_letter', delete_after: 100 },
    ]);

    await expect(cleanupExpiredPluginHookOutbox(adapter, { now: 100, limit: 25 })).resolves.toEqual(
      {
        scanned: 2,
        deleted: 2,
        succeededDeleted: 1,
        deadLetterDeleted: 1,
      }
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("status IN ('succeeded', 'dead_letter')"),
      [100, 25]
    );
    const statements = batch.mock.calls[0]?.[0] as PreparedStatement[];
    expect(statements).toEqual([
      expect.objectContaining({ params: ['succeeded-1', 'succeeded', 100] }),
      expect.objectContaining({ params: ['dead-1', 'dead_letter', 100] }),
    ]);
    expect(statements[0]?.sql).toContain('delete_after IS NOT NULL AND delete_after <= ?');
  });

  it('tolerates a concurrent terminal-row removal without overcounting', async () => {
    const { adapter } = adapterWithCandidates(
      [
        { outbox_id: 'succeeded-1', status: 'succeeded', delete_after: 90 },
        { outbox_id: 'dead-1', status: 'dead_letter', delete_after: 100 },
      ],
      [
        { success: true, rowsAffected: 0 },
        { success: true, rowsAffected: 1 },
      ]
    );

    await expect(cleanupExpiredPluginHookOutbox(adapter, { now: 100 })).resolves.toEqual({
      scanned: 2,
      deleted: 1,
      succeededDeleted: 0,
      deadLetterDeleted: 1,
    });
  });

  it('rejects malformed candidates and limits before issuing deletes', async () => {
    const malformed = adapterWithCandidates([
      { outbox_id: 'outbox-1', status: 'queued', delete_after: 100 },
    ]);
    await expect(cleanupExpiredPluginHookOutbox(malformed.adapter, { now: 100 })).rejects.toThrow(
      'plugin_outbox_retention_candidate_invalid'
    );
    expect(malformed.batch).not.toHaveBeenCalled();

    const empty = adapterWithCandidates([]);
    await expect(
      cleanupExpiredPluginHookOutbox(empty.adapter, { now: 100, limit: 1001 })
    ).rejects.toThrow('plugin_outbox_retention_limit_invalid');
    expect(empty.query).not.toHaveBeenCalled();
  });

  it('fails closed on incomplete or malformed batch results', async () => {
    const candidate = { outbox_id: 'outbox-1', status: 'succeeded', delete_after: 100 };
    await expect(
      cleanupExpiredPluginHookOutbox(adapterWithCandidates([candidate], []).adapter, { now: 100 })
    ).rejects.toThrow('plugin_outbox_retention_batch_incomplete');
    await expect(
      cleanupExpiredPluginHookOutbox(
        adapterWithCandidates([candidate], [{ success: true, rowsAffected: 2 }]).adapter,
        { now: 100 }
      )
    ).rejects.toThrow('plugin_outbox_retention_delete_result_invalid');
  });
});
