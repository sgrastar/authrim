import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  findByUserId: vi.fn(),
  findById: vi.fn(),
  revoke: vi.fn(),
  revokeByUserId: vi.fn(),
  cleanupExpired: vi.fn(),
  audit: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  repositoryTenants: [] as string[],
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  class Repository {
    findByUserId = mocks.findByUserId;
    findById = mocks.findById;
    revoke = mocks.revoke;
    revokeByUserId = mocks.revokeByUserId;
    cleanupExpired = mocks.cleanupExpired;

    constructor(_adapter: unknown, tenantId: string) {
      mocks.repositoryTenants.push(tenantId);
    }
  }
  const statusByCode: Record<string, number> = {
    [actual.AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD]: 400,
    [actual.AR_ERROR_CODES.VALIDATION_INVALID_VALUE]: 400,
    [actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND]: 404,
    [actual.AR_ERROR_CODES.INTERNAL_ERROR]: 500,
  };
  return {
    ...actual,
    DeviceSecretRepository: Repository,
    createAuthContextFromHono: () => ({ coreAdapter: {} }),
    createAuditLogFromContext: mocks.audit,
    getTenantIdFromContext: (c: { get: (key: string) => unknown }) => c.get('tenantId'),
    getLogger: () => ({
      module: () => ({ info: mocks.logInfo, error: mocks.logError }),
    }),
    createErrorResponse: (
      c: { json: (body: unknown, status?: number) => Response },
      code: string
    ) => c.json({ error_code: code }, statusByCode[code] ?? 500),
  };
});

import { AR_ERROR_CODES } from '@authrim/ar-lib-core';
import {
  cleanupExpiredDeviceSecrets,
  getDeviceSecret,
  listUserDeviceSecrets,
  revokeAllUserDeviceSecrets,
  revokeDeviceSecret,
} from '../routes/device-secrets';

function secret(overrides: Record<string, unknown> = {}) {
  return {
    id: 'device-a',
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    session_id: 'session-a',
    device_name: 'Laptop',
    device_platform: 'macOS',
    secret_hash: 'must-never-leak',
    created_at: Date.parse('2026-07-01T00:00:00.000Z'),
    expires_at: Date.parse('2026-08-01T00:00:00.000Z'),
    last_used_at: Date.parse('2026-07-10T00:00:00.000Z'),
    use_count: 3,
    is_active: 1,
    revoked_at: undefined,
    revoke_reason: undefined,
    ...overrides,
  };
}

function app() {
  const instance = new Hono<{ Bindings: Record<string, never>; Variables: { tenantId: string } }>();
  instance.use('*', async (c, next) => {
    c.set('tenantId', c.req.header('x-test-tenant') ?? 'tenant-a');
    await next();
  });
  instance.get('/users/:userId/device-secrets', listUserDeviceSecrets as never);
  instance.delete('/users/:userId/device-secrets', revokeAllUserDeviceSecrets as never);
  instance.post('/device-secrets/cleanup', cleanupExpiredDeviceSecrets as never);
  instance.get('/device-secrets/:id', getDeviceSecret as never);
  instance.delete('/device-secrets/:id', revokeDeviceSecret as never);
  return instance;
}

describe('device secret admin security behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.repositoryTenants.length = 0;
    mocks.findByUserId.mockResolvedValue([]);
    mocks.findById.mockResolvedValue(secret());
    mocks.revoke.mockResolvedValue(true);
    mocks.revokeByUserId.mockResolvedValue(0);
    mocks.cleanupExpired.mockResolvedValue(0);
    mocks.audit.mockResolvedValue(undefined);
  });

  it('returns metadata only, filters revoked secrets and computes a meaningful summary', async () => {
    const now = Date.now();
    mocks.findByUserId.mockResolvedValue([
      secret(),
      secret({ id: 'expired', expires_at: now - 1, last_used_at: undefined }),
      secret({
        id: 'revoked',
        is_active: 0,
        revoked_at: Date.parse('2026-07-11T00:00:00.000Z'),
        revoke_reason: 'compromised',
      }),
    ]);
    const response = await app().request('/users/user-a/device-secrets?limit=1&offset=1');
    expect(response.status).toBe(200);
    const body = await response.json<{
      items: Array<Record<string, unknown>>;
      pagination: Record<string, unknown>;
      summary: Record<string, unknown>;
    }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).not.toHaveProperty('secret_hash');
    expect(JSON.stringify(body)).not.toContain('must-never-leak');
    expect(body.pagination).toMatchObject({ total: 2, limit: 1, offset: 1, has_more: false });
    expect(body.summary).toEqual({ total: 3, active: 2, revoked: 1, expired: 1 });
    expect(mocks.repositoryTenants).toEqual(['tenant-a']);
  });

  it('includes revoked metadata only when explicitly requested and caps the page size', async () => {
    mocks.findByUserId.mockResolvedValue([
      secret(),
      secret({ id: 'revoked', is_active: 0, revoked_at: Date.now() }),
    ]);
    const response = await app().request(
      '/users/user-a/device-secrets?include_revoked=true&limit=500'
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      pagination: { total: 2, limit: 100, offset: 0 },
    });
  });

  it.each(['?limit=0', '?limit=-1', '?limit=NaN', '?limit=1.5', '?offset=-1', '?offset=NaN'])(
    'rejects invalid pagination %s before repository access',
    async (query) => {
      const response = await app().request(`/users/user-a/device-secrets${query}`);
      expect(response.status).toBe(400);
      expect(mocks.findByUserId).not.toHaveBeenCalled();
    }
  );

  it('gets an existing tenant-scoped secret without exposing its hash', async () => {
    const response = await app().request('/device-secrets/device-a');
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      id: 'device-a',
      user_id: 'user-a',
      is_active: true,
      created_at: '2026-07-01T00:00:00.000Z',
    });
    expect(body).not.toHaveProperty('secret_hash');
  });

  it('uses a uniform not-found response for an inaccessible secret', async () => {
    mocks.findById.mockResolvedValue(null);
    const response = await app().request('/device-secrets/unknown');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error_code: AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND,
    });
  });

  it.each([
    ['{not-json', 'application/json'],
    [JSON.stringify({ reason: 42 }), 'application/json'],
    [JSON.stringify({ reason: 'x'.repeat(501) }), 'application/json'],
  ])('rejects invalid individual revocation input before changing state', async (body, type) => {
    const response = await app().request('/device-secrets/device-a', {
      method: 'DELETE',
      headers: { 'Content-Type': type },
      body,
    });
    expect(response.status).toBe(400);
    expect(mocks.findById).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('rejects an already-revoked secret without rewriting its reason', async () => {
    mocks.findById.mockResolvedValue(secret({ revoked_at: Date.now(), is_active: 0 }));
    const response = await app().request('/device-secrets/device-a', { method: 'DELETE' });
    expect(response.status).toBe(400);
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('sanitizes the revocation reason and audits only after persistence', async () => {
    const response = await app().request('/device-secrets/device-a', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: '  compromised\nheader: injected\u0000  ' }),
    });
    expect(response.status).toBe(200);
    expect(mocks.revoke).toHaveBeenCalledWith('device-a', 'compromisedheader: injected');
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'device_secret.revoke',
      'device_secret',
      'device-a',
      { user_id: 'user-a', reason: 'compromisedheader: injected' }
    );
  });

  it('uses a safe default reason for an empty optional body', async () => {
    const response = await app().request('/device-secrets/device-a', { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(mocks.revoke).toHaveBeenCalledWith('device-a', 'admin_revocation');
  });

  it('does not audit a revocation that failed to persist', async () => {
    mocks.revoke.mockResolvedValue(false);
    const response = await app().request('/device-secrets/device-a', { method: 'DELETE' });
    expect(response.status).toBe(500);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each([
    ['{not-json'],
    [JSON.stringify({ reason: false })],
    [JSON.stringify({ reason: 'x'.repeat(501) })],
  ])('rejects invalid bulk revocation input before mutation', async (body) => {
    const response = await app().request('/users/user-a/device-secrets', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(response.status).toBe(400);
    expect(mocks.revokeByUserId).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('bulk-revokes only within the request tenant and audits the count', async () => {
    mocks.revokeByUserId.mockResolvedValue(3);
    const response = await app().request('/users/user-a/device-secrets', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'x-test-tenant': 'tenant-b',
      },
      body: JSON.stringify({ reason: 'account lockdown' }),
    });
    expect(response.status).toBe(200);
    expect(mocks.revokeByUserId).toHaveBeenCalledWith('user-a', 'tenant-b', 'account lockdown');
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'device_secret.revoke_all',
      'user',
      'user-a',
      { revoked_count: 3, reason: 'account lockdown' }
    );
  });

  it('audits manual cleanup with the number of deleted secrets', async () => {
    mocks.cleanupExpired.mockResolvedValue(4);
    const response = await app().request('/device-secrets/cleanup', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, cleaned_count: 4 });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'device_secret.cleanup',
      'device_secret',
      'expired',
      { cleaned_count: 4 }
    );
  });

  it.each([
    ['GET', '/users/user-a/device-secrets', 'findByUserId'],
    ['GET', '/device-secrets/device-a', 'findById'],
    ['DELETE', '/device-secrets/device-a', 'findById'],
    ['DELETE', '/users/user-a/device-secrets', 'revokeByUserId'],
    ['POST', '/device-secrets/cleanup', 'cleanupExpired'],
  ] as const)('returns a redacted 500 when %s %s storage fails', async (method, path, mockName) => {
    mocks[mockName].mockRejectedValueOnce(new Error('database unavailable with private details'));
    const response = await app().request(path, { method });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error_code: AR_ERROR_CODES.INTERNAL_ERROR });
    expect(mocks.logError).toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
