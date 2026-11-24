/**
 * Shared fakes for the queue-consumer mutation tests.
 * Everything here is in-memory: no network, no real database, no timers.
 */
import { vi } from 'vitest';
import type { Logger } from '../../../utils/logger';
import {
  encryptObjectArtifact,
  type EncryptedObjectArtifactEnvelope,
} from '../../object-artifact-crypto';

export const ROOT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

export interface FakeMessage<T = unknown> {
  id: string;
  attempts: number;
  body: T;
  timestamp?: Date;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
}

export function createMessage<T>(
  body: T,
  options: { attempts?: number; id?: string; timestamp?: Date } = {}
): FakeMessage<T> {
  return {
    id: options.id ?? crypto.randomUUID(),
    attempts: options.attempts ?? 1,
    body,
    timestamp: options.timestamp,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

export function createFakeLogger() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
    module: vi.fn(),
    startTimer: vi.fn(() => () => undefined),
  };
  logger.child.mockReturnValue(logger);
  logger.module.mockReturnValue(logger);
  return logger as typeof logger & Logger;
}

export interface FakeAdminDbOptions {
  destination?: Record<string, unknown> | null;
  dlqItem?: Record<string, unknown> | null;
  /** rowsAffected returned by execute(); a function may decide per statement. */
  executeResult?: (sql: string, params: unknown[]) => unknown;
  /** Extra queryOne handler consulted first. Return undefined to fall through. */
  queryOne?: (sql: string, params: unknown[]) => unknown;
}

/**
 * Admin DB adapter fake. Notification rows are returned only after an INSERT, so the
 * repository dedupe lookup sees "not found" first.
 */
export function createFakeAdminDb(options: FakeAdminDbOptions = {}) {
  let notificationInserted = false;
  const adapter = {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockImplementation(async (sql: string, params: unknown[]) => {
      const custom = options.queryOne?.(sql, params);
      if (custom !== undefined) {
        return custom;
      }
      if (sql.includes('FROM admin_destinations')) {
        if (options.destination === null) {
          return null;
        }
        return {
          id: params[0] ?? 'dest_1',
          provider: 'http',
          lifecycle_status: 'active',
          provider_config: JSON.stringify({ url: 'https://collector.example/chunks' }),
          credential_ref: null,
          credential_version: null,
          ...options.destination,
        };
      }
      if (sql.includes('FROM logging_dlq_items')) {
        if (options.dlqItem === null) {
          return null;
        }
        return {
          id: params[0] ?? 'dlq_1',
          tenant_key: 'tk_123',
          payload_type: 'audit_queue_message',
          schema_version: 1,
          lane: 'critical',
          destination_id: 'queue:AUDIT_DLQ',
          payload_object_ref: 'dlq/tenant_key=tk_123/item.json',
          status: 'open',
          ...options.dlqItem,
        };
      }
      if (sql.includes('internal_notification_events')) {
        if (!notificationInserted) {
          return null;
        }
        return {
          id: 'notification-1',
          tenant_id: 'tk_123',
          category: 'logging_delivery_failure',
          event_type: 'logging.delivery.retrying',
          severity: 'critical',
          status: 'pending',
          deduplication_key: params[0] ?? null,
          payload_json: '{}',
          attempts: 0,
          last_error: null,
          next_attempt_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          delivered_at: null,
        };
      }
      return null;
    }),
    execute: vi.fn().mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO internal_notification_events')) {
        notificationInserted = true;
      }
      const custom = options.executeResult?.(sql, params);
      if (custom !== undefined) {
        if (custom instanceof Error) {
          throw custom;
        }
        return custom;
      }
      return { rowsAffected: 1 };
    }),
    transaction: vi.fn(),
    batch: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 1 }),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return adapter;
}

export type FakeAdminDb = ReturnType<typeof createFakeAdminDb>;

export interface DeliveryEventRow {
  id: string;
  tenantKey: string;
  destinationId: string | null;
  logType: string;
  plane: string;
  lane: string;
  status: string;
  attemptCount: number;
  errorClass: string | null;
  objectCatalogId: string | null;
  nextRetryAt: number | null;
  metadata: Record<string, unknown> | null;
}

/** Parse the logging_delivery_events INSERT statements recorded by insertEvent(). */
export function insertedDeliveryEvents(db: FakeAdminDb): DeliveryEventRow[] {
  return db.execute.mock.calls
    .filter(
      ([sql]) =>
        typeof sql === 'string' &&
        sql.includes('INSERT INTO logging_delivery_events') &&
        !sql.includes("'delivery_in_progress'")
    )
    .map(([, params]) => {
      const p = params as unknown[];
      return {
        id: p[0] as string,
        tenantKey: p[1] as string,
        destinationId: p[2] as string | null,
        logType: p[3] as string,
        plane: p[4] as string,
        lane: p[5] as string,
        status: p[6] as string,
        attemptCount: p[7] as number,
        errorClass: p[8] as string | null,
        objectCatalogId: p[9] as string | null,
        nextRetryAt: p[12] as number | null,
        metadata: p[13] ? (JSON.parse(p[13] as string) as Record<string, unknown>) : null,
      };
    });
}

export interface NotificationRow {
  id: string;
  tenantId: string;
  category: string;
  eventType: string;
  severity: string;
  deduplicationKey: string;
  payload: Record<string, unknown>;
}

export function insertedNotifications(db: FakeAdminDb): NotificationRow[] {
  return db.execute.mock.calls
    .filter(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO internal_notification_events')
    )
    .map(([, params]) => {
      const p = params as unknown[];
      return {
        id: p[0] as string,
        tenantId: p[1] as string,
        category: p[2] as string,
        eventType: p[3] as string,
        severity: p[4] as string,
        deduplicationKey: p[5] as string,
        payload: JSON.parse(p[6] as string) as Record<string, unknown>,
      };
    });
}

export function sqlCalls(db: FakeAdminDb, fragment: string) {
  return db.execute.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes(fragment));
}

export interface MemoryBucketObject {
  value: string | Uint8Array;
  customMetadata?: Record<string, string>;
  httpMetadata?: Record<string, unknown>;
}

/** In-memory R2 bucket. Objects stored through put() are readable through get(). */
export function createMemoryBucket() {
  const objects = new Map<string, MemoryBucketObject>();
  const bucket = {
    objects,
    put: vi.fn().mockImplementation(async (key: string, value: unknown, options?: R2PutOptions) => {
      objects.set(key, {
        value: value as string | Uint8Array,
        customMetadata: options?.customMetadata,
        httpMetadata: options?.httpMetadata as Record<string, unknown> | undefined,
      });
    }),
    get: vi.fn().mockImplementation(async (key: string) => {
      const object = objects.get(key);
      if (!object) {
        return null;
      }
      const text =
        typeof object.value === 'string' ? object.value : new TextDecoder().decode(object.value);
      return {
        size: new TextEncoder().encode(text).byteLength,
        customMetadata: object.customMetadata,
        httpMetadata: object.httpMetadata,
        text: vi.fn().mockResolvedValue(text),
      };
    }),
    delete: vi.fn().mockImplementation(async (key: string) => {
      objects.delete(key);
    }),
  };
  return bucket;
}

export type MemoryBucket = ReturnType<typeof createMemoryBucket>;

/** Build an R2 object body holding an encrypted logging-delivery payload. */
export async function createEncryptedPayloadObject(
  objectKey: string,
  tenantContext: string,
  payload: unknown,
  extra: { contentType?: string; metadata?: Record<string, string | undefined> } = {}
): Promise<R2ObjectBody> {
  const envelope = await encryptObjectArtifact(
    typeof payload === 'string' ? payload : JSON.stringify(payload),
    {
      rootKeyHex: ROOT_KEY,
      plane: 'SENSITIVE_DETAILS',
      keyVersion: 1,
      contentType: 'application/json',
      context: { tenantId: tenantContext, objectKey, objectClass: 'operational_log_detail' },
    }
  );
  const stored = JSON.stringify(envelope);
  return {
    size: new TextEncoder().encode(stored).byteLength,
    customMetadata: {
      encryption: 'authrim-object-envelope-v1',
      encryptionTenantContext: tenantContext,
      keyVersion: '1',
      ...extra.metadata,
    },
    httpMetadata: extra.contentType ? { contentType: extra.contentType } : undefined,
    text: vi.fn().mockResolvedValue(stored),
  } as unknown as R2ObjectBody;
}

export function fetchResponse(status: number, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) =>
        Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ??
        null,
    },
  };
}

export function parseEnvelope(json: string): EncryptedObjectArtifactEnvelope {
  return JSON.parse(json) as EncryptedObjectArtifactEnvelope;
}

/** Presence check for test fixtures: returns the value or fails with a descriptive message. */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${what} to be present`);
  }
  return value;
}
