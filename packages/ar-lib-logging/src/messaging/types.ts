import type { LoggingDeliveryLane } from '../delivery/types';

export type LoggingMessageJobKind = 'retry_delivery' | 'export_build';

export type LoggingMessageJobStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'retrying'
  | 'completed'
  | 'failed'
  | 'dlq'
  | 'cancelled'
  | 'expired'
  | 'blocked';

export type LoggingMessageJobCriticality = 'standard' | 'critical';

export type LoggingMessageJobTopologyType =
  | 'platform'
  | 'shared_d1'
  | 'tenant_d1'
  | 'external_db'
  | 'unknown';

export type LoggingMessageJobScopeType = 'platform' | 'tenant' | 'shared';

export type LoggingMessageJobSourceType = 'dlq_item' | 'delivery_event' | 'payload_object';

export interface LoggingMessageTopologySnapshot {
  tenantId?: string | null;
  tenantKey?: string | null;
  topologyType: LoggingMessageJobTopologyType;
  databaseBindingRef?: string | null;
  connectionRef?: string | null;
  topologySnapshotVersion?: string | null;
  topologyResolvedAt?: number | null;
}

export interface LoggingMessageAttemptPolicy {
  maxAttempts: number;
  leaseTimeoutMs: number;
  backoffMs?: number;
  errorClassBackoffMs?: Record<string, number>;
}

export interface LoggingMessageJobRecord {
  id: string;
  kind: LoggingMessageJobKind;
  status: LoggingMessageJobStatus;
  lane: LoggingDeliveryLane;
  criticality: LoggingMessageJobCriticality;
  priority: number;
  tenantId: string | null;
  tenantKey: string | null;
  topologyType: LoggingMessageJobTopologyType;
  databaseBindingRef: string | null;
  connectionRef: string | null;
  topologySnapshotVersion: string | null;
  topologyResolvedAt: number | null;
  scopeType: LoggingMessageJobScopeType;
  scopeId: string | null;
  scopeKey: string;
  sourceType: LoggingMessageJobSourceType;
  sourceId: string;
  rootJobId: string | null;
  parentJobId: string | null;
  depth: number;
  payloadObjectRef: string;
  payloadSha256: string;
  payloadType: string;
  payloadSchemaVersion: number;
  redactedSummary: Record<string, unknown> | null;
  validationSummary: Record<string, unknown> | null;
  idempotencyKey: string | null;
  dedupeUntil: number | null;
  notBefore: number;
  attemptCount: number;
  maxAttempts: number;
  attemptPolicy: LoggingMessageAttemptPolicy | null;
  claimToken: string | null;
  claimedAt: number | null;
  claimedUntil: number | null;
  requestedBy: string | null;
  reason: string | null;
  errorClass: string | null;
  lastError: string | null;
  blockedReason: string | null;
  cancelRequestedAt: number | null;
  cancelledBy: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  expiresAt: number | null;
}

export interface LoggingMessageJobCreateInput {
  id?: string;
  kind: LoggingMessageJobKind;
  lane: LoggingDeliveryLane;
  criticality?: LoggingMessageJobCriticality;
  priority?: number;
  topology: LoggingMessageTopologySnapshot;
  scopeType: LoggingMessageJobScopeType;
  scopeId?: string | null;
  scopeKey: string;
  sourceType: LoggingMessageJobSourceType;
  sourceId: string;
  rootJobId?: string | null;
  parentJobId?: string | null;
  depth?: number;
  payloadObjectRef: string;
  payloadSha256: string;
  payloadType: string;
  payloadSchemaVersion: number;
  redactedSummary?: Record<string, unknown> | null;
  validationSummary?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  dedupeUntil?: number | null;
  notBefore?: number;
  maxAttempts?: number;
  attemptPolicy?: LoggingMessageAttemptPolicy | null;
  requestedBy?: string | null;
  reason?: string | null;
  errorClass?: string | null;
  expiresAt?: number | null;
  now?: number;
}

export interface LoggingMessageJobClaimInput {
  now: number;
  leaseMs: number;
  claimToken: string;
  lane?: LoggingDeliveryLane;
  kind?: LoggingMessageJobKind;
  limit?: number;
}

export interface LoggingMessageJobListDueInput {
  now: number;
  lane?: LoggingDeliveryLane;
  kind?: LoggingMessageJobKind;
  limit?: number;
}

export interface LoggingMessageJobListInput {
  tenantKey?: string | null;
  scopeKey?: string;
  kind?: LoggingMessageJobKind;
  status?: LoggingMessageJobStatus;
  lane?: LoggingDeliveryLane;
  sourceType?: LoggingMessageJobSourceType;
  sourceId?: string;
  rootJobId?: string;
  parentJobId?: string | null;
  createdAfter?: number;
  createdBefore?: number;
  limit?: number;
  offset?: number;
}

export interface LoggingMessageJobRepairListInput {
  now: number;
  lane?: LoggingDeliveryLane;
  kind?: LoggingMessageJobKind;
  limit?: number;
}

export interface LoggingMessageJobRepairFindingRecord {
  id: string;
  messageJobId: string | null;
  findingType:
    | 'stuck_claim'
    | 'expired_queued'
    | 'expired_retrying'
    | 'missing_payload_object'
    | 'missing_export_part'
    | 'orphan_staging_object'
    | 'event_job_mismatch'
    | 'blocked_configuration';
  severity: 'info' | 'warning' | 'error' | 'critical';
  status: 'open' | 'safe_repaired' | 'dangerous_previewed' | 'dangerous_applied' | 'ignored';
  safeAction: string | null;
  dangerousAction: string | null;
  impact: Record<string, unknown> | null;
  detectedAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  appliedAt: number | null;
  appliedBy: string | null;
  tenantKey: string | null;
  jobKind: LoggingMessageJobKind | null;
  jobStatus: LoggingMessageJobStatus | null;
}

export interface LoggingMessageJobRepairFindingListInput {
  tenantKey?: string | null;
  status?: LoggingMessageJobRepairFindingRecord['status'];
  severity?: LoggingMessageJobRepairFindingRecord['severity'];
  findingType?: LoggingMessageJobRepairFindingRecord['findingType'];
  messageJobId?: string;
  limit?: number;
  offset?: number;
}

export interface LoggingMessageIdempotencyReservation {
  status: 'reserved' | 'duplicate';
  jobId: string;
}

export interface LoggingMessageJobRepairFindingInput {
  id?: string;
  messageJobId: string;
  findingType:
    | 'stuck_claim'
    | 'expired_queued'
    | 'expired_retrying'
    | 'missing_payload_object'
    | 'missing_export_part'
    | 'orphan_staging_object'
    | 'event_job_mismatch'
    | 'blocked_configuration';
  severity: 'info' | 'warning' | 'error' | 'critical';
  status?: 'open' | 'safe_repaired';
  safeAction?: string | null;
  dangerousAction?: string | null;
  impact?: Record<string, unknown> | null;
  now?: number;
}
