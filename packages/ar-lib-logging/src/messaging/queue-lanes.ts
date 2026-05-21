import type { LoggingDeliveryLane } from '../delivery/types';
import type { LoggingMessageQueuePayload } from './queue-payload';

export type LoggingMessageQueueBindingName =
  | 'LOGGING_MESSAGE_CRITICAL_QUEUE'
  | 'LOGGING_MESSAGE_QUEUE'
  | 'LOGGING_MESSAGE_BULK_QUEUE';

export interface LoggingMessageQueueLike<TPayload = unknown> {
  send(message: TPayload): Promise<unknown>;
}

export interface LoggingMessageEnqueueResult {
  queued: boolean;
  lane: LoggingDeliveryLane;
  bindingName: LoggingMessageQueueBindingName | null;
  fallbackUsed: boolean;
  attemptedBindingNames: readonly LoggingMessageQueueBindingName[];
  payloadId: string;
  byteCount: number;
}

const MESSAGE_QUEUE_BINDINGS: Record<
  LoggingDeliveryLane,
  {
    bindingName: LoggingMessageQueueBindingName;
    fallbackBindingNames: readonly LoggingMessageQueueBindingName[];
    maxBytes: number;
  }
> = {
  critical: {
    bindingName: 'LOGGING_MESSAGE_CRITICAL_QUEUE',
    fallbackBindingNames: ['LOGGING_MESSAGE_QUEUE'],
    maxBytes: 256 * 1024,
  },
  default: {
    bindingName: 'LOGGING_MESSAGE_QUEUE',
    fallbackBindingNames: [],
    maxBytes: 512 * 1024,
  },
  bulk: {
    bindingName: 'LOGGING_MESSAGE_BULK_QUEUE',
    fallbackBindingNames: ['LOGGING_MESSAGE_QUEUE'],
    maxBytes: 1024 * 1024,
  },
};

function isQueueLike<TPayload>(value: unknown): value is LoggingMessageQueueLike<TPayload> {
  return (
    !!value && typeof value === 'object' && typeof (value as { send?: unknown }).send === 'function'
  );
}

function estimatePayloadBytes(payload: unknown): number {
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
}

export async function enqueueLoggingMessagePayload(
  payload: LoggingMessageQueuePayload,
  bindings: Record<string, unknown>
): Promise<LoggingMessageEnqueueResult> {
  const profile = MESSAGE_QUEUE_BINDINGS[payload.lane];
  const attemptedBindingNames = [profile.bindingName, ...profile.fallbackBindingNames];
  const byteCount = estimatePayloadBytes(payload);
  if (byteCount > profile.maxBytes) {
    throw new Error(`logging_message_payload_too_large:${payload.lane}`);
  }

  for (const bindingName of attemptedBindingNames) {
    const queue = bindings[bindingName];
    if (!isQueueLike<LoggingMessageQueuePayload>(queue)) {
      continue;
    }
    await queue.send(payload);
    return {
      queued: true,
      lane: payload.lane,
      bindingName,
      fallbackUsed: bindingName !== profile.bindingName,
      attemptedBindingNames,
      payloadId: payload.payload_id,
      byteCount,
    };
  }

  return {
    queued: false,
    lane: payload.lane,
    bindingName: null,
    fallbackUsed: false,
    attemptedBindingNames,
    payloadId: payload.payload_id,
    byteCount,
  };
}
