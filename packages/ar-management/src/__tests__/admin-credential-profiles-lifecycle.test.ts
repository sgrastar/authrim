import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  adminDb: {} as DatabaseAdapter,
  audit: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: () => 'tenant-1',
    requireDedicatedAdminDatabaseAdapter: () => mocks.adminDb,
    createAuditLogFromContext: mocks.audit,
    getLogger: () => ({ module: () => ({ warn: vi.fn() }) }),
  };
});

import { ADMIN_CREDENTIAL_CONFIGURATION_ID } from '@authrim/ar-lib-core';
import {
  adminCredentialProfileCreateHandler,
  adminCredentialProfileUpdateHandler,
  adminCredentialProfileVersionCreateHandler,
} from '../admin-credential-profiles';

const profile = {
  id: 'profile-1',
  tenant_id: 'tenant-1',
  profile_key: 'EmployeeCard',
  display_name: 'Employee card',
  description: null,
  lifecycle_state: 'draft',
};

const version = {
  id: 'version-5',
  tenant_id: 'tenant-1',
  credential_profile_id: 'profile-1',
  version_number: 5,
  lifecycle_state: 'draft',
};

function context(body: Record<string, unknown>): Context<{ Bindings: Env }> {
  return {
    env: {},
    req: {
      json: async () => body,
      param: (name: string) => (name === 'id' ? 'profile-1' : ''),
    },
    get: () => ({ userId: 'admin-1' }),
    json: (value: unknown, status = 200) => Response.json(value, { status }),
  } as unknown as Context<{ Bindings: Env }>;
}

function versionBody(overrides: Record<string, unknown> = {}) {
  return {
    credential_configuration_id: 'EmployeeCredential',
    issuance_flow_id: 'issuance-flow',
    issuance_mapping_set_id: 'issuance-mapping',
    claim_allowlist: ['last_name', 'first_name', 'last_name'],
    ...overrides,
  };
}

describe('credential profile draft lifecycle', () => {
  beforeEach(() => {
    mocks.audit.mockReset().mockResolvedValue(undefined);
    mocks.adminDb = {
      queryOne: vi.fn(async (sql: string) => {
        if (sql.includes('MAX(version_number)')) return { max_version: 4 };
        if (sql.includes('credential_profile_versions')) return version;
        return profile;
      }),
      execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
    } as unknown as DatabaseAdapter;
  });

  it('creates a tenant-scoped draft with normalized display name and records the actor', async () => {
    const response = await adminCredentialProfileCreateHandler(
      context({
        tenant_id: 'tenant-other',
        profile_key: ' EmployeeCard ',
        display_name: '  Employee card  ',
        description: 'x'.repeat(2001),
      })
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ credential_profile: profile });
    const [sql, params] = vi.mocked(mocks.adminDb.execute).mock.calls[0];
    expect(sql).toContain('INSERT INTO credential_profiles');
    expect(params?.[1]).toBe('tenant-1');
    expect(params?.[2]).toBe('EmployeeCard');
    expect(params?.[3]).toBe('Employee card');
    expect(params?.[4]).toBe('x'.repeat(2000));
    expect(params?.[5]).toBe('admin-1');
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'credential_profile.created',
      'credential_profile',
      expect.any(String),
      { profile_key: 'EmployeeCard' }
    );
    expect(mocks.adminDb.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('WHERE tenant_id = ? AND id = ?'),
      ['tenant-1', expect.any(String)]
    );
  });

  it.each([
    ['invalid profile key', { profile_key: 'bad key', display_name: 'Employee card' }],
    ['empty display name', { profile_key: 'EmployeeCard', display_name: '   ' }],
  ])('rejects %s before writing or auditing', async (_label, body) => {
    const response = await adminCredentialProfileCreateHandler(context(body));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mocks.adminDb.execute).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('rejects direct publication through the draft update endpoint without side effects', async () => {
    const response = await adminCredentialProfileUpdateHandler(
      context({ lifecycle_state: 'published' })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
    expect(mocks.adminDb.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('WHERE tenant_id = ? AND id = ?'),
      ['tenant-1', 'profile-1']
    );
    expect(mocks.adminDb.execute).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('numbers a new draft version and stores a sorted, deduplicated claim allowlist', async () => {
    const response = await adminCredentialProfileVersionCreateHandler(
      context(versionBody({ transaction_code_required: true }))
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ version });
    const [sql, params] = vi.mocked(mocks.adminDb.execute).mock.calls[0];
    expect(sql).toContain('INSERT INTO credential_profile_versions');
    expect(params?.[1]).toBe('tenant-1');
    expect(params?.[2]).toBe('profile-1');
    expect(params?.[3]).toBe(5);
    expect(params?.[9]).toBe('["first_name","last_name"]');
    expect(params?.[10]).toBe(300);
    expect(params?.[11]).toBe(86400);
    expect(params?.[12]).toBe(1);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'credential_profile.version_created',
      'credential_profile',
      'profile-1',
      { version_id: params?.[0] }
    );
  });

  it('rejects the administrator-only credential configuration before creating a version', async () => {
    const response = await adminCredentialProfileVersionCreateHandler(
      context(versionBody({ credential_configuration_id: ADMIN_CREDENTIAL_CONFIGURATION_ID }))
    );

    expect(response.status).toBe(400);
    expect(mocks.adminDb.execute).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each([
    ['empty allowlist', { claim_allowlist: [] }],
    ['invalid claim name', { claim_allowlist: ['first name'] }],
    ['short offer lifetime', { offer_ttl_seconds: 59 }],
    ['long attribute age', { maximum_attribute_age_seconds: 2592001 }],
  ])('rejects %s before creating or auditing a version', async (_label, overrides) => {
    const response = await adminCredentialProfileVersionCreateHandler(
      context(versionBody(overrides))
    );

    expect(response.status).toBe(400);
    expect(mocks.adminDb.execute).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('does not create a version for a disabled profile', async () => {
    vi.mocked(mocks.adminDb.queryOne).mockResolvedValueOnce({
      ...profile,
      lifecycle_state: 'disabled',
    });

    const response = await adminCredentialProfileVersionCreateHandler(context(versionBody()));

    expect(response.status).toBe(409);
    expect(mocks.adminDb.execute).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
