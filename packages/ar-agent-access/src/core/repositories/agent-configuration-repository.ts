import type { DatabaseAdapter, PreparedStatement } from '@authrim/ar-lib-core/db/adapter';
import type { AdminAgentAuditWrite } from '../audit';
import type {
  AgentConfigurationPlanDefinition,
  AgentScopePolicyDefinition,
  ResolvedAgentTaskSetVersion,
} from '../configuration';
import type { AgentPlanStage, AgentPlanStatus } from '../plans';
import type { AgentRiskLevel, JsonObject } from '../types';

export interface AgentTaskSetRecord {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  kind: 'builtin' | 'custom' | 'template_copy';
  status: 'active' | 'archived';
  currentVersion: number;
  version: ResolvedAgentTaskSetVersion;
  createdAt: number;
  updatedAt: number;
}

export interface AgentScopePolicyRecord {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  kind: 'builtin' | 'custom' | 'template_copy';
  status: 'active' | 'archived';
  currentVersion: number;
  definition: AgentScopePolicyDefinition;
  definitionDigest: string;
  selectorCatalogVersion: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentConfigurationPlanRecord {
  id: string;
  version: number;
  tenantId: string;
  grantId: string;
  grantGeneration: number;
  consentVersion: number;
  actorSub: string;
  clientId: string;
  definition?: AgentConfigurationPlanDefinition;
  definitionDigest: string;
  snapshot?: JsonObject;
  diff?: JsonObject;
  validation?: JsonObject;
  result?: JsonObject;
  status: AgentPlanStatus;
  stage: AgentPlanStage;
  appliedStepCount: number;
  failedStepId?: string;
  failureKind?: string;
  confirmationId?: string;
  expiresAt: number;
  cancelledAt?: number;
  cancelledBy?: string;
  cancelReason?: string;
  payloadPurgeAt: number;
  payloadPurgedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentPlanConfirmationRecord {
  id: string;
  tenantId: string;
  planId: string;
  planVersion: number;
  planDigest: string;
  grantId: string;
  actorSub: string;
  confirmedBy?: string;
  status: 'pending' | 'confirmed' | 'consumed' | 'denied';
  expiresAt: number;
}

export interface CreateAgentTaskSetInput {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  kind: AgentTaskSetRecord['kind'];
  resolved: ResolvedAgentTaskSetVersion;
  createdBy: string;
  now: number;
  audit: AdminAgentAuditWrite;
}

export interface CreateAgentScopePolicyInput {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  kind: AgentScopePolicyRecord['kind'];
  definition: AgentScopePolicyDefinition;
  definitionDigest: string;
  selectorCatalogVersion: string;
  createdBy: string;
  now: number;
  audit: AdminAgentAuditWrite;
}

export interface AgentSecretRefRecord {
  id: string;
  tenantId: string;
  resourceType: string;
  resourceId?: string;
  purpose: string;
  status: 'active' | 'revoked' | 'expired';
  createdBy: string;
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
  revokedBy?: string;
}

export interface ResolvedAgentSecretRef extends AgentSecretRefRecord {
  providerKey: string;
}

export interface CreateAgentConfigurationPlanInput {
  id: string;
  version: number;
  tenantId: string;
  grantId: string;
  grantGeneration: number;
  consentVersion: number;
  actorSub: string;
  clientId: string;
  definition: AgentConfigurationPlanDefinition;
  definitionDigest: string;
  risks: readonly AgentRiskLevel[];
  expiresAt: number;
  payloadPurgeAt: number;
  now: number;
  audit: AdminAgentAuditWrite;
}

interface TaskSetRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  kind: AgentTaskSetRecord['kind'];
  status: AgentTaskSetRecord['status'];
  current_version: number;
  tool_entries_json: string;
  resolved_permissions_json: string;
  definition_digest: string;
  catalog_version: string;
  created_at: number;
  updated_at: number;
}

interface ScopePolicyRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  kind: AgentScopePolicyRecord['kind'];
  status: AgentScopePolicyRecord['status'];
  current_version: number;
  definition_json: string;
  definition_digest: string;
  selector_catalog_version: string;
  created_at: number;
  updated_at: number;
}

interface PlanRow {
  id: string;
  version: number;
  tenant_id: string;
  grant_id: string;
  grant_generation: number;
  consent_version: number;
  actor_sub: string;
  client_id: string;
  definition_json: string | null;
  snapshot_json: string | null;
  diff_json: string | null;
  validation_json: string | null;
  result_json: string | null;
  definition_digest: string;
  status: AgentPlanStatus;
  stage: AgentPlanStage;
  applied_step_count: number;
  failed_step_id: string | null;
  failure_kind: string | null;
  confirmation_id: string | null;
  expires_at: number;
  cancelled_at: number | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  payload_purge_at: number;
  payload_purged_at: number | null;
  created_at: number;
  updated_at: number;
}

function jsonObject(value: string | null): JsonObject | undefined {
  if (value === null) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('Stored Agent configuration JSON is invalid');
  }
  return parsed as JsonObject;
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

function taskSet(row: TaskSetRow): AgentTaskSetRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description ?? undefined,
    kind: row.kind,
    status: row.status,
    currentVersion: row.current_version,
    version: {
      tools: JSON.parse(row.tool_entries_json) as ResolvedAgentTaskSetVersion['tools'],
      permissions: JSON.parse(
        row.resolved_permissions_json
      ) as ResolvedAgentTaskSetVersion['permissions'],
      digest: row.definition_digest,
      catalogVersion: row.catalog_version,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function scopePolicy(row: ScopePolicyRow): AgentScopePolicyRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description ?? undefined,
    kind: row.kind,
    status: row.status,
    currentVersion: row.current_version,
    definition: JSON.parse(row.definition_json) as AgentScopePolicyDefinition,
    definitionDigest: row.definition_digest,
    selectorCatalogVersion: row.selector_catalog_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function plan(row: PlanRow): AgentConfigurationPlanRecord {
  const definition = jsonObject(row.definition_json);
  return {
    id: row.id,
    version: row.version,
    tenantId: row.tenant_id,
    grantId: row.grant_id,
    grantGeneration: row.grant_generation,
    consentVersion: row.consent_version,
    actorSub: row.actor_sub,
    clientId: row.client_id,
    definition: definition as unknown as AgentConfigurationPlanDefinition | undefined,
    definitionDigest: row.definition_digest,
    snapshot: jsonObject(row.snapshot_json),
    diff: jsonObject(row.diff_json),
    validation: jsonObject(row.validation_json),
    result: jsonObject(row.result_json),
    status: row.status,
    stage: row.stage,
    appliedStepCount: row.applied_step_count,
    failedStepId: row.failed_step_id ?? undefined,
    failureKind: row.failure_kind ?? undefined,
    confirmationId: row.confirmation_id ?? undefined,
    expiresAt: row.expires_at,
    cancelledAt: row.cancelled_at ?? undefined,
    cancelledBy: row.cancelled_by ?? undefined,
    cancelReason: row.cancel_reason ?? undefined,
    payloadPurgeAt: row.payload_purge_at,
    payloadPurgedAt: row.payload_purged_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** DB_ADMIN repository using the existing cross-platform DatabaseAdapter. */
export class AgentConfigurationRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async writeAudit(audit: AdminAgentAuditWrite): Promise<void> {
    const statement = auditStatement(audit);
    await this.adapter.execute(statement.sql, statement.params);
  }

  async isActiveTenant(tenantId: string): Promise<boolean> {
    const row = await this.adapter.queryOne<{ id: string }>(
      `SELECT id FROM tenants WHERE id = ? AND lifecycle_state = 'active' LIMIT 1`,
      [tenantId]
    );
    return row?.id === tenantId;
  }

  async createTaskSet(input: CreateAgentTaskSetInput): Promise<void> {
    await this.adapter.batch([
      {
        sql: `INSERT INTO agent_task_sets (
          id, tenant_id, name, description, kind, status, current_version,
          created_by, last_transition_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)`,
        params: [
          input.id,
          input.tenantId,
          input.name,
          input.description ?? null,
          input.kind,
          input.createdBy,
          input.audit.id,
          input.now,
          input.now,
        ],
      },
      {
        sql: `INSERT INTO agent_task_set_versions (
          task_set_id, version, tool_entries_json, resolved_permissions_json,
          definition_digest, catalog_version, status, created_by, created_at
        ) VALUES (?, 1, ?, ?, ?, ?, 'active', ?, ?)`,
        params: [
          input.id,
          JSON.stringify(input.resolved.tools),
          JSON.stringify(input.resolved.permissions),
          input.resolved.digest,
          input.resolved.catalogVersion,
          input.createdBy,
          input.now,
        ],
      },
      auditStatement(input.audit),
    ]);
  }

  async listTaskSets(tenantId: string): Promise<AgentTaskSetRecord[]> {
    const rows = await this.adapter.query<TaskSetRow>(
      `SELECT s.id, s.tenant_id, s.name, s.description, s.kind, s.status,
        s.current_version, v.tool_entries_json, v.resolved_permissions_json,
        v.definition_digest, v.catalog_version, s.created_at, s.updated_at
       FROM agent_task_sets s JOIN agent_task_set_versions v
        ON v.task_set_id = s.id AND v.version = s.current_version
       WHERE s.tenant_id = ? ORDER BY s.name, s.id`,
      [tenantId]
    );
    return rows.map(taskSet);
  }

  async getTaskSet(tenantId: string, id: string): Promise<AgentTaskSetRecord | null> {
    const rows = await this.listTaskSets(tenantId);
    return rows.find((item) => item.id === id) ?? null;
  }

  async getTaskSetVersion(
    tenantId: string,
    id: string,
    version: number
  ): Promise<AgentTaskSetRecord | null> {
    const row = await this.adapter.queryOne<TaskSetRow>(
      `SELECT s.id, s.tenant_id, s.name, s.description, s.kind, s.status,
        s.current_version, v.tool_entries_json, v.resolved_permissions_json,
        v.definition_digest, v.catalog_version, s.created_at, s.updated_at
       FROM agent_task_sets s JOIN agent_task_set_versions v ON v.task_set_id = s.id
       WHERE s.tenant_id = ? AND s.id = ? AND v.version = ? AND v.status = 'active'`,
      [tenantId, id, version]
    );
    return row ? { ...taskSet(row), currentVersion: version } : null;
  }

  async createScopePolicy(input: CreateAgentScopePolicyInput): Promise<void> {
    await this.adapter.batch([
      {
        sql: `INSERT INTO agent_scope_policies (
          id, tenant_id, name, description, kind, status, current_version,
          created_by, last_transition_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)`,
        params: [
          input.id,
          input.tenantId,
          input.name,
          input.description ?? null,
          input.kind,
          input.createdBy,
          input.audit.id,
          input.now,
          input.now,
        ],
      },
      {
        sql: `INSERT INTO agent_scope_policy_versions (
          scope_policy_id, version, definition_json, definition_digest,
          selector_catalog_version, status, created_by, created_at
        ) VALUES (?, 1, ?, ?, ?, 'active', ?, ?)`,
        params: [
          input.id,
          JSON.stringify(input.definition),
          input.definitionDigest,
          input.selectorCatalogVersion,
          input.createdBy,
          input.now,
        ],
      },
      auditStatement(input.audit),
    ]);
  }

  async listScopePolicies(tenantId: string): Promise<AgentScopePolicyRecord[]> {
    const rows = await this.adapter.query<ScopePolicyRow>(
      `SELECT p.id, p.tenant_id, p.name, p.description, p.kind, p.status,
        p.current_version, v.definition_json, v.definition_digest,
        v.selector_catalog_version, p.created_at, p.updated_at
       FROM agent_scope_policies p JOIN agent_scope_policy_versions v
        ON v.scope_policy_id = p.id AND v.version = p.current_version
       WHERE p.tenant_id = ? ORDER BY p.name, p.id`,
      [tenantId]
    );
    return rows.map(scopePolicy);
  }

  async createTaskSetVersion(input: {
    tenantId: string;
    id: string;
    expectedVersion: number;
    resolved: ResolvedAgentTaskSetVersion;
    createdBy: string;
    now: number;
    audit: AdminAgentAuditWrite;
  }): Promise<boolean> {
    const version = input.expectedVersion + 1;
    const results = await this.adapter.batch([
      {
        sql: `UPDATE agent_task_sets SET current_version = ?, last_transition_id = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ? AND status = 'active' AND current_version = ?`,
        params: [
          version,
          input.audit.id,
          input.now,
          input.tenantId,
          input.id,
          input.expectedVersion,
        ],
      },
      {
        sql: `INSERT INTO agent_task_set_versions (
          task_set_id, version, tool_entries_json, resolved_permissions_json,
          definition_digest, catalog_version, status, created_by, created_at
        ) SELECT id, ?, ?, ?, ?, ?, 'active', ?, ? FROM agent_task_sets
          WHERE tenant_id = ? AND id = ? AND last_transition_id = ?`,
        params: [
          version,
          JSON.stringify(input.resolved.tools),
          JSON.stringify(input.resolved.permissions),
          input.resolved.digest,
          input.resolved.catalogVersion,
          input.createdBy,
          input.now,
          input.tenantId,
          input.id,
          input.audit.id,
        ],
      },
      auditStatement(input.audit, {
        from: 'agent_task_sets',
        where: 'tenant_id = ? AND id = ? AND last_transition_id = ?',
        params: [input.tenantId, input.id, input.audit.id],
      }),
    ]);
    return (results[0]?.rowsAffected ?? 0) === 1;
  }

  async suspendTaskSetVersion(input: {
    tenantId: string;
    id: string;
    version: number;
    audit: AdminAgentAuditWrite;
  }): Promise<boolean> {
    const results = await this.adapter.batch([
      {
        sql: `UPDATE agent_task_set_versions SET status = 'suspended', last_transition_id = ?
         WHERE task_set_id = ? AND version = ? AND status = 'active'
           AND EXISTS (SELECT 1 FROM agent_task_sets
             WHERE id = agent_task_set_versions.task_set_id AND tenant_id = ?)`,
        params: [input.audit.id, input.id, input.version, input.tenantId],
      },
      auditStatement(input.audit, {
        from: 'agent_task_set_versions v JOIN agent_task_sets s ON s.id = v.task_set_id',
        where:
          's.tenant_id = ? AND v.task_set_id = ? AND v.version = ? AND v.last_transition_id = ?',
        params: [input.tenantId, input.id, input.version, input.audit.id],
      }),
    ]);
    return (results[0]?.rowsAffected ?? 0) === 1;
  }

  async createScopePolicyVersion(input: {
    tenantId: string;
    id: string;
    expectedVersion: number;
    definition: AgentScopePolicyDefinition;
    definitionDigest: string;
    selectorCatalogVersion: string;
    createdBy: string;
    now: number;
    audit: AdminAgentAuditWrite;
  }): Promise<boolean> {
    const version = input.expectedVersion + 1;
    const results = await this.adapter.batch([
      {
        sql: `UPDATE agent_scope_policies SET current_version = ?, last_transition_id = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ? AND status = 'active' AND current_version = ?`,
        params: [
          version,
          input.audit.id,
          input.now,
          input.tenantId,
          input.id,
          input.expectedVersion,
        ],
      },
      {
        sql: `INSERT INTO agent_scope_policy_versions (
          scope_policy_id, version, definition_json, definition_digest,
          selector_catalog_version, status, created_by, created_at
        ) SELECT id, ?, ?, ?, ?, 'active', ?, ? FROM agent_scope_policies
          WHERE tenant_id = ? AND id = ? AND last_transition_id = ?`,
        params: [
          version,
          JSON.stringify(input.definition),
          input.definitionDigest,
          input.selectorCatalogVersion,
          input.createdBy,
          input.now,
          input.tenantId,
          input.id,
          input.audit.id,
        ],
      },
      auditStatement(input.audit, {
        from: 'agent_scope_policies',
        where: 'tenant_id = ? AND id = ? AND last_transition_id = ?',
        params: [input.tenantId, input.id, input.audit.id],
      }),
    ]);
    return (results[0]?.rowsAffected ?? 0) === 1;
  }

  async suspendScopePolicyVersion(input: {
    tenantId: string;
    id: string;
    version: number;
    audit: AdminAgentAuditWrite;
  }): Promise<boolean> {
    const results = await this.adapter.batch([
      {
        sql: `UPDATE agent_scope_policy_versions SET status = 'suspended', last_transition_id = ?
         WHERE scope_policy_id = ? AND version = ? AND status = 'active'
           AND EXISTS (SELECT 1 FROM agent_scope_policies
             WHERE id = agent_scope_policy_versions.scope_policy_id AND tenant_id = ?)`,
        params: [input.audit.id, input.id, input.version, input.tenantId],
      },
      auditStatement(input.audit, {
        from: 'agent_scope_policy_versions v JOIN agent_scope_policies p ON p.id = v.scope_policy_id',
        where:
          'p.tenant_id = ? AND v.scope_policy_id = ? AND v.version = ? AND v.last_transition_id = ?',
        params: [input.tenantId, input.id, input.version, input.audit.id],
      }),
    ]);
    return (results[0]?.rowsAffected ?? 0) === 1;
  }

  async getScopePolicy(tenantId: string, id: string): Promise<AgentScopePolicyRecord | null> {
    const rows = await this.listScopePolicies(tenantId);
    return rows.find((item) => item.id === id) ?? null;
  }

  async getScopePolicyVersion(
    tenantId: string,
    id: string,
    version: number
  ): Promise<AgentScopePolicyRecord | null> {
    const row = await this.adapter.queryOne<ScopePolicyRow>(
      `SELECT p.id, p.tenant_id, p.name, p.description, p.kind, p.status,
        p.current_version, v.definition_json, v.definition_digest,
        v.selector_catalog_version, p.created_at, p.updated_at
       FROM agent_scope_policies p JOIN agent_scope_policy_versions v
        ON v.scope_policy_id = p.id
       WHERE p.tenant_id = ? AND p.id = ? AND v.version = ? AND v.status = 'active'`,
      [tenantId, id, version]
    );
    return row ? { ...scopePolicy(row), currentVersion: version } : null;
  }

  async createPlan(input: CreateAgentConfigurationPlanInput): Promise<void> {
    const planStatement: PreparedStatement = {
      sql: `INSERT INTO agent_configuration_plans (
        id, version, tenant_id, grant_id, grant_generation, consent_version,
        actor_sub, client_id, definition_json,
        definition_digest, status, stage, last_transition_id, expires_at, payload_purge_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'validate', ?, ?, ?, ?, ?)`,
      params: [
        input.id,
        input.version,
        input.tenantId,
        input.grantId,
        input.grantGeneration,
        input.consentVersion,
        input.actorSub,
        input.clientId,
        JSON.stringify(input.definition),
        input.definitionDigest,
        input.audit.id,
        input.expiresAt,
        input.payloadPurgeAt,
        input.now,
        input.now,
      ],
    };
    const steps: PreparedStatement[] = input.definition.steps.map((step, sequence) => ({
      sql: `INSERT INTO agent_configuration_plan_steps (
        plan_id, plan_version, step_id, sequence, operation, tool_contract_version,
        input_json, input_digest, resource_precondition, risk_level, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      params: [
        input.id,
        input.version,
        step.id,
        sequence,
        step.operation,
        step.toolContractVersion,
        JSON.stringify(step.input),
        input.definitionDigest,
        step.resourcePrecondition ?? null,
        input.risks[sequence],
      ],
    }));
    await this.adapter.batch([planStatement, ...steps, auditStatement(input.audit)]);
  }

  async getPlan(
    tenantId: string,
    id: string,
    version: number
  ): Promise<AgentConfigurationPlanRecord | null> {
    const row = await this.adapter.queryOne<PlanRow>(
      `SELECT * FROM agent_configuration_plans
       WHERE tenant_id = ? AND id = ? AND version = ?`,
      [tenantId, id, version]
    );
    return row ? plan(row) : null;
  }

  async getLatestPlan(tenantId: string, id: string): Promise<AgentConfigurationPlanRecord | null> {
    const row = await this.adapter.queryOne<PlanRow>(
      `SELECT * FROM agent_configuration_plans
       WHERE tenant_id = ? AND id = ? ORDER BY version DESC LIMIT 1`,
      [tenantId, id]
    );
    return row ? plan(row) : null;
  }

  async listPlans(tenantId: string, limit = 100): Promise<AgentConfigurationPlanRecord[]> {
    const rows = await this.adapter.query<PlanRow>(
      `SELECT * FROM agent_configuration_plans WHERE tenant_id = ?
       ORDER BY created_at DESC, id DESC, version DESC LIMIT ?`,
      [tenantId, Math.min(Math.max(limit, 1), 200)]
    );
    return rows.map(plan);
  }

  async markPlanReady(input: {
    tenantId: string;
    id: string;
    version: number;
    definitionDigest: string;
    snapshot: JsonObject;
    diff: JsonObject;
    validation: JsonObject;
    now: number;
    audit: AdminAgentAuditWrite;
  }): Promise<boolean> {
    const results = await this.adapter.batch([
      {
        sql: `UPDATE agent_configuration_plans SET
          status = 'ready', stage = 'apply', snapshot_json = ?, diff_json = ?,
          validation_json = ?, last_transition_id = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND version = ? AND status = 'draft'
          AND definition_digest = ? AND expires_at > ? AND cancelled_at IS NULL`,
        params: [
          JSON.stringify(input.snapshot),
          JSON.stringify(input.diff),
          JSON.stringify(input.validation),
          input.audit.id,
          input.now,
          input.tenantId,
          input.id,
          input.version,
          input.definitionDigest,
          input.now,
        ],
      },
      auditStatement(input.audit, {
        from: 'agent_configuration_plans',
        where: 'tenant_id = ? AND id = ? AND version = ? AND last_transition_id = ?',
        params: [input.tenantId, input.id, input.version, input.audit.id],
      }),
    ]);
    return (results[0]?.rowsAffected ?? 0) === 1;
  }

  async claimPlanApply(input: {
    tenantId: string;
    id: string;
    version: number;
    definitionDigest: string;
    now: number;
    audit: AdminAgentAuditWrite;
    confirmationId?: string;
  }): Promise<boolean> {
    const results = await this.adapter.batch([
      {
        sql: `UPDATE agent_configuration_plans SET
        status = 'running', last_transition_id = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND version = ? AND status = 'ready'
        AND stage = 'apply' AND definition_digest = ? AND expires_at > ?
        AND cancelled_at IS NULL
        AND (? IS NULL OR EXISTS (
          SELECT 1 FROM agent_plan_confirmations c
          WHERE c.id = ? AND c.tenant_id = agent_configuration_plans.tenant_id
            AND c.plan_id = agent_configuration_plans.id
            AND c.plan_version = agent_configuration_plans.version
            AND c.plan_digest = agent_configuration_plans.definition_digest
            AND c.grant_id = agent_configuration_plans.grant_id
            AND c.actor_sub = agent_configuration_plans.actor_sub
            AND c.status = 'confirmed' AND c.expires_at > ?
        ))`,
        params: [
          input.audit.id,
          input.now,
          input.tenantId,
          input.id,
          input.version,
          input.definitionDigest,
          input.now,
          input.confirmationId ?? null,
          input.confirmationId ?? null,
          input.now,
        ],
      },
      ...(input.confirmationId
        ? [
            {
              sql: `UPDATE agent_plan_confirmations SET
                status = 'consumed', consumed_at = ?, last_transition_id = ?
               WHERE id = ? AND tenant_id = ? AND plan_id = ? AND plan_version = ?
                AND plan_digest = ? AND grant_id = (
                  SELECT grant_id FROM agent_configuration_plans
                  WHERE tenant_id = ? AND id = ? AND version = ? AND last_transition_id = ?
                ) AND actor_sub = (
                  SELECT actor_sub FROM agent_configuration_plans
                  WHERE tenant_id = ? AND id = ? AND version = ? AND last_transition_id = ?
                ) AND status = 'confirmed' AND expires_at > ?`,
              params: [
                input.now,
                input.audit.id,
                input.confirmationId,
                input.tenantId,
                input.id,
                input.version,
                input.definitionDigest,
                input.tenantId,
                input.id,
                input.version,
                input.audit.id,
                input.tenantId,
                input.id,
                input.version,
                input.audit.id,
                input.now,
              ],
            },
          ]
        : []),
      auditStatement(input.audit, {
        from: 'agent_configuration_plans',
        where: 'tenant_id = ? AND id = ? AND version = ? AND last_transition_id = ?',
        params: [input.tenantId, input.id, input.version, input.audit.id],
      }),
    ]);
    return (results[0]?.rowsAffected ?? 0) === 1;
  }

  async ensurePlanConfirmation(input: {
    id: string;
    tenantId: string;
    planId: string;
    planVersion: number;
    planDigest: string;
    grantId: string;
    actorSub: string;
    now: number;
    expiresAt: number;
    audit: AdminAgentAuditWrite;
  }): Promise<AgentPlanConfirmationRecord> {
    await this.adapter.batch([
      {
        sql: `INSERT INTO agent_plan_confirmations (
          id, tenant_id, plan_id, plan_version, plan_digest, grant_id, actor_sub,
          status, created_at, expires_at, last_transition_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        ON CONFLICT(plan_id, plan_version, plan_digest) DO NOTHING`,
        params: [
          input.id,
          input.tenantId,
          input.planId,
          input.planVersion,
          input.planDigest,
          input.grantId,
          input.actorSub,
          input.now,
          input.expiresAt,
          input.audit.id,
        ],
      },
      auditStatement(input.audit, {
        from: 'agent_plan_confirmations',
        where: 'id = ? AND tenant_id = ? AND last_transition_id = ?',
        params: [input.id, input.tenantId, input.audit.id],
      }),
    ]);
    const confirmation = await this.getPlanConfirmation(
      input.tenantId,
      input.planId,
      input.planVersion,
      input.planDigest
    );
    if (!confirmation) throw new TypeError('Plan confirmation could not be created');
    return confirmation;
  }

  async getPlanConfirmation(
    tenantId: string,
    planId: string,
    planVersion: number,
    planDigest: string
  ): Promise<AgentPlanConfirmationRecord | null> {
    const row = await this.adapter.queryOne<{
      id: string;
      tenant_id: string;
      plan_id: string;
      plan_version: number;
      plan_digest: string;
      grant_id: string;
      actor_sub: string;
      confirmed_by: string | null;
      status: AgentPlanConfirmationRecord['status'];
      expires_at: number;
    }>(
      `SELECT id, tenant_id, plan_id, plan_version, plan_digest, grant_id, actor_sub,
        confirmed_by, status, expires_at
       FROM agent_plan_confirmations
       WHERE tenant_id = ? AND plan_id = ? AND plan_version = ? AND plan_digest = ?`,
      [tenantId, planId, planVersion, planDigest]
    );
    return row
      ? {
          id: row.id,
          tenantId: row.tenant_id,
          planId: row.plan_id,
          planVersion: row.plan_version,
          planDigest: row.plan_digest,
          grantId: row.grant_id,
          actorSub: row.actor_sub,
          confirmedBy: row.confirmed_by ?? undefined,
          status: row.status,
          expiresAt: row.expires_at,
        }
      : null;
  }

  async confirmPlan(input: {
    tenantId: string;
    confirmationId: string;
    confirmedBy: string;
    planId: string;
    planVersion: number;
    planDigest: string;
    now: number;
    audit: AdminAgentAuditWrite;
  }): Promise<boolean> {
    const results = await this.adapter.batch([
      {
        sql: `UPDATE agent_plan_confirmations SET
          status = 'confirmed', confirmed_by = ?, confirmed_at = ?, last_transition_id = ?
         WHERE tenant_id = ? AND id = ? AND plan_id = ? AND plan_version = ?
          AND plan_digest = ? AND status = 'pending' AND expires_at > ?`,
        params: [
          input.confirmedBy,
          input.now,
          input.audit.id,
          input.tenantId,
          input.confirmationId,
          input.planId,
          input.planVersion,
          input.planDigest,
          input.now,
        ],
      },
      auditStatement(input.audit, {
        from: 'agent_plan_confirmations',
        where: 'tenant_id = ? AND id = ? AND last_transition_id = ?',
        params: [input.tenantId, input.confirmationId, input.audit.id],
      }),
    ]);
    return (results[0]?.rowsAffected ?? 0) === 1;
  }

  async completePlan(input: {
    tenantId: string;
    id: string;
    version: number;
    definitionDigest: string;
    status: 'completed' | 'failed';
    result: JsonObject;
    appliedStepCount: number;
    failedStepId?: string;
    failureKind?: string;
    now: number;
    audit: AdminAgentAuditWrite;
  }): Promise<boolean> {
    const results = await this.adapter.batch([
      {
        sql: `UPDATE agent_configuration_plans SET
          status = ?, stage = 'verify', result_json = ?, applied_step_count = ?,
          failed_step_id = ?, failure_kind = ?, last_transition_id = ?, updated_at = ?,
          payload_purge_at = MIN(payload_purge_at, ?)
         WHERE tenant_id = ? AND id = ? AND version = ? AND status = 'running'
          AND definition_digest = ? AND cancelled_at IS NULL`,
        params: [
          input.status,
          JSON.stringify(input.result),
          input.appliedStepCount,
          input.failedStepId ?? null,
          input.failureKind ?? null,
          input.audit.id,
          input.now,
          input.now + 30 * 24 * 60 * 60_000,
          input.tenantId,
          input.id,
          input.version,
          input.definitionDigest,
        ],
      },
      auditStatement(input.audit, {
        from: 'agent_configuration_plans',
        where: 'tenant_id = ? AND id = ? AND version = ? AND last_transition_id = ?',
        params: [input.tenantId, input.id, input.version, input.audit.id],
      }),
    ]);
    return (results[0]?.rowsAffected ?? 0) === 1;
  }

  async cancelPlan(input: {
    tenantId: string;
    id: string;
    version: number;
    cancelledBy: string;
    reason: string;
    now: number;
    audit: AdminAgentAuditWrite;
  }): Promise<boolean> {
    const results = await this.adapter.batch([
      {
        sql: `UPDATE agent_configuration_plans SET
          cancelled_at = ?, cancelled_by = ?, cancel_reason = ?,
          last_transition_id = ?, updated_at = ?,
          payload_purge_at = MIN(payload_purge_at, ?)
         WHERE tenant_id = ? AND id = ? AND version = ?
          AND status IN ('draft', 'ready', 'running') AND cancelled_at IS NULL`,
        params: [
          input.now,
          input.cancelledBy,
          input.reason,
          input.audit.id,
          input.now,
          input.now + 30 * 24 * 60 * 60_000,
          input.tenantId,
          input.id,
          input.version,
        ],
      },
      auditStatement(input.audit, {
        from: 'agent_configuration_plans',
        where: 'tenant_id = ? AND id = ? AND version = ? AND last_transition_id = ?',
        params: [input.tenantId, input.id, input.version, input.audit.id],
      }),
    ]);
    return (results[0]?.rowsAffected ?? 0) === 1;
  }

  async failCancelledRunningPlan(input: {
    tenantId: string;
    id: string;
    version: number;
    definitionDigest: string;
    result: JsonObject;
    appliedStepCount: number;
    failedStepId?: string;
    now: number;
    audit: AdminAgentAuditWrite;
  }): Promise<boolean> {
    const results = await this.adapter.batch([
      {
        sql: `UPDATE agent_configuration_plans SET
          status = 'failed', stage = 'verify', result_json = ?, applied_step_count = ?,
          failed_step_id = ?, failure_kind = 'plan_cancelled', last_transition_id = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ? AND version = ? AND status = 'running'
          AND definition_digest = ? AND cancelled_at IS NOT NULL`,
        params: [
          JSON.stringify(input.result),
          input.appliedStepCount,
          input.failedStepId ?? null,
          input.audit.id,
          input.now,
          input.tenantId,
          input.id,
          input.version,
          input.definitionDigest,
        ],
      },
      auditStatement(input.audit, {
        from: 'agent_configuration_plans',
        where: 'tenant_id = ? AND id = ? AND version = ? AND last_transition_id = ?',
        params: [input.tenantId, input.id, input.version, input.audit.id],
      }),
    ]);
    return (results[0]?.rowsAffected ?? 0) === 1;
  }

  async purgeExpiredPayloads(now: number, limit = 100): Promise<number> {
    const result = await this.adapter.execute(
      `UPDATE agent_configuration_plans SET
        definition_json = NULL, snapshot_json = NULL, diff_json = NULL,
        validation_json = NULL, result_json = NULL, payload_purged_at = ?, updated_at = ?
       WHERE rowid IN (
        SELECT rowid FROM agent_configuration_plans
        WHERE payload_purge_at <= ? AND payload_purged_at IS NULL LIMIT ?
       )`,
      [now, now, now, Math.min(Math.max(limit, 1), 500)]
    );
    return result.rowsAffected;
  }

  async createSecretRef(input: {
    id: string;
    tenantId: string;
    resourceType: string;
    resourceId?: string;
    purpose: string;
    providerKey: string;
    createdBy: string;
    now: number;
    expiresAt?: number;
    audit: AdminAgentAuditWrite;
  }): Promise<void> {
    await this.adapter.batch([
      {
        sql: `INSERT INTO agent_secret_refs (
          id, tenant_id, resource_type, resource_id, purpose, provider_key,
          status, created_by, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        params: [
          input.id,
          input.tenantId,
          input.resourceType,
          input.resourceId ?? null,
          input.purpose,
          input.providerKey,
          input.createdBy,
          input.now,
          input.expiresAt ?? null,
        ],
      },
      auditStatement(input.audit),
    ]);
  }

  async listSecretRefs(tenantId: string, now: number): Promise<AgentSecretRefRecord[]> {
    const rows = await this.adapter.query<{
      id: string;
      tenant_id: string;
      resource_type: string;
      resource_id: string | null;
      purpose: string;
      status: AgentSecretRefRecord['status'];
      created_by: string;
      created_at: number;
      expires_at: number | null;
      revoked_at: number | null;
      revoked_by: string | null;
    }>(
      `SELECT id, tenant_id, resource_type, resource_id, purpose,
        CASE WHEN status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?
          THEN 'expired' ELSE status END AS status,
        created_by, created_at, expires_at, revoked_at, revoked_by
       FROM agent_secret_refs WHERE tenant_id = ? ORDER BY created_at DESC, id DESC`,
      [now, tenantId]
    );
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      resourceType: row.resource_type,
      resourceId: row.resource_id ?? undefined,
      purpose: row.purpose,
      status: row.status,
      createdBy: row.created_by,
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? undefined,
      revokedAt: row.revoked_at ?? undefined,
      revokedBy: row.revoked_by ?? undefined,
    }));
  }

  async resolveActiveSecretRef(input: {
    tenantId: string;
    id: string;
    resourceType: string;
    resourceId?: string;
    purpose: string;
    now: number;
  }): Promise<ResolvedAgentSecretRef | null> {
    const rows = await this.adapter.query<{
      id: string;
      tenant_id: string;
      resource_type: string;
      resource_id: string | null;
      purpose: string;
      provider_key: string;
      status: AgentSecretRefRecord['status'];
      created_by: string;
      created_at: number;
      expires_at: number | null;
      revoked_at: number | null;
      revoked_by: string | null;
    }>(
      `SELECT id, tenant_id, resource_type, resource_id, purpose, provider_key, status,
        created_by, created_at, expires_at, revoked_at, revoked_by
       FROM agent_secret_refs
       WHERE tenant_id = ? AND id = ? AND resource_type = ?
         AND COALESCE(resource_id, '') = COALESCE(?, '') AND purpose = ?
         AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)
       LIMIT 1`,
      [
        input.tenantId,
        input.id,
        input.resourceType,
        input.resourceId ?? null,
        input.purpose,
        input.now,
      ]
    );
    const row = rows[0];
    return row
      ? {
          id: row.id,
          tenantId: row.tenant_id,
          resourceType: row.resource_type,
          resourceId: row.resource_id ?? undefined,
          purpose: row.purpose,
          providerKey: row.provider_key,
          status: row.status,
          createdBy: row.created_by,
          createdAt: row.created_at,
          expiresAt: row.expires_at ?? undefined,
          revokedAt: row.revoked_at ?? undefined,
          revokedBy: row.revoked_by ?? undefined,
        }
      : null;
  }

  async revokeSecretRef(input: {
    tenantId: string;
    id: string;
    revokedBy: string;
    now: number;
    audit: AdminAgentAuditWrite;
  }): Promise<boolean> {
    const results = await this.adapter.batch([
      {
        sql: `UPDATE agent_secret_refs SET
          status = 'revoked', revoked_at = ?, revoked_by = ?, last_transition_id = ?
         WHERE tenant_id = ? AND id = ? AND status = 'active'`,
        params: [input.now, input.revokedBy, input.audit.id, input.tenantId, input.id],
      },
      auditStatement(input.audit, {
        from: 'agent_secret_refs',
        where: 'tenant_id = ? AND id = ? AND last_transition_id = ?',
        params: [input.tenantId, input.id, input.audit.id],
      }),
    ]);
    return (results[0]?.rowsAffected ?? 0) === 1;
  }
}
