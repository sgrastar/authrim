import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEventDispatcher } from '../event-dispatcher';
import { logProducerFixture } from './log-iceberg-producer-fixture';
vi.mock('@authrim/ar-lib-logging/iceberg/capabilities', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-logging/iceberg/capabilities')>()),
  LOG_ARCHIVE_IMPLEMENTED_MODES: ['scheduled', 'pipeline'],
}));
const opened: Array<Awaited<ReturnType<typeof logProducerFixture>>> = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const f of opened.splice(0)) {
    f.db.close();
  }
});
for (const mode of ['scheduled', 'pipeline'] as const)
  describe(`${mode} webhook dispatcher runtime logging`, () => {
    it('archives redacted delivery metadata through the new mode without including the business payload or secrets', async () => {
      const tenantId = 'tenant-a',
        f = await logProducerFixture(mode);
      opened.push(f);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(null, { status: 204 }))
      );
      const dispatcher = createEventDispatcher({
        adapter: f.adapter,
        kv: { get: vi.fn(async () => null), put: vi.fn(async () => {}) } as unknown as KVNamespace,
        webhookRegistry: {
          findByEventType: vi.fn(async () => [
            {
              id: 'webhook-a',
              tenantId,
              url: 'https://receiver.example/hooks?token=secret',
              secretEncrypted: 'encrypted-secret',
              timeoutMs: 10000,
              events: ['user.*'],
              active: true,
            },
          ]),
          recordSuccess: vi.fn(async () => {}),
          recordFailure: vi.fn(async () => {}),
        } as never,
        handlerRegistry: { getHandlers: vi.fn(() => []) } as never,
        hookRegistry: { getBeforeHooks: vi.fn(() => []), getAfterHooks: vi.fn(() => []) } as never,
        decryptSecret: vi.fn(async () => 'decrypted-secret'),
        runtimeLogging: { env: f.env, tenantKeyResolver: async () => 'key-a' },
      });
      const result = await dispatcher.publish(
        {
          type: 'account.created',
          tenantId,
          data: { userId: 'user-a', secretValue: 'must-not-log' },
        },
        { skipAuditLog: true }
      );
      expect(result.success).toBe(true);
      const rows = await f.rows('runtime.webhook_delivery_events');
      expect(rows).toHaveLength(1);
      const body = JSON.stringify(rows);
      expect(body).toContain('webhook_delivery');
      expect(body).toContain('receiver.example');
      for (const secret of ['must-not-log', 'decrypted-secret', 'token=secret', 'encrypted-secret'])
        expect(body).not.toContain(secret);
      expect(f.db.prepare('SELECT COUNT(*) n FROM log_iceberg_records').get()?.n).toBe(
        mode === 'scheduled' ? 1 : 0
      );
      if (mode === 'pipeline')
        expect(f.queueMessages).toMatchObject([
          { payload_type: 'iceberg_ingest', source_dataset: 'runtime.webhook_delivery_events' },
        ]);
      expect(f.db.prepare('SELECT COUNT(*) n FROM log_chunk_record_index').get()?.n).toBe(0);
    });
  });
