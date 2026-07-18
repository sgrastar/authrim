import type { DatabaseAdapter, PreparedStatement } from '@authrim/ar-lib-core/db/adapter';
import type { AdminAgentAuditWrite } from '../audit';
import type {
  AgentBulkPlanDefinition,
  AgentBulkPlanStage,
  AgentBulkPlanStatus,
  AgentBulkTenantExecutionStatus,
  ResolvedAgentBulkPlan,
} from '../bulk';
import type { AgentActorAssurance, AgentMode, JsonObject } from '../types';

interface BulkPlanRow {
  id: string;
  version: number;
  control_tenant_id: string;
  grant_id: string;
  actor_sub: string;
  client_id: string;
  definition_json: string | null;
  definition_digest: string;
  target_snapshot_json: string | null;
  target_snapshot_digest: string;
  canary_tenant_ids_json: string | null;
  canary_digest: string;
  status: AgentBulkPlanStatus;
  stage: AgentBulkPlanStage;
  canary_size: number;
  wave_size: number;
  wave_failure_threshold_bps: number;
  current_wave: number;
  succeeded_count: number;
  failed_count: number;
  indeterminate_count: number;
  pause_reason: string | null;
  expires_at: number;
  payload_purge_at: number;
  payload_purged_at: number | null;
  created_at: number;
  updated_at: number;
  delegator_id: string | null;
  actor_mode: AgentMode | null;
  actor_assurance: AgentActorAssurance | null;
  token_binding: 'bearer' | 'dpop' | null;
  machine_principal_id: string | null;
  machine_credential_id: string | null;
  grant_generation: number;
  consent_version: number;
  approved_by: string | null;
  approved_at: number | null;
  approval_digest: string | null;
  cancelled_at: number | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
}

interface TenantExecutionRow {
  id: string;
  bulk_plan_id: string;
  bulk_plan_version: number;
  target_tenant_id: string;
  target_sequence: number;
  is_canary: number;
  wave_number: number | null;
  stage: AgentBulkPlanStage;
  status: AgentBulkTenantExecutionStatus;
  plan_digest: string;
  child_capability_digest: string | null;
  precondition_snapshot_digest: string | null;
  execution_attempt: number;
  execution_fence: number;
  execution_owner_id: string | null;
  execution_lease_expires_at: number | null;
  idempotency_key: string;
  result_json: string | null;
  result_digest: string | null;
  failure_kind: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  updated_at: number;
  child_capability_expires_at: number | null;
}

export interface AgentBulkPlanRecord {
  id: string;
  version: number;
  controlTenantId: string;
  grantId: string;
  actorSub: string;
  clientId: string;
  definition?: AgentBulkPlanDefinition;
  definitionDigest: string;
  targetTenantIds?: string[];
  targetSnapshotDigest: string;
  canaryTenantIds?: string[];
  canaryDigest: string;
  status: AgentBulkPlanStatus;
  stage: AgentBulkPlanStage;
  canarySize: number;
  waveSize: number;
  waveFailureThresholdBasisPoints: number;
  currentWave: number;
  succeededCount: number;
  failedCount: number;
  indeterminateCount: number;
  pauseReason?: string;
  expiresAt: number;
  payloadPurgeAt: number;
  payloadPurgedAt?: number;
  createdAt: number;
  updatedAt: number;
  delegatorId?: string;
  actorMode?: AgentMode;
  actorAssurance?: AgentActorAssurance;
  tokenBinding?: 'bearer' | 'dpop';
  machinePrincipalId?: string;
  machineCredentialId?: string;
  grantGeneration: number;
  consentVersion: number;
  approvedBy?: string;
  approvedAt?: number;
  approvalDigest?: string;
  cancelledAt?: number;
  cancelledBy?: string;
  cancelReason?: string;
}

export interface AgentBulkTenantExecutionRecord {
  id: string;
  bulkPlanId: string;
  bulkPlanVersion: number;
  targetTenantId: string;
  targetSequence: number;
  isCanary: boolean;
  waveNumber?: number;
  stage: AgentBulkPlanStage;
  status: AgentBulkTenantExecutionStatus;
  planDigest: string;
  childCapabilityDigest?: string;
  preconditionSnapshotDigest?: string;
  executionAttempt: number;
  executionFence: number;
  executionOwnerId?: string;
  executionLeaseExpiresAt?: number;
  idempotencyKey: string;
  result?: JsonObject;
  resultDigest?: string;
  failureKind?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  updatedAt: number;
  childCapabilityExpiresAt?: number;
}

function auditStatement(
  audit: AdminAgentAuditWrite,
  guard?: { from: string; where: string; params: readonly unknown[] }
): PreparedStatement {
  const values = [
    audit.id,
    audit.tenantId,
    audit.adminUserId ?? null,
    audit.action,
    audit.resourceType,
    audit.resourceId,
    audit.result ?? 'success',
    audit.severity,
    audit.requestId ?? null,
    JSON.stringify(audit.metadata),
    audit.createdAt,
    audit.actorType,
    audit.actorSub,
    audit.actorMode ?? null,
    audit.actorAssurance ?? null,
    audit.tokenBinding ?? null,
    audit.actClientId ?? null,
    audit.actPrincipalId ?? null,
    audit.grantId ?? null,
    audit.elevationId ?? null,
    audit.mcpTool ?? null,
  ];
  return {
    sql: `INSERT INTO admin_audit_log (
      id, tenant_id, admin_user_id, action, resource_type, resource_id,
      result, severity, request_id, metadata_json, created_at,
      actor_type, actor_sub, actor_mode, actor_assurance, token_binding,
      act_client_id, act_principal_id, grant_id, elevation_id, mcp_tool
    ) ${guard ? `SELECT ${values.map(() => '?').join(', ')} FROM ${guard.from} WHERE ${guard.where}` : `VALUES (${values.map(() => '?').join(', ')})`}`,
    params: guard ? [...values, ...guard.params] : values,
  };
}

function parseObject<T>(value: string | null): T | undefined {
  return value === null ? undefined : (JSON.parse(value) as T);
}

function bulkPlan(row: BulkPlanRow): AgentBulkPlanRecord {
  return {
    id: row.id,
    version: row.version,
    controlTenantId: row.control_tenant_id,
    grantId: row.grant_id,
    actorSub: row.actor_sub,
    clientId: row.client_id,
    definition: parseObject<AgentBulkPlanDefinition>(row.definition_json),
    definitionDigest: row.definition_digest,
    targetTenantIds: parseObject<string[]>(row.target_snapshot_json),
    targetSnapshotDigest: row.target_snapshot_digest,
    canaryTenantIds: parseObject<string[]>(row.canary_tenant_ids_json),
    canaryDigest: row.canary_digest,
    status: row.status,
    stage: row.stage,
    canarySize: row.canary_size,
    waveSize: row.wave_size,
    waveFailureThresholdBasisPoints: row.wave_failure_threshold_bps,
    currentWave: row.current_wave,
    succeededCount: row.succeeded_count,
    failedCount: row.failed_count,
    indeterminateCount: row.indeterminate_count,
    pauseReason: row.pause_reason ?? undefined,
    expiresAt: row.expires_at,
    payloadPurgeAt: row.payload_purge_at,
    payloadPurgedAt: row.payload_purged_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    delegatorId: row.delegator_id ?? undefined,
    actorMode: row.actor_mode ?? undefined,
    actorAssurance: row.actor_assurance ?? undefined,
    tokenBinding: row.token_binding ?? undefined,
    machinePrincipalId: row.machine_principal_id ?? undefined,
    machineCredentialId: row.machine_credential_id ?? undefined,
    grantGeneration: row.grant_generation,
    consentVersion: row.consent_version,
    approvedBy: row.approved_by ?? undefined,
    approvedAt: row.approved_at ?? undefined,
    approvalDigest: row.approval_digest ?? undefined,
    cancelledAt: row.cancelled_at ?? undefined,
    cancelledBy: row.cancelled_by ?? undefined,
    cancelReason: row.cancel_reason ?? undefined,
  };
}

function tenantExecution(row: TenantExecutionRow): AgentBulkTenantExecutionRecord {
  return {
    id: row.id,
    bulkPlanId: row.bulk_plan_id,
    bulkPlanVersion: row.bulk_plan_version,
    targetTenantId: row.target_tenant_id,
    targetSequence: row.target_sequence,
    isCanary: row.is_canary === 1,
    waveNumber: row.wave_number ?? undefined,
    stage: row.stage,
    status: row.status,
    planDigest: row.plan_digest,
    childCapabilityDigest: row.child_capability_digest ?? undefined,
    preconditionSnapshotDigest: row.precondition_snapshot_digest ?? undefined,
    executionAttempt: row.execution_attempt,
    executionFence: row.execution_fence,
    executionOwnerId: row.execution_owner_id ?? undefined,
    executionLeaseExpiresAt: row.execution_lease_expires_at ?? undefined,
    idempotencyKey: row.idempotency_key,
    result: parseObject<JsonObject>(row.result_json),
    resultDigest: row.result_digest ?? undefined,
    failureKind: row.failure_kind ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    updatedAt: row.updated_at,
    childCapabilityExpiresAt: row.child_capability_expires_at ?? undefined,
  };
}

export class AgentBulkRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async create(input: {
    id: string;
    version: number;
    controlTenantId: string;
    grantId: string;
    actorSub: string;
    clientId: string;
    delegatorId?: string;
    actorMode?: AgentMode;
    actorAssurance?: AgentActorAssurance;
    tokenBinding?: 'bearer' | 'dpop';
    machinePrincipalId?: string;
    machineCredentialId?: string;
    grantGeneration: number;
    consentVersion: number;
    resolved: ResolvedAgentBulkPlan;
    expiresAt: number;
    payloadPurgeAt: number;
    now: number;
    audit: AdminAgentAuditWrite;
  }): Promise<void> {
    const targets = input.resolved.definition.targetTenantIds;
    const canaries = new Set(input.resolved.definition.canaryTenantIds);
    let nonCanary = 0;
    const statements: PreparedStatement[] = [
      {
        sql: `INSERT INTO agent_bulk_plans (
          id, version, control_tenant_id, grant_id, actor_sub, client_id,
          delegator_id, actor_mode, actor_assurance, token_binding,
          machine_principal_id, machine_credential_id, grant_generation, consent_version,
          definition_json, definition_digest, target_snapshot_json, target_snapshot_digest,
          canary_tenant_ids_json, canary_digest, status, stage, canary_size, wave_size,
          wave_failure_threshold_bps, last_transition_id, expires_at, payload_purge_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'validate', ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          input.id,
          input.version,
          input.controlTenantId,
          input.grantId,
          input.actorSub,
          input.clientId,
          input.delegatorId ?? null,
          input.actorMode ?? null,
          input.actorAssurance ?? null,
          input.tokenBinding ?? null,
          input.machinePrincipalId ?? null,
          input.machineCredentialId ?? null,
          input.grantGeneration,
          input.consentVersion,
          JSON.stringify(input.resolved.definition),
          input.resolved.digest,
          JSON.stringify(targets),
          input.resolved.targetSnapshotDigest,
          JSON.stringify(input.resolved.definition.canaryTenantIds),
          input.resolved.canaryDigest,
          input.resolved.rollout.canarySize,
          input.resolved.rollout.waveSize,
          input.resolved.rollout.waveFailureThresholdBasisPoints,
          input.audit.id,
          input.expiresAt,
          input.payloadPurgeAt,
          input.now,
          input.now,
        ],
      },
      ...targets.map((targetTenantId, targetSequence): PreparedStatement => {
        const isCanary = canaries.has(targetTenantId);
        const waveNumber = isCanary
          ? null
          : Math.floor(nonCanary++ / input.resolved.rollout.waveSize) + 1;
        return {
          sql: `INSERT INTO agent_bulk_tenant_executions (
            id, bulk_plan_id, bulk_plan_version, target_tenant_id, target_sequence,
            is_canary, wave_number, stage, status, plan_digest, idempotency_key,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'validate', 'pending', ?, ?, ?, ?)`,
          params: [
            `abte_${input.id}_${input.version}_${targetSequence}`,
            input.id,
            input.version,
            targetTenantId,
            targetSequence,
            isCanary ? 1 : 0,
            waveNumber,
            input.resolved.digest,
            `${input.id}:${input.version}:${targetTenantId}`,
            input.now,
            input.now,
          ],
        };
      }),
      auditStatement(input.audit),
    ];
    await this.adapter.batch(statements);
  }

  async get(
    controlTenantId: string,
    id: string,
    version: number
  ): Promise<AgentBulkPlanRecord | null> {
    const row = await this.adapter.queryOne<BulkPlanRow>(
      'SELECT * FROM agent_bulk_plans WHERE control_tenant_id = ? AND id = ? AND version = ?',
      [controlTenantId, id, version]
    );
    return row ? bulkPlan(row) : null;
  }

  async list(controlTenantId: string): Promise<AgentBulkPlanRecord[]> {
    const rows = await this.adapter.query<BulkPlanRow>(
      'SELECT * FROM agent_bulk_plans WHERE control_tenant_id = ? ORDER BY created_at DESC, id',
      [controlTenantId]
    );
    return rows.map(bulkPlan);
  }

  async listRunning(limit: number = 25): Promise<AgentBulkPlanRecord[]> {
    const rows = await this.adapter.query<BulkPlanRow>(
      `SELECT * FROM agent_bulk_plans WHERE status = 'running' AND cancelled_at IS NULL
       ORDER BY updated_at, control_tenant_id, id LIMIT ?`,
      [limit]
    );
    return rows.map(bulkPlan);
  }

  async listTenantExecutions(
    controlTenantId: string,
    id: string,
    version: number
  ): Promise<AgentBulkTenantExecutionRecord[]> {
    const rows = await this.adapter.query<TenantExecutionRow>(
      `SELECT e.* FROM agent_bulk_tenant_executions e
       JOIN agent_bulk_plans p ON p.id = e.bulk_plan_id AND p.version = e.bulk_plan_version
       WHERE p.control_tenant_id = ? AND e.bulk_plan_id = ? AND e.bulk_plan_version = ?
       ORDER BY e.target_sequence`,
      [controlTenantId, id, version]
    );
    return rows.map(tenantExecution);
  }

  async getTenantExecution(
    controlTenantId: string,
    id: string,
    version: number,
    executionId: string
  ): Promise<AgentBulkTenantExecutionRecord | null> {
    const row = await this.adapter.queryOne<TenantExecutionRow>(
      `SELECT e.* FROM agent_bulk_tenant_executions e
       JOIN agent_bulk_plans p ON p.id = e.bulk_plan_id AND p.version = e.bulk_plan_version
       WHERE p.control_tenant_id = ? AND e.bulk_plan_id = ?
         AND e.bulk_plan_version = ? AND e.id = ?`,
      [controlTenantId, id, version, executionId]
    );
    return row ? tenantExecution(row) : null;
  }

  async startApproved(input: {
    controlTenantId: string;
    id: string;
    version: number;
    definitionDigest: string;
    targetSnapshotDigest: string;
    canaryDigest: string;
    approvedBy: string;
    approvalDigest: string;
    now: number;
    audit: AdminAgentAuditWrite;
  }): Promise<boolean> {
    const results = await this.adapter.batch([
      {
        sql: `UPDATE agent_bulk_plans SET status = 'running', stage = 'validate',
          approved_by = ?, approved_at = ?, approval_digest = ?, last_transition_id = ?,
          updated_at = ? WHERE control_tenant_id = ? AND id = ? AND version = ?
          AND status = 'ready' AND definition_digest = ? AND target_snapshot_digest = ?
          AND canary_digest = ? AND expires_at > ? AND cancelled_at IS NULL`,
        params: [
          input.approvedBy,
          input.now,
          input.approvalDigest,
          input.audit.id,
          input.now,
          input.controlTenantId,
          input.id,
          input.version,
          input.definitionDigest,
          input.targetSnapshotDigest,
          input.canaryDigest,
          input.now,
        ],
      },
      auditStatement(input.audit, {
        from: 'agent_bulk_plans',
        where: 'control_tenant_id = ? AND id = ? AND version = ? AND last_transition_id = ?',
        params: [input.controlTenantId, input.id, input.version, input.audit.id],
      }),
    ]);
    return (results[0]?.rowsAffected ?? 0) === 1;
  }

  async transition(input: {
    controlTenantId: string;
    id: string;
    version: number;
    from: AgentBulkPlanStatus;
    to: AgentBulkPlanStatus;
    stage: AgentBulkPlanStage;
    pauseReason?: string;
    now: number;
    audit: AdminAgentAuditWrite;
  }): Promise<boolean> {
    const results = await this.adapter.batch([
      {
        sql: `UPDATE agent_bulk_plans SET status = ?, stage = ?, pause_reason = ?,
          last_transition_id = ?, updated_at = ?,
          payload_purge_at = CASE WHEN ? = 'completed'
            THEN MIN(payload_purge_at, ?) ELSE payload_purge_at END
         WHERE control_tenant_id = ? AND id = ? AND version = ? AND status = ?
           AND cancelled_at IS NULL`,
        params: [
          input.to,
          input.stage,
          input.pauseReason ?? null,
          input.audit.id,
          input.now,
          input.to,
          input.now + 30 * 24 * 60 * 60_000,
          input.controlTenantId,
          input.id,
          input.version,
          input.from,
        ],
      },
      auditStatement(input.audit, {
        from: 'agent_bulk_plans',
        where: 'control_tenant_id = ? AND id = ? AND version = ? AND last_transition_id = ?',
        params: [input.controlTenantId, input.id, input.version, input.audit.id],
      }),
    ]);
    return (results[0]?.rowsAffected ?? 0) === 1;
  }

  async cancel(input: {
    controlTenantId: string;
    id: string;
    version: number;
    cancelledBy: string;
    reason: string;
    now: number;
    audit: AdminAgentAuditWrite;
  }): Promise<boolean> {
    const results = await this.adapter.batch([
      {
        sql: `UPDATE agent_bulk_plans SET cancelled_at = ?, cancelled_by = ?,
          cancel_reason = ?, indeterminate_count = indeterminate_count + (
            SELECT COUNT(*) FROM agent_bulk_tenant_executions e
             WHERE e.bulk_plan_id = agent_bulk_plans.id
               AND e.bulk_plan_version = agent_bulk_plans.version AND e.status = 'running'
          ), last_transition_id = ?, updated_at = ?,
          payload_purge_at = MIN(payload_purge_at, ?)
         WHERE control_tenant_id = ? AND id = ? AND version = ?
           AND status IN ('draft', 'ready', 'running', 'paused') AND cancelled_at IS NULL`,
        params: [
          input.now,
          input.cancelledBy,
          input.reason,
          input.audit.id,
          input.now,
          input.now + 30 * 24 * 60 * 60_000,
          input.controlTenantId,
          input.id,
          input.version,
        ],
      },
      {
        sql: `UPDATE agent_bulk_tenant_executions SET status = 'indeterminate',
          failure_kind = 'plan_cancelled', completed_at = ?, updated_at = ?,
          execution_owner_id = NULL, execution_lease_expires_at = NULL,
          child_capability_digest = NULL, child_capability_expires_at = NULL
         WHERE bulk_plan_id = ? AND bulk_plan_version = ? AND status = 'running'
           AND EXISTS (SELECT 1 FROM agent_bulk_plans p
             WHERE p.id = agent_bulk_tenant_executions.bulk_plan_id
               AND p.version = agent_bulk_tenant_executions.bulk_plan_version
               AND p.control_tenant_id = ? AND p.cancelled_at = ?)`,
        params: [input.now, input.now, input.id, input.version, input.controlTenantId, input.now],
      },
      auditStatement(input.audit, {
        from: 'agent_bulk_plans',
        where: 'control_tenant_id = ? AND id = ? AND version = ? AND last_transition_id = ?',
        params: [input.controlTenantId, input.id, input.version, input.audit.id],
      }),
    ]);
    return (results[0]?.rowsAffected ?? 0) === 1;
  }

  async setRunningProgress(input: {
    controlTenantId: string;
    id: string;
    version: number;
    stage: AgentBulkPlanStage;
    currentWave: number;
    now: number;
  }): Promise<boolean> {
    const result = await this.adapter.execute(
      `UPDATE agent_bulk_plans SET stage = ?, current_wave = ?, updated_at = ?
       WHERE control_tenant_id = ? AND id = ? AND version = ? AND status = 'running'
         AND cancelled_at IS NULL`,
      [input.stage, input.currentWave, input.now, input.controlTenantId, input.id, input.version]
    );
    return result.rowsAffected === 1;
  }

  async claimTenant(input: {
    controlTenantId: string;
    bulkPlanId: string;
    bulkPlanVersion: number;
    executionId: string;
    expectedStage: AgentBulkPlanStage;
    ownerId: string;
    leaseExpiresAt: number;
    childCapabilityDigest: string;
    childCapabilityExpiresAt: number;
    now: number;
  }): Promise<boolean> {
    const result = await this.adapter.execute(
      `UPDATE agent_bulk_tenant_executions SET status = 'running',
        execution_attempt = execution_attempt + 1, execution_fence = execution_fence + 1,
        execution_owner_id = ?, execution_lease_expires_at = ?, child_capability_digest = ?,
        child_capability_expires_at = ?,
        started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ? AND bulk_plan_id = ? AND bulk_plan_version = ? AND status = 'pending'
         AND stage = ? AND EXISTS (
           SELECT 1 FROM agent_bulk_plans p
           WHERE p.id = agent_bulk_tenant_executions.bulk_plan_id
             AND p.version = agent_bulk_tenant_executions.bulk_plan_version
             AND p.control_tenant_id = ? AND p.status = 'running' AND p.cancelled_at IS NULL
         )`,
      [
        input.ownerId,
        input.leaseExpiresAt,
        input.childCapabilityDigest,
        input.childCapabilityExpiresAt,
        input.now,
        input.now,
        input.executionId,
        input.bulkPlanId,
        input.bulkPlanVersion,
        input.expectedStage,
        input.controlTenantId,
      ]
    );
    return result.rowsAffected === 1;
  }

  async advanceTenantStage(input: {
    controlTenantId: string;
    bulkPlanId: string;
    bulkPlanVersion: number;
    executionId: string;
    executionAttempt: number;
    executionFence: number;
    from: AgentBulkPlanStage;
    to: AgentBulkPlanStage;
    preconditionSnapshotDigest?: string;
    checkpoint?: JsonObject;
    checkpointDigest?: string;
    now: number;
    audit: AdminAgentAuditWrite;
  }): Promise<boolean> {
    const results = await this.adapter.batch([
      {
        sql: `UPDATE agent_bulk_tenant_executions SET status = 'pending', stage = ?,
          precondition_snapshot_digest = COALESCE(?, precondition_snapshot_digest),
          result_json = COALESCE(?, result_json), result_digest = COALESCE(?, result_digest),
          execution_owner_id = NULL, execution_lease_expires_at = NULL,
          child_capability_digest = NULL, child_capability_expires_at = NULL,
          last_transition_id = ?, updated_at = ?
         WHERE id = ? AND bulk_plan_id = ? AND bulk_plan_version = ? AND status = 'running'
           AND stage = ? AND execution_attempt = ? AND execution_fence = ?
           AND EXISTS (SELECT 1 FROM agent_bulk_plans p
             WHERE p.id = agent_bulk_tenant_executions.bulk_plan_id
               AND p.version = agent_bulk_tenant_executions.bulk_plan_version
               AND p.control_tenant_id = ? AND p.status = 'running'
               AND p.cancelled_at IS NULL)`,
        params: [
          input.to,
          input.preconditionSnapshotDigest ?? null,
          input.checkpoint ? JSON.stringify(input.checkpoint) : null,
          input.checkpointDigest ?? null,
          input.audit.id,
          input.now,
          input.executionId,
          input.bulkPlanId,
          input.bulkPlanVersion,
          input.from,
          input.executionAttempt,
          input.executionFence,
          input.controlTenantId,
        ],
      },
      auditStatement(input.audit, {
        from: 'agent_bulk_tenant_executions',
        where: 'id = ? AND last_transition_id = ?',
        params: [input.executionId, input.audit.id],
      }),
    ]);
    return (results[0]?.rowsAffected ?? 0) === 1;
  }

  async listRunnableTenantExecutions(input: {
    controlTenantId: string;
    bulkPlanId: string;
    bulkPlanVersion: number;
  }): Promise<AgentBulkTenantExecutionRecord[]> {
    const plan = await this.get(input.controlTenantId, input.bulkPlanId, input.bulkPlanVersion);
    if (!plan || plan.status !== 'running' || plan.cancelledAt !== undefined) return [];
    const executions = await this.listTenantExecutions(
      input.controlTenantId,
      input.bulkPlanId,
      input.bulkPlanVersion
    );
    const pending = executions.filter((execution) => execution.status === 'pending');

    // Every target must validate before the first canary is allowed to apply.
    const validation = pending.filter((execution) => execution.stage === 'validate');
    if (validation.length > 0) return validation.slice(0, Math.max(plan.waveSize, plan.canarySize));
    if (executions.some((execution) => execution.stage === 'validate')) return [];

    const groupRunnable = (group: AgentBulkTenantExecutionRecord[]) => {
      const apply = group.filter(
        (execution) => execution.status === 'pending' && execution.stage === 'apply'
      );
      if (apply.length > 0) return apply;
      if (group.some((execution) => execution.status === 'running')) return [];
      return group.filter(
        (execution) => execution.status === 'pending' && execution.stage === 'verify'
      );
    };

    const canaries = executions.filter((execution) => execution.isCanary);
    if (canaries.some((execution) => execution.status !== 'succeeded')) {
      return groupRunnable(canaries).slice(0, plan.canarySize);
    }

    const waveNumbers = [
      ...new Set(
        executions
          .filter((execution) => !execution.isCanary && execution.waveNumber !== undefined)
          .map((execution) => execution.waveNumber!)
      ),
    ].sort((a, b) => a - b);
    for (const waveNumber of waveNumbers) {
      const group = executions.filter((execution) => execution.waveNumber === waveNumber);
      if (
        group.every(
          (execution) => execution.status === 'succeeded' || execution.status === 'failed'
        )
      ) {
        continue;
      }
      if (group.some((execution) => execution.status !== 'succeeded')) {
        return groupRunnable(group).slice(0, plan.waveSize);
      }
    }
    return [];
  }

  async completeTenant(input: {
    controlTenantId: string;
    bulkPlanId: string;
    bulkPlanVersion: number;
    executionId: string;
    executionAttempt: number;
    executionFence: number;
    status: Extract<AgentBulkTenantExecutionStatus, 'succeeded' | 'failed' | 'indeterminate'>;
    result?: JsonObject;
    resultDigest?: string;
    failureKind?: string;
    now: number;
    audit: AdminAgentAuditWrite;
  }): Promise<boolean> {
    const counter =
      input.status === 'succeeded'
        ? 'succeeded_count'
        : input.status === 'failed'
          ? 'failed_count'
          : 'indeterminate_count';
    const results = await this.adapter.batch([
      {
        sql: `UPDATE agent_bulk_tenant_executions SET status = ?, result_json = ?,
          result_digest = ?, failure_kind = ?, completed_at = ?, updated_at = ?,
          last_transition_id = ?
         WHERE id = ? AND bulk_plan_id = ? AND bulk_plan_version = ? AND status = 'running'
           AND execution_attempt = ? AND execution_fence = ?`,
        params: [
          input.status,
          input.result ? JSON.stringify(input.result) : null,
          input.resultDigest ?? null,
          input.failureKind ?? null,
          input.now,
          input.now,
          input.audit.id,
          input.executionId,
          input.bulkPlanId,
          input.bulkPlanVersion,
          input.executionAttempt,
          input.executionFence,
        ],
      },
      {
        sql: `UPDATE agent_bulk_plans SET ${counter} = ${counter} + 1, updated_at = ?
         WHERE control_tenant_id = ? AND id = ? AND version = ? AND status = 'running'
           AND EXISTS (SELECT 1 FROM agent_bulk_tenant_executions
             WHERE id = ? AND last_transition_id = ?)`,
        params: [
          input.now,
          input.controlTenantId,
          input.bulkPlanId,
          input.bulkPlanVersion,
          input.executionId,
          input.audit.id,
        ],
      },
      auditStatement(input.audit, {
        from: 'agent_bulk_tenant_executions',
        where: 'id = ? AND last_transition_id = ?',
        params: [input.executionId, input.audit.id],
      }),
    ]);
    return (results[0]?.rowsAffected ?? 0) === 1 && (results[1]?.rowsAffected ?? 0) === 1;
  }

  async purgePayloads(now: number, limit: number = 100): Promise<number> {
    const result = await this.adapter.execute(
      `UPDATE agent_bulk_plans SET definition_json = NULL, target_snapshot_json = NULL,
        canary_tenant_ids_json = NULL, payload_purged_at = ?, updated_at = ?
       WHERE rowid IN (SELECT rowid FROM agent_bulk_plans
         WHERE payload_purged_at IS NULL AND payload_purge_at <= ? LIMIT ?)`,
      [now, now, now, limit]
    );
    return result.rowsAffected;
  }
}
