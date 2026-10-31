import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logProducerFixture } from './log-iceberg-producer-fixture';
import {
  createDirectoryAuthMigrationTransaction,
  completeDirectoryAuthEmailCodeFallback,
} from '../directory-auth';

describe.each(['scheduled', 'pipeline'] as const)(
  'directory migration log storage (%s)',
  (mode) => {
    let f: Awaited<ReturnType<typeof logProducerFixture>>;
    beforeEach(async () => {
      f = await logProducerFixture(mode);
    });
    afterEach(() => f.db.close());
    it('keeps resumable business state while sending only the events to the new backend', async () => {
      const transaction = await createDirectoryAuthMigrationTransaction(f.env, f.adapter, {
        tenantId: 'tenant-a',
        tokenHash: 'sha256:opaque',
        scope: 'email_code_fallback',
        ttlSeconds: 600,
        now: f.now,
      });
      expect(
        f.db
          .prepare('SELECT state,token_hash FROM directory_auth_migration_transactions WHERE id=?')
          .get(transaction.id)
      ).toMatchObject({ state: 'active', token_hash: 'sha256:opaque' });
      expect(
        await completeDirectoryAuthEmailCodeFallback(f.env, f.adapter, {
          tenantId: 'tenant-a',
          transactionId: transaction.id,
          userId: 'user-1',
          now: f.now + 1000,
        })
      ).toBe(true);
      expect(
        f.db
          .prepare('SELECT state,token_hash FROM directory_auth_migration_transactions WHERE id=?')
          .get(transaction.id)
      ).toMatchObject({ state: 'completed', token_hash: `completed:${transaction.id}` });
      const rows = await f.rows('core.directory_auth_migration_transaction_events');
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.event_type).sort()).toEqual([
        'created',
        'email_code_fallback.completed',
      ]);
      expect(rows.every((row) => row.transaction_id === transaction.id)).toBe(true);
      expect(
        f.db.prepare('SELECT COUNT(*) AS n FROM directory_auth_migration_transaction_events').get()
          ?.n
      ).toBe(0);
      expect(
        await completeDirectoryAuthEmailCodeFallback(f.env, f.adapter, {
          tenantId: 'tenant-a',
          transactionId: transaction.id,
          userId: 'user-1',
          now: f.now + 2000,
        })
      ).toBe(false);
      expect(await f.rows('core.directory_auth_migration_transaction_events')).toHaveLength(2);
    });
  }
);
