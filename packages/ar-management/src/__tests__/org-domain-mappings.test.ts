import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCoreAdapter,
  mockGetDomainMappingById,
  mockGenerateEmailDomainHashWithVersion,
  mockGenerateVerificationToken,
  mockCalculateVerificationExpiry,
  mockVerifyDomainDnsTxt,
  mockUpdateDomainMapping,
  mockPublishEvent,
  mockGetLogger,
  mockResolveSettingsCoreAdapter,
  mockResolveSettingsTenantId,
  mockCreateDomainMapping,
} = vi.hoisted(() => {
  const logger = {
    module: vi.fn().mockReturnThis(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  };
  return {
    mockCoreAdapter: {
      queryOne: vi.fn(),
      query: vi.fn(),
      execute: vi.fn(),
    },
    mockCreateDomainMapping: vi.fn(),
    mockGetDomainMappingById: vi.fn(),
    mockGenerateEmailDomainHashWithVersion: vi.fn(),
    mockGenerateVerificationToken: vi.fn(),
    mockCalculateVerificationExpiry: vi.fn(),
    mockVerifyDomainDnsTxt: vi.fn(),
    mockUpdateDomainMapping: vi.fn(),
    mockPublishEvent: vi.fn(),
    mockGetLogger: vi.fn().mockReturnValue(logger),
    mockResolveSettingsCoreAdapter: vi.fn(),
    mockResolveSettingsTenantId: vi.fn(),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: mockGetLogger,
    getEmailDomainHashConfig: vi
      .fn()
      .mockResolvedValue({ current_version: 1, secrets: { 1: 'secret' } }),
    generateEmailDomainHashWithVersion: mockGenerateEmailDomainHashWithVersion,
    getDomainMappingById: mockGetDomainMappingById,
    generateVerificationToken: mockGenerateVerificationToken,
    calculateVerificationExpiry: mockCalculateVerificationExpiry,
    verifyDomainDnsTxt: mockVerifyDomainDnsTxt,
    updateDomainMapping: mockUpdateDomainMapping,
    createDomainMapping: mockCreateDomainMapping,
    publishEvent: mockPublishEvent,
  };
});

vi.mock('../routes/settings/tenant-resolver', () => ({
  resolveSettingsCoreAdapter: mockResolveSettingsCoreAdapter,
  resolveSettingsTenantId: mockResolveSettingsTenantId,
}));

import {
  confirmDomainVerification,
  createOrgDomainMapping,
  updateOrgDomainMapping,
  verifyDomainOwnership,
} from '../routes/settings/org-domain-mappings';

function createContext(body: Record<string, unknown>) {
  return {
    req: {
      json: vi.fn().mockResolvedValue(body),
    },
    env: {},
    json: vi.fn(
      (responseBody, status = 200) =>
        new Response(JSON.stringify(responseBody), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
    ),
  } as any;
}

describe('org domain mapping verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSettingsCoreAdapter.mockReturnValue(mockCoreAdapter);
    mockResolveSettingsTenantId.mockReturnValue('tenant-1');
    mockGenerateVerificationToken.mockResolvedValue('verification-token');
    mockCalculateVerificationExpiry.mockReturnValue(1_800_000_000);
    mockPublishEvent.mockResolvedValue(undefined);
  });

  it('rejects verification initiation when the supplied domain does not match the mapping hash', async () => {
    mockGetDomainMappingById.mockResolvedValue({
      id: 'mapping-1',
      tenant_id: 'tenant-1',
      domain_hash: 'hash-example',
      domain_hash_version: 1,
      org_id: 'org-1',
      verified: false,
    });
    mockGenerateEmailDomainHashWithVersion.mockResolvedValue({
      hash: 'hash-other',
      version: 1,
    });

    const response = await verifyDomainOwnership(
      createContext({ mapping_id: 'mapping-1', domain: 'other.example' })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request',
      error_description: 'domain does not match the requested mapping',
    });
    expect(mockCoreAdapter.execute).not.toHaveBeenCalled();
    expect(mockGenerateVerificationToken).not.toHaveBeenCalled();
  });

  it('rejects verification confirmation before DNS lookup when the domain does not match', async () => {
    mockCoreAdapter.queryOne.mockResolvedValue({
      id: 'mapping-1',
      org_id: 'org-1',
      verification_token: 'verification-token',
      verification_status: 'pending',
      verification_expires_at: 1_800_000_000,
      verification_method: 'dns_txt',
      domain_hash: 'hash-example',
      domain_hash_version: 1,
    });
    mockGenerateEmailDomainHashWithVersion.mockResolvedValue({
      hash: 'hash-other',
      version: 1,
    });

    const response = await confirmDomainVerification(
      createContext({ mapping_id: 'mapping-1', domain: 'other.example' })
    );

    expect(response.status).toBe(400);
    expect(mockVerifyDomainDnsTxt).not.toHaveBeenCalled();
    expect(mockUpdateDomainMapping).not.toHaveBeenCalled();
  });
});

describe('org domain mapping automatic role delegation', () => {
  const below = { hierarchyLevel: 80, maxGrantTier: 1, permissions: ['admin:roles:write'] };
  function settingsContext(body: Record<string, unknown>, adminAuth: Record<string, unknown>) {
    return {
      req: {
        json: vi.fn().mockResolvedValue(body),
        param: vi.fn(() => 'mapping-1'),
      },
      env: {},
      get: vi.fn((key: string) => (key === 'adminAuth' ? adminAuth : undefined)),
      json: vi.fn(
        (responseBody: unknown, status: number = 200) =>
          new Response(JSON.stringify(responseBody), {
            status,
            headers: { 'Content-Type': 'application/json' },
          })
      ),
    } as never;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSettingsCoreAdapter.mockReturnValue(mockCoreAdapter);
    mockResolveSettingsTenantId.mockReturnValue('tenant-1');
    mockGenerateEmailDomainHashWithVersion.mockResolvedValue({ hash: 'hash-1', version: 1 });
    // The tenant's roles: one within a grant tier 1 ceiling, one above it.
    mockCoreAdapter.query.mockImplementation(async (_sql: string, params: unknown[] = []) =>
      [
        { id: 'role-member', grant_tier: 1, hierarchy_level: 10, is_assignable: 1 },
        { id: 'role-admin', grant_tier: 2, hierarchy_level: 10, is_assignable: 1 },
      ].filter((role) => params.includes(role.id))
    );
    mockCreateDomainMapping.mockResolvedValue({ id: 'mapping-1' });
    mockUpdateDomainMapping.mockResolvedValue({ id: 'mapping-1' });
    mockPublishEvent.mockResolvedValue(undefined);
  });

  it('refuses a mapping that would grant a role above the ceiling, and creates one within it', async () => {
    mockCoreAdapter.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('FROM organizations') ? { id: 'org-1' } : null
    );
    const body = { domain: 'example.com', org_id: 'org-1' };
    const refused = await createOrgDomainMapping(
      settingsContext({ ...body, auto_assign_role_id: 'role-admin' }, below)
    );
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({ error: 'role_delegation_denied' });
    expect(mockCreateDomainMapping).not.toHaveBeenCalled();

    const missing = await createOrgDomainMapping(
      settingsContext({ ...body, auto_assign_role_id: 'role-elsewhere' }, below)
    );
    expect(missing.status).toBe(400);

    const created = await createOrgDomainMapping(
      settingsContext({ ...body, auto_assign_role_id: 'role-member' }, below)
    );
    expect(created.status).toBe(201);
    expect(mockCreateDomainMapping).toHaveBeenCalledTimes(1);
  });

  it('refuses re-enabling a mapping whose role is above the ceiling', async () => {
    mockCoreAdapter.queryOne.mockResolvedValue({
      auto_assign_role_id: 'role-admin',
      is_active: 0,
      updated_at: 100,
    });
    const reenable = await updateOrgDomainMapping(settingsContext({ is_active: true }, below));
    expect(reenable.status).toBe(403);
    // Left disabled, the mapping grants nothing.
    const disabled = await updateOrgDomainMapping(settingsContext({ priority: 5 }, below));
    expect(disabled.status).toBe(200);
    // Within the ceiling once its role is replaced.
    const replaced = await updateOrgDomainMapping(
      settingsContext({ is_active: true, auto_assign_role_id: 'role-member' }, below)
    );
    expect(replaced.status).toBe(200);
    expect(mockUpdateDomainMapping).toHaveBeenCalledTimes(2);
    // Each write is of the row as it was checked.
    expect(mockUpdateDomainMapping).toHaveBeenLastCalledWith(
      mockCoreAdapter,
      'mapping-1',
      'tenant-1',
      expect.objectContaining({ isActive: true, autoAssignRoleId: 'role-member' }),
      { expectedUpdatedAt: 100 }
    );
  });

  it('answers 404 without writing for a mapping the tenant does not have', async () => {
    mockCoreAdapter.queryOne.mockResolvedValue(null);
    const response = await updateOrgDomainMapping(settingsContext({ priority: 5 }, below));
    expect(response.status).toBe(404);
    expect(mockUpdateDomainMapping).not.toHaveBeenCalled();
  });

  it('answers 409 when the mapping changed between its check and its write', async () => {
    mockCoreAdapter.queryOne.mockResolvedValue({
      id: 'mapping-1',
      auto_assign_role_id: 'role-member',
      is_active: 1,
      updated_at: 100,
    });
    mockUpdateDomainMapping.mockRejectedValueOnce(new Error('org_domain_mapping_changed'));
    const response = await updateOrgDomainMapping(settingsContext({ priority: 5 }, below));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'conflict' });
  });

  it('checks the automatic role before completing the verification of an active mapping', async () => {
    mockGenerateEmailDomainHashWithVersion.mockResolvedValue({ hash: 'hash-1', version: 1 });
    mockCoreAdapter.queryOne.mockResolvedValue({
      id: 'mapping-1',
      org_id: 'org-1',
      verification_token: 'verification-token',
      verification_status: 'pending',
      verification_expires_at: 4_000_000_000,
      verification_method: 'dns_txt',
      domain_hash: 'hash-1',
      domain_hash_version: 1,
      auto_assign_role_id: 'role-admin',
      is_active: 1,
      updated_at: 100,
    });
    mockVerifyDomainDnsTxt.mockResolvedValue({ verified: true });
    const body = { mapping_id: 'mapping-1', domain: 'example.com' };
    const refused = await confirmDomainVerification(settingsContext(body, below));
    expect(refused.status).toBe(403);
    expect(mockUpdateDomainMapping).not.toHaveBeenCalled();

    const allowed = await confirmDomainVerification(
      settingsContext(body, { ...below, maxGrantTier: 2 })
    );
    expect(allowed.status).toBe(200);
    expect(mockUpdateDomainMapping).toHaveBeenCalledWith(
      mockCoreAdapter,
      'mapping-1',
      'tenant-1',
      { verified: true },
      { expectedUpdatedAt: 100 }
    );
  });
});
