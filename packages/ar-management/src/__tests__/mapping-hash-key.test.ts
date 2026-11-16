import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  ADMIN_PERMISSIONS,
  requireAdminPermissions,
  type AdminAuthContext,
  type Env,
} from '@authrim/ar-lib-core';
import {
  adminMappingHashKeyGetHandler,
  adminMappingHashKeyRotateHandler,
} from '../mapping-hash-key';

const { audit } = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  getTenantIdFromContext: () => 'tenant-a',
  createAuditLog: audit,
}));

function fixture(permissions?: string[]) {
  const read = vi.fn();
  const rotate = vi.fn();
  const provision = vi.fn();
  const idFromName = vi.fn();
  const env = {
    KEY_MANAGER: {
      idFromName,
      get: () => ({
        getExistingSecretRpc: read,
        rotateMappingHashKeyRpc: rotate,
        provisionMappingHashKeyRpc: provision,
      }),
    },
  };
  const app = new Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>();
  app.use('*', async (c, next) => {
    if (permissions)
      c.set('adminAuth', {
        userId: 'synthetic-admin',
        authMethod: 'session',
        roles: [],
        permissions,
      });
    await next();
  });
  app.get(
    '/key',
    requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_READ]),
    adminMappingHashKeyGetHandler
  );
  app.post(
    '/key/rotate',
    requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
    adminMappingHashKeyRotateHandler
  );
  return { app, env, read, rotate, provision, idFromName };
}
const mutation = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('mapping hash admin lifecycle boundary', () => {
  it('reads installation status without creating a key or exposing its value', async () => {
    const f = fixture([ADMIN_PERMISSIONS.SETTINGS_READ]);
    f.read.mockResolvedValue(null);
    const missing = await f.app.request('/key', undefined, f.env);
    expect(await missing.json()).toEqual({ installed: false, kid: null });
    f.read.mockResolvedValue({
      active: { kid: 'synthetic-kid', value: 'synthetic-only-never-return' },
    });
    const installed = await f.app.request('/key', undefined, f.env);
    expect(await installed.json()).toEqual({ installed: true, kid: 'synthetic-kid' });
    expect(installed.headers.get('Cache-Control')).toBe('no-store');
    expect(f.idFromName).toHaveBeenCalledWith('tenant-a-v3');
    expect(f.provision).not.toHaveBeenCalled();
    expect(f.rotate).not.toHaveBeenCalled();
  });
  it.each([undefined, []])(
    'refuses missing authorization before touching the key manager',
    async (permissions) => {
      const f = fixture(permissions);
      const response = await f.app.request(
        '/key/rotate',
        mutation({ expectedKid: 'synthetic-kid' }),
        f.env
      );
      expect(response.status).toBe(permissions ? 403 : 401);
      expect(f.idFromName).not.toHaveBeenCalled();
    }
  );
  it('requires write authority and never accepts a tenant override', async () => {
    const readOnly = fixture([ADMIN_PERMISSIONS.SETTINGS_READ]);
    expect(
      (await readOnly.app.request('/key/rotate', mutation({ expectedKid: 'key' }), readOnly.env))
        .status
    ).toBe(403);
    const writer = fixture([ADMIN_PERMISSIONS.SETTINGS_WRITE]);
    expect(
      (
        await writer.app.request(
          '/key/rotate',
          mutation({ expectedKid: 'key', tenantId: 'tenant-b' }),
          writer.env
        )
      ).status
    ).toBe(400);
    expect(writer.idFromName).not.toHaveBeenCalled();
  });
  it.each([
    ['mapping_hash_key_missing', 404],
    ['mapping_hash_key_conflict', 409],
    ['synthetic unavailable', 503],
  ] satisfies [string, number][])(
    'returns stable %s failure without creation',
    async (message, status) => {
      const f = fixture([ADMIN_PERMISSIONS.SETTINGS_WRITE]);
      f.rotate.mockRejectedValue(new Error(message));
      expect(
        (await f.app.request('/key/rotate', mutation({ expectedKid: 'key' }), f.env)).status
      ).toBe(status);
      expect(f.provision).not.toHaveBeenCalled();
    }
  );
  it('returns only the active kid and audits the authorized tenant', async () => {
    audit.mockClear();
    const f = fixture([ADMIN_PERMISSIONS.SETTINGS_WRITE]);
    f.rotate.mockResolvedValue({ kid: 'next-kid' });
    const response = await f.app.request(
      '/key/rotate',
      mutation({ expectedKid: 'previous-kid' }),
      f.env
    );
    expect(await response.json()).toEqual({ kid: 'next-kid' });
    expect(f.rotate).toHaveBeenCalledWith('previous-kid');
    expect(audit).toHaveBeenCalledWith(
      f.env,
      expect.objectContaining({
        tenantId: 'tenant-a',
        userId: 'synthetic-admin',
        metadata: JSON.stringify({ kid: 'next-kid' }),
      })
    );
    expect(f.provision).not.toHaveBeenCalled();
  });
});
