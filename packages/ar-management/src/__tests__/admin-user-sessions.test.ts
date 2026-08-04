import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCoreAdapter,
  mockSessionStore,
  mockSessionRevocationStore,
  mockGetSessionStoreBySessionId,
  mockCreateAuditLogFromContext,
  mockGetLogger,
  mockScheduleAdminAuditLog,
  mockRuntimeUsers,
  mockInvalidateUserCache,
  mockIsShardedSessionId,
  mockDetectImageType,
  mockLogSanitizedError,
  mockRecordHybridUserSessionRevocationEpoch,
} = vi.hoisted(() => {
  const logger = {
    module: vi.fn().mockReturnThis(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return {
    mockCoreAdapter: {
      queryOne: vi.fn(),
      query: vi.fn(),
      execute: vi.fn(),
    },
    mockSessionStore: {
      invalidateSessionRpc: vi.fn(),
      getSessionRpc: vi.fn(),
    },
    mockSessionRevocationStore: {
      listActiveSessionsRpc: vi.fn(),
    },
    mockGetSessionStoreBySessionId: vi.fn(),
    mockCreateAuditLogFromContext: vi.fn(),
    mockGetLogger: vi.fn().mockReturnValue(logger),
    mockScheduleAdminAuditLog: vi.fn(),
    mockRuntimeUsers: {
      findById: vi.fn(),
      syncUser: vi.fn(),
    },
    mockInvalidateUserCache: vi.fn(),
    mockIsShardedSessionId: vi.fn(),
    mockDetectImageType: vi.fn(),
    mockLogSanitizedError: vi.fn(),
    mockRecordHybridUserSessionRevocationEpoch: vi.fn(),
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
    CanonicalRuntimeUserStore: vi.fn(function CanonicalRuntimeUserStoreMock() {
      return mockRuntimeUsers;
    }),
    getSessionStoreBySessionId: mockGetSessionStoreBySessionId,
    getSessionRevocationStore: vi.fn(() => mockSessionRevocationStore),
    createAuditLogFromContext: mockCreateAuditLogFromContext,
    getLogger: mockGetLogger,
    invalidateUserCache: mockInvalidateUserCache,
    isShardedSessionId: mockIsShardedSessionId,
    recordUserSessionRevocation: mockRecordHybridUserSessionRevocationEpoch,
    createErrorResponse: vi.fn((c, code) =>
      c.json({ error: code }, code === actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND ? 404 : 500)
    ),
  };
});

vi.mock('../admin-shared', () => ({
  detectImageType: mockDetectImageType,
  logSanitizedError: mockLogSanitizedError,
  scheduleAdminAuditLog: mockScheduleAdminAuditLog,
}));

vi.mock('../request-issuer', () => ({
  getCanonicalTenantBaseUrl: vi.fn(() => 'https://tenant.example.com'),
}));

import {
  adminSessionGetHandler,
  adminSessionRevokeHandler,
  adminSessionsListHandler,
  adminUserAvatarDeleteHandler,
  adminUserAvatarUploadHandler,
  adminUserRevokeAllSessionsHandler,
  serveAvatarHandler,
} from '../admin-user-sessions';

function createContext(
  options: {
    id?: string;
    filename?: string;
    query?: Record<string, string | undefined>;
    parsedBody?: Record<string, unknown>;
    avatars?: {
      get: ReturnType<typeof vi.fn>;
      put: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
  } = {}
) {
  const query = options.query ?? {};
  const avatars = options.avatars ?? {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  };
  return {
    req: {
      param: vi.fn((name: string) =>
        name === 'filename' ? (options.filename ?? 'user-1.png') : (options.id ?? 'user-1')
      ),
      query: vi.fn((name: string) => query[name]),
      parseBody: vi.fn().mockResolvedValue(options.parsedBody ?? {}),
    },
    env: { AVATARS: avatars },
    json: vi.fn(
      (body, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
    ),
  } as never;
}

describe('admin user session revocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCoreAdapter.queryOne.mockResolvedValue(null);
    mockCoreAdapter.query.mockResolvedValue([
      { id: 'g1:apac:3:session_one' },
      { id: 'legacy-session' },
    ]);
    mockCoreAdapter.execute.mockResolvedValue({ rowsAffected: 2 });
    mockSessionStore.invalidateSessionRpc.mockReset().mockResolvedValue(true);
    mockGetSessionStoreBySessionId.mockReturnValue({ stub: mockSessionStore });
    mockCreateAuditLogFromContext.mockResolvedValue(undefined);
    mockRuntimeUsers.findById.mockResolvedValue({
      id: 'user-1',
      active: 1,
      email: 'person@example.com',
      name: 'Person',
      email_verified: 1,
      phone_number_verified: 0,
      picture: null,
    });
    mockRuntimeUsers.syncUser.mockResolvedValue(undefined);
    mockInvalidateUserCache.mockResolvedValue(undefined);
    mockIsShardedSessionId.mockImplementation((id: string) => id.startsWith('g1:'));
    mockSessionStore.getSessionRpc.mockResolvedValue(null);
    mockSessionRevocationStore.listActiveSessionsRpc.mockResolvedValue([]);
    mockRecordHybridUserSessionRevocationEpoch.mockResolvedValue(1_750_000_000_000);
    mockDetectImageType.mockReturnValue({ extension: 'png', mimeType: 'image/png' });
  });

  it('revokes all sessions through the user-scoped DO without querying session D1 rows', async () => {
    mockSessionRevocationStore.listActiveSessionsRpc.mockResolvedValueOnce([
      { sessionId: 'g1:apac:3:session_one' },
      { sessionId: 'g1:apac:3:session_two' },
    ]);
    const response = await adminUserRevokeAllSessionsHandler(createContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      revokedCount: 2,
      storeRevokedCount: 2,
    });
    expect(mockRecordHybridUserSessionRevocationEpoch).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-1',
      'user-1',
      expect.any(Number)
    );
    expect(mockCoreAdapter.query).not.toHaveBeenCalled();
    expect(mockCoreAdapter.execute).not.toHaveBeenCalled();
  });

  describe('avatar serving and mutation', () => {
    it.each([
      ['path traversal', '../secret.png'],
      ['unsupported extension', 'avatar.svg'],
      ['missing extension', 'avatar'],
    ])('rejects %s filenames before reading R2', async (_name, filename) => {
      const avatars = { get: vi.fn(), put: vi.fn(), delete: vi.fn() };
      const response = await serveAvatarHandler(createContext({ filename, avatars }));
      expect(response.status).toBe(404);
      expect(avatars.get).not.toHaveBeenCalled();
    });

    it('returns not_found for a missing avatar object', async () => {
      const avatars = { get: vi.fn(), put: vi.fn(), delete: vi.fn() };
      expect(
        (await serveAvatarHandler(createContext({ filename: 'user-1.jpeg', avatars }))).status
      ).toBe(404);
      expect(avatars.get).toHaveBeenCalledWith('avatars/user-1.jpeg');
    });

    it.each([
      ['gif', 'image/gif'],
      ['jpg', 'image/jpeg'],
      ['jpeg', 'image/jpeg'],
      ['png', 'image/png'],
      ['webp', 'image/webp'],
    ])('serves .%s with nosniff and immutable metadata', async (extension, contentType) => {
      const object = {
        body: new Blob(['image']),
        httpEtag: 'etag-1',
        writeHttpMetadata: vi.fn((headers: Headers) => headers.set('x-r2-meta', 'yes')),
      };
      const avatars = { get: vi.fn().mockResolvedValue(object), put: vi.fn(), delete: vi.fn() };
      const response = await serveAvatarHandler(
        createContext({ filename: `user-1.${extension}`, avatars })
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(contentType);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('cache-control')).toContain('immutable');
    });

    it('normalizes R2 failures to internal_error', async () => {
      const avatars = {
        get: vi.fn().mockRejectedValue(new Error('R2 unavailable')),
        put: vi.fn(),
        delete: vi.fn(),
      };
      expect((await serveAvatarHandler(createContext({ avatars }))).status).toBe(500);
      expect(mockLogSanitizedError).toHaveBeenCalled();
    });

    it('refuses avatar upload for an unknown tenant user', async () => {
      mockRuntimeUsers.findById.mockResolvedValueOnce(null);
      expect((await adminUserAvatarUploadHandler(createContext())).status).toBe(404);
    });

    it('requires a File upload', async () => {
      expect(
        (await adminUserAvatarUploadHandler(createContext({ parsedBody: { avatar: 'text' } })))
          .status
      ).toBe(400);
    });

    it.each([
      [new File(['x'], 'avatar.svg', { type: 'image/svg+xml' }), 'mime type'],
      [new File(['x'], 'avatar.exe', { type: 'image/png' }), 'extension'],
    ])('rejects avatar %s mismatch', async (file) => {
      expect(
        (await adminUserAvatarUploadHandler(createContext({ parsedBody: { avatar: file } }))).status
      ).toBe(400);
    });

    it('rejects files above 5 MiB before reading content', async () => {
      const file = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'avatar.png', {
        type: 'image/png',
      });
      expect(
        (await adminUserAvatarUploadHandler(createContext({ parsedBody: { avatar: file } }))).status
      ).toBe(400);
    });

    it('rejects content whose magic bytes are not an allowed image', async () => {
      mockDetectImageType.mockReturnValueOnce(null);
      const file = new File(['not an image'], 'avatar.png', { type: 'image/png' });
      expect(
        (await adminUserAvatarUploadHandler(createContext({ parsedBody: { avatar: file } }))).status
      ).toBe(400);
    });

    it('stores detected image type and updates only canonical picture PII', async () => {
      const file = new File(['png'], '../avatar.jpg', { type: 'image/jpeg' });
      const avatars = { get: vi.fn(), put: vi.fn(), delete: vi.fn() };
      const response = await adminUserAvatarUploadHandler(
        createContext({ parsedBody: { avatar: file }, avatars })
      );
      await expect(response.json()).resolves.toMatchObject({
        success: true,
        avatarUrl: 'https://tenant.example.com/avatars/user-1.png',
      });
      expect(avatars.put).toHaveBeenCalledWith('avatars/user-1.png', expect.any(ArrayBuffer), {
        httpMetadata: { contentType: 'image/png' },
      });
      expect(mockRuntimeUsers.syncUser).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          piiFields: { picture: true },
          sensitiveValues: { picture: 'https://tenant.example.com/avatars/user-1.png' },
        })
      );
      expect(mockInvalidateUserCache).toHaveBeenCalledWith(expect.anything(), 'tenant-1', 'user-1');
    });

    it('does not reactivate an inactive user when updating an avatar', async () => {
      mockRuntimeUsers.findById.mockResolvedValueOnce({
        id: 'user-1',
        active: 0,
        email_verified: 1,
        phone_number_verified: 0,
        picture: null,
      });
      const file = new File(['png'], 'avatar.png', { type: 'image/png' });

      expect(
        (await adminUserAvatarUploadHandler(createContext({ parsedBody: { avatar: file } }))).status
      ).toBe(200);
      expect(mockRuntimeUsers.syncUser).toHaveBeenCalledWith(
        expect.objectContaining({ active: false })
      );
    });

    it('returns server_error when avatar persistence fails', async () => {
      const file = new File(['png'], 'avatar.png', { type: 'image/png' });
      const avatars = {
        get: vi.fn(),
        put: vi.fn().mockRejectedValue(new Error('R2 unavailable')),
        delete: vi.fn(),
      };
      expect(
        (
          await adminUserAvatarUploadHandler(
            createContext({ parsedBody: { avatar: file }, avatars })
          )
        ).status
      ).toBe(500);
    });

    it('returns not_found when deleting an unknown user or a user without picture', async () => {
      mockRuntimeUsers.findById.mockResolvedValueOnce(null);
      expect((await adminUserAvatarDeleteHandler(createContext())).status).toBe(404);
      mockRuntimeUsers.findById.mockResolvedValueOnce({ id: 'user-1', picture: null });
      expect((await adminUserAvatarDeleteHandler(createContext())).status).toBe(404);
    });

    it('clears canonical picture even when best-effort R2 deletion fails', async () => {
      mockRuntimeUsers.findById.mockResolvedValueOnce({
        id: 'user-1',
        picture: 'https://tenant.example.com/avatars/user-1.png',
        email_verified: 0,
        phone_number_verified: 1,
      });
      const avatars = {
        get: vi.fn(),
        put: vi.fn(),
        delete: vi.fn().mockRejectedValue(new Error('R2 unavailable')),
      };
      const response = await adminUserAvatarDeleteHandler(createContext({ avatars }));
      expect(response.status).toBe(200);
      expect(avatars.delete).toHaveBeenCalledWith('avatars/user-1.png');
      expect(mockRuntimeUsers.syncUser).toHaveBeenCalledWith(
        expect.objectContaining({ sensitiveValues: { picture: null } })
      );
    });

    it('does not reactivate an inactive user when deleting an avatar', async () => {
      mockRuntimeUsers.findById.mockResolvedValueOnce({
        id: 'user-1',
        active: 0,
        picture: 'https://tenant.example.com/avatars/user-1.png',
        email_verified: 0,
        phone_number_verified: 1,
      });

      expect((await adminUserAvatarDeleteHandler(createContext())).status).toBe(200);
      expect(mockRuntimeUsers.syncUser).toHaveBeenCalledWith(
        expect.objectContaining({ active: false })
      );
    });

    it('returns server_error for unexpected avatar deletion failures', async () => {
      mockRuntimeUsers.findById.mockRejectedValueOnce(new Error('PII store unavailable'));
      expect((await adminUserAvatarDeleteHandler(createContext())).status).toBe(500);
    });
  });

  describe('session listing and lookup', () => {
    it('requires a user_id because there is no tenant-wide D1 session index', async () => {
      const response = await adminSessionsListHandler(createContext());
      expect(response.status).toBe(400);
      expect(mockCoreAdapter.query).not.toHaveBeenCalled();
    });

    it('lists only verified active sessions from the user and session DOs', async () => {
      const now = Date.now();
      mockSessionRevocationStore.listActiveSessionsRpc.mockResolvedValueOnce([
        { sessionId: 'g1:apac:3:s1' },
        { sessionId: 'g1:apac:3:stale' },
      ]);
      mockSessionStore.getSessionRpc
        .mockResolvedValueOnce({
          id: 'g1:apac:3:s1',
          tenantId: 'tenant-1',
          userId: 'user-1',
          accountId: 'account:user-1',
          createdAt: now - 1_000,
          expiresAt: now + 60_000,
          data: { ipAddress: '203.0.113.1', userAgent: 'Browser' },
        })
        .mockResolvedValueOnce(null);

      const response = await adminSessionsListHandler(
        createContext({ query: { user_id: 'user-1' } })
      );
      await expect(response.json()).resolves.toMatchObject({
        sessions: [
          {
            id: 'g1:apac:3:s1',
            user_id: 'user-1',
            user_email: 'person@example.com',
            is_active: true,
          },
        ],
        pagination: { total: 1 },
      });
      expect(mockCoreAdapter.query).not.toHaveBeenCalled();
    });

    it('rejects expired-session listing instead of reading D1 history', async () => {
      const response = await adminSessionsListHandler(
        createContext({ query: { user_id: 'user-1', status: 'expired' } })
      );
      expect(response.status).toBe(400);
    });

    it('returns server_error when the user session DO is unavailable', async () => {
      mockSessionRevocationStore.listActiveSessionsRpc.mockRejectedValueOnce(
        new Error('DO unavailable')
      );
      expect(
        (await adminSessionsListHandler(createContext({ query: { user_id: 'user-1' } }))).status
      ).toBe(500);
    });

    it('returns not_found when SessionStore has no session', async () => {
      expect((await adminSessionGetHandler(createContext({ id: 'legacy' }))).status).toBe(404);
    });

    it('returns active SessionStore data with PII identity', async () => {
      mockSessionStore.getSessionRpc.mockResolvedValueOnce({
        id: 'g1:apac:3:s1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        createdAt: Date.now() - 1000,
        expiresAt: Date.now() + 60_000,
      });
      const response = await adminSessionGetHandler(createContext({ id: 'g1:apac:3:s1' }));
      await expect(response.json()).resolves.toMatchObject({
        session: {
          id: 'g1:apac:3:s1',
          userId: 'user-1',
          userEmail: 'person@example.com',
          userName: 'Person',
          isActive: true,
          source: 'durable_object',
        },
      });
    });

    it('does not fall back to D1 when SessionStore routing fails', async () => {
      mockGetSessionStoreBySessionId.mockImplementationOnce(() => {
        throw new Error('route failure');
      });
      const response = await adminSessionGetHandler(createContext({ id: 'g1:apac:3:s1' }));
      expect(response.status).toBe(404);
      expect(mockCoreAdapter.queryOne).not.toHaveBeenCalled();
    });
  });

  describe('individual and bulk revocation', () => {
    it('rejects a non-sharded session ID without consulting D1', async () => {
      expect((await adminSessionRevokeHandler(createContext({ id: 'legacy' }))).status).toBe(404);
      expect(mockCoreAdapter.queryOne).not.toHaveBeenCalled();
    });

    it('revokes an existing session directly in SessionStore', async () => {
      mockSessionStore.getSessionRpc.mockResolvedValueOnce({
        id: 'g1:apac:3:s1',
        tenantId: 'tenant-1',
        userId: 'user-1',
      });
      const response = await adminSessionRevokeHandler(createContext({ id: 'g1:apac:3:s1' }));
      expect(response.status).toBe(200);
      expect(mockSessionStore.invalidateSessionRpc).toHaveBeenCalledWith('g1:apac:3:s1');
      expect(mockCoreAdapter.execute).not.toHaveBeenCalled();
    });

    it('fails closed when SessionStore invalidation is not confirmed', async () => {
      mockSessionStore.getSessionRpc.mockResolvedValueOnce({
        id: 'g1:apac:3:s1',
        tenantId: 'tenant-1',
        userId: 'user-1',
      });
      mockSessionStore.invalidateSessionRpc.mockResolvedValueOnce(false);
      expect((await adminSessionRevokeHandler(createContext({ id: 'g1:apac:3:s1' }))).status).toBe(
        500
      );
    });

    it('returns not_found when bulk revocation user is outside the tenant', async () => {
      mockRuntimeUsers.findById.mockResolvedValueOnce(null);
      expect((await adminUserRevokeAllSessionsHandler(createContext())).status).toBe(404);
    });

    it('advances the sole user DO authority and reports indexed active sessions', async () => {
      mockSessionRevocationStore.listActiveSessionsRpc.mockResolvedValueOnce([
        { sessionId: 'g1:apac:3:one' },
        { sessionId: 'g1:apac:3:two' },
      ]);
      const response = await adminUserRevokeAllSessionsHandler(createContext());
      await expect(response.json()).resolves.toMatchObject({
        revokedCount: 2,
        storeRevokedCount: 2,
      });
      expect(mockRecordHybridUserSessionRevocationEpoch).toHaveBeenCalledOnce();
      expect(mockCoreAdapter.execute).not.toHaveBeenCalled();
    });

    it('returns server_error when the revocation DO is unavailable', async () => {
      mockRecordHybridUserSessionRevocationEpoch.mockRejectedValueOnce(new Error('DO unavailable'));
      expect((await adminUserRevokeAllSessionsHandler(createContext())).status).toBe(500);
    });

    it('returns server_error for bulk revocation failure', async () => {
      mockRuntimeUsers.findById.mockRejectedValueOnce(new Error('user store unavailable'));
      expect((await adminUserRevokeAllSessionsHandler(createContext())).status).toBe(500);
    });
  });
});
