import { describe, expect, it, vi } from 'vitest';
import { SqlLoggingDlqItemStore } from '../dlq-store';

describe('SqlLoggingDlqItemStore', () => {
  it('inserts DLQ metadata rows for replay payloads', async () => {
    const executor = {
      execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
    };
    const store = new SqlLoggingDlqItemStore(executor);

    const record = await store.insertItem({
      tenantKey: 'tk_abc',
      payloadType: 'audit_queue_message',
      schemaVersion: 1,
      lane: 'critical',
      payloadObjectRef: 'dlq/tenant_key=tk_abc/yyyy=2026/mm=05/dd=19/dlq_1.json',
      errorClass: 'audit_message_failed_permanently',
      attemptCount: 5,
      now: 1_700_000_000_000,
    });

    expect(record.id).toMatch(/^dlq_/);
    expect(record.status).toBe('open');
    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_dlq_items'),
      expect.arrayContaining([
        'tk_abc',
        'audit_queue_message',
        1,
        'critical',
        null,
        'dlq/tenant_key=tk_abc/yyyy=2026/mm=05/dd=19/dlq_1.json',
        'audit_message_failed_permanently',
        5,
        'open',
      ])
    );
  });
});
