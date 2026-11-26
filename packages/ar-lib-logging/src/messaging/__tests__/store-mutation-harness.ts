import { vi } from 'vitest';
import { SqlLoggingMessageJobStore, type LoggingMessageSqlExecutor } from '../store';

/** A store over a recording executor: every query, queryOne and execute call is observable. */
export function storeHarness(options: { maxDepth?: number; rowsAffected?: unknown } = {}) {
  const query = vi.fn(async (_sql: string, _params?: unknown[]): Promise<unknown[]> => []);
  const queryOne = vi.fn(async (_sql: string, _params?: unknown[]): Promise<unknown> => null);
  const execute = vi.fn(
    async (_sql: string, _params?: unknown[]): Promise<unknown> =>
      'rowsAffected' in options ? options.rowsAffected : { rowsAffected: 1 }
  );
  const executor = { query, queryOne, execute } as unknown as LoggingMessageSqlExecutor;
  const store = new SqlLoggingMessageJobStore(
    executor,
    options.maxDepth === undefined ? undefined : { maxDepth: options.maxDepth }
  );
  return { store, query, queryOne, execute };
}

/** The arguments of the nth call of a mock, as a typed pair. */
export function callAt(
  mock: { mock: { calls: Array<[string, unknown[]?]> } },
  index = 0
): { sql: string; params: unknown[] } {
  const call = mock.mock.calls[index];
  if (!call) throw new Error(`no call ${index}`);
  return { sql: call[0], params: call[1] ?? [] };
}

/** A stored job row with every column set to a distinct value. */
export function fullJobRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'job-1',
    kind: 'retry_delivery',
    status: 'queued',
    lane: 'default',
    criticality: 'critical',
    priority: 3,
    tenant_id: 'tenant-1',
    tenant_key: 'tkey-1',
    topology_type: 'external_db',
    database_binding_ref: 'db-1',
    connection_ref: 'conn-1',
    topology_snapshot_version: 'v1',
    topology_resolved_at: 11,
    scope_type: 'tenant',
    scope_id: 'scope-1',
    scope_key: 'tenant:tkey-1',
    source_type: 'dlq_item',
    source_id: 'src-1',
    root_job_id: 'root-1',
    parent_job_id: 'parent-1',
    depth: 2,
    payload_object_ref: 'ref-1',
    payload_sha256: 'sha-1',
    payload_type: 'ptype',
    payload_schema_version: 4,
    redacted_summary_json: '{"a":1}',
    validation_summary_json: '{"b":2}',
    idempotency_key: 'idem-1',
    dedupe_until: 12,
    not_before: 13,
    attempt_count: 1,
    max_attempts: 6,
    attempt_policy_json: '{"maxAttempts":6,"leaseTimeoutMs":7}',
    claim_token: 'claim-1',
    claimed_at: 14,
    claimed_until: 15,
    requested_by: 'admin-1',
    reason: 'because',
    error_class: 'eclass',
    last_error: 'elast',
    blocked_reason: 'blocked',
    cancel_requested_at: 16,
    cancelled_by: 'admin-2',
    created_at: 17,
    updated_at: 18,
    started_at: 19,
    completed_at: 20,
    expires_at: 21,
    ...overrides,
  };
}

export const fullJobRecord = {
  id: 'job-1',
  kind: 'retry_delivery',
  status: 'queued',
  lane: 'default',
  criticality: 'critical',
  priority: 3,
  tenantId: 'tenant-1',
  tenantKey: 'tkey-1',
  topologyType: 'external_db',
  databaseBindingRef: 'db-1',
  connectionRef: 'conn-1',
  topologySnapshotVersion: 'v1',
  topologyResolvedAt: 11,
  scopeType: 'tenant',
  scopeId: 'scope-1',
  scopeKey: 'tenant:tkey-1',
  sourceType: 'dlq_item',
  sourceId: 'src-1',
  rootJobId: 'root-1',
  parentJobId: 'parent-1',
  depth: 2,
  payloadObjectRef: 'ref-1',
  payloadSha256: 'sha-1',
  payloadType: 'ptype',
  payloadSchemaVersion: 4,
  redactedSummary: { a: 1 },
  validationSummary: { b: 2 },
  idempotencyKey: 'idem-1',
  dedupeUntil: 12,
  notBefore: 13,
  attemptCount: 1,
  maxAttempts: 6,
  attemptPolicy: { maxAttempts: 6, leaseTimeoutMs: 7 },
  claimToken: 'claim-1',
  claimedAt: 14,
  claimedUntil: 15,
  requestedBy: 'admin-1',
  reason: 'because',
  errorClass: 'eclass',
  lastError: 'elast',
  blockedReason: 'blocked',
  cancelRequestedAt: 16,
  cancelledBy: 'admin-2',
  createdAt: 17,
  updatedAt: 18,
  startedAt: 19,
  completedAt: 20,
  expiresAt: 21,
};
