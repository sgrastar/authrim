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
} = vi.hoisted(() => {
  const logger = {
    module: vi.fn().mockReturnThis(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    mockCoreAdapter: {
      queryOne: vi.fn(),
      execute: vi.fn(),
    },
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
    getEmailDomainHashConfig: vi.fn().mockResolvedValue({ current_version: 1, secrets: { 1: 'secret' } }),
    generateEmailDomainHashWithVersion: mockGenerateEmailDomainHashWithVersion,
    getDomainMappingById: mockGetDomainMappingById,
    generateVerificationToken: mockGenerateVerificationToken,
    calculateVerificationExpiry: mockCalculateVerificationExpiry,
    verifyDomainDnsTxt: mockVerifyDomainDnsTxt,
    updateDomainMapping: mockUpdateDomainMapping,
    publishEvent: mockPublishEvent,
  };
});

vi.mock('../routes/settings/tenant-resolver', () => ({
  resolveSettingsCoreAdapter: mockResolveSettingsCoreAdapter,
  resolveSettingsTenantId: mockResolveSettingsTenantId,
}));

import {
  confirmDomainVerification,
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
