import { createLoggingId } from '../ids';
import type { LoggingDeliveryLane } from './types';
import type { LoggingSqlExecutor } from './delivery-events';

export type LoggingDlqItemStatus = 'open' | 'replayed' | 'deleted' | 'purged';

export interface LoggingDlqItemInput {
  id?: string;
  tenantKey: string;
  payloadType: string;
  schemaVersion: number;
  lane: LoggingDeliveryLane;
  destinationId?: string | null;
  payloadObjectRef: string;
  errorClass: string;
  attemptCount: number;
  status?: LoggingDlqItemStatus;
  now?: number;
}

export interface LoggingDlqItemRecord {
  id: string;
  tenantKey: string;
  payloadType: string;
  schemaVersion: number;
  lane: LoggingDeliveryLane;
  destinationId: string | null;
  payloadObjectRef: string;
  errorClass: string;
  attemptCount: number;
  status: LoggingDlqItemStatus;
  createdAt: number;
  updatedAt: number;
}

export interface LoggingDlqItemStore {
  insertItem(input: LoggingDlqItemInput): Promise<LoggingDlqItemRecord>;
}

export class SqlLoggingDlqItemStore implements LoggingDlqItemStore {
  constructor(private readonly executor: LoggingSqlExecutor) {}

  async insertItem(input: LoggingDlqItemInput): Promise<LoggingDlqItemRecord> {
    const now = input.now ?? Date.now();
    const record: LoggingDlqItemRecord = {
      id: input.id ?? createLoggingId('dlq', now),
      tenantKey: input.tenantKey,
      payloadType: input.payloadType,
      schemaVersion: input.schemaVersion,
      lane: input.lane,
      destinationId: input.destinationId ?? null,
      payloadObjectRef: input.payloadObjectRef,
      errorClass: input.errorClass,
      attemptCount: input.attemptCount,
      status: input.status ?? 'open',
      createdAt: now,
      updatedAt: now,
    };

    await this.executor.execute(
      `INSERT INTO logging_dlq_items (
        id, tenant_key, payload_type, schema_version, lane, destination_id,
        payload_object_ref, error_class, attempt_count, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.tenantKey,
        record.payloadType,
        record.schemaVersion,
        record.lane,
        record.destinationId,
        record.payloadObjectRef,
        record.errorClass,
        record.attemptCount,
        record.status,
        record.createdAt,
        record.updatedAt,
      ]
    );

    return record;
  }
}
