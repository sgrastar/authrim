import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AdminAuthContext } from '../../types/admin';
import {
  requireAdmin,
  requireAllRoles,
  requireAnyRole,
  requireRole,
  requireSystemAdmin,
} from '../rbac';

function auth(overrides: Partial<AdminAuthContext> = {}): AdminAuthContext {
  return {
    userId: 'admin-a',
    roles: [],
    permissions: [],
    hierarchyLevel: 0,
    mfaVerified: false,
    ...overrides,
  };
}

function app(middleware: ReturnType<typeof requireRole>, context?: AdminAuthContext) {
  const instance = new Hono();
  const reached = vi.fn();
  if (context) {
    instance.use('*', async (c, next) => {
      c.set('adminAuth', context);
      await next();
    });
  }
  instance.get('/protected', middleware, (c) => {
    reached();
    return c.json({ ok: true });
  });
  return { instance, reached };
}

describe('RBAC middleware security decisions', () => {
  it.each([
    requireRole('security_admin'),
    requireAnyRole(['security_admin', 'auditor']),
    requireAllRoles(['security_admin', 'auditor']),
    requireAdmin(),
    requireSystemAdmin(),
  ])('rejects missing authentication before invoking the handler', async (middleware) => {
    const { instance, reached } = app(middleware);
    const response = await instance.request('/protected');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'invalid_token',
      error_description: 'Authentication required. Please authenticate first.',
    });
    expect(reached).not.toHaveBeenCalled();
  });

  it('requires an exact role match and does not accept case or substring variants', async () => {
    for (const roles of [
      ['security_admin_extra'],
      ['SECURITY_ADMIN'],
      [' security_admin '],
      ['admin'],
    ]) {
      const { instance, reached } = app(requireRole('security_admin'), auth({ roles }));
      const response = await instance.request('/protected');
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: 'access_denied',
        required_roles: ['security_admin'],
      });
      expect(reached).not.toHaveBeenCalled();
    }

    const allowed = app(requireRole('security_admin'), auth({ roles: ['security_admin'] }));
    expect((await allowed.instance.request('/protected')).status).toBe(200);
    expect(allowed.reached).toHaveBeenCalledOnce();
  });

  it.each(['super_admin', 'system_admin'])(
    '%s bypasses single, any and all role gates',
    async (role) => {
      for (const middleware of [
        requireRole('unrelated'),
        requireAnyRole(['unrelated-a', 'unrelated-b']),
        requireAllRoles(['unrelated-a', 'unrelated-b']),
      ]) {
        const { instance, reached } = app(middleware, auth({ roles: [role] }));
        expect((await instance.request('/protected')).status).toBe(200);
        expect(reached).toHaveBeenCalledOnce();
      }
    }
  );

  it('allows machine bypass only for an exact machine token and admin:* permission', async () => {
    const allowed = app(
      requireAllRoles(['security_admin', 'auditor']),
      auth({ authMethod: 'machine_access_token', permissions: ['admin:*'] })
    );
    expect((await allowed.instance.request('/protected')).status).toBe(200);

    for (const context of [
      auth({ authMethod: 'machine_access_token', permissions: ['admin:clients:*'] }),
      auth({ authMethod: 'machine_access_token', permissions: ['admin:*:read'] }),
      auth({ authMethod: 'admin_session', permissions: ['admin:*'] }),
      auth({ permissions: ['admin:*'] }),
    ]) {
      const denied = app(requireRole('security_admin'), context);
      expect((await denied.instance.request('/protected')).status).toBe(403);
      expect(denied.reached).not.toHaveBeenCalled();
    }
  });

  it('allows any-role access with one exact role and reports all accepted roles on denial', async () => {
    const allowed = app(
      requireAnyRole(['security_admin', 'auditor']),
      auth({ roles: ['auditor'] })
    );
    expect((await allowed.instance.request('/protected')).status).toBe(200);

    const denied = app(requireAnyRole(['security_admin', 'auditor']), auth({ roles: ['viewer'] }));
    const response = await denied.instance.request('/protected');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'access_denied',
      error_description: 'This action requires one of the following roles: security_admin, auditor',
      required_roles: ['security_admin', 'auditor'],
    });
  });

  it('requires every all-role entry and identifies only the missing roles', async () => {
    const denied = app(
      requireAllRoles(['security_admin', 'auditor', 'incident_responder']),
      auth({ roles: ['security_admin', 'incident_responder'] })
    );
    const response = await denied.instance.request('/protected');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'access_denied',
      error_description: 'Missing required roles: auditor',
      required_roles: ['security_admin', 'auditor', 'incident_responder'],
      missing_roles: ['auditor'],
    });

    const allowed = app(
      requireAllRoles(['security_admin', 'auditor']),
      auth({ roles: ['auditor', 'security_admin', 'extra'] })
    );
    expect((await allowed.instance.request('/protected')).status).toBe(200);
  });

  it.each(['system_admin', 'distributor_admin', 'org_admin', 'admin'])(
    'requireAdmin accepts the documented %s role',
    async (role) => {
      const protectedApp = app(requireAdmin(), auth({ roles: [role] }));
      expect((await protectedApp.instance.request('/protected')).status).toBe(200);
    }
  );

  it('requireAdmin rejects tenant_admin and end_user while requireSystemAdmin rejects lower admins', async () => {
    for (const role of ['tenant_admin', 'end_user']) {
      expect(
        (await app(requireAdmin(), auth({ roles: [role] })).instance.request('/protected')).status
      ).toBe(403);
    }
    expect(
      (
        await app(requireSystemAdmin(), auth({ roles: ['distributor_admin'] })).instance.request(
          '/protected'
        )
      ).status
    ).toBe(403);
    expect(
      (
        await app(requireSystemAdmin(), auth({ roles: ['system_admin'] })).instance.request(
          '/protected'
        )
      ).status
    ).toBe(200);
  });

  it.each([
    () => requireRole(''),
    () => requireRole('   '),
    () => requireAnyRole([]),
    () => requireAnyRole(['valid', '']),
    () => requireAllRoles([]),
    () => requireAllRoles(['valid', '   ']),
  ])('rejects empty role configuration at route construction time', (build) => {
    expect(build).toThrow('requires at least one non-empty role');
  });
});
