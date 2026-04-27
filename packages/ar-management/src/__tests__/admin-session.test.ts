import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const {
  mockGetCookie,
  mockSetCookie,
  mockBuildIssuerUrl,
  mockGetTenantIdFromContext,
  mockParseAllowedOrigins,
  mockIsAllowedOrigin,
  mockPublishEvent,
  mockGetAdminCookieSameSite,
  mockGetLogger,
  mockLogger,
  mockAdminAdapter,
  mockAdminSessionRepo,
  mockRequireDedicatedAdminDatabaseAdapter,
  MockAdminSessionRepository,
} = vi.hoisted(() => {
  const logger = {
    module: vi.fn().mockReturnThis(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const adminAdapter = {
    query: vi.fn(),
    queryOne: vi.fn(),
  };

  const adminSessionRepo = {
    getSession: vi.fn(),
    getSessionIncludingExpired: vi.fn(),
    deleteSession: vi.fn(),
  };

  const MockAdminSessionRepository = vi.fn(function MockAdminSessionRepository() {
    return adminSessionRepo;
  });

  return {
    mockGetCookie: vi.fn(),
    mockSetCookie: vi.fn(),
    mockBuildIssuerUrl: vi.fn().mockReturnValue('https://admin.example.com'),
    mockGetTenantIdFromContext: vi.fn().mockReturnValue('default'),
    mockParseAllowedOrigins: vi.fn().mockReturnValue(['https://admin.example.com']),
    mockIsAllowedOrigin: vi.fn().mockReturnValue(true),
    mockPublishEvent: vi.fn().mockResolvedValue(undefined),
    mockGetAdminCookieSameSite: vi.fn().mockReturnValue('Lax'),
    mockGetLogger: vi.fn().mockReturnValue(logger),
    mockLogger: logger,
    mockAdminAdapter: adminAdapter,
    mockAdminSessionRepo: adminSessionRepo,
    mockRequireDedicatedAdminDatabaseAdapter: vi.fn().mockReturnValue(adminAdapter),
    MockAdminSessionRepository,
  };
});

vi.mock('hono/cookie', () => ({
  getCookie: mockGetCookie,
  setCookie: mockSetCookie,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    buildIssuerUrl: mockBuildIssuerUrl,
    getTenantIdFromContext: mockGetTenantIdFromContext,
    parseAllowedOrigins: mockParseAllowedOrigins,
    isAllowedOrigin: mockIsAllowedOrigin,
    getLogger: mockGetLogger,
    requireDedicatedAdminDatabaseAdapter: mockRequireDedicatedAdminDatabaseAdapter,
    AdminSessionRepository: MockAdminSessionRepository,
    publishEvent: mockPublishEvent,
    getAdminCookieSameSite: mockGetAdminCookieSameSite,
  };
});

import { adminLogoutHandler, adminSessionStatusHandler } from '../admin-session';

function createMockContext(options: { headers?: Record<string, string>; env?: Partial<Env> }) {
  const headers = Object.fromEntries(
    Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  );

  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
    },
    env: {
      ISSUER_URL: 'https://admin.example.com',
      DB_ADMIN: {} as D1Database,
      ...options.env,
    } as Env,
    json: vi.fn(
      (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
    ),
  } as any;
}

describe('Admin Session Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildIssuerUrl.mockReturnValue('https://admin.example.com');
    mockGetTenantIdFromContext.mockReturnValue('default');
    mockParseAllowedOrigins.mockReturnValue(['https://admin.example.com']);
    mockIsAllowedOrigin.mockReturnValue(true);
    mockPublishEvent.mockResolvedValue(undefined);
    mockGetAdminCookieSameSite.mockReturnValue('Lax');
    mockGetLogger.mockReturnValue(mockLogger);
    mockRequireDedicatedAdminDatabaseAdapter.mockReturnValue(mockAdminAdapter);
  });

  it('returns session details when the admin user has an allowed role', async () => {
    mockGetCookie.mockReturnValue('admin-session-123');
    mockAdminSessionRepo.getSession.mockResolvedValue({
      id: 'admin-session-123',
      admin_user_id: 'admin-user-1',
      created_at: 100,
      expires_at: 200,
    });
    mockAdminAdapter.query.mockResolvedValue([{ name: 'viewer' }]);
    mockAdminAdapter.queryOne.mockResolvedValue({
      email: 'admin@example.com',
      name: 'Admin User',
      last_login_at: 1700000000,
    });

    const response = await adminSessionStatusHandler(createMockContext({}));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      active: true,
      session_id: 'admin-session-123',
      user_id: 'admin-user-1',
      email: 'admin@example.com',
      name: 'Admin User',
      roles: ['viewer'],
      last_login_at: 1700000000,
    });
  });

  it('rejects session status requests when the user lacks an admin role', async () => {
    mockGetCookie.mockReturnValue('admin-session-123');
    mockAdminSessionRepo.getSession.mockResolvedValue({
      id: 'admin-session-123',
      admin_user_id: 'admin-user-1',
      created_at: 100,
      expires_at: 200,
    });
    mockAdminAdapter.query.mockResolvedValue([{ name: 'auditor' }]);

    const response = await adminSessionStatusHandler(createMockContext({}));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: 'forbidden',
      error_description: 'You do not have admin permissions',
    });
  });

  it('rejects admin logout when both Origin and Referer are missing', async () => {
    mockGetCookie.mockReturnValue('admin-session-123');

    const response = await adminLogoutHandler(createMockContext({}));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: 'forbidden',
      error_description: 'Origin or Referer header is required',
    });
    expect(mockSetCookie).not.toHaveBeenCalled();
  });

  it('accepts a valid Referer fallback and clears the admin session cookie', async () => {
    mockGetCookie.mockReturnValue('admin-session-123');
    mockAdminSessionRepo.getSessionIncludingExpired.mockResolvedValue({
      admin_user_id: 'admin-user-1',
    });
    mockAdminSessionRepo.deleteSession.mockResolvedValue(true);

    const response = await adminLogoutHandler(
      createMockContext({
        headers: {
          Referer: 'https://admin.example.com/settings',
        },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      message: 'Logged out successfully',
    });
    expect(mockIsAllowedOrigin).toHaveBeenCalledWith('https://admin.example.com', [
      'https://admin.example.com',
    ]);
    expect(mockSetCookie).toHaveBeenCalledWith(
      expect.anything(),
      'authrim_admin_session',
      '',
      expect.objectContaining({
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        maxAge: 0,
      })
    );
    expect(mockPublishEvent).toHaveBeenCalledTimes(2);
  });
});
