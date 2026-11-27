import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: { query: vi.fn(), execute: vi.fn() },
  createService: vi.fn(),
  check: vi.fn(),
  readPolicyFlags: vi.fn(),
  resolveAccount: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    createUnifiedCheckService: mocks.createService,
    readPolicyFlags: mocks.readPolicyFlags,
    resolveAccountCoreDataContext: mocks.resolveAccount,
    createErrorResponse: vi.fn(
      (c: { json: (value: unknown, status: number) => Response }, code: string, options?: object) =>
        c.json(
          { error: code, ...options },
          code === actual.AR_ERROR_CODES.INTERNAL_ERROR ? 500 : 400
        )
    ),
  };
});

import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import {
  adminAccessCheckHandler,
  readSubjectGroupState,
  subjectAccountOf,
} from '../admin-access-check';
import { findAdminRouteAccessRule } from '../admin-route-access';

function context(body: unknown) {
  return {
    env: { marker: 'env' },
    req: {
      json: vi.fn(async () => {
        if (body instanceof Error) throw body;
        return body;
      }),
    },
    json: (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  } as never;
}

interface ServiceConfig {
  debugMode: boolean;
  tenantPolicy(tenantId: string): Promise<Record<string, unknown>>;
  subjectAccount(tenantId: string, subjectId: string): Promise<unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.check.mockResolvedValue({
    allowed: true,
    resolved_via: ['role'],
    final_decision: 'allow',
    cache_ttl: 0,
    debug: { matched_rules: ['role:editor'], evaluation_time_ms: 1 },
  });
  mocks.createService.mockImplementation(() => ({ check: mocks.check }));
  mocks.readPolicyFlags.mockResolvedValue({
    abac: false,
    rebac: true,
    policyLogging: false,
    verifiedAttributes: false,
    sdJwt: false,
    policyEmbedding: false,
  });
  mocks.resolveAccount.mockResolvedValue({
    coreDb: { name: 'account-db' },
    legacyUserId: 'user-9',
  });
});

describe('POST /api/admin/access-check', () => {
  it('is guarded by admin:roles:read or admin:groups:read', () => {
    expect(findAdminRouteAccessRule('POST', '/api/admin/access-check')).toMatchObject({
      anyPermissions: [ADMIN_PERMISSIONS.ROLES_READ, ADMIN_PERMISSIONS.GROUPS_READ],
    });
    expect(findAdminRouteAccessRule('GET', '/api/admin/access-check')).toBeNull();
  });

  it('runs the unified check for any subject under the server contract, with debug', async () => {
    const body = {
      subject_id: 'user-9',
      permission: 'documents:doc_1:read',
      resource_context: { owner_id: 'user-9', group_id: 'grp-1' },
      rebac: { relation: 'viewer', object: 'document:doc_1' },
    };
    const response = await adminAccessCheckHandler(context(body));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      tenant_id: 'tenant-a',
      subject_id: 'user-9',
      allowed: true,
      debug: { matched_rules: ['role:editor'] },
    });
    expect(mocks.check).toHaveBeenCalledWith(
      {
        subject_id: 'user-9',
        subject_type: 'user',
        permission: 'documents:doc_1:read',
        tenant_id: 'tenant-a',
        resource_context: body.resource_context,
        rebac: body.rebac,
      },
      { contract: 'server' }
    );
    const config = mocks.createService.mock.calls[0]?.[0] as ServiceConfig;
    expect(config.debugMode).toBe(true);
    await expect(config.subjectAccount('tenant-a', 'user-9')).resolves.toEqual({
      db: { name: 'account-db' },
      subjectId: 'user-9',
    });
    expect(mocks.resolveAccount).toHaveBeenCalledWith(
      { marker: 'env' },
      { tenantId: 'tenant-a', accountId: 'user-9' }
    );
    // Another form of the same account: its rows are read under the router's canonical id.
    await expect(config.subjectAccount('tenant-a', 'account:user-9')).resolves.toEqual({
      db: { name: 'account-db' },
      subjectId: 'user-9',
    });
  });

  it('reads the policy flags fresh, as it reads the rules', async () => {
    await adminAccessCheckHandler(context({ subject_id: 'u', permission: 'a:b' }));
    const config = mocks.createService.mock.calls[0]?.[0] as ServiceConfig;
    await config.tenantPolicy('tenant-a');
    expect(mocks.readPolicyFlags).toHaveBeenCalledWith({ marker: 'env' }, 'tenant-a', {
      fresh: true,
    });
  });

  it("follows the tenant's flags for ReBAC and ABAC; all off when unreadable", async () => {
    await adminAccessCheckHandler(context({ subject_id: 'u', permission: 'a:b' }));
    const config = mocks.createService.mock.calls[0]?.[0] as ServiceConfig;
    await expect(config.tenantPolicy('tenant-a')).resolves.toMatchObject({
      abac: false,
      rebac: true,
    });
    mocks.readPolicyFlags.mockResolvedValueOnce(null);
    await expect(config.tenantPolicy('tenant-a')).resolves.toMatchObject({
      abac: false,
      rebac: false,
    });
  });

  it("evaluates the tenant's rules with feature.enable_abac alone, with the subject's groups", async () => {
    mocks.readPolicyFlags.mockResolvedValue({
      abac: true,
      rebac: false,
      policyLogging: false,
      verifiedAttributes: false,
      sdJwt: false,
      policyEmbedding: false,
    });
    // The rules, then (they name groups) the groups service groups decide: none.
    mocks.adapter.query.mockResolvedValue([]);
    mocks.adapter.query.mockResolvedValueOnce([
      {
        id: 'allow_staff',
        name: 'Allow staff',
        description: null,
        priority: 10,
        effect: 'allow',
        resource_types: null,
        actions: null,
        conditions: JSON.stringify([{ type: 'in_group', params: { group_id: 'grp-staff' } }]),
      },
    ]);
    await adminAccessCheckHandler(context({ subject_id: 'u', permission: 'a:b' }));
    const config = mocks.createService.mock.calls[0]?.[0] as ServiceConfig;
    const policy = (await config.tenantPolicy('tenant-a')) as {
      abac: boolean;
      evaluator?: {
        usesSubjectGroups?: boolean;
        evaluate(context: Record<string, unknown>): { allowed: boolean };
      };
    };
    expect(policy.abac).toBe(true);
    expect(policy.evaluator?.usesSubjectGroups).toBe(true);
    const base = {
      subjectId: 'u',
      verifiedAttributes: [],
      resourceType: 'a',
      action: 'b',
      timestamp: Date.now(),
    };
    expect(policy.evaluator?.evaluate({ ...base, subjectGroupIds: ['grp-staff'] }).allowed).toBe(
      true
    );
    expect(policy.evaluator?.evaluate({ ...base, subjectGroupIds: [] }).allowed).toBe(false);
    expect(policy.evaluator?.evaluate(base).allowed).toBe(false);
  });

  it("resolves the subject's effective groups from its account database", async () => {
    // A database adapter whose queries answer `rows(sql)`.
    const adapterOf = (rows: (sql: string) => unknown[]) => ({
      query: vi.fn(async (sql: string) => rows(sql)),
      queryOne: vi.fn(),
      execute: vi.fn(),
      transaction: vi.fn(),
      batch: vi.fn(),
      isHealthy: vi.fn(),
      getType: vi.fn(),
      close: vi.fn(),
    });
    const metadata = adapterOf((sql) =>
      // (No service group in the tenant.)
      sql.includes('FROM "groups"') && !sql.includes("kind = 'dynamic'")
        ? [
            { id: 'grp-team', parent_group_id: 'grp-dept', lifecycle_state: 'active' },
            { id: 'grp-dept', parent_group_id: null, lifecycle_state: 'active' },
          ]
        : []
    );
    const account = adapterOf((sql) =>
      sql.includes('FROM group_memberships') ? [{ group_id: 'grp-team' }] : []
    );
    mocks.resolveAccount.mockResolvedValueOnce({ coreDb: account, legacyUserId: 'user-9' });
    const resolved = await subjectAccountOf(
      { marker: 'env' } as never,
      'tenant-a',
      ' account:user-9'
    );
    expect(resolved.subjectId).toBe('user-9');
    expect(mocks.resolveAccount).toHaveBeenCalledWith(
      { marker: 'env' },
      { tenantId: 'tenant-a', accountId: ' account:user-9' }
    );
    const state = await readSubjectGroupState(
      metadata as never,
      resolved,
      'tenant-a',
      1_700_000_000
    );
    expect([...state.groupIds].sort()).toEqual(['grp-dept', 'grp-team']);
    expect(state).toMatchObject({ unknownGroupIds: [], rolesComplete: true });
    // The memberships are read under the canonical id, at the instant given.
    expect(account.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM group_memberships'),
      expect.arrayContaining(['tenant-a', 'user-9', 1_700_000_000])
    );

    // A dynamic membership with no publication on record: that group is unknown.
    const uncertain = adapterOf((sql) =>
      sql.includes('FROM group_memberships')
        ? [{ group_id: 'grp-dyn', assignment_source: 'dynamic', source_ref: '0000000000000001:1' }]
        : []
    );
    const partial = await readSubjectGroupState(
      metadata as never,
      { db: uncertain as never, subjectId: 'user-9' },
      'tenant-a'
    );
    expect(partial.unknownGroupIds).toContain('grp-dyn');

    mocks.resolveAccount.mockRejectedValueOnce(new Error('no such account'));
    await expect(
      subjectAccountOf({ marker: 'env' } as never, 'tenant-a', 'nobody')
    ).rejects.toThrow();
  });

  it.each([
    ['no subject', { permission: 'a:b' }],
    ['no permission', { subject_id: 'u' }],
    ['a malformed permission', { subject_id: 'u', permission: 'a:b:c:d' }],
    ['a non-object resource_context', { subject_id: 'u', permission: 'a:b', resource_context: 1 }],
    ['a rebac without object', { subject_id: 'u', permission: 'a:b', rebac: { relation: 'v' } }],
    ['a non-object body', ['u']],
    ['an unreadable body', new Error('bad json')],
  ])('refuses %s with 400', async (_label, body) => {
    const response = await adminAccessCheckHandler(context(body));
    expect(response.status).toBe(400);
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it('answers 500 when the check cannot run', async () => {
    mocks.check.mockRejectedValueOnce(new Error('db down'));
    const response = await adminAccessCheckHandler(context({ subject_id: 'u', permission: 'a:b' }));
    expect(response.status).toBe(500);
  });
});
