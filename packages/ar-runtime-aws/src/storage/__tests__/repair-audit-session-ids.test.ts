import { describe, expect, it, vi } from 'vitest';
import {
  countLegacyAuditSessionIds,
  repairLegacyAuditSessionIds,
} from '../repair-audit-session-ids';

describe('legacy AWS session audit repair', () => {
  it('counts without exposing credentials and updates in bounded, repeatable batches', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ count: '3' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
    const db = { query };
    expect(await countLegacyAuditSessionIds(db)).toBe(3);
    expect(await repairLegacyAuditSessionIds(db, 2)).toEqual({ updated: 3, remaining: 0 });
    expect(query).toHaveBeenCalledTimes(5);
    for (const call of query.mock.calls.slice(1, 4)) {
      const [sql, values] = call as [string, unknown[]];
      expect(sql).toContain("payload->>'resource' = 'session'");
      expect(sql).toContain('jsonb_set(');
      expect(sql).toContain("decode('00', 'hex')");
      expect(values).toEqual([2]);
    }
  });

  it('rejects an invalid batch size before writing', async () => {
    const query = vi.fn();
    await expect(repairLegacyAuditSessionIds({ query }, 0)).rejects.toThrow(
      'aws_audit_repair_batch_size_invalid'
    );
    expect(query).not.toHaveBeenCalled();
  });
});
