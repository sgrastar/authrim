import { Hono } from 'hono';
import type { Context } from 'hono';
import type {
  AdminAuthContext,
  DatabaseAdapter,
  Env,
  SupportOpsActionName,
  SupportOpsSelector,
} from '@authrim/ar-lib-core';
import {
  ADMIN_PERMISSIONS,
  ApprovalRequestApprovalRepository,
  ApprovalRequestRepository,
  buildSupportOpsRiskSummary,
  canonicalizeApprovalScope,
  compileSupportOpsSelector,
  createAuthContextFromHono,
  generateInvestigationId,
  getSupportOpsResource,
  getTenantIdFromContext,
  getTenantSettings,
  hasAdminPermission,
  listSupportOpsResources,
  requireDedicatedAdminDatabaseAdapter,
  resolveAuthCorePersistenceAdapterFromEnv,
  validateSupportOpsAction,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from './admin-shared';
import { getApprovalPresetExpiry } from './approval-policy-presets';

type SupportOpsContext = Context<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>;

interface AggregateRequest {
  resource: string;
  selector?: SupportOpsSelector;
  group_by?: string[];
  metrics?: string[];
}

interface CohortRequest {
  resource: string;
  selector?: SupportOpsSelector;
  intent?: {
    action?: SupportOpsActionName;
    reason?: string;
    support_case_id?: string;
  };
}

interface ActionRequest {
  cohort_id: string;
  action: SupportOpsActionName;
  reason: string;
  support_case_id?: string;
}

interface SupportOpsTargetSnapshotRow {
  target_id: string;
  block_reason: string | null;
}

type SupportOpsDutySeparation = 'requester_approver' | 'requester_approver_executor';
type SupportOpsSnapshotStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

interface SupportOpsSnapshotJobConfig {
  cohort_id: string;
  resource: string;
  intended_action: SupportOpsActionName;
  selector_json: string;
  selector_hash: string;
  matched_count: number;
  snapshot_cutoff: number;
  support_case_id?: string | null;
}

interface SupportOpsSnapshotJobProgress {
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  actionable: number;
  blocked: number;
  last_target_id: string;
  stage: 'queued' | 'processing' | 'completed' | 'failed';
}

interface SupportOpsSnapshotJobRow {
  id: string;
  tenant_id: string;
  status: 'pending' | 'processing';
  progress: string | null;
  config: string | null;
}

interface SupportOpsLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>, error?: Error): void;
}

interface RedactedCohortCounts {
  matched_count: number | null;
  actionable_count: number | null;
  blocked_count: number | null;
  blocked_reasons: string[];
  blocked_reasons_suppressed: boolean;
  privacy: {
    min_count: number;
    low_count_suppressed: boolean;
  };
}

interface SupportOpsCountAuditSummary {
  matched_count: number | null;
  actionable_count: number | null;
  blocked_count: number | null;
  blocked_reasons_suppressed: boolean;
  privacy: {
    min_count: number;
    low_count_suppressed: boolean;
  };
}

export const supportOpsRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

function getAdminAuth(c: SupportOpsContext): AdminAuthContext | undefined {
  return c.get('adminAuth');
}

function requirePermission(c: SupportOpsContext, permission: string): Response | null {
  const auth = getAdminAuth(c);
  if (!hasAdminPermission(auth?.permissions ?? [], permission)) {
    return c.json(
      {
        error: 'forbidden',
        error_description: `Missing permission: ${permission}`,
      },
      403
    );
  }
  return null;
}

function jsonError(c: SupportOpsContext, status: 400 | 404 | 409, error: string, message: string) {
  return c.json({ error, error_description: message }, status);
}

function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function fromJsonRecord(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseSupportOpsSelectorJson(value: string | null): SupportOpsSelector | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid_snapshot_selector_json');
    }
    return Object.keys(parsed as Record<string, unknown>).length === 0
      ? undefined
      : (parsed as SupportOpsSelector);
  } catch {
    throw new Error('invalid_snapshot_selector_json');
  }
}

function parseSnapshotJobProgress(value: string | null): SupportOpsSnapshotJobProgress {
  const fallback: SupportOpsSnapshotJobProgress = {
    total: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    actionable: 0,
    blocked: 0,
    last_target_id: '',
    stage: 'queued',
  };
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value) as Partial<SupportOpsSnapshotJobProgress>;
    return {
      total: Number(parsed.total ?? 0),
      processed: Number(parsed.processed ?? 0),
      succeeded: Number(parsed.succeeded ?? 0),
      failed: Number(parsed.failed ?? 0),
      actionable: Number(parsed.actionable ?? 0),
      blocked: Number(parsed.blocked ?? 0),
      last_target_id: typeof parsed.last_target_id === 'string' ? parsed.last_target_id : '',
      stage:
        parsed.stage === 'processing' || parsed.stage === 'completed' || parsed.stage === 'failed'
          ? parsed.stage
          : 'queued',
    };
  } catch {
    return fallback;
  }
}

function parseSnapshotJobConfig(value: string | null): SupportOpsSnapshotJobConfig | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<SupportOpsSnapshotJobConfig>;
    if (
      typeof parsed.cohort_id !== 'string' ||
      typeof parsed.resource !== 'string' ||
      typeof parsed.intended_action !== 'string' ||
      typeof parsed.selector_json !== 'string' ||
      typeof parsed.selector_hash !== 'string' ||
      typeof parsed.matched_count !== 'number' ||
      typeof parsed.snapshot_cutoff !== 'number'
    ) {
      return null;
    }
    return parsed as SupportOpsSnapshotJobConfig;
  } catch {
    return null;
  }
}

function createSupportOpsAuthContext(c: SupportOpsContext, tenantId: string) {
  return createAuthContextFromHono(
    c as unknown as Parameters<typeof createAuthContextFromHono>[0],
    tenantId
  );
}

function isLowCount(value: number, minCount: number): boolean {
  return value > 0 && value < minCount;
}

function redactCohortCounts(
  resource: { minCount: number },
  matchedCount: number,
  actionableCount: number,
  blockedCount: number,
  blockedReasons: string[] = []
): RedactedCohortCounts {
  const actionableSuppressed = isLowCount(actionableCount, resource.minCount);
  const blockedSuppressed = isLowCount(blockedCount, resource.minCount);
  const matchedSuppressed =
    isLowCount(matchedCount, resource.minCount) ||
    (actionableSuppressed && blockedCount > 0) ||
    (blockedSuppressed && actionableCount > 0);

  return {
    matched_count: matchedSuppressed ? null : matchedCount,
    actionable_count: actionableSuppressed ? null : actionableCount,
    blocked_count: blockedSuppressed ? null : blockedCount,
    blocked_reasons: blockedSuppressed ? [] : blockedReasons,
    blocked_reasons_suppressed: blockedSuppressed,
    privacy: {
      min_count: resource.minCount,
      low_count_suppressed: matchedSuppressed || actionableSuppressed || blockedSuppressed,
    },
  };
}

function redactResultSummary(
  resource: { minCount: number },
  resultSummary: Record<string, unknown>,
  matchedCount: number,
  actionableCount: number,
  blockedCount: number
): Record<string, unknown> {
  const redacted = redactCohortCounts(resource, matchedCount, actionableCount, blockedCount);
  return {
    ...resultSummary,
    matched_count: redacted.matched_count,
    attempted_count: redacted.actionable_count,
    blocked_count: redacted.blocked_count,
    blocked_reasons_suppressed: redacted.blocked_reasons_suppressed,
    privacy: redacted.privacy,
  };
}

function redactCountAuditSummary(
  resource: { minCount: number },
  matchedCount: number,
  actionableCount: number,
  blockedCount: number
): SupportOpsCountAuditSummary {
  const redacted = redactCohortCounts(resource, matchedCount, actionableCount, blockedCount);
  return {
    matched_count: redacted.matched_count,
    actionable_count: redacted.actionable_count,
    blocked_count: redacted.blocked_count,
    blocked_reasons_suppressed: redacted.blocked_reasons_suppressed,
    privacy: redacted.privacy,
  };
}

function bucketAggregateCount(value: number, minCount: number): number | null {
  if (isLowCount(value, minCount)) {
    return null;
  }
  return Math.floor(value / minCount) * minCount;
}

function hasActionableMinimum(actionableCount: number, minCount: number): boolean {
  return actionableCount >= minCount;
}

function isBooleanTrue(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

async function getSupportOpsTenantSettings(
  c: SupportOpsContext,
  tenantId: string
): Promise<{ allowSelfApproval: boolean; dutySeparation: SupportOpsDutySeparation }> {
  const settings =
    (await getTenantSettings(c.env.SETTINGS, tenantId, 'support-ops')) ??
    (await getTenantSettings(c.env.AUTHRIM_CONFIG, tenantId, 'support-ops'));
  const dutySeparation = settings?.['support_ops.duty_separation'];

  return {
    allowSelfApproval: isBooleanTrue(settings?.['support_ops.allow_self_approval']),
    dutySeparation:
      dutySeparation === 'requester_approver_executor'
        ? 'requester_approver_executor'
        : 'requester_approver',
  };
}

async function createSupportOpsApprovalRequest(
  c: SupportOpsContext,
  input: {
    tenantId: string;
    actionId: string;
    cohortId: string;
    resource: string;
    action: SupportOpsActionName;
    selectorHash: string;
    matchedCount: number;
    actionableCount: number;
    blockedCount: number;
    reason: string;
    supportCaseId?: string | null;
    actor: string;
  }
): Promise<string> {
  const adminAdapter = requireDedicatedAdminDatabaseAdapter(c.env, 'support-ops-approval');
  const requestRepo = new ApprovalRequestRepository(adminAdapter);
  const approvalRepo = new ApprovalRequestApprovalRepository(adminAdapter);
  const investigationId = input.supportCaseId || generateInvestigationId();
  const expiresAt = getApprovalPresetExpiry('support_case_default');
  const approvalCounts = redactCountAuditSummary(
    { minCount: getSupportOpsResource(input.resource)?.minCount ?? 10 },
    input.matchedCount,
    input.actionableCount,
    input.blockedCount
  );
  const scope = canonicalizeApprovalScope({
    version: 1,
    surface: 'support_ops',
    action: `support_action.${input.action}`,
    tenant_id: input.tenantId,
    resource_class: 'support_operation_cohort',
    resource_ids: [input.cohortId],
    detail_classes: ['summary'],
    investigation_id: investigationId,
    redaction_level: 'summary_only',
    attributes: {
      support_action_id: input.actionId,
      cohort_id: input.cohortId,
      resource: input.resource,
      action: input.action,
      selector_hash: input.selectorHash,
      counts: {
        matched_count: approvalCounts.matched_count,
        actionable_count: approvalCounts.actionable_count,
        blocked_count: approvalCounts.blocked_count,
        blocked_reasons_suppressed: approvalCounts.blocked_reasons_suppressed,
        min_count: approvalCounts.privacy.min_count,
        low_count_suppressed: approvalCounts.privacy.low_count_suppressed,
      },
    },
  });
  const request = await requestRepo.createApprovalRequest({
    tenant_id: input.tenantId,
    investigation_id: investigationId,
    requester_subject_type: 'admin_user',
    requester_subject_id: input.actor,
    target_subject_type: 'tenant_resource',
    target_subject_id: input.cohortId,
    request_surface: 'support_ops',
    requested_action: `support_action.${input.action}`,
    redaction_level: 'summary_only',
    scope_json: scope.normalized,
    scope_canonical: scope.canonical,
    reason_code: 'support_ops_action_request',
    reason_note: input.reason,
    ticket_reference: input.supportCaseId
      ? { system: 'support_case', id: input.supportCaseId }
      : null,
    policy_preset: 'support_case_default',
    reuse_scope: 'request',
    partial_access_allowed: false,
    expires_at: expiresAt,
  });
  await approvalRepo.createApproval({
    approval_request_id: request.id,
    step_key: 'support-ops-approval',
    side: 'admin_operator',
    subject_type: 'admin_user',
    subject_id: null,
    relation_type: null,
    relation_source: 'support_ops_policy',
    method: null,
    transport_channel: null,
    notification_count: 0,
    last_notification_action: null,
    last_notified_at: null,
    expires_at: request.expires_at,
  });
  return request.public_request_id;
}

async function getSupportOpsApprovalWorkflowState(
  c: SupportOpsContext,
  approvalRequestId: string | null,
  expected: {
    tenantId: string;
    actionId: string;
    cohortId: string;
    action: string;
    selectorHash: string;
  }
): Promise<{ approved: boolean; approvedBy: string[]; bound: boolean }> {
  if (!approvalRequestId) {
    return { approved: false, approvedBy: [], bound: false };
  }
  const adminAdapter = requireDedicatedAdminDatabaseAdapter(c.env, 'support-ops-approval-state');
  const requestRepo = new ApprovalRequestRepository(adminAdapter);
  const approvalRepo = new ApprovalRequestApprovalRepository(adminAdapter);
  const request = await requestRepo.getApprovalRequestByPublicId(approvalRequestId);
  if (!request) {
    return { approved: false, approvedBy: [], bound: false };
  }
  const attributes = request.scope_json.attributes ?? {};
  const resourceIds = request.scope_json.resource_ids ?? [];
  const bound =
    request.tenant_id === expected.tenantId &&
    request.request_surface === 'support_ops' &&
    request.requested_action === `support_action.${expected.action}` &&
    request.target_subject_id === expected.cohortId &&
    request.scope_json.surface === 'support_ops' &&
    request.scope_json.action === `support_action.${expected.action}` &&
    request.scope_json.tenant_id === expected.tenantId &&
    request.scope_json.resource_class === 'support_operation_cohort' &&
    resourceIds.length === 1 &&
    resourceIds[0] === expected.cohortId &&
    attributes.support_action_id === expected.actionId &&
    attributes.cohort_id === expected.cohortId &&
    attributes.action === expected.action &&
    attributes.selector_hash === expected.selectorHash;
  if (!bound) {
    return { approved: false, approvedBy: [], bound: false };
  }
  const approvals = await approvalRepo.listApprovalsForRequest(request.id);
  return {
    approved: request.status === 'approved' && request.expires_at > Date.now(),
    bound,
    approvedBy: approvals
      .filter((approval) => approval.status === 'approved' && approval.subject_id)
      .map((approval) => approval.subject_id as string),
  };
}

async function auditSupportOps(
  c: SupportOpsContext,
  action: string,
  resourceId: string | null,
  result: 'success' | 'failure',
  metadata?: Record<string, unknown>
): Promise<void> {
  await writeAdminAuditLog(c, {
    action,
    resourceType: 'support_ops',
    resourceId,
    result,
    metadata,
  });
}

function buildBlockExpression(action?: SupportOpsActionName): string {
  if (action !== 'suspend') {
    return 'NULL';
  }
  return `CASE
    WHEN status != 'active' THEN 'not_active'
    WHEN lifecycle_state = 'deprovisioned' THEN 'deprovisioned'
    ELSE NULL
  END`;
}

function buildSnapshotCutoffExpression(resource: {
  table: string;
  fields: Record<string, { column: string }>;
}): string {
  const createdAt = resource.fields.created_at?.column;
  const updatedAt = resource.fields.updated_at?.column;
  if (!createdAt || !updatedAt) {
    throw new Error('Resource does not support stable snapshot cutoffs');
  }
  return `${resource.table}.${createdAt} <= ? AND ${resource.table}.${updatedAt} <= ?`;
}

async function getCohortCounts(
  coreAdapter: ReturnType<typeof createAuthContextFromHono>['coreAdapter'],
  cohortId: string,
  tenantId: string
): Promise<{ actionable: number; blocked: number; blockedReasons: string[] }> {
  const actionable = await coreAdapter.queryOne<{ count: number }>(
    `SELECT COUNT(*) as count
       FROM support_operation_cohort_targets
      WHERE tenant_id = ? AND cohort_id = ? AND block_reason IS NULL`,
    [tenantId, cohortId]
  );
  const blocked = await coreAdapter.queryOne<{ count: number }>(
    `SELECT COUNT(*) as count
       FROM support_operation_cohort_targets
      WHERE tenant_id = ? AND cohort_id = ? AND block_reason IS NOT NULL`,
    [tenantId, cohortId]
  );
  const reasons = await coreAdapter.query<{ block_reason: string }>(
    `SELECT DISTINCT block_reason
       FROM support_operation_cohort_targets
      WHERE tenant_id = ? AND cohort_id = ? AND block_reason IS NOT NULL
      ORDER BY block_reason`,
    [tenantId, cohortId]
  );
  return {
    actionable: actionable?.count ?? 0,
    blocked: blocked?.count ?? 0,
    blockedReasons: reasons.map((row) => row.block_reason),
  };
}

async function cleanupCohort(
  coreAdapter: ReturnType<typeof createAuthContextFromHono>['coreAdapter'],
  cohortId: string,
  tenantId: string
): Promise<void> {
  await coreAdapter.execute(
    'DELETE FROM support_operation_cohort_targets WHERE tenant_id = ? AND cohort_id = ?',
    [tenantId, cohortId]
  );
  await coreAdapter.execute(
    'DELETE FROM support_operation_cohorts WHERE tenant_id = ? AND id = ?',
    [tenantId, cohortId]
  );
}

async function createSupportOpsSnapshotJob(
  coreAdapter: DatabaseAdapter,
  input: {
    jobId?: string;
    tenantId: string;
    cohortId: string;
    resource: string;
    intendedAction: SupportOpsActionName;
    selectorJson: string;
    selectorHash: string;
    matchedCount: number;
    snapshotCutoff: number;
    actor: string;
    supportCaseId?: string | null;
  }
): Promise<string> {
  const jobId = input.jobId ?? crypto.randomUUID();
  const nowTs = Math.floor(Date.now() / 1000);
  const progress: SupportOpsSnapshotJobProgress = {
    total: input.matchedCount,
    processed: 0,
    succeeded: 0,
    failed: 0,
    actionable: 0,
    blocked: 0,
    last_target_id: '',
    stage: 'queued',
  };
  const config: SupportOpsSnapshotJobConfig = {
    cohort_id: input.cohortId,
    resource: input.resource,
    intended_action: input.intendedAction,
    selector_json: input.selectorJson,
    selector_hash: input.selectorHash,
    matched_count: input.matchedCount,
    snapshot_cutoff: input.snapshotCutoff,
    support_case_id: input.supportCaseId ?? null,
  };

  await coreAdapter.execute(
    `INSERT INTO admin_jobs (
      id, tenant_id, job_type, status, progress, config,
      created_by, created_at, updated_at, estimated_completion
    ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    [
      jobId,
      input.tenantId,
      'support-ops/cohort-snapshot',
      toJson(progress),
      toJson(config),
      input.actor,
      nowTs,
      nowTs,
      nowTs + Math.max(60, Math.ceil(input.matchedCount / 5000) * 60),
    ]
  );
  return jobId;
}

async function updateSnapshotJobFailure(
  coreAdapter: DatabaseAdapter,
  jobId: string,
  tenantId: string,
  cohortId: string,
  message: string
): Promise<void> {
  const nowMs = Date.now();
  const nowTs = Math.floor(nowMs / 1000);
  await coreAdapter.execute(
    `UPDATE support_operation_cohorts
        SET snapshot_status = 'failed', snapshot_error = ?, snapshot_job_id = COALESCE(snapshot_job_id, ?)
      WHERE tenant_id = ? AND id = ?`,
    [message, jobId, tenantId, cohortId]
  );
  await coreAdapter.execute(
    `UPDATE admin_jobs
        SET status = 'failed', error_message = ?, completed_at = ?, updated_at = ?
      WHERE tenant_id = ? AND id = ?`,
    [message, nowTs, nowTs, tenantId, jobId]
  );
}

async function processSupportOpsSnapshotJob(
  coreAdapter: DatabaseAdapter,
  job: SupportOpsSnapshotJobRow,
  logger?: SupportOpsLogger
): Promise<void> {
  const config = parseSnapshotJobConfig(job.config);
  if (!config) {
    await updateSnapshotJobFailure(
      coreAdapter,
      job.id,
      job.tenant_id,
      'unknown',
      'invalid_snapshot_job_config'
    );
    return;
  }

  const resource = getSupportOpsResource(config.resource);
  if (!resource) {
    await updateSnapshotJobFailure(
      coreAdapter,
      job.id,
      job.tenant_id,
      config.cohort_id,
      'unsupported_resource'
    );
    return;
  }

  const startedTs = Math.floor(Date.now() / 1000);
  const leaseCutoffTs = startedTs - 15 * 60;
  const transition = await coreAdapter.execute(
    `UPDATE admin_jobs
        SET status = 'processing', started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE tenant_id = ? AND id = ?
        AND (status = 'pending' OR (status = 'processing' AND updated_at < ?))`,
    [startedTs, startedTs, job.tenant_id, job.id, leaseCutoffTs]
  );
  if (transition.rowsAffected === 0) return;

  try {
    await coreAdapter.execute(
      `UPDATE support_operation_cohorts
          SET snapshot_status = 'running', snapshot_job_id = ?, snapshot_error = NULL
        WHERE tenant_id = ? AND id = ? AND snapshot_status IN ('pending', 'running')`,
      [job.id, job.tenant_id, config.cohort_id]
    );

    const progress = parseSnapshotJobProgress(job.progress);
    progress.total = config.matched_count;
    progress.stage = 'processing';

    const selector = parseSupportOpsSelectorJson(config.selector_json);
    const compiled = await compileSupportOpsSelector(resource, selector);
    const blockExpression = buildBlockExpression(config.intended_action);
    const cutoffExpression = buildSnapshotCutoffExpression(resource);
    const pageSize = 500;
    const maxRowsPerRun = 5000;
    let processedThisRun = 0;

    while (processedThisRun < maxRowsPerRun) {
      const rows = await coreAdapter.query<SupportOpsTargetSnapshotRow>(
        `SELECT ${resource.idColumn} as target_id, ${blockExpression} as block_reason
           FROM ${resource.table}
          WHERE tenant_id = ? AND is_active = 1 AND ${compiled.whereSql}
            AND ${cutoffExpression}
            AND ${resource.idColumn} > ?
            AND NOT EXISTS (
              SELECT 1
                FROM support_operation_cohort_targets existing
               WHERE existing.tenant_id = ?
                 AND existing.cohort_id = ?
                 AND existing.target_id = ${resource.table}.${resource.idColumn}
            )
          ORDER BY ${resource.idColumn} ASC
          LIMIT ?`,
        [
          job.tenant_id,
          ...compiled.params,
          config.snapshot_cutoff,
          config.snapshot_cutoff,
          progress.last_target_id,
          job.tenant_id,
          config.cohort_id,
          pageSize,
        ]
      );

      if (rows.length === 0) {
        const counts = await getCohortCounts(coreAdapter, config.cohort_id, job.tenant_id);
        if (!hasActionableMinimum(counts.actionable, resource.minCount)) {
          await coreAdapter.execute(
            'DELETE FROM support_operation_cohort_targets WHERE tenant_id = ? AND cohort_id = ?',
            [job.tenant_id, config.cohort_id]
          );
          await updateSnapshotJobFailure(
            coreAdapter,
            job.id,
            job.tenant_id,
            config.cohort_id,
            'actionable_min_count_not_met'
          );
          return;
        }
        const nowTs = Math.floor(Date.now() / 1000);
        const finalProgress: SupportOpsSnapshotJobProgress = {
          ...progress,
          processed: progress.processed,
          succeeded: progress.succeeded,
          actionable: counts.actionable,
          blocked: counts.blocked,
          stage: 'completed',
        };
        await coreAdapter.execute(
          `UPDATE support_operation_cohorts
              SET snapshot_status = 'completed',
                  actionable_count = ?,
                  blocked_count = ?,
                  blocked_summary_json = ?,
                  snapshot_error = NULL
            WHERE tenant_id = ? AND id = ?`,
          [
            counts.actionable,
            counts.blocked,
            toJson({ reasons: counts.blockedReasons }),
            job.tenant_id,
            config.cohort_id,
          ]
        );
        await coreAdapter.execute(
          `UPDATE admin_jobs
              SET status = 'completed', progress = ?, result = ?, completed_at = ?, updated_at = ?
            WHERE tenant_id = ? AND id = ?`,
          [
            toJson(finalProgress),
            toJson({
              cohort_id: config.cohort_id,
              matched_count: config.matched_count,
              actionable_count: counts.actionable,
              blocked_count: counts.blocked,
            }),
            nowTs,
            nowTs,
            job.tenant_id,
            job.id,
          ]
        );
        logger?.info('Support Ops snapshot job completed', {
          job_id: job.id,
          cohort_id: config.cohort_id,
        });
        return;
      }

      for (const target of rows) {
        await coreAdapter.execute(
          `INSERT INTO support_operation_cohort_targets (
            id, cohort_id, tenant_id, resource, target_id, target_hash, block_reason, created_at
          ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
          [
            `sct_${crypto.randomUUID().replace(/-/g, '')}`,
            config.cohort_id,
            job.tenant_id,
            resource.resource,
            target.target_id,
            target.block_reason ?? null,
            Date.now(),
          ]
        );
        progress.processed += 1;
        progress.succeeded += 1;
        if (target.block_reason) {
          progress.blocked += 1;
        } else {
          progress.actionable += 1;
        }
      }
      progress.last_target_id = rows[rows.length - 1]?.target_id ?? progress.last_target_id;
      processedThisRun += rows.length;

      const nowTs = Math.floor(Date.now() / 1000);
      await coreAdapter.execute(
        `UPDATE admin_jobs
            SET progress = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?`,
        [toJson(progress), nowTs, job.tenant_id, job.id]
      );

      if (rows.length < pageSize) {
        continue;
      }
    }

    const nowTs = Math.floor(Date.now() / 1000);
    await coreAdapter.execute(
      `UPDATE admin_jobs
          SET status = 'pending', progress = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ? AND status = 'processing'`,
      [toJson(progress), nowTs, job.tenant_id, job.id]
    );
  } catch (error) {
    await updateSnapshotJobFailure(
      coreAdapter,
      job.id,
      job.tenant_id,
      config.cohort_id,
      'snapshot_processing_failed'
    );
    logger?.error(
      'Support Ops snapshot job failed',
      { job_id: job.id, cohort_id: config.cohort_id },
      error as Error
    );
  }
}

export async function processPendingSupportOpsSnapshotJobs(
  env: Env,
  logger?: SupportOpsLogger
): Promise<void> {
  const coreAdapter = await resolveAuthCorePersistenceAdapterFromEnv(
    env,
    'support-ops-snapshot-jobs'
  );
  const jobs = await coreAdapter.query<SupportOpsSnapshotJobRow>(
    `SELECT id, tenant_id, status, progress, config
       FROM admin_jobs
      WHERE job_type = 'support-ops/cohort-snapshot'
        AND (status = 'pending' OR (status = 'processing' AND updated_at < ?))
      ORDER BY created_at ASC
      LIMIT 3`,
    [Math.floor(Date.now() / 1000) - 15 * 60]
  );
  for (const job of jobs) {
    await processSupportOpsSnapshotJob(coreAdapter, job, logger);
  }
}

supportOpsRouter.get('/registry', (c) => {
  const forbidden = requirePermission(c, ADMIN_PERMISSIONS.SUPPORT_OPS_REGISTRY_READ);
  if (forbidden) return forbidden;
  return c.json({ resources: listSupportOpsResources() });
});

supportOpsRouter.post('/aggregate', async (c) => {
  const forbidden = requirePermission(c, ADMIN_PERMISSIONS.SUPPORT_OPS_AGGREGATE_READ);
  if (forbidden) return forbidden;

  const body = await c.req.json<AggregateRequest>();
  const resource = getSupportOpsResource(body.resource);
  if (!resource) return jsonError(c, 400, 'unsupported_resource', 'Unsupported resource');

  const groupBy = body.group_by ?? [];
  if (groupBy.length === 0 || groupBy.length > 3) {
    return jsonError(c, 400, 'invalid_group_by', 'group_by must include 1-3 fields');
  }
  for (const fieldName of groupBy) {
    const field = resource.fields[fieldName];
    if (!field || !field.aggregatable || field.sensitive) {
      return jsonError(c, 400, 'invalid_group_by', `Field is not aggregatable: ${fieldName}`);
    }
  }

  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createSupportOpsAuthContext(c, tenantId);
    const compiled = await compileSupportOpsSelector(resource, body.selector);
    const selectColumns = groupBy.map((name) => resource.fields[name].column);
    const rows = await authCtx.coreAdapter.query<Record<string, unknown>>(
      `SELECT ${selectColumns.join(', ')}, COUNT(*) as count
         FROM ${resource.table}
        WHERE tenant_id = ? AND is_active = 1 AND ${compiled.whereSql}
        GROUP BY ${selectColumns.join(', ')}
        ORDER BY count DESC
        LIMIT 100`,
      [tenantId, ...compiled.params]
    );

    let lowCountSuppressedGroups = 0;
    let complementarySuppressedGroups = 0;
    const visibleCandidates: Array<{
      key: Record<string, unknown>;
      count: number;
      rawCount: number;
    }> = [];
    for (const row of rows) {
      const rawCount = Number(row.count ?? 0);
      const bucketedCount = bucketAggregateCount(rawCount, resource.minCount);
      if (bucketedCount === null) {
        lowCountSuppressedGroups += 1;
        continue;
      }
      const key: Record<string, unknown> = {};
      for (const name of groupBy) {
        key[name] = row[resource.fields[name].column];
      }
      visibleCandidates.push({ key, count: bucketedCount, rawCount });
    }
    const groups = visibleCandidates
      .filter((row) => {
        if (lowCountSuppressedGroups === 0 || row.rawCount >= resource.minCount * 2) {
          return true;
        }
        complementarySuppressedGroups += 1;
        return false;
      })
      .map(({ key, count }) => ({ key, count }));
    const suppressedGroups = lowCountSuppressedGroups + complementarySuppressedGroups;

    await auditSupportOps(c, 'support_ops.aggregate', null, 'success', {
      resource: resource.resource,
      group_by: groupBy,
      selector_hash: compiled.selectorHash,
      suppressed_groups: suppressedGroups,
      count_precision: resource.minCount,
    });

    return c.json({
      resource: resource.resource,
      groups,
      suppressed_groups: suppressedGroups,
      privacy: {
        min_count: resource.minCount,
        count_precision: resource.minCount,
        count_exact: false,
        low_count_suppressed: suppressedGroups > 0,
        complementary_suppression: complementarySuppressedGroups > 0,
      },
    });
  } catch {
    await auditSupportOps(c, 'support_ops.aggregate', null, 'failure', {
      resource: body.resource,
      reason: 'invalid_selector',
    });
    return jsonError(c, 400, 'invalid_selector', 'Invalid selector');
  }
});

supportOpsRouter.post('/cohorts/preview', async (c) => {
  const forbidden = requirePermission(c, ADMIN_PERMISSIONS.SUPPORT_OPS_COHORTS_PREVIEW);
  if (forbidden) return forbidden;

  const body = await c.req.json<CohortRequest>();
  const resource = getSupportOpsResource(body.resource);
  if (!resource) return jsonError(c, 400, 'unsupported_resource', 'Unsupported resource');
  const intendedAction = body.intent?.action;
  if (intendedAction) {
    const actionValidation = validateSupportOpsAction(resource, intendedAction);
    if (!actionValidation.valid) {
      return jsonError(
        c,
        400,
        'unsupported_action',
        actionValidation.error ?? 'Unsupported action'
      );
    }
  }

  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createSupportOpsAuthContext(c, tenantId);
    const compiled = await compileSupportOpsSelector(resource, body.selector);
    const matched = await authCtx.coreAdapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count
         FROM ${resource.table}
        WHERE tenant_id = ? AND is_active = 1 AND ${compiled.whereSql}`,
      [tenantId, ...compiled.params]
    );
    const blockExpression = buildBlockExpression(body.intent?.action);
    const actionable = await authCtx.coreAdapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count
         FROM ${resource.table}
        WHERE tenant_id = ? AND is_active = 1 AND ${compiled.whereSql}
          AND (${blockExpression}) IS NULL`,
      [tenantId, ...compiled.params]
    );
    const blockedRows = await authCtx.coreAdapter.query<{ block_reason: string }>(
      `SELECT block_reason
         FROM (
           SELECT ${blockExpression} as block_reason
             FROM ${resource.table}
            WHERE tenant_id = ? AND is_active = 1 AND ${compiled.whereSql}
         )
        WHERE block_reason IS NOT NULL
        GROUP BY block_reason
        ORDER BY block_reason`,
      [tenantId, ...compiled.params]
    );
    const matchedCount = matched?.count ?? 0;
    const actionableCount = actionable?.count ?? matchedCount;
    const blockedCount = matchedCount - actionableCount;
    const redactedCounts = redactCohortCounts(
      resource,
      matchedCount,
      actionableCount,
      blockedCount,
      blockedRows.map((row) => row.block_reason)
    );
    const risk = buildSupportOpsRiskSummary({
      resource,
      matchedCount,
      action: body.intent?.action,
    });

    await auditSupportOps(c, 'support_ops.cohort.preview', null, 'success', {
      resource: resource.resource,
      selector_hash: compiled.selectorHash,
      counts: redactCountAuditSummary(resource, matchedCount, actionableCount, blockedCount),
      support_case_id: body.intent?.support_case_id ?? null,
    });

    return c.json({
      resource: resource.resource,
      ...redactedCounts,
      risk: {
        min_count: risk.minCount,
        matched_count: redactedCounts.matched_count,
        low_count_suppressed: redactedCounts.privacy.low_count_suppressed,
        uses_sensitive_field: risk.usesSensitiveField,
        risk_level: risk.riskLevel,
        approval_required: risk.approvalRequired,
      },
      selector_hash: compiled.selectorHash,
    });
  } catch {
    await auditSupportOps(c, 'support_ops.cohort.preview', null, 'failure', {
      resource: body.resource,
      reason: 'invalid_selector',
    });
    return jsonError(c, 400, 'invalid_selector', 'Invalid selector');
  }
});

supportOpsRouter.post('/cohorts', async (c) => {
  const forbidden = requirePermission(c, ADMIN_PERMISSIONS.SUPPORT_OPS_COHORTS_CREATE);
  if (forbidden) return forbidden;

  const body = await c.req.json<CohortRequest>();
  const resource = getSupportOpsResource(body.resource);
  if (!resource) return jsonError(c, 400, 'unsupported_resource', 'Unsupported resource');
  const intendedAction = body.intent?.action;
  if (!intendedAction) {
    return jsonError(c, 400, 'action_required', 'intent.action is required for cohort creation');
  }
  const actionValidation = validateSupportOpsAction(resource, intendedAction);
  if (!actionValidation.valid) {
    return jsonError(c, 400, 'unsupported_action', actionValidation.error ?? 'Unsupported action');
  }

  let createdCohort: {
    coreAdapter: ReturnType<typeof createAuthContextFromHono>['coreAdapter'];
    tenantId: string;
    cohortId: string;
  } | null = null;
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createSupportOpsAuthContext(c, tenantId);
    const compiled = await compileSupportOpsSelector(resource, body.selector);
    const now = Date.now();
    const snapshotCutoff = now;
    const cutoffExpression = buildSnapshotCutoffExpression(resource);
    const matched = await authCtx.coreAdapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count
         FROM ${resource.table}
        WHERE tenant_id = ? AND is_active = 1 AND ${compiled.whereSql}
          AND ${cutoffExpression}`,
      [tenantId, ...compiled.params, snapshotCutoff, snapshotCutoff]
    );
    const matchedCount = matched?.count ?? 0;
    if (matchedCount > 0 && matchedCount < resource.minCount) {
      return jsonError(
        c,
        400,
        'cohort_below_min_count',
        `Cohort must include at least ${resource.minCount} matched records`
      );
    }
    const cohortId = `cohort_${crypto.randomUUID().replace(/-/g, '')}`;
    const expiresAt = now + 24 * 60 * 60 * 1000;
    const blockExpression = buildBlockExpression(intendedAction);
    const risk = buildSupportOpsRiskSummary({
      resource,
      matchedCount,
      action: intendedAction,
    });
    const actor = getAdminAuth(c)?.userId ?? 'system';
    const selectorJson = toJson(body.selector ?? {});

    if (matchedCount > resource.maxSnapshotCount) {
      const jobId = crypto.randomUUID();
      await authCtx.coreAdapter.execute(
        `INSERT INTO support_operation_cohorts (
          id, tenant_id, resource, intended_action, selector_json, selector_hash,
          matched_count, actionable_count, blocked_count, blocked_summary_json,
          snapshot_status, snapshot_job_id, snapshot_error,
          risk_json, created_by, support_case_id, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'pending', ?, NULL, ?, ?, ?, ?, ?)`,
        [
          cohortId,
          tenantId,
          resource.resource,
          intendedAction,
          selectorJson,
          compiled.selectorHash,
          matchedCount,
          toJson({}),
          jobId,
          toJson(risk),
          actor,
          body.intent?.support_case_id ?? null,
          expiresAt,
          now,
        ]
      );
      createdCohort = { coreAdapter: authCtx.coreAdapter, tenantId, cohortId };

      await createSupportOpsSnapshotJob(authCtx.coreAdapter, {
        jobId,
        tenantId,
        cohortId,
        resource: resource.resource,
        intendedAction,
        selectorJson,
        selectorHash: compiled.selectorHash,
        matchedCount,
        snapshotCutoff,
        actor,
        supportCaseId: body.intent?.support_case_id ?? null,
      });

      await auditSupportOps(c, 'support_ops.cohort.create', cohortId, 'success', {
        resource: resource.resource,
        intended_action: intendedAction,
        selector_hash: compiled.selectorHash,
        counts: redactCountAuditSummary(resource, matchedCount, 0, 0),
        snapshot_status: 'pending',
        snapshot_job_id: jobId,
        support_case_id: body.intent?.support_case_id ?? null,
      });

      return c.json(
        {
          cohort_id: cohortId,
          resource: resource.resource,
          intended_action: intendedAction,
          matched_count: matchedCount,
          actionable_count: null,
          blocked_count: null,
          blocked_reasons: [],
          blocked_reasons_suppressed: false,
          privacy: {
            min_count: resource.minCount,
            low_count_suppressed: false,
          },
          snapshot_status: 'pending' as SupportOpsSnapshotStatus,
          snapshot_job_id: jobId,
          expires_at: expiresAt,
          selector_hash: compiled.selectorHash,
          risk,
        },
        202
      );
    }

    await authCtx.coreAdapter.execute(
      `INSERT INTO support_operation_cohorts (
        id, tenant_id, resource, intended_action, selector_json, selector_hash,
        matched_count, actionable_count, blocked_count, blocked_summary_json,
        snapshot_status, snapshot_job_id, snapshot_error,
        risk_json, created_by, support_case_id, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'running', NULL, NULL, ?, ?, ?, ?, ?)`,
      [
        cohortId,
        tenantId,
        resource.resource,
        intendedAction,
        selectorJson,
        compiled.selectorHash,
        matchedCount,
        toJson({}),
        toJson(risk),
        actor,
        body.intent?.support_case_id ?? null,
        expiresAt,
        now,
      ]
    );
    createdCohort = { coreAdapter: authCtx.coreAdapter, tenantId, cohortId };

    const targetRows = await authCtx.coreAdapter.query<SupportOpsTargetSnapshotRow>(
      `SELECT ${resource.idColumn} as target_id, ${blockExpression} as block_reason
         FROM ${resource.table}
        WHERE tenant_id = ? AND is_active = 1 AND ${compiled.whereSql}
          AND ${cutoffExpression}`,
      [tenantId, ...compiled.params, snapshotCutoff, snapshotCutoff]
    );
    for (const target of targetRows) {
      await authCtx.coreAdapter.execute(
        `INSERT INTO support_operation_cohort_targets (
          id, cohort_id, tenant_id, resource, target_id, target_hash, block_reason, created_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        [
          `sct_${crypto.randomUUID().replace(/-/g, '')}`,
          cohortId,
          tenantId,
          resource.resource,
          target.target_id,
          target.block_reason ?? null,
          now,
        ]
      );
    }

    const counts = await getCohortCounts(authCtx.coreAdapter, cohortId, tenantId);
    if (!hasActionableMinimum(counts.actionable, resource.minCount)) {
      await cleanupCohort(authCtx.coreAdapter, cohortId, tenantId);
      await auditSupportOps(c, 'support_ops.cohort.create', null, 'failure', {
        resource: resource.resource,
        selector_hash: compiled.selectorHash,
        intended_action: intendedAction,
        reason: 'actionable_min_count_not_met',
        support_case_id: body.intent?.support_case_id ?? null,
      });
      return jsonError(
        c,
        400,
        'cohort_below_actionable_min_count',
        `Cohort must include at least ${resource.minCount} actionable records`
      );
    }
    await authCtx.coreAdapter.execute(
      `UPDATE support_operation_cohorts
          SET actionable_count = ?,
              blocked_count = ?,
              blocked_summary_json = ?,
              snapshot_status = 'completed',
              snapshot_error = NULL
        WHERE tenant_id = ? AND id = ?`,
      [
        counts.actionable,
        counts.blocked,
        toJson({ reasons: counts.blockedReasons }),
        tenantId,
        cohortId,
      ]
    );

    await auditSupportOps(c, 'support_ops.cohort.create', cohortId, 'success', {
      resource: resource.resource,
      intended_action: intendedAction,
      selector_hash: compiled.selectorHash,
      counts: redactCountAuditSummary(resource, matchedCount, counts.actionable, counts.blocked),
      support_case_id: body.intent?.support_case_id ?? null,
    });

    const redactedCounts = redactCohortCounts(
      resource,
      matchedCount,
      counts.actionable,
      counts.blocked,
      counts.blockedReasons
    );

    return c.json(
      {
        cohort_id: cohortId,
        resource: resource.resource,
        intended_action: intendedAction,
        ...redactedCounts,
        snapshot_status: 'completed' as SupportOpsSnapshotStatus,
        snapshot_job_id: null,
        expires_at: expiresAt,
        selector_hash: compiled.selectorHash,
        risk,
      },
      201
    );
  } catch {
    if (createdCohort) {
      await cleanupCohort(
        createdCohort.coreAdapter,
        createdCohort.cohortId,
        createdCohort.tenantId
      );
    }
    await auditSupportOps(c, 'support_ops.cohort.create', null, 'failure', {
      resource: body.resource,
      reason: 'invalid_cohort',
    });
    return jsonError(c, 400, 'invalid_cohort', 'Invalid cohort');
  }
});

supportOpsRouter.get('/cohorts/:cohortId', async (c) => {
  const forbidden = requirePermission(c, ADMIN_PERMISSIONS.SUPPORT_OPS_COHORTS_PREVIEW);
  if (forbidden) return forbidden;

  const tenantId = getTenantIdFromContext(c);
  const authCtx = createSupportOpsAuthContext(c, tenantId);
  const cohortId = c.req.param('cohortId');
  const row = await authCtx.coreAdapter.queryOne<{
    id: string;
    resource: string;
    intended_action: string | null;
    selector_hash: string;
    matched_count: number;
    actionable_count: number;
    blocked_count: number;
    blocked_summary_json: string | null;
    snapshot_status: SupportOpsSnapshotStatus;
    snapshot_job_id: string | null;
    snapshot_error: string | null;
    risk_json: string | null;
    support_case_id: string | null;
    expires_at: number;
    created_at: number;
  }>('SELECT * FROM support_operation_cohorts WHERE tenant_id = ? AND id = ?', [
    tenantId,
    cohortId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Cohort not found');
  const resource = getSupportOpsResource(row.resource);
  if (!resource) return jsonError(c, 400, 'unsupported_resource', 'Unsupported resource');
  const blockedSummary = fromJsonRecord(row.blocked_summary_json);
  const blockedReasons = Array.isArray(blockedSummary.reasons)
    ? blockedSummary.reasons.filter((reason): reason is string => typeof reason === 'string')
    : [];
  const redactedCounts = redactCohortCounts(
    resource,
    row.matched_count,
    row.actionable_count,
    row.blocked_count,
    blockedReasons
  );

  return c.json({
    cohort_id: row.id,
    resource: row.resource,
    intended_action: row.intended_action,
    selector_hash: row.selector_hash,
    ...redactedCounts,
    snapshot_status: row.snapshot_status,
    snapshot_job_id: row.snapshot_job_id,
    snapshot_error: row.snapshot_error,
    blocked_summary: redactedCounts.blocked_reasons_suppressed
      ? { suppressed: true }
      : blockedSummary,
    risk: fromJsonRecord(row.risk_json),
    support_case_id: row.support_case_id,
    expires_at: row.expires_at,
    created_at: row.created_at,
  });
});

supportOpsRouter.post('/actions', async (c) => {
  const forbidden = requirePermission(c, ADMIN_PERMISSIONS.SUPPORT_OPS_ACTIONS_REQUEST);
  if (forbidden) return forbidden;

  const body = await c.req.json<ActionRequest>();
  if (!body.cohort_id || !body.action || !body.reason?.trim()) {
    return jsonError(c, 400, 'invalid_request', 'cohort_id, action, and reason are required');
  }

  const tenantId = getTenantIdFromContext(c);
  const authCtx = createSupportOpsAuthContext(c, tenantId);
  const cohort = await authCtx.coreAdapter.queryOne<{
    id: string;
    resource: string;
    intended_action: string | null;
    selector_hash: string;
    matched_count: number;
    actionable_count: number;
    blocked_count: number;
    snapshot_status: SupportOpsSnapshotStatus;
    snapshot_job_id: string | null;
    expires_at: number;
  }>('SELECT * FROM support_operation_cohorts WHERE tenant_id = ? AND id = ?', [
    tenantId,
    body.cohort_id,
  ]);
  if (!cohort) return jsonError(c, 404, 'not_found', 'Cohort not found');
  if (cohort.expires_at <= Date.now()) return jsonError(c, 409, 'cohort_expired', 'Cohort expired');
  if (cohort.snapshot_status !== 'completed') {
    return jsonError(
      c,
      409,
      'cohort_snapshot_not_ready',
      'Cohort snapshot must complete before requesting an action'
    );
  }
  if (cohort.intended_action !== body.action) {
    return jsonError(
      c,
      409,
      'action_mismatch',
      'Requested action does not match the cohort intended action'
    );
  }

  const resource = getSupportOpsResource(cohort.resource);
  if (!resource) return jsonError(c, 400, 'unsupported_resource', 'Unsupported resource');
  const actionValidation = validateSupportOpsAction(resource, body.action);
  if (!actionValidation.valid) {
    return jsonError(c, 400, 'unsupported_action', actionValidation.error ?? 'Unsupported action');
  }
  if (!hasActionableMinimum(cohort.actionable_count, resource.minCount)) {
    return jsonError(
      c,
      409,
      'cohort_below_actionable_min_count',
      `Cohort must include at least ${resource.minCount} actionable records`
    );
  }

  const now = Date.now();
  const actionId = `sact_${crypto.randomUUID().replace(/-/g, '')}`;
  const actor = getAdminAuth(c)?.userId ?? 'system';
  await authCtx.coreAdapter.execute(
    `INSERT INTO support_operation_actions (
      id, tenant_id, cohort_id, resource, action, status, reason,
      support_case_id, approval_request_id, requested_by, approved_by, result_summary_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'approval_required', ?, ?, NULL, ?, NULL, ?, ?, ?)`,
    [
      actionId,
      tenantId,
      body.cohort_id,
      cohort.resource,
      body.action,
      body.reason.trim(),
      body.support_case_id ?? null,
      actor,
      toJson({}),
      now,
      now,
    ]
  );
  let approvalRequestId: string;
  try {
    approvalRequestId = await createSupportOpsApprovalRequest(c, {
      tenantId,
      actionId,
      cohortId: body.cohort_id,
      resource: cohort.resource,
      action: body.action,
      selectorHash: cohort.selector_hash,
      matchedCount: cohort.matched_count,
      actionableCount: cohort.actionable_count,
      blockedCount: cohort.blocked_count,
      reason: body.reason.trim(),
      supportCaseId: body.support_case_id ?? null,
      actor,
    });
  } catch {
    await auditSupportOps(c, 'support_ops.action.request', actionId, 'failure', {
      cohort_id: body.cohort_id,
      resource: cohort.resource,
      action: body.action,
      reason: 'approval_workflow_unavailable',
      support_case_id: body.support_case_id ?? null,
    });
    await authCtx.coreAdapter.execute(
      'DELETE FROM support_operation_actions WHERE tenant_id = ? AND id = ?',
      [tenantId, actionId]
    );
    return jsonError(
      c,
      409,
      'approval_workflow_unavailable',
      'Support operation approval workflow is unavailable'
    );
  }
  await authCtx.coreAdapter.execute(
    `UPDATE support_operation_actions
        SET approval_request_id = ?, updated_at = ?
      WHERE tenant_id = ? AND id = ?`,
    [approvalRequestId, Date.now(), tenantId, actionId]
  );

  await auditSupportOps(c, 'support_ops.action.request', actionId, 'success', {
    cohort_id: body.cohort_id,
    resource: cohort.resource,
    action: body.action,
    counts: redactCountAuditSummary(
      resource,
      cohort.matched_count,
      cohort.actionable_count,
      cohort.blocked_count
    ),
    support_case_id: body.support_case_id ?? null,
  });
  const redactedCounts = redactCohortCounts(
    resource,
    cohort.matched_count,
    cohort.actionable_count,
    cohort.blocked_count
  );

  return c.json(
    {
      action_id: actionId,
      status: 'approval_required',
      approval_request_id: approvalRequestId,
      approval_url: `/admin/approvals/${encodeURIComponent(approvalRequestId)}`,
      summary: {
        resource: cohort.resource,
        action: body.action,
        matched_count: redactedCounts.matched_count,
        actionable_count: redactedCounts.actionable_count,
        blocked_count: redactedCounts.blocked_count,
        blocked_reasons_suppressed: redactedCounts.blocked_reasons_suppressed,
        privacy: redactedCounts.privacy,
      },
    },
    201
  );
});

supportOpsRouter.post('/actions/:actionId/approve', async (c) => {
  const forbidden = requirePermission(c, ADMIN_PERMISSIONS.SUPPORT_OPS_ACTIONS_APPROVE);
  if (forbidden) return forbidden;

  const tenantId = getTenantIdFromContext(c);
  const authCtx = createSupportOpsAuthContext(c, tenantId);
  const actionId = c.req.param('actionId');
  const actor = getAdminAuth(c)?.userId ?? 'system';
  const action = await authCtx.coreAdapter.queryOne<{
    id: string;
    status: string;
    requested_by: string;
    approval_request_id: string | null;
  }>(
    `SELECT id, status, requested_by, approval_request_id
       FROM support_operation_actions
      WHERE tenant_id = ? AND id = ?`,
    [tenantId, actionId]
  );
  if (!action) return jsonError(c, 404, 'not_found', 'Action not found');
  if (action.status !== 'approval_required') {
    return jsonError(c, 409, 'not_approvable', 'Action is not pending approval');
  }
  if (action.approval_request_id) {
    return jsonError(
      c,
      409,
      'approval_workflow_required',
      'Approve this action through the linked approval request'
    );
  }
  if (action.requested_by === actor) {
    const settings = await getSupportOpsTenantSettings(c, tenantId);
    if (!settings.allowSelfApproval) {
      await auditSupportOps(c, 'support_ops.action.approve', actionId, 'failure', {
        reason: 'self_approval_not_allowed',
      });
      return jsonError(
        c,
        409,
        'self_approval_not_allowed',
        'Self approval is disabled for this tenant'
      );
    }
  }
  const now = Date.now();
  const result = await authCtx.coreAdapter.execute(
    `UPDATE support_operation_actions
        SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ?
      WHERE tenant_id = ? AND id = ? AND status = 'approval_required'`,
    [actor, now, now, tenantId, actionId]
  );
  if (result.rowsAffected === 0) {
    return jsonError(c, 409, 'not_approvable', 'Action is not pending approval');
  }

  await auditSupportOps(c, 'support_ops.action.approve', actionId, 'success');
  return c.json({ action_id: actionId, status: 'approved' });
});

supportOpsRouter.post('/actions/:actionId/execute', async (c) => {
  const forbidden = requirePermission(c, ADMIN_PERMISSIONS.SUPPORT_OPS_ACTIONS_EXECUTE);
  if (forbidden) return forbidden;

  const tenantId = getTenantIdFromContext(c);
  const authCtx = createSupportOpsAuthContext(c, tenantId);
  const actionId = c.req.param('actionId');
  const action = await authCtx.coreAdapter.queryOne<{
    id: string;
    cohort_id: string;
    resource: string;
    action: string;
    status: string;
    approval_request_id: string | null;
    requested_by: string;
    approved_by: string | null;
    intended_action: string | null;
    selector_hash: string;
    matched_count: number;
    actionable_count: number;
    blocked_count: number;
    snapshot_status: SupportOpsSnapshotStatus;
    expires_at: number;
  }>(
    `SELECT a.*, c.intended_action, c.selector_hash, c.matched_count, c.actionable_count,
            c.blocked_count, c.snapshot_status, c.expires_at
       FROM support_operation_actions a
       JOIN support_operation_cohorts c ON c.id = a.cohort_id AND c.tenant_id = a.tenant_id
      WHERE a.tenant_id = ? AND a.id = ?`,
    [tenantId, actionId]
  );
  if (!action) return jsonError(c, 404, 'not_found', 'Action not found');
  if (action.expires_at <= Date.now()) {
    await authCtx.coreAdapter.execute(
      `UPDATE support_operation_actions
          SET status = 'cancelled',
              result_summary_json = ?,
              updated_at = ?
        WHERE tenant_id = ? AND id = ? AND status IN ('approval_required', 'approved')`,
      [
        toJson({
          error: 'cohort_expired',
          matched_count: action.matched_count,
          attempted_count: action.actionable_count,
          blocked_count: action.blocked_count,
        }),
        Date.now(),
        tenantId,
        actionId,
      ]
    );
    await auditSupportOps(c, 'support_ops.action.execute', actionId, 'failure', {
      cohort_id: action.cohort_id,
      resource: action.resource,
      action: action.action,
      reason: 'cohort_expired',
    });
    return jsonError(c, 409, 'cohort_expired', 'Cohort expired');
  }
  if (action.snapshot_status !== 'completed') {
    return jsonError(
      c,
      409,
      'cohort_snapshot_not_ready',
      'Cohort snapshot must complete before execution'
    );
  }
  let approvalActors: string[] = [];
  if (action.status === 'approval_required' && action.approval_request_id) {
    const approvalState = await getSupportOpsApprovalWorkflowState(c, action.approval_request_id, {
      tenantId,
      actionId: action.id,
      cohortId: action.cohort_id,
      action: action.action,
      selectorHash: action.selector_hash,
    });
    approvalActors = approvalState.approvedBy;
    if (!approvalState.bound) {
      await auditSupportOps(c, 'support_ops.action.execute', actionId, 'failure', {
        cohort_id: action.cohort_id,
        resource: action.resource,
        action: action.action,
        reason: 'approval_scope_mismatch',
      });
      return jsonError(
        c,
        409,
        'approval_scope_mismatch',
        'Approval request does not match this support action'
      );
    }
    if (!approvalState.approved) {
      return jsonError(c, 409, 'not_executable', 'Action must be approved before execution');
    }
    const approvedBy =
      approvalActors.length > 0
        ? approvalActors.join(',')
        : `approval:${action.approval_request_id}`;
    const approvalTransition = await authCtx.coreAdapter.execute(
      `UPDATE support_operation_actions
          SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ? AND status = 'approval_required'`,
      [approvedBy, Date.now(), Date.now(), tenantId, actionId]
    );
    if (approvalTransition.rowsAffected === 0) {
      return jsonError(c, 409, 'not_executable', 'Action is no longer pending approval');
    }
  } else if (action.status !== 'approved') {
    return jsonError(c, 409, 'not_executable', 'Action must be approved before execution');
  } else if (action.approved_by) {
    approvalActors = action.approved_by.split(',').filter((actor) => actor.length > 0);
  }
  if (action.resource !== 'User' || action.action !== 'suspend') {
    return jsonError(c, 400, 'unsupported_action', 'Only User suspend is implemented');
  }
  if (action.intended_action !== action.action) {
    return jsonError(c, 409, 'action_mismatch', 'Action does not match the cohort intended action');
  }
  const resource = getSupportOpsResource(action.resource);
  if (!resource) return jsonError(c, 400, 'unsupported_resource', 'Unsupported resource');
  const settings = await getSupportOpsTenantSettings(c, tenantId);
  const executor = getAdminAuth(c)?.userId ?? 'system';
  if (
    settings.dutySeparation === 'requester_approver_executor' &&
    (executor === action.requested_by || approvalActors.includes(executor))
  ) {
    return jsonError(
      c,
      409,
      'duty_separation_required',
      'Executor must be different from requester and approver for this tenant'
    );
  }
  if (!hasActionableMinimum(action.actionable_count, resource.minCount)) {
    return jsonError(
      c,
      409,
      'cohort_below_actionable_min_count',
      `Cohort must include at least ${resource.minCount} actionable records`
    );
  }

  const now = Date.now();
  const transition = await authCtx.coreAdapter.execute(
    `UPDATE support_operation_actions
        SET status = 'running', updated_at = ?
      WHERE tenant_id = ? AND id = ? AND status = 'approved'`,
    [now, tenantId, actionId]
  );
  if (transition.rowsAffected === 0) {
    return jsonError(c, 409, 'not_executable', 'Action is no longer approved for execution');
  }

  try {
    const updateResult = await authCtx.coreAdapter.execute(
      `UPDATE users_core
          SET status = 'suspended', suspended_at = ?, suspended_until = NULL, updated_at = ?
        WHERE tenant_id = ?
          AND id IN (
            SELECT target_id
              FROM support_operation_cohort_targets
             WHERE tenant_id = ? AND cohort_id = ? AND block_reason IS NULL
          )
          AND status = 'active'
          AND lifecycle_state != 'deprovisioned'`,
      [Math.floor(now / 1000), now, tenantId, tenantId, action.cohort_id]
    );
    const succeededCount = updateResult.rowsAffected ?? 0;
    const failedCount = Math.max(0, action.actionable_count - succeededCount);
    const resultSummary = {
      matched_count: action.matched_count,
      attempted_count: action.actionable_count,
      succeeded_count: succeededCount,
      failed_count: failedCount,
      blocked_count: action.blocked_count,
    };
    await authCtx.coreAdapter.execute(
      `UPDATE support_operation_actions
          SET status = 'completed', result_summary_json = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ? AND status = 'running'`,
      [toJson(resultSummary), Date.now(), tenantId, actionId]
    );

    await auditSupportOps(c, 'support_ops.action.execute', actionId, 'success', {
      cohort_id: action.cohort_id,
      resource: action.resource,
      action: action.action,
      result: redactResultSummary(
        resource,
        resultSummary,
        action.matched_count,
        action.actionable_count,
        action.blocked_count
      ),
    });
    const redactedResultSummary = redactResultSummary(
      resource,
      resultSummary,
      action.matched_count,
      action.actionable_count,
      action.blocked_count
    );

    return c.json({
      action_id: actionId,
      status: 'completed',
      resource: action.resource,
      action: action.action,
      cohort_id: action.cohort_id,
      ...redactedResultSummary,
    });
  } catch {
    const failureSummary = {
      matched_count: action.matched_count,
      attempted_count: action.actionable_count,
      succeeded_count: 0,
      failed_count: action.actionable_count,
      blocked_count: action.blocked_count,
      error: 'execution_failed',
    };
    await authCtx.coreAdapter.execute(
      `UPDATE support_operation_actions
          SET status = 'failed', result_summary_json = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ? AND status = 'running'`,
      [toJson(failureSummary), Date.now(), tenantId, actionId]
    );
    await auditSupportOps(c, 'support_ops.action.execute', actionId, 'failure', {
      cohort_id: action.cohort_id,
      resource: action.resource,
      action: action.action,
      reason: 'execution_failed',
    });
    return jsonError(c, 409, 'execution_failed', 'Action execution failed');
  }
});

supportOpsRouter.get('/actions/:actionId', async (c) => {
  const forbidden = requirePermission(c, ADMIN_PERMISSIONS.SUPPORT_OPS_ACTIONS_READ);
  if (forbidden) return forbidden;

  const tenantId = getTenantIdFromContext(c);
  const authCtx = createSupportOpsAuthContext(c, tenantId);
  const actionId = c.req.param('actionId');
  const action = await authCtx.coreAdapter.queryOne<{
    id: string;
    cohort_id: string;
    resource: string;
    action: string;
    status: string;
    reason: string;
    support_case_id: string | null;
    approval_request_id: string | null;
    requested_by: string;
    approved_by: string | null;
    result_summary_json: string | null;
    matched_count: number;
    actionable_count: number;
    blocked_count: number;
    created_at: number;
    updated_at: number;
  }>(
    `SELECT a.*, c.matched_count, c.actionable_count, c.blocked_count
       FROM support_operation_actions a
       JOIN support_operation_cohorts c ON c.id = a.cohort_id AND c.tenant_id = a.tenant_id
      WHERE a.tenant_id = ? AND a.id = ?`,
    [tenantId, actionId]
  );
  if (!action) return jsonError(c, 404, 'not_found', 'Action not found');
  const resource = getSupportOpsResource(action.resource);
  const resultSummary = fromJsonRecord(action.result_summary_json);
  return c.json({
    action_id: action.id,
    cohort_id: action.cohort_id,
    resource: action.resource,
    action: action.action,
    status: action.status,
    reason: action.reason,
    support_case_id: action.support_case_id,
    approval_request_id: action.approval_request_id,
    requested_by: action.requested_by,
    approved_by: action.approved_by,
    result_summary: resource
      ? redactResultSummary(
          resource,
          resultSummary,
          action.matched_count,
          action.actionable_count,
          action.blocked_count
        )
      : resultSummary,
    created_at: action.created_at,
    updated_at: action.updated_at,
  });
});
