import type { MessageBatch } from '@cloudflare/workers-types';
import type { Env } from '@authrim/ar-lib-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

const processAuditQueueMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const processLoggingDeliveryQueueMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    processAuditQueue: processAuditQueueMock,
    processLoggingDeliveryQueue: processLoggingDeliveryQueueMock,
  };
});

import worker from '../index';

describe('ar-management queue routing', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('routes logging delivery queue batches to the logging delivery consumer', async () => {
    const batch = {
      queue: 'portable-logging-delivery-queue',
      messages: [],
    } as unknown as MessageBatch<unknown>;

    await worker.queue(batch, {} as Env);

    expect(processLoggingDeliveryQueueMock).toHaveBeenCalledWith(
      batch,
      expect.anything(),
      expect.anything()
    );
    expect(processAuditQueueMock).not.toHaveBeenCalled();
  });

  it('routes logging delivery binding-name batches to the logging delivery consumer in tests', async () => {
    const batch = {
      queue: 'LOGGING_DELIVERY_CRITICAL_QUEUE',
      messages: [],
    } as unknown as MessageBatch<unknown>;

    await worker.queue(batch, {} as Env);

    expect(processLoggingDeliveryQueueMock).toHaveBeenCalledWith(
      batch,
      expect.anything(),
      expect.anything()
    );
    expect(processAuditQueueMock).not.toHaveBeenCalled();
  });

  it('routes custom configured logging delivery queue names to the logging delivery consumer', async () => {
    const batch = {
      queue: 'custom-critical-queue',
      messages: [],
    } as unknown as MessageBatch<unknown>;

    await worker.queue(batch, {
      LOGGING_DELIVERY_QUEUE_NAMES: 'custom-critical-queue,custom-default-queue',
    } as unknown as Env);

    expect(processLoggingDeliveryQueueMock).toHaveBeenCalledWith(
      batch,
      expect.anything(),
      expect.anything()
    );
    expect(processAuditQueueMock).not.toHaveBeenCalled();
  });

  it('routes non-logging queue batches to the audit queue consumer', async () => {
    const batch = {
      queue: 'AUDIT_QUEUE',
      messages: [],
    } as unknown as MessageBatch<unknown>;

    await worker.queue(batch, {} as Env);

    expect(processAuditQueueMock).toHaveBeenCalledWith(batch, expect.anything(), expect.anything());
    expect(processLoggingDeliveryQueueMock).not.toHaveBeenCalled();
  });
});
