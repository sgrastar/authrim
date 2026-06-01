import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCoreAdapter,
  mockSessionStore,
  mockGetSessionStoreBySessionId,
  mockCreateAuditLogFromContext,
  mockGetLogger,
  mockScheduleAdminAuditLog,
} = vi.hoisted(() => {
  const logger = {
    module: vi.fn().mockReturnThis(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return {
    mockCoreAdapter: {
      query: vi.fn(),
      execute: vi.fn(),
    },
    mockSessionStore: {
      invalidateSessionRpc: vi.fn(),
    },
    mockGetSessionStoreBySessionId: vi.fn(),
    mockCreateAuditLogFromContext: vi.fn(),
    mockGetLogger: vi.fn().mockReturnValue(logger),
    mockScheduleAdminAuditLog: vi.fn(),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn().mockReturnValue('tenant-1'),
    createAuthContextFromHono: vi.fn().mockReturnValue({
      coreAdapter: mockCoreAdapter,
    }),
    createPIIContextFromHono: vi.fn().mockReturnValue({
      defaultPiiAdapter: {},
    }),
    CanonicalRuntimeUserStore: class {
      async findById() {
        return { id: 'user-1', active: true };
      }
    },
    getSessionStoreBySessionId: mockGetSessionStoreBySessionId,
    createAuditLogFromContext: mockCreateAuditLogFromContext,
    getLogger: mockGetLogger,
  };
});

vi.mock('../admin-shared', () => ({
  detectImageType: vi.fn(),
  logSanitizedError: vi.fn(),
  scheduleAdminAuditLog: mockScheduleAdminAuditLog,
}));

import { adminUserRevokeAllSessionsHandler } from '../admin-user-sessions';

function createContext() {
  return {
    req: {
      param: vi.fn().mockReturnValue('user-1'),
    },
    env: {},
    json: vi.fn(
      (body, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
    ),
  } as any;
}

describe('admin user session revocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCoreAdapter.query.mockResolvedValue([
      { id: 'g1:apac:3:session_one' },
      { id: 'legacy-session' },
    ]);
    mockCoreAdapter.execute.mockResolvedValue({ rowsAffected: 2 });
    mockSessionStore.invalidateSessionRpc.mockResolvedValue(true);
    mockGetSessionStoreBySessionId.mockReturnValue({ stub: mockSessionStore });
    mockCreateAuditLogFromContext.mockResolvedValue(undefined);
  });

  it('invalidates located sharded SessionStore sessions before deleting persistence rows', async () => {
    const response = await adminUserRevokeAllSessionsHandler(createContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      revokedCount: 2,
      storeRevokedCount: 1,
    });
    expect(mockGetSessionStoreBySessionId).toHaveBeenCalledWith(
      expect.any(Object),
      'g1:apac:3:session_one',
      'tenant-1'
    );
    expect(mockSessionStore.invalidateSessionRpc).toHaveBeenCalledWith('g1:apac:3:session_one');
    expect(mockCoreAdapter.execute).toHaveBeenCalledWith(
      'DELETE FROM sessions WHERE tenant_id = ? AND user_id = ?',
      ['tenant-1', 'user-1']
    );
  });
});
