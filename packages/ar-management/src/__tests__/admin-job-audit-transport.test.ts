import { afterEach, describe, expect, it, vi } from 'vitest';
import { logProducerFixture } from '../../../../test/helpers/log-iceberg-producer-fixture.mjs';
import { writeTenantLifecycleJobAudit } from '../admin-job-executor';
import { runLogIcebergDelivery } from '@authrim/ar-lib-core/services/log-iceberg-delivery';
import type { Env } from '@authrim/ar-lib-core';
const dispose: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  dispose.splice(0).forEach((close) => close());
});
const job = {
  id: 'job-lifecycle',
  tenant_id: 'tenant-a',
  config: JSON.stringify({ actor_id: 'admin-a' }),
} as Parameters<typeof writeTenantLifecycleJobAudit>[1];
const audit = {
  action: 'tenant.lifecycle.validation_completed',
  result: 'success' as const,
  severity: 'info' as const,
  metadata: { source_state: 'frozen', target_state: 'active' },
};
async function fixture(mode: 'scheduled' | 'pipeline') {
  const f = await logProducerFixture(mode, { separateAdmin: true });
  dispose.push(f.close);
  return f;
}
describe.each(['scheduled', 'pipeline'] as const)(
  'tenant lifecycle audit durability (%s)',
  (mode) => {
    it('keeps a committed audit and lets the scanner recover a failed queue send', async () => {
      const f = await fixture(mode);
      const send = vi
        .spyOn(f.env.LOGGING_DELIVERY_QUEUE!, 'send')
        .mockRejectedValueOnce(new Error('queue unavailable'));
      await expect(
        writeTenantLifecycleJobAudit(f.env as unknown as Env, job, audit)
      ).resolves.toBeUndefined();
      expect(await f.rows('admin.admin_audit_log')).toHaveLength(1);
      expect(f.adminDb.prepare('SELECT count(*) n FROM admin_audit_receipts').get()?.n).toBe(1);
      expect(f.adminDb.prepare('SELECT count(*) n FROM admin_audit_log').get()?.n).toBe(0);
      if (mode === 'pipeline') {
        expect(send).toHaveBeenCalledOnce();
        expect(f.queueMessages).toHaveLength(0);
        await expect(runLogIcebergDelivery(f.env)).resolves.toMatchObject({ queued: 1, failed: 0 });
        expect(f.queueMessages).toHaveLength(1);
        expect(f.adminDb.prepare('SELECT count(*) n FROM log_iceberg_records').get()?.n).toBe(0);
      } else {
        expect(send).not.toHaveBeenCalled();
        expect(f.objects.size).toBe(0);
      }
    });
    it('fails closed if the Admin commit failed and no exact receipt survived', async () => {
      const f = await fixture(mode),
        batch = f.adminAdapter.batch.bind(f.adminAdapter);
      vi.spyOn(f.adminAdapter, 'batch').mockImplementation(async (statements) => {
        if (
          statements.some((statement) => statement.sql.includes('INSERT INTO admin_audit_receipts'))
        )
          throw new Error('audit DB commit unavailable');
        return batch(statements);
      });
      await expect(
        writeTenantLifecycleJobAudit(f.env as unknown as Env, job, audit)
      ).rejects.toThrow('audit DB commit unavailable');
      expect(await f.rows('admin.admin_audit_log')).toHaveLength(0);
      expect(f.adminDb.prepare('SELECT count(*) n FROM admin_audit_receipts').get()?.n).toBe(0);
      expect(f.queueMessages).toHaveLength(0);
    });
    it('recovers a lost batch acknowledgement only after the exact durable receipt is read', async () => {
      const f = await fixture(mode),
        batch = f.adminAdapter.batch.bind(f.adminAdapter);
      let lost = false;
      vi.spyOn(f.adminAdapter, 'batch').mockImplementation(async (statements) => {
        const result = await batch(statements);
        if (
          !lost &&
          statements.some((statement) => statement.sql.includes('INSERT INTO admin_audit_receipts'))
        ) {
          lost = true;
          throw new Error('commit acknowledgement lost');
        }
        return result;
      });
      await expect(
        writeTenantLifecycleJobAudit(f.env as unknown as Env, job, audit)
      ).resolves.toBeUndefined();
      expect(lost).toBe(true);
      expect(await f.rows('admin.admin_audit_log')).toHaveLength(1);
      expect(f.adminDb.prepare('SELECT count(*) n FROM admin_audit_receipts').get()?.n).toBe(1);
    });
  }
);
