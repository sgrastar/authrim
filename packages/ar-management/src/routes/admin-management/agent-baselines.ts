import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  AgentBaselineRepository,
  AgentBulkRepository,
  AgentConfigurationRepository,
  canonicalizeJson,
  evaluateAgentBaselineConfiguration,
  getAgentTaskSetWithBuiltins,
  resolveAgentBaselineDefinition,
  resolveAgentConfigurationPlan,
  validateAgentBaselineException,
  type AdminAgentAuditWrite,
  type AgentBaselineDefinition,
  type AgentBaselineEnforcement,
  type AgentBaselineMode,
  type AgentConfigurationTemplateType,
  type JsonObject,
} from '@authrim/ar-agent-access/core';
import {
  createAdminToolCatalog,
  McpSdkJsonSchemaValidator,
} from '@authrim/ar-agent-access/protocol/mcp';
import { CloudflareTenantConfigurationReader } from '@authrim/ar-agent-access/platform/cloudflare/tenant-configuration-reader';
import { CloudflareAgentSettingsProvider } from '@authrim/ar-agent-access/platform/cloudflare/tenant-settings';
import {
  ADMIN_PERMISSIONS,
  adminAuthMiddleware,
  hasAdminPermission,
  requireDedicatedAdminDatabaseAdapter,
  type AdminAuthContext,
} from '@authrim/ar-lib-core';
import { isAgentMcpEnabled, type AgentManagementEnv } from '../../agent-downscope-auth';
import { isFreshAdminHuman } from '../../agent-fresh-auth';

type BaselineContext = Context<{
  Bindings: AgentManagementEnv;
  Variables: { adminAuth?: AdminAuthContext };
}>;

const SAFE = /^[A-Za-z0-9._~-]{1,128}$/u;
const NAME = /^[\p{L}\p{N} ._~-]{1,120}$/u;
const ADMIN_TOOL_CATALOG = createAdminToolCatalog();
const schemaValidator = new McpSdkJsonSchemaValidator();

export const agentTemplatesRouter = new Hono<{
  Bindings: AgentManagementEnv;
  Variables: { adminAuth?: AdminAuthContext };
}>();
export const agentBaselinesRouter = new Hono<{
  Bindings: AgentManagementEnv;
  Variables: { adminAuth?: AdminAuthContext };
}>();

agentTemplatesRouter.use('*', adminAuthMiddleware());
agentBaselinesRouter.use('*', adminAuthMiddleware());

function auth(c: BaselineContext): AdminAuthContext {
  return c.get('adminAuth') as AdminAuthContext;
}

function controlTenant(c: BaselineContext): string {
  return auth(c).tenantId ?? c.env.DEFAULT_TENANT_ID ?? 'default';
}

function human(c: BaselineContext): boolean {
  const value = auth(c);
  return (
    (!value.actorType || value.actorType === 'human') &&
    value.authMethod === 'session' &&
    typeof value.userId === 'string'
  );
}

function permitted(c: BaselineContext, permission: string): boolean {
  return hasAdminPermission(auth(c).permissions ?? [], permission);
}

function tenantScoped(c: BaselineContext, tenantIds: readonly string[]): boolean {
  const scope = auth(c).tenantScope ?? [];
  return scope.includes('*') || tenantIds.every((tenantId) => scope.includes(tenantId));
}

function error(c: BaselineContext, status: 400 | 403 | 404 | 409 | 503, code: string) {
  return c.json({ error: code, error_description: code }, status);
}

async function body(c: BaselineContext): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await c.req.json();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function repositories(c: BaselineContext) {
  const database = requireDedicatedAdminDatabaseAdapter(c.env, 'agent-baseline-management');
  return {
    baseline: new AgentBaselineRepository(database),
    bulk: new AgentBulkRepository(database),
    configuration: new AgentConfigurationRepository(database),
  };
}

function audit(
  c: BaselineContext,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: JsonObject
): AdminAgentAuditWrite {
  const current = auth(c);
  return {
    id: `audit_${crypto.randomUUID()}`,
    tenantId: controlTenant(c),
    adminUserId: current.userId,
    action,
    resourceType,
    resourceId,
    severity: action.includes('exception') ? 'warn' : 'info',
    actorType: 'admin_user',
    actorSub: `admin_user:${current.userId}`,
    requestId: c.req.header('x-request-id'),
    metadata,
    createdAt: Date.now(),
  };
}

async function activeTenants(c: BaselineContext, tenantIds: readonly string[]): Promise<boolean> {
  if (tenantIds.length === 0 || tenantIds.length > 1000) return false;
  const database = requireDedicatedAdminDatabaseAdapter(c.env, 'agent-template-targets');
  const rows = await database.query<{ id: string }>(
    `SELECT id FROM tenants WHERE lifecycle_state = 'active' AND id IN (${tenantIds.map(() => '?').join(', ')})`,
    [...tenantIds]
  );
  const active = new Set(rows.map((row) => row.id));
  return tenantIds.every((tenantId) => active.has(tenantId));
}

agentTemplatesRouter.get('/', async (c) => {
  if (!permitted(c, ADMIN_PERMISSIONS.AGENT_TEMPLATES_PUBLISH)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  return c.json({ templates: await repositories(c).baseline.listTemplates(controlTenant(c)) });
});

agentTemplatesRouter.post('/', async (c) => {
  if (!human(c) || !permitted(c, ADMIN_PERMISSIONS.AGENT_TEMPLATES_PUBLISH)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  if (!(await isAgentMcpEnabled(c.env, controlTenant(c)))) {
    return error(c, 404, 'AGENT_MCP_DISABLED');
  }
  const value = await body(c);
  const templateType = value?.template_type;
  const sourceObjectId = value?.source_object_id;
  const sourceObjectVersion = value?.source_object_version;
  if (
    (templateType !== 'task_set' && templateType !== 'scope_policy') ||
    typeof sourceObjectId !== 'string' ||
    !SAFE.test(sourceObjectId) ||
    typeof sourceObjectVersion !== 'number' ||
    !Number.isSafeInteger(sourceObjectVersion) ||
    sourceObjectVersion < 1
  ) {
    return error(c, 400, 'AGENT_TEMPLATE_INVALID');
  }
  const { baseline, configuration } = repositories(c);
  let definition: JsonObject;
  let definitionDigest: string;
  if (templateType === 'task_set') {
    const source = await getAgentTaskSetWithBuiltins({
      repository: configuration,
      catalog: ADMIN_TOOL_CATALOG,
      tenantId: controlTenant(c),
      id: sourceObjectId,
      version: sourceObjectVersion,
    });
    if (!source) return error(c, 404, 'AGENT_TEMPLATE_SOURCE_NOT_FOUND');
    if (
      source.version.permissions.some(
        (permission) => !hasAdminPermission(auth(c).permissions ?? [], permission)
      )
    ) {
      return error(c, 403, 'AGENT_TEMPLATE_BASE_PERMISSION_REQUIRED');
    }
    definition = {
      name: source.name,
      description: source.description ?? null,
      catalog_version: source.version.catalogVersion,
      tools: source.version.tools as unknown as JsonObject['tools'],
      permissions: [...source.version.permissions],
    };
    definitionDigest = source.version.digest;
  } else {
    const source = await configuration.getScopePolicyVersion(
      controlTenant(c),
      sourceObjectId,
      sourceObjectVersion
    );
    if (!source) return error(c, 404, 'AGENT_TEMPLATE_SOURCE_NOT_FOUND');
    definition = {
      name: source.name,
      description: source.description ?? null,
      selector_catalog_version: source.selectorCatalogVersion,
      definition: source.definition as unknown as JsonObject,
    };
    definitionDigest = source.definitionDigest;
  }
  const id = `act_${crypto.randomUUID()}`;
  const now = Date.now();
  await baseline.publishTemplate({
    id,
    version: 1,
    sourceTenantId: controlTenant(c),
    templateType: templateType as AgentConfigurationTemplateType,
    sourceObjectId,
    sourceObjectVersion,
    definition,
    definitionDigest,
    publishedBy: auth(c).userId!,
    publishedAt: now,
    audit: audit(c, 'agent.template.published', 'agent_configuration_template', id, {
      template_type: templateType,
      source_object_id: sourceObjectId,
      source_object_version: sourceObjectVersion,
      definition_digest: definitionDigest,
    }),
  });
  return c.json({ id, version: 1, digest: definitionDigest, status: 'active' }, 201);
});

agentTemplatesRouter.get('/:id/:version/copies', async (c) => {
  if (!permitted(c, ADMIN_PERMISSIONS.AGENT_TEMPLATES_PUBLISH)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const itemVersion = Number(c.req.param('version'));
  if (!Number.isSafeInteger(itemVersion) || itemVersion < 1) {
    return error(c, 400, 'AGENT_TEMPLATE_INVALID_VERSION');
  }
  return c.json({
    copies: await repositories(c).baseline.listTemplateCopies(c.req.param('id'), itemVersion),
  });
});

agentTemplatesRouter.post('/:id/:version/copies', async (c) => {
  if (
    !human(c) ||
    !permitted(c, ADMIN_PERMISSIONS.AGENT_TEMPLATES_PUBLISH) ||
    !permitted(c, ADMIN_PERMISSIONS.BULK_PLANS_APPLY)
  ) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const value = await body(c);
  const itemVersion = Number(c.req.param('version'));
  const tenantIds = value?.target_tenant_ids;
  const bulkPlanId = value?.bulk_plan_id;
  const bulkPlanVersion = value?.bulk_plan_version;
  if (
    !Number.isSafeInteger(itemVersion) ||
    itemVersion < 1 ||
    !Array.isArray(tenantIds) ||
    tenantIds.length === 0 ||
    tenantIds.some((tenantId) => typeof tenantId !== 'string' || !SAFE.test(tenantId)) ||
    new Set(tenantIds).size !== tenantIds.length ||
    typeof bulkPlanId !== 'string' ||
    !SAFE.test(bulkPlanId) ||
    typeof bulkPlanVersion !== 'number' ||
    !Number.isSafeInteger(bulkPlanVersion) ||
    bulkPlanVersion < 1 ||
    !tenantScoped(c, tenantIds as string[]) ||
    !(await activeTenants(c, tenantIds as string[]))
  ) {
    return error(c, 400, 'AGENT_TEMPLATE_COPY_INVALID');
  }
  const { baseline, bulk } = repositories(c);
  const template = await baseline.getTemplate(c.req.param('id'), itemVersion);
  if (!template || template.status !== 'active') {
    return error(c, 404, 'AGENT_TEMPLATE_NOT_FOUND');
  }
  const plan = await bulk.get(controlTenant(c), bulkPlanId, bulkPlanVersion);
  if (plan?.status !== 'completed') return error(c, 409, 'AGENT_TEMPLATE_BULK_PLAN_REQUIRED');
  const executions = await bulk.listTenantExecutions(controlTenant(c), plan.id, plan.version);
  if (
    (tenantIds as string[]).some(
      (tenantId) =>
        !executions.some(
          (execution) => execution.targetTenantId === tenantId && execution.status === 'succeeded'
        )
    )
  ) {
    return error(c, 409, 'AGENT_TEMPLATE_BULK_PLAN_INCOMPLETE');
  }
  const copies = [];
  for (const tenantId of tenantIds as string[]) {
    const copyId = `atc_${crypto.randomUUID()}`;
    const targetObjectId = `${template.templateType === 'task_set' ? 'ats' : 'asp'}_${crypto.randomUUID()}`;
    const copied = await baseline.copyTemplate({
      id: copyId,
      templateId: template.id,
      templateVersion: template.version,
      targetTenantId: tenantId,
      targetObjectId,
      bulkPlanId: plan.id,
      bulkPlanVersion: plan.version,
      copiedBy: auth(c).userId!,
      copiedAt: Date.now(),
      audit: audit(c, 'agent.template.copied', 'agent_template_copy', copyId, {
        template_id: template.id,
        template_version: template.version,
        target_tenant_id: tenantId,
        target_object_status: 'inactive',
        bulk_plan_id: plan.id,
        bulk_plan_version: plan.version,
      }),
    });
    if (!copied) return error(c, 409, 'AGENT_TEMPLATE_COPY_CONFLICT');
    copies.push({ id: copyId, target_tenant_id: tenantId, target_object_id: targetObjectId });
  }
  return c.json({ copies }, 201);
});

agentBaselinesRouter.get('/', async (c) => {
  if (!permitted(c, ADMIN_PERMISSIONS.AGENT_BASELINES_READ)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  return c.json({ baselines: await repositories(c).baseline.listBaselines(controlTenant(c)) });
});

agentBaselinesRouter.post('/', async (c) => {
  if (!human(c) || !permitted(c, ADMIN_PERMISSIONS.AGENT_BASELINES_WRITE)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const value = await body(c);
  const itemName = typeof value?.name === 'string' ? value.name.trim() : '';
  const mode = value?.mode as AgentBaselineMode;
  const enforcement = value?.enforcement as AgentBaselineEnforcement;
  if (!NAME.test(itemName)) return error(c, 400, 'AGENT_BASELINE_INVALID');
  if (enforcement === 'standard_auto_remediation' && !isFreshAdminHuman(auth(c), Date.now())) {
    return error(c, 403, 'AGENT_BASELINE_AUTO_REMEDIATION_FRESH_CONFIRMATION_REQUIRED');
  }
  let resolved;
  try {
    const configuration = await resolveAgentConfigurationPlan({
      definition: (value?.definition as AgentBaselineDefinition).configurationProfile,
      catalog: ADMIN_TOOL_CATALOG,
      maxOperations: 100,
      schemaValidator,
    });
    resolved = await resolveAgentBaselineDefinition({
      definition: {
        ...(value?.definition as AgentBaselineDefinition),
        configurationProfile: configuration.definition,
      },
      mode,
      enforcement,
    });
  } catch {
    return error(c, 400, 'AGENT_BASELINE_INVALID');
  }
  const id = `abl_${crypto.randomUUID()}`;
  const now = Date.now();
  await repositories(c).baseline.createBaseline({
    id,
    version: 1,
    controlTenantId: controlTenant(c),
    name: itemName,
    mode,
    enforcement,
    definition: resolved.definition,
    definitionDigest: resolved.digest,
    createdBy: auth(c).userId!,
    createdAt: now,
    audit: audit(c, 'agent.baseline.created', 'agent_baseline', id, {
      version: 1,
      mode,
      enforcement,
      definition_digest: resolved.digest,
    }),
  });
  return c.json({ id, version: 1, digest: resolved.digest, status: 'active' }, 201);
});

agentBaselinesRouter.get('/:id/:version', async (c) => {
  if (!permitted(c, ADMIN_PERMISSIONS.AGENT_BASELINES_READ)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const itemVersion = Number(c.req.param('version'));
  if (!Number.isSafeInteger(itemVersion) || itemVersion < 1) {
    return error(c, 400, 'AGENT_BASELINE_INVALID_VERSION');
  }
  const repository = repositories(c).baseline;
  const baseline = await repository.getBaseline(controlTenant(c), c.req.param('id'), itemVersion);
  if (!baseline) return error(c, 404, 'AGENT_BASELINE_NOT_FOUND');
  return c.json({
    baseline,
    assignments: await repository.listAssignments(controlTenant(c), baseline.id, baseline.version),
  });
});

agentBaselinesRouter.post('/:id/:version/assignments', async (c) => {
  if (!human(c) || !permitted(c, ADMIN_PERMISSIONS.AGENT_BASELINES_APPLY)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const value = await body(c);
  const itemVersion = Number(c.req.param('version'));
  const tenantId = value?.tenant_id;
  const bulkPlanId = value?.source_bulk_plan_id;
  const bulkPlanVersion = value?.source_bulk_plan_version;
  if (
    !Number.isSafeInteger(itemVersion) ||
    itemVersion < 1 ||
    typeof tenantId !== 'string' ||
    !SAFE.test(tenantId) ||
    typeof bulkPlanId !== 'string' ||
    !SAFE.test(bulkPlanId) ||
    typeof bulkPlanVersion !== 'number' ||
    !Number.isSafeInteger(bulkPlanVersion) ||
    bulkPlanVersion < 1 ||
    !tenantScoped(c, [tenantId])
  ) {
    return error(c, 400, 'AGENT_BASELINE_ASSIGNMENT_INVALID');
  }
  const { baseline: repository, bulk } = repositories(c);
  const [baseline, sourcePlan] = await Promise.all([
    repository.getBaseline(controlTenant(c), c.req.param('id'), itemVersion),
    bulk.get(controlTenant(c), bulkPlanId, bulkPlanVersion),
  ]);
  if (!baseline) return error(c, 404, 'AGENT_BASELINE_NOT_FOUND');
  if (
    sourcePlan?.status !== 'completed' ||
    !sourcePlan.definition ||
    canonicalizeJson(sourcePlan.definition.plan as unknown as JsonObject) !==
      canonicalizeJson(baseline.definition.configurationProfile as unknown as JsonObject)
  ) {
    return error(c, 409, 'AGENT_BASELINE_SOURCE_PLAN_MISMATCH');
  }
  const id = `aba_${crypto.randomUUID()}`;
  const assigned = await repository.assignBaseline({
    id,
    controlTenantId: controlTenant(c),
    baselineId: c.req.param('id'),
    baselineVersion: itemVersion,
    tenantId,
    sourceBulkPlanId: bulkPlanId,
    sourceBulkPlanVersion: bulkPlanVersion,
    assignedBy: auth(c).userId!,
    assignedAt: Date.now(),
    audit: audit(c, 'agent.baseline.assigned', 'agent_baseline_assignment', id, {
      baseline_id: c.req.param('id'),
      baseline_version: itemVersion,
      tenant_id: tenantId,
      source_bulk_plan_id: bulkPlanId,
      source_bulk_plan_version: bulkPlanVersion,
    }),
  });
  return assigned
    ? c.json({ id, drift_status: 'unknown' }, 201)
    : error(c, 409, 'AGENT_BASELINE_ASSIGNMENT_CONFLICT');
});

agentBaselinesRouter.post('/assignments/:assignmentId/evaluate', async (c) => {
  if (!human(c) || !permitted(c, ADMIN_PERMISSIONS.AGENT_BASELINES_APPLY)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const assignmentId = c.req.param('assignmentId');
  const repository = repositories(c).baseline;
  const context = await repository.getAssignmentContext(controlTenant(c), assignmentId);
  if (!context) return error(c, 404, 'AGENT_BASELINE_ASSIGNMENT_NOT_FOUND');
  if (!tenantScoped(c, [context.assignment.tenantId])) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_TENANT_SCOPE');
  }
  if (context.baseline.status !== 'active') {
    return error(c, 409, 'AGENT_BASELINE_NOT_ACTIVE');
  }
  let evaluation;
  try {
    const reader = new CloudflareTenantConfigurationReader(c.env);
    const current = await Promise.all(
      context.baseline.definition.configurationProfile.steps.map(async (step) => ({
        stepId: step.id,
        operation: step.operation,
        current: await reader.readCurrent({ tenantId: context.assignment.tenantId, step }),
      }))
    );
    const exceptions = await repository.listExceptions(controlTenant(c), assignmentId, Date.now());
    evaluation = await evaluateAgentBaselineConfiguration({
      definition: context.baseline.definition,
      current,
      exceptionFields: exceptions.flatMap((exception) => exception.fields),
    });
  } catch {
    return error(c, 503, 'AGENT_BASELINE_EVALUATION_UNAVAILABLE');
  }
  const status = await repository.evaluateAssignment({
    controlTenantId: controlTenant(c),
    assignmentId,
    status: evaluation.status,
    currentDigest: evaluation.currentDigest,
    evaluatedAt: Date.now(),
    audit: audit(c, 'agent.baseline.drift_evaluated', 'agent_baseline_assignment', assignmentId, {
      current_digest: evaluation.currentDigest,
      drift_status: evaluation.status,
      drift_fields: evaluation.driftFields,
      excepted_fields: evaluation.exceptedFields,
    }),
  });
  if (!status) return error(c, 404, 'AGENT_BASELINE_ASSIGNMENT_NOT_FOUND');
  let remediation: {
    status: 'not_applicable' | 'queued' | 'already_queued' | 'blocked';
    bulk_plan_id?: string;
    reason?: string;
  } = { status: 'not_applicable' };
  if (
    status === 'drifted' &&
    context.baseline.mode === 'managed' &&
    context.baseline.enforcement === 'standard_auto_remediation'
  ) {
    let targetSettings;
    try {
      targetSettings = await new CloudflareAgentSettingsProvider(c.env).get(
        context.assignment.tenantId
      );
    } catch {
      remediation = { status: 'blocked', reason: 'policy_unavailable' };
    }
    if (targetSettings) {
      if (targetSettings.bulkCanaryProtected) {
        remediation = { status: 'blocked', reason: 'protected_tenant' };
      } else {
        const bulkPlanId = `abp_baseline_${crypto.randomUUID()}`;
        let reserved = false;
        try {
          reserved = await repository.reserveAutoRemediation({
            controlTenantId: controlTenant(c),
            assignmentId,
            driftDigest: evaluation.currentDigest,
            bulkPlanId,
            bulkPlanVersion: 1,
            requestedAt: Date.now(),
            audit: audit(
              c,
              'agent.baseline.remediation_requested',
              'agent_baseline_assignment',
              assignmentId,
              {
                baseline_id: context.baseline.id,
                baseline_version: context.baseline.version,
                tenant_id: context.assignment.tenantId,
                drift_digest: evaluation.currentDigest,
                bulk_plan_id: bulkPlanId,
              }
            ),
          });
        } catch {
          remediation = { status: 'blocked', reason: 'reservation_unavailable' };
        }
        if (reserved) {
          remediation = { status: 'queued', bulk_plan_id: bulkPlanId };
        } else if (remediation.reason !== 'reservation_unavailable') {
          const latest = await repository.getAssignmentContext(controlTenant(c), assignmentId);
          remediation = {
            status: 'already_queued',
            ...(latest?.assignment.remediationBulkPlanId
              ? { bulk_plan_id: latest.assignment.remediationBulkPlanId }
              : {}),
          };
        }
      }
    }
  }
  return c.json({
    id: assignmentId,
    drift_status: status,
    drift_digest: evaluation.currentDigest,
    drift_fields: evaluation.driftFields,
    excepted_fields: evaluation.exceptedFields,
    remediation,
  });
});

agentBaselinesRouter.post('/assignments/:assignmentId/exceptions', async (c) => {
  if (
    !human(c) ||
    !permitted(c, ADMIN_PERMISSIONS.AGENT_BASELINES_APPLY) ||
    !isFreshAdminHuman(auth(c), Date.now())
  ) {
    return error(c, 403, 'AGENT_BASELINE_EXCEPTION_FRESH_CONFIRMATION_REQUIRED');
  }
  const value = await body(c);
  let exception;
  try {
    exception = validateAgentBaselineException({
      fields: value?.fields as string[],
      reason: value?.reason as string,
      expiresAt: value?.expires_at as number,
      now: Date.now(),
    });
  } catch {
    return error(c, 400, 'AGENT_BASELINE_EXCEPTION_INVALID');
  }
  const assignmentId = c.req.param('assignmentId');
  const repository = repositories(c).baseline;
  const context = await repository.getAssignmentContext(controlTenant(c), assignmentId);
  if (!context) return error(c, 404, 'AGENT_BASELINE_ASSIGNMENT_NOT_FOUND');
  if (!tenantScoped(c, [context.assignment.tenantId])) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_TENANT_SCOPE');
  }
  const id = `abx_${crypto.randomUUID()}`;
  const created = await repository.createException({
    id,
    controlTenantId: controlTenant(c),
    assignmentId,
    fields: exception.fields,
    reason: exception.reason,
    approvedBy: auth(c).userId!,
    approvedAt: Date.now(),
    expiresAt: exception.expiresAt,
    audit: audit(c, 'agent.baseline.exception_approved', 'agent_baseline_exception', id, {
      assignment_id: assignmentId,
      fields: exception.fields,
      expires_at: exception.expiresAt,
    }),
  });
  return created
    ? c.json({ id, assignment_id: assignmentId, expires_at: exception.expiresAt }, 201)
    : error(c, 409, 'AGENT_BASELINE_EXCEPTION_CONFLICT');
});
