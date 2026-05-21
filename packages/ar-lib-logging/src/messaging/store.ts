import { createLoggingId } from '../ids';
import type { LoggingDeliveryLane } from '../delivery/types';
import type {
  LoggingMessageAttemptPolicy,
  LoggingMessageIdempotencyReservation,
  LoggingMessageJobClaimInput,
  LoggingMessageJobCreateInput,
  LoggingMessageJobKind,
  LoggingMessageJobListInput,
  LoggingMessageJobListDueInput,
  LoggingMessageJobRepairFindingListInput,
  LoggingMessageJobRepairFindingRecord,
  LoggingMessageJobRecord,
  LoggingMessageJobRepairFindingInput,
  LoggingMessageJobRepairListInput,
  LoggingMessageJobStatus,
} from './types';

export interface LoggingMessageSqlExecutor {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<unknown>;
}

const DEFAULT_MAX_DEPTH = 16;
const DEFAULT_MAX_ATTEMPTS = 5;

interface LoggingMessageJobRow {
  id: string;
  kind: LoggingMessageJobKind;
  status: LoggingMessageJobStatus;
  lane: LoggingDeliveryLane;
  criticality: 'standard' | 'critical';
  priority: number;
  tenant_id: string | null;
  tenant_key: string | null;
  topology_type: LoggingMessageJobRecord['topologyType'];
  database_binding_ref: string | null;
  connection_ref: string | null;
  topology_snapshot_version: string | null;
  topology_resolved_at: number | null;
  scope_type: LoggingMessageJobRecord['scopeType'];
  scope_id: string | null;
  scope_key: string;
  source_type: LoggingMessageJobRecord['sourceType'];
  source_id: string;
  root_job_id: string | null;
  parent_job_id: string | null;
  depth: number;
  payload_object_ref: string;
  payload_sha256: string;
  payload_type: string;
  payload_schema_version: number;
  redacted_summary_json: string | null;
  validation_summary_json: string | null;
  idempotency_key: string | null;
  dedupe_until: number | null;
  not_before: number;
  attempt_count: number;
  max_attempts: number;
  attempt_policy_json: string | null;
  claim_token: string | null;
  claimed_at: number | null;
  claimed_until: number | null;
  requested_by: string | null;
  reason: string | null;
  error_class: string | null;
  last_error: string | null;
  blocked_reason: string | null;
  cancel_requested_at: number | null;
  cancelled_by: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
  expires_at: number | null;
}

interface LoggingMessageRepairFindingRow {
  id: string;
  message_job_id: string | null;
  finding_type: LoggingMessageJobRepairFindingRecord['findingType'];
  severity: LoggingMessageJobRepairFindingRecord['severity'];
  status: LoggingMessageJobRepairFindingRecord['status'];
  safe_action: string | null;
  dangerous_action: string | null;
  impact_json: string | null;
  detected_at: number;
  updated_at: number;
  resolved_at: number | null;
  applied_at: number | null;
  applied_by: string | null;
  tenant_key: string | null;
  job_kind: LoggingMessageJobKind | null;
  job_status: LoggingMessageJobStatus | null;
}

function jsonOrNull(
  value: Record<string, unknown> | LoggingMessageAttemptPolicy | null
): string | null {
  if (!value || Object.keys(value).length === 0) {
    return null;
  }
  return JSON.stringify(value);
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function parseAttemptPolicy(value: string | null): LoggingMessageAttemptPolicy | null {
  const parsed = parseJsonObject(value);
  return parsed as LoggingMessageAttemptPolicy | null;
}

function readRowsAffected(result: unknown): number | null {
  if (!result || typeof result !== 'object' || !('rowsAffected' in result)) {
    return null;
  }
  const rowsAffected = Number((result as { rowsAffected?: unknown }).rowsAffected);
  return Number.isFinite(rowsAffected) ? rowsAffected : null;
}

function mapJobRow(row: LoggingMessageJobRow): LoggingMessageJobRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    lane: row.lane,
    criticality: row.criticality,
    priority: row.priority,
    tenantId: row.tenant_id,
    tenantKey: row.tenant_key,
    topologyType: row.topology_type,
    databaseBindingRef: row.database_binding_ref,
    connectionRef: row.connection_ref,
    topologySnapshotVersion: row.topology_snapshot_version,
    topologyResolvedAt: row.topology_resolved_at,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    scopeKey: row.scope_key,
    sourceType: row.source_type,
    sourceId: row.source_id,
    rootJobId: row.root_job_id,
    parentJobId: row.parent_job_id,
    depth: row.depth,
    payloadObjectRef: row.payload_object_ref,
    payloadSha256: row.payload_sha256,
    payloadType: row.payload_type,
    payloadSchemaVersion: row.payload_schema_version,
    redactedSummary: parseJsonObject(row.redacted_summary_json),
    validationSummary: parseJsonObject(row.validation_summary_json),
    idempotencyKey: row.idempotency_key,
    dedupeUntil: row.dedupe_until,
    notBefore: row.not_before,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    attemptPolicy: parseAttemptPolicy(row.attempt_policy_json),
    claimToken: row.claim_token,
    claimedAt: row.claimed_at,
    claimedUntil: row.claimed_until,
    requestedBy: row.requested_by,
    reason: row.reason,
    errorClass: row.error_class,
    lastError: row.last_error,
    blockedReason: row.blocked_reason,
    cancelRequestedAt: row.cancel_requested_at,
    cancelledBy: row.cancelled_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
  };
}

function mapRepairFindingRow(
  row: LoggingMessageRepairFindingRow
): LoggingMessageJobRepairFindingRecord {
  return {
    id: row.id,
    messageJobId: row.message_job_id,
    findingType: row.finding_type,
    severity: row.severity,
    status: row.status,
    safeAction: row.safe_action,
    dangerousAction: row.dangerous_action,
    impact: parseJsonObject(row.impact_json),
    detectedAt: row.detected_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    appliedAt: row.applied_at,
    appliedBy: row.applied_by,
    tenantKey: row.tenant_key,
    jobKind: row.job_kind,
    jobStatus: row.job_status,
  };
}

function buildDueWhere(input: LoggingMessageJobListDueInput): {
  sql: string;
  params: unknown[];
} {
  const clauses = [
    '(status = ? OR status = ?)',
    'not_before <= ?',
    '(expires_at IS NULL OR expires_at > ?)',
  ];
  const params: unknown[] = ['queued', 'retrying', input.now, input.now];
  if (input.lane) {
    clauses.push('lane = ?');
    params.push(input.lane);
  }
  if (input.kind) {
    clauses.push('kind = ?');
    params.push(input.kind);
  }
  return { sql: clauses.join(' AND '), params };
}

function appendOptionalJobFilters(
  clauses: string[],
  params: unknown[],
  input: {
    lane?: LoggingDeliveryLane;
    kind?: LoggingMessageJobKind;
  }
): void {
  if (input.lane) {
    clauses.push('lane = ?');
    params.push(input.lane);
  }
  if (input.kind) {
    clauses.push('kind = ?');
    params.push(input.kind);
  }
}

export class SqlLoggingMessageJobStore {
  constructor(
    private readonly executor: LoggingMessageSqlExecutor,
    private readonly options: { maxDepth?: number } = {}
  ) {}

  async createJob(input: LoggingMessageJobCreateInput): Promise<LoggingMessageJobRecord> {
    const now = input.now ?? Date.now();
    const id = input.id ?? createLoggingId('lmj', now);
    const depth = input.depth ?? 0;
    const maxDepth = this.options.maxDepth ?? DEFAULT_MAX_DEPTH;
    if (depth > maxDepth) {
      throw new Error('logging_message_job_depth_exceeded');
    }

    const maxAttempts =
      input.maxAttempts ?? input.attemptPolicy?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const rootJobId = input.rootJobId ?? input.parentJobId ?? null;

    if (input.idempotencyKey) {
      const reservation = await this.reserveIdempotencyKey({
        jobId: id,
        kind: input.kind,
        scopeKey: input.scopeKey,
        idempotencyKey: input.idempotencyKey,
        targetPayloadHash: input.payloadSha256,
        lane: input.lane,
        criticality: input.criticality ?? 'standard',
        dedupeUntil: input.dedupeUntil ?? input.expiresAt ?? now + 24 * 60 * 60 * 1000,
        now,
      });
      if (reservation.status === 'duplicate') {
        const duplicate = await this.getJob(reservation.jobId);
        if (duplicate) {
          return duplicate;
        }
      }
    }

    await this.executor.execute(
      `INSERT INTO logging_message_jobs (
        id, kind, status, lane, criticality, priority,
        tenant_id, tenant_key, topology_type, database_binding_ref, connection_ref,
        topology_snapshot_version, topology_resolved_at,
        scope_type, scope_id, scope_key, source_type, source_id,
        root_job_id, parent_job_id, depth,
        payload_object_ref, payload_sha256, payload_type, payload_schema_version,
        redacted_summary_json, validation_summary_json,
        idempotency_key, dedupe_until, not_before,
        attempt_count, max_attempts, attempt_policy_json,
        claim_token, claimed_at, claimed_until,
        requested_by, reason, error_class, last_error, blocked_reason,
        cancel_requested_at, cancelled_by,
        created_at, updated_at, started_at, completed_at, expires_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?
      )`,
      [
        id,
        input.kind,
        'queued',
        input.lane,
        input.criticality ?? 'standard',
        input.priority ?? 0,
        input.topology.tenantId ?? null,
        input.topology.tenantKey ?? null,
        input.topology.topologyType,
        input.topology.databaseBindingRef ?? null,
        input.topology.connectionRef ?? null,
        input.topology.topologySnapshotVersion ?? null,
        input.topology.topologyResolvedAt ?? null,
        input.scopeType,
        input.scopeId ?? null,
        input.scopeKey,
        input.sourceType,
        input.sourceId,
        rootJobId,
        input.parentJobId ?? null,
        depth,
        input.payloadObjectRef,
        input.payloadSha256,
        input.payloadType,
        input.payloadSchemaVersion,
        jsonOrNull(input.redactedSummary ?? null),
        jsonOrNull(input.validationSummary ?? null),
        input.idempotencyKey ?? null,
        input.dedupeUntil ?? null,
        input.notBefore ?? now,
        0,
        maxAttempts,
        jsonOrNull(input.attemptPolicy ?? null),
        null,
        null,
        null,
        input.requestedBy ?? null,
        input.reason ?? null,
        input.errorClass ?? null,
        null,
        null,
        null,
        null,
        now,
        now,
        null,
        null,
        input.expiresAt ?? null,
      ]
    );

    return {
      id,
      kind: input.kind,
      status: 'queued',
      lane: input.lane,
      criticality: input.criticality ?? 'standard',
      priority: input.priority ?? 0,
      tenantId: input.topology.tenantId ?? null,
      tenantKey: input.topology.tenantKey ?? null,
      topologyType: input.topology.topologyType,
      databaseBindingRef: input.topology.databaseBindingRef ?? null,
      connectionRef: input.topology.connectionRef ?? null,
      topologySnapshotVersion: input.topology.topologySnapshotVersion ?? null,
      topologyResolvedAt: input.topology.topologyResolvedAt ?? null,
      scopeType: input.scopeType,
      scopeId: input.scopeId ?? null,
      scopeKey: input.scopeKey,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      rootJobId,
      parentJobId: input.parentJobId ?? null,
      depth,
      payloadObjectRef: input.payloadObjectRef,
      payloadSha256: input.payloadSha256,
      payloadType: input.payloadType,
      payloadSchemaVersion: input.payloadSchemaVersion,
      redactedSummary: input.redactedSummary ?? null,
      validationSummary: input.validationSummary ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      dedupeUntil: input.dedupeUntil ?? null,
      notBefore: input.notBefore ?? now,
      attemptCount: 0,
      maxAttempts,
      attemptPolicy: input.attemptPolicy ?? null,
      claimToken: null,
      claimedAt: null,
      claimedUntil: null,
      requestedBy: input.requestedBy ?? null,
      reason: input.reason ?? null,
      errorClass: input.errorClass ?? null,
      lastError: null,
      blockedReason: null,
      cancelRequestedAt: null,
      cancelledBy: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      expiresAt: input.expiresAt ?? null,
    };
  }

  async getJob(id: string): Promise<LoggingMessageJobRecord | null> {
    const row = await this.executor.queryOne<LoggingMessageJobRow>(
      'SELECT * FROM logging_message_jobs WHERE id = ?',
      [id]
    );
    return row ? mapJobRow(row) : null;
  }

  async listDueJobs(input: LoggingMessageJobListDueInput): Promise<LoggingMessageJobRecord[]> {
    const where = buildDueWhere(input);
    const rows = await this.executor.query<LoggingMessageJobRow>(
      `SELECT * FROM logging_message_jobs
       WHERE ${where.sql}
       ORDER BY priority DESC, not_before ASC, created_at ASC
       LIMIT ?`,
      [...where.params, input.limit ?? 50]
    );
    return rows.map(mapJobRow);
  }

  async listJobs(input: LoggingMessageJobListInput = {}): Promise<LoggingMessageJobRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (input.tenantKey !== undefined) {
      if (input.tenantKey === null) {
        clauses.push('tenant_key IS NULL');
      } else {
        clauses.push('tenant_key = ?');
        params.push(input.tenantKey);
      }
    }
    if (input.scopeKey) {
      clauses.push('scope_key = ?');
      params.push(input.scopeKey);
    }
    if (input.kind) {
      clauses.push('kind = ?');
      params.push(input.kind);
    }
    if (input.status) {
      clauses.push('status = ?');
      params.push(input.status);
    }
    if (input.lane) {
      clauses.push('lane = ?');
      params.push(input.lane);
    }
    if (input.sourceType) {
      clauses.push('source_type = ?');
      params.push(input.sourceType);
    }
    if (input.sourceId) {
      clauses.push('source_id = ?');
      params.push(input.sourceId);
    }
    if (input.rootJobId) {
      clauses.push('root_job_id = ?');
      params.push(input.rootJobId);
    }
    if (input.parentJobId !== undefined) {
      if (input.parentJobId === null) {
        clauses.push('parent_job_id IS NULL');
      } else {
        clauses.push('parent_job_id = ?');
        params.push(input.parentJobId);
      }
    }
    if (typeof input.createdAfter === 'number') {
      clauses.push('created_at >= ?');
      params.push(input.createdAfter);
    }
    if (typeof input.createdBefore === 'number') {
      clauses.push('created_at <= ?');
      params.push(input.createdBefore);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.executor.query<LoggingMessageJobRow>(
      `SELECT * FROM logging_message_jobs
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...params, input.limit ?? 50, input.offset ?? 0]
    );
    return rows.map(mapJobRow);
  }

  async listStuckClaimJobs(
    input: LoggingMessageJobRepairListInput
  ): Promise<LoggingMessageJobRecord[]> {
    const clauses = [
      '(status = ? OR status = ?)',
      'claimed_until IS NOT NULL',
      'claimed_until <= ?',
    ];
    const params: unknown[] = ['claimed', 'running', input.now];
    appendOptionalJobFilters(clauses, params, input);
    const rows = await this.executor.query<LoggingMessageJobRow>(
      `SELECT * FROM logging_message_jobs
       WHERE ${clauses.join(' AND ')}
       ORDER BY claimed_until ASC, priority DESC, created_at ASC
       LIMIT ?`,
      [...params, input.limit ?? 50]
    );
    return rows.map(mapJobRow);
  }

  async listExpiredQueuedJobs(
    input: LoggingMessageJobRepairListInput
  ): Promise<LoggingMessageJobRecord[]> {
    const clauses = ['(status = ? OR status = ?)', 'expires_at IS NOT NULL', 'expires_at <= ?'];
    const params: unknown[] = ['queued', 'retrying', input.now];
    appendOptionalJobFilters(clauses, params, input);
    const rows = await this.executor.query<LoggingMessageJobRow>(
      `SELECT * FROM logging_message_jobs
       WHERE ${clauses.join(' AND ')}
       ORDER BY expires_at ASC, priority DESC, created_at ASC
       LIMIT ?`,
      [...params, input.limit ?? 50]
    );
    return rows.map(mapJobRow);
  }

  async claimDueJob(input: LoggingMessageJobClaimInput): Promise<LoggingMessageJobRecord | null> {
    const candidates = await this.listDueJobs(input);
    for (const candidate of candidates) {
      const claimedUntil = input.now + input.leaseMs;
      const update = await this.executor.execute(
        `UPDATE logging_message_jobs
         SET status = ?, claim_token = ?, claimed_at = ?, claimed_until = ?,
             attempt_count = attempt_count + 1,
             started_at = CASE WHEN started_at IS NULL THEN ? ELSE started_at END,
             updated_at = ?
         WHERE id = ?
           AND (status = ? OR status = ?)
           AND not_before <= ?
           AND (claimed_until IS NULL OR claimed_until <= ?)`,
        [
          'claimed',
          input.claimToken,
          input.now,
          claimedUntil,
          input.now,
          input.now,
          candidate.id,
          'queued',
          'retrying',
          input.now,
          input.now,
        ]
      );
      const rowsAffected = readRowsAffected(update);
      if (rowsAffected === 0) {
        continue;
      }
      const claimed = await this.getJob(candidate.id);
      if (claimed?.claimToken === input.claimToken) {
        return claimed;
      }
    }
    return null;
  }

  async markRunning(id: string, claimToken: string, now: number): Promise<boolean> {
    return this.updateClaimedStatus(id, claimToken, 'running', now);
  }

  async markCompleted(id: string, claimToken: string, now: number): Promise<boolean> {
    const update = await this.executor.execute(
      `UPDATE logging_message_jobs
       SET status = ?, completed_at = ?, updated_at = ?,
           claim_token = NULL, claimed_at = NULL, claimed_until = NULL
       WHERE id = ? AND claim_token = ? AND (status = ? OR status = ?)`,
      ['completed', now, now, id, claimToken, 'claimed', 'running']
    );
    return (readRowsAffected(update) ?? 0) > 0;
  }

  async markRetrying(input: {
    id: string;
    claimToken: string;
    now: number;
    notBefore: number;
    errorClass?: string | null;
    lastError?: string | null;
  }): Promise<boolean> {
    const update = await this.executor.execute(
      `UPDATE logging_message_jobs
       SET status = ?, not_before = ?, error_class = ?, last_error = ?, updated_at = ?,
           claim_token = NULL, claimed_at = NULL, claimed_until = NULL
       WHERE id = ? AND claim_token = ? AND (status = ? OR status = ?)`,
      [
        'retrying',
        input.notBefore,
        input.errorClass ?? null,
        input.lastError ?? null,
        input.now,
        input.id,
        input.claimToken,
        'claimed',
        'running',
      ]
    );
    return (readRowsAffected(update) ?? 0) > 0;
  }

  async markFailed(input: {
    id: string;
    claimToken: string;
    now: number;
    status?: 'failed' | 'dlq';
    errorClass?: string | null;
    lastError?: string | null;
  }): Promise<boolean> {
    const update = await this.executor.execute(
      `UPDATE logging_message_jobs
       SET status = ?, error_class = ?, last_error = ?, completed_at = ?, updated_at = ?,
           claim_token = NULL, claimed_at = NULL, claimed_until = NULL
       WHERE id = ? AND claim_token = ? AND (status = ? OR status = ?)`,
      [
        input.status ?? 'failed',
        input.errorClass ?? null,
        input.lastError ?? null,
        input.now,
        input.now,
        input.id,
        input.claimToken,
        'claimed',
        'running',
      ]
    );
    return (readRowsAffected(update) ?? 0) > 0;
  }

  async markBlocked(input: {
    id: string;
    now: number;
    blockedReason: string;
    errorClass?: string | null;
    lastError?: string | null;
  }): Promise<boolean> {
    const update = await this.executor.execute(
      `UPDATE logging_message_jobs
       SET status = ?, blocked_reason = ?, error_class = ?, last_error = ?, updated_at = ?,
           claim_token = NULL, claimed_at = NULL, claimed_until = NULL
       WHERE id = ?`,
      [
        'blocked',
        input.blockedReason,
        input.errorClass ?? null,
        input.lastError ?? null,
        input.now,
        input.id,
      ]
    );
    return (readRowsAffected(update) ?? 0) > 0;
  }

  async markExpired(input: {
    id: string;
    now: number;
    lastError?: string | null;
  }): Promise<boolean> {
    const update = await this.executor.execute(
      `UPDATE logging_message_jobs
       SET status = ?, last_error = ?, completed_at = ?, updated_at = ?,
           claim_token = NULL, claimed_at = NULL, claimed_until = NULL
       WHERE id = ? AND status IN (?, ?, ?, ?)`,
      [
        'expired',
        input.lastError ?? null,
        input.now,
        input.now,
        input.id,
        'queued',
        'retrying',
        'claimed',
        'running',
      ]
    );
    return (readRowsAffected(update) ?? 0) > 0;
  }

  async repairStuckLeaseForRetry(input: {
    id: string;
    now: number;
    notBefore: number;
    errorClass?: string | null;
    lastError?: string | null;
  }): Promise<boolean> {
    const update = await this.executor.execute(
      `UPDATE logging_message_jobs
       SET status = ?, not_before = ?, error_class = ?, last_error = ?, updated_at = ?,
           claim_token = NULL, claimed_at = NULL, claimed_until = NULL
       WHERE id = ? AND status IN (?, ?) AND claimed_until IS NOT NULL AND claimed_until <= ?`,
      [
        'retrying',
        input.notBefore,
        input.errorClass ?? null,
        input.lastError ?? null,
        input.now,
        input.id,
        'claimed',
        'running',
        input.now,
      ]
    );
    return (readRowsAffected(update) ?? 0) > 0;
  }

  async repairStuckLeaseToDlq(input: {
    id: string;
    now: number;
    errorClass?: string | null;
    lastError?: string | null;
  }): Promise<boolean> {
    const update = await this.executor.execute(
      `UPDATE logging_message_jobs
       SET status = ?, error_class = ?, last_error = ?, completed_at = ?, updated_at = ?,
           claim_token = NULL, claimed_at = NULL, claimed_until = NULL
       WHERE id = ? AND status IN (?, ?) AND claimed_until IS NOT NULL AND claimed_until <= ?`,
      [
        'dlq',
        input.errorClass ?? null,
        input.lastError ?? null,
        input.now,
        input.now,
        input.id,
        'claimed',
        'running',
        input.now,
      ]
    );
    return (readRowsAffected(update) ?? 0) > 0;
  }

  async requestCancel(id: string, cancelledBy: string, now: number): Promise<boolean> {
    const update = await this.executor.execute(
      `UPDATE logging_message_jobs
       SET cancel_requested_at = ?, cancelled_by = ?, updated_at = ?
       WHERE id = ? AND status IN (?, ?, ?, ?)`,
      [now, cancelledBy, now, id, 'queued', 'retrying', 'claimed', 'running']
    );
    return (readRowsAffected(update) ?? 0) > 0;
  }

  async markCancelled(id: string, now: number): Promise<boolean> {
    const update = await this.executor.execute(
      `UPDATE logging_message_jobs
       SET status = ?, completed_at = ?, updated_at = ?,
           claim_token = NULL, claimed_at = NULL, claimed_until = NULL
       WHERE id = ? AND status <> ?`,
      ['cancelled', now, now, id, 'completed']
    );
    return (readRowsAffected(update) ?? 0) > 0;
  }

  async recordRepairFinding(input: LoggingMessageJobRepairFindingInput): Promise<string> {
    const now = input.now ?? Date.now();
    const id = input.id ?? createLoggingId('rw', now);
    await this.executor.execute(
      `INSERT INTO logging_message_repair_findings (
        id, message_job_id, finding_type, severity, status,
        safe_action, dangerous_action, impact_json,
        detected_at, updated_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.messageJobId,
        input.findingType,
        input.severity,
        input.status ?? 'open',
        input.safeAction ?? null,
        input.dangerousAction ?? null,
        jsonOrNull(input.impact ?? null),
        now,
        now,
        null,
      ]
    );
    return id;
  }

  async listRepairFindings(
    input: LoggingMessageJobRepairFindingListInput = {}
  ): Promise<LoggingMessageJobRepairFindingRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (input.tenantKey !== undefined) {
      if (input.tenantKey === null) {
        clauses.push('mj.tenant_key IS NULL');
      } else {
        clauses.push('mj.tenant_key = ?');
        params.push(input.tenantKey);
      }
    }
    if (input.status) {
      clauses.push('f.status = ?');
      params.push(input.status);
    }
    if (input.severity) {
      clauses.push('f.severity = ?');
      params.push(input.severity);
    }
    if (input.findingType) {
      clauses.push('f.finding_type = ?');
      params.push(input.findingType);
    }
    if (input.messageJobId) {
      clauses.push('f.message_job_id = ?');
      params.push(input.messageJobId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.executor.query<LoggingMessageRepairFindingRow>(
      `SELECT f.id, f.message_job_id, f.finding_type, f.severity, f.status,
              f.safe_action, f.dangerous_action, f.impact_json,
              f.detected_at, f.updated_at, f.resolved_at, f.applied_at, f.applied_by,
              mj.tenant_key, mj.kind AS job_kind, mj.status AS job_status
       FROM logging_message_repair_findings f
       LEFT JOIN logging_message_jobs mj ON mj.id = f.message_job_id
       ${where}
       ORDER BY
         CASE f.severity
           WHEN 'critical' THEN 0
           WHEN 'error' THEN 1
           WHEN 'warning' THEN 2
           ELSE 3
         END,
         f.detected_at DESC,
         f.id DESC
       LIMIT ? OFFSET ?`,
      [...params, input.limit ?? 50, input.offset ?? 0]
    );
    return rows.map(mapRepairFindingRow);
  }

  async getRepairFinding(id: string): Promise<LoggingMessageJobRepairFindingRecord | null> {
    const row = await this.executor.queryOne<LoggingMessageRepairFindingRow>(
      `SELECT f.id, f.message_job_id, f.finding_type, f.severity, f.status,
              f.safe_action, f.dangerous_action, f.impact_json,
              f.detected_at, f.updated_at, f.resolved_at, f.applied_at, f.applied_by,
              mj.tenant_key, mj.kind AS job_kind, mj.status AS job_status
       FROM logging_message_repair_findings f
       LEFT JOIN logging_message_jobs mj ON mj.id = f.message_job_id
       WHERE f.id = ?`,
      [id]
    );
    return row ? mapRepairFindingRow(row) : null;
  }

  async markRepairFindingApplied(input: {
    id: string;
    status: 'safe_repaired' | 'dangerous_applied' | 'ignored';
    appliedBy: string;
    now: number;
  }): Promise<boolean> {
    const update = await this.executor.execute(
      `UPDATE logging_message_repair_findings
       SET status = ?, updated_at = ?, resolved_at = ?, applied_at = ?, applied_by = ?
       WHERE id = ? AND status = ?`,
      [input.status, input.now, input.now, input.now, input.appliedBy, input.id, 'open']
    );
    return (readRowsAffected(update) ?? 0) > 0;
  }

  private async updateClaimedStatus(
    id: string,
    claimToken: string,
    status: 'running',
    now: number
  ): Promise<boolean> {
    const update = await this.executor.execute(
      `UPDATE logging_message_jobs
       SET status = ?, updated_at = ?
       WHERE id = ? AND claim_token = ? AND status = ?`,
      [status, now, id, claimToken, 'claimed']
    );
    return (readRowsAffected(update) ?? 0) > 0;
  }

  private async reserveIdempotencyKey(input: {
    jobId: string;
    kind: LoggingMessageJobKind;
    scopeKey: string;
    idempotencyKey: string;
    targetPayloadHash: string;
    lane: LoggingDeliveryLane;
    criticality: 'standard' | 'critical';
    dedupeUntil: number;
    now: number;
  }): Promise<LoggingMessageIdempotencyReservation> {
    const existing = await this.executor.queryOne<{
      message_job_id: string;
      dedupe_until: number;
      status: string;
    }>(
      `SELECT message_job_id, dedupe_until, status
       FROM logging_message_idempotency_keys
       WHERE scope_key = ? AND idempotency_key = ?`,
      [input.scopeKey, input.idempotencyKey]
    );
    if (existing && existing.dedupe_until > input.now && existing.status === 'active') {
      return { status: 'duplicate', jobId: existing.message_job_id };
    }
    if (existing) {
      await this.executor.execute(
        `UPDATE logging_message_idempotency_keys
         SET message_job_id = ?, kind = ?, target_payload_hash = ?, lane = ?, criticality = ?,
             status = ?, dedupe_until = ?, created_at = ?, updated_at = ?
         WHERE scope_key = ? AND idempotency_key = ?`,
        [
          input.jobId,
          input.kind,
          input.targetPayloadHash,
          input.lane,
          input.criticality,
          'active',
          input.dedupeUntil,
          input.now,
          input.now,
          input.scopeKey,
          input.idempotencyKey,
        ]
      );
      return { status: 'reserved', jobId: input.jobId };
    }

    await this.executor.execute(
      `INSERT INTO logging_message_idempotency_keys (
        scope_key, idempotency_key, message_job_id, kind, target_payload_hash,
        lane, criticality, status, dedupe_until, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.scopeKey,
        input.idempotencyKey,
        input.jobId,
        input.kind,
        input.targetPayloadHash,
        input.lane,
        input.criticality,
        'active',
        input.dedupeUntil,
        input.now,
        input.now,
      ]
    );
    return { status: 'reserved', jobId: input.jobId };
  }
}
