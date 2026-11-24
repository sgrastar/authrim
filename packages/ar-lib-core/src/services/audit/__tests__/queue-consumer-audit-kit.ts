import { vi } from 'vitest';
import {
  ROOT_KEY,
  createFakeAdminDb,
  createFakeLogger,
  createMemoryBucket,
  createMessage,
} from './queue-consumer-mutation-helpers';
import { processAuditQueue, type AuditQueueConsumerEnv } from '../queue-consumer';
import { type AuditQueueMessage } from '../types';

export const TIMESTAMP = 1779148800000;
let tenantCounter = 0;

export function nextTenant(): string {
  tenantCounter += 1;
  return `tenant-enqueue-${tenantCounter}`;
}

export function auditBody(
  tenantId: string,
  sinks: unknown[],
  overrides: Partial<AuditQueueMessage> = {},
  fanout: Record<string, unknown> = {}
): AuditQueueMessage {
  return {
    type: 'event_log',
    tenantId,
    timestamp: TIMESTAMP,
    entries: [
      {
        id: 'evt-b',
        tenantId,
        eventType: 'auth.login',
        eventCategory: 'auth',
        result: 'success',
        severity: 'info',
        createdAt: TIMESTAMP + 5,
      },
      {
        id: 'evt-a',
        tenantId,
        eventType: 'auth.logout',
        eventCategory: 'auth',
        result: 'success',
        severity: 'info',
        createdAt: TIMESTAMP + 9,
      },
    ],
    fanout: {
      auditProfileId: 'profile-enqueue',
      archives: [],
      sinks,
      archiveFailureMode: 'best_effort',
      sinkFailureMode: 'best_effort',
      ...fanout,
    },
    ...overrides,
  } as unknown as AuditQueueMessage;
}

export function createQueue() {
  return { send: vi.fn().mockResolvedValue(undefined) };
}

export async function run(
  body: AuditQueueMessage,
  env: Partial<AuditQueueConsumerEnv> & Record<string, unknown>,
  options: { attempts?: number } = {}
) {
  const message = createMessage(body, { attempts: options.attempts ?? 1 });
  const logger = createFakeLogger();
  await processAuditQueue(
    { messages: [message] } as unknown as MessageBatch<AuditQueueMessage>,
    { DB: {}, DB_PII: {}, ...env } as unknown as AuditQueueConsumerEnv,
    logger
  );
  return { message, logger };
}

export function stdEnv() {
  const adminDb = createFakeAdminDb();
  const bucket = createMemoryBucket();
  const queue = createQueue();
  const critical = createQueue();
  return {
    adminDb,
    bucket,
    queue,
    critical,
    env: {
      DB_ADMIN: adminDb,
      SENSITIVE_DETAILS: bucket,
      OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
      LOGGING_DELIVERY_CRITICAL_QUEUE: critical,
      LOGGING_DELIVERY_QUEUE: queue,
    } as Record<string, unknown>,
  };
}
