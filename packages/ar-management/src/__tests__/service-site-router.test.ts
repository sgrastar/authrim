import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type {
  AdminAuthContext,
  ControlServiceSiteBindingStatusView,
  Env,
} from '@authrim/ar-lib-core';

const audit = vi.hoisted(() => vi.fn());

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    adminAuthMiddleware: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
    getTenantIdFromContext: vi.fn(() => 'default'),
  };
});

vi.mock('../admin-shared', () => ({ writeAdminAuditLog: audit }));

import { serviceSiteRouter } from '../routes/admin-management/service-site';

const PATH = '/api/admin/platform/service-site';
const partial = (value: Record<string, unknown>): unknown => expect.objectContaining(value);
const none: ControlServiceSiteBindingStatusView = {
  environmentId: 'test',
  bindingName: null,
  desiredState: 'detached',
  desiredWorkerName: null,
  attachedWorkerName: null,
  state: 'none',
  operationId: null,
  lastErrorCode: null,
  updatedAt: null,
};
const attaching: ControlServiceSiteBindingStatusView = {
  ...none,
  bindingName: 'SERVICE_SITE',
  desiredState: 'attached',
  desiredWorkerName: 'my-site',
  state: 'pending',
  operationId: 'service-site:1',
  updatedAt: 100,
};
const attached: ControlServiceSiteBindingStatusView = {
  ...attaching,
  attachedWorkerName: 'my-site',
  state: 'succeeded',
};

function createApp(input?: {
  roles?: string[];
  actorType?: AdminAuthContext['actorType'];
  status?: unknown;
  settings?: string | null;
  control?: Record<string, unknown> | null;
}) {
  const getServiceSiteBindingStatus = vi.fn(async () => input?.status ?? none);
  const requestServiceSiteBinding = vi.fn(async () => attaching);
  const control =
    input?.control === null
      ? undefined
      : ({
          getServiceSiteBindingStatus,
          requestServiceSiteBinding,
          ...input?.control,
        } as unknown as NonNullable<Env['CONTROL']>);
  const settingsGet = vi.fn(async () => input?.settings ?? null);
  const env = {
    CONTROL: control,
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    SETTINGS: { get: settingsGet },
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>();
  app.use('*', async (c, next) => {
    c.set('adminAuth', {
      userId: 'admin-1',
      authMethod: 'session',
      actorType: input?.actorType ?? 'human',
      roles: input?.roles ?? ['ar_super_admin'],
      globalRoles: input?.roles ?? ['ar_super_admin'],
      tenantScope: ['*'],
      permissions: [],
    });
    await next();
  });
  app.route(PATH, serviceSiteRouter);
  return { app, env, getServiceSiteBindingStatus, requestServiceSiteBinding, settingsGet };
}

function put(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

describe('service site admin router', () => {
  beforeEach(() => {
    audit.mockReset();
    audit.mockResolvedValue('audit-1');
  });

  describe('GET', () => {
    it('returns the unattached state with the fallback setting of the tenant', async () => {
      const { app, env, settingsGet } = createApp({
        settings: JSON.stringify({ 'service-site.fallback_enabled': true }),
      });
      const response = await app.request(PATH, {}, env);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        service_site: {
          attached: false,
          worker_name: null,
          state: 'none',
          desired_state: 'detached',
          desired_worker_name: null,
          binding_name: null,
          last_error: null,
          operation_id: null,
          updated_at: null,
          fallback_enabled: true,
        },
      });
      expect(settingsGet).toHaveBeenCalledWith('settings:tenant:default:service-site');
    });

    it('reports the attached Worker and defaults the fallback to off', async () => {
      const { app, env } = createApp({ status: attached });
      const body = await (
        await app.request(PATH, {}, env)
      ).json<{
        service_site: Record<string, unknown>;
      }>();
      expect(body.service_site).toMatchObject({
        attached: true,
        worker_name: 'my-site',
        state: 'succeeded',
        fallback_enabled: false,
      });
    });

    it('is limited to platform administrators', async () => {
      const denied = createApp({ roles: ['ar_tenant_admin'] });
      const response = await denied.app.request(PATH, {}, denied.env);
      expect(response.status).toBe(403);
      expect(denied.getServiceSiteBindingStatus).not.toHaveBeenCalled();
    });

    it('is unavailable without the Control capability', async () => {
      const { app, env } = createApp({ control: null });
      expect((await app.request(PATH, {}, env)).status).toBe(503);
    });

    it('does not pass on a status that has the wrong shape', async () => {
      const wrongEnvironment = createApp({ status: { ...none, environmentId: 'other' } });
      expect((await wrongEnvironment.app.request(PATH, {}, wrongEnvironment.env)).status).toBe(503);
      const extraField = createApp({ status: { ...none, secret: 'x' } });
      expect((await extraField.app.request(PATH, {}, extraField.env)).status).toBe(503);
      const badState = createApp({ status: { ...none, state: 'weird' } });
      expect((await badState.app.request(PATH, {}, badState.env)).status).toBe(503);
    });
  });

  describe('PUT', () => {
    it('audits the request, then asks Control to attach', async () => {
      const { app, env, requestServiceSiteBinding } = createApp();
      const response = await app.request(
        PATH,
        put({ worker_name: 'my-site' }, { 'idempotency-key': 'attach-1' }),
        env
      );
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        service_site: { state: 'pending', desired_worker_name: 'my-site' },
        audit_id: 'audit-1',
      });
      expect(audit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'service_site.attach.requested',
          resourceType: 'service_site_binding',
          after: partial({
            desired_state: 'attached',
            desired_worker_name: 'my-site',
          }),
        })
      );
      expect(requestServiceSiteBinding).toHaveBeenCalledWith({
        desiredState: 'attached',
        workerName: 'my-site',
        idempotencyKey: 'attach-1',
        requestedById: 'admin-1',
      });
      expect(audit.mock.invocationCallOrder[0]).toBeLessThan(
        requestServiceSiteBinding.mock.invocationCallOrder[0] ?? 0
      );
    });

    it('generates an idempotency key when the caller sends none', async () => {
      const { app, env, requestServiceSiteBinding } = createApp();
      await app.request(PATH, put({ worker_name: 'my-site' }), env);
      expect(requestServiceSiteBinding).toHaveBeenCalledWith(
        partial({ idempotencyKey: expect.stringMatching(/^service-site:/u) as unknown })
      );
    });

    it('answers 200 when the router already has the requested attachment', async () => {
      const { app, env } = createApp({
        control: { requestServiceSiteBinding: vi.fn(async () => attached) },
      });
      expect((await app.request(PATH, put({ worker_name: 'my-site' }), env)).status).toBe(200);
    });

    it.each([
      ['no body', ''],
      ['not JSON', 'nope'],
      ['an array', '[]'],
      ['no Worker name', '{}'],
      ['an extra field', '{"worker_name":"my-site","force":true}'],
      ['an uppercase name', '{"worker_name":"My-Site"}'],
      ['a name with a slash', '{"worker_name":"a/b"}'],
      ['a non-string name', '{"worker_name":5}'],
      ['a name that is too long', JSON.stringify({ worker_name: 'a'.repeat(64) })],
    ])('rejects %s', async (_label, body) => {
      const { app, env, requestServiceSiteBinding } = createApp();
      const response = await app.request(PATH, put(body), env);
      expect(response.status).toBe(400);
      expect(requestServiceSiteBinding).not.toHaveBeenCalled();
    });

    it('rejects an unsafe idempotency key', async () => {
      const { app, env, requestServiceSiteBinding } = createApp();
      const response = await app.request(
        PATH,
        put({ worker_name: 'my-site' }, { 'idempotency-key': 'bad key!' }),
        env
      );
      expect(response.status).toBe(400);
      expect(requestServiceSiteBinding).not.toHaveBeenCalled();
    });

    it('is limited to platform administrators and to human actors', async () => {
      const tenantAdmin = createApp({ roles: ['ar_tenant_admin'] });
      expect(
        (await tenantAdmin.app.request(PATH, put({ worker_name: 'my-site' }), tenantAdmin.env))
          .status
      ).toBe(403);
      const invalid = createApp({ roles: ['ar_tenant_admin'] });
      expect((await invalid.app.request(PATH, put({}), invalid.env)).status).toBe(403);
      const machine = createApp({ actorType: 'machine' });
      expect(
        (await machine.app.request(PATH, put({ worker_name: 'my-site' }), machine.env)).status
      ).toBe(403);
      for (const denied of [tenantAdmin, invalid, machine]) {
        expect(denied.requestServiceSiteBinding).not.toHaveBeenCalled();
      }
      expect(audit).not.toHaveBeenCalled();
    });

    it('fails closed before Control when audit persistence is unavailable', async () => {
      audit.mockResolvedValueOnce(null);
      const { app, env, requestServiceSiteBinding } = createApp();
      const response = await app.request(PATH, put({ worker_name: 'my-site' }), env);
      expect(response.status).toBe(503);
      expect(requestServiceSiteBinding).not.toHaveBeenCalled();
    });

    it.each([
      ['invalid_service_site_binding_request', 400, 'SERVICE_SITE_INVALID_REQUEST'],
      ['service_site_worker_reserved', 400, 'SERVICE_SITE_WORKER_RESERVED'],
      ['service_site_change_in_progress', 409, 'SERVICE_SITE_CHANGE_IN_PROGRESS'],
      ['service_site_idempotency_conflict', 409, 'SERVICE_SITE_IDEMPOTENCY_CONFLICT'],
      ['service_site_environment_not_active', 409, 'SERVICE_SITE_ENVIRONMENT_NOT_ACTIVE'],
      ['service_site_router_not_in_inventory', 409, 'SERVICE_SITE_ROUTER_UNAVAILABLE'],
      ['service_site_provider_mutation_unavailable', 503, 'SERVICE_SITE_UPDATE_UNAVAILABLE'],
      ['control_internal_error', 503, 'SERVICE_SITE_UPDATE_UNAVAILABLE'],
    ])('maps the Control error %s', async (code, status, expected) => {
      const { app, env } = createApp({
        control: {
          requestServiceSiteBinding: vi.fn(async () => {
            throw new Error(code);
          }),
        },
      });
      const response = await app.request(PATH, put({ worker_name: 'my-site' }), env);
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({ error: expected });
    });
  });

  describe('DELETE', () => {
    it('audits the request, then asks Control to detach', async () => {
      const { app, env, requestServiceSiteBinding } = createApp({ status: attached });
      requestServiceSiteBinding.mockResolvedValueOnce({
        ...attached,
        desiredState: 'detached',
        desiredWorkerName: null,
        state: 'pending',
      });
      const response = await app.request(
        PATH,
        { method: 'DELETE', headers: { 'idempotency-key': 'detach-1' } },
        env
      );
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        service_site: { attached: true, desired_state: 'detached', state: 'pending' },
      });
      expect(audit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'service_site.detach.requested',
          before: partial({ attached_worker_name: 'my-site' }),
        })
      );
      expect(requestServiceSiteBinding).toHaveBeenCalledWith({
        desiredState: 'detached',
        workerName: null,
        idempotencyKey: 'detach-1',
        requestedById: 'admin-1',
      });
    });

    it('is limited to platform administrators', async () => {
      const denied = createApp({ roles: ['ar_tenant_admin'] });
      const response = await denied.app.request(PATH, { method: 'DELETE' }, denied.env);
      expect(response.status).toBe(403);
      expect(denied.requestServiceSiteBinding).not.toHaveBeenCalled();
    });
  });
});
