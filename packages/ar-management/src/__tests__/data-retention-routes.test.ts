import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RetentionCategory } from '../compliance/retention-inventory';

const mocks = vi.hoisted(() => ({
  adapter: { queryOne: vi.fn(), execute: vi.fn(), batch: vi.fn() },
  audit: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  buildRetentionInventory: vi.fn(),
  resolveStores: vi.fn(),
}));
vi.mock('../admin-tenant-access', () => ({
  getAdminAuth: vi.fn(() => ({ userId: 'admin-a' })),
}));
vi.mock('../compliance/retention-inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../compliance/retention-inventory')>();
  return { ...actual, buildRetentionInventory: mocks.buildRetentionInventory };
});
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    createAuditLogFromContext: mocks.audit,
    getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
    resolveTenantAssignedDatabaseSourcesFromRegistry: mocks.resolveStores,
    ensureDatabaseAdapter: vi.fn(() => mocks.adapter),
    createErrorResponse: vi.fn((c, code, options) =>
      c.json({ error: code, ...options }, code === actual.AR_ERROR_CODES.INTERNAL_ERROR ? 500 : 400)
    ),
  };
});

import {
  getDataRetentionEstimate,
  getDataRetentionStatus,
  listRetentionCategories,
  retentionAttention,
  updateCategoryRetention,
} from '../routes/settings/data-retention';

function context(
  options: {
    body?: unknown;
    param?: string;
    query?: Record<string, string>;
    env?: Record<string, unknown>;
  } = {}
) {
  return {
    req: {
      param: vi.fn(() => options.param),
      query: vi.fn((name: string) => options.query?.[name]),
      json: vi.fn().mockResolvedValue(options.body ?? {}),
    },
    env: options.env ?? {},
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

function scheduled(
  overrides: Partial<Extract<RetentionCategory['deletion'], { kind: 'scheduled_task' }>> = {}
): RetentionCategory['deletion'] {
  return {
    kind: 'scheduled_task',
    task: 'audit_retention',
    enabled: true,
    disabled_reason: null,
    status: 'succeeded',
    last_started_at: 1,
    last_completed_at: 2,
    last_error_code: null,
    next_run_at: 3,
    tenant_last_run: { at: 2, outcome: 'cleaned' },
    ...overrides,
  };
}

function category(
  id: RetentionCategory['id'],
  overrides: Partial<RetentionCategory> = {}
): RetentionCategory {
  return {
    id,
    retention: { value: 90, unit: 'days' },
    source: { kind: 'default' },
    edit: { kind: 'none' },
    deletion: { kind: 'expiry' },
    varies: null,
    counts: null,
    ...overrides,
  };
}

describe('data retention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.queryOne.mockReset();
    mocks.adapter.execute.mockReset();
    mocks.adapter.batch.mockReset();
    mocks.adapter.queryOne.mockResolvedValue(null);
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.adapter.batch.mockImplementation(async (statements: unknown[]) =>
      statements.map(() => ({ success: true, rowsAffected: 1 }))
    );
    mocks.audit.mockResolvedValue(undefined);
    mocks.resolveStores.mockResolvedValue([{ source: {}, bindingRef: 'DB_PII' }]);
    mocks.buildRetentionInventory.mockResolvedValue([
      category('audit_events', {
        deletion: scheduled(),
        counts: { total: 10, expired: 2 },
      }),
      category('user_tombstones', {
        deletion: scheduled({ task: 'user_tombstone_retention' }),
        counts: { total: 3, expired: 1 },
      }),
      category('access_tokens', { deletion: { kind: 'not_stored' } }),
    ]);
  });

  it('reports every category with its counts and what needs attention', async () => {
    const response = await getDataRetentionStatus(context());
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      tenant_id: string;
      categories: unknown[];
      summary: { expired_records: number; attention: unknown[] };
    };
    expect(body.tenant_id).toBe('tenant-a');
    expect(body.categories).toHaveLength(3);
    expect(body.summary).toEqual({ expired_records: 3, attention: [] });
    expect(mocks.buildRetentionInventory).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', withCounts: true })
    );
    expect(mocks.resolveStores).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: 'tenant-a', role: 'tenant_pii' })
    );
  });

  it('answers 503, not defaults, when what decides retention cannot be read', async () => {
    mocks.buildRetentionInventory.mockRejectedValueOnce(new Error('settings_unavailable'));
    expect((await getDataRetentionStatus(context())).status).toBe(503);
    mocks.buildRetentionInventory.mockRejectedValueOnce(new Error('settings_unavailable'));
    expect((await listRetentionCategories(context())).status).toBe(503);
    mocks.buildRetentionInventory.mockRejectedValueOnce(new Error('settings_unavailable'));
    expect((await getDataRetentionEstimate(context())).status).toBe(503);
  });

  it('lists categories without counting records', async () => {
    const response = await listRetentionCategories(context());
    expect(response.status).toBe(200);
    expect(mocks.buildRetentionInventory).toHaveBeenCalledWith(
      expect.objectContaining({ withCounts: false, piiAdapters: [] })
    );
    expect(mocks.resolveStores).not.toHaveBeenCalled();
  });

  it('estimates records past retention, null where they cannot be counted', async () => {
    const body = (await (await getDataRetentionEstimate(context())).json()) as {
      estimates: Array<Record<string, unknown>>;
    };
    expect(body.estimates).toEqual([
      expect.objectContaining({
        category: 'audit_events',
        records: 10,
        records_past_retention: 2,
      }),
      expect.objectContaining({
        category: 'user_tombstones',
        records: 3,
        records_past_retention: 1,
      }),
      expect.objectContaining({
        category: 'access_tokens',
        records: null,
        records_past_retention: null,
      }),
    ]);

    const filtered = (await (
      await getDataRetentionEstimate(context({ query: { category: 'user_tombstones' } }))
    ).json()) as { estimates: Array<{ category: string }> };
    expect(filtered.estimates.map((estimate) => estimate.category)).toEqual(['user_tombstones']);

    expect(
      (await getDataRetentionEstimate(context({ query: { category: 'tombstones' } }))).status
    ).toBe(400);
  });

  it('names why a category is not being removed as its retention says', () => {
    expect(
      retentionAttention([
        category('audit_events', { deletion: scheduled({ enabled: false }) }),
        category('audit_pii', {
          deletion: scheduled({ tenant_last_run: { at: 1, outcome: 'archive_only' } }),
        }),
        category('check_api_audit', {
          deletion: scheduled({
            task: 'check_api_audit_retention',
            tenant_last_run: { at: 1, outcome: 'failed' },
          }),
        }),
        // Run for other tenants, never for this one.
        category('user_tombstones', {
          deletion: scheduled({ task: 'user_tombstone_retention', tenant_last_run: null }),
        }),
        category('diagnostic_logs', {
          deletion: scheduled({
            task: 'r2_diagnostic_log_retention',
            status: 'failed',
            tenant_last_run: { at: 1, outcome: 'failed' },
          }),
        }),
        category('lookup_directory', {
          deletion: {
            kind: 'not_deleted',
            reason: 'lookup_purge_not_available',
            projection: 'pending',
          },
        }),
        category('sessions', {
          deletion: { kind: 'expiry' },
          extension: { per_refresh_seconds: 86400, absolute_limit_seconds: null },
        }),
        category('refresh_tokens', { deletion: scheduled() }),
        // Cleaned in the primary store, but archived too: the archive is kept.
        category('audit_events', {
          deletion: scheduled({ tenant_last_run: { at: 1, outcome: 'cleaned' } }),
          archive: { deletion: 'not_deleted' },
        }),
      ])
    ).toEqual([
      { category: 'audit_events', reason: 'task_disabled' },
      { category: 'audit_pii', reason: 'deleted_outside_authrim' },
      { category: 'check_api_audit', reason: 'tenant_run_failed' },
      { category: 'user_tombstones', reason: 'never_run' },
      { category: 'diagnostic_logs', reason: 'tenant_run_failed' },
      { category: 'lookup_directory', reason: 'not_deleted' },
      { category: 'lookup_directory', reason: 'projection_pending' },
      { category: 'sessions', reason: 'no_absolute_limit' },
      { category: 'audit_events', reason: 'archive_not_deleted' },
    ]);
    // Diagnostic logs too are judged by this tenant's run, not the task's: a run that has not
    // reached the tenant yet is not enough.
    expect(
      retentionAttention([
        category('diagnostic_logs', {
          deletion: scheduled({ task: 'r2_diagnostic_log_retention', tenant_last_run: null }),
        }),
        category('diagnostic_logs', {
          deletion: scheduled({
            task: 'r2_diagnostic_log_retention',
            tenant_last_run: { at: 1, outcome: 'cleaned' },
          }),
        }),
      ])
    ).toEqual([{ category: 'diagnostic_logs', reason: 'never_run' }]);
  });

  it('sets only the lookup directory here, and says where the others are set', async () => {
    mocks.buildRetentionInventory.mockResolvedValueOnce([
      category('diagnostic_logs', {
        edit: {
          kind: 'settings',
          category: 'diagnostic-logging',
          key: 'diagnostic-logging.retention_days',
          level: 'tenant',
        },
      }),
    ]);
    const response = await updateCategoryRetention(
      context({ param: 'diagnostic_logs', body: { retention_days: 30 } })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'retention_not_set_here',
      edit: { kind: 'settings', key: 'diagnostic-logging.retention_days' },
    });

    const unknown = await updateCategoryRetention(
      context({ param: 'audit_logs', body: { retention_days: 30 } })
    );
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ edit: null });
    expect(mocks.adapter.batch).not.toHaveBeenCalled();
  });

  it('writes the lookup policy, its projection and history together, then projects it', async () => {
    const applyLookupRetentionPolicyProjection = vi.fn().mockResolvedValue(undefined);
    mocks.adapter.queryOne.mockResolvedValueOnce({ retention_days: 180 }).mockResolvedValueOnce({
      tenant_id: 'tenant-a',
      policy_generation: 2,
      retention_days: 365,
      updated_at: 1700000000,
    });

    const response = await updateCategoryRetention(
      context({
        param: 'lookup_directory',
        body: { retention_days: 365 },
        env: { CONTROL: { applyLookupRetentionPolicyProjection } },
      })
    );

    expect(response.status).toBe(200);
    const statements = mocks.adapter.batch.mock.calls[0]![0] as Array<{
      sql: string;
      params: unknown[];
    }>;
    expect(statements).toHaveLength(3);
    expect(statements[0]!.sql).toContain('INSERT INTO lookup_retention_policies');
    expect(statements[0]!.params.slice(0, 3)).toEqual(['tenant-a', 365, 'admin-a']);
    expect(statements[1]!.sql).toContain('lookup_retention_policy_projection_outbox');
    expect(statements[2]!.sql).toContain('INSERT INTO settings_history');
    expect(statements.some((statement) => statement.sql.includes('tenants'))).toBe(false);
    expect(applyLookupRetentionPolicyProjection).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', retentionDays: 365, policyGeneration: 2 })
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'data_retention.category_updated',
      'data_retention',
      'lookup_directory',
      expect.objectContaining({ retention_days: 365, previous_retention_days: 180 })
    );
  });

  it('shortens the lookup retention only with a confirmation of the current value', async () => {
    mocks.adapter.queryOne.mockResolvedValue({ retention_days: 365 });
    const unconfirmed = await updateCategoryRetention(
      context({ param: 'lookup_directory', body: { retention_days: 90 } })
    );
    expect(unconfirmed.status).toBe(409);

    const stale = await updateCategoryRetention(
      context({
        param: 'lookup_directory',
        body: {
          retention_days: 90,
          confirm_shortening: true,
          expected_current_retention_days: 180,
        },
      })
    );
    expect(stale.status).toBe(409);
    expect(mocks.adapter.batch).not.toHaveBeenCalled();

    const confirmed = await updateCategoryRetention(
      context({
        param: 'lookup_directory',
        body: {
          retention_days: 90,
          confirm_shortening: true,
          expected_current_retention_days: 365,
        },
      })
    );
    expect(confirmed.status).toBe(200);
  });

  it('keeps the lookup retention within 30 days to 10 years', async () => {
    for (const retention_days of [29, 3651, 1.5]) {
      const response = await updateCategoryRetention(
        context({ param: 'lookup_directory', body: { retention_days } })
      );
      expect(response.status).toBe(400);
    }
    expect(mocks.adapter.batch).not.toHaveBeenCalled();
  });

  it('fails the change when the policy write is incomplete', async () => {
    mocks.adapter.batch.mockResolvedValueOnce([
      { success: true, rowsAffected: 1 },
      { success: true, rowsAffected: 0 },
      { success: true, rowsAffected: 1 },
    ]);
    const response = await updateCategoryRetention(
      context({ param: 'lookup_directory', body: { retention_days: 365 } })
    );
    expect(response.status).toBe(500);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
