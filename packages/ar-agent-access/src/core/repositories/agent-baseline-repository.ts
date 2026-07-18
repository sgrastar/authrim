import type { DatabaseAdapter, PreparedStatement } from '@authrim/ar-lib-core/db/adapter';
import type { AdminAgentAuditWrite } from '../audit';
import type {
  AgentBaselineDefinition,
  AgentBaselineDriftStatus,
  AgentBaselineEnforcement,
  AgentBaselineMode,
  AgentConfigurationTemplateType,
} from '../baseline';
import type { JsonObject } from '../types';

export interface AgentConfigurationTemplateRecord {
  id: string;
  version: number;
  sourceTenantId: string;
  templateType: AgentConfigurationTemplateType;
  sourceObjectId: string;
  sourceObjectVersion: number;
  definition: JsonObject;
  definitionDigest: string;
  status: 'active' | 'retired';
  publishedBy: string;
  publishedAt: number;
}

export interface AgentTemplateCopyRecord {
  id: string;
  templateId: string;
  templateVersion: number;
  targetTenantId: string;
  targetObjectId: string;
  targetObjectVersion: number;
  targetObjectStatus: 'inactive';
  bulkPlanId: string;
  bulkPlanVersion: number;
  copiedBy: string;
  copiedAt: number;
}

export interface AgentBaselineRecord {
  id: string;
  version: number;
  controlTenantId: string;
  name: string;
  mode: AgentBaselineMode;
  enforcement: AgentBaselineEnforcement;
  definition: AgentBaselineDefinition;
  definitionDigest: string;
  status: 'active' | 'archived';
  createdBy: string;
  createdAt: number;
}

export interface AgentBaselineAssignmentRecord {
  id: string;
  baselineId: string;
  baselineVersion: number;
  tenantId: string;
  sourceBulkPlanId: string;
  sourceBulkPlanVersion: number;
  assignedBy: string;
  assignedAt: number;
  lastEvaluatedAt?: number;
  driftStatus?: AgentBaselineDriftStatus;
  driftDigest?: string;
  remediationBulkPlanId?: string;
  remediationBulkPlanVersion?: number;
  remediationDriftDigest?: string;
  remediationRequestedAt?: number;
}

export interface AgentBaselineAssignmentContext {
  assignment: AgentBaselineAssignmentRecord;
  baseline: AgentBaselineRecord;
}

export interface AgentManagedBaselineEvaluationCandidate {
  controlTenantId: string;
  assignmentId: string;
  lastEvaluatedAt?: number;
}

export interface AgentBaselineExceptionRecord {
  id: string;
  assignmentId: string;
  fields: string[];
  reason: string;
  approvedBy: string;
  approvedAt: number;
  expiresAt: number;
  revokedAt?: number;
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

function parseObject<T>(value: string): T {
  return JSON.parse(value) as T;
}

export class AgentBaselineRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async publishTemplate(input: {
    id: string;
    version: number;
    sourceTenantId: string;
    templateType: AgentConfigurationTemplateType;
    sourceObjectId: string;
    sourceObjectVersion: number;
    definition: JsonObject;
    definitionDigest: string;
    publishedBy: string;
    publishedAt: number;
    audit: AdminAgentAuditWrite;
  }): Promise<void> {
    await this.adapter.batch([
      {
        sql: `INSERT INTO agent_configuration_templates (
          id, version, source_tenant_id, template_type, source_object_id,
          source_object_version, definition_json, definition_digest, status,
          published_by, published_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        params: [
          input.id,
          input.version,
          input.sourceTenantId,
          input.templateType,
          input.sourceObjectId,
          input.sourceObjectVersion,
          JSON.stringify(input.definition),
          input.definitionDigest,
          input.publishedBy,
          input.publishedAt,
        ],
      },
      auditStatement(input.audit),
    ]);
  }

  async listTemplates(sourceTenantId: string): Promise<AgentConfigurationTemplateRecord[]> {
    const rows = await this.adapter.query<{
      id: string;
      version: number;
      source_tenant_id: string;
      template_type: AgentConfigurationTemplateType;
      source_object_id: string;
      source_object_version: number;
      definition_json: string;
      definition_digest: string;
      status: 'active' | 'retired';
      published_by: string;
      published_at: number;
    }>(
      `SELECT * FROM agent_configuration_templates
       WHERE source_tenant_id = ? ORDER BY published_at DESC, id, version DESC`,
      [sourceTenantId]
    );
    return rows.map((row) => ({
      id: row.id,
      version: row.version,
      sourceTenantId: row.source_tenant_id,
      templateType: row.template_type,
      sourceObjectId: row.source_object_id,
      sourceObjectVersion: row.source_object_version,
      definition: parseObject<JsonObject>(row.definition_json),
      definitionDigest: row.definition_digest,
      status: row.status,
      publishedBy: row.published_by,
      publishedAt: row.published_at,
    }));
  }

  async getTemplate(id: string, version: number): Promise<AgentConfigurationTemplateRecord | null> {
    const row = await this.adapter.queryOne<{
      id: string;
      version: number;
      source_tenant_id: string;
      template_type: AgentConfigurationTemplateType;
      source_object_id: string;
      source_object_version: number;
      definition_json: string;
      definition_digest: string;
      status: 'active' | 'retired';
      published_by: string;
      published_at: number;
    }>('SELECT * FROM agent_configuration_templates WHERE id = ? AND version = ?', [id, version]);
    return row
      ? {
          id: row.id,
          version: row.version,
          sourceTenantId: row.source_tenant_id,
          templateType: row.template_type,
          sourceObjectId: row.source_object_id,
          sourceObjectVersion: row.source_object_version,
          definition: parseObject<JsonObject>(row.definition_json),
          definitionDigest: row.definition_digest,
          status: row.status,
          publishedBy: row.published_by,
          publishedAt: row.published_at,
        }
      : null;
  }

  async copyTemplate(input: {
    id: string;
    templateId: string;
    templateVersion: number;
    targetTenantId: string;
    targetObjectId: string;
    bulkPlanId: string;
    bulkPlanVersion: number;
    copiedBy: string;
    copiedAt: number;
    audit: AdminAgentAuditWrite;
  }): Promise<boolean> {
    const template = await this.getTemplate(input.templateId, input.templateVersion);
    if (!template || template.status !== 'active') return false;
    const name = typeof template.definition.name === 'string' ? template.definition.name : '';
    if (!name) return false;
    const description =
      typeof template.definition.description === 'string' ? template.definition.description : null;
    const objectStatements: PreparedStatement[] =
      template.templateType === 'task_set'
        ? [
            {
              sql: `INSERT INTO agent_task_sets (
                id, tenant_id, name, description, kind, status, current_version,
                source_template_id, source_template_version, created_by, created_at, updated_at
              ) SELECT ?, ?, ?, ?, 'template_copy', 'archived', 1, ?, ?, ?, ?, ?
                WHERE EXISTS (SELECT 1 FROM agent_configuration_templates
                  WHERE id = ? AND version = ? AND status = 'active')
                  AND EXISTS (SELECT 1 FROM agent_bulk_plans p
                    JOIN agent_bulk_tenant_executions e
                      ON e.bulk_plan_id = p.id AND e.bulk_plan_version = p.version
                    WHERE p.id = ? AND p.version = ? AND p.status = 'completed'
                      AND e.target_tenant_id = ? AND e.status = 'succeeded')`,
              params: [
                input.targetObjectId,
                input.targetTenantId,
                name,
                description,
                input.templateId,
                input.templateVersion,
                input.copiedBy,
                input.copiedAt,
                input.copiedAt,
                input.templateId,
                input.templateVersion,
                input.bulkPlanId,
                input.bulkPlanVersion,
                input.targetTenantId,
              ],
            },
            {
              sql: `INSERT INTO agent_task_set_versions (
                task_set_id, version, tool_entries_json, resolved_permissions_json,
                definition_digest, catalog_version, status, created_by, created_at
              ) SELECT ?, 1, ?, ?, ?, ?, 'archived', ?, ?
                WHERE EXISTS (SELECT 1 FROM agent_task_sets WHERE id = ? AND status = 'archived')`,
              params: [
                input.targetObjectId,
                JSON.stringify(template.definition.tools ?? []),
                JSON.stringify(template.definition.permissions ?? []),
                template.definitionDigest,
                typeof template.definition.catalog_version === 'string'
                  ? template.definition.catalog_version
                  : 'unknown',
                input.copiedBy,
                input.copiedAt,
                input.targetObjectId,
              ],
            },
          ]
        : [
            {
              sql: `INSERT INTO agent_scope_policies (
                id, tenant_id, name, description, kind, status, current_version,
                source_template_id, source_template_version, created_by, created_at, updated_at
              ) SELECT ?, ?, ?, ?, 'template_copy', 'archived', 1, ?, ?, ?, ?, ?
                WHERE EXISTS (SELECT 1 FROM agent_configuration_templates
                  WHERE id = ? AND version = ? AND status = 'active')
                  AND EXISTS (SELECT 1 FROM agent_bulk_plans p
                    JOIN agent_bulk_tenant_executions e
                      ON e.bulk_plan_id = p.id AND e.bulk_plan_version = p.version
                    WHERE p.id = ? AND p.version = ? AND p.status = 'completed'
                      AND e.target_tenant_id = ? AND e.status = 'succeeded')`,
              params: [
                input.targetObjectId,
                input.targetTenantId,
                name,
                description,
                input.templateId,
                input.templateVersion,
                input.copiedBy,
                input.copiedAt,
                input.copiedAt,
                input.templateId,
                input.templateVersion,
                input.bulkPlanId,
                input.bulkPlanVersion,
                input.targetTenantId,
              ],
            },
            {
              sql: `INSERT INTO agent_scope_policy_versions (
                scope_policy_id, version, definition_json, definition_digest,
                selector_catalog_version, status, created_by, created_at
              ) SELECT ?, 1, ?, ?, ?, 'archived', ?, ?
                WHERE EXISTS (SELECT 1 FROM agent_scope_policies
                  WHERE id = ? AND status = 'archived')`,
              params: [
                input.targetObjectId,
                JSON.stringify(template.definition.definition ?? {}),
                template.definitionDigest,
                typeof template.definition.selector_catalog_version === 'string'
                  ? template.definition.selector_catalog_version
                  : 'unknown',
                input.copiedBy,
                input.copiedAt,
                input.targetObjectId,
              ],
            },
          ];
    const results = await this.adapter.batch([
      ...objectStatements,
      {
        sql: `INSERT INTO agent_template_copies (
          id, template_id, template_version, target_tenant_id, target_object_id,
          target_object_version, target_object_status, bulk_plan_id, bulk_plan_version,
          copied_by, copied_at
        ) SELECT ?, t.id, t.version, ?, ?, 1, 'inactive', p.id, p.version, ?, ?
          FROM agent_configuration_templates t JOIN agent_bulk_plans p
            ON p.id = ? AND p.version = ? AND p.status = 'completed'
         WHERE t.id = ? AND t.version = ? AND t.status = 'active'
           AND EXISTS (SELECT 1 FROM agent_bulk_tenant_executions e
             WHERE e.bulk_plan_id = p.id AND e.bulk_plan_version = p.version
               AND e.target_tenant_id = ? AND e.status = 'succeeded')`,
        params: [
          input.id,
          input.targetTenantId,
          input.targetObjectId,
          input.copiedBy,
          input.copiedAt,
          input.bulkPlanId,
          input.bulkPlanVersion,
          input.templateId,
          input.templateVersion,
          input.targetTenantId,
        ],
      },
      auditStatement(input.audit, {
        from: 'agent_template_copies',
        where: 'id = ? AND template_id = ? AND template_version = ?',
        params: [input.id, input.templateId, input.templateVersion],
      }),
    ]);
    return (
      objectStatements.every((_, index) => results[index]?.rowsAffected === 1) &&
      results[objectStatements.length]?.rowsAffected === 1
    );
  }

  async listTemplateCopies(
    templateId: string,
    templateVersion: number
  ): Promise<AgentTemplateCopyRecord[]> {
    const rows = await this.adapter.query<{
      id: string;
      template_id: string;
      template_version: number;
      target_tenant_id: string;
      target_object_id: string;
      target_object_version: number;
      target_object_status: 'inactive';
      bulk_plan_id: string;
      bulk_plan_version: number;
      copied_by: string;
      copied_at: number;
    }>(
      `SELECT * FROM agent_template_copies
       WHERE template_id = ? AND template_version = ? ORDER BY target_tenant_id`,
      [templateId, templateVersion]
    );
    return rows.map((row) => ({
      id: row.id,
      templateId: row.template_id,
      templateVersion: row.template_version,
      targetTenantId: row.target_tenant_id,
      targetObjectId: row.target_object_id,
      targetObjectVersion: row.target_object_version,
      targetObjectStatus: row.target_object_status,
      bulkPlanId: row.bulk_plan_id,
      bulkPlanVersion: row.bulk_plan_version,
      copiedBy: row.copied_by,
      copiedAt: row.copied_at,
    }));
  }

  async createBaseline(input: {
    id: string;
    version: number;
    controlTenantId: string;
    name: string;
    mode: AgentBaselineMode;
    enforcement: AgentBaselineEnforcement;
    definition: AgentBaselineDefinition;
    definitionDigest: string;
    createdBy: string;
    createdAt: number;
    audit: AdminAgentAuditWrite;
  }): Promise<void> {
    await this.adapter.batch([
      {
        sql: `INSERT INTO agent_baselines (
          id, version, control_tenant_id, name, mode, enforcement, definition_json,
          definition_digest, status, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        params: [
          input.id,
          input.version,
          input.controlTenantId,
          input.name,
          input.mode,
          input.enforcement,
          JSON.stringify(input.definition),
          input.definitionDigest,
          input.createdBy,
          input.createdAt,
        ],
      },
      auditStatement(input.audit),
    ]);
  }

  async listBaselines(controlTenantId: string): Promise<AgentBaselineRecord[]> {
    const rows = await this.adapter.query<{
      id: string;
      version: number;
      control_tenant_id: string;
      name: string;
      mode: AgentBaselineMode;
      enforcement: AgentBaselineEnforcement;
      definition_json: string;
      definition_digest: string;
      status: 'active' | 'archived';
      created_by: string;
      created_at: number;
    }>(
      `SELECT * FROM agent_baselines WHERE control_tenant_id = ?
       ORDER BY created_at DESC, id, version DESC`,
      [controlTenantId]
    );
    return rows.map((row) => ({
      id: row.id,
      version: row.version,
      controlTenantId: row.control_tenant_id,
      name: row.name,
      mode: row.mode,
      enforcement: row.enforcement,
      definition: parseObject<AgentBaselineDefinition>(row.definition_json),
      definitionDigest: row.definition_digest,
      status: row.status,
      createdBy: row.created_by,
      createdAt: row.created_at,
    }));
  }

  async getBaseline(
    controlTenantId: string,
    id: string,
    version: number
  ): Promise<AgentBaselineRecord | null> {
    const rows = await this.listBaselines(controlTenantId);
    return rows.find((item) => item.id === id && item.version === version) ?? null;
  }

  async assignBaseline(input: {
    id: string;
    controlTenantId: string;
    baselineId: string;
    baselineVersion: number;
    tenantId: string;
    sourceBulkPlanId: string;
    sourceBulkPlanVersion: number;
    assignedBy: string;
    assignedAt: number;
    audit: AdminAgentAuditWrite;
  }): Promise<boolean> {
    const results = await this.adapter.batch([
      {
        sql: `INSERT INTO agent_baseline_assignments (
          id, baseline_id, baseline_version, tenant_id, source_bulk_plan_id,
          source_bulk_plan_version, assigned_by, assigned_at, drift_status
        ) SELECT ?, b.id, b.version, ?, p.id, p.version, ?, ?, 'unknown'
          FROM agent_baselines b JOIN agent_bulk_plans p
            ON p.id = ? AND p.version = ? AND p.control_tenant_id = b.control_tenant_id
         WHERE b.control_tenant_id = ? AND b.id = ? AND b.version = ?
           AND b.status = 'active' AND p.status = 'completed'
           AND EXISTS (SELECT 1 FROM agent_bulk_tenant_executions e
             WHERE e.bulk_plan_id = p.id AND e.bulk_plan_version = p.version
               AND e.target_tenant_id = ? AND e.status = 'succeeded')`,
        params: [
          input.id,
          input.tenantId,
          input.assignedBy,
          input.assignedAt,
          input.sourceBulkPlanId,
          input.sourceBulkPlanVersion,
          input.controlTenantId,
          input.baselineId,
          input.baselineVersion,
          input.tenantId,
        ],
      },
      auditStatement(input.audit, {
        from: 'agent_baseline_assignments',
        where: 'id = ? AND baseline_id = ? AND baseline_version = ?',
        params: [input.id, input.baselineId, input.baselineVersion],
      }),
    ]);
    return (results[0]?.rowsAffected ?? 0) === 1;
  }

  async listAssignments(
    controlTenantId: string,
    baselineId: string,
    baselineVersion: number
  ): Promise<AgentBaselineAssignmentRecord[]> {
    const rows = await this.adapter.query<{
      id: string;
      baseline_id: string;
      baseline_version: number;
      tenant_id: string;
      source_bulk_plan_id: string;
      source_bulk_plan_version: number;
      assigned_by: string;
      assigned_at: number;
      last_evaluated_at: number | null;
      drift_status: AgentBaselineDriftStatus | null;
      drift_digest: string | null;
      remediation_bulk_plan_id: string | null;
      remediation_bulk_plan_version: number | null;
      remediation_drift_digest: string | null;
      remediation_requested_at: number | null;
    }>(
      `SELECT a.* FROM agent_baseline_assignments a JOIN agent_baselines b
        ON b.id = a.baseline_id AND b.version = a.baseline_version
       WHERE b.control_tenant_id = ? AND a.baseline_id = ? AND a.baseline_version = ?
       ORDER BY a.tenant_id`,
      [controlTenantId, baselineId, baselineVersion]
    );
    return rows.map((row) => ({
      id: row.id,
      baselineId: row.baseline_id,
      baselineVersion: row.baseline_version,
      tenantId: row.tenant_id,
      sourceBulkPlanId: row.source_bulk_plan_id,
      sourceBulkPlanVersion: row.source_bulk_plan_version,
      assignedBy: row.assigned_by,
      assignedAt: row.assigned_at,
      lastEvaluatedAt: row.last_evaluated_at ?? undefined,
      driftStatus: row.drift_status ?? undefined,
      driftDigest: row.drift_digest ?? undefined,
      remediationBulkPlanId: row.remediation_bulk_plan_id ?? undefined,
      remediationBulkPlanVersion: row.remediation_bulk_plan_version ?? undefined,
      remediationDriftDigest: row.remediation_drift_digest ?? undefined,
      remediationRequestedAt: row.remediation_requested_at ?? undefined,
    }));
  }

  async getAssignmentContext(
    controlTenantId: string,
    assignmentId: string
  ): Promise<AgentBaselineAssignmentContext | null> {
    const row = await this.adapter.queryOne<{
      assignment_id: string;
      baseline_id: string;
      baseline_version: number;
      tenant_id: string;
      source_bulk_plan_id: string;
      source_bulk_plan_version: number;
      assigned_by: string;
      assigned_at: number;
      last_evaluated_at: number | null;
      drift_status: AgentBaselineDriftStatus | null;
      drift_digest: string | null;
      remediation_bulk_plan_id: string | null;
      remediation_bulk_plan_version: number | null;
      remediation_drift_digest: string | null;
      remediation_requested_at: number | null;
      control_tenant_id: string;
      baseline_name: string;
      baseline_mode: AgentBaselineMode;
      baseline_enforcement: AgentBaselineEnforcement;
      definition_json: string;
      definition_digest: string;
      baseline_status: 'active' | 'archived';
      baseline_created_by: string;
      baseline_created_at: number;
    }>(
      `SELECT a.id AS assignment_id, a.*, b.control_tenant_id,
          b.name AS baseline_name, b.mode AS baseline_mode,
          b.enforcement AS baseline_enforcement, b.definition_json,
          b.definition_digest, b.status AS baseline_status,
          b.created_by AS baseline_created_by, b.created_at AS baseline_created_at
       FROM agent_baseline_assignments a JOIN agent_baselines b
         ON b.id = a.baseline_id AND b.version = a.baseline_version
       WHERE b.control_tenant_id = ? AND a.id = ?`,
      [controlTenantId, assignmentId]
    );
    if (!row) return null;
    return {
      assignment: {
        id: row.assignment_id,
        baselineId: row.baseline_id,
        baselineVersion: row.baseline_version,
        tenantId: row.tenant_id,
        sourceBulkPlanId: row.source_bulk_plan_id,
        sourceBulkPlanVersion: row.source_bulk_plan_version,
        assignedBy: row.assigned_by,
        assignedAt: row.assigned_at,
        lastEvaluatedAt: row.last_evaluated_at ?? undefined,
        driftStatus: row.drift_status ?? undefined,
        driftDigest: row.drift_digest ?? undefined,
        remediationBulkPlanId: row.remediation_bulk_plan_id ?? undefined,
        remediationBulkPlanVersion: row.remediation_bulk_plan_version ?? undefined,
        remediationDriftDigest: row.remediation_drift_digest ?? undefined,
        remediationRequestedAt: row.remediation_requested_at ?? undefined,
      },
      baseline: {
        id: row.baseline_id,
        version: row.baseline_version,
        controlTenantId: row.control_tenant_id,
        name: row.baseline_name,
        mode: row.baseline_mode,
        enforcement: row.baseline_enforcement,
        definition: parseObject<AgentBaselineDefinition>(row.definition_json),
        definitionDigest: row.definition_digest,
        status: row.baseline_status,
        createdBy: row.baseline_created_by,
        createdAt: row.baseline_created_at,
      },
    };
  }

  async evaluateAssignment(input: {
    controlTenantId: string;
    assignmentId: string;
    status: AgentBaselineDriftStatus;
    currentDigest: string;
    evaluatedAt: number;
    audit: AdminAgentAuditWrite;
  }): Promise<AgentBaselineDriftStatus | null> {
    const results = await this.adapter.batch([
      {
        sql: `UPDATE agent_baseline_assignments SET last_evaluated_at = ?,
          drift_status = ?, drift_digest = ?, last_transition_id = ? WHERE id = ?
          AND EXISTS (SELECT 1 FROM agent_baselines b
            WHERE b.id = agent_baseline_assignments.baseline_id
              AND b.version = agent_baseline_assignments.baseline_version
              AND b.control_tenant_id = ?)`,
        params: [
          input.evaluatedAt,
          input.status,
          input.currentDigest,
          input.audit.id,
          input.assignmentId,
          input.controlTenantId,
        ],
      },
      auditStatement(input.audit, {
        from: 'agent_baseline_assignments',
        where: 'id = ? AND drift_digest = ?',
        params: [input.assignmentId, input.currentDigest],
      }),
    ]);
    return results[0]?.rowsAffected === 1 ? input.status : null;
  }

  async listManagedEvaluationCandidates(input: {
    now: number;
    minimumIntervalMs: number;
    limit?: number;
  }): Promise<AgentManagedBaselineEvaluationCandidate[]> {
    const rows = await this.adapter.query<{
      control_tenant_id: string;
      assignment_id: string;
      last_evaluated_at: number | null;
    }>(
      `SELECT b.control_tenant_id, a.id AS assignment_id, a.last_evaluated_at
       FROM agent_baseline_assignments a JOIN agent_baselines b
         ON b.id = a.baseline_id AND b.version = a.baseline_version
       WHERE b.status = 'active' AND b.mode = 'managed'
         AND (a.last_evaluated_at IS NULL OR a.last_evaluated_at <= ?)
       ORDER BY COALESCE(a.last_evaluated_at, 0), a.id LIMIT ?`,
      [
        input.now - Math.max(60_000, input.minimumIntervalMs),
        Math.min(Math.max(input.limit ?? 25, 1), 100),
      ]
    );
    return rows.map((row) => ({
      controlTenantId: row.control_tenant_id,
      assignmentId: row.assignment_id,
      lastEvaluatedAt: row.last_evaluated_at ?? undefined,
    }));
  }

  async evaluateManagedAssignment(input: {
    controlTenantId: string;
    assignmentId: string;
    expectedLastEvaluatedAt?: number;
    status: AgentBaselineDriftStatus;
    currentDigest: string;
    evaluatedAt: number;
    audit: AdminAgentAuditWrite;
  }): Promise<boolean> {
    const expected = input.expectedLastEvaluatedAt;
    const results = await this.adapter.batch([
      {
        sql: `UPDATE agent_baseline_assignments SET last_evaluated_at = ?,
          drift_status = ?, drift_digest = ? WHERE id = ?
          AND ${expected === undefined ? 'last_evaluated_at IS NULL' : 'last_evaluated_at = ?'}
          AND EXISTS (SELECT 1 FROM agent_baselines b
            WHERE b.id = agent_baseline_assignments.baseline_id
              AND b.version = agent_baseline_assignments.baseline_version
              AND b.control_tenant_id = ? AND b.status = 'active' AND b.mode = 'managed')`,
        params: [
          input.evaluatedAt,
          input.status,
          input.currentDigest,
          input.assignmentId,
          ...(expected === undefined ? [] : [expected]),
          input.controlTenantId,
        ],
      },
      auditStatement(input.audit, {
        from: 'agent_baseline_assignments',
        where: 'id = ? AND last_transition_id = ?',
        params: [input.assignmentId, input.audit.id],
      }),
    ]);
    return (results[0]?.rowsAffected ?? 0) === 1;
  }

  async reserveAutoRemediation(input: {
    controlTenantId: string;
    assignmentId: string;
    driftDigest: string;
    bulkPlanId: string;
    bulkPlanVersion: number;
    requestedAt: number;
    audit: AdminAgentAuditWrite;
  }): Promise<boolean> {
    const results = await this.adapter.batch([
      {
        sql: `UPDATE agent_baseline_assignments SET
          remediation_bulk_plan_id = ?, remediation_bulk_plan_version = ?,
          remediation_drift_digest = ?, remediation_requested_at = ?, last_transition_id = ?
         WHERE id = ? AND drift_status = 'drifted' AND drift_digest = ?
           AND (remediation_bulk_plan_id IS NULL OR (
             remediation_drift_digest <> ? AND EXISTS (
               SELECT 1 FROM agent_bulk_plans previous
                WHERE previous.id = remediation_bulk_plan_id
                  AND previous.version = remediation_bulk_plan_version
                  AND previous.status = 'completed'
             )
           ))
           AND EXISTS (SELECT 1 FROM agent_baselines b
             WHERE b.id = agent_baseline_assignments.baseline_id
               AND b.version = agent_baseline_assignments.baseline_version
               AND b.control_tenant_id = ? AND b.status = 'active'
               AND b.mode = 'managed' AND b.enforcement = 'standard_auto_remediation')`,
        params: [
          input.bulkPlanId,
          input.bulkPlanVersion,
          input.driftDigest,
          input.requestedAt,
          input.audit.id,
          input.assignmentId,
          input.driftDigest,
          input.driftDigest,
          input.controlTenantId,
        ],
      },
      auditStatement(input.audit, {
        from: 'agent_baseline_assignments',
        where: 'id = ? AND last_transition_id = ?',
        params: [input.assignmentId, input.audit.id],
      }),
    ]);
    return (results[0]?.rowsAffected ?? 0) === 1;
  }

  async listPendingAutoRemediations(
    limit = 25
  ): Promise<Array<{ controlTenantId: string; assignmentId: string }>> {
    return this.adapter.query<{ controlTenantId: string; assignmentId: string }>(
      `SELECT b.control_tenant_id AS controlTenantId, a.id AS assignmentId
       FROM agent_baseline_assignments a JOIN agent_baselines b
         ON b.id = a.baseline_id AND b.version = a.baseline_version
       LEFT JOIN agent_bulk_plans p
         ON p.id = a.remediation_bulk_plan_id
        AND p.version = a.remediation_bulk_plan_version
        AND p.control_tenant_id = b.control_tenant_id
         WHERE b.status = 'active' AND b.mode = 'managed'
         AND b.enforcement = 'standard_auto_remediation'
         AND a.remediation_drift_digest IS NOT NULL
         AND a.remediation_bulk_plan_id IS NOT NULL
         AND (p.id IS NULL OR p.status IN ('draft', 'ready'))
       ORDER BY a.remediation_requested_at, a.id LIMIT ?`,
      [Math.min(Math.max(limit, 1), 100)]
    );
  }

  async createException(input: {
    id: string;
    controlTenantId: string;
    assignmentId: string;
    fields: readonly string[];
    reason: string;
    approvedBy: string;
    approvedAt: number;
    expiresAt: number;
    audit: AdminAgentAuditWrite;
  }): Promise<boolean> {
    const results = await this.adapter.batch([
      {
        sql: `INSERT INTO agent_baseline_exceptions (
          id, assignment_id, fields_json, reason, approved_by, approved_at, expires_at
        ) SELECT ?, a.id, ?, ?, ?, ?, ? FROM agent_baseline_assignments a
          JOIN agent_baselines b ON b.id = a.baseline_id AND b.version = a.baseline_version
         WHERE a.id = ? AND b.control_tenant_id = ? AND b.mode = 'managed'
           AND (a.remediation_bulk_plan_id IS NULL OR EXISTS (
             SELECT 1 FROM agent_bulk_plans p
              WHERE p.id = a.remediation_bulk_plan_id
                AND p.version = a.remediation_bulk_plan_version
                AND p.status = 'completed'
           ))`,
        params: [
          input.id,
          JSON.stringify(input.fields),
          input.reason,
          input.approvedBy,
          input.approvedAt,
          input.expiresAt,
          input.assignmentId,
          input.controlTenantId,
        ],
      },
      auditStatement(input.audit, {
        from: 'agent_baseline_exceptions',
        where: 'id = ? AND assignment_id = ?',
        params: [input.id, input.assignmentId],
      }),
    ]);
    return (results[0]?.rowsAffected ?? 0) === 1;
  }

  async listExceptions(
    controlTenantId: string,
    assignmentId: string,
    now: number
  ): Promise<AgentBaselineExceptionRecord[]> {
    const rows = await this.adapter.query<{
      id: string;
      assignment_id: string;
      fields_json: string;
      reason: string;
      approved_by: string;
      approved_at: number;
      expires_at: number;
      revoked_at: number | null;
    }>(
      `SELECT x.* FROM agent_baseline_exceptions x
       JOIN agent_baseline_assignments a ON a.id = x.assignment_id
       JOIN agent_baselines b ON b.id = a.baseline_id AND b.version = a.baseline_version
       WHERE b.control_tenant_id = ? AND x.assignment_id = ?
         AND x.revoked_at IS NULL AND x.expires_at > ? ORDER BY x.approved_at DESC`,
      [controlTenantId, assignmentId, now]
    );
    return rows.map((row) => ({
      id: row.id,
      assignmentId: row.assignment_id,
      fields: parseObject<string[]>(row.fields_json),
      reason: row.reason,
      approvedBy: row.approved_by,
      approvedAt: row.approved_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at ?? undefined,
    }));
  }
}
