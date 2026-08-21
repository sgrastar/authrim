import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCoreAdapter,
  mockSessionStore,
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
    createAuditLogFromContext: mockCreateAuditLogFromContext,
    getLogger: mockGetLogger,
    invalidateUserCache: mockInvalidateUserCache,
    isShardedSessionId: mockIsShardedSessionId,
    recordHybridUserSessionRevocationEpoch: mockRecordHybridUserSessionRevocationEpoch,
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
    env: { PUBLIC_ASSETS: avatars },
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
    mockRecordHybridUserSessionRevocationEpoch.mockResolvedValue(1_750_000_000_000);
    mockDetectImageType.mockReturnValue({ extension: 'png', mimeType: 'image/png' });
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
    expect(mockRecordHybridUserSessionRevocationEpoch).toHaveBeenCalledWith(
      expect.anything(),
      mockCoreAdapter,
      'tenant-1',
      'user-1',
      expect.any(Number)
    );
    expect(mockCoreAdapter.execute).toHaveBeenCalledWith(
      'DELETE FROM sessions WHERE tenant_id = ? AND user_id = ?',
      ['tenant-1', 'user-1']
    );
  });

  describe('avatar serving and mutation', () => {
    it.each([
      ['path traversal', '../secret.png'],
      ['unsupported extension', 'avatar.svg'],
      ['missing extension', 'avatar'],
    ])('rejects %s filenames before reading R2', async (_name, filename) => {
      const avatars = {
        get: vi.fn(),
        put: vi.fn(),
        delete: vi.fn().mockResolvedValue(undefined),
      };
      const response = await serveAvatarHandler(createContext({ filename, avatars }));
      expect(response.status).toBe(404);
      expect(avatars.get).not.toHaveBeenCalled();
    });

    it('returns not_found for a missing avatar object', async () => {
      const avatars = {
        get: vi.fn(),
        put: vi.fn(),
        delete: vi.fn().mockResolvedValue(undefined),
      };
      expect(
        (await serveAvatarHandler(createContext({ filename: 'user-1.jpeg', avatars }))).status
      ).toBe(404);
      expect(avatars.get).toHaveBeenCalledWith('avatars/tenant-1/users/user-1.jpeg');
    });

    it.each([
      ['gif', 'image/gif'],
      ['jpg', 'image/jpeg'],
      ['jpeg', 'image/jpeg'],
      ['png', 'image/png'],
      ['webp', 'image/webp'],
    ])('serves .%s with nosniff and no-store metadata', async (extension, contentType) => {
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
      expect(response.headers.get('cache-control')).toBe('private, no-store');
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
      const body = (await response.json()) as { success: boolean; avatarUrl: string };
      expect(body).toMatchObject({
        success: true,
      });
      expect(body.avatarUrl).toMatch(
        /^https:\/\/tenant\.example\.com\/api\/avatars\/[0-9a-f-]{36}\.png$/u
      );
      const filename = body.avatarUrl.split('/').pop();
      expect(avatars.put).toHaveBeenCalledWith(
        `avatars/tenant-1/users/${filename}`,
        expect.any(ArrayBuffer),
        {
          httpMetadata: { contentType: 'image/png' },
        }
      );
      expect(mockRuntimeUsers.syncUser).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          piiFields: { picture: true },
          sensitiveValues: { picture: body.avatarUrl },
        })
      );
      expect(mockInvalidateUserCache).toHaveBeenCalledWith(expect.anything(), 'tenant-1', 'user-1');
    });

    it('replaces only a tenant-owned previous avatar after canonical PII is updated', async () => {
      mockRuntimeUsers.findById.mockResolvedValueOnce({
        id: 'user-1',
        active: 1,
        email_verified: 1,
        phone_number_verified: 0,
        picture: 'https://tenant.example.com/api/avatars/previous.png',
      });
      const avatars = {
        get: vi.fn(),
        put: vi.fn(),
        delete: vi.fn().mockResolvedValue(undefined),
      };
      const file = new File(['png'], 'avatar.png', { type: 'image/png' });

      expect(
        (
          await adminUserAvatarUploadHandler(
            createContext({ parsedBody: { avatar: file }, avatars })
          )
        ).status
      ).toBe(200);
      expect(mockRuntimeUsers.syncUser).toHaveBeenCalledBefore(avatars.delete);
      expect(avatars.delete).toHaveBeenCalledWith('avatars/tenant-1/users/previous.png');

      mockRuntimeUsers.findById.mockResolvedValueOnce({
        id: 'user-1',
        active: 1,
        email_verified: 1,
        phone_number_verified: 0,
        picture: 'https://external.example/avatar/other-user.png',
      });
      await adminUserAvatarUploadHandler(createContext({ parsedBody: { avatar: file }, avatars }));
      expect(avatars.delete).toHaveBeenCalledTimes(1);
    });

    it('removes a newly uploaded object when canonical PII update fails', async () => {
      mockRuntimeUsers.syncUser.mockRejectedValueOnce(new Error('PII store unavailable'));
      const avatars = {
        get: vi.fn(),
        put: vi.fn(),
        delete: vi.fn().mockResolvedValue(undefined),
      };
      const file = new File(['png'], 'avatar.png', { type: 'image/png' });

      expect(
        (
          await adminUserAvatarUploadHandler(
            createContext({ parsedBody: { avatar: file }, avatars })
          )
        ).status
      ).toBe(500);
      expect(avatars.delete).toHaveBeenCalledWith(
        expect.stringMatching(/^avatars\/tenant-1\/users\/[0-9a-f-]{36}\.png$/u)
      );
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
        picture: 'https://tenant.example.com/api/avatars/user-1.png',
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
      expect(avatars.delete).toHaveBeenCalledWith('avatars/tenant-1/users/user-1.png');
      expect(mockRuntimeUsers.syncUser).toHaveBeenCalledWith(
        expect.objectContaining({ sensitiveValues: { picture: null } })
      );
    });

    it('does not reactivate an inactive user when deleting an avatar', async () => {
      mockRuntimeUsers.findById.mockResolvedValueOnce({
        id: 'user-1',
        active: 0,
        picture: 'https://tenant.example.com/api/avatars/user-1.png',
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
    it('lists active sessions with aliases, pagination, deduplicated PII lookup, and fallbacks', async () => {
      const now = Math.floor(Date.now() / 1000);
      mockCoreAdapter.queryOne.mockResolvedValueOnce({ count: 3 });
      mockCoreAdapter.query.mockResolvedValueOnce([
        {
          id: 's1',
          user_id: 'user-1',
          created_at: now - 100,
          last_accessed_at: null,
          expires_at: now + 100,
          ip_address: '',
          user_agent: null,
        },
        {
          id: 's2',
          user_id: 'user-1',
          created_at: now - 200,
          last_accessed_at: now - 50,
          expires_at: now - 1,
          ip_address: '203.0.113.1',
          user_agent: 'Browser',
        },
      ]);
      const response = await adminSessionsListHandler(
        createContext({ query: { page: '2', limit: '2', userId: 'user-1', active: 'true' } })
      );
      const body = (await response.json()) as { sessions: unknown[]; pagination: unknown };
      expect(body.sessions).toHaveLength(2);
      expect(body.pagination).toEqual({
        page: 2,
        limit: 2,
        total: 3,
        totalPages: 2,
        hasNext: false,
        hasPrev: true,
      });
      expect(mockRuntimeUsers.findById).toHaveBeenCalledTimes(1);
      expect(mockCoreAdapter.query).toHaveBeenCalledWith(
        expect.stringContaining('expires_at > ?'),
        expect.arrayContaining(['tenant-1', 'user-1', 2, 2])
      );
    });

    it.each([
      [{ status: 'expired' }, 'expires_at <= ?'],
      [{ active: 'false' }, 'expires_at <= ?'],
      [{ status: 'active' }, 'expires_at > ?'],
    ])('applies session status filter %#', async (query, sql) => {
      mockCoreAdapter.queryOne.mockResolvedValueOnce({ count: 0 });
      mockCoreAdapter.query.mockResolvedValueOnce([]);
      await adminSessionsListHandler(createContext({ query }));
      expect(mockCoreAdapter.query).toHaveBeenCalledWith(
        expect.stringContaining(sql),
        expect.any(Array)
      );
    });

    it('uses list defaults and handles missing count', async () => {
      mockCoreAdapter.queryOne.mockResolvedValueOnce(null);
      mockCoreAdapter.query.mockResolvedValueOnce([]);
      const response = await adminSessionsListHandler(createContext());
      await expect(response.json()).resolves.toMatchObject({
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasNext: false, hasPrev: false },
      });
    });

    it('returns server_error for session list failure', async () => {
      mockCoreAdapter.queryOne.mockRejectedValueOnce(new Error('D1 unavailable'));
      expect((await adminSessionsListHandler(createContext())).status).toBe(500);
    });

    it('returns not_found when neither SessionStore nor D1 has a session', async () => {
      expect((await adminSessionGetHandler(createContext({ id: 'legacy' }))).status).toBe(404);
    });

    it('returns active sharded SessionStore data with PII identity', async () => {
      mockSessionStore.getSessionRpc.mockResolvedValueOnce({
        id: 'g1:apac:3:s1',
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
          source: 'memory',
        },
      });
    });

    it('falls back to tenant-scoped D1 when SessionStore routing fails', async () => {
      mockGetSessionStoreBySessionId.mockImplementationOnce(() => {
        throw new Error('route failure');
      });
      mockCoreAdapter.queryOne.mockResolvedValueOnce({
        id: 'g1:apac:3:s1',
        user_id: 'user-1',
        created_at: 100,
        expires_at: Math.floor(Date.now() / 1000) - 1,
      });
      const response = await adminSessionGetHandler(createContext({ id: 'g1:apac:3:s1' }));
      await expect(response.json()).resolves.toMatchObject({
        session: { source: 'database', isActive: false },
      });
    });

    it('returns session without identity when neither source has user ID', async () => {
      mockCoreAdapter.queryOne.mockResolvedValueOnce({
        id: 'legacy',
        user_id: '',
        created_at: 100,
        expires_at: 200,
      });
      const response = await adminSessionGetHandler(createContext({ id: 'legacy' }));
      await expect(response.json()).resolves.toMatchObject({
        session: { userEmail: null, userName: null },
      });
      expect(mockRuntimeUsers.findById).not.toHaveBeenCalled();
    });

    it('returns server_error for session lookup failure', async () => {
      mockCoreAdapter.queryOne.mockRejectedValueOnce(new Error('D1 unavailable'));
      expect((await adminSessionGetHandler(createContext({ id: 'legacy' }))).status).toBe(500);
    });
  });

  describe('individual and bulk revocation', () => {
    it('does not revoke a session outside the tenant', async () => {
      expect((await adminSessionRevokeHandler(createContext({ id: 'legacy' }))).status).toBe(404);
    });

    it.each([
      ['g1:apac:3:s1', true],
      ['g1:apac:3:s1', false],
      ['legacy', true],
    ])('revokes %s with SessionStore result=%s and always deletes D1', async (id, deleted) => {
      mockCoreAdapter.queryOne.mockResolvedValueOnce({ id, user_id: 'user-1' });
      mockSessionStore.invalidateSessionRpc.mockResolvedValueOnce(deleted);
      const response = await adminSessionRevokeHandler(createContext({ id }));
      expect(response.status).toBe(200);
      expect(mockCoreAdapter.execute).toHaveBeenCalledWith(
        'DELETE FROM sessions WHERE id = ? AND tenant_id = ?',
        [id, 'tenant-1']
      );
    });

    it('continues D1 revocation when SessionStore routing throws', async () => {
      mockCoreAdapter.queryOne.mockResolvedValueOnce({ id: 'g1:apac:3:s1', user_id: 'user-1' });
      mockGetSessionStoreBySessionId.mockImplementationOnce(() => {
        throw new Error('route failure');
      });
      expect((await adminSessionRevokeHandler(createContext({ id: 'g1:apac:3:s1' }))).status).toBe(
        200
      );
      expect(mockCoreAdapter.execute).toHaveBeenCalled();
    });

    it('returns server_error for D1 revoke failure', async () => {
      mockCoreAdapter.queryOne.mockRejectedValueOnce(new Error('D1 unavailable'));
      expect((await adminSessionRevokeHandler(createContext())).status).toBe(500);
    });

    it('returns not_found when bulk revocation user is outside the tenant', async () => {
      mockRuntimeUsers.findById.mockResolvedValueOnce(null);
      expect((await adminUserRevokeAllSessionsHandler(createContext())).status).toBe(404);
    });

    it('advances both revocation authorities and counts only confirmed DO invalidations', async () => {
      mockCoreAdapter.query.mockResolvedValueOnce([
        { id: 'g1:apac:3:one' },
        { id: 'g1:apac:3:two' },
        { id: 'legacy' },
      ]);
      mockSessionStore.invalidateSessionRpc
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      const response = await adminUserRevokeAllSessionsHandler(createContext());
      await expect(response.json()).resolves.toMatchObject({ storeRevokedCount: 1 });
      expect(mockRecordHybridUserSessionRevocationEpoch).toHaveBeenCalledOnce();
    });

    it('continues bulk revocation when one DO route fails and defaults missing row count to zero', async () => {
      mockCoreAdapter.query.mockResolvedValueOnce([{ id: 'g1:apac:3:one' }]);
      mockGetSessionStoreBySessionId.mockImplementationOnce(() => {
        throw new Error('route failure');
      });
      mockCoreAdapter.execute.mockResolvedValueOnce({ rowsAffected: undefined });
      const response = await adminUserRevokeAllSessionsHandler(createContext());
      await expect(response.json()).resolves.toMatchObject({
        revokedCount: 0,
        storeRevokedCount: 0,
      });
    });

    it('returns server_error for bulk revocation failure', async () => {
      mockRuntimeUsers.findById.mockRejectedValueOnce(new Error('user store unavailable'));
      expect((await adminUserRevokeAllSessionsHandler(createContext())).status).toBe(500);
    });
  });
});
