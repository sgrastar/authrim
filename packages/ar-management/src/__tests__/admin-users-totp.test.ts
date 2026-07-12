import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const {
  mockProjectionRepository,
  mockTotpRepository,
  mockCreateAuthContextFromHono,
  mockCreateAuditLogFromContext,
  mockGetTenantIdFromContext,
} = vi.hoisted(() => {
  const projectionRepository = {
    findByLegacyUserId: vi.fn(),
  };
  const totpRepository = {
    deleteByUserId: vi.fn(),
  };
  return {
    mockProjectionRepository: projectionRepository,
    mockTotpRepository: totpRepository,
    mockCreateAuthContextFromHono: vi.fn().mockReturnValue({
      coreAdapter: {},
      repositories: {
        totp: totpRepository,
      },
    }),
    mockCreateAuditLogFromContext: vi.fn(),
    mockGetTenantIdFromContext: vi.fn().mockReturnValue('tenant_123'),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: mockGetTenantIdFromContext,
    createAuthContextFromHono: mockCreateAuthContextFromHono,
    createPIIContextFromHono: vi.fn().mockReturnValue({ defaultPiiAdapter: {} }),
    hasPIIDatabase: vi.fn().mockReturnValue(true),
    CanonicalSensitiveValueResolver: vi.fn(function CanonicalSensitiveValueResolverMock() {
      return {};
    }),
    CanonicalRuntimeUserProjectionRepository: vi.fn(
      function CanonicalRuntimeUserProjectionRepositoryMock() {
        return mockProjectionRepository;
      }
    ),
    createAuditLogFromContext: mockCreateAuditLogFromContext,
    createErrorResponse: vi.fn(
      (c: { json: (body: unknown, status?: number) => Response }, errorCode: string) =>
        c.json({ error: 'error', error_code: errorCode }, 500)
    ),
  };
});

import { adminUserTotpResetHandler } from '../admin-users';

function createMockContext(userId = 'user_123') {
  const headers = new Headers();
  return {
    env: {} as Env,
    req: {
      param: vi.fn((name: string) => (name === 'id' ? userId : '')),
    },
    header: (name: string, value: string) => {
      headers.append(name, value);
    },
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: {
          'Content-Type': 'application/json',
          ...Object.fromEntries(headers.entries()),
        },
      }),
  } as any;
}

describe('admin user TOTP reset handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTenantIdFromContext.mockReturnValue('tenant_123');
    mockCreateAuthContextFromHono.mockReturnValue({
      coreAdapter: {},
      repositories: {
        totp: mockTotpRepository,
      },
    });
  });

  it('deletes tenant-scoped TOTP credentials and writes an admin audit event', async () => {
    mockProjectionRepository.findByLegacyUserId.mockResolvedValue({ user_id: 'user_123' });
    mockTotpRepository.deleteByUserId.mockResolvedValue(2);
    const context = createMockContext('user_123');

    const response = await adminUserTotpResetHandler(context);
    const body = (await response.json()) as { ok: boolean; deleted: number };

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, deleted: 2 });
    expect(mockCreateAuthContextFromHono).toHaveBeenCalledWith(context, 'tenant_123');
    expect(mockProjectionRepository.findByLegacyUserId).toHaveBeenCalledWith('user_123', {
      includeInactive: true,
    });
    expect(mockTotpRepository.deleteByUserId).toHaveBeenCalledWith('user_123');
    expect(mockCreateAuditLogFromContext).toHaveBeenCalledWith(
      context,
      'admin.user.totp.reset',
      'user',
      'user_123',
      { deleted: 2 },
      'warning'
    );
  });

  it('does not delete credentials when the target user does not exist', async () => {
    mockProjectionRepository.findByLegacyUserId.mockResolvedValue(null);

    const response = await adminUserTotpResetHandler(createMockContext('missing_user'));
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(404);
    expect(body.error).toBe('not_found');
    expect(mockTotpRepository.deleteByUserId).not.toHaveBeenCalled();
    expect(mockCreateAuditLogFromContext).not.toHaveBeenCalled();
  });
});
