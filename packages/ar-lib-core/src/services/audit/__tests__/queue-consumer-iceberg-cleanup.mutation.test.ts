import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupExpiredGlobalEventLogs,
  cleanupExpiredGlobalPIILogs,
  cleanupExpiredTenantEventLogs,
  cleanupExpiredTenantPIILogs,
  processLoggingDeliveryQueue,
  type AuditQueueConsumerEnv,
} from '../queue-consumer';
import { consumeLogIcebergMessage } from '../../log-iceberg-runtime';
import {
  createFakeAdminDb,
  createFakeLogger,
  createMessage,
} from './queue-consumer-mutation-helpers';

vi.mock('../../log-iceberg-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../log-iceberg-runtime')>()),
  consumeLogIcebergMessage: vi.fn(),
}));

const consumeMock = vi.mocked(consumeLogIcebergMessage);

function createControl() {
  return {
    acquireTenantBackupMutationPermit: vi.fn().mockResolvedValue({ admitted: true }),
    completeTenantBackupMutationPermit: vi.fn().mockResolvedValue(undefined),
    acquireEnvironmentBackupMutationPermit: vi.fn().mockResolvedValue({ admitted: true }),
    completeEnvironmentBackupMutationPermit: vi.fn().mockResolvedValue(undefined),
  };
}

describe('logging delivery queue: iceberg_ingest', () => {
  beforeEach(() => {
    consumeMock.mockReset();
  });

  async function runIceberg(options: { control?: ReturnType<typeof createControl> | null } = {}) {
    const body = { payload_type: 'iceberg_ingest', outbox_id: 'ob_1' };
    const message = createMessage(body, { attempts: 2 });
    const logger = createFakeLogger();
    const control = options.control === undefined ? createControl() : options.control;
    const env = {
      DB: {},
      DB_PII: {},
      ...(control ? { CONTROL: control } : {}),
    } as unknown as AuditQueueConsumerEnv;
    await processLoggingDeliveryQueue(
      { messages: [message] } as unknown as MessageBatch<unknown>,
      env,
      logger
    );
    return { body, message, logger, control, env };
  }

  it('consumes the message under an environment backup permit and acks it', async () => {
    consumeMock.mockResolvedValue(undefined as never);
    const { body, message, control, env } = await runIceberg();

    expect(consumeMock).toHaveBeenCalledOnce();
    expect(consumeMock.mock.calls[0]?.[0]).toBe(body);
    expect(consumeMock.mock.calls[0]?.[1]).toBe(env);
    expect(consumeMock.mock.calls[0]?.[1]).not.toHaveProperty('TENANT_BACKUP_WRAPPING_KEY');
    expect(control?.acquireEnvironmentBackupMutationPermit).toHaveBeenCalledOnce();
    expect(control?.completeEnvironmentBackupMutationPermit).toHaveBeenCalledOnce();
    expect(control?.acquireTenantBackupMutationPermit).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('releases the permit and retries when ingestion fails', async () => {
    consumeMock.mockRejectedValue(new Error('iceberg unavailable'));
    const { message, logger, control } = await runIceberg();
    expect(control?.completeEnvironmentBackupMutationPermit).toHaveBeenCalledOnce();
    expect(message.retry).toHaveBeenCalledExactlyOnceWith();
    expect(message.ack).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('logging_delivery_queue_message_failed', {
      messageId: message.id,
      attempts: 2,
      error: 'Error: iceberg unavailable',
    });
  });

  it('fails closed without a control admission facade', async () => {
    const { message, logger } = await runIceberg({ control: null });
    expect(consumeMock).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'logging_delivery_queue_message_failed',
      expect.objectContaining({
        error: 'TenantBackupMutationUnavailableError: backup_mutation_unavailable',
      })
    );
  });

  it('retries without consuming when the permit is refused', async () => {
    const control = createControl();
    control.acquireEnvironmentBackupMutationPermit.mockResolvedValue({ admitted: false });
    const { message } = await runIceberg({ control });
    expect(consumeMock).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
  });

  it('does not treat other payload types as iceberg ingests', async () => {
    const message = createMessage({ payload_type: 'something_else' });
    await processLoggingDeliveryQueue(
      { messages: [message] } as unknown as MessageBatch<unknown>,
      { DB: {}, DB_PII: {} } as unknown as AuditQueueConsumerEnv,
      createFakeLogger()
    );
    expect(consumeMock).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
  });
});

describe('retention cleanup', () => {
  const NOW = new Date('2026-07-08T09:10:11.000Z');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function db(rowsAffected = 7) {
    return createFakeAdminDb({ executeResult: () => ({ rowsAffected }) });
  }

  it('deletes expired tenant event logs with the default batch size', async () => {
    const adapter = db(3);
    await expect(cleanupExpiredTenantEventLogs(adapter, '  tenant-1  ')).resolves.toBe(3);
    expect(adapter.execute).toHaveBeenCalledExactlyOnceWith(
      'DELETE FROM event_log WHERE retention_until < ? AND tenant_id = ? LIMIT ?',
      [NOW.getTime(), 'tenant-1', 1000]
    );
  });

  it('honours a custom batch size for tenant event logs', async () => {
    const adapter = db();
    await cleanupExpiredTenantEventLogs(adapter, 'tenant-1', 25);
    expect(adapter.execute.mock.calls[0]?.[1]).toEqual([NOW.getTime(), 'tenant-1', 25]);
  });

  it.each(['', '   ', '\n\t'])('rejects blank tenant ids %j for event logs', async (tenantId) => {
    const adapter = db();
    await expect(cleanupExpiredTenantEventLogs(adapter, tenantId)).rejects.toThrow(
      'cleanupExpiredTenantEventLogs requires tenantId'
    );
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('deletes expired global event logs', async () => {
    const adapter = db(11);
    await expect(cleanupExpiredGlobalEventLogs(adapter)).resolves.toBe(11);
    expect(adapter.execute).toHaveBeenCalledExactlyOnceWith(
      'DELETE FROM event_log WHERE retention_until < ? LIMIT ?',
      [NOW.getTime(), 1000]
    );
    await cleanupExpiredGlobalEventLogs(adapter, 5);
    expect(adapter.execute.mock.calls[1]?.[1]).toEqual([NOW.getTime(), 5]);
  });

  it('deletes expired tenant PII logs with the default batch size', async () => {
    const adapter = db(4);
    await expect(cleanupExpiredTenantPIILogs(adapter, ' tenant-2 ')).resolves.toBe(4);
    expect(adapter.execute).toHaveBeenCalledExactlyOnceWith(
      'DELETE FROM pii_log WHERE retention_until < ? AND tenant_id = ? LIMIT ?',
      [NOW.getTime(), 'tenant-2', 1000]
    );
    await cleanupExpiredTenantPIILogs(adapter, 'tenant-2', 9);
    expect(adapter.execute.mock.calls[1]?.[1]).toEqual([NOW.getTime(), 'tenant-2', 9]);
  });

  it.each(['', '  '])('rejects blank tenant ids %j for PII logs', async (tenantId) => {
    const adapter = db();
    await expect(cleanupExpiredTenantPIILogs(adapter, tenantId)).rejects.toThrow(
      'cleanupExpiredTenantPIILogs requires tenantId'
    );
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('deletes expired global PII logs', async () => {
    const adapter = db(2);
    await expect(cleanupExpiredGlobalPIILogs(adapter)).resolves.toBe(2);
    expect(adapter.execute).toHaveBeenCalledExactlyOnceWith(
      'DELETE FROM pii_log WHERE retention_until < ? LIMIT ?',
      [NOW.getTime(), 1000]
    );
    await cleanupExpiredGlobalPIILogs(adapter, 3);
    expect(adapter.execute.mock.calls[1]?.[1]).toEqual([NOW.getTime(), 3]);
  });
});
