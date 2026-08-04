import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';

const { mockAdapter, mockAdminAdapter, mockGetTenantSettings, mockListTenantStores } = vi.hoisted(
  () => ({
    mockAdapter: {
      query: vi.fn(),
      queryOne: vi.fn(),
      execute: vi.fn(),
    } satisfies Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>,
    mockAdminAdapter: {
      query: vi.fn(),
      queryOne: vi.fn(),
      execute: vi.fn(),
    } satisfies Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>,
    mockGetTenantSettings: vi.fn(),
    mockListTenantStores: vi.fn(async () => [
      { tenantId: 'tenant-a', store: { source: {}, bindingRef: 'TDB_TENANT_A' } },
    ]),
  })
);

const { mockWriteAdminAuditLog } = vi.hoisted(() => ({
  mockWriteAdminAuditLog: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    ADMIN_PERMISSIONS: {
      ...actual.ADMIN_PERMISSIONS,
      SUPPORT_OPS_REGISTRY_READ: 'admin:support_ops:registry:read',
      SUPPORT_OPS_AGGREGATE_READ: 'admin:support_ops:aggregate:read',
      SUPPORT_OPS_COHORTS_PREVIEW: 'admin:support_ops:cohorts:preview',
      SUPPORT_OPS_COHORTS_CREATE: 'admin:support_ops:cohorts:create',
      SUPPORT_OPS_ACTIONS_REQUEST: 'admin:support_ops:actions:request',
      SUPPORT_OPS_ACTIONS_APPROVE: 'admin:support_ops:actions:approve',
      SUPPORT_OPS_ACTIONS_EXECUTE: 'admin:support_ops:actions:execute',
      SUPPORT_OPS_ACTIONS_READ: 'admin:support_ops:actions:read',
    },
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mockAdapter })),
    getSupportOpsResource: vi.fn((resource: string) =>
      resource === 'User'
        ? {
            resource: 'User',
            displayName: 'Users',
            minCount: 10,
            maxSnapshotCount: 10000,
            table: 'users_core',
            idColumn: 'id',
            fields: {
              status: {
                column: 'status',
                type: 'enum',
                filterable: true,
                aggregatable: true,
                sensitive: false,
                operators: ['eq', 'ne', 'in', 'exists', 'not_exists'],
                values: ['active', 'suspended', 'locked'],
              },
              created_at: {
                column: 'created_at',
                type: 'datetime',
                filterable: true,
                aggregatable: true,
                sensitive: false,
                operators: ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'exists', 'not_exists'],
              },
              updated_at: {
                column: 'updated_at',
                type: 'datetime',
                filterable: true,
                aggregatable: true,
                sensitive: false,
                operators: ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'exists', 'not_exists'],
              },
            },
            actions: {
              suspend: { destructive: false, approvalRequired: true, implemented: true },
            },
          }
        : null
    ),
    listSupportOpsResources: vi.fn(() => [
      {
        resource: 'User',
        displayName: 'Users',
        minCount: 10,
        maxSnapshotCount: 10000,
        fields: {
          status: {
            type: 'enum',
            filterable: true,
            aggregatable: true,
            sensitive: false,
            operators: ['eq', 'ne', 'in', 'exists', 'not_exists'],
            values: ['active', 'suspended', 'locked'],
          },
          created_at: {
            type: 'datetime',
            filterable: true,
            aggregatable: true,
            sensitive: false,
            operators: ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'exists', 'not_exists'],
          },
          updated_at: {
            type: 'datetime',
            filterable: true,
            aggregatable: true,
            sensitive: false,
            operators: ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'exists', 'not_exists'],
          },
        },
        actions: {
          suspend: { destructive: false, approvalRequired: true, implemented: true },
        },
      },
    ]),
    validateSupportOpsAction: vi.fn((_resource: unknown, action: string) =>
      action === 'suspend' ? { valid: true } : { valid: false, error: 'Unsupported action' }
    ),
    compileSupportOpsSelector: vi.fn(async () => ({
      whereSql: 'status = ?',
      params: ['active'],
      selectorHash: 'sha256:test',
    })),
    buildSupportOpsRiskSummary: vi.fn(
      ({
        resource,
        matchedCount,
        action,
      }: {
        resource: { minCount: number };
        matchedCount: number;
        action?: string;
      }) => ({
        minCount: resource.minCount,
        matchedCount,
        lowCountSuppressed: matchedCount > 0 && matchedCount < resource.minCount,
        usesSensitiveField: false,
        riskLevel: matchedCount >= 1000 ? 'medium' : 'low',
        approvalRequired: action === 'suspend',
      })
    ),
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    getTenantSettings: mockGetTenantSettings,
    ensureDatabaseAdapter: vi.fn(() => mockAdapter),
    listEnvironmentTenantDefaultStores: mockListTenantStores,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mockAdminAdapter),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => mockAdapter),
  };
});

vi.mock('../admin-shared', () => ({
  writeAdminAuditLog: mockWriteAdminAuditLog,
}));

import { ADMIN_PERMISSIONS, compileSupportOpsSelector } from '@authrim/ar-lib-core';
import {
  processPendingSupportOpsSnapshotJobs as processPendingSupportOpsSnapshotJobsImpl,
  supportOpsRouter,
} from '../support-ops';

function processPendingSupportOpsSnapshotJobs(env: Env) {
  return processPendingSupportOpsSnapshotJobsImpl({
    ...env,
    AUTHRIM_CONFIG: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    } as unknown as KVNamespace,
  });
}

function approvalRequestEntity(overrides: Record<string, unknown> = {}) {
  const scope = {
    version: 1,
    surface: 'support_ops',
    action: 'support_action.suspend',
    tenant_id: 'tenant-a',
    resource_class: 'support_operation_cohort',
    resource_ids: ['cohort-1'],
    detail_classes: ['summary'],
    redaction_level: 'summary_only',
    attributes: {
      support_action_id: 'action-1',
      cohort_id: 'cohort-1',
      resource: 'User',
      action: 'suspend',
      selector_hash: 'sha256:test',
    },
  };
  return {
    id: 'approval-row-1',
    public_request_id: 'apr_approval_1',
    tenant_id: 'tenant-a',
    investigation_id: 'case-1',
    requester_subject_type: 'admin_user',
    requester_subject_id: 'admin-2',
    target_subject_type: 'tenant_resource',
    target_subject_id: 'cohort-1',
    request_surface: 'support_ops',
    requested_action: 'support_action.suspend',
    redaction_level: 'summary_only',
    status: 'approved',
    scope_canonical: '{}',
    scope_json: JSON.stringify(scope),
    reason_code: 'support_ops_action_request',
    reason_note: 'case cleanup',
    reference_system: null,
    reference_value: null,
    reference_url: null,
    ticket_reference_system: null,
    ticket_reference_value: null,
    ticket_reference_url: null,
    reuse_scope: 'request',
    policy_preset: 'support_case_default',
    partial_access_allowed: 0,
    requested_at: Date.now(),
    expires_at: Date.now() + 60_000,
    decided_at: Date.now(),
    detail_object_catalog_id: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

function approvalEntity(overrides: Record<string, unknown> = {}) {
  return {
    id: 'approval-step-1',
    approval_request_id: 'approval-row-1',
    step_key: 'support-ops-approval',
    side: 'admin_operator',
    subject_type: 'admin_user',
    subject_id: 'admin-2',
    relation_type: null,
    relation_source: 'support_ops_policy',
    status: 'approved',
    method: null,
    transport_channel: null,
    reason_code: null,
    reason_note: null,
    last_notification_action: null,
    last_notified_at: null,
    notification_count: 0,
    requested_at: Date.now(),
    decided_at: Date.now(),
    expires_at: Date.now() + 60_000,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

function createApp(permissions: string[] = ['admin:support_ops:*']) {
  const app = new Hono<{ Bindings: Env; Variables: { adminAuth?: unknown } }>();
  app.use('/api/admin/support-ops/*', async (c, next) => {
    c.set('adminAuth', {
      userId: 'admin-1',
      email: 'admin@example.com',
      sessionId: 'session-1',
      permissions,
    });
    await next();
  });
  app.route('/api/admin/support-ops', supportOpsRouter);
  return app;
}

describe('support operations admin router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.query.mockResolvedValue([]);
    mockAdapter.queryOne.mockResolvedValue({ count: 0 });
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 0 });
    mockAdminAdapter.query.mockResolvedValue([]);
    mockAdminAdapter.queryOne.mockResolvedValue(null);
    mockAdminAdapter.execute.mockResolvedValue({ rowsAffected: 1 });
    mockGetTenantSettings.mockResolvedValue(null);
  });

  it('requires support operation permissions for registry access', async () => {
    const response = await createApp([ADMIN_PERMISSIONS.USERS_READ]).request(
      '/api/admin/support-ops/registry',
      {},
      {} as Env
    );

    expect(response.status).toBe(403);
  });

  it('suppresses exact preview counts below the resource minimum', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({ count: 4 }).mockResolvedValueOnce({ count: 4 });

    const response = await createApp().request(
      '/api/admin/support-ops/cohorts/preview',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resource: 'User',
          selector: { field: 'status', op: 'eq', value: 'active' },
          intent: { action: 'suspend' },
        }),
      },
      {} as Env
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.matched_count).toBeNull();
    expect(payload.actionable_count).toBeNull();
    expect(payload.blocked_count).toBe(0);
    expect(payload.risk).toMatchObject({
      matched_count: null,
      low_count_suppressed: true,
      min_count: 10,
    });
  });

  it('allows selector-only cohort previews before an action is chosen', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({ count: 12 }).mockResolvedValueOnce({ count: 12 });

    const response = await createApp().request(
      '/api/admin/support-ops/cohorts/preview',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resource: 'User',
          selector: { field: 'status', op: 'eq', value: 'active' },
        }),
      },
      {} as Env
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.matched_count).toBe(12);
    expect(payload.actionable_count).toBe(12);
    expect(payload.blocked_count).toBe(0);
  });

  it('returns bucketed aggregate counts with complementary suppression', async () => {
    mockAdapter.query.mockResolvedValueOnce([
      { status: 'active', count: 35 },
      { status: 'locked', count: 12 },
      { status: 'suspended', count: 4 },
    ]);

    const response = await createApp().request(
      '/api/admin/support-ops/aggregate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resource: 'User',
          selector: { field: 'status', op: 'eq', value: 'active' },
          group_by: ['status'],
        }),
      },
      {} as Env
    );
    const payload = (await response.json()) as {
      groups: Array<{ key: Record<string, unknown>; count: number }>;
      suppressed_groups: number;
      privacy: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(payload.groups).toEqual([{ key: { status: 'active' }, count: 30 }]);
    expect(payload.suppressed_groups).toBe(2);
    expect(payload.privacy).toMatchObject({
      count_exact: false,
      count_precision: 10,
      complementary_suppression: true,
    });
  });

  it('suppresses exact actionable preview counts below the resource minimum', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({ count: 12 }).mockResolvedValueOnce({ count: 5 });

    const response = await createApp().request(
      '/api/admin/support-ops/cohorts/preview',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resource: 'User',
          selector: { field: 'status', op: 'eq', value: 'active' },
          intent: { action: 'suspend' },
        }),
      },
      {} as Env
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.matched_count).toBeNull();
    expect(payload.actionable_count).toBeNull();
    expect(payload.blocked_count).toBeNull();
  });

  it('rejects low-count cohort creation before snapshotting targets', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({ count: 7 });

    const response = await createApp().request(
      '/api/admin/support-ops/cohorts',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resource: 'User',
          selector: { field: 'status', op: 'eq', value: 'active' },
          intent: { action: 'suspend' },
        }),
      },
      {} as Env
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(payload.error).toBe('cohort_below_min_count');
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('queues a paged snapshot job for cohort creation above the synchronous snapshot limit', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({ count: 10001 });
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 1 });

    const response = await createApp().request(
      '/api/admin/support-ops/cohorts',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resource: 'User',
          selector: { field: 'status', op: 'eq', value: 'active' },
          intent: { action: 'suspend' },
        }),
      },
      {} as Env
    );
    const payload = (await response.json()) as Record<string, unknown>;
    const executedSql = mockAdapter.execute.mock.calls.map((call) => String(call[0]));

    expect(response.status).toBe(202);
    expect(payload.snapshot_status).toBe('pending');
    expect(payload.snapshot_job_id).toEqual(expect.any(String));
    expect(executedSql.some((sql) => sql.includes('INSERT INTO support_operation_cohorts'))).toBe(
      true
    );
    expect(executedSql.some((sql) => sql.includes('INSERT INTO admin_jobs'))).toBe(true);
    const jobConfig = mockAdapter.execute.mock.calls.find((call) =>
      String(call[0]).includes('INSERT INTO admin_jobs')
    )?.[1]?.[4] as string;
    expect(JSON.parse(jobConfig)).toEqual(
      expect.objectContaining({
        snapshot_cutoff: expect.any(Number),
      })
    );
  });

  it('redacts low-count blocked subsets when creating cohorts', async () => {
    mockAdapter.queryOne
      .mockResolvedValueOnce({ count: 13 })
      .mockResolvedValueOnce({ count: 12 })
      .mockResolvedValueOnce({ count: 1 });
    mockAdapter.query
      .mockResolvedValueOnce(
        Array.from({ length: 13 }, (_, index) => ({
          target_id: `user-${index}`,
          block_reason: index === 12 ? 'not_active' : null,
        }))
      )
      .mockResolvedValueOnce([{ block_reason: 'not_active' }]);
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 1 });

    const response = await createApp().request(
      '/api/admin/support-ops/cohorts',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resource: 'User',
          selector: { field: 'status', op: 'eq', value: 'active' },
          intent: { action: 'suspend' },
        }),
      },
      {} as Env
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(payload.matched_count).toBeNull();
    expect(payload.actionable_count).toBe(12);
    expect(payload.blocked_count).toBeNull();
    expect(payload.blocked_reasons).toEqual([]);
    expect(payload.blocked_reasons_suppressed).toBe(true);
    const auditPayload = mockWriteAdminAuditLog.mock.calls.find(
      (call) => call[1]?.action === 'support_ops.cohort.create'
    )?.[1];
    expect(auditPayload?.metadata).toMatchObject({
      counts: {
        matched_count: null,
        actionable_count: 12,
        blocked_count: null,
        blocked_reasons_suppressed: true,
      },
    });
    expect(auditPayload?.metadata).not.toHaveProperty('blocked_count');
  });

  it('rejects cohorts whose frozen actionable target set is below min_count', async () => {
    mockAdapter.queryOne
      .mockResolvedValueOnce({ count: 12 })
      .mockResolvedValueOnce({ count: 5 })
      .mockResolvedValueOnce({ count: 7 });
    mockAdapter.query
      .mockResolvedValueOnce(
        Array.from({ length: 12 }, (_, index) => ({
          target_id: `user-${index}`,
          block_reason: index < 5 ? null : 'not_active',
        }))
      )
      .mockResolvedValueOnce([{ block_reason: 'not_active' }]);
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 1 });

    const response = await createApp().request(
      '/api/admin/support-ops/cohorts',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resource: 'User',
          selector: { field: 'status', op: 'eq', value: 'active' },
          intent: { action: 'suspend' },
        }),
      },
      {} as Env
    );
    const payload = (await response.json()) as Record<string, unknown>;
    const executedSql = mockAdapter.execute.mock.calls.map((call) => String(call[0]));

    expect(response.status).toBe(400);
    expect(payload.error).toBe('cohort_below_actionable_min_count');
    expect(executedSql.some((sql) => sql.includes('randomblob'))).toBe(false);
    expect(executedSql.some((sql) => sql.includes('DELETE FROM support_operation_cohorts'))).toBe(
      true
    );
  });

  it('rejects action requests that do not match cohort intended_action', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'cohort-1',
      resource: 'User',
      intended_action: 'suspend',
      matched_count: 12,
      actionable_count: 12,
      blocked_count: 0,
      snapshot_status: 'completed',
      expires_at: Date.now() + 60_000,
    });

    const response = await createApp().request(
      '/api/admin/support-ops/actions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cohort_id: 'cohort-1',
          action: 'delete',
          reason: 'case cleanup',
        }),
      },
      {} as Env
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(payload.error).toBe('action_mismatch');
  });

  it('creates a linked approval request when requesting an action', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'cohort-1',
      resource: 'User',
      intended_action: 'suspend',
      selector_hash: 'sha256:test',
      matched_count: 12,
      actionable_count: 12,
      blocked_count: 0,
      snapshot_status: 'completed',
      expires_at: Date.now() + 60_000,
    });
    mockAdapter.execute.mockResolvedValueOnce({ rowsAffected: 1 });

    const response = await createApp().request(
      '/api/admin/support-ops/actions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cohort_id: 'cohort-1',
          action: 'suspend',
          reason: 'case cleanup',
        }),
      },
      {} as Env
    );
    const payload = (await response.json()) as Record<string, unknown>;
    const coreSql = mockAdapter.execute.mock.calls.map((call) => String(call[0]));
    const adminSql = mockAdminAdapter.execute.mock.calls.map((call) => String(call[0]));

    expect(response.status).toBe(201);
    expect(payload.approval_request_id).toMatch(/^apr_/);
    expect(payload.approval_url).toContain('/admin/approvals/');
    expect(coreSql.some((sql) => sql.includes('approval_request_id'))).toBe(true);
    expect(adminSql.some((sql) => sql.includes('INSERT INTO approval_requests'))).toBe(true);
    expect(adminSql.some((sql) => sql.includes('INSERT INTO approval_request_approvals'))).toBe(
      true
    );
  });

  it('rejects action requests before async cohort snapshot completion', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'cohort-1',
      resource: 'User',
      intended_action: 'suspend',
      selector_hash: 'sha256:test',
      matched_count: 10001,
      actionable_count: 0,
      blocked_count: 0,
      snapshot_status: 'pending',
      snapshot_job_id: 'job-1',
      expires_at: Date.now() + 60_000,
    });

    const response = await createApp().request(
      '/api/admin/support-ops/actions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cohort_id: 'cohort-1',
          action: 'suspend',
          reason: 'case cleanup',
        }),
      },
      {} as Env
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(payload.error).toBe('cohort_snapshot_not_ready');
    expect(mockAdminAdapter.execute).not.toHaveBeenCalled();
  });

  it('rejects execution when the cohort has expired after approval', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'action-1',
      cohort_id: 'cohort-1',
      resource: 'User',
      action: 'suspend',
      status: 'approved',
      approval_request_id: null,
      requested_by: 'admin-2',
      approved_by: 'admin-3',
      intended_action: 'suspend',
      selector_hash: 'sha256:test',
      matched_count: 12,
      actionable_count: 12,
      blocked_count: 0,
      snapshot_status: 'completed',
      expires_at: Date.now() - 1,
    });
    mockAdapter.execute.mockResolvedValueOnce({ rowsAffected: 1 });

    const response = await createApp().request(
      '/api/admin/support-ops/actions/action-1/execute',
      { method: 'POST' },
      {} as Env
    );
    const payload = (await response.json()) as Record<string, unknown>;
    const executedSql = mockAdapter.execute.mock.calls.map((call) => String(call[0]));

    expect(response.status).toBe(409);
    expect(payload.error).toBe('cohort_expired');
    expect(executedSql.some((sql) => sql.includes("status = 'cancelled'"))).toBe(true);
    expect(executedSql.some((sql) => sql.includes('UPDATE users_core'))).toBe(false);
  });

  it('rejects linked approvals whose scope does not match the action', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'action-1',
      cohort_id: 'cohort-1',
      resource: 'User',
      action: 'suspend',
      status: 'approval_required',
      approval_request_id: 'apr_approval_1',
      requested_by: 'admin-2',
      approved_by: null,
      intended_action: 'suspend',
      selector_hash: 'sha256:test',
      matched_count: 12,
      actionable_count: 12,
      blocked_count: 0,
      snapshot_status: 'completed',
      expires_at: Date.now() + 60_000,
    });
    mockAdminAdapter.queryOne.mockResolvedValueOnce(
      approvalRequestEntity({
        target_subject_id: 'cohort-other',
        scope_json: JSON.stringify({
          version: 1,
          surface: 'support_ops',
          action: 'support_action.suspend',
          tenant_id: 'tenant-a',
          resource_class: 'support_operation_cohort',
          resource_ids: ['cohort-other'],
          attributes: {
            support_action_id: 'action-1',
            cohort_id: 'cohort-other',
            action: 'suspend',
            selector_hash: 'sha256:test',
          },
        }),
      })
    );

    const response = await createApp().request(
      '/api/admin/support-ops/actions/action-1/execute',
      { method: 'POST' },
      {} as Env
    );
    const payload = (await response.json()) as Record<string, unknown>;
    const executedSql = mockAdapter.execute.mock.calls.map((call) => String(call[0]));

    expect(response.status).toBe(409);
    expect(payload.error).toBe('approval_scope_mismatch');
    expect(mockAdminAdapter.query).not.toHaveBeenCalled();
    expect(executedSql.some((sql) => sql.includes('UPDATE users_core'))).toBe(false);
  });

  it('accepts linked approvals only when the approval scope matches the action', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'action-1',
      cohort_id: 'cohort-1',
      resource: 'User',
      action: 'suspend',
      status: 'approval_required',
      approval_request_id: 'apr_approval_1',
      requested_by: 'admin-2',
      approved_by: null,
      intended_action: 'suspend',
      selector_hash: 'sha256:test',
      matched_count: 12,
      actionable_count: 12,
      blocked_count: 0,
      snapshot_status: 'completed',
      expires_at: Date.now() + 60_000,
    });
    mockAdminAdapter.queryOne.mockResolvedValueOnce(approvalRequestEntity());
    mockAdminAdapter.query.mockResolvedValueOnce([approvalEntity()]);
    mockAdapter.execute
      .mockResolvedValueOnce({ rowsAffected: 1 })
      .mockResolvedValueOnce({ rowsAffected: 1 })
      .mockResolvedValueOnce({ rowsAffected: 12 })
      .mockResolvedValueOnce({ rowsAffected: 1 });

    const response = await createApp().request(
      '/api/admin/support-ops/actions/action-1/execute',
      { method: 'POST' },
      {} as Env
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.status).toBe('completed');
  });

  it('uses a conditional approved-to-running transition before execution', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'action-1',
      cohort_id: 'cohort-1',
      resource: 'User',
      action: 'suspend',
      status: 'approved',
      intended_action: 'suspend',
      selector_hash: 'sha256:test',
      matched_count: 12,
      actionable_count: 12,
      blocked_count: 0,
      snapshot_status: 'completed',
      expires_at: Date.now() + 60_000,
    });
    mockAdapter.execute.mockResolvedValueOnce({ rowsAffected: 0 });

    const response = await createApp().request(
      '/api/admin/support-ops/actions/action-1/execute',
      { method: 'POST' },
      {} as Env
    );
    const executedSql = mockAdapter.execute.mock.calls.map((call) => String(call[0]));

    expect(response.status).toBe(409);
    expect(executedSql[0]).toContain("status = 'approved'");
    expect(executedSql.some((sql) => sql.includes('UPDATE users_core'))).toBe(false);
  });

  it('enforces requester-approver-executor separation when tenant setting requires it', async () => {
    mockGetTenantSettings.mockResolvedValueOnce({
      'support_ops.duty_separation': 'requester_approver_executor',
    });
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'action-1',
      cohort_id: 'cohort-1',
      resource: 'User',
      action: 'suspend',
      status: 'approved',
      approval_request_id: null,
      requested_by: 'admin-2',
      approved_by: 'admin-1',
      intended_action: 'suspend',
      selector_hash: 'sha256:test',
      matched_count: 12,
      actionable_count: 12,
      blocked_count: 0,
      snapshot_status: 'completed',
      expires_at: Date.now() + 60_000,
    });

    const response = await createApp().request(
      '/api/admin/support-ops/actions/action-1/execute',
      { method: 'POST' },
      {} as Env
    );
    const payload = (await response.json()) as Record<string, unknown>;
    const executedSql = mockAdapter.execute.mock.calls.map((call) => String(call[0]));

    expect(response.status).toBe(409);
    expect(payload.error).toBe('duty_separation_required');
    expect(executedSql.some((sql) => sql.includes('UPDATE users_core'))).toBe(false);
  });

  it('marks running actions failed when execution throws', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'action-1',
      cohort_id: 'cohort-1',
      resource: 'User',
      action: 'suspend',
      status: 'approved',
      intended_action: 'suspend',
      selector_hash: 'sha256:test',
      matched_count: 12,
      actionable_count: 12,
      blocked_count: 0,
      snapshot_status: 'completed',
      expires_at: Date.now() + 60_000,
    });
    mockAdapter.execute
      .mockResolvedValueOnce({ rowsAffected: 1 })
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce({ rowsAffected: 1 });

    const response = await createApp().request(
      '/api/admin/support-ops/actions/action-1/execute',
      { method: 'POST' },
      {} as Env
    );
    const executedSql = mockAdapter.execute.mock.calls.map((call) => String(call[0]));

    expect(response.status).toBe(409);
    expect(executedSql.some((sql) => sql.includes("SET status = 'failed'"))).toBe(true);
  });

  it('rejects self approval by default', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'action-1',
      status: 'approval_required',
      requested_by: 'admin-1',
    });

    const response = await createApp().request(
      '/api/admin/support-ops/actions/action-1/approve',
      { method: 'POST' },
      {} as Env
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(payload.error).toBe('self_approval_not_allowed');
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('allows self approval only when enabled in tenant settings', async () => {
    mockGetTenantSettings.mockResolvedValueOnce({
      'support_ops.allow_self_approval': true,
    });
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'action-1',
      status: 'approval_required',
      requested_by: 'admin-1',
    });
    mockAdapter.execute.mockResolvedValueOnce({ rowsAffected: 1 });

    const response = await createApp().request(
      '/api/admin/support-ops/actions/action-1/approve',
      { method: 'POST' },
      {} as Env
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.status).toBe('approved');
  });

  it('processes pending paged cohort snapshot jobs', async () => {
    const progress = {
      total: 12,
      processed: 0,
      succeeded: 0,
      failed: 0,
      actionable: 0,
      blocked: 0,
      last_target_id: '',
      stage: 'queued',
    };
    const config = {
      cohort_id: 'cohort-1',
      resource: 'User',
      intended_action: 'suspend',
      selector_json: JSON.stringify({ field: 'status', op: 'eq', value: 'active' }),
      selector_hash: 'sha256:test',
      matched_count: 12,
      snapshot_cutoff: 1_700_000_000,
    };
    mockAdapter.query
      .mockResolvedValueOnce([
        {
          id: 'job-1',
          tenant_id: 'tenant-a',
          status: 'pending',
          progress: JSON.stringify(progress),
          config: JSON.stringify(config),
        },
      ])
      .mockResolvedValueOnce([
        { target_id: 'user-1', block_reason: null },
        { target_id: 'user-2', block_reason: null },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockAdapter.queryOne.mockResolvedValueOnce({ count: 12 }).mockResolvedValueOnce({ count: 0 });
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 1 });

    await processPendingSupportOpsSnapshotJobs({} as Env);

    const querySql = mockAdapter.query.mock.calls.map((call) => String(call[0]));
    const targetQueryParams = mockAdapter.query.mock.calls[1]?.[1] as unknown[];
    const executedSql = mockAdapter.execute.mock.calls.map((call) => String(call[0]));
    expect(querySql[0]).toContain("status = 'pending'");
    expect(querySql[0]).toContain("status = 'processing'");
    expect(querySql[0]).toContain('updated_at < ?');
    expect(querySql[1]).toContain('created_at <= ?');
    expect(querySql[1]).toContain('updated_at <= ?');
    expect(targetQueryParams).toEqual(
      expect.arrayContaining([config.snapshot_cutoff, config.snapshot_cutoff])
    );
    expect(executedSql.some((sql) => sql.includes("SET status = 'processing'"))).toBe(true);
    expect(
      executedSql.some((sql) => sql.includes('INSERT INTO support_operation_cohort_targets'))
    ).toBe(true);
    expect(
      executedSql.some(
        (sql) => sql.includes('UPDATE support_operation_cohorts') && sql.includes('completed')
      )
    ).toBe(true);
    expect(executedSql.some((sql) => sql.includes("status = 'completed'"))).toBe(true);
  });

  it('marks snapshot jobs failed when selector compilation fails after claim', async () => {
    vi.mocked(compileSupportOpsSelector).mockRejectedValueOnce(new Error('unsupported field'));
    const config = {
      cohort_id: 'cohort-1',
      resource: 'User',
      intended_action: 'suspend',
      selector_json: JSON.stringify({ field: 'removed_field', op: 'eq', value: 'active' }),
      selector_hash: 'sha256:test',
      matched_count: 12,
      snapshot_cutoff: 1_700_000_000,
    };
    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'job-1',
        tenant_id: 'tenant-a',
        status: 'pending',
        progress: null,
        config: JSON.stringify(config),
      },
    ]);
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 1 });

    await processPendingSupportOpsSnapshotJobs({} as Env);

    const executedSql = mockAdapter.execute.mock.calls.map((call) => String(call[0]));
    expect(executedSql.some((sql) => sql.includes("SET status = 'processing'"))).toBe(true);
    expect(
      executedSql.some((sql) => sql.includes("SET status = 'failed'") && sql.includes('admin_jobs'))
    ).toBe(true);
    expect(
      executedSql.some(
        (sql) => sql.includes("snapshot_status = 'failed'") && sql.includes('snapshot_error')
      )
    ).toBe(true);
  });
});
