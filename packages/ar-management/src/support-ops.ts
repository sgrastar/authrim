import {
  isLowCount,
  redactCohortCounts,
  redactResultSummary,
  type RedactedCohortCounts,
} from './support-ops-redaction';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type {
  AdminAuthContext,
  DatabaseAdapter,
  Env,
  SupportOpsActionName,
  SupportOpsRiskSummary,
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
  getTenantSettingsDocument,
  hasAdminPermission,
  listSupportOpsResources,
  requireDedicatedAdminDatabaseAdapter,
  validateSupportOpsAction,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog, getAdminActorAuditMetadata } from './admin-shared';
import { getApprovalPresetExpiry } from './approval-policy-presets';
import {
  assertSupportOpsStoreIdentity,
  preflightSupportOpsExecutionStores,
} from './support-ops-execution-stores';
import {
  createSupportOpsExecuteJob,
  deleteSupportOpsExecuteJob,
  processSupportOpsExecuteJobInline,
  type SupportOpsRunBudget,
} from './support-ops-execute-job';
import {
  accountsByStore,
  ACCOUNT_ID_CHUNK,
  heldByAnotherStore,
  mapAccountStores,
  mayCountAccountTwice,
  SupportOpsAmbiguousAccountError,
  supportOpsStoresFromEnv,
  supportOpsStoresFromHono,
  type SupportOpsAccountStore,
  type SupportOpsStores,
} from './support-ops-stores';

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
  /** The account database being read (its key), and the last account taken from it. */
  store_key: string;
  last_target_id: string;
  stage: 'queued' | 'processing' | 'completed' | 'failed';
}

interface SupportOpsSnapshotJobRow {
  id: string;
  tenant_id: string;
  status: 'pending' | 'processing';
  progress: string | null;
  config: string | null;
  updated_at: number;
}

interface SupportOpsLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>, error?: Error): void;
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

/** The groups an aggregate answers, and the most it reads from one account database. */
const AGGREGATE_GROUP_LIMIT = 100;
const AGGREGATE_STORE_GROUP_LIMIT = 1000;

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

function jsonError(
  c: SupportOpsContext,
  status: 400 | 404 | 409 | 503,
  error: string,
  message: string
) {
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
    store_key: '',
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
      store_key: typeof parsed.store_key === 'string' ? parsed.store_key : '',
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

/**
 * A risk summary as a response shows it: its matched count only as the counts beside it show it,
 * so a suppressed count cannot be told from it.
 */
function redactRiskSummary(
  risk: Partial<SupportOpsRiskSummary>,
  counts: { matched_count: number | null; privacy: { low_count_suppressed: boolean } }
) {
  return {
    min_count: risk.minCount,
    matched_count: counts.matched_count,
    low_count_suppressed: counts.privacy.low_count_suppressed,
    uses_sensitive_field: risk.usesSensitiveField,
    risk_level: risk.riskLevel,
    approval_required: risk.approvalRequired,
  };
}

/**
 * An action's result as a response or audit shows it. Its succeeded and failed counts are shown
 * only together and only when neither is a low count (nor the attempted count they add up to):
 * one of them is the other subtracted from the attempted count.
 */

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

/**
 * Bucket the visible preview counts after complementary low-count suppression, using the
 * aggregate's precision. Frozen cohorts retain their existing count contract.
 */
function bucketPreviewCounts(
  resource: { minCount: number },
  counts: RedactedCohortCounts
): RedactedCohortCounts & {
  privacy: RedactedCohortCounts['privacy'] & { count_exact: false; count_precision: number };
} {
  const bucket = (value: number | null) =>
    value === null ? null : bucketAggregateCount(value, resource.minCount);
  return {
    ...counts,
    matched_count: bucket(counts.matched_count),
    actionable_count: bucket(counts.actionable_count),
    blocked_count: bucket(counts.blocked_count),
    privacy: { ...counts.privacy, count_exact: false, count_precision: resource.minCount },
  };
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
  const settings = await getTenantSettingsDocument(c.env, tenantId, 'support-ops');
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
  const request = await requestRepo.getApprovalRequestByPublicId(
    approvalRequestId,
    expected.tenantId
  );
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

/** Counts that changed while they were checked (see assertCountedOnce): none is answered. */
class SupportOpsCountUnverifiedError extends Error {
  constructor() {
    super('support_ops_count_unverified');
  }
}

/**
 * Refuses (SupportOpsAmbiguousAccountError) a count summed over the account databases that may
 * count an account more than once to reach the minimum (see mayCountAccountTwice): the accounts
 * it counts are read (fewer than the minimum times the databases), each database's as many as it
 * counted (else SupportOpsCountUnverifiedError: they changed since, and what was counted is not
 * known), and none may be in two databases. Each of `subsets` is a condition (beside the
 * selector) and each database's count of it.
 */
async function assertCountedOnce(
  stores: SupportOpsStores,
  resource: { table: string; idColumn: string; activeWhereSql: string; minCount: number },
  tenantId: string,
  compiled: { whereSql: string; params: unknown[] },
  subsets: Array<{ whereSql: string; storeCounts: number[] }>
): Promise<void> {
  const checked = subsets.filter(({ storeCounts }) =>
    mayCountAccountTwice(
      storeCounts.reduce((sum, count) => sum + count, 0),
      resource.minCount,
      stores.accounts.length
    )
  );
  if (checked.length === 0) return;
  const read = await mapAccountStores(stores.accounts, ({ adapter }, index) => {
    const counted = checked.reduce((sum, { storeCounts }) => sum + (storeCounts[index] ?? 0), 0);
    return adapter.query<Record<string, unknown> & { id: string }>(
      `SELECT ${resource.idColumn} AS id,
              ${checked.map(({ whereSql }, subset) => `CASE WHEN (${whereSql}) THEN 1 ELSE 0 END AS in_${subset}`).join(', ')}
         FROM ${resource.table}
        WHERE tenant_id = ? AND ${resource.activeWhereSql} AND ${compiled.whereSql}
          AND (${checked.map(({ whereSql }) => `(${whereSql})`).join(' OR ')})
        LIMIT ?`,
      [tenantId, ...compiled.params, counted + 1]
    );
  });
  read.forEach((rows, index) => {
    checked.forEach(({ storeCounts }, subset) => {
      const found = rows.filter((row) => Number(row[`in_${subset}`]) === 1).length;
      if (found !== (storeCounts[index] ?? 0)) throw new SupportOpsCountUnverifiedError();
    });
  });
  await accountsByStore(
    stores.accounts,
    tenantId,
    read.flat().map(({ id }) => id)
  );
}

/**
 * As assertCountedOnce, for the groups of an aggregate: the accounts of each group whose count
 * may count one twice are read, each database's as many as it counted (else the counts are not
 * verified), and none may be in two databases.
 */
async function assertGroupsCountedOnce(
  stores: SupportOpsStores,
  resource: {
    table: string;
    idColumn: string;
    activeWhereSql: string;
    minCount: number;
    maxSnapshotCount: number;
  },
  tenantId: string,
  compiled: { whereSql: string; params: unknown[] },
  selectColumns: string[],
  storeGroups: Array<Map<string, number>>,
  groups: Map<string, { count: number }>
): Promise<void> {
  const checked = [...groups.entries()]
    // A group is compared with the minimum and (for complementary suppression) twice it.
    .filter(([, { count }]) =>
      mayCountAccountTwice(count, resource.minCount, stores.accounts.length, resource.minCount * 2)
    )
    .map(([key]) => key);
  if (checked.length === 0) return;
  const counted = checked.reduce((sum, key) => sum + groups.get(key)!.count, 0);
  // No more than a cohort the request snapshots is read; a larger read is not made.
  if (counted > resource.maxSnapshotCount) throw new SupportOpsCountUnverifiedError();
  const groupKey = `json_array(${selectColumns.join(', ')})`;
  const read = await mapAccountStores(stores.accounts, ({ adapter }) =>
    adapter.query<{ id: string; group_key: string }>(
      `SELECT ${resource.idColumn} AS id, ${groupKey} AS group_key
         FROM ${resource.table}
        WHERE tenant_id = ? AND ${resource.activeWhereSql} AND ${compiled.whereSql}
          AND ${groupKey} IN (SELECT value FROM json_each(?))
        LIMIT ?`,
      [tenantId, ...compiled.params, `[${checked.join(',')}]`, counted + 1]
    )
  );
  read.forEach((rows, index) => {
    const found = new Map<string, number>();
    for (const row of rows) {
      const key = JSON.stringify(JSON.parse(row.group_key) as unknown);
      found.set(key, (found.get(key) ?? 0) + 1);
    }
    for (const key of checked) {
      if ((found.get(key) ?? 0) !== (storeGroups[index]!.get(key) ?? 0)) {
        throw new SupportOpsCountUnverifiedError();
      }
    }
  });
  await accountsByStore(
    stores.accounts,
    tenantId,
    read.flat().map(({ id }) => id)
  );
}

type SupportOpsCountConflict = 'account_store_ambiguous' | 'count_unverified';

/** Why a count or cohort could not be answered across the account databases, if it is that. */
function countConflictReason(error: unknown): SupportOpsCountConflict | null {
  if (error instanceof SupportOpsAmbiguousAccountError) return 'account_store_ambiguous';
  if (error instanceof SupportOpsCountUnverifiedError) return 'count_unverified';
  return null;
}

function countConflictResponse(c: SupportOpsContext, reason: SupportOpsCountConflict) {
  return reason === 'account_store_ambiguous'
    ? ambiguousAccountResponse(c)
    : jsonError(
        c,
        409,
        'count_unverified',
        'The counts could not be verified across the account databases'
      );
}

function ambiguousAccountResponse(c: SupportOpsContext) {
  return jsonError(
    c,
    409,
    'account_store_ambiguous',
    'An account is in more than one account database'
  );
}

function buildBlockExpression(
  resource: { blockReasonSql?: Partial<Record<SupportOpsActionName, string>> },
  action?: SupportOpsActionName
): string {
  return (action && resource.blockReasonSql?.[action]) || 'NULL';
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

/** The snapshot job, kept in DB_ADMIN (`jobsAdapter`) where the scheduled run claims it. */
async function createSupportOpsSnapshotJob(
  jobsAdapter: DatabaseAdapter,
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
    store_key: '',
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

  await jobsAdapter.execute(
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

/** Where a snapshot job is kept (DB_ADMIN), and the tenant's databases it snapshots. */
interface SupportOpsSnapshotStores {
  jobs: DatabaseAdapter;
  tenant: SupportOpsStores;
}

/**
 * How much a scheduled run of the snapshot jobs reads (smaller in tests, to stop it part-way): a
 * job's rows, and the statements of all its jobs (each page reads one database and checks the
 * others for its accounts).
 */
export interface SupportOpsSnapshotRunLimits {
  pageSize?: number;
  maxRowsPerRun?: number;
  maxQueriesPerRun?: number;
}

async function updateSnapshotJobFailure(
  stores: SupportOpsSnapshotStores,
  jobId: string,
  tenantId: string,
  cohortId: string,
  message: string
): Promise<void> {
  const nowMs = Date.now();
  const nowTs = Math.floor(nowMs / 1000);
  await stores.tenant.metadata.execute(
    `UPDATE support_operation_cohorts
        SET snapshot_status = 'failed', snapshot_error = ?, snapshot_job_id = COALESCE(snapshot_job_id, ?)
      WHERE tenant_id = ? AND id = ?`,
    [message, jobId, tenantId, cohortId]
  );
  await stores.jobs.execute(
    `UPDATE admin_jobs
        SET status = 'failed', error_message = ?, completed_at = ?, updated_at = ?
      WHERE tenant_id = ? AND id = ?`,
    [message, nowTs, nowTs, tenantId, jobId]
  );
}

/**
 * The account database a job resumes in: the one its progress names, or (when that one is gone)
 * the next after it, from the start of it. Null once it is past the last.
 */
function resumeSnapshotStore(
  accounts: readonly SupportOpsAccountStore[],
  progress: SupportOpsSnapshotJobProgress
): number | null {
  // A job started before its progress named a database starts again from the first: the
  // targets it already took are taken once all the same.
  const index =
    progress.store_key === '' ? 0 : accounts.findIndex(({ key }) => key >= progress.store_key);
  if (index < 0 || index >= accounts.length) return null;
  if (accounts[index].key !== progress.store_key) progress.last_target_id = '';
  return index;
}

async function processSupportOpsSnapshotJob(
  stores: SupportOpsSnapshotStores,
  job: SupportOpsSnapshotJobRow,
  logger?: SupportOpsLogger,
  limits: SupportOpsSnapshotRunLimits = {},
  /** Statements the jobs of this scheduled run may still make; this job's are taken from it. */
  budget: { remaining: number } = { remaining: limits.maxQueriesPerRun ?? 400 }
): Promise<void> {
  const metadata = stores.tenant.metadata;
  const accounts = stores.tenant.accounts;
  const config = parseSnapshotJobConfig(job.config);
  if (!config) {
    await updateSnapshotJobFailure(
      stores,
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
      stores,
      job.id,
      job.tenant_id,
      config.cohort_id,
      'unsupported_resource'
    );
    return;
  }

  const startedTs = Math.floor(Date.now() / 1000);
  const leaseCutoffTs = startedTs - 15 * 60;
  const transition = await stores.jobs.execute(
    `UPDATE admin_jobs
        SET status = 'processing', started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE tenant_id = ? AND id = ?
        AND (status = 'pending' OR (status = 'processing' AND updated_at < ?))`,
    [startedTs, startedTs, job.tenant_id, job.id, leaseCutoffTs]
  );
  if (transition.rowsAffected === 0) return;

  try {
    await metadata.execute(
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
    const blockExpression = buildBlockExpression(resource, config.intended_action);
    const cutoffExpression = buildSnapshotCutoffExpression(resource);
    const pageSize = limits.pageSize ?? 500;
    const maxRowsPerRun = limits.maxRowsPerRun ?? 5000;
    let processedThisRun = 0;
    let storeIndex = resumeSnapshotStore(accounts, progress);
    const failAmbiguous = async () => {
      await metadata.execute(
        'DELETE FROM support_operation_cohort_targets WHERE tenant_id = ? AND cohort_id = ?',
        [job.tenant_id, config.cohort_id]
      );
      await updateSnapshotJobFailure(
        stores,
        job.id,
        job.tenant_id,
        config.cohort_id,
        'account_store_ambiguous'
      );
    };

    // Each account database in turn, in pages by account id, as many as a run's rows and
    // statements allow. A page whose progress was not recorded (the run ended before) is read
    // again, and its targets already taken are skipped.
    while (storeIndex !== null && processedThisRun < maxRowsPerRun && budget.remaining > 0) {
      const store = accounts[storeIndex];
      progress.store_key = store.key;
      const limit = Math.min(pageSize, maxRowsPerRun - processedThisRun);
      const rows = await store.adapter.query<SupportOpsTargetSnapshotRow>(
        `SELECT ${resource.idColumn} as target_id, ${blockExpression} as block_reason
           FROM ${resource.table}
          WHERE tenant_id = ? AND ${resource.activeWhereSql} AND ${compiled.whereSql}
            AND ${cutoffExpression}
            AND ${resource.idColumn} > ?
          ORDER BY ${resource.idColumn} ASC
          LIMIT ?`,
        [
          job.tenant_id,
          ...compiled.params,
          config.snapshot_cutoff,
          config.snapshot_cutoff,
          progress.last_target_id,
          limit,
        ]
      );

      budget.remaining -= 1;

      // An account of the page in another database too (in any state) is one whose copy is
      // unknown: the cohort is refused, as cohort creation and execute refuse it.
      if (rows.length > 0 && accounts.length > 1) {
        budget.remaining -= (accounts.length - 1) * Math.ceil(rows.length / ACCOUNT_ID_CHUNK);
        if (
          await heldByAnotherStore(
            accounts,
            store.key,
            job.tenant_id,
            rows.map((target) => target.target_id)
          )
        ) {
          await failAmbiguous();
          return;
        }
      }
      const inserted =
        rows.length === 0
          ? []
          : await metadata.batch(
              rows.map((target) => ({
                sql: `INSERT INTO support_operation_cohort_targets (
                        id, cohort_id, tenant_id, resource, target_id, target_hash, block_reason,
                        created_at
                      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
                      ON CONFLICT (cohort_id, target_id) DO NOTHING`,
                params: [
                  `sct_${crypto.randomUUID().replace(/-/g, '')}`,
                  config.cohort_id,
                  job.tenant_id,
                  resource.resource,
                  target.target_id,
                  target.block_reason ?? null,
                  Date.now(),
                ],
              }))
            );
      budget.remaining -= rows.length === 0 ? 0 : 1;
      rows.forEach((target, index) => {
        if ((inserted[index]?.rowsAffected ?? 0) === 0) return;
        progress.processed += 1;
        progress.succeeded += 1;
        if (target.block_reason) {
          progress.blocked += 1;
        } else {
          progress.actionable += 1;
        }
      });
      processedThisRun += rows.length;
      if (rows.length < limit) {
        // This database is done: the next one, from its start.
        storeIndex = storeIndex + 1 < accounts.length ? storeIndex + 1 : null;
        progress.last_target_id = '';
        if (storeIndex !== null) progress.store_key = accounts[storeIndex].key;
      } else {
        progress.last_target_id = rows[rows.length - 1].target_id;
      }
      if (storeIndex === null) break;

      const nowTs = Math.floor(Date.now() / 1000);
      await stores.jobs.execute(
        `UPDATE admin_jobs
            SET progress = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?`,
        [toJson(progress), nowTs, job.tenant_id, job.id]
      );
      budget.remaining -= 1;
    }

    if (storeIndex !== null) {
      const nowTs = Math.floor(Date.now() / 1000);
      await stores.jobs.execute(
        `UPDATE admin_jobs
            SET status = 'pending', progress = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND status = 'processing'`,
        [toJson(progress), nowTs, job.tenant_id, job.id]
      );
      return;
    }

    const counts = await getCohortCounts(metadata, config.cohort_id, job.tenant_id);
    if (!hasActionableMinimum(counts.actionable, resource.minCount)) {
      await metadata.execute(
        'DELETE FROM support_operation_cohort_targets WHERE tenant_id = ? AND cohort_id = ?',
        [job.tenant_id, config.cohort_id]
      );
      await updateSnapshotJobFailure(
        stores,
        job.id,
        job.tenant_id,
        config.cohort_id,
        'actionable_min_count_not_met'
      );
      return;
    }
    const nowTs = Math.floor(Date.now() / 1000);
    // The cohort's targets as recorded, also those a run took before its progress was; its count
    // is of them (as a cohort the request snapshots), not the count it was queued with, of
    // accounts some of which may have changed or gone since.
    const snapshotCount = counts.actionable + counts.blocked;
    const finalProgress: SupportOpsSnapshotJobProgress = {
      ...progress,
      total: snapshotCount,
      processed: snapshotCount,
      succeeded: snapshotCount,
      actionable: counts.actionable,
      blocked: counts.blocked,
      stage: 'completed',
    };
    await metadata.execute(
      `UPDATE support_operation_cohorts
          SET snapshot_status = 'completed',
              matched_count = ?,
              actionable_count = ?,
              blocked_count = ?,
              blocked_summary_json = ?,
              risk_json = ?,
              snapshot_error = NULL
        WHERE tenant_id = ? AND id = ?`,
      [
        snapshotCount,
        counts.actionable,
        counts.blocked,
        toJson({ reasons: counts.blockedReasons }),
        toJson(
          buildSupportOpsRiskSummary({
            resource,
            matchedCount: snapshotCount,
            action: config.intended_action,
          })
        ),
        job.tenant_id,
        config.cohort_id,
      ]
    );
    await stores.jobs.execute(
      `UPDATE admin_jobs
          SET status = 'completed', progress = ?, result = ?, completed_at = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?`,
      [
        toJson(finalProgress),
        toJson({
          cohort_id: config.cohort_id,
          matched_count: snapshotCount,
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
  } catch (error) {
    await updateSnapshotJobFailure(
      stores,
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
  logger?: SupportOpsLogger,
  limits: SupportOpsSnapshotRunLimits = {},
  /** The scheduled run's budget, shared with its other Support Ops jobs; this run's is taken from it. */
  shared?: SupportOpsRunBudget
): Promise<void> {
  // One budget for all the jobs of this run (they run in one invocation).
  const budget = {
    remaining: Math.min(limits.maxQueriesPerRun ?? 400, shared?.remaining ?? Infinity),
  };
  const started = budget.remaining;
  try {
    await processSnapshotJobs(env, logger, limits, budget);
  } finally {
    if (shared) shared.remaining -= started - budget.remaining;
  }
}

async function processSnapshotJobs(
  env: Env,
  logger: SupportOpsLogger | undefined,
  limits: SupportOpsSnapshotRunLimits,
  budget: { remaining: number }
): Promise<void> {
  if (budget.remaining <= 0) return;
  const jobsAdapter = requireDedicatedAdminDatabaseAdapter(env, 'support-ops-snapshot-jobs');
  budget.remaining -= 1;
  const jobs = await jobsAdapter.query<SupportOpsSnapshotJobRow>(
    `SELECT id, tenant_id, status, progress, config, updated_at
       FROM admin_jobs
      WHERE job_type = 'support-ops/cohort-snapshot'
        AND (status = 'pending' OR (status = 'processing' AND updated_at < ?))
      ORDER BY created_at ASC
      LIMIT 3`,
    [Math.floor(Date.now() / 1000) - 15 * 60]
  );
  for (const job of jobs) {
    let tenant: SupportOpsStores;
    try {
      tenant = await supportOpsStoresFromEnv(env, job.tenant_id);
    } catch (error) {
      // Failed, not left pending: a job whose tenant cannot be routed would take a slot of
      // every run. Only as this run found it: another run may have claimed or ended it since.
      // The cohort stays pending until it expires.
      const nowTs = Math.floor(Date.now() / 1000);
      budget.remaining -= 1;
      await jobsAdapter.execute(
        `UPDATE admin_jobs
            SET status = 'failed', error_message = ?, completed_at = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND status = ? AND updated_at = ?`,
        [
          'snapshot_tenant_database_unavailable',
          nowTs,
          nowTs,
          job.tenant_id,
          job.id,
          job.status,
          job.updated_at,
        ]
      );
      logger?.error(
        'Support Ops snapshot job tenant database unavailable',
        { job_id: job.id },
        error as Error
      );
      continue;
    }
    if (budget.remaining <= 0) break;
    await processSupportOpsSnapshotJob({ jobs: jobsAdapter, tenant }, job, logger, limits, budget);
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
    const stores = await supportOpsStoresFromHono(c, tenantId);
    const compiled = await compileSupportOpsSelector(resource, body.selector);
    const selectColumns = groupBy.map((name) => resource.fields[name].column);
    // Each group's count over all the account databases, before any is bucketed or suppressed:
    // a group under the minimum in every database may not be under it in all of them together.
    const merged = new Map<string, Record<string, unknown> & { count: number }>();
    const storeGroups: Array<Map<string, number>> = [];
    for (const storeRows of await mapAccountStores(stores.accounts, ({ adapter }) =>
      adapter.query<Record<string, unknown>>(
        `SELECT ${selectColumns.join(', ')}, COUNT(*) as count
           FROM ${resource.table}
          WHERE tenant_id = ? AND ${resource.activeWhereSql} AND ${compiled.whereSql}
          GROUP BY ${selectColumns.join(', ')}
          LIMIT ${AGGREGATE_STORE_GROUP_LIMIT + 1}`,
        [tenantId, ...compiled.params]
      )
    )) {
      // Groups a database leaves out could not be added up: none is answered.
      if (storeRows.length > AGGREGATE_STORE_GROUP_LIMIT) {
        await auditSupportOps(c, 'support_ops.aggregate', null, 'failure', {
          resource: resource.resource,
          reason: 'too_many_groups',
        });
        return jsonError(c, 400, 'too_many_groups', 'Too many groups to aggregate');
      }
      const counts = new Map<string, number>();
      storeGroups.push(counts);
      for (const row of storeRows) {
        const groupKey = JSON.stringify(selectColumns.map((column) => row[column] ?? null));
        counts.set(groupKey, Number(row.count ?? 0));
        const group = merged.get(groupKey);
        if (group) group.count += Number(row.count ?? 0);
        else merged.set(groupKey, { ...row, count: Number(row.count ?? 0) });
      }
    }
    await assertGroupsCountedOnce(
      stores,
      resource,
      tenantId,
      compiled,
      selectColumns,
      storeGroups,
      merged
    );
    const rows = [...merged.entries()]
      .sort(([leftKey, left], [rightKey, right]) =>
        right.count !== left.count ? right.count - left.count : leftKey < rightKey ? -1 : 1
      )
      .slice(0, AGGREGATE_GROUP_LIMIT)
      .map(([, row]) => row);

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
  } catch (error) {
    const conflict = countConflictReason(error);
    await auditSupportOps(c, 'support_ops.aggregate', null, 'failure', {
      resource: body.resource,
      reason: conflict ?? 'invalid_selector',
    });
    return conflict
      ? countConflictResponse(c, conflict)
      : jsonError(c, 400, 'invalid_selector', 'Invalid selector');
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
    const stores = await supportOpsStoresFromHono(c, tenantId);
    const compiled = await compileSupportOpsSelector(resource, body.selector);
    const blockExpression = buildBlockExpression(resource, body.intent?.action);
    // The counts over all the account databases: only these are compared with the minimum.
    const perStore = await mapAccountStores(stores.accounts, async ({ adapter }) => {
      const matched = await adapter.queryOne<{ count: number }>(
        `SELECT COUNT(*) as count
           FROM ${resource.table}
          WHERE tenant_id = ? AND ${resource.activeWhereSql} AND ${compiled.whereSql}`,
        [tenantId, ...compiled.params]
      );
      const actionable = await adapter.queryOne<{ count: number }>(
        `SELECT COUNT(*) as count
           FROM ${resource.table}
          WHERE tenant_id = ? AND ${resource.activeWhereSql} AND ${compiled.whereSql}
            AND (${blockExpression}) IS NULL`,
        [tenantId, ...compiled.params]
      );
      const blockedRows = await adapter.query<{ block_reason: string }>(
        `SELECT block_reason
           FROM (
             SELECT ${blockExpression} as block_reason
               FROM ${resource.table}
              WHERE tenant_id = ? AND ${resource.activeWhereSql} AND ${compiled.whereSql}
           )
          WHERE block_reason IS NOT NULL
          GROUP BY block_reason
          ORDER BY block_reason`,
        [tenantId, ...compiled.params]
      );
      const matchedCount = matched?.count ?? 0;
      return {
        matchedCount,
        actionableCount: actionable?.count ?? matchedCount,
        blockReasons: blockedRows.map((row) => row.block_reason),
      };
    });
    const matchedCount = perStore.reduce((sum, store) => sum + store.matchedCount, 0);
    const actionableCount = perStore.reduce((sum, store) => sum + store.actionableCount, 0);
    const blockedCount = matchedCount - actionableCount;
    await assertCountedOnce(stores, resource, tenantId, compiled, [
      { whereSql: '1 = 1', storeCounts: perStore.map((store) => store.matchedCount) },
      {
        whereSql: `(${blockExpression}) IS NULL`,
        storeCounts: perStore.map((store) => store.actionableCount),
      },
      {
        whereSql: `(${blockExpression}) IS NOT NULL`,
        storeCounts: perStore.map((store) => store.matchedCount - store.actionableCount),
      },
    ]);
    const redactedCounts = bucketPreviewCounts(
      resource,
      redactCohortCounts(
        resource,
        matchedCount,
        actionableCount,
        blockedCount,
        [...new Set(perStore.flatMap((store) => store.blockReasons))].sort()
      )
    );
    const risk = buildSupportOpsRiskSummary({
      resource,
      matchedCount: redactedCounts.matched_count ?? matchedCount,
      action: body.intent?.action,
    });

    await auditSupportOps(c, 'support_ops.cohort.preview', null, 'success', {
      resource: resource.resource,
      selector_hash: compiled.selectorHash,
      counts: {
        matched_count: redactedCounts.matched_count,
        actionable_count: redactedCounts.actionable_count,
        blocked_count: redactedCounts.blocked_count,
        blocked_reasons_suppressed: redactedCounts.blocked_reasons_suppressed,
        privacy: redactedCounts.privacy,
      },
      support_case_id: body.intent?.support_case_id ?? null,
    });

    return c.json({
      resource: resource.resource,
      ...redactedCounts,
      risk: redactRiskSummary(risk, redactedCounts),
      selector_hash: compiled.selectorHash,
    });
  } catch (error) {
    const conflict = countConflictReason(error);
    await auditSupportOps(c, 'support_ops.cohort.preview', null, 'failure', {
      resource: body.resource,
      reason: conflict ?? 'invalid_selector',
    });
    return conflict
      ? countConflictResponse(c, conflict)
      : jsonError(c, 400, 'invalid_selector', 'Invalid selector');
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
    const stores = await supportOpsStoresFromHono(c, tenantId);
    const compiled = await compileSupportOpsSelector(resource, body.selector);
    const now = Date.now();
    const snapshotCutoff = now;
    const cutoffExpression = buildSnapshotCutoffExpression(resource);
    const matchedCount = (
      await mapAccountStores(stores.accounts, async ({ adapter }) => {
        const matched = await adapter.queryOne<{ count: number }>(
          `SELECT COUNT(*) as count
             FROM ${resource.table}
            WHERE tenant_id = ? AND ${resource.activeWhereSql} AND ${compiled.whereSql}
              AND ${cutoffExpression}`,
          [tenantId, ...compiled.params, snapshotCutoff, snapshotCutoff]
        );
        return matched?.count ?? 0;
      })
    ).reduce((sum, count) => sum + count, 0);
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
    const blockExpression = buildBlockExpression(resource, intendedAction);
    const risk = buildSupportOpsRiskSummary({
      resource,
      matchedCount,
      action: intendedAction,
    });
    const actor = getAdminAuth(c)?.userId ?? 'system';
    const selectorJson = toJson(body.selector ?? {});

    if (matchedCount > resource.maxSnapshotCount) {
      const jobId = crypto.randomUUID();
      await stores.metadata.execute(
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
      createdCohort = { coreAdapter: stores.metadata, tenantId, cohortId };

      await createSupportOpsSnapshotJob(
        requireDedicatedAdminDatabaseAdapter(c.env, 'support-ops-snapshot-jobs'),
        {
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
        }
      );

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
          risk: redactRiskSummary(risk, {
            matched_count: matchedCount,
            privacy: { low_count_suppressed: false },
          }),
        },
        202
      );
    }

    await stores.metadata.execute(
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
    createdCohort = { coreAdapter: stores.metadata, tenantId, cohortId };

    // An account in more than one database (in any state) is refused: which copy is it?
    const targetRows = (
      await mapAccountStores(stores.accounts, ({ adapter }) =>
        adapter.query<SupportOpsTargetSnapshotRow>(
          `SELECT ${resource.idColumn} as target_id, ${blockExpression} as block_reason
             FROM ${resource.table}
            WHERE tenant_id = ? AND ${resource.activeWhereSql} AND ${compiled.whereSql}
              AND ${cutoffExpression}`,
          [tenantId, ...compiled.params, snapshotCutoff, snapshotCutoff]
        )
      )
    ).flat();
    await accountsByStore(
      stores.accounts,
      tenantId,
      targetRows.map((target) => target.target_id)
    );
    for (const target of targetRows) {
      await stores.metadata.execute(
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

    const counts = await getCohortCounts(stores.metadata, cohortId, tenantId);
    if (!hasActionableMinimum(counts.actionable, resource.minCount)) {
      await cleanupCohort(stores.metadata, cohortId, tenantId);
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
    // The cohort's count is of its targets, the accounts as it took them (each once), not of the
    // databases' counts before: those may have changed since, or counted an account twice.
    const snapshotCount = counts.actionable + counts.blocked;
    const snapshotRisk = buildSupportOpsRiskSummary({
      resource,
      matchedCount: snapshotCount,
      action: intendedAction,
    });
    await stores.metadata.execute(
      `UPDATE support_operation_cohorts
          SET matched_count = ?,
              actionable_count = ?,
              blocked_count = ?,
              blocked_summary_json = ?,
              risk_json = ?,
              snapshot_status = 'completed',
              snapshot_error = NULL
        WHERE tenant_id = ? AND id = ?`,
      [
        snapshotCount,
        counts.actionable,
        counts.blocked,
        toJson({ reasons: counts.blockedReasons }),
        toJson(snapshotRisk),
        tenantId,
        cohortId,
      ]
    );

    await auditSupportOps(c, 'support_ops.cohort.create', cohortId, 'success', {
      resource: resource.resource,
      intended_action: intendedAction,
      selector_hash: compiled.selectorHash,
      counts: redactCountAuditSummary(resource, snapshotCount, counts.actionable, counts.blocked),
      support_case_id: body.intent?.support_case_id ?? null,
    });

    const redactedCounts = redactCohortCounts(
      resource,
      snapshotCount,
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
        risk: redactRiskSummary(snapshotRisk, redactedCounts),
      },
      201
    );
  } catch (error) {
    if (createdCohort) {
      await cleanupCohort(
        createdCohort.coreAdapter,
        createdCohort.cohortId,
        createdCohort.tenantId
      );
    }
    const conflict = countConflictReason(error);
    await auditSupportOps(c, 'support_ops.cohort.create', null, 'failure', {
      resource: body.resource,
      reason: conflict ?? 'invalid_cohort',
    });
    return conflict
      ? countConflictResponse(c, conflict)
      : jsonError(c, 400, 'invalid_cohort', 'Invalid cohort');
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
    risk: redactRiskSummary(
      fromJsonRecord(row.risk_json) as Partial<SupportOpsRiskSummary>,
      redactedCounts
    ),
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
  let pendingApprovalActor: string | undefined;
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
    pendingApprovalActor =
      approvalActors.length > 0
        ? approvalActors.join(',')
        : `approval:${action.approval_request_id}`;
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

  let executionStores: SupportOpsStores;
  try {
    executionStores = await supportOpsStoresFromHono(c, tenantId);
    await preflightSupportOpsExecutionStores(executionStores);
  } catch {
    return jsonError(
      c,
      503,
      'execution_store_unavailable',
      'Action execution stores could not be verified'
    );
  }
  if (pendingApprovalActor !== undefined) {
    const approvalTransition = await authCtx.coreAdapter.execute(
      `UPDATE support_operation_actions
          SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = MAX(updated_at,?)
        WHERE tenant_id = ? AND id = ? AND status = 'approval_required'`,
      [pendingApprovalActor, Date.now(), Date.now(), tenantId, actionId]
    );
    if (approvalTransition.rowsAffected === 0)
      return jsonError(c, 409, 'not_executable', 'Action is no longer pending approval');
  }

  // The same durable operation is used for both bounded inline execution and scheduled work.
  // Persist intent before the Core action CAS; a restart can always find the original source version.
  const jobsAdapter = requireDedicatedAdminDatabaseAdapter(c.env, 'support-ops-execute-jobs');
  const jobId = crypto.randomUUID();
  const sourceVersionMs = Date.now();
  const adminAuth = getAdminAuth(c);
  assertSupportOpsStoreIdentity(executionStores.metadataIdentity);
  await createSupportOpsExecuteJob(jobsAdapter, {
    jobId,
    tenantId,
    actionId,
    cohortId: action.cohort_id,
    executor,
    sourceVersionMs,
    actionableCount: action.actionable_count,
    matchedCount: action.matched_count,
    blockedCount: action.blocked_count,
    actor: {
      adminUserId:
        adminAuth?.authMethod === 'machine_access_token' ? null : adminAuth?.userId || 'system',
      metadata: getAdminActorAuditMetadata(adminAuth),
    },
    metadataIdentity: executionStores.metadataIdentity,
  });
  let confirmed = false;
  try {
    await authCtx.coreAdapter.execute(
      `UPDATE support_operation_actions SET status='running', result_summary_json=?,
        updated_at=MAX(updated_at,?) WHERE tenant_id=? AND id=? AND status='approved'`,
      [toJson({ job_id: jobId }), sourceVersionMs, tenantId, actionId]
    );
    const bound = await authCtx.coreAdapter.queryOne<{
      status: string;
      result_summary_json: string | null;
    }>(
      'SELECT status,result_summary_json FROM support_operation_actions WHERE tenant_id=? AND id=?',
      [tenantId, actionId],
      { consistencyClass: 'primary_required' }
    );
    confirmed =
      bound?.status === 'running' && bound.result_summary_json === toJson({ job_id: jobId });
  } catch {
    // An uncertain write is left durable for the scheduler; it is never deleted from an error guess.
    return jsonError(
      c,
      503,
      'execution_state_unavailable',
      'Action execution state could not be confirmed'
    );
  }
  if (!confirmed) {
    await deleteSupportOpsExecuteJob(jobsAdapter, tenantId, jobId);
    return jsonError(c, 409, 'not_executable', 'Action is no longer approved for execution');
  }
  await auditSupportOps(c, 'support_ops.action.execute', actionId, 'success', {
    cohort_id: action.cohort_id,
    resource: action.resource,
    action: action.action,
    execution: 'job',
    job_id: jobId,
  });
  if (action.actionable_count <= resource.maxSyncExecuteCount) {
    await processSupportOpsExecuteJobInline(c.env, tenantId, jobId, {
      maxCallsPerRun: 400,
      maxTargetsPerRun: resource.maxSyncExecuteCount,
    });
    const completed = await authCtx.coreAdapter.queryOne<{
      status: string;
      result_summary_json: string | null;
    }>(
      'SELECT status,result_summary_json FROM support_operation_actions WHERE tenant_id=? AND id=?',
      [tenantId, actionId],
      { consistencyClass: 'primary_required' }
    );
    const durable = await jobsAdapter.queryOne<{ status: string }>(
      'SELECT status FROM admin_jobs WHERE tenant_id=? AND id=?',
      [tenantId, jobId],
      { consistencyClass: 'primary_required' }
    );
    // Completion includes final durable audit and logout-job transfer, not remote logout delivery.
    if (completed?.status === 'completed' && durable?.status === 'completed') {
      const summary = JSON.parse(completed.result_summary_json ?? '{}') as Record<string, unknown>;
      return c.json({
        action_id: actionId,
        status: 'completed',
        resource: action.resource,
        action: action.action,
        cohort_id: action.cohort_id,
        ...redactResultSummary(
          resource,
          summary,
          action.matched_count,
          action.actionable_count,
          action.blocked_count
        ),
      });
    }
    if (completed?.status === 'failed' && durable?.status === 'failed')
      return jsonError(c, 409, 'execution_failed', 'Action execution failed');
  }
  return c.json(
    {
      action_id: actionId,
      status: 'running',
      resource: action.resource,
      action: action.action,
      cohort_id: action.cohort_id,
      job_id: jobId,
    },
    202
  );
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
