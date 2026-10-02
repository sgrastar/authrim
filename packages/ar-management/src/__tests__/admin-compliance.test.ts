import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  core: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() },
  admin: { queryOne: vi.fn() },
  auditDb: { queryOne: vi.fn() },
  hotSupport: vi.fn(),
  audit: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn() },
  buildRetentionInventory: vi.fn(),
  readMfaEnforcement: vi.fn(),
  countAdminMfa: vi.fn(),
  countUserMfa: vi.fn(),
  resolveStores: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.core })),
    requireAdminDatabaseAdapter: vi.fn(() => mocks.admin),
    createAuditLogFromContext: mocks.audit,
    createErrorResponse: vi.fn((c, code, options) =>
      c.json({ error: code, ...options }, code === actual.AR_ERROR_CODES.INTERNAL_ERROR ? 500 : 400)
    ),
    getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
    resolveTenantAssignedDatabaseSourcesFromRegistry: mocks.resolveStores,
    resolveTenantRuntimeProfilesFromEnv: vi.fn(async () => ({ auditProfile: { id: 'p' } })),
    ensureDatabaseAdapter: vi.fn(() => mocks.core),
  };
});

vi.mock('../compliance/retention-inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../compliance/retention-inventory')>();
  return { ...actual, buildRetentionInventory: mocks.buildRetentionInventory };
});

vi.mock('../compliance/mfa-coverage', () => ({
  readMfaEnforcement: mocks.readMfaEnforcement,
  countAdminMfa: mocks.countAdminMfa,
  countUserMfa: mocks.countUserMfa,
}));

vi.mock('../audit-hot-query', () => ({
  getAuditHotQuerySupportForProfile: mocks.hotSupport,
  getAuditHotQuerySqlSpec: vi.fn(() => ({ tableName: 'audit_events' })),
  getAuditTimeRange: vi.fn((from: number, to: number) => [from, to]),
}));

import { adminComplianceStatusHandler } from '../admin-compliance';

function context(
  options: {
    query?: Record<string, string | undefined>;
    body?: unknown;
    bodyError?: boolean;
    adminId?: string;
  } = {}
) {
  return {
    get: vi.fn((name: string) =>
      name === 'adminAuth' && options.adminId ? { adminId: options.adminId } : null
    ),
    req: {
      query: vi.fn((name: string) => options.query?.[name]),
      json: options.bodyError
        ? vi.fn().mockRejectedValue(new SyntaxError('bad json'))
        : vi.fn().mockResolvedValue(options.body ?? {}),
    },
    env: { SETTINGS: {} },
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

describe('admin compliance APIs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.core.query.mockReset();
    mocks.core.queryOne.mockReset();
    mocks.core.execute.mockReset();
    mocks.admin.queryOne.mockReset();
    mocks.auditDb.queryOne.mockReset();
    mocks.hotSupport.mockReset();
    mocks.core.query.mockResolvedValue([]);
    mocks.core.queryOne.mockResolvedValue(null);
    mocks.core.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.admin.queryOne.mockResolvedValue(null);
    mocks.auditDb.queryOne.mockResolvedValue(null);
    mocks.hotSupport.mockReturnValue({ supported: false, status: 'not_supported' });
    mocks.audit.mockResolvedValue(undefined);
    mocks.resolveStores.mockResolvedValue([{ source: {}, bindingRef: 'DB_PII' }]);
    mocks.buildRetentionInventory.mockResolvedValue([
      {
        id: 'audit_events',
        retention: { value: 180, unit: 'days' },
        source: { kind: 'audit', from: 'audit_profile' },
        edit: { kind: 'audit_profile' },
        deletion: { kind: 'expiry' },
        varies: null,
        counts: { total: 10, expired: 2 },
      },
      {
        id: 'audit_pii',
        retention: { value: 365, unit: 'days' },
        source: { kind: 'audit', from: 'pii_config' },
        edit: { kind: 'audit_pii_config' },
        deletion: { kind: 'expiry' },
        varies: null,
        counts: null,
      },
    ]);
    mocks.readMfaEnforcement.mockResolvedValue({
      enforced: false,
      assurance_enabled: false,
      default_aal: 'AAL1',
      scopes_requiring_mfa: [],
    });
    mocks.countAdminMfa.mockResolvedValue({ admins: 2, with_passkey: 2 });
    mocks.countUserMfa.mockResolvedValue({
      users: 10,
      with_passkey: 6,
      with_totp: 3,
      with_any: 9,
      guests: 1,
      deleting: 3,
    });
  });

  it('reports each check from what the tenant enforces, and the facts behind it', async () => {
    // Roles in the default store; users with one in each of two stores.
    mocks.resolveStores.mockResolvedValue([
      { source: {}, bindingRef: 'DB' },
      { source: {}, bindingRef: 'DB_USERS_1' },
    ]);
    mocks.core.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('FROM roles WHERE') ? { active_roles: 2 } : null
    );
    // Four users with a role in each store, one of them in both.
    const storeUsers = [
      ['user-1', 'user-2', 'user-3', 'user-4'],
      ['user-4', 'user-5', 'user-6', 'user-7'],
    ];
    let storeIndex = 0;
    mocks.core.query.mockImplementation(async (sql: string) =>
      sql.includes('ra.subject_id') ? storeUsers[storeIndex++]!.map((user_id) => ({ user_id })) : []
    );
    const response = await adminComplianceStatusHandler(context());
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;

    expect(body.overall_status).toBe('warning');
    expect(
      Object.fromEntries(
        (body.checks as Array<{ id: string; status: string }>).map((check) => [
          check.id,
          check.status,
        ])
      )
    ).toEqual({
      data_retention_enforced: 'compliant',
      audit_logging: 'compliant',
      admin_mfa: 'compliant',
      user_mfa_enforced: 'warning',
      user_mfa_coverage: 'compliant',
      rbac_configured: 'compliant',
    });
    expect(body.audit_log).toEqual({
      enabled: true,
      event_retention_days: 180,
      pii_retention_days: 365,
      total_entries: null,
      entries_last_30_days: null,
      hot_query_status: 'not_supported',
    });
    expect(body.data_retention).toEqual({ expired_records: 2, attention: [] });
    expect(body.mfa.users.with_any).toBe(9);
    expect(body.accounts).toEqual({ pending_deletions: 3 });
    expect(body).not.toHaveProperty('encryption');
    expect(mocks.countAdminMfa).toHaveBeenCalledWith(mocks.admin, 'tenant-a');
    // The profile read once is the one the retention and the counts use.
    expect(mocks.buildRetentionInventory).toHaveBeenCalledWith(
      expect.objectContaining({ auditProfile: { id: 'p' } })
    );
    expect(mocks.hotSupport).toHaveBeenCalledWith(expect.anything(), { id: 'p' });
    expect(mocks.countUserMfa).toHaveBeenCalledWith(expect.anything(), 'tenant-a', {
      routed: false,
    });
    // Users with a role: only unexpired assignments to roles of the tenant.
    const rbacSql = String(
      mocks.core.query.mock.calls.find(([sql]) => String(sql).includes('role_assignments'))?.[0]
    );
    expect(rbacSql).toContain('JOIN roles r ON r.id = ra.role_id AND r.tenant_id = ra.tenant_id');
    expect(rbacSql).toContain('ra.expires_at IS NULL OR ra.expires_at > ?');
    expect(body.access_control).toEqual({ active_roles: 2, users_with_roles: 7 });
  });

  it('counts audit entries where the audit log can be queried', async () => {
    mocks.hotSupport.mockReturnValueOnce({
      supported: true,
      context: { adapter: mocks.auditDb, createdAtUnit: 'seconds' },
    });
    mocks.auditDb.queryOne.mockResolvedValueOnce({ total: 10, last_30_days: 0 });
    const body = (await (await adminComplianceStatusHandler(context())).json()) as Record<
      string,
      any
    >;
    expect(body.audit_log).toMatchObject({
      total_entries: 10,
      entries_last_30_days: 0,
      hot_query_status: 'supported',
    });
    expect(
      (body.checks as Array<{ id: string; status: string }>).find(
        (check) => check.id === 'audit_logging'
      )?.status
    ).toBe('warning');
  });

  it.each([
    ['retention', () => mocks.buildRetentionInventory.mockRejectedValueOnce(new Error('x'))],
    ['MFA enforcement', () => mocks.readMfaEnforcement.mockRejectedValueOnce(new Error('x'))],
    ['user counts', () => mocks.countUserMfa.mockRejectedValueOnce(new Error('x'))],
  ])('answers 503 when the %s cannot be read', async (_what, fail) => {
    fail();
    expect((await adminComplianceStatusHandler(context())).status).toBe(503);
  });
});
