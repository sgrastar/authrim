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
import { adminAccessCheckHandler } from '../admin-access-check';
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
  subjectAccountDb(tenantId: string, subjectId: string): Promise<unknown>;
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
    customRules: false,
    sdJwt: false,
    policyEmbedding: false,
  });
  mocks.resolveAccount.mockResolvedValue({ coreDb: { name: 'account-db' } });
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
    await expect(config.subjectAccountDb('tenant-a', 'user-9')).resolves.toEqual({
      name: 'account-db',
    });
    expect(mocks.resolveAccount).toHaveBeenCalledWith(
      { marker: 'env' },
      { tenantId: 'tenant-a', accountId: 'user-9' }
    );
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
