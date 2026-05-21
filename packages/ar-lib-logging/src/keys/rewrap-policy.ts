import type { LogPlane, LogType } from '../registry';
import { createLoggingId } from '../ids';

export type LoggingRewrapReason =
  | 'compromised'
  | 'sensitive_detail'
  | 'critical_archive'
  | 'recent_access'
  | 'default_archive';

export interface ClassifyLoggingRewrapInput {
  logType: LogType;
  plane: LogPlane;
  compromised?: boolean;
  recentlyAccessed?: boolean;
  critical?: boolean;
}

export interface LoggingRewrapPriorityDecision {
  priority: number;
  reason: LoggingRewrapReason;
}

export interface LoggingRewrapRetentionDecisionInput {
  now: number;
  expiresAt?: number | null;
  skipThresholdMs: number;
}

export type LoggingRewrapJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface LoggingRewrapSqlExecutor {
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface LoggingRewrapJobRecord {
  id: string;
  keyRegistryId: string;
  fromVersion: number;
  toVersion: number;
  priority: number;
  status: LoggingRewrapJobStatus;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  metadata: Record<string, unknown> | null;
}

export interface EnqueueLoggingRewrapJobInput {
  id?: string;
  keyRegistryId: string;
  fromVersion: number;
  toVersion: number;
  priority: number;
  metadata?: Record<string, unknown>;
  now?: number;
}

export interface CompleteLoggingRewrapJobInput {
  id: string;
  status: Extract<LoggingRewrapJobStatus, 'succeeded' | 'failed' | 'skipped'>;
  metadata?: Record<string, unknown>;
  now?: number;
}

interface LoggingRewrapJobRow {
  id: string;
  key_registry_id: string;
  from_version: number;
  to_version: number;
  priority: number;
  status: LoggingRewrapJobStatus;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  metadata: string | null;
}

export function classifyLoggingRewrapPriority(
  input: ClassifyLoggingRewrapInput
): LoggingRewrapPriorityDecision {
  if (input.compromised) {
    return { priority: 0, reason: 'compromised' };
  }
  if (input.plane === 'sensitive_detail') {
    return { priority: 10, reason: 'sensitive_detail' };
  }
  if (
    input.critical ||
    input.logType === 'admin_audit' ||
    input.logType === 'audit' ||
    input.plane === 'archive'
  ) {
    return { priority: 20, reason: 'critical_archive' };
  }
  if (input.recentlyAccessed) {
    return { priority: 30, reason: 'recent_access' };
  }
  return { priority: 40, reason: 'default_archive' };
}

export function shouldSkipLoggingRewrapForRetention(
  input: LoggingRewrapRetentionDecisionInput
): boolean {
  if (!input.expiresAt) {
    return false;
  }
  return input.expiresAt - input.now <= input.skipThresholdMs;
}

function metadataToJson(metadata: Record<string, unknown> | undefined): string | null {
  if (!metadata || Object.keys(metadata).length === 0) {
    return null;
  }
  return JSON.stringify(metadata);
}

function parseMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function mapRewrapJob(row: LoggingRewrapJobRow): LoggingRewrapJobRecord {
  return {
    id: row.id,
    keyRegistryId: row.key_registry_id,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    priority: row.priority,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    metadata: parseMetadata(row.metadata),
  };
}

export class SqlLoggingRewrapJobQueue {
  constructor(private readonly executor: LoggingRewrapSqlExecutor) {}

  async enqueue(input: EnqueueLoggingRewrapJobInput): Promise<LoggingRewrapJobRecord> {
    const now = input.now ?? Date.now();
    const record: LoggingRewrapJobRecord = {
      id: input.id ?? createLoggingId('lrw', now),
      keyRegistryId: input.keyRegistryId,
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      priority: input.priority,
      status: 'queued',
      createdAt: now,
      startedAt: null,
      completedAt: null,
      metadata: input.metadata ?? null,
    };

    await this.executor.execute(
      `INSERT INTO logging_rewrap_jobs (
        id, key_registry_id, from_version, to_version, priority, status,
        created_at, started_at, completed_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.keyRegistryId,
        record.fromVersion,
        record.toVersion,
        record.priority,
        record.status,
        record.createdAt,
        record.startedAt,
        record.completedAt,
        metadataToJson(record.metadata ?? undefined),
      ]
    );

    return record;
  }

  async claimNext(now: number = Date.now()): Promise<LoggingRewrapJobRecord | null> {
    const row = await this.executor.queryOne<LoggingRewrapJobRow>(
      `SELECT id, key_registry_id, from_version, to_version, priority, status,
              created_at, started_at, completed_at, metadata
       FROM logging_rewrap_jobs
       WHERE status = ?
       ORDER BY priority ASC, created_at ASC
       LIMIT 1`,
      ['queued']
    );
    if (!row) {
      return null;
    }

    await this.executor.execute(
      `UPDATE logging_rewrap_jobs
       SET status = ?, started_at = ?
       WHERE id = ? AND status = ?`,
      ['running', now, row.id, 'queued']
    );

    return mapRewrapJob({
      ...row,
      status: 'running',
      started_at: now,
    });
  }

  async complete(input: CompleteLoggingRewrapJobInput): Promise<void> {
    const now = input.now ?? Date.now();
    await this.executor.execute(
      `UPDATE logging_rewrap_jobs
       SET status = ?, completed_at = ?, metadata = ?
       WHERE id = ? AND status = ?`,
      [input.status, now, metadataToJson(input.metadata), input.id, 'running']
    );
  }
}
